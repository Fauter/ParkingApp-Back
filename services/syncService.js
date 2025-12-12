/* eslint-disable no-console */
const mongoose = require('mongoose');
const { MongoClient, ObjectId } = require('mongodb');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// =======================
// MODELOS LOCALES
// =======================
const Outbox = require('../models/Outbox');
const Counter = require('../models/Counter');
const Ticket = require('../models/Ticket');

// Modelos usados para reconstruir la transacción compuesta
const Cliente = require('../models/Cliente');
const Vehiculo = require('../models/Vehiculo');
const Abono = require('../models/Abono');
const Movimiento = require('../models/Movimiento');
const Cochera = require('../models/Cochera'); // 
let MovimientoCliente; // carga lazy

// ✅ Estado (expuesto vía handle.getStatus())
const status = {
  lastRun: null,
  lastError: null,
  online: false,
  pendingOutbox: 0,
  lastPullCounts: {},
};

// =======================
// CONFIG PRECIOS (HTTP+cache)
// =======================
const PRECIOS_REMOTE_URL = process.env.PRECIOS_REMOTE_URL || 'https://api.garageia.com/api/precios';

// ✅ helper para construir la URL con ?metodo=...
function appendMetodo(url, metodo) {
  const u = String(url || '').trim();
  if (!u) return '';
  return u.includes('?') ? `${u}&metodo=${metodo}` : `${u}?metodo=${metodo}`;
}

// ✅ NUEVO: URL remota para el bucket "otros"
const PRECIOS_REMOTE_URL_OTROS =
  process.env.PRECIOS_REMOTE_URL_OTROS || appendMetodo(PRECIOS_REMOTE_URL, 'otros');

const PRECIOS_CACHE_FILE =
  process.env.PRECIOS_CACHE_FILE ||
  path.join(process.cwd(), 'uploads', 'cache', 'precios.json');

const PRECIOS_FETCH_TIMEOUT_MS = Number(process.env.PRECIOS_FETCH_TIMEOUT_MS || 5000);
const PRECIOS_DEBUG = String(process.env.PRECIOS_DEBUG || '').trim() === '1';

function logPrecios(...args) { if (PRECIOS_DEBUG) console.log('[precios]', ...args); }

// fetch (compat Node 16/18)
let _fetch = global.fetch;
async function ensureFetch() {
  if (_fetch) return _fetch;
  const mod = await import('node-fetch');
  _fetch = mod.default || mod;
  return _fetch;
}
async function fetchJsonWithTimeout(url, ms = 5000) {
  const f = await ensureFetch();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await f(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
function ensureDirForFile(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('[precios] no pude crear carpeta cache:', e.message);
  }
}
// Estructura canonical de cache en disco:
// { efectivo: { <vehiculo>: {tarifas...} }, otros: { <vehiculo>: {tarifas...} } }
function readPreciosCache() {
  try {
    if (!fs.existsSync(PRECIOS_CACHE_FILE)) return { efectivo: {}, otros: {} };
    const txt = fs.readFileSync(PRECIOS_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(txt || '{}');

    // Soporta legado plano (sin buckets)
    const looksBucketed = parsed && typeof parsed === 'object' &&
                          (Object.prototype.hasOwnProperty.call(parsed, 'efectivo') ||
                           Object.prototype.hasOwnProperty.call(parsed, 'otros'));
    if (!looksBucketed) {
      return { efectivo: normalizePreciosObject(parsed || {}), otros: {} };
    }
    return {
      efectivo: normalizePreciosObject(parsed.efectivo || {}),
      otros: normalizePreciosObject(parsed.otros || {})
    };
  } catch {
    return { efectivo: {}, otros: {} };
  }
}

function writePreciosCache(store) {
  ensureDirForFile(PRECIOS_CACHE_FILE);
  const canonical = {
    efectivo: normalizePreciosObject(store?.efectivo || {}),
    otros: normalizePreciosObject(store?.otros || {})
  };
  fs.writeFileSync(PRECIOS_CACHE_FILE, JSON.stringify(canonical, null, 2), 'utf8');
}
function fixInnerKey(k) {
  const base = String(k || '').toLowerCase().trim();
  if (base === 'media estadia') return 'media estadía';
  if (base === 'dia') return 'día';
  if (base === 'dias') return 'días';
  if (base === '1 hora') return 'hora';
  return base;
}
function normalizePreciosObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const tipoRaw of Object.keys(obj)) {
    const tabla = obj[tipoRaw] || {};
    const fixed = {};
    for (const k of Object.keys(tabla || {})) fixed[fixInnerKey(k)] = tabla[k];
    out[String(tipoRaw || '').toLowerCase().trim()] = fixed;
  }
  return out;
}
// _id determinístico para mirror estricto
function oidFromStringStable(s) {
  try {
    const crypto = require('crypto');
    const hex = crypto.createHash('md5').update(String(s || '')).digest('hex').slice(0, 24);
    return hex;
  } catch {
    return new ObjectId();
  }
}

// ahora recibe tb el bucket/metodo: 'efectivo' | 'otros'
async function buildPreciosDocsFromObject(mapObj, metodo = 'efectivo') {
  const normalized = normalizePreciosObject(mapObj);
  const docs = [];
  for (const tipo of Object.keys(normalized)) {
    docs.push({
      _id: oidFromStringStable(`precios:${metodo}:${tipo}`), // ✅ incluye metodo en el hash
      metodo,                                                // ✅ nuevo campo
      tipo,
      tabla: normalized[tipo],
      updatedAt: new Date()
    });
  }
  return docs;
}
async function fetchPreciosDocs() {
  try {
    // Traer EFECTIVO y OTROS desde remoto (en paralelo), con fallback a cache por-bucket
    const [effRes, otrRes] = await Promise.allSettled([
      fetchJsonWithTimeout(PRECIOS_REMOTE_URL, PRECIOS_FETCH_TIMEOUT_MS),
      fetchJsonWithTimeout(PRECIOS_REMOTE_URL_OTROS, PRECIOS_FETCH_TIMEOUT_MS)
    ]);

    const effOk = effRes.status === 'fulfilled';
    const otrOk = otrRes.status === 'fulfilled';

    const effData = effOk
      ? ((effRes.value && effRes.value.data && typeof effRes.value.data === 'object')
          ? effRes.value.data : effRes.value)
      : null;

    const otrData = otrOk
      ? ((otrRes.value && otrRes.value.data && typeof otrRes.value.data === 'object')
          ? otrRes.value.data : otrRes.value)
      : null;

    // Cache anterior (para fallback fino por-bucket)
    const prev = readPreciosCache();

    // Construir docs: cada bucket usa remoto si vino OK, sino su cache previa
    const effDocs = await buildPreciosDocsFromObject(effOk ? (effData || {}) : (prev.efectivo || {}), 'efectivo');
    const otrDocs = await buildPreciosDocsFromObject(otrOk ? (otrData || {}) : (prev.otros || {}),    'otros');

    // Escribir cache combinada
    const nextStore = {
      efectivo: effOk ? normalizePreciosObject(effData || {}) : (prev.efectivo || {}),
      otros:    otrOk ? normalizePreciosObject(otrData || {}) : (prev.otros || {})
    };
    writePreciosCache(nextStore);

    logPrecios('remote(fetch)/ok-per-bucket', {
      urlEfectivo: PRECIOS_REMOTE_URL,
      urlOtros: PRECIOS_REMOTE_URL_OTROS,
      tiposEfectivo: effDocs.map(d => d.tipo),
      tiposOtros: otrDocs.map(d => d.tipo)
    });

    // Permitir mirror delete SOLO si ambos buckets vinieron del remoto
    const bothRemote = effOk && otrOk;
    return { docs: [...effDocs, ...otrDocs], source: bothRemote ? 'remote' : 'mixed', allowMirrorDelete: bothRemote };
  } catch (e) {
    // Fallback total a cache
    const cached = readPreciosCache();
    const effDocs = await buildPreciosDocsFromObject(cached.efectivo || {}, 'efectivo');
    const otrDocs = await buildPreciosDocsFromObject(cached.otros || {},    'otros');
    const docs = [...effDocs, ...otrDocs];

    logPrecios('remote-fail -> cache', {
      error: String(e && e.message || e),
      tiposEfectivo: effDocs.map(d => d.tipo),
      tiposOtros: otrDocs.map(d => d.tipo)
    });
    return { docs, source: 'cache', allowMirrorDelete: false };
  }
}

// =======================
// WATERMARK / SYNC STATE
// =======================
// 🔁 usamos `canon` (no `collection`) + migración en caliente
const SyncStateSchema = new mongoose.Schema({
  canon: { type: String, unique: true, required: true },
  lastUpdatedAt: { type: Date },
  lastObjectId: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed }, // puede guardar { lastPair: { ts: Date, oid: string } }
}, { collection: 'sync_state', timestamps: true });

const SyncState = mongoose.models.SyncState || mongoose.model('SyncState', SyncStateSchema);

// =======================
// VARS DE CONEXIÓN REMOTA
// =======================
let remoteClient = null;
let syncing = false;
let SELECTED_REMOTE_DBNAME = null;

let INITIAL_PULL_DONE = false;

// =======================
// UTILS BÁSICOS
// =======================
function is24Hex(s) { return typeof s === 'string' && /^[a-fA-F0-9]{24}$/.test(s); }

function bytesFromAny(x) {
  try {
    if (!x) return null;
    if (Array.isArray(x) && x.length === 12 && x.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return Uint8Array.from(x);
    }
    if (typeof x === 'object') {
      if (Array.isArray(x.data) && x.data.length === 12) return Uint8Array.from(x.data);
      if (x.type === 'Buffer' && Array.isArray(x.data) && x.data.length === 12) return Uint8Array.from(x.data);
      if (x.$binary?.base64) {
        const buf = Buffer.from(x.$binary.base64, 'base64');
        if (buf.length === 12) return new Uint8Array(buf);
      }
      if (x.buffer && typeof x.buffer === 'object') {
        const keys = Object.keys(x.buffer).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
        if (keys.length === 12) return Uint8Array.from(keys.map(k => Number(x.buffer[k])));
      }
      const directKeys = Object.keys(x).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
      if (directKeys.length === 12) return Uint8Array.from(directKeys.map(k => Number(x[k])));
      if (x._bsontype === 'ObjectId' && x.id) return bytesFromAny(x.id);
      if (x.id) return bytesFromAny(x.id);
    }
  } catch {}
  return null;
}

function hexFromAny(o) {
  try {
    if (!o) return null;
    if (typeof o === 'string') return is24Hex(o.trim()) ? o.trim() : null;
    if (typeof o === 'object') {
      if (is24Hex(o.$oid)) return o.$oid;
      if (is24Hex(o.oid)) return o.oid;
      if (is24Hex(o._id)) return o._id;
      if (is24Hex(o.id)) return o.id;
      const by = bytesFromAny(o);
      if (by?.length === 12) return Buffer.from(by).toString('hex');
    }
  } catch {}
  return null;
}

function safeObjectId(id) {
  try {
    if (!id) return null;
    if (id instanceof ObjectId) return id;
    const hx = hexFromAny(id);
    if (is24Hex(hx)) return new ObjectId(hx);
    const s = String(id);
    if (is24Hex(s)) return new ObjectId(s);
    return id;
  } catch {
    return id;
  }
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj || {})); }

function removeNulls(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeNulls);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      const r = removeNulls(v);
      if (r !== undefined && (typeof r !== 'object' || Object.keys(r).length)) out[k] = r;
    } else out[k] = v;
  }
  return out;
}

async function hasInternet() {
  return new Promise(resolve => { dns.lookup('google.com', err => resolve(!err)); });
}

function getRemoteDbInstance() {
  if (!remoteClient) return null;
  try { return remoteClient.db(SELECTED_REMOTE_DBNAME || undefined); } catch { return null; }
}

async function connectRemote(atlasUri, dbName) {
  if (!atlasUri) throw new Error('No ATLAS URI provista');
  SELECTED_REMOTE_DBNAME = dbName || SELECTED_REMOTE_DBNAME || null;
  const existing = getRemoteDbInstance();
  if (existing) return existing;
  console.log('[syncService] intentando conectar a Atlas...');
  remoteClient = new MongoClient(atlasUri, { serverSelectionTimeoutMS: 3000 });
  await remoteClient.connect();
  const db = remoteClient.db(SELECTED_REMOTE_DBNAME || undefined);
  console.log(`[syncService] conectado a Atlas (remote db="${db.databaseName}")`);
  return db;
}

// =======================
// ALIASES / CLAVES NATURALES / CASTEOS
// =======================
const REF_BY_COLL = {
  vehiculos: ['cliente', 'abono'],
  abonos: ['cliente', 'vehiculo'],
  movimientos: ['cliente', 'vehiculo', 'abono', 'operador'], // ✅ incluir operador
  movimientoclientes: ['cliente', 'vehiculo', 'abono'],
  cierresdecajas: ['operador'],
  cocheras: ['cliente', 'vehiculos'],                        // ✅ NUEVO: castear bien refs en cocheras
};
const NATURAL_KEYS = {
  tickets: ['ticket'],
  users: ['username', 'email'],
  vehiculos: ['patente'],
  clientes: ['dniCuitCuil', 'email'],
  cocheras: ['cliente','tipo','piso','exclusiva'],
  tipovehiculos: ['nombre'],
  tarifas: ['nombre'],
  promos: ['codigo'],
  alertas: ['codigo'],
  cierresdecajas: ['fecha', 'hora', 'operador'],
  precios: ['tipo', 'metodo'],
};
const REMOTE_ALIASES = {
  cierresdecajas: ['cierresDeCaja','cierredecajas','cierresdecaja','cierredecaja'],
  movimientoclientes: ['movimientosClientes','movimientoClientes','movimientocliente'],
  tipovehiculos: ['tiposvehiculo','tipoVehiculos','tiposVehiculo','tipoVehiculo','tipos-vehiculo','tipo-vehiculo'],
  tarifas: ['tarifa'],
  promos: ['promociones','promo'],
  precios: ['precio'],
  parametros: ['parametro','parametros_app','parámetros'],
  cocheras: ['cochera'],
};

function getRemoteNames(colName) {
  const canon = canonicalizeName(colName);
  const aliases = REMOTE_ALIASES[canon] || [];
  const all = [canon, ...aliases].filter(Boolean);
  return all.filter((v, i) => all.indexOf(v) === i);
}
function canonicalizeName(name) {
  const lower = String(name || '').toLowerCase();
  // ✅ quitar querystring y fragmento, y barritas finales
  const clean = lower.split('?')[0].split('#')[0].replace(/\/+$/, '');

  for (const [canon, aliases] of Object.entries(REMOTE_ALIASES)) {
    if (clean === canon) return canon;
    if (aliases.some(a => a.toLowerCase() === clean)) return canon;
  }
  return clean;
}

// Intenta mapear a una colección local ya existente
let _localCollectionsCache = null;
async function getLocalCollectionsSet(db) {
  if (_localCollectionsCache) return _localCollectionsCache;
  const cols = await db.db.listCollections().toArray();
  _localCollectionsCache = new Set(cols.map(c => c.name));
  return _localCollectionsCache;
}
async function resolveLocalCollectionName(db, canonName) {
  const aliases = getRemoteNames(canonName);
  const set = await getLocalCollectionsSet(db);
  for (const name of aliases) {
    if (set.has(name)) return name;
  }
  return canonName;
}

(async () => {
  try {
    const ensure = async () => {
      const localName = await resolveLocalCollectionName(mongoose.connection, 'precios');
      await mongoose.connection
        .collection(localName)
        .createIndex({ tipo: 1, metodo: 1 }, { unique: true });
      console.log('[syncService] ensured unique index precios(tipo,metodo)');
    };

    if (mongoose.connection.readyState === 1) {
      await ensure();
    } else {
      mongoose.connection.once('open', () => { ensure().catch(() => {}); });
    }
  } catch (_) {}
})();

function buildNaturalKeyFilter(colName, src) {
  const keys = NATURAL_KEYS[colName?.toLowerCase()] || [];
  const filter = {};
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null && String(src[k]).trim() !== '') {
      filter[k] = src[k];
    }
  }
  return Object.keys(filter).length ? filter : null;
}

// ⬇️ robustecido: también normaliza 'operador' y subdoc 'movimiento'
function coerceRefIds(doc, colName) {
  if (!doc || typeof doc !== 'object') return doc;
  const fields = new Set([...(REF_BY_COLL[colName?.toLowerCase()] || []), 'operador']);
  for (const f of fields) {
    if (doc[f] !== undefined) {
      if (Array.isArray(doc[f])) doc[f] = doc[f].map(safeObjectId);
      else doc[f] = safeObjectId(doc[f]);
    }
  }
  if (doc.movimiento && typeof doc.movimiento === 'object') {
    if (doc.movimiento._id !== undefined) doc.movimiento._id = safeObjectId(doc.movimiento._id);
    if (doc.movimiento.operador !== undefined) doc.movimiento.operador = safeObjectId(doc.movimiento.operador);
    if (doc.movimiento.cliente !== undefined) doc.movimiento.cliente = safeObjectId(doc.movimiento.cliente);
    if (doc.movimiento.vehiculo !== undefined) doc.movimiento.vehiculo = safeObjectId(doc.movimiento.vehiculo);
    if (doc.movimiento.abono !== undefined) doc.movimiento.abono = safeObjectId(doc.movimiento.abono);
  }
  return doc;
}

// 🔧 Limpieza específica para VEHICULOS: nunca queremos _id anidados en estadías
function stripVehiculoNestedIds(clone) {
  if (!clone || typeof clone !== 'object') return clone;

  // 1) estadiaActual._id → fuera
  if (
    clone.estadiaActual &&
    typeof clone.estadiaActual === 'object' &&
    !Array.isArray(clone.estadiaActual)
  ) {
    if (Object.prototype.hasOwnProperty.call(clone.estadiaActual, '_id')) {
      delete clone.estadiaActual._id;
    }
  }

  // 2) historialEstadias[*]._id → fuera
  if (Array.isArray(clone.historialEstadias)) {
    clone.historialEstadias = clone.historialEstadias.map((e) => {
      if (e && typeof e === 'object' && !Array.isArray(e)) {
        const { _id, ...rest } = e; // saco _id y dejo el resto
        return rest;
      }
      return e;
    });
  }

  return clone;
}

function normalizeIds(inputDoc, colName) {
  const clone = deepClone(inputDoc || {});

  // 🛡 FIX crítico: para vehiculos limpiamos _id anidados de estadías
  if (String(colName).toLowerCase() === 'vehiculos') {
    stripVehiculoNestedIds(clone);
  }

  if (clone._id != null) clone._id = safeObjectId(clone._id);

  const commonKeys = new Set(['cliente','vehiculo','abono','user','ticket','operador', ...(REF_BY_COLL[colName?.toLowerCase()] || [])]);
  for (const k of commonKeys) {
    if (clone[k] !== undefined) {
      if (Array.isArray(clone[k])) clone[k] = clone[k].map(safeObjectId);
      else clone[k] = safeObjectId(clone[k]);
    }
  }
  // Normalización anidada para dedup.movimiento
  if (clone.movimiento && typeof clone.movimiento === 'object') {
    clone.movimiento = deepClone(clone.movimiento);
    if (clone.movimiento._id !== undefined) clone.movimiento._id = safeObjectId(clone.movimiento._id);
    for (const k of ['cliente','vehiculo','abono','operador','user']) {
      if (clone.movimiento[k] !== undefined) clone.movimiento[k] = safeObjectId(clone.movimiento[k]);
    }
  }

  const maybeIdArrays = ['abonos','vehiculos','movimientos'];
  for (const k of maybeIdArrays) {
    if (Array.isArray(clone[k])) clone[k] = clone[k].map(safeObjectId);
  }
  return removeNulls(clone);
}

function getCollectionNameFromItem(item) {
  if (!item) return null;
  if (item.collection) return item.collection;
  if (item.route) {
    const raw = String(item.route || '');
    const routePath = raw.split('?')[0].split('#')[0];   // ✅ limpia query/fragment
    const parts = routePath.split('/').filter(Boolean);
    const apiIndex = parts.indexOf('api');
    if (apiIndex >= 0 && parts.length > apiIndex + 1) return parts[apiIndex + 1];
    const last = parts[parts.length - 1];
    if (last && mongoose.Types.ObjectId.isValid(last) && parts.length >= 2) return parts[parts.length - 2];
    if (parts.length) return parts[parts.length - 1];
  }
  return null;
}
function extractIdFromItem(item) {
  if (!item) return null;
  if (item.document && (item.document._id || item.document.id)) return item.document._id || item.document.id;
  if (item.params && (item.params.id || item.params._id)) return item.params.id || item.params._id;
  if (item.query && (item.query.id || item.query._id)) return item.query.id || item.query._id;
  if (item.route) {
    const parts = item.route.split('/').filter(Boolean);
    for (const part of parts) if (mongoose.Types.ObjectId.isValid(part)) return part;
  }
  return null;
}
function looksLikeValidDocument(obj) {
  return !!(obj && typeof obj === 'object' && !Array.isArray(obj));
}

// =======================
// OUTBOX: UPSERT REMOTO
// =======================
async function upsertRemoteDoc(remoteDb, colName, rawDoc) {
  if (!rawDoc) return 0;
  const names = getRemoteNames(colName);
  const doc = deepClone(rawDoc);
  coerceRefIds(doc, colName);
  const cleaned = removeNulls(doc);
  const _id = safeObjectId(cleaned._id);
  const rest = deepClone(cleaned); delete rest._id;

  let pushed = 0;
  for (const name of names) {
    const collection = remoteDb.collection(name);

    // 🔒 Protección fecha movimientos
    if (String(colName).toLowerCase() === 'movimientos') {
      const $set = removeNulls(deepClone(rest));
      const $setOnInsert = {};
      if (Object.prototype.hasOwnProperty.call($set, 'fecha')) delete $set.fecha;
      const creationDate = cleaned.fecha || cleaned.createdAt || new Date();
      $setOnInsert.fecha = creationDate;

      if (_id instanceof ObjectId) {
        await collection.updateOne({ _id }, { ...(Object.keys($set).length ? { $set } : {}), $setOnInsert }, { upsert: true });
      } else {
        const nk = buildNaturalKeyFilter(colName, cleaned);
        if (nk) {
          await collection.updateOne(nk, { ...(Object.keys($set).length ? { $set } : {}), $setOnInsert }, { upsert: true });
        } else {
          await collection.insertOne({ _id: cleaned._id, ...$setOnInsert, ...$set });
        }
      }
      pushed++;
      continue;
    }

    if (_id instanceof ObjectId) {
      await collection.updateOne({ _id }, { $set: rest }, { upsert: true });
    } else {
      const nk = buildNaturalKeyFilter(colName, cleaned);
      if (nk) await collection.updateOne(nk, { $set: rest }, { upsert: true });
      else await collection.insertOne(cleaned);
    }
    pushed++;
  }
  return pushed;
}

// Casos compuestos (registrar abono)
async function ensureCompositeRegistrarAbonoSynced(remoteDb, item) {
  const body = item?.document || {};

  let cliente = null;
  if (body.cliente && mongoose.Types.ObjectId.isValid(body.cliente)) {
    cliente = await Cliente.findById(body.cliente).lean();
  }
  if (!cliente && body.dniCuitCuil) cliente = await Cliente.findOne({ dniCuitCuil: body.dniCuitCuil }).lean();
  if (!cliente && body.email)      cliente = await Cliente.findOne({ email: body.email }).lean();

  let vehiculo = null;
  if (body.patente) vehiculo = await Vehiculo.findOne({ patente: body.patente }).lean();

  let abono = null;
  if (vehiculo && cliente) {
    abono = await Abono.findOne({ vehiculo: vehiculo._id, cliente: cliente._id }).sort({ createdAt: -1 }).lean();
  } else if (body.patente) {
    abono = await Abono.findOne({ patente: body.patente }).sort({ createdAt: -1 }).lean();
  }

  // ⛔️ Importante: NO empujamos movimientos desde el compuesto;
  // el movimiento se sube por su propio Outbox (evita duplicados).
    if (!MovimientoCliente) { 
    try { 
      MovimientoCliente = require('../models/MovimientoCliente'); 
    } catch (_) {} 
  }

  let movCli = null;
  if (MovimientoCliente && cliente) {
    movCli = await MovimientoCliente.findOne({ cliente: cliente._id })
      .sort({ createdAt: -1 })
      .lean();
  }

  // ✅ NUEVO: intentar localizar la cochera asociada al abono
  let cochera = null;
  try {
    if (abono && abono.cochera) {
      cochera = await Cochera.findById(abono.cochera).lean();
    }
  } catch (_) {
    // ignore
  }

  let pushed = 0;
  pushed += await upsertRemoteDoc(remoteDb, 'clientes', cliente);
  pushed += await upsertRemoteDoc(remoteDb, 'vehiculos', vehiculo);
  pushed += await upsertRemoteDoc(remoteDb, 'abonos', abono);
  pushed += await upsertRemoteDoc(remoteDb, 'cocheras', cochera);         // ✅ NUEVO: empujar cocheras
  // NO: pushed += await upsertRemoteDoc(remoteDb, 'movimientos', mov);
  pushed += await upsertRemoteDoc(remoteDb, 'movimientoclientes', movCli);

  if (!pushed) {
    throw new Error('composite_registrar_abono: no se encontraron docs locales para sincronizar');
  }
}


// --- helpers mirror/push ---
function toCanonSet(arr = []) {
  return new Set((arr || []).map(s => canonicalizeName(s)));
}
function isMirrorBlockedCollection(name, opts = {}) {
  if (!name) return false;
  const canon = canonicalizeName(name);
  if (opts.mirrorAll) return true; // si espejás todo, bloquea push de todo
  const set = toCanonSet(opts.mirrorCollections || []);
  return set.has(canon);
}
async function processOutboxItem(remoteDb, item) {
  const isComposite = /\/api\/abonos\/registrar-abono/i.test(item?.route || '');
  if (isComposite) { await ensureCompositeRegistrarAbonoSynced(remoteDb, item); return; }

  const colName = getCollectionNameFromItem(item);
  if (!colName) throw new Error('invalid_collection');

  const canonCol = canonicalizeName(colName);

  // 🟥 CASO ESPECIAL DEFINITIVO: remover vehículo de cochera
  // Objetivo: coherencia de grafo (cochera + vehiculo + cliente) en remoto.
  if (
    canonCol === 'cocheras' &&
    /\/cocheras\/remover-vehiculo\b/i.test(item?.route || '')
  ) {
    console.log("[syncService] CASO ESPECIAL: remover vehículo (PUSH grafo: cochera+vehiculo+cliente)");

    // 1) Detectar cocheraId y vehiculoId
    let cocheraId =
      item.document?.cocheraId ||
      item.document?.cochera ||
      item.params?.cocheraId ||
      item.params?.id ||
      null;

    if (!cocheraId && item.document?.filter) {
      cocheraId =
        item.document.filter._id ||
        item.document.filter.cocheraId ||
        null;
    }

    if (!cocheraId) cocheraId = extractIdFromItem(item);
    if (!cocheraId) throw new Error("cocheraId_missing_remover_vehiculo");

    // Intentar detectar vehiculoId (depende de cómo armes el body del endpoint)
    let vehiculoId =
      item.document?.vehiculoId ||
      item.document?.vehiculo ||
      item.params?.vehiculoId ||
      null;

    // 2) Leer cochera local ya actualizada
    const cocheraLocal = await Cochera.findById(cocheraId).lean();
    if (!cocheraLocal) throw new Error("cochera_no_encontrada_local_para_remover");

    // 3) Resolver clienteId desde cocheraLocal
    const clienteId = cocheraLocal.cliente ? (cocheraLocal.cliente._id || cocheraLocal.cliente) : null;

    // 4) Si no vino vehiculoId, intentar inferir por diferencia (caro pero seguro)
    //    Nota: esto requiere que en el Outbox guardes al menos el vehiculoId removido; si no, inferimos.
    let vehiculoLocal = null;
    if (vehiculoId && mongoose.Types.ObjectId.isValid(String(vehiculoId))) {
      vehiculoLocal = await Vehiculo.findById(vehiculoId).lean();
    }

    // Si no tenemos vehiculoId, no podemos “limpiar” vehiculo/cliente con certeza.
    // Aun así, empujamos cochera (que ya quedó bien).
    // Recomendación: GUARDA vehiculoId removido en el Outbox del endpoint.
    // (te lo marco abajo como ajuste de controllers)
    // ------------------------------------------------------------

    // 5) Normalizar payload de cochera → SOLO IDs
    const vehiculosIds = Array.isArray(cocheraLocal.vehiculos)
      ? cocheraLocal.vehiculos.map(v => (v && v._id) ? v._id : v)
      : [];

    const cocheraPayload = {
      _id: safeObjectId(cocheraId),
      cliente: clienteId ? safeObjectId(clienteId) : null,
      tipo: cocheraLocal.tipo,
      piso: cocheraLocal.piso,
      exclusiva: !!cocheraLocal.exclusiva,
      vehiculos: vehiculosIds.map(id => safeObjectId(id)),
      updatedAt: new Date()
    };

    // 6) Empujar cochera (exacto)
    await remoteDb.collection("cocheras").updateOne(
      { _id: cocheraPayload._id },
      { $set: cocheraPayload },
      { upsert: true }
    );

    // 7) Si tenemos vehiculoLocal: empujar el vehiculo ya actualizado en LOCAL
    //    (idealmente el endpoint local ya le puso cocheraId=null y/o lo que corresponda)
    if (vehiculoLocal && vehiculoLocal._id) {
      // Releer por seguridad el estado final local
      const vehFinal = await Vehiculo.findById(vehiculoLocal._id).lean();

      if (vehFinal) {
        // Normalización de ids (tu helper existente)
        const vehNorm = normalizeIds(deepClone(vehFinal), 'vehiculos');

        // Upsert remoto por patente (consistente con tu lógica de vehiculos)
        const vehRemoteName = (getRemoteNames('vehiculos')[0] || 'vehiculos');
        const vehColl = remoteDb.collection(vehRemoteName);

        const filter = vehNorm.patente ? { patente: vehNorm.patente } : { _id: safeObjectId(vehNorm._id) };

        const vehDocWithoutId = deepClone(vehNorm);
        delete vehDocWithoutId._id;

        await vehColl.updateOne(
          filter,
          { $set: vehDocWithoutId, $setOnInsert: vehNorm.patente ? { patente: vehNorm.patente } : {} },
          { upsert: true }
        );
      }
    }

    // 8) Si tenemos clienteId: empujar el cliente (para que /clientes refleje vehiculos[])
    //    OJO: esto asume que el endpoint local efectivamente removió el vehiculo del array del cliente.
    if (clienteId && mongoose.Types.ObjectId.isValid(String(clienteId))) {
      const cliFinal = await Cliente.findById(clienteId).lean();
      if (cliFinal) {
        const cliNorm = normalizeIds(deepClone(cliFinal), 'clientes');

        const cliColl = remoteDb.collection(getRemoteNames('clientes')[0] || 'clientes');
        await cliColl.updateOne(
          { _id: safeObjectId(cliNorm._id) },
          { $set: removeNulls(deepClone((() => { const x = deepClone(cliNorm); delete x._id; return x; })())) },
          { upsert: true }
        );
      }
    }

    console.log("[syncService] remover-vehiculo → REMOTO ACTUALIZADO (cochera+vehiculo+cliente)");

    // 9) Marcar outbox y terminar
    await Outbox.updateOne(
      { _id: item._id },
      { status: "synced", syncedAt: new Date(), error: null }
    );
    return;
  }

  // Permitimos doc vacío SOLO para vehiculos (vamos a leer desde Mongo local)
  if (
    item.method !== 'DELETE' &&
    !looksLikeValidDocument(item.document) &&
    !isComposite &&
    canonCol !== 'vehiculos'
  ) {
    throw new Error('invalid_document');
  }

  const remoteNames = getRemoteNames(colName);
  if (!remoteNames.length) throw new Error(`Colección remota no encontrada (aliases vacíos): ${colName}`);

  // ========================
  // POST
  // ========================
  if (item.method === 'POST') {
    const doc = deepClone(item.document || {});
    coerceRefIds(doc, colName);
    const cleaned = removeNulls(doc);
    const _id = safeObjectId(cleaned._id);
    const nk = buildNaturalKeyFilter(colName, cleaned);
    const rest = deepClone(cleaned); delete rest._id;

    for (const name of remoteNames) {
      const collection = remoteDb.collection(name);

      if (String(colName).toLowerCase() === 'movimientos') {
        const $set = removeNulls(deepClone(rest));
        const $setOnInsert = {};
        if (Object.prototype.hasOwnProperty.call($set, 'fecha')) delete $set.fecha;
        const creationDate = cleaned.fecha || cleaned.createdAt || new Date();
        $setOnInsert.fecha = creationDate;

        if (_id instanceof ObjectId) {
          await collection.updateOne({ _id }, { ...(Object.keys($set).length ? { $set } : {}), $setOnInsert }, { upsert: true });
        } else if (nk) {
          await collection.updateOne(nk, { ...(Object.keys($set).length ? { $set } : {}), $setOnInsert }, { upsert: true });
        } else {
          await collection.insertOne({ _id: cleaned._id, ...$setOnInsert, ...$set });
        }
        continue;
      }

      if (_id instanceof ObjectId) {
        await collection.updateOne({ _id }, { $set: rest }, { upsert: true });
      } else if (nk) {
        await collection.updateOne(nk, { $set: rest }, { upsert: true });
      } else {
        await collection.insertOne(cleaned);
      }
    }
    return;
  }

  // ========================
  // PUT / PATCH
  // ========================
  if (item.method === 'PUT' || item.method === 'PATCH') {

    // 🟩 CASO ESPECIAL: VEHICULOS
    // Ignoramos el body del Outbox y reflejamos SIEMPRE el vehículo completo local en Atlas,
    // pero SIN tocar nunca el _id remoto: usamos $set + clave natural (patente),
    // y además hacemos un $unset fino de las claves de estadiaActual que ya no existan localmente.
    if (canonCol === 'vehiculos') {
      console.log('[syncService] [vehiculos] procesando PUSH/PATCH desde Outbox', {
        route: item.route || null,
        method: item.method,
      });

      // 1) Intentar ID directo (_id en document o extraído de la ruta)
      let id =
        (item.document && (item.document._id || item.document.id)) ||
        extractIdFromItem(item);

      let vehiculo = null;

      // 2) Si el id luce como ObjectId, buscar por _id en LOCAL
      if (id && mongoose.Types.ObjectId.isValid(String(id))) {
        try {
          vehiculo = await Vehiculo.findById(id).lean();
        } catch (e) {
          console.warn('[syncService] [vehiculos] error buscando por _id:', String(e && e.message || e));
          vehiculo = null;
        }
      }

      // 3) Si no encontramos por _id, resolvemos por patente en LOCAL
      if (!vehiculo) {
        let patente =
          (item.document && item.document.patente) ||
          (item.params && (item.params.patente || item.params.patenteNueva)) ||
          null;

        // último recurso: intentar sacar la patente de la URL
        if (!patente && item.route) {
          const parts = String(item.route)
            .split('?')[0]
            .split('#')[0]
            .split('/')
            .filter(Boolean);

          const maybePlate = parts.find(
            (p) =>
              /^[A-Z0-9]{6,8}$/i.test(p) &&
              p.toLowerCase() !== 'vehiculos' &&
              p.toLowerCase() !== 'api'
          );
          if (maybePlate) patente = maybePlate.toUpperCase();
        }

        if (patente) {
          try {
            vehiculo = await Vehiculo.findOne({ patente }).lean();
          } catch (e) {
            console.warn('[syncService] [vehiculos] error buscando por patente:', String(e && e.message || e));
            vehiculo = null;
          }
        }

        if (!vehiculo) {
          console.warn(
            '[syncService] [vehiculos] vehiculo no encontrado para PUSH/PATCH.',
            {
              id: id || null,
              patente:
                patente ||
                (item.document && item.document.patente) ||
                (item.params && item.params.patente) ||
                null,
              route: item.route || null,
            }
          );
          throw new Error('vehiculo_no_encontrado_para_push');
        }
      }

      // ✅ 4) Leer vehículo completo local
      const vehiculoLocal =
        (vehiculo && vehiculo._id)
          ? (await Vehiculo.findById(vehiculo._id).lean()) || vehiculo
          : vehiculo;

      if (!vehiculoLocal) {
        console.warn('[syncService] [vehiculos] vehiculo no encontrado localmente para PUSH');
        throw new Error('vehiculo_local_no_encontrado_para_push');
      }

      // ✅ 5) Construir “vista local” SIN perder nulls (para poder desenganchar en remoto)
      const localRaw = deepClone(vehiculoLocal);

      // Normalizamos ids pero OJO: normalizeIds() elimina nulls.
      // Usamos normalizeIds() para ids/limpieza, pero guardamos el raw para decidir $unset.
      const normalizedFullVeh = normalizeIds(localRaw, 'vehiculos');

      // Preparamos payload sin _id ni patente
      const docWithoutId = deepClone(normalizedFullVeh);
      delete docWithoutId._id;
      delete docWithoutId.patente;

      // Clave natural
      const filter = normalizedFullVeh.patente
        ? { patente: normalizedFullVeh.patente }
        : { _id: safeObjectId(normalizedFullVeh._id) };

      const vehRemoteName = remoteNames[0] || 'vehiculos';
      const vehColl = remoteDb.collection(vehRemoteName);

      // 🧽 6) Construir $unset para campos “link” que quedaron null/undefined en LOCAL
      // (si no lo hacés, el remoto conserva valores viejos)
      const UNSET_IF_EMPTY = [
        // ⚠️ LINKS RELACIONALES: NUNCA auto-unset
        // 'cliente',
        // 'abono',

        // ✅ solo metadata del abono
        'cocheraId',
        'abonoExpira',
        'abonoVence',
        'abonoDesde',
        'abonoHasta',
        'fechaVencimiento',
        'vencimiento',

        // estadía se maneja aparte
        'estadiaActual',
      ];

      const unsetLinks = {};
      try {
        const remoteSnap = await vehColl.findOne(filter, {
          projection: UNSET_IF_EMPTY.reduce((acc, k) => (acc[k] = 1, acc), {})
        });

        for (const k of UNSET_IF_EMPTY) {
          const localVal = localRaw?.[k];

          const localEmpty =
            localVal === null ||
            localVal === undefined ||
            (typeof localVal === 'string' && localVal.trim() === '') ||
            (Array.isArray(localVal) && localVal.length === 0) ||
            (typeof localVal === 'object' && !Array.isArray(localVal) && localVal && Object.keys(localVal).length === 0);

          const remoteHas = remoteSnap && Object.prototype.hasOwnProperty.call(remoteSnap, k);

          // Si local está vacío y remoto tiene el campo → lo desinstalamos
          if (localEmpty && remoteHas) {
            unsetLinks[k] = '';
          }
        }
      } catch (e) {
        console.warn('[syncService] [vehiculos] no pude leer remoto para build unsetLinks:', String(e && e.message || e));
      }

      // 🧽 7) Unset fino de estadiaActual.* (tu lógica existente)
      let unsetEstadia = {};
      try {
        const remoteSnap2 = await vehColl.findOne(filter, { projection: { estadiaActual: 1 } });
        if (remoteSnap2 && remoteSnap2.estadiaActual && typeof remoteSnap2.estadiaActual === 'object') {
          const localEstadia =
            localRaw.estadiaActual && typeof localRaw.estadiaActual === 'object'
              ? localRaw.estadiaActual
              : null;

          for (const kk of Object.keys(remoteSnap2.estadiaActual)) {
            if (!localEstadia || !(kk in localEstadia)) {
              unsetEstadia[`estadiaActual.${kk}`] = '';
            }
          }
        }
      } catch (e) {
        console.warn('[syncService] [vehiculos] no pude leer remoto para build unsetEstadia:', String(e && e.message || e));
      }

      const updateOps = {
        $set: docWithoutId,
        $setOnInsert: normalizedFullVeh.patente ? { patente: normalizedFullVeh.patente } : {}
      };

      const mergedUnset = { ...unsetLinks, ...unsetEstadia };
      if (Object.keys(mergedUnset).length) updateOps.$unset = mergedUnset;

      const res = await vehColl.updateOne(filter, updateOps, { upsert: true });

      console.log('[syncService] [vehiculos] updateOne remoto', {
        filter,
        matched: res.matchedCount,
        modified: res.modifiedCount,
        upsertedId: res.upsertedId || null,
        unset: Object.keys(mergedUnset)
      });

      // 🆕 REFRESH LOCAL SOLO DEL VEHÍCULO (micro-mirror)
      // No afecta ninguna otra colección.
      // No es mirror global.
      // No pisa estadías ni campos críticos.
      try {
        const vehRemote = await vehColl.findOne(filter);
        if (vehRemote) {
          const localName = await resolveLocalCollectionName(mongoose.connection, 'vehiculos');
          const localVehColl = mongoose.connection.collection(localName);

          const copy = deepClone(vehRemote);
          delete copy._id;

          // ⛔ NO reflejar info derivada de abono
          delete copy.abono;
          delete copy.abonoExpira;
          delete copy.abonoVence;
          delete copy.abonoDesde;
          delete copy.abonoHasta;

          // ⛔ NO tocar campos que el local deriva desde Abono
          delete copy.companiaSeguro;
          delete copy.fotoSeguro;
          delete copy.fotoDNI;
          delete copy.fotoCedulaVerde;
          delete copy.fotoCedulaAzul;

          await localVehColl.updateOne(
            { patente: vehRemote.patente },
            { $set: copy },
            { upsert: true }
          );

          console.log('[syncService] [vehiculos] local actualizado post-push (micro-mirror)');
        }
      } catch (e) {
        console.warn('[syncService] [vehiculos] no se pudo refrescar local post-push:', e.message);
      }

      // ⬅️ importante: NO seguir con la lógica genérica
      return;
    }

    // 🔵 Resto de colecciones → lógica genérica PATCH
    let doc = deepClone(item.document || {});
    coerceRefIds(doc, colName);

    const id = doc._id || extractIdFromItem(item);
    if (!id) throw new Error('sin id en outbox');

    // -----------------------------
    // PATCH 1 — Leer versión completa de cocheras
    // -----------------------------
    let localFull = null;
    if (String(colName).toLowerCase() === 'cocheras') {
      localFull = await Cochera.findById(id).lean();

      if (!localFull) {
        console.warn("[syncService] cochera no encontrada para PATCH:", id);
        return;
      }

      // Usar SIEMPRE la cochera completa (evita doc incompleto)
      doc = deepClone(localFull);
    }

    // -----------------------------
    // Construcción de operadores: $set, $unset, $setOnInsert
    // -----------------------------
    const setBody = deepClone(doc);
    delete setBody._id;

    const $set = removeNulls(setBody);
    const $unset = {};
    const $setOnInsert = {};

    // Unset por valores null
    for (const k of Object.keys(setBody)) {
      if (setBody[k] === null) {
        $unset[k] = "";
        delete $set[k];
      }
    }

    // -----------------------------
    // PATCH 2 — No permitir borrar campos críticos en cocheras
    // -----------------------------
    if (String(colName).toLowerCase() === 'cocheras') {
      delete $unset.cliente;
      delete $unset.vehiculos;
      delete $unset.tipo;
      delete $unset.piso;
      delete $unset.exclusiva;
    }

    // -----------------------------
    // PATCH 3 — Refuerzo anti-doc incompleto (cocheras)
    // -----------------------------
    if (String(colName).toLowerCase() === 'cocheras') {
      if (!doc.cliente && localFull?.cliente) {
        doc.cliente = localFull.cliente;
        $set.cliente = localFull.cliente;
      }
      if ((!Array.isArray(doc.vehiculos) || doc.vehiculos.length === 0) &&
          Array.isArray(localFull.vehiculos)) {
        doc.vehiculos = localFull.vehiculos;
        $set.vehiculos = localFull.vehiculos;
      }
    }

    // -----------------------------
    // Movimientos — protección de fecha
    // -----------------------------
    if (String(colName).toLowerCase() === 'movimientos') {
      if ('fecha' in $set) delete $set.fecha;
      $setOnInsert.fecha = doc.fecha || doc.createdAt || new Date();
    }

    // -----------------------------
    // Operador final
    // -----------------------------
    const updateOps = {};
    if (Object.keys($set).length) updateOps.$set = $set;
    if (Object.keys($unset).length) updateOps.$unset = $unset;
    if (Object.keys($setOnInsert).length) updateOps.$setOnInsert = $setOnInsert;

    const filter = { _id: safeObjectId(id) };

    for (const name of remoteNames) {
      const collection = remoteDb.collection(name);
      await collection.updateOne(filter, updateOps, { upsert: true });
    }

    return;
  }

  // ========================
  // DELETE
  // ========================
  if (item.method === 'DELETE') {
    const id = (item.document && (item.document._id || item.document.id)) || extractIdFromItem(item);
    const isBulk =
      (item.query && (item.query.__bulk === true || item.query.__bulk === 'true')) ||
      (item.query && (item.query.all === true || item.query.all === 'true')) ||
      item.bulk === true || item.bulk === 'true';

    const bulkFilter =
      (item.query && item.query.filter) ||
      (item.document && item.document.filter) || {};

    for (const name of remoteNames) {
      const collection = remoteDb.collection(name);
      if (id) {
        await collection.deleteOne({ _id: safeObjectId(id) });
      } else if (isBulk) {
        const effective = (bulkFilter && typeof bulkFilter === 'object' && Object.keys(bulkFilter).length)
          ? bulkFilter : {};
        await collection.deleteMany(effective);
      } else {
        const doc = item.document || {};
        const nk = buildNaturalKeyFilter(colName, doc);
        if (nk) { await collection.deleteOne(nk); }
        else if (doc.ticket !== undefined) { await collection.deleteOne({ ticket: doc.ticket }); }
        else if (doc.username) { await collection.deleteOne({ username: doc.username }); }
        else if (doc.email)    { await collection.deleteOne({ email: doc.email }); }
        else { throw new Error('DELETE sin id ni bulk flag'); }
      }
    }
    return;
  }

  throw new Error('Método no soportado en outbox: ' + item.method);
}

// =======================
// PULL REMOTO → LOCAL
// =======================

// ❗️Para mirror no usamos la clave natural para dedup (evita perdas y deleteLocal falsos)
function makeSeenKeyIncremental(doc) {
  return String(doc && doc._id);
}

// 🔧 helper: compara Date, devolviendo -1/0/1
function cmpDate(a, b) {
  const ta = a instanceof Date ? a.getTime() : null;
  const tb = b instanceof Date ? b.getTime() : null;
  if (ta === null && tb === null) return 0;
  if (ta === null) return -1;
  if (tb === null) return 1;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

async function upsertLocalDocWithConflictResolution(localCollection, collName, remoteDoc, stats, options = {}) {
  const { mirrorArrays = false } = options;

  // 🛡 GUARD RAILS DEFINITIVO PARA COCHERAS
  // LOCAL es dueño absoluto de la verdad.
  // Solo aceptar docs remotos si NO existen localmente.
  if (collName === 'cocheras') {
    const id = safeObjectId(remoteDoc && remoteDoc._id);
    if (id) {
      let exists = null;

      if (typeof localCollection.findOne === 'function') {
        try {
          exists = await localCollection.findOne({ _id: id }).lean();
        } catch (_) {
          exists = await localCollection.findOne({ _id: id });
        }
      } else {
        exists = await localCollection.findOne({ _id: id });
      }

      if (exists) {
        const localHasCliente = !!exists.cliente;
        const localHasVehs =
          Array.isArray(exists.vehiculos) && exists.vehiculos.length > 0;

        const localEstaSana = localHasCliente && localHasVehs;

        // 🔒 Solo bloqueo si la cochera local está "sana"
        if (localEstaSana) {
          return true; // no dejo que el remoto la toque
        }
        // 🩹 Si local está rota (cliente null o vehiculos vacíos),
        //     dejo que siga el flujo para que el remoto la complete.
      }
    }
  }

  // =============================
  //  FIX 0: Protección ANTES de normalizeIds
  // =============================
  if (collName === 'cocheras') {

    // 🆕 1) Si viene embed: { _id, nombreApellido } → lo colapsamos a solo _id
    if (remoteDoc.cliente && typeof remoteDoc.cliente === 'object') {
      if (remoteDoc.cliente._id) {
        remoteDoc.cliente = remoteDoc.cliente._id;
      }
    }

    // 🆕 2) Si los vehículos vienen embed: [{ _id, patente }] → [ _id, _id, ... ]
    if (Array.isArray(remoteDoc.vehiculos)) {
      remoteDoc.vehiculos = remoteDoc.vehiculos.map(v => {
        if (v && typeof v === 'object' && v._id) return v._id;
        return v;
      });
    }

    // 🔎 Limpieza de basura, pero sin romper cliente/vehiculos si vienen bien
    if (remoteDoc.tipo !== undefined && String(remoteDoc.tipo).trim() === "") {
      delete remoteDoc.tipo;
    }

    if (remoteDoc.piso !== undefined && String(remoteDoc.piso).trim() === "") {
      delete remoteDoc.piso;
    }

    if (remoteDoc.exclusiva === null || remoteDoc.exclusiva === undefined) {
      delete remoteDoc.exclusiva;
    }

    // vehiculos vacío no pisa local
    if (Array.isArray(remoteDoc.vehiculos) && remoteDoc.vehiculos.length === 0) {
      delete remoteDoc.vehiculos;
    }

    // cliente null NO se toca acá: lo decide más abajo el bloque NO-DESTRUCTIVO
  }

  // Ahora sí normalizamos IDs
  const cleaned = normalizeIds(remoteDoc, collName);
  cleaned._id = safeObjectId(cleaned._id);
  const _id = cleaned._id;

  // ✅ Snapshot local solo para cocheras (para reglas NO-DESTRUCTIVAS en cliente/vehiculos)
  let localDocForCochera = null;
  if (collName === 'cocheras') {
    try {
      if (typeof localCollection.findOne === 'function') {
        localDocForCochera = await localCollection.findOne({ _id }).lean();
      } else {
        localDocForCochera = await localCollection.findOne({ _id });
      }
    } catch (_) {
      localDocForCochera = null;
    }
  }

  const REL_ARRAYS_BY_COLL = { clientes: ['abonos','vehiculos','movimientos'] };
  const relArrays = new Set(REL_ARRAYS_BY_COLL[collName?.toLowerCase()] || []);

  const rest = deepClone(cleaned); delete rest._id;

  const addToSet = {};
  const pullOps  = {};
  const setOps   = {};
  const unsetOps = {};
  const setOnInsert = {};

  for (const field of Object.keys(rest)) {
    if (!relArrays.has(field)) continue;
    const val = rest[field];
    if (val == null) { delete rest[field]; continue; }
    if (!Array.isArray(val)) { delete rest[field]; continue; }
    const arr = val.map(safeObjectId).filter(Boolean);

    if (mirrorArrays) {
      if (arr.length > 0) {
        setOps[field] = arr;
        pullOps[field] = { $nin: arr };
      }
    } else {
      if (arr.length > 0) addToSet[field] = { $each: arr };
    }
    delete rest[field];
  }

  // =====================
  // FIX NO-DESTRUCTIVO COMPLETO PARA COCHERAS
  // =====================
  if (collName === 'cocheras') {

    for (const key of Object.keys(rest)) {
      const v = rest[key];

      // 1) CLIENTE: solo usamos el remoto para RELLENAR si local no tiene nada.
      if (key === 'cliente') {
        const localHasCliente = !!(localDocForCochera && localDocForCochera.cliente);

        const remoteHasCliente =
          v !== null &&
          v !== undefined &&
          !(typeof v === 'string' && v.trim() === '');

        // Si local NO tiene cliente y remoto trae uno válido → lo usamos
        if (!localHasCliente && remoteHasCliente) {
          setOps[key] = v;
        }
        // En cualquier otro caso NO tocamos cliente
        continue;
      }

      // 2) NO pisar vehiculos[] si remoto viene vacío y local tiene algo
      if (key === 'vehiculos') {
        if (Array.isArray(v) && v.length === 0) {
          const localHasVehs =
            localDocForCochera &&
            Array.isArray(localDocForCochera.vehiculos) &&
            localDocForCochera.vehiculos.length > 0;

          if (localHasVehs) {
            continue; // dejamos los vehiculos locales
          }
        }
      }

      // 3) NO pisar ningún campo si el remoto viene vacío
      if (
        v === null || v === undefined ||
        (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0)
      ) {
        continue;
      }

      // ✔ aplicar valor remoto solo si es válido
      setOps[key] = v;
    }

  } else {
    // comportamiento estándar para otras colecciones
    for (const key of Object.keys(rest)) {
      setOps[key] = rest[key];
    }
  }

  // También aseguramos que no metas campos null
  Object.assign(setOps, removeNulls(setOps));

  const isMovs = String(collName).toLowerCase() === 'movimientos';
  if (isMovs) {
    if (Object.prototype.hasOwnProperty.call(setOps, 'fecha')) delete setOps.fecha;
    const creationDate = cleaned.fecha || cleaned.createdAt || new Date();
    setOnInsert.fecha = creationDate;
  }

  // 🛑 Protecciones extra para vehículos (estadiaActual)
  if (String(collName).toLowerCase() === 'vehiculos') {
    const localDoc = await localCollection.findOne(
      { _id },
      { projection: { estadiaActual: 1 } }
    );

    if (localDoc) {
      const localSinEstadia =
        !localDoc.estadiaActual ||
        (typeof localDoc.estadiaActual === 'object' &&
          !Array.isArray(localDoc.estadiaActual) &&
          Object.keys(localDoc.estadiaActual).length === 0);

      if (localSinEstadia) {
        unsetOps.estadiaActual = "";
        if (setOps && Object.prototype.hasOwnProperty.call(setOps, 'estadiaActual')) {
          delete setOps.estadiaActual;
        }
        if (cleaned.estadiaActual) delete cleaned.estadiaActual;
      }
    }

    const hasEstadia = Object.prototype.hasOwnProperty.call(cleaned, 'estadiaActual');
    const isEmpty =
      hasEstadia &&
      cleaned.estadiaActual &&
      typeof cleaned.estadiaActual === 'object' &&
      !Array.isArray(cleaned.estadiaActual) &&
      Object.keys(cleaned.estadiaActual).length === 0;

    if (!hasEstadia || isEmpty) {
      unsetOps.estadiaActual = "";
      if (hasEstadia && setOps && Object.prototype.hasOwnProperty.call(setOps, 'estadiaActual')) {
        delete setOps.estadiaActual;
      }
    }
  }

  const updateOps = {};
  if (Object.keys(setOps).length)     updateOps.$set      = setOps;
  if (Object.keys(addToSet).length)   updateOps.$addToSet = addToSet;
  if (Object.keys(unsetOps).length)   updateOps.$unset    = unsetOps;
  if (mirrorArrays) {
    for (const k of Object.keys(pullOps)) {
      if (updateOps.$set && Object.prototype.hasOwnProperty.call(updateOps.$set, k)) {
        updateOps.$pull = Object.assign(updateOps.$pull || {}, { [k]: pullOps[k] });
      }
    }
  }
  if (Object.keys(setOnInsert).length) updateOps.$setOnInsert = setOnInsert;

  try {
    await localCollection.updateOne(
      { _id },
      Object.keys(updateOps).length
        ? updateOps
        : (isMovs ? { $setOnInsert: { fecha: new Date() } } : { $set: {} }),
      { upsert: true }
    );

    // 🧹 Compactación local segura para movimientos dedup
    if (isMovs && cleaned.dedup === true && cleaned.movimiento && cleaned.movimiento._id) {
      const baseId = safeObjectId(cleaned.movimiento._id);
      if (baseId && String(baseId) !== String(_id)) {
        const delRes = await localCollection.deleteOne({ _id: baseId });
        if (delRes?.deletedCount && stats) stats.deletedLocal = (stats.deletedLocal || 0) + delRes.deletedCount;
      }
    }

    return true;
  } catch (err) {
    const code = err && (err.code || err?.errorResponse?.code);
    if (code !== 11000) throw err;

    // 🔁 Resolución de conflictos UNIQUE por claves naturales
    const keys = NATURAL_KEYS[collName?.toLowerCase()] || [];
    let anyDelete = false;
    for (const k of keys) {
      if (cleaned[k] === undefined || cleaned[k] === null) continue;
      const f = {}; f[k] = cleaned[k]; f._id = { $ne: cleaned._id };
      const delRes = await localCollection.deleteMany(f);
      if (delRes?.deletedCount) {
        anyDelete = true;
        console.warn(`[syncService] ${collName}: conflicto UNIQUE (${k}="${cleaned[k]}"). Borré locales duplicados: ${delRes.deletedCount}.`);
      }
    }

    if (!anyDelete) {
      const msg = String(err.message || '');
      const m = msg.match(/dup key:\s*\{\s*([^}]+)\s*\}/i);
      if (m && m[1]) {
        const pair = m[1].split(':').map(s => s.trim());
        if (pair.length >= 2) {
          const field = pair[0].replace(/^\{?\s*"?(\w+)"?\s*$/, '$1');
          const value = (pair.slice(1).join(':').trim().replace(/^"|"$/g, ''));
          if (field && value !== undefined) {
            const f = {}; f[field] = value; f._id = { $ne: cleaned._id };
            const delRes = await localCollection.deleteMany(f);
            if (delRes?.deletedCount) {
              anyDelete = true;
              console.warn(`[syncService] ${collName}: conflicto UNIQUE (${field}="${value}"). Borré locales duplicados: ${delRes.deletedCount}.`);
            }
          }
        }
      }
    }

    await localCollection.updateOne(
      { _id },
      Object.keys(updateOps).length
        ? updateOps
        : (isMovs ? { $setOnInsert: { fecha: new Date() } } : { $set: {} }),
      { upsert: true }
    );
    return true;
  }
}


// === Detección de campo temporal para incremental ===
const _hasTemporalFieldCache = new Map();
async function detectTemporalField(remoteDb, collName) {
  const key = `${remoteDb.databaseName}#${collName}`;
  if (_hasTemporalFieldCache.has(key)) return _hasTemporalFieldCache.get(key);

  let field = null;
  try {
    const c = remoteDb.collection(collName);
    const doc = await c.find({}, { projection: { updatedAt: 1, createdAt: 1 }, limit: 1 }).next();
    if (doc?.updatedAt instanceof Date) field = 'updatedAt';
    else if (doc?.createdAt instanceof Date) field = 'createdAt';
  } catch {}
  _hasTemporalFieldCache.set(key, field);
  return field;
}

// 🔁 NUEVAS funciones con migración en caliente desde `collection` -> `canon`
async function getSyncState(collName) {
  const canon = canonicalizeName(collName);
  let st = await SyncState.findOne({ canon });

  if (!st) {
    const legacy = await SyncState.findOne({ collection: canon }).lean();
    if (legacy) {
      await SyncState.updateOne(
        { _id: legacy._id },
        { $set: { canon }, $unset: { collection: "" } }
      );
      st = await SyncState.findOne({ canon });
    }
  }
  if (!st) st = await SyncState.create({ canon, meta: {} });
  if (!st.meta) { st.meta = {}; await st.save().catch(()=>{}); }
  return st;
}
async function saveSyncState(collName, patch) {
  const canon = canonicalizeName(collName);
  await SyncState.updateOne(
    { canon },
    { $set: { ...patch, canon }, $unset: { collection: "" } },
    { upsert: true }
  );
}

async function pullCollectionsFromRemote(remoteDb, requestedCollections = [], opts = {}) {
  const {
    pullAll = false,
    mirrorAll = false,
    mirrorCollections = [],
    skipCollections = [],
    skipCollectionsSet = new Set(),
    incrementalBatch = Number(process.env.SYNC_PULL_BATCH) || 5000,
  } = opts;

  const resultCounts = {};
  let collections = requestedCollections;

  if (pullAll) {
    const cols = await remoteDb.listCollections().toArray();
    const namesRaw = cols.map(c => c.name).filter(n => !n.startsWith('system.') && n !== 'outbox' && n !== 'sync_state');
    const canonicalized = namesRaw.map(canonicalizeName);
    collections = Array.from(new Set(canonicalized));
  }

  const skipConfigured = new Set((skipCollections || []).map(s => s.toLowerCase()));

  collections = (collections || [])
    .filter(c => c !== 'counters')
    .filter(c => !skipConfigured.has(String(c).toLowerCase()))
    .filter(c => !skipCollectionsSet.has(c));

  if (!collections.length) return resultCounts;

  for (const coll of collections) {
    const canonName = canonicalizeName(coll);
    const stats = { remoteTotal: 0, upsertedOrUpdated: 0, deletedLocal: 0, conflictsResolved: 0 };

    // ============================
    // COLECCIÓN ESPECIAL: PRECIOS
    // ============================
    if (canonName === 'precios') {
      try {
        const isMirrorThisCollection = !!(mirrorAll || new Set(mirrorCollections || []).has('precios'));
        const { docs, source, allowMirrorDelete } = await fetchPreciosDocs();
        const preciosReadonly = String(process.env.PRECIOS_READONLY || '').trim() === '1';
        const canDelete = allowMirrorDelete && !preciosReadonly;

        stats.remoteTotal = docs.length;

        const localName = await resolveLocalCollectionName(mongoose.connection, 'precios');
        const localCollection = mongoose.connection.collection(localName);

        for (const d of docs) {
          await upsertLocalDocWithConflictResolution(localCollection, 'precios', d, stats, { mirrorArrays: false });
          stats.upsertedOrUpdated++;
        }

        if (isMirrorThisCollection) {
          if (canDelete) {
            const remoteIds = new Set(docs.map(d => String(d._id)));
            const localIdsDocs = await localCollection.find({}, { projection: { _id: 1 } }).toArray();
            const toDeleteObjIds = [];
            for (const ld of localIdsDocs) {
              const idRaw = ld._id; const idStr = String(idRaw);
              if (!remoteIds.has(idStr)) {
                if (idRaw instanceof ObjectId) toDeleteObjIds.push(idRaw);
                else if (typeof idRaw === 'string' && is24Hex(idRaw)) toDeleteObjIds.push(new ObjectId(idRaw));
                else {
                  const delOne = await localCollection.deleteOne({ _id: idRaw });
                  if (delOne?.deletedCount) stats.deletedLocal += delOne.deletedCount;
                }
              }
            }
            if (toDeleteObjIds.length) {
              const { deletedCount } = await localCollection.deleteMany({ _id: { $in: toDeleteObjIds } });
              stats.deletedLocal += deletedCount || 0;
            }
          } else {
            console.log('[syncService] precios: mirror FULL saltado (cache o readonly).');
          }
        }

        resultCounts['precios'] = stats;
        const mirrorFlag = isMirrorThisCollection ? (allowMirrorDelete ? '[mirror:FULL/http]' : '[http/cache-no-delete]') : '[http]';
        console.log(
          `[syncService] pulled precios (fuente=${source}) (db="${remoteDb.databaseName}"): ` +
          `remote=${stats.remoteTotal}, upserted=${stats.upsertedOrUpdated}, deletedLocal=${stats.deletedLocal} ${mirrorFlag} (buckets: efectivo+otros)`
        );
      } catch (err) {
        console.warn('[syncService] no se pudo pull precios:', err.message || err);
      }
      continue; // siguiente coll
    }

    // ============================
    // RESTO DE COLECCIONES (Atlas)
    // ============================
    try {
      const remoteNames = getRemoteNames(canonName);
      const union = [];
      const seenIds = new Set(); // solo por _id para evitar duplicados idénticos entre alias

      const isMirrorThisCollection = !!(mirrorAll || new Set(mirrorCollections || []).has(canonName));
      const st = await getSyncState(canonName);
      const temporalField = await detectTemporalField(remoteDb, remoteNames[0]);

      // Checkpoint previo (para tie-break en frontera)
      const lastTs = st.lastUpdatedAt instanceof Date ? st.lastUpdatedAt : null;
      const lastId = is24Hex(st.lastObjectId || '') ? st.lastObjectId : null;

      for (const name of remoteNames) {
        try {
          const rc = remoteDb.collection(name);
          let filter = {};
          let sort = {};

          if (isMirrorThisCollection) {
            sort = { _id: 1 }; // FULL SCAN
          } else {
            if (temporalField) {
              // ✅ Incremental robusto: ts > lastTs  OR  (ts == lastTs AND _id > lastId)
              if (lastTs || lastId) {
                const orConds = [{ [temporalField]: { $gt: lastTs || new Date(0) } }];
                if (lastTs && lastId) {
                  orConds.push({ [temporalField]: lastTs, _id: { $gt: safeObjectId(lastId) } });
                }
                filter = { $or: orConds };
              }
              sort = { [temporalField]: 1, _id: 1 };
            } else if (lastId) {
              filter = { _id: { $gt: safeObjectId(lastId) } };
              sort = { _id: 1 };
            } else {
              sort = { _id: 1 };
            }
          }

          let lastDoc = null;
          const cursor = rc.find(filter).sort(sort);
          while (await cursor.hasNext()) {
            const batch = [];
            while (batch.length < incrementalBatch && await cursor.hasNext()) {
              const d = await cursor.next();
              batch.push(d);
            }
            for (const d of batch) {
              const idStr = String(d._id);
              if (seenIds.has(idStr)) continue;
              seenIds.add(idStr);
              union.push(d);
              lastDoc = d;
            }
          }

          // Trackear máximos para checkpoint compuesto (ts, _id)
          if (lastDoc) {
            const ts = temporalField && (lastDoc[temporalField] instanceof Date) ? lastDoc[temporalField] : null;
            const oidStr = String(hexFromAny(lastDoc._id) || '');

            // Guardamos provisoriamente en memoria del proceso (st._tmp*)
            if (ts) {
              // max por fecha
              if (!st._tmpMaxDate || cmpDate(ts, st._tmpMaxDate) > 0) {
                st._tmpMaxDate = ts;
                st._tmpMaxIdAtMaxDate = oidStr;
              } else if (cmpDate(ts, st._tmpMaxDate) === 0) {
                // si misma fecha, usar mayor _id
                if (!st._tmpMaxIdAtMaxDate || oidStr > st._tmpMaxIdAtMaxDate) {
                  st._tmpMaxIdAtMaxDate = oidStr;
                }
              }
            } else {
              // sin campo temporal, solo _id
              if (!st._tmpMaxId || oidStr > st._tmpMaxId) st._tmpMaxId = oidStr;
            }
          }
        } catch (e) {
          // alias faltante -> ignoro
        }
      }

      stats.remoteTotal = union.length;

      // ======================================================
      // 🔥 USAR MODELO MONGOOSE REAL (elimina Native Collection)
      // ======================================================
      // ✅ En PULL usamos SIEMPRE Native Collection (evita mixed API Model vs Driver)
      const localName = await resolveLocalCollectionName(mongoose.connection, canonName);
      const localCollection = mongoose.connection.collection(localName);

      for (let raw of union) {

        // 🟥 PULL INICIAL → importar cocheras "completas"
        if (!INITIAL_PULL_DONE && canonName === 'cocheras') {
            // 1) Normalize cliente embed → ObjectId
            if (raw.cliente && typeof raw.cliente === "object" && raw.cliente._id) {
                raw.cliente = raw.cliente._id;
            }

            // 2) Normalize vehículos embed → ObjectId[]
            if (Array.isArray(raw.vehiculos)) {
                raw.vehiculos = raw.vehiculos.map(v =>
                    v && typeof v === "object" && v._id ? v._id : v
                );
            }

            // 3) Limpieza suave (no borrar nada crítico)
            if (raw.tipo === "") delete raw.tipo;
            if (raw.piso === "") delete raw.piso;
            if (raw.exclusiva == null) delete raw.exclusiva;

            // 4) Insert/replace DIRECTO SIN GUARD RAILS
            await localCollection.updateOne(
                { _id: safeObjectId(raw._id) },
                { $set: raw },
                { upsert: true }
            );

            stats.upsertedOrUpdated++;
            continue; // 🟢 No usar la lógica pesada normal
        }

        // 🟦 Resto de colecciones / pulls posteriores
        await upsertLocalDocWithConflictResolution(localCollection, canonName, raw, stats, {
            mirrorArrays: isMirrorThisCollection
        });
        stats.upsertedOrUpdated++;
    }

      if (union.length && !isMirrorThisCollection) {
        const patch = {};
        if (st._tmpMaxDate) {
          patch.lastUpdatedAt = st._tmpMaxDate;
          if (st._tmpMaxIdAtMaxDate) patch.lastObjectId = st._tmpMaxIdAtMaxDate;
        } else if (st._tmpMaxId) {
          patch.lastObjectId = st._tmpMaxId;
        }
        if (Object.keys(patch).length) await saveSyncState(canonName, patch);
      }

      if (isMirrorThisCollection) {
        const remoteIds = new Set(union.map(d => String(d._id)));
        const localIdsDocs = await localCollection.find({}, { projection: { _id: 1 } }).toArray();

        const toDeleteObjIds = [];
        for (const d of localIdsDocs) {
          const idRaw = d._id;
          const idStr = String(idRaw);
          if (!remoteIds.has(idStr)) {
            if (idRaw instanceof ObjectId) toDeleteObjIds.push(idRaw);
            else if (typeof idRaw === 'string' && is24Hex(idRaw)) toDeleteObjIds.push(new ObjectId(idRaw));
            else {
              const delOne = await localCollection.deleteOne({ _id: idRaw });
              if (delOne?.deletedCount) stats.deletedLocal += delOne.deletedCount;
            }
          }
        }
        if (toDeleteObjIds.length) {
          const { deletedCount } = await localCollection.deleteMany({ _id: { $in: toDeleteObjIds } });
          stats.deletedLocal += deletedCount || 0;
        }
      }

      resultCounts[canonName] = stats;
      const aliasNote = remoteNames.length > 1 ? ` (aliases: ${remoteNames.join(', ')})` : '';
      const mirrorFlag = isMirrorThisCollection ? '[mirror:FULL]' : '';
      console.log(
        `[syncService] pulled ${canonName}${aliasNote} (db="${remoteDb.databaseName}"): ` +
        `remote=${stats.remoteTotal}, upserted=${stats.upsertedOrUpdated}, deletedLocal=${stats.deletedLocal}` +
        `${stats.conflictsResolved ? `, conflictsResolved=${stats.conflictsResolved}` : ''} ${mirrorFlag}`
      );
    } catch (err) {
      console.warn(`[syncService] no se pudo pull ${canonName}:`, err.message || err);
    }
  }

  // Ajuste de counter ticket post-pull
  try {
    const maxTicket = await Ticket.findOne().sort({ ticket: -1 }).select('ticket').lean();
    const maxNumero = maxTicket && typeof maxTicket.ticket === 'number' ? maxTicket.ticket : 0;
    const seq = await Counter.ensureAtLeast('ticket', maxNumero);
    console.log(`[syncService] counter 'ticket' ajustado post-pull a >= ${maxNumero}. seq=${seq}`);
  } catch (e) {
    console.warn('[syncService] no se pudo ajustar counter post-pull:', e.message);
  }

  // ============================================
  // 🔥 AJUSTE ticketPago post-pull (necesario SIEMPRE)
  // ============================================
  try {
    let max = 0;

    // 1) ticketPago en root
    const lastRoot = await Movimiento.findOne({ ticketPago: { $gte: 1 } })
      .sort({ ticketPago: -1 })
      .select('ticketPago')
      .lean();

    if (lastRoot && typeof lastRoot.ticketPago === 'number') {
      max = Math.max(max, lastRoot.ticketPago);
    }

    // 2) ticketPago en movimiento.ticketPago (logs que vienen del remoto)
    const lastNested = await Movimiento.findOne({ 'movimiento.ticketPago': { $gte: 1 } })
      .sort({ 'movimiento.ticketPago': -1 })
      .select('movimiento.ticketPago')
      .lean();

    if (lastNested && lastNested.movimiento && typeof lastNested.movimiento.ticketPago === 'number') {
      max = Math.max(max, lastNested.movimiento.ticketPago);
    }

    const valor = max;

    const ctrl = require('../controllers/movimientoControllers');
    if (typeof ctrl._setLastTicketPago === 'function') {
      ctrl._setLastTicketPago(valor);
      console.log(`[syncService] ticketPago ajustado post-pull a ${valor}`);
    } else {
      console.warn('[syncService] _setLastTicketPago no encontrado en movimientoControllers');
    }
  } catch (e) {
    console.warn('[syncService] no se pudo ajustar ticketPago post-pull:', e.message);
  }


  return resultCounts;

}

// =======================
// PRECIOS LOCAL-ONLY (HTTP) — SIEMPRE, AÚN SIN ATLAS
// =======================
async function syncPreciosLocalOnly({ mirrorAll = false, mirrorCollections = [] } = {}) {
  try {
    const { docs, source, allowMirrorDelete } = await fetchPreciosDocs();
    const localName = await resolveLocalCollectionName(mongoose.connection, 'precios');
    const localCollection = mongoose.connection.collection(localName);
    let upserted = 0, deleted = 0;

    for (const d of docs) {
      await upsertLocalDocWithConflictResolution(localCollection, 'precios', d, null, { mirrorArrays: false });
      upserted++;
    }

    const isMirrorThisCollection = !!(mirrorAll || new Set(mirrorCollections || []).has('precios'));
    if (isMirrorThisCollection && allowMirrorDelete) {
      const remoteIds = new Set(docs.map(d => String(d._id)));
      const localIdsDocs = await localCollection.find({}, { projection: { _id: 1 } }).toArray();
      const toDeleteObjIds = [];
      for (const ld of localIdsDocs) {
        const idRaw = ld._id; const idStr = String(idRaw);
        if (!remoteIds.has(idStr)) {
          if (idRaw instanceof ObjectId) toDeleteObjIds.push(idRaw);
          else if (typeof idRaw === 'string' && is24Hex(idRaw)) toDeleteObjIds.push(new ObjectId(idRaw));
          else {
            const delOne = await localCollection.deleteOne({ _id: idRaw });
            if (delOne?.deletedCount) deleted += delOne.deletedCount;
          }
        }
      }
      if (toDeleteObjIds.length) {
        const { deletedCount } = await localCollection.deleteMany({ _id: { $in: toDeleteObjIds } });
        deleted += deletedCount || 0;
      }
    } else if (isMirrorThisCollection && !allowMirrorDelete) {
      console.log('[syncService] precios: espejo estricto saltado para borrado (fuente=cache).');
    }

    status.lastPullCounts = { ...status.lastPullCounts, precios: { remoteTotal: docs.length, upsertedOrUpdated: upserted, deletedLocal: deleted } };
    console.log(`[syncService] precios local-only (${source}) -> upserted=${upserted}, deleted=${deleted} (buckets: efectivo+otros)`);
  } catch (e) {
    console.warn('[syncService] precios local-only falló:', e.message || e);
  }
}

// =======================
// CICLO DE SINCRONIZACIÓN (REMOTE-FIRST)
// =======================
async function syncTick(atlasUri, opts = {}, statusCb = () => {}) {
  if (syncing) return;
  syncing = true;
  status.lastRun = new Date();
  status.lastError = null;
  status.pendingOutbox = 0;
  statusCb(status);

  try {
    //✅ SIEMPRE: hidratar precios al local (HTTP + cache), incluso sin internet
    await syncPreciosLocalOnly({ mirrorAll: !!opts.mirrorAll, mirrorCollections: opts.mirrorCollections || [] });
    const internet = await hasInternet();
    if (!internet) {
      status.online = false;
      status.lastError = 'No hay conexión a Internet, saltando SYNC';
      statusCb(status);
      console.warn('[syncService] No hay conexion, salteando SYNC');
      return;
    }

    let remoteDb = null;
    try {
      SELECTED_REMOTE_DBNAME = opts.remoteDbName || SELECTED_REMOTE_DBNAME || null;
      const existing = getRemoteDbInstance();
      remoteDb = existing || await connectRemote(atlasUri, SELECTED_REMOTE_DBNAME);
    } catch (err) {
      status.online = false;
      status.lastError = `No se pudo conectar a Atlas: ${err.message || err}`;
      statusCb(status);
      console.warn('[syncService] Sin conexión a Atlas. Saltando sync:', err.message || err);
      return; // ojo: ya actualizamos precios localmente arriba
    }

    status.online = true;
    statusCb(status);

    // === A) PULL REMOTO → LOCAL (incremental para todas menos espejo)
    const pullOptsA = {
      pullAll: !!opts.pullAll,
      mirrorAll: false,
      mirrorCollections: [],
      skipCollections: opts.skipCollections || [],
      skipCollectionsSet: new Set(),
    };
    const collectionsEnvA = Array.isArray(opts.pullCollections) ? opts.pullCollections.filter(Boolean) : [];
    let reqA = pullOptsA.pullAll ? collectionsEnvA : collectionsEnvA;
    // ⛔ Después del primer pull, excluir cocheras del PULL (solo push)
    if (INITIAL_PULL_DONE) {
      reqA = reqA.filter(c => canonicalizeName(c) !== 'cocheras');
    }
    const pullCountsA = await pullCollectionsFromRemote(remoteDb, reqA, pullOptsA);
    status.lastPullCounts = pullCountsA;
    statusCb(status);

    // === B) OUTBOX local → remoto
    const bulkDeletedCollections = new Set();

    if (process.env.SYNC_DISABLE_PUSH === '1') {
      console.log('[syncService] push deshabilitado por env');
      status.pendingOutbox = 0;
      statusCb(status);
    } else {
      const pending = await Outbox.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200);
      status.pendingOutbox = pending.length;
      statusCb(status);

      for (const item of pending) {
        const preColName = getCollectionNameFromItem(item);
        const canonPreCol = canonicalizeName(preColName || '');
        const preIsDelete = item.method === 'DELETE';
        const preHasId = !!extractIdFromItem(item);
        const preIsBulk = preIsDelete && (
          (item.query && (item.query.__bulk === true || item.query.__bulk === 'true')) ||
          (item.query && (item.query.all === true || item.query.all === 'true')) ||
          item.bulk === true || item.bulk === 'true'
        );
        const shouldSkipPullThisTick = preIsDelete && !preHasId && preIsBulk && !!preColName;

        try {
          await Outbox.updateOne({ _id: item._id }, { status: 'processing' });

          // ⛔️ BLOQUEO DE PUSH para colecciones espejadas (SYNC_MIRROR)
          if (preColName && isMirrorBlockedCollection(preColName, opts)) {
            await Outbox.updateOne(
              { _id: item._id },
              { status: 'synced', syncedAt: new Date(), error: null, note: 'push_blocked_by_mirror' }
            );
            console.log(`[syncService] push bloqueado por mirror para "${canonicalizeName(preColName)}" (${item.method})`);
            continue; // NO empujar al remoto
          }

          if (!preColName && !/\/api\/abonos\/registrar-abono/i.test(item?.route || '')) {
            await Outbox.updateOne({ _id: item._id }, { status: 'error', error: 'invalid_collection', retries: 6 });
            continue;
          }
          if (
            ['POST','PUT','PATCH'].includes(item.method) &&
            !looksLikeValidDocument(item.document) &&
            !/\/api\/abonos\/registrar-abono/i.test(item?.route || '') &&
            canonPreCol !== 'vehiculos'             // ⬅️ PERMITIMOS vehiculos aunque el doc esté vacío
          ) {
            await Outbox.updateOne(
              { _id: item._id },
              { status: 'error', error: 'invalid_document', retries: 6 }
            );
            continue;
          }

          await processOutboxItem(remoteDb, item);
          await Outbox.updateOne({ _id: item._id }, { status: 'synced', syncedAt: new Date(), error: null });
        } catch (err) {
          const errMsg = String(err?.message || err).slice(0, 1000);
          const retries = (item.retries || 0) + 1;

          const nonRetriableCodes = [
            'invalid_collection',
            'invalid_document',
            'sin id en outbox',
            'duplicate key',
            11000,
            'bulk_delete_not_allowed',
            'bulk_delete_requires_filter',
            'DELETE sin id ni bulk flag',
            'composite_registrar_abono: no se encontraron docs locales para sincronizar'
          ];
          const isNonRetriable = nonRetriableCodes.some(code =>
            (typeof code === 'string' && errMsg.includes(code)) ||
            (typeof code === 'number' && err && err.code === code)
          );

          const update = {
            error: errMsg,
            retries,
            status: isNonRetriable || retries >= 6 ? 'error' : 'pending'
          };
          await Outbox.updateOne({ _id: item._id }, update);
          console.error('[syncService] error procesando outbox item', item._id, errMsg);
        } finally {
          if (shouldSkipPullThisTick && preColName) bulkDeletedCollections.add(canonicalizeName(preColName));
        }
      }
    }

    // === C) MINI-PULL FINAL DESHABILITADO ===
    // No hacemos un segundo pull/mirror para evitar que colecciones locales
    // como vehículos, clientes, cocheras, etc. queden pisadas.
    console.log('[syncService] mini-pull espejo final DESHABILITADO');

  } catch (err) {
    status.lastError = String(err).slice(0, 2000);
    status.online = false;
    console.warn('[syncService] tick error:', err.message || err);
    statusCb(status);
  } finally {
    syncing = false;
    statusCb(status);
  }
}

// ===============================
// MASTER SWITCH DE SINCRONIZACIÓN
// ===============================
// SYNC_ENABLED:
// 1 → sync completo: inicial + periódico + push
// 0 → SOLO PULL INICIAL ABSOLUTO (sin loop, sin push, sin incremental)
const SYNC_ENABLED = process.env.SYNC_ENABLED !== '0';

// Si está apagado → bloquear push y forzar FULL PULL
if (!SYNC_ENABLED) {
  process.env.SYNC_DISABLE_PUSH = '1';
  process.env.SYNC_PULL = '*';
}

// ===============================
function startPeriodicSync(atlasUri, opts = {}, statusCb = () => {}) {
  console.log("[syncService] SYNC_ENABLED =", SYNC_ENABLED);

  const intervalMs = opts.intervalMs || 30000;

  // ============================================================
  // 🔴 MODO SYNC OFF → solo pull inicial absoluto
  // ============================================================
  if (!SYNC_ENABLED) {
    console.log("[syncService] SYNC desactivado. Haciendo SOLO PULL INICIAL...");

    const initialOpts = {
      pullAll: true,
      mirrorAll: false,
      mirrorCollections: opts.mirrorCollections || [],
      skipCollections: opts.skipCollections || [],
      remoteDbName: opts.remoteDbName
    };

    syncTick(atlasUri, initialOpts, statusCb)
      .then(() => console.log("[syncService] PULL INICIAL COMPLETADO (SYNC apagado)."))
      .catch(err => console.error("[syncService] Error en pull inicial:", err));

    return {
      stop: () => {},
      runOnce: () => Promise.resolve(),
      getStatus: () => ({ ...status }),
      inspectRemote: async () => ({ remoteDbName: null, counts: {} })
    };
  }

  // ============================================================
  // 🔵 SYNC ON
  // ============================================================
  console.log("[syncService] iniciando sincronizador. Intervalo =", intervalMs, "ms");

  if (opts.remoteDbName) {
    SELECTED_REMOTE_DBNAME = opts.remoteDbName;
    console.log(`[syncService] Base remota usada: "${SELECTED_REMOTE_DBNAME}"`);
  }

  const effectiveOpts = {
    ...opts,
    pullCollections:
      process.env.SYNC_PULL
        ? process.env.SYNC_PULL.split(",").filter(Boolean)
        : [],
  };

  // ████████████████████████████████████████████████████████
  // PRIMER TICK (ÚNICO MOMENTO DONDE COCHERAS ACEPTA PULL)
  // ████████████████████████████████████████████████████████
  syncTick(atlasUri, effectiveOpts, statusCb)
    .then(() => {
      INITIAL_PULL_DONE = true;
      console.log("[syncService] Primer pull completado → cocheras ahora PUSH-ONLY.");
    })
    .catch(err => console.error("[syncService] primer tick falló:", err));

  // LOOP PERIÓDICO
  const handle = setInterval(
    () => syncTick(atlasUri, effectiveOpts, statusCb),
    intervalMs
  );

  return {
    stop: () => clearInterval(handle),
    runOnce: () => syncTick(atlasUri, effectiveOpts, statusCb),
    getStatus: () => ({ ...status }),
    inspectRemote: async (cols = []) => {
      const db =
        getRemoteDbInstance() ||
        await connectRemote(atlasUri, SELECTED_REMOTE_DBNAME);

      let collections = cols.length
        ? cols
        : (await db.listCollections().toArray()).map(c =>
            canonicalizeName(c.name)
          );

      const out = {};
      for (const c of collections) {
        try {
          let total = 0;
          for (const name of getRemoteNames(c)) {
            try {
              total += await db.collection(name).countDocuments();
            } catch (_) {}
          }
          out[c] = total;
        } catch (e) {
          out[c] = `err: ${e.message}`;
        }
      }
      return { remoteDbName: db.databaseName, counts: out };
    }
  };
}

module.exports = { startPeriodicSync, connectRemote, syncTick };
