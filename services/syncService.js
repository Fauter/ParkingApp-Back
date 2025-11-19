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
};
const NATURAL_KEYS = {
  tickets: ['ticket'],
  users: ['username', 'email'],
  vehiculos: ['patente'],
  clientes: ['dniCuitCuil', 'email'],
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

function normalizeIds(inputDoc, colName) {
  const clone = deepClone(inputDoc || {});
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
  if (!MovimientoCliente) { try { MovimientoCliente = require('../models/MovimientoCliente'); } catch (_) {} }
  let movCli = null;
  if (MovimientoCliente && cliente) {
    movCli = await MovimientoCliente.findOne({ cliente: cliente._id }).sort({ createdAt: -1 }).lean();
  }

  let pushed = 0;
  pushed += await upsertRemoteDoc(remoteDb, 'clientes', cliente);
  pushed += await upsertRemoteDoc(remoteDb, 'vehiculos', vehiculo);
  pushed += await upsertRemoteDoc(remoteDb, 'abonos', abono);
  // NO: pushed += await upsertRemoteDoc(remoteDb, 'movimientos', mov);
  pushed += await upsertRemoteDoc(remoteDb, 'movimientoclientes', movCli);

  if (!pushed) throw new Error('composite_registrar_abono: no se encontraron docs locales para sincronizar');
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

  if (item.method !== 'DELETE' && !looksLikeValidDocument(item.document) && !isComposite) {
    throw new Error('invalid_document');
  }

  const remoteNames = getRemoteNames(colName);
  if (!remoteNames.length) throw new Error(`Colección remota no encontrada (aliases vacíos): ${colName}`);

  // POST
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

  // PUT/PATCH
  if (item.method === 'PUT' || item.method === 'PATCH') {
    const doc = deepClone(item.document || {});
    coerceRefIds(doc, colName);
    const id = doc._id || extractIdFromItem(item);
    if (!id) throw new Error('sin id en outbox');

    const filter = { _id: safeObjectId(id) };
    const setBody = deepClone(doc); delete setBody._id;
    const $set = removeNulls(setBody);
    const $unset = {};
    const $setOnInsert = {};

    Object.keys(setBody || {}).forEach(k => {
      if (setBody[k] === null) { $unset[k] = ""; delete $set[k]; }
    });

    if (String(colName).toLowerCase() === 'movimientos') {
      if (Object.prototype.hasOwnProperty.call($set, 'fecha')) delete $set.fecha;
      const creationDate = doc.fecha || doc.createdAt || new Date();
      $setOnInsert.fecha = creationDate;
    }

    if (String(colName).toLowerCase() === 'vehiculos') {
      const hasEstadia = Object.prototype.hasOwnProperty.call(doc, 'estadiaActual');
      const isEmpty =
        hasEstadia && doc.estadiaActual && typeof doc.estadiaActual === 'object' &&
        !Array.isArray(doc.estadiaActual) && Object.keys(doc.estadiaActual).length === 0;
      if (!hasEstadia || isEmpty) {
        $unset.estadiaActual = "";
        if ($set && Object.prototype.hasOwnProperty.call($set, 'estadiaActual')) delete $set.estadiaActual;
      }
    }

    const updateOps = {};
    if (Object.keys($set).length)         updateOps.$set = $set;
    if (Object.keys($unset).length)       updateOps.$unset = $unset;
    if (Object.keys($setOnInsert).length) updateOps.$setOnInsert = $setOnInsert;

    for (const name of remoteNames) {
      const collection = remoteDb.collection(name);
      await collection.updateOne(
        filter,
        Object.keys(updateOps).length ? updateOps
          : (String(colName).toLowerCase() === 'movimientos'
              ? { $setOnInsert: { fecha: new Date() } }
              : { $set: {} }),
        { upsert: true }
      );
    }
    return;
  }

  // DELETE
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
  // =============================
  //  FIX 0: Protección ANTES de normalizeIds
  // =============================
  if (collName === 'cocheras') {

    // 1) JAMÁS pisar 'cliente' si viene null, undefined o vacío
    if (
      remoteDoc.cliente === null ||
      remoteDoc.cliente === undefined ||
      remoteDoc.cliente === "" ||
      (typeof remoteDoc.cliente === 'object' && Object.keys(remoteDoc.cliente).length === 0)
    ) {
      delete remoteDoc.cliente;
    }

    // 2) JAMÁS pisar vehiculos si viene undefined o array vacío
    if (!Array.isArray(remoteDoc.vehiculos) || remoteDoc.vehiculos.length === 0) {
      delete remoteDoc.vehiculos;
    }

    // 3) JAMÁS pisar tipo vacío
    if (!remoteDoc.tipo || String(remoteDoc.tipo).trim() === "") {
      delete remoteDoc.tipo;
    }

    // 4) JAMÁS pisar piso vacío
    if (!remoteDoc.piso || String(remoteDoc.piso).trim() === "") {
      delete remoteDoc.piso;
    }

    // 5) JAMÁS pisar exclusiva si viene null
    if (remoteDoc.exclusiva === null || remoteDoc.exclusiva === undefined) {
      delete remoteDoc.exclusiva;
    }
  }

  // Ahora sí normalizamos
  const cleaned = normalizeIds(remoteDoc, collName);
  cleaned._id = safeObjectId(cleaned._id);
  const _id = cleaned._id;

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

      // 1) NO pisar nunca cliente null/undefined
      if (key === 'cliente') {
        if (v === null || v === undefined) continue;
      }

      // 2) NO pisar vehiculos[] si remoto viene vacío y local tiene algo
      if (key === 'vehiculos') {
        if (Array.isArray(v) && v.length === 0) {
          const localDoc = await localCollection.findOne({ _id }, { vehiculos: 1 }).lean();
          if (localDoc && Array.isArray(localDoc.vehiculos) && localDoc.vehiculos.length > 0) {
            continue;
          }
        }
      }

      // 3) NO pisar ningún campo si el remoto viene vacío
      //    (esto protege: tipo, piso, exclusiva)
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

  if (String(collName).toLowerCase() === 'vehiculos') {
    const hasEstadia = Object.prototype.hasOwnProperty.call(cleaned, 'estadiaActual');
    const isEmpty =
      hasEstadia && cleaned.estadiaActual && typeof cleaned.estadiaActual === 'object' &&
      !Array.isArray(cleaned.estadiaActual) && Object.keys(cleaned.estadiaActual).length === 0;
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

    // 🧹 Compactación local segura: si entra un doc dedup que referencia a un movimiento base, borramos ese base local.
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

    // 🔁 Aquí sí usamos claves naturales solo para resolver duplicados locales
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

      const localName = await resolveLocalCollectionName(mongoose.connection, canonName);
      const localCollection = mongoose.connection.collection(localName);

      for (const raw of union) {
        await upsertLocalDocWithConflictResolution(localCollection, canonName, raw, stats, { mirrorArrays: isMirrorThisCollection });
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
    const reqA = pullOptsA.pullAll ? collectionsEnvA : collectionsEnvA;
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
          if (['POST','PUT','PATCH'].includes(item.method) && !looksLikeValidDocument(item.document) && !/\/api\/abonos\/registrar-abono/i.test(item?.route || '')) {
            await Outbox.updateOne({ _id: item._id }, { status: 'error', error: 'invalid_document', retries: 6 });
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

    // === C) MINI-PULL FINAL SOLO ESPEJOS
    const pullOptsC = {
      pullAll: !!opts.mirrorAll,
      mirrorAll: !!opts.mirrorAll,
      mirrorCollections: opts.mirrorCollections || [],
      skipCollections: opts.skipCollections || [],
      skipCollectionsSet: bulkDeletedCollections,
    };
    const reqC = pullOptsC.pullAll ? [] : (pullOptsC.mirrorCollections || []);
    const pullCountsC = await pullCollectionsFromRemote(remoteDb, reqC, pullOptsC);

    status.lastPullCounts = { ...status.lastPullCounts, ...pullCountsC };
    status.lastError = null;
    statusCb(status);

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

// =======================
function startPeriodicSync(atlasUri, opts = {}, statusCb = () => {}) {
  const intervalMs = opts.intervalMs || 30_000;
  console.log('[syncService] iniciando sincronizador. Intervalo:', intervalMs, 'ms');
  if (opts.remoteDbName) {
    SELECTED_REMOTE_DBNAME = opts.remoteDbName;
    console.log(`[syncService] DB remota seleccionada: "${SELECTED_REMOTE_DBNAME}"`);
  }

  syncTick(atlasUri, opts, statusCb).catch(e => console.error('[syncService] primer tick falló:', e));

  const handle = setInterval(() => syncTick(atlasUri, opts, statusCb), intervalMs);

  return {
    stop: () => clearInterval(handle),
    runOnce: () => syncTick(atlasUri, opts, statusCb),
    getStatus: () => ({ ...status }),
    inspectRemote: async (cols = []) => {
      const db = getRemoteDbInstance() || await connectRemote(atlasUri, SELECTED_REMOTE_DBNAME);
      let collections = cols.length ? cols : (await db.listCollections().toArray()).map(c => canonicalizeName(c.name));
      collections = Array.from(new Set(collections));
      const out = {};
      for (const c of collections) {
        try {
          let total = 0;
          for (const name of getRemoteNames(c)) {
            try { total += await db.collection(name).countDocuments(); } catch (_) {}
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
