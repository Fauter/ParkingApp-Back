/* eslint-disable no-console */
// controllers/abonoControllers.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Abono = require('../models/Abono');
const Vehiculo = require('../models/Vehiculo');
const Cliente = require('../models/Cliente');
const Outbox = require('../models/Outbox'); // para encolar manualmente PATCH abonos

/* =======================================================
   🔧 Utilidades comunes (I/O local y HTTP)
======================================================= */

/** Lee JSON si existe, si no devuelve null */
function readJsonIfExists(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) {
      const raw = fs.readFileSync(absPath, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/** GET local por HTTP al propio server (Node >=18 tiene fetch) */
async function httpGetJsonLocal(pathAndQuery, timeoutMs = 2000) {
  if (typeof fetch !== 'function') return null;
  const port = process.env.PORT || 5000;
  const url = `http://127.0.0.1:${port}${pathAndQuery}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'cache-control': 'no-store' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* =======================================================
   🧼 Normalización y tiers robustos
======================================================= */

const toStr = (v) => (v === null || v === undefined ? '' : String(v));
const stripAccents = (s) => toStr(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const normKey = (s) => stripAccents(toStr(s).trim().toLowerCase());

const normVehiculoKey = (s) => normKey(s); // "Camioneta" -> "camioneta"
const normCochera = (s) => {
  const k = normKey(s);
  return k === 'fija' ? 'fija' : 'movil'; // todo lo que no sea 'fija' es 'movil'
};
const normExclusiva = (exclusiva, cocheraNorm) =>
  cocheraNorm === 'fija' ? Boolean(exclusiva) : false;

function getTierCandidates(cocheraNorm, exclusivaBool) {
  if (cocheraNorm === 'fija') {
    return exclusivaBool ? ['exclusiva', 'fija'] : ['fija'];
  }
  return ['móvil', 'movil']; // soporta con y sin tilde
}

/* =======================================================
   📦 Catálogo con caché en memoria + doble intento
======================================================= */

// Estructura esperada desde /api/precios:
// { "camioneta": { "móvil": 123, "movil": 123, "fija": 456, "exclusiva": 789 }, ... }

let _catalogCache = {
  at: 0,
  efectivo: null,
  otros: null,
};
const CACHE_TTL_MS = 60_000; // 60s para evitar race intermitente

function normalizarMapaVehiculos(mapa) {
  const out = {};
  for (const k of Object.keys(mapa || {})) {
    const nk = normVehiculoKey(k);
    out[nk] = mapa[k] || {};
  }
  return out;
}

async function fetchCatalogoRemoto(metodo) {
  const isCash = normKey(metodo) === 'efectivo';
  const apiPath = isCash ? '/api/precios' : '/api/precios?metodo=otros';

  // 1) HTTP local (preferido)
  const viaHttp = await httpGetJsonLocal(apiPath, 2000);
  if (viaHttp && typeof viaHttp === 'object') {
    return normalizarMapaVehiculos(viaHttp);
  }

  // 2) Cache en disco (opcional)
  const baseCache = process.env.PRECIOS_CACHE_FILE || null;
  let cachePath = baseCache;
  if (baseCache && !isCash) {
    const { dir, name, ext } = path.parse(baseCache);
    cachePath = path.join(dir, `${name}_otros${ext || '.json'}`);
  }
  const viaCache = readJsonIfExists(cachePath);
  if (viaCache) return normalizarMapaVehiculos(viaCache);

  // 3) data local (repo)
  const dataDir = path.join(__dirname, '../data');
  const localData = isCash
    ? readJsonIfExists(path.join(dataDir, 'precios.json'))
    : (readJsonIfExists(path.join(dataDir, 'precios_otros.json')) ||
       readJsonIfExists(path.join(dataDir, 'precios.json')));
  if (localData) return normalizarMapaVehiculos(localData);

  // 4) vacío
  return {};
}

async function getCatalogo(metodo, { forceRefresh = false } = {}) {
  const key = normKey(metodo) === 'efectivo' ? 'efectivo' : 'otros';
  const fresh = _catalogCache[key];
  const expired = Date.now() - _catalogCache.at > CACHE_TTL_MS;

  if (!forceRefresh && fresh && !expired) return fresh;

  try {
    const data = await fetchCatalogoRemoto(key === 'efectivo' ? 'efectivo' : 'otros');
    _catalogCache[key] = data;
    _catalogCache.at = Date.now();
    return data;
  } catch (e) {
    if (fresh) return fresh;
    return {};
  }
}

/* =======================================================
   💰 Resolución robusta de precio (doble intento + fallback opcional)
======================================================= */

function lookupPrecio(catalogo, vehiculoKey, tierCandidates) {
  const bucket = (catalogo || {})[vehiculoKey] || null;
  if (!bucket) return null;
  for (const t of tierCandidates) {
    const val = bucket[t];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  }
  return null;
}

async function resolverPrecioSeguro({
  tipoVehiculo,
  metodoPago = 'Efectivo',
  cochera = 'Móvil',
  exclusiva = false,
  precioFront, // opcional
  tierFront,   // opcional
}) {
  const veh = normVehiculoKey(tipoVehiculo);
  const cochNorm = normCochera(cochera);
  const excl = normExclusiva(exclusiva, cochNorm);
  const tierCandidates = getTierCandidates(cochNorm, excl);

  // 1) intento con cache actual
  let catalogo = await getCatalogo(metodoPago, { forceRefresh: false });
  let precio = lookupPrecio(catalogo, veh, tierCandidates);

  // 2) refresh y retry
  if (!(typeof precio === 'number' && Number.isFinite(precio))) {
    catalogo = await getCatalogo(metodoPago, { forceRefresh: true });
    precio = lookupPrecio(catalogo, veh, tierCandidates);
  }

  // 3) fallback opcional al precio del front si el tier calza
  const allowFrontFallback = String(process.env.ALLOW_FRONT_PRICE_FALLBACK || '').toLowerCase() === 'true';
  if (!(typeof precio === 'number' && Number.isFinite(precio)) && allowFrontFallback) {
    const tFront = normKey(tierFront || '');
    const tierOk =
      (cochNorm === 'fija' && excl && tFront === 'exclusiva') ||
      (cochNorm === 'fija' && !excl && tFront === 'fija') ||
      (cochNorm === 'movil' && (tFront === 'movil' || tFront === 'móvil'));

    if (tierOk && typeof Number(precioFront) === 'number' && Number.isFinite(Number(precioFront))) {
      precio = Number(precioFront);
      console.warn(`[ABONOS] FALLBACK al precio del front habilitado. veh='${veh}' tier='${tierCandidates.join('|')}' precio=${precio}`);
    }
  }

  if (!(typeof precio === 'number' && Number.isFinite(precio) && precio > 0)) {
    const metodoStr = normKey(metodoPago) === 'efectivo' ? 'efectivo' : 'otros';
    const err = new Error(`No hay catálogo para tipo "${veh}" en método "${metodoStr}" con tier (${tierCandidates.join(' / ')}).`);
    err.code = 'CATALOGO_NO_ENCONTRADO';
    err.meta = { vehiculo: veh, metodo: metodoStr, tierCandidates };
    throw err;
  }

  const tierElegido = tierCandidates.find((t) => {
    const v = (catalogo?.[veh] || {})[t];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  }) || tierCandidates[0];

  return {
    precio,
    tier: tierElegido,
    vehiculo: veh,
    metodo: normKey(metodoPago) === 'efectivo' ? 'efectivo' : 'otros',
    cochera: cochNorm,
    exclusiva: excl,
  };
}

/* =======================================================
   ⏱️ Fechas / prorrateo / multi-mes
======================================================= */

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function getUltimoDiaMes(baseDate = new Date(), offsetMonths = 0) {
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth() + 1 + offsetMonths;
  const d = new Date(y, m, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function prorratearMonto(base, hoy = new Date()) {
  const ultimoDiaMes = getUltimoDiaMes(hoy, 0);
  const totalDiasMes = ultimoDiaMes.getDate();
  const diaActual = hoy.getDate();
  const diasRestantes = (diaActual === 1) ? totalDiasMes : (totalDiasMes - diaActual + 1);
  const factor = totalDiasMes > 0 ? (diasRestantes / totalDiasMes) : 0;
  const proporcional = Math.round(Math.max(0, Number(base) || 0) * factor);
  return { proporcional, ultimoDiaMes, totalDiasMes, diasRestantes, factor };
}

/**
 * Calcula cobro total para N meses:
 *  - Mes actual: prorrateo de diffBase (upgrade de este mes)
 *  - Meses completos siguientes: baseNuevo * (N-1)
 */
function calcularCobroMultiMes(baseNuevo, maxBaseVigente, hoy, mesesAbonarRaw) {
  const meses = clampInt(mesesAbonarRaw, 1, 12);
  const diffBase = Math.max(0, (Number(baseNuevo) || 0) - (Number(maxBaseVigente) || 0));
  const { proporcional, ultimoDiaMes, totalDiasMes, diasRestantes, factor } = prorratearMonto(diffBase, hoy);

  const mesesCompletos = Math.max(0, meses - 1);
  const subtotalMesesCompletos = mesesCompletos * Math.max(0, Number(baseNuevo) || 0);
  const total = proporcional + subtotalMesesCompletos;

  const venceEl = getUltimoDiaMes(hoy, meses - 1);

  return {
    meses,
    mesesCompletos,
    proporcionalMesActual: proporcional,
    subtotalMesesCompletos,
    totalCobrar: total,
    venceEl,
    totalDiasMes,
    diasRestantes,
    factor,
    diffBase,
  };
}

/* =======================================================
   📈 Máximo “base mensual” ya abonado por el cliente (mes vigente)
======================================================= */

async function getClienteMaxBaseMensualVigente(clienteId, hoy = new Date(), sopt) {
  if (!clienteId) return { maxBase: 0 };

  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finMesLocal = getUltimoDiaMes(hoy, 0);

  // ⚠️ Importante: agregamos +12h para absorber diferencias de huso/UTC
  const finMesTolerante = new Date(finMesLocal.getTime() + 12 * 60 * 60 * 1000);

  const abonos = await Abono.find({
    cliente: clienteId,
    activo: true,
    fechaExpiracion: { $gte: inicioMes, $lte: finMesTolerante }
  }, { tipoVehiculo: 1, metodoPago: 1, cochera: 1, exclusiva: 1 }, sopt).lean();

  if (!abonos || !abonos.length) return { maxBase: 0 };

  let maxBase = 0;
  for (const a of abonos) {
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo: a.tipoVehiculo,
        metodoPago: a.metodoPago || 'Efectivo',
        cochera: a.cochera || 'Móvil',
        exclusiva: a.cochera === 'Fija' ? Boolean(a.exclusiva) : false
      });
      if (r.precio > maxBase) maxBase = r.precio;
    } catch {
      // ignoramos si el abono histórico no matchea el catálogo actual
    }
  }
  return { maxBase };
}

/* =======================================================
   🖼️ Helpers de fotos
======================================================= */

// AHORA: el mapUploadedPaths en las rutas ya pone el path web final en req.body[field]
function buildFotoPath(req, field) {
  return req.body?.[field] || '';
}

/* =======================================================
   ⚙️ Soporte transacciones / búsqueda cliente / ObjectId safe
======================================================= */

async function supportsTransactions() {
  try {
    const admin = mongoose.connection.db.admin();
    let info;
    try { info = await admin.command({ hello: 1 }); }
    catch { info = await admin.command({ isMaster: 1 }); }
    return Boolean(info.setName || info.msg === 'isdbgrid');
  } catch {
    return false;
  }
}

// 🔧 Busca cliente tanto si _id es String como si es ObjectId
async function findClienteFlexible(id, sopt) {
  if (!id) return null;
  const rawId = String(id);

  // 1) _id guardado como string
  try {
    const first = await Cliente.collection.findOne(
      { _id: rawId },
      sopt?.session ? { session: sopt.session } : undefined
    );
    if (first) return new Cliente(first);
  } catch {}

  // 2) _id ObjectId válido
  if (mongoose.Types.ObjectId.isValid(rawId)) {
    const byObj = await Cliente.findById(rawId, null, sopt);
    if (byObj) return byObj;
  }

  // 3) _id-string raro (coincidencia por $toString)
  try {
    const agg = await Cliente.aggregate([
      { $addFields: { _idStr: { $toString: '$_id' } } },
      { $match: { _idStr: rawId } },
      { $limit: 1 },
    ]).session(sopt?.session || null);
    if (agg && agg[0] && agg[0]._id) {
      const again = await Cliente.findById(agg[0]._id, null, sopt);
      if (again) return again;
    }
  } catch {}

  return null;
}

// === ObjectId safe (acepta string, Buffer, objeto {buffer:{...}}, ObjectId) ===
const { Types: { ObjectId } } = mongoose;
function toObjectIdSafe(v) {
  if (!v) return undefined;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    return /^[0-9a-fA-F]{24}$/.test(s) ? new ObjectId(s) : undefined;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v) && (v.length === 12 || v.length === 24)) {
    return new ObjectId(v);
  }
  if (typeof v === 'object' && v.buffer && typeof v.buffer === 'object') {
    try {
      const arr = Object.keys(v.buffer).map(k => v.buffer[k]);
      const buf = Buffer.from(arr);
      if (buf.length === 12 || buf.length === 24) return new ObjectId(buf);
    } catch (_) {}
  }
  return undefined;
}

/** Devuelve string de ObjectId o null, evitando objetos “buffer” en la salida */
function toObjectIdString(v) {
  const oid =
    toObjectIdSafe(v) ||
    toObjectIdSafe(v && v._id) ||
    (v && v.buffer ? toObjectIdSafe(v) : undefined);
  return oid ? String(oid) : null;
}

/* =======================================================
   👤 Alta/obtención de cliente en backend (id o DNI)
======================================================= */
async function ensureClienteBackend(payload, sopt) {
  const clienteId = payload.cliente || payload.clienteId;
  const dni = String(payload.dniCuitCuil || '').trim();

  // 1) ID explícito
  if (clienteId) {
    const byId = await findClienteFlexible(clienteId, sopt);
    if (byId) return byId;
  }

  // 2) Buscar por DNI
  if (dni) {
    const byDni = await Cliente.findOne({ dniCuitCuil: dni }, null, sopt);
    if (byDni) return byDni;
  }

  // 3) Crear con los datos provistos
  if (!dni) throw new Error('Falta dniCuitCuil para crear cliente');
  if (!String(payload.nombreApellido || '').trim()) throw new Error('Falta nombreApellido para crear cliente');
  if (!String(payload.email || '').trim()) throw new Error('Falta email para crear cliente');

  const cliente = new Cliente({
    nombreApellido: String(payload.nombreApellido).trim(),
    dniCuitCuil: dni,
    domicilio: payload.domicilio || '',
    localidad: payload.localidad || '',
    telefonoParticular: payload.telefonoParticular || '',
    telefonoEmergencia: payload.telefonoEmergencia || '',
    domicilioTrabajo: payload.domicilioTrabajo || '',
    telefonoTrabajo: payload.telefonoTrabajo || '',
    email: String(payload.email).trim(),
    abonado: false,
    finAbono: null,
    precioAbono: String(payload.tipoVehiculo || '').toLowerCase(),
    abonos: [],
    vehiculos: [],
    movimientos: []
  });
  await cliente.save(sopt);
  return cliente;
}

// ahora incluye cocheraId opcional
async function getBaseCocheraVigente(
  clienteId,
  cocheraNorm,
  pisoNorm,
  hoy = new Date(),
  sopt,
  cocheraId = null
) {
  if (!clienteId) return { existe: false, base: 0 };

  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finMesLocal = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);
  const finMesTolerante = new Date(finMesLocal.getTime() + 12 * 60 * 60 * 1000);

  const k = normKey(cocheraNorm || '');
  let cocheraCandidates = [];

  if (k === 'fija') {
    cocheraCandidates = ['Fija', 'fija'];
  } else if (k === 'movil') {
    cocheraCandidates = ['Móvil', 'Movil', 'móvil', 'movil', 'MÓVIL'];
  } else if (cocheraNorm) {
    cocheraCandidates = [String(cocheraNorm)];
  } else {
    cocheraCandidates = ['Fija', 'fija', 'Móvil', 'Movil', 'móvil', 'movil'];
  }

  // 🔥 query creado correctamente
  const query = {
    cliente: clienteId,
    fechaExpiracion: { $gte: inicioMes, $lte: finMesTolerante }
  };

  // 🔥 si vino cocheraId → solo esa cochera
  if (cocheraId) {
    query.cocheraId = toObjectIdSafe(cocheraId);
  } else {
    query.cochera = { $in: cocheraCandidates };
    query.piso = pisoNorm;
  }

  // 🔥 Buscar TODOS los abonos de esta misma cochera/piso
  const abonos = await Abono.find(query, null, sopt).lean();

  if (!abonos || !abonos.length) return { existe: false, base: 0 };

  let maxBase = 0;
  for (const a of abonos) {
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo: a.tipoVehiculo,
        metodoPago: a.metodoPago || 'Efectivo',
        cochera: a.cochera,
        exclusiva: a.exclusiva,
      });
      if (r.precio > maxBase) maxBase = r.precio;
    } catch {
      // ignoramos errores individuales
    }
  }

  return { existe: true, base: maxBase };
}

/* =========================
   PREVIEWS
========================= */

exports.previewAbono = async (req, res) => {
  try {
    let {
      clienteId,
      tipoVehiculo,
      dniCuitCuil,
      metodoPago = 'Efectivo',
      cochera = 'Móvil',
      exclusiva = 'false',
      mesesAbonar = '1',
      piso = ''
    } = req.query;

    if (!tipoVehiculo) {
      return res.status(400).json({ error: 'Falta tipoVehiculo' });
    }

    const meses = clampInt(mesesAbonar, 1, 12);

    // 🧠 Normalización coherente con registrarAbono
    const cochKey = String(cochera || '').trim().toLowerCase();
    const cocheraNorm = cochKey === 'fija' ? 'Fija' : 'Móvil';

    let pisoNorm = '';
    if (cocheraNorm === 'Fija') {
      pisoNorm = String(piso || '').trim();
      if (!pisoNorm) {
        return res.status(400).json({ error: 'Las cocheras fijas deben tener número/piso asignado.' });
      }
    }

    const exBool = cocheraNorm === 'Fija'
      ? (String(exclusiva) === 'true' || exclusiva === true)
      : false;

    // Resolver cliente por id o por dni (opcional)
    let cliente = null;
    if (clienteId) {
      cliente = await findClienteFlexible(clienteId, null);
    } else if (dniCuitCuil) {
      cliente = await Cliente.findOne({ dniCuitCuil: String(dniCuitCuil).trim() }).lean();
    }

    const hoy = new Date();

    // 💰 base del nuevo abono
    let baseNuevo, tier;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo,
        metodoPago,
        cochera: cocheraNorm,
        exclusiva: exBool
      });
      baseNuevo = r.precio;
      tier = r.tier;
    } catch (e) {
      const status = e.code === 'CATALOGO_NO_ENCONTRADO' ? 409 : 400;
      return res.status(status).json({ error: e.message });
    }

    // máximo base ya abonado este mes SOLO en esta cochera/piso
    let baseActual = 0;
    let existeAbonoEnEstaCochera = false;

    if (cliente && cliente._id) {
      const r = await getBaseCocheraVigente(cliente._id, cocheraNorm, pisoNorm, hoy);
      baseActual = r.base;
      existeAbonoEnEstaCochera = r.existe;
    }

    const multi = calcularCobroMultiMes(baseNuevo, baseActual, hoy, meses);

    return res.json({
      ok: true,
      metodoPago,
      cochera: cocheraNorm,
      piso: pisoNorm,
      exclusiva: cocheraNorm === 'Fija' ? exBool : false,
      tipoVehiculo,
      mesesAbonar: multi.meses,
      baseActual,
      baseNuevo,
      tier,
      diffBase: multi.diffBase,
      diasRestantes: multi.diasRestantes,
      totalDiasMes: multi.totalDiasMes,
      factor: multi.factor,
      proporcionalMesActual: multi.proporcionalMesActual,
      subtotalMesesCompletos: multi.subtotalMesesCompletos,
      monto: multi.totalCobrar,
      venceEl: multi.venceEl,
      existeAbonoEnEstaCochera
    });
  } catch (e) {
    console.error('previewAbono error:', e);
    return res.status(500).json({ error: 'Error en preview de abono' });
  }
};

// GET /api/abonos/preview-renovacion
exports.previewRenovacion = async (req, res) => {
  try {
    const { clienteId, metodoPago = 'Efectivo' } = req.query;
    let {
      cochera = 'Móvil',
      exclusiva = 'false',
      mesesAbonar = '1',
      piso = ''
    } = req.query;

    const meses = clampInt(mesesAbonar, 1, 12);

    if (!clienteId) return res.status(400).json({ error: 'Falta clienteId' });

    const cliente = await findClienteFlexible(clienteId, null);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Tipo a renovar
    let tipo = (cliente.precioAbono || '').toLowerCase();
    if (!tipo) {
      const ultimo = await Abono.findOne({ cliente: cliente._id })
        .sort({ fechaExpiracion: -1, createdAt: -1 })
        .lean();
      tipo = (ultimo?.tipoVehiculo || '').toLowerCase();

      // Si no vino cochera/exclusiva/piso en el query, heredamos del último abono
      if (!req.query.cochera && ultimo?.cochera) cochera = ultimo.cochera;
      if (!req.query.exclusiva && typeof ultimo?.exclusiva === 'boolean') exclusiva = String(ultimo.exclusiva);
      if (!req.query.piso && typeof ultimo?.piso === 'string') piso = ultimo.piso;
    }
    if (!tipo) return res.status(400).json({ error: 'No hay tipo asignado para renovar' });

    // 🧠 Normalización de cochera/piso/exclusiva coherente con el resto
    const cochKey = String(cochera || '').trim().toLowerCase();
    const cocheraNorm = cochKey === 'fija' ? 'Fija' : 'Móvil';

    let pisoNorm = '';
    if (cocheraNorm === 'Fija') {
      pisoNorm = String(piso || '').trim();
      if (!pisoNorm) {
        return res.status(400).json({ error: 'Las cocheras fijas deben tener número/piso asignado.' });
      }
    }

    const exBool = cocheraNorm === 'Fija'
      ? (String(exclusiva) === 'true' || exclusiva === true)
      : false;

    const hoy = new Date();

    let baseNuevo, tier;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo: tipo,
        metodoPago,
        cochera: cocheraNorm,
        exclusiva: exBool
      });
      baseNuevo = r.precio;
      tier = r.tier;
    } catch (e) {
      const status = e.code === 'CATALOGO_NO_ENCONTRADO' ? 409 : 400;
      return res.status(status).json({ error: e.message });
    }

    // Renovación: por diseño seguimos sin restar base previa (0)
    const multi = calcularCobroMultiMes(baseNuevo, 0, hoy, meses);

    return res.json({
      ok: true,
      metodoPago,
      tipoVehiculo: tipo,
      cochera: cocheraNorm,
      piso: pisoNorm,
      exclusiva: cocheraNorm === 'Fija' ? exBool : false,
      mesesAbonar: multi.meses,
      baseNuevo,
      tier,
      diasRestantes: multi.diasRestantes,
      totalDiasMes: multi.totalDiasMes,
      factor: multi.factor,
      proporcionalMesActual: multi.proporcionalMesActual,
      subtotalMesesCompletos: multi.subtotalMesesCompletos,
      monto: multi.totalCobrar,
      venceEl: multi.venceEl
    });
  } catch (e) {
    console.error('previewRenovacion error:', e);
    return res.status(500).json({ error: 'Error en preview de renovación' });
  }
};

/* =========================
   RENOVAR ABONO (NUNCA crear movimientos acá)
========================= */

exports.renovarAbono = async (req, res) => {
  const canTx = await supportsTransactions();
  const session = canTx ? await mongoose.startSession() : null;
  if (session) session.startTransaction();
  const sopt = session ? { session } : {};

  try {
    let {
      clienteId,
      metodoPago = 'Efectivo',
      factura = 'CC',
      operador,
      patente,
      cochera = 'Móvil',
      piso = '',
      exclusiva = false,
      mesesAbonar = 1
    } = req.body;

    if (!clienteId) throw new Error('Falta clienteId');

    const cliente = await findClienteFlexible(clienteId, sopt);
    if (!cliente) throw new Error('Cliente no encontrado');

    // Determinar tipo a renovar
    let tipo = (cliente.precioAbono || '').toLowerCase();
    if (!tipo) {
      const ultimo = await Abono.findOne({ cliente: cliente._id })
        .sort({ fechaExpiracion: -1, createdAt: -1 })
        .lean();
      tipo = (ultimo?.tipoVehiculo || '').toLowerCase();

      if (!('cochera' in req.body) && ultimo?.cochera) cochera = ultimo.cochera;
      if (!('exclusiva' in req.body) && typeof ultimo?.exclusiva === 'boolean') exclusiva = ultimo.exclusiva;
      if (!('piso' in req.body) && typeof ultimo?.piso === 'string') piso = ultimo.piso;
    }
    if (!tipo) throw new Error('El cliente no tiene tipo asociado para renovar');

    // 🧠 Normalización de cochera/piso/exclusiva
    const cochKey = String(cochera || '').trim().toLowerCase();
    const cocheraNorm = cochKey === 'fija' ? 'Fija' : 'Móvil';

    let pisoNorm = '';
    if (cocheraNorm === 'Fija') {
      pisoNorm = String(piso || '').trim();
      if (!pisoNorm) throw new Error('Las cocheras fijas deben tener número/piso asignado.');
    }

    const exclusivaNorm = cocheraNorm === 'Fija'
      ? (String(exclusiva).trim().toLowerCase() === 'true' || exclusiva === true)
      : false;

    const hoy = new Date();

    let baseNuevo;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo: tipo,
        metodoPago,
        cochera: cocheraNorm,
        exclusiva: exclusivaNorm
      });
      baseNuevo = r.precio;
    } catch (e) {
      throw new Error(e.message || 'Precio no disponible para el tier elegido');
    }

    const multi = calcularCobroMultiMes(baseNuevo, 0, hoy, mesesAbonar);
    const monto = multi.totalCobrar;

    const abono = new Abono({
      nombreApellido: cliente.nombreApellido || '',
      domicilio: cliente.domicilio || '',
      localidad: cliente.localidad || '',
      telefonoParticular: cliente.telefonoParticular || '',
      telefonoEmergencia: cliente.telefonoEmergencia || '',
      domicilioTrabajo: cliente.domicilioTrabajo || '',
      telefonoTrabajo: cliente.telefonoTrabajo || '',
      email: cliente.email || '',
      dniCuitCuil: cliente.dniCuitCuil || '',
      patente: (patente || '').toUpperCase(),
      precio: monto,
      metodoPago,
      factura,
      tipoVehiculo: tipo,
      tipoAbono: { nombre: 'Mensual', dias: multi.totalDiasMes },
      fechaExpiracion: multi.venceEl,
      cliente: cliente._id,
      activo: true,
      cochera: cocheraNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm
    });
    await abono.save(sopt);

    // Reactivar cliente y extender fin
    cliente.abonado = true;
    cliente.finAbono = multi.venceEl;
    if (!cliente.precioAbono) cliente.precioAbono = tipo;
    if (!cliente.abonos.some(id => String(id) === String(abono._id))) {
      cliente.abonos.push(abono._id);
    }
    await cliente.save(sopt);

    if (session) { await session.commitTransaction(); session.endSession(); }

    const clientePop = await Cliente.findById(cliente._id)
      .populate('abonos')
      .populate('vehiculos', '_id patente tipoVehiculo abonado')
      .populate('movimientos');

    return res.status(201).json({
      ok: true,
      message: `Renovación registrada por $${monto}.`,
      cobrado: monto,
      abono,
      cliente: clientePop,
      multi: {
        mesesAbonar: multi.meses,
        proporcionalMesActual: multi.proporcionalMesActual,
        subtotalMesesCompletos: multi.subtotalMesesCompletos
      }
    });
  } catch (error) {
    console.error('renovarAbono error:', error);
    if (session) { try { await session.abortTransaction(); } catch {} session.endSession(); }
    return res.status(400).json({ error: error.message || 'Error al renovar abono' });
  }
};

// =========================
//   REGISTRAR / AGREGAR ABONO
// =========================

const {
  ensureCocheraInterno,
  asignarVehiculoInterno,
  registrarOutboxCocheraInterna
} = require('../services/cocheraService');

exports.registrarAbono = async (req, res) => {
  console.log('📨 [registrarAbono] body:', JSON.stringify({ ...req.body, _files: !!req.files }, null, 2));
  
  // 🧼 SANEAR ENTRADA ANTES DE TODO
  if (req.body.cliente && typeof req.body.cliente === 'object') {
    req.body.cliente = req.body.cliente._id || undefined;
  }
  if (req.body.cliente === undefined) {
    delete req.body.cliente;
  }

  // ============================================================
  // 🧱 TRANSACCIÓN
  // ============================================================
  const canTx = await supportsTransactions();
  const session = canTx ? await mongoose.startSession() : null;
  if (session) session.startTransaction();
  const sopt = session ? { session } : {};

  const created = { cliente: null, vehiculo: null, abono: null };

  try {
    // ============================================================
    // 🧼 INPUTS CRUDOS
    // ============================================================
    let {
      nombreApellido,
      domicilio,
      localidad,
      telefonoParticular,
      telefonoEmergencia,
      domicilioTrabajo,
      telefonoTrabajo,
      email,
      patente,
      marca,
      modelo,
      color,
      anio,
      companiaSeguro,
      metodoPago = 'Efectivo',
      factura = 'CC',
      tipoVehiculo,
      dniCuitCuil,
      cliente: clienteIdBody,
      clienteId: clienteIdAlt,
      operador,
      cochera = 'Móvil',
      piso = '',
      exclusiva = false,
      mesesAbonar = 1
    } = req.body;

    // ============================================================
    // ✔ VALIDACIONES MÍNIMAS
    // ============================================================
    if (!String(nombreApellido || '').trim()) throw new Error('Falta nombreApellido');
    if (!String(email || '').trim()) throw new Error('Falta email');
    if (!String(patente || '').trim()) throw new Error('Falta patente');
    if (!String(tipoVehiculo || '').trim()) throw new Error('Falta tipoVehiculo');
    if (!String(dniCuitCuil || '').trim()) throw new Error('Falta dniCuitCuil');

    patente = String(patente).trim().toUpperCase();

    // ============================================================
    // 🧠 NORMALIZACIÓN COCHERA / PISO / EXCLUSIVA
    // ============================================================
    const cochKey = String(cochera || '').trim().toLowerCase();
    const cocheraNorm = cochKey === 'fija' ? 'Fija' : 'Móvil';

    let pisoNorm = '';
    if (cocheraNorm === 'Fija') {
      pisoNorm = String(piso || '').trim();
      if (!pisoNorm) throw new Error('Las cocheras fijas deben tener número/piso asignado.');
    }

    const exclusivaNorm = cocheraNorm === 'Fija'
      ? (String(exclusiva).trim().toLowerCase() === 'true')
      : false;

    // ============================================================
    // 👤 CLIENTE: buscar / crear
    // ============================================================
    let cliente = null;
    const anyClienteId = clienteIdBody || clienteIdAlt;

    if (anyClienteId) {
      cliente = await findClienteFlexible(anyClienteId, sopt);
    }
    if (!cliente && dniCuitCuil) {
      cliente = await Cliente.findOne({ dniCuitCuil: String(dniCuitCuil).trim() }, null, sopt);
    }
    if (!cliente) {
      // nuevo cliente
      const nuevo = new Cliente({
        nombreApellido: String(nombreApellido).trim(),
        dniCuitCuil: String(dniCuitCuil).trim(),
        domicilio: domicilio || '',
        localidad: localidad || '',
        telefonoParticular: telefonoParticular || '',
        telefonoEmergencia: telefonoEmergencia || '',
        domicilioTrabajo: domicilioTrabajo || '',
        telefonoTrabajo: telefonoTrabajo || '',
        email: String(email).trim(),
        abonado: false,
        finAbono: null,
        precioAbono: String(tipoVehiculo || '').toLowerCase(),
        abonos: [],
        vehiculos: [],
        movimientos: [],
        cocheras: []
      });
      await nuevo.save(sopt);
      cliente = nuevo;
      if (!session) created.cliente = nuevo;
    }

    if (!cliente) throw new Error('No se pudo obtener/crear cliente');

    // ============================================================
    // 🖼️ FOTOS
    // ============================================================
    const fotoSeguro       = buildFotoPath(req, 'fotoSeguro');
    const fotoDNI          = buildFotoPath(req, 'fotoDNI');
    const fotoCedulaVerde  = buildFotoPath(req, 'fotoCedulaVerde');

    // ============================================================
    // 🚗 VEHÍCULO: crear / reusar
    // ============================================================
    let vehiculo = await Vehiculo.findOne({ patente }, null, sopt);

    if (!vehiculo) {
      vehiculo = new Vehiculo({
        patente,
        tipoVehiculo,
        marca: marca || '',
        modelo: modelo || '',
        color: color || '',
        anio: anio ? Number(anio) : null,
        abonado: true,
        cliente: cliente._id
      });
      await vehiculo.save(sopt);
      if (!session) created.vehiculo = vehiculo;
    } else {
      vehiculo.tipoVehiculo = tipoVehiculo;
      vehiculo.abonado = true;
      vehiculo.cliente = cliente._id;
      await vehiculo.save(sopt);
    }

    // ============================================================
    // 💰 PRECIO SEGÚN CATÁLOGO
    // ============================================================
    let baseNuevo;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo,
        metodoPago,
        cochera: cocheraNorm,
        exclusiva: exclusivaNorm,
        precioFront: req.body?.precio ? Number(req.body.precio) : undefined,
        tierFront: req.body?.tierAbono || undefined,
      });
      baseNuevo = r.precio;
    } catch (e) {
      const status = e.code === 'CATALOGO_NO_ENCONTRADO' ? 409 : 400;
      throw Object.assign(new Error(e.message), { httpStatus: status });
    }

    // ============================================================
    // 📅 MAX BASE MENSUAL YA ABONADO
    // ============================================================
    // 📅 MAX BASE MENSUAL YA ABONADO
    // 🔥 Primero LLAMADA SIN cocheraId (porque cocheraReal todavía no existe)
    const rBase = await getBaseCocheraVigente(
      cliente._id,
      cocheraNorm,
      pisoNorm,
      new Date(),
      sopt
    );
    const maxBase = rBase.base;
    const existeAbonoEnEstaCochera = rBase.existe;

    // ============================================================
    // 📦 MULTIMES
    // ============================================================
    const multi = calcularCobroMultiMes(baseNuevo, maxBase, new Date(), mesesAbonar);
    const montoACobrar = multi.totalCobrar;

    // ============================================================
    // 🧾 CREAR ABONO
    // ============================================================
    const AbonoModelo = new Abono({
      nombreApellido: String(nombreApellido).trim(),
      domicilio,
      localidad,
      telefonoParticular,
      telefonoEmergencia,
      domicilioTrabajo,
      telefonoTrabajo,
      email,
      dniCuitCuil,
      patente,
      marca: marca || '',
      modelo: modelo || '',
      color: color || '',
      anio: anio ? Number(anio) : null,
      companiaSeguro: companiaSeguro || '',
      precio: montoACobrar,
      metodoPago,
      factura,
      tipoVehiculo,
      tipoAbono: { nombre: 'Mensual', dias: multi.totalDiasMes },
      fechaExpiracion: multi.venceEl,
      fotoSeguro,
      fotoDNI,
      fotoCedulaVerde,
      cliente: cliente._id,
      vehiculo: vehiculo._id,
      cochera: cocheraNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm
    });
    await AbonoModelo.save(sopt);
    if (!session) created.abono = AbonoModelo;

    // ============================================================
    // 🔗 VÍNCULOS CLIENTE ↔ VEHÍCULO
    // ============================================================
    vehiculo.abono = AbonoModelo._id;
    await vehiculo.save(sopt);

    cliente.abonado   = true;
    cliente.finAbono  = multi.venceEl;

    if (baseNuevo >= maxBase) {
      cliente.precioAbono = (tipoVehiculo || '').toLowerCase();
    }

    if (!cliente.abonos.some(id => String(id) === String(AbonoModelo._id))) {
      cliente.abonos.push(AbonoModelo._id);
    }
    if (!cliente.vehiculos.some(id => String(id) === String(vehiculo._id))) {
      cliente.vehiculos.push(vehiculo._id);
    }
    await cliente.save(sopt);

    // 🅿️ COCHERA — RESPETAR cocheraId si viene del FRONT
    let cocheraReal = null;

    // 1) Si viene cocheraId → usamos esa cochera directamente
    if (req.body.cocheraId) {
      const Cochera = require("../models/Cochera");

      cocheraReal = await Cochera.findById(req.body.cocheraId).session(session || null);

      if (!cocheraReal) {
        throw new Error(`cocheraId ${req.body.cocheraId} no existe`);
      }

      // ⚠️ NO tocamos cliente.cocheras acá.
      // Se asume que esa cochera ya estaba asociada al cliente si corresponde.

    } else {
      // 2) Si NO viene cocheraId → ensure normal (tipo+piso+exclusiva)
      //    ESTE helper es el ÚNICO que agrega en cliente.cocheras[]
      cocheraReal = await ensureCocheraInterno({
        clienteId: cliente._id,
        tipo: cocheraNorm,
        piso: pisoNorm,
        exclusiva: exclusivaNorm,
        session
      });
    }

    // Asignar vehículo a esa cochera (siempre)
    await asignarVehiculoInterno({
      cocheraId: cocheraReal._id,
      vehiculoId: vehiculo._id,
      session
    });

    // ============================================================
    // 💾 COMMIT
    // ============================================================
    if (session) {
      await session.commitTransaction();
      session.endSession();
    }

    // ============================================================
    // 📨 OUTBOX FINAL COCHERA — POST-COMMIT (sin session)
    // ============================================================
    try {
      if (cocheraReal && cocheraReal._id) {

        const Cochera = require("../models/Cochera");
        const Vehiculo = require("../models/Vehiculo");

        // re-leer cochera SIN session (ya committeado)
        const coch = await Cochera.findById(cocheraReal._id).lean();

        if (coch) {
          const vehs = await Vehiculo.find({ cocheraId: cocheraReal._id })
            .select("_id")
            .lean();

          await registrarOutboxCocheraInterna({
            _id: coch._id,
            cliente: coch.cliente,
            tipo: coch.tipo,
            piso: coch.piso,
            exclusiva: coch.exclusiva,
            vehiculos: vehs.map(v => String(v._id)),
          });
        } else {
          console.warn("[registrarAbono] cochera no encontrada post-commit para outbox");
        }

      }
    } catch (e) {
      console.warn("[registrarAbono] no se pudo generar OUTBOX FINAL cochera post-commit:", e.message);
    }

    const clientePopulado = await Cliente.findById(cliente._id)
      .populate('vehiculos', '_id patente tipoVehiculo abonado')
      .populate('abonos')
      .populate('movimientos');

    return res.status(201).json({
      ok: true,
      message: montoACobrar > 0
        ? `Abono registrado. Se cobró $${montoACobrar}.`
        : 'Abono registrado sin cargos.',
      cobrado: montoACobrar,
      abono: AbonoModelo,
      vehiculo,
      cliente: clientePopulado,
      cochera: cocheraReal,
      multi: {
        mesesAbonar: multi.meses,
        proporcionalMesActual: multi.proporcionalMesActual,
        subtotalMesesCompletos: multi.subtotalMesesCompletos,
        diffBase: multi.diffBase
      }
    });

  } catch (error) {
    console.error('🔥 Error en registrarAbono:', error);

    if (session) {
      try { await session.abortTransaction(); } catch {}
      session.endSession();
    } else {
      try {
        if (created.abono)    await Abono.deleteOne({ _id: created.abono._id });
        if (created.vehiculo) await Vehiculo.deleteOne({ _id: created.vehiculo._id });
        if (created.cliente)  await Cliente.deleteOne({ _id: created.cliente._id });
      } catch {}
    }

    const httpStatus = error.httpStatus || 400;
    return res.status(httpStatus).json({ message: 'Error al registrar abono', error: error.message });
  }
};

exports.agregarAbono = async (req, res) => {
  // JAMÁS aceptar un cliente objeto desde el front
  if (req.body.cliente && typeof req.body.cliente === 'object') {
    delete req.body.cliente;
  }

  if (!req.body.cliente && req.body.clienteId) {
    req.body.cliente = req.body.clienteId;
  }
  return exports.registrarAbono(req, res);
};

/* =======================================================
   === 🔴 NORMALIZADOR DE SALIDA (ordenado y sin duplicados) ===
======================================================= */

function normalizeAbonoOutput(a) {
  // aseguramos ids planos
  const clienteId = toObjectIdString(a.cliente);
  const vehiculoId = toObjectIdString(a.vehiculo);

  // orden lógico (inserción) para serialización “linda”
  const out = {};

  // 1) Identificación y estado
  out._id = String(a._id);
  if (typeof a.activo === 'boolean') out.activo = a.activo;

  // 2) Persona / contacto
  out.nombreApellido = a.nombreApellido || '';
  out.dniCuitCuil = a.dniCuitCuil || '';
  out.email = a.email || '';
  out.telefonoParticular = a.telefonoParticular || '';
  out.telefonoTrabajo = a.telefonoTrabajo || '';
  out.telefonoEmergencia = a.telefonoEmergencia || '';
  out.domicilio = a.domicilio || '';
  out.domicilioTrabajo = a.domicilioTrabajo || '';
  out.localidad = a.localidad || '';

  // 3) Vehículo
  out.patente = (a.patente || '').toUpperCase();
  out.tipoVehiculo = a.tipoVehiculo || '';
  out.marca = a.marca || '';
  out.modelo = a.modelo || '';
  out.color = a.color || '';
  if (a.anio !== undefined && a.anio !== null) out.anio = Number(a.anio);

  // 4) Contrato / abono
  out.tipoAbono = a.tipoAbono || null; // { nombre, dias }
  if (a.precio !== undefined) out.precio = Number(a.precio) || 0;
  out.metodoPago = a.metodoPago || '';
  out.factura = a.factura || '';
  out.cochera = a.cochera || '';
  out.piso = a.piso || '';
  if (typeof a.exclusiva === 'boolean') out.exclusiva = a.exclusiva;

  // 5) Fechas
  if (a.fechaCreacion) out.fechaCreacion = a.fechaCreacion;
  if (a.createdAt) out.createdAt = a.createdAt;
  if (a.updatedAt) out.updatedAt = a.updatedAt;
  if (a.fechaExpiracion) out.fechaExpiracion = a.fechaExpiracion;

  // 6) Media / adjuntos
  out.fotoSeguro = a.fotoSeguro || '';
  out.fotoDNI = a.fotoDNI || '';
  out.fotoCedulaVerde = a.fotoCedulaVerde || '';

  // 7) Referencias planas
  out.cliente = clienteId;
  out.vehiculo = vehiculoId;

  // 8) Técnicos
  if (a.__v !== undefined) out.__v = a.__v;

  return out;
}

/* =========================
   LISTADOS / BÚSQUEDAS
========================= */

exports.getAbonos = async (req, res) => {
  try {
    const {
      cochera,
      exclusiva,
      search,
      activo,
      limit = 50,
      skip = 0,
      clienteId,
      patente,
      paginated
    } = req.query;

    const q = {};

    // Filtros opcionales
    if (cochera !== undefined) {
      const k = normKey(cochera); // soporta mayúsculas/minúsculas y tildes
      if (k === 'fija') {
        q.cochera = 'Fija';
      } else if (k === 'movil') {
        q.cochera = 'Móvil';
      }
      // cualquier otra cosa => no filtra por cochera
    }

    if (exclusiva === 'true' || exclusiva === 'false') {
      q.exclusiva = (exclusiva === 'true');
    }
    if (activo === 'true' || activo === 'false') {
      q.activo = (activo === 'true');
    }

    if (clienteId && mongoose.Types.ObjectId.isValid(String(clienteId))) q.cliente = clienteId;
    if (patente) q.patente = String(patente).toUpperCase();

    if (search && String(search).trim()) {
      const s = String(search).trim();
      q.$or = [
        { nombreApellido: { $regex: s, $options: 'i' } },
        { email:          { $regex: s, $options: 'i' } },
        { dniCuitCuil:    { $regex: s, $options: 'i' } },
        { patente:        { $regex: s, $options: 'i' } },
        { piso:           { $regex: s, $options: 'i' } },
        { cochera:        { $regex: s, $options: 'i' } },
        { tipoVehiculo:   { $regex: s, $options: 'i' } },
      ];
    }

    const lim = Math.min(Number(limit) || 50, 500);
    const sk = Math.max(Number(skip) || 0, 0);

    const [items, total] = await Promise.all([
      Abono.find(q).sort({ createdAt: -1 }).skip(sk).limit(lim).lean(),
      Abono.countDocuments(q)
    ]);

    // 🔹 Normalización sin duplicados ni buffers
    const normalized = items.map(normalizeAbonoOutput);

    if (String(paginated) === 'true') {
      return res.status(200).json({ total, limit: lim, skip: sk, items: normalized });
    }
    return res.status(200).json(normalized);
  } catch (error) {
    console.error('Error al obtener abonos:', error);
    res.status(500).json({ message: 'Error al obtener abonos' });
  }
};

// GET /api/abonos/by-cliente/:clienteId
exports.getAbonosPorCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(clienteId))) {
      return res.status(400).json({ message: 'clienteId inválido' });
    }
    const items = await Abono.find({ cliente: clienteId }).sort({ createdAt: -1 }).lean();
    const normalized = items.map(normalizeAbonoOutput);
    res.status(200).json({ total: normalized.length, items: normalized });
  } catch (error) {
    console.error('getAbonosPorCliente error:', error);
    res.status(500).json({ message: 'Error al obtener abonos por cliente' });
  }
};

// GET /api/abonos/by-patente/:patente
exports.getAbonosPorPatente = async (req, res) => {
  try {
    const { patente } = req.params;
    const pat = String(patente || '').toUpperCase();
    if (!pat) return res.status(400).json({ message: 'Patente requerida' });

    const items = await Abono.find({ patente: pat }).sort({ createdAt: -1 }).lean();
    const normalized = items.map(normalizeAbonoOutput);
    res.status(200).json({ total: normalized.length, items: normalized });
  } catch (error) {
    console.error('getAbonosPorPatente error:', error);
    res.status(500).json({ message: 'Error al obtener abonos por patente' });
  }
};

// GET /api/abonos/catalogo/cocheras-pisos
exports.getCatalogoCocherasYPisos = async (_req, res) => {
  try {
    const agg = await Abono.aggregate([
      {
        $group: {
          _id: null,
          cocheras: { $addToSet: '$cochera' },
          pisos:    { $addToSet: '$piso' }
        }
      },
      {
        $project: {
          _id: 0,
          cocheras: {
            $filter: {
              input: '$cocheras',
              as: 'c',
              cond: { $ne: ['$$c', ''] }
            }
          },
          pisos: {
            $filter: {
              input: '$pisos',
              as: 'p',
              cond: { $ne: ['$$p', ''] }
            }
          }
        }
      }
    ]);

    const counts = await Abono.aggregate([
      {
        $group: {
          _id: { cochera: '$cochera', piso: '$piso' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.cochera': 1, '_id.piso': 1 } }
    ]);

    res.json({
      cocheras: (agg[0]?.cocheras || []).sort(),
      pisos: (agg[0]?.pisos || []).sort(),
      combinaciones: counts.map(c => ({ cochera: c._id.cochera, piso: c._id.piso, count: c.count }))
    });
  } catch (e) {
    console.error('getCatalogoCocherasYPisos error:', e);
    res.status(500).json({ message: 'Error al obtener catálogo de cocheras/pisos' });
  }
};

/* =========================
   DETALLE / UPDATE
========================= */

exports.getAbonoPorId = async (req, res) => {
  try {
    const { id } = req.params;
    const abono = await Abono.findById(id).lean();
    if (!abono) return res.status(404).json({ message: 'Abono no encontrado' });
    return res.status(200).json(normalizeAbonoOutput(abono));
  } catch (error) {
    console.error('Error al obtener abono por ID:', error);
    res.status(500).json({ message: 'Error al obtener abono por ID' });
  }
};

// 🔸 helper: encola un Outbox
async function enqueueOutboxPatchAbono(abonoDoc) {
  try {
    if (!abonoDoc?._id) return;
    if (process.env.SYNC_DISABLE_PUSH === '1') return;

    await Outbox.create({
      method: 'PATCH',
      route: `/api/abonos/${abonoDoc._id}`,
      params: { id: String(abonoDoc._id) },
      document: abonoDoc,
      status: 'pending',
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn('[actualizarAbono] no pude encolar Outbox PATCH abonos:', e.message || e);
  }
}

// PATCH /api/abonos/:id
exports.actualizarAbono = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    // ⛔️ NO usar .lean() acá (necesitamos casteo Mongoose por docs viejos)
    const before = await Abono.findById(id);
    if (!before) return res.status(404).json({ message: 'Abono no encontrado' });

    // Normalizo/limpio abono.vehiculo si vino raro (Buffer serializado, string, etc.)
    const vehIdSafePre = toObjectIdSafe(before.vehiculo);
    if (before.vehiculo && !vehIdSafePre) {
      before.vehiculo = undefined;
      try { await before.save(); } catch (_) {}
    } else if (vehIdSafePre && String(vehIdSafePre) !== String(before.vehiculo || '')) {
      before.vehiculo = vehIdSafePre;
      try { await before.save(); } catch (_) {}
    }

    // 🔧 NUEVO: normalizo/limpio abono.cliente si vino raro (Buffer/objeto)
    const cliIdSafePre =
      toObjectIdSafe(before.cliente) ||
      toObjectIdSafe(before.cliente && before.cliente._id) ||
      (before.cliente && before.cliente.buffer ? toObjectIdSafe(before.cliente) : undefined);

    if (before.cliente && !cliIdSafePre) {
      before.cliente = undefined;
      try { await before.save(); } catch (_) {}
    } else if (cliIdSafePre && String(cliIdSafePre) !== String(before.cliente || '')) {
      before.cliente = cliIdSafePre;
      try { await before.save(); } catch (_) {}
    }

    const updates = {};
    const allowed = [
      'nombreApellido','domicilio','localidad','telefonoParticular','telefonoEmergencia',
      'domicilioTrabajo','telefonoTrabajo','email','dniCuitCuil','patente','marca','modelo',
      'color','anio','companiaSeguro','precio','metodoPago','factura','tipoVehiculo',
      'activo','cochera','piso','exclusiva','fotoSeguro','fotoDNI','fotoCedulaVerde'
      // 'vehiculo' NO se expone aquí
    ];

    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }

    // Normalizaciones de campos
    const beforePatUP = String(before.patente || '').toUpperCase();
    if ('patente' in updates && updates.patente) updates.patente = String(updates.patente).toUpperCase();
    if ('anio' in updates && updates.anio != null) updates.anio = Number(updates.anio);
    if ('exclusiva' in updates) updates.exclusiva = String(updates.exclusiva) === 'true' || updates.exclusiva === true;
    if ('cochera' in updates) {
      const c = String(updates.cochera || '');
      updates.cochera = ['Fija','Móvil',''].includes(c) ? c : '';
    }

    const newPatUP = ('patente' in updates && updates.patente) ? String(updates.patente).toUpperCase() : beforePatUP;
    const willChangePatente = newPatUP !== beforePatUP;

    // 🔍 Pre-chequeo de colisión si cambia la patente (para cortar temprano)
    if (willChangePatente) {
      const dup = await Vehiculo.findOne({ patente: newPatUP });
      if (dup && (!before.vehiculo || String(dup._id) !== String(before.vehiculo))) {
        return res.status(409).json({ message: 'Patente ya existe en otro vehículo', code: 'PATENTE_DUPLICADA' });
      }
    }

    // ⬆️ Actualizo Abono primero
    const updated = await Abono.findByIdAndUpdate(id, { $set: updates }, { new: true });
    if (!updated) return res.status(404).json({ message: 'Abono no encontrado' });

    // 🔁 Propagación si se desactiva: limpiar bandera en vehículo vinculado (si corresponde)
    if (('activo' in updates) && updates.activo === false && before.vehiculo) {
      try {
        const veh = await Vehiculo.findById(before.vehiculo);
        if (veh) {
          const stillActive = await Abono.exists({ vehiculo: veh._id, activo: true });
          if (!stillActive) {
            veh.abonado = false;
            veh.abono = null;
            await veh.save();
          } else if (String(veh.abono || '') === String(id)) {
            veh.abono = null;
            await veh.save();
          }
        }
      } catch (e) {
        console.warn('[actualizarAbono] no se pudo propagar estado a vehiculo:', e.message);
      }
    }

    // ⭐ Renombrado/Link robusto si cambió la patente
    if (willChangePatente) {
      try {
        const abonoId = updated._id;
        const vehIdFromBefore = toObjectIdSafe(before.vehiculo);
        let veh = null;

        // 1) Intento por ID ya vinculado
        if (vehIdFromBefore) {
          veh = await Vehiculo.findById(vehIdFromBefore);
        }

        // 2) Si no hay vínculo previo, busco por patente ANTERIOR
        if (!veh && beforePatUP) {
          veh = await Vehiculo.findOne({ patente: beforePatUP });
        }

        // 3) Si encontré vehículo → renombro y reparo vínculos
        if (veh) {
          // Seguridad extra: evito colisión
          const colision = await Vehiculo.findOne({ patente: newPatUP });
          if (colision && String(colision._id) !== String(veh._id)) {
            // deshago patente en Abono a valor anterior
            try { await Abono.findByIdAndUpdate(id, { $set: { patente: beforePatUP } }); } catch {}
            return res.status(409).json({ message: 'Patente ya existe en otro vehículo', code: 'PATENTE_DUPLICADA' });
          }

          veh.patente = newPatUP;
          veh.abonado = true;
          try { veh.abono = abonoId; } catch (_) {}
          // opcional: refresco datos básicos desde Abono
          if (updated.tipoVehiculo) veh.tipoVehiculo = updated.tipoVehiculo;
          if ('marca' in updated)  veh.marca  = updated.marca ?? veh.marca;
          if ('modelo' in updated) veh.modelo = updated.modelo ?? veh.modelo;
          if ('color' in updated)  veh.color  = updated.color ?? veh.color;
          if ('anio' in updated && Number.isFinite(Number(updated.anio))) veh.anio = Number(updated.anio);

          await veh.save();

          // Aseguro puntero en Abono → vehiculo
          const vehIdFinal = toObjectIdSafe(veh._id) || veh._id;
          if (!updated.vehiculo || String(updated.vehiculo) !== String(vehIdFinal)) {
            updated.vehiculo = vehIdFinal;
            try { await updated.save(); } catch (e) { console.warn('[actualizarAbono] no pude setear abono.vehiculo:', e?.message); }
          }

          // 🔧 **NUEVO**: Aseguro que el cliente tenga el vehículo en el array con casteo fuerte + fallback
          const tryCastClienteId =
            toObjectIdSafe(updated.cliente) ||
            toObjectIdSafe(updated.cliente && updated.cliente._id) ||
            (updated.cliente && updated.cliente.buffer ? toObjectIdSafe(updated.cliente) : undefined) ||
            null;

          let cliIdFinal = tryCastClienteId;
          if (!cliIdFinal) {
            const dni   = String(updated.dniCuitCuil || '').trim();
            const email = String(updated.email || '').trim().toLowerCase();
            const name  = String(updated.nombreApellido || '').trim();

            const byDni   = dni   ? await Cliente.findOne({ dniCuitCuil: dni }).select('_id').lean() : null;
            const byEmail = !byDni && email ? await Cliente.findOne({ email }).select('_id').lean() : null;
            const byName  = !byDni && !byEmail && name ? await Cliente.findOne({ nombreApellido: name }).select('_id').lean() : null;

            cliIdFinal = (byDni || byEmail || byName)?._id || null;

            if (cliIdFinal) {
              updated.cliente = cliIdFinal;
              try { await updated.save(); } catch (_) {}
            }
          }

          if (cliIdFinal && vehIdFinal) {
            try {
              await Cliente.updateOne(
                { _id: cliIdFinal },
                { $addToSet: { vehiculos: vehIdFinal } }
              );
            } catch (e) {
              console.warn('[actualizarAbono] addToSet cliente.vehiculos:', e?.message);
            }
          } else {
            console.warn('[actualizarAbono] skip addToSet (no cliId o vehId casteables)', {
              cliId: String(cliIdFinal || ''), vehId: String(vehIdFinal || '')
            });
          }
        } else {
          // 4) Si no existe vehículo previo: creo uno SOLO si no existe la patente nueva
          const existNew = await Vehiculo.findOne({ patente: newPatUP });
          if (!existNew) {
            const v = new Vehiculo({
              patente: newPatUP,
              tipoVehiculo: updated.tipoVehiculo || 'Auto',
              abonado: true,
              abono: abonoId,
              marca: updated.marca || '',
              modelo: updated.modelo || '',
              color: updated.color || '',
              anio: updated.anio || null,
              cliente: updated.cliente || undefined
            });
            await v.save();

            // vinculo en Abono y Cliente
            const vId = toObjectIdSafe(v._id) || v._id;
            updated.vehiculo = vId;
            try { await updated.save(); } catch {}

            // 🔧 **NUEVO**: $addToSet con cliente casteado/fallback
            const tryCastClienteId2 =
              toObjectIdSafe(updated.cliente) ||
              toObjectIdSafe(updated.cliente && updated.cliente._id) ||
              (updated.cliente && updated.cliente.buffer ? toObjectIdSafe(updated.cliente) : undefined) ||
              null;

            let cliIdFinal2 = tryCastClienteId2;
            if (!cliIdFinal2) {
              const dni   = String(updated.dniCuitCuil || '').trim();
              const email = String(updated.email || '').trim().toLowerCase();
              const name  = String(updated.nombreApellido || '').trim();

              const byDni   = dni   ? await Cliente.findOne({ dniCuitCuil: dni }).select('_id').lean() : null;
              const byEmail = !byDni && email ? await Cliente.findOne({ email }).select('_id').lean() : null;
              const byName  = !byDni && !byEmail && name ? await Cliente.findOne({ nombreApellido: name }).select('_id').lean() : null;

              cliIdFinal2 = (byDni || byEmail || byName)?._id || null;

              if (cliIdFinal2) {
                updated.cliente = cliIdFinal2;
                try { await updated.save(); } catch (_) {}
              }
            }

            if (cliIdFinal2 && vId) {
              try {
                await Cliente.updateOne({ _id: cliIdFinal2 }, { $addToSet: { vehiculos: vId } });
              } catch (e) { console.warn('[actualizarAbono] addToSet cliente.vehiculos (creación):', e?.message); }
            } else {
              console.warn('[actualizarAbono] skip addToSet (creación) (no cliId o vehId casteables)', {
                cliId: String(cliIdFinal2 || ''), vehId: String(vId || '')
              });
            }
          }
        }
      } catch (e) {
        // Falla “controlada”: vuelvo la patente del Abono a la anterior para no dejar roto
        console.warn('[actualizarAbono] fallo propagación/rename vehiculo:', e?.message || e);
        try { await Abono.findByIdAndUpdate(id, { $set: { patente: beforePatUP } }, { new: true }); } catch {}
        return res.status(400).json({ message: 'No se pudo actualizar la patente del vehículo vinculado' });
      }
    }

    // Encolar PATCH del Abono para sync
    try {
      await enqueueOutboxPatchAbono(updated.toObject());
    } catch (_) {}

    // 🔹 Respuesta normalizada (sin duplicados)
    return res.json({ ok: true, abono: normalizeAbonoOutput(updated.toObject()) });
  } catch (e) {
    console.error('actualizarAbono error:', e);
    res.status(500).json({ message: 'Error al actualizar abono' });
  }
};

// PATCH /api/abonos/:id/exclusiva   body: { exclusiva: true|false }
exports.setExclusiva = async (req, res) => {
  try {
    const { id } = req.params;
    let { exclusiva } = req.body;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'ID inválido' });
    }
    const bool = String(exclusiva) === 'true' || exclusiva === true;
    const updated = await Abono.findByIdAndUpdate(id, { $set: { exclusiva: bool } }, { new: true });
    if (!updated) return res.status(404).json({ message: 'Abono no encontrado' });

    try {
      await enqueueOutboxPatchAbono(updated.toObject());
    } catch (_) {}

    return res.json({ ok: true, abono: normalizeAbonoOutput(updated.toObject()) });
  } catch (e) {
    console.error('setExclusiva error:', e);
    res.status(500).json({ message: 'Error al actualizar exclusiva' });
  }
};

/* =========================
   NUEVO: desvincular/actualizar vehículo del abono
========================= */
exports.updateVehiculoDeAbono = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    const { vehiculoId } = req.body;
    const abono = await Abono.findById(id);
    if (!abono) return res.status(404).json({ message: 'Abono no encontrado' });

    const prevVehId = abono.vehiculo ? String(abono.vehiculo) : null;

    // Validación de nuevo vehiculo (si viene)
    let nextVehId = null;
    if (vehiculoId) {
      if (!mongoose.Types.ObjectId.isValid(String(vehiculoId))) {
        return res.status(400).json({ message: 'vehiculoId inválido' });
      }
      const exists = await Vehiculo.exists({ _id: vehiculoId });
      if (!exists) return res.status(404).json({ message: 'Vehículo no encontrado' });
      nextVehId = String(vehiculoId);
    }

    // Actualizo vínculo en Abono
    abono.vehiculo = nextVehId ? nextVehId : null;
    await abono.save();

    // Si había vínculo previo y se está removiendo o cambiando, limpiar el Vehiculo previo
    if (prevVehId && (!nextVehId || nextVehId !== prevVehId)) {
      try {
        const vehPrev = await Vehiculo.findById(prevVehId);
        if (vehPrev) {
          const otherActive = await Abono.exists({ vehiculo: vehPrev._id, activo: true });
          if (!otherActive) {
            vehPrev.abonado = false;
          }
          if (String(vehPrev.abono || '') === String(id)) {
            vehPrev.abono = null;
          }
          await vehPrev.save();
        }
      } catch (e) {
        console.warn('[updateVehiculoDeAbono] limpiar vehiculo previo:', e.message);
      }
    }

    // Si setearon un nuevo vehículo, subimos su bandera y lo vinculamos
    if (nextVehId) {
      try {
        const vehNext = await Vehiculo.findById(nextVehId);
        if (vehNext) {
          vehNext.abonado = true;
          vehNext.abono = abono._id;
          await vehNext.save();
        }
      } catch (e) {
        console.warn('[updateVehiculoDeAbono] setear vehiculo nuevo:', e.message);
      }
    }

    try {
      await enqueueOutboxPatchAbono(abono.toObject());
    } catch (_) {}

    return res.json({ ok: true, abono: normalizeAbonoOutput(abono.toObject()) });
  } catch (e) {
    console.error('updateVehiculoDeAbono error:', e);
    res.status(500).json({ message: 'Error al actualizar vínculo de vehículo del abono' });
  }
};

/* =========================
   BORRADO MASIVO
========================= */

exports.eliminarAbonos = async (_req, res) => {
  try {
    await Abono.deleteMany({});
    res.status(200).json({ message: 'Todos los abonos fueron eliminados.' });
  } catch (error) {
    console.error('Error al eliminar abonos:', error);
    res.status(500).json({ message: 'Error al eliminar abonos' });
  }
};

/* =======================================================
   (Opcional) TAREA ÚNICA DE saneo de datos viejos
======================================================= */
exports._sanearIdsAbonosYClientes = async (_req, res) => {
  try {
    const Abono = require('../models/Abono');
    const Cliente = require('../models/Cliente');
    const Vehiculo = require('../models/Vehiculo');

    const fixed = { abonos: 0, links: 0, clientes: 0 };
    const all = await Abono.find().lean();

    const toOid = (v) =>
      toObjectIdSafe(v) ||
      toObjectIdSafe(v && v._id) ||
      (v && v.buffer ? toObjectIdSafe(v) : undefined) ||
      null;

    for (const a of all) {
      let cliId = toOid(a.cliente);
      if (!cliId) {
        const byDni   = a.dniCuitCuil ? await Cliente.findOne({ dniCuitCuil: a.dniCuitCuil }).select('_id').lean() : null;
        const byEmail = !byDni && a.email ? await Cliente.findOne({ email: String(a.email).toLowerCase() }).select('_id').lean() : null;
        const byName  = !byDni && !byEmail && a.nombreApellido ? await Cliente.findOne({ nombreApellido: a.nombreApellido }).select('_id').lean() : null;
        cliId = (byDni || byEmail || byName)?._id || null;
        if (cliId) { await Abono.updateOne({ _id: a._id }, { $set: { cliente: cliId } }); fixed.abonos++; }
      }

      let vehId = toOid(a.vehiculo);
      if (!vehId && a.patente) {
        const v = await Vehiculo.findOne({ patente: String(a.patente).toUpperCase() }).select('_id').lean();
        if (v) { vehId = v._id; await Abono.updateOne({ _id: a._id }, { $set: { vehiculo: vehId } }); fixed.abonos++; }
      }

      if (cliId && vehId) {
        await Cliente.updateOne({ _id: cliId }, { $addToSet: { vehiculos: vehId, abonos: a._id } });
        fixed.links++;
      }
    }

    const clientes = await Cliente.find().select('_id vehiculos abonos').lean();
    for (const c of clientes) {
      const uniqVeh = [...new Set((c.vehiculos || []).map(x => String(x)))].map(s => toObjectIdSafe(s) || s);
      const uniqAbo = [...new Set((c.abonos || []).map(x => String(x)))].map(s => toObjectIdSafe(s) || s);
      await Cliente.updateOne({ _id: c._id }, { $set: { vehiculos: uniqVeh, abonos: uniqAbo } });
      fixed.clientes++;
    }

    return res.json({ ok: true, fixed });
  } catch (e) {
    console.error('_sanearIdsAbonosYClientes error:', e);
    return res.status(500).json({ error: 'Error al sanear' });
  }
};
