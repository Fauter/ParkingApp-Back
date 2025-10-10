// controllers/abonoControllers.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Abono = require('../models/Abono');
const Vehiculo = require('../models/Vehiculo');
const Cliente = require('../models/Cliente');

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
  const finMes = getUltimoDiaMes(hoy, 0);

  const abonos = await Abono.find({
    cliente: clienteId,
    activo: true,
    fechaExpiracion: { $gte: inicioMes, $lte: finMes }
  }, { tipoVehiculo: 1, metodoPago: 1, cochera: 1, exclusiva: 1 }, sopt).lean();

  if (!abonos || !abonos.length) return { maxBase: 0 };

  // • OJO: Para el "máximo" usamos la misma resolución robusta del catálogo actual
  //   para evitar inconsistencias si cambiaron claves de catálogo.
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
   ⚙️ Soporte transacciones y búsqueda flexible de Cliente
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

/* =======================================================
   👤 Alta/obtención de cliente en backend (id o DNI)
======================================================= */

async function ensureClienteBackend(payload, sopt) {
  const clienteId = payload.cliente || payload.clienteId;
  const dni = String(payload.dniCuitCuil || '').trim();

  // 1) Si vino un ID, lo intentamos
  if (clienteId) {
    const byId = await findClienteFlexible(clienteId, sopt);
    if (byId) return byId;
  }

  // 2) Si hay DNI, buscamos por DNI
  if (dni) {
    const byDni = await Cliente.findOne({ dniCuitCuil: dni }, null, sopt);
    if (byDni) return byDni;
  }

  // 3) Crear cliente con los datos provistos
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

/* =========================
   PREVIEWS
========================= */

// GET /api/abonos/preview?clienteId=...&tipoVehiculo=...&metodoPago=...&cochera=Fija|Móvil&exclusiva=true|false&mesesAbonar=1..12 (&dniCuitCuil=...)
exports.previewAbono = async (req, res) => {
  try {
    let {
      clienteId,
      tipoVehiculo,
      dniCuitCuil,
      metodoPago = 'Efectivo',
      cochera = 'Móvil',
      exclusiva = 'false',
      mesesAbonar = '1'
    } = req.query;

    if (!tipoVehiculo) {
      return res.status(400).json({ error: 'Falta tipoVehiculo' });
    }

    const exBool = String(exclusiva) === 'true';
    const meses = clampInt(mesesAbonar, 1, 12);

    // Resolver cliente por id o por dni (opcional)
    let cliente = null;
    if (clienteId) {
      cliente = await findClienteFlexible(clienteId, null);
    } else if (dniCuitCuil) {
      cliente = await Cliente.findOne({ dniCuitCuil: String(dniCuitCuil).trim() }).lean();
    }

    const hoy = new Date();

    // 💰 base del nuevo abono (doble intento + normalización + fallback opcional)
    let baseNuevo, tier;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo,
        metodoPago,
        cochera,
        exclusiva: cochera === 'Fija' ? exBool : false
      });
      baseNuevo = r.precio;
      tier = r.tier;
    } catch (e) {
      const status = e.code === 'CATALOGO_NO_ENCONTRADO' ? 409 : 400;
      return res.status(status).json({ error: e.message });
    }

    // máximo base ya abonado este mes (respetando método/tier históricas)
    let baseActual = 0;
    if (cliente && cliente._id) {
      const r = await getClienteMaxBaseMensualVigente(cliente._id, hoy, null);
      baseActual = r.maxBase || 0;
    }

    const multi = calcularCobroMultiMes(baseNuevo, baseActual, hoy, meses);

    return res.json({
      ok: true,
      metodoPago,
      cochera,
      exclusiva: cochera === 'Fija' ? exBool : false,
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
      venceEl: multi.venceEl
    });
  } catch (e) {
    console.error('previewAbono error:', e);
    return res.status(500).json({ error: 'Error en preview de abono' });
  }
};

// GET /api/abonos/preview-renovacion?clienteId=...&metodoPago=...&cochera=...&exclusiva=...&mesesAbonar=...
exports.previewRenovacion = async (req, res) => {
  try {
    const { clienteId, metodoPago = 'Efectivo' } = req.query;
    let { cochera = 'Móvil', exclusiva = 'false', mesesAbonar = '1' } = req.query;
    const exBool = String(exclusiva) === 'true';
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
      if (!req.query.cochera && ultimo?.cochera) cochera = ultimo.cochera;
      if (!req.query.exclusiva && typeof ultimo?.exclusiva === 'boolean') exclusiva = String(ultimo.exclusiva);
    }
    if (!tipo) return res.status(400).json({ error: 'No hay tipo asignado para renovar' });

    const hoy = new Date();

    let baseNuevo, tier;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo: tipo,
        metodoPago,
        cochera,
        exclusiva: cochera === 'Fija' ? exBool : false
      });
      baseNuevo = r.precio;
      tier = r.tier;
    } catch (e) {
      const status = e.code === 'CATALOGO_NO_ENCONTRADO' ? 409 : 400;
      return res.status(status).json({ error: e.message });
    }

    // En renovación no consideramos "maxBase" previo del mes.
    const multi = calcularCobroMultiMes(baseNuevo, 0, hoy, meses);

    return res.json({
      ok: true,
      metodoPago,
      tipoVehiculo: tipo,
      cochera,
      exclusiva: cochera === 'Fija' ? exBool : false,
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
    const {
      clienteId,
      metodoPago='Efectivo',
      factura='CC',
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
      if (!req.body.cochera && ultimo?.cochera) req.body.cochera = ultimo.cochera;
      if (!('exclusiva' in req.body) && typeof ultimo?.exclusiva === 'boolean') req.body.exclusiva = ultimo.exclusiva;
    }
    if (!tipo) throw new Error('El cliente no tiene tipo asociado para renovar');

    const hoy = new Date();

    let baseNuevo;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo: tipo,
        metodoPago,
        cochera,
        exclusiva: cochera === 'Fija' ? Boolean(exclusiva) : false
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
      cochera: ['Fija','Móvil'].includes(String(cochera)) ? cochera : '',
      piso: String(piso || ''),
      exclusiva: cochera === 'Fija' ? Boolean(exclusiva) : false
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

/* =========================
   REGISTRAR / AGREGAR ABONO (NUNCA crear movimientos acá)
========================= */

exports.registrarAbono = async (req, res) => {
  console.log('📨 [registrarAbono] body:', JSON.stringify({ ...req.body, _files: !!req.files }, null, 2));

  const canTx = await supportsTransactions();
  const session = canTx ? await mongoose.startSession() : null;
  if (session) session.startTransaction();
  const sopt = session ? { session } : {};

  const created = { cliente: null, vehiculo: null, abono: null };

  try {
    const {
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

    // Validaciones mínimas
    if (!String(nombreApellido || '').trim()) throw new Error('Falta nombreApellido');
    if (!String(email || '').trim()) throw new Error('Falta email');
    if (!String(patente || '').trim()) throw new Error('Falta patente');
    if (!String(tipoVehiculo || '').trim()) throw new Error('Falta tipoVehiculo');
    if (!String(dniCuitCuil || '').trim()) throw new Error('Falta dniCuitCuil');

    const pat = String(patente).trim().toUpperCase();

    // 🧠 Cliente: buscar/crear
    let cliente = await ensureClienteBackend(
      {
        cliente: clienteIdBody || clienteIdAlt,
        nombreApellido,
        dniCuitCuil,
        domicilio,
        localidad,
        telefonoParticular,
        telefonoEmergencia,
        domicilioTrabajo,
        telefonoTrabajo,
        email,
        tipoVehiculo
      },
      sopt
    );
    if (!cliente) throw new Error('No se pudo obtener/crear cliente');
    if (!session) created.cliente = cliente;

    // Fotos (YA VIENEN MAPEADAS A RUTA WEB FINAL)
    const fotoSeguro       = buildFotoPath(req, 'fotoSeguro');
    const fotoDNI          = buildFotoPath(req, 'fotoDNI');
    const fotoCedulaVerde  = buildFotoPath(req, 'fotoCedulaVerde');

    // Vehículo (crear o actualizar)
    let vehiculo = await Vehiculo.findOne({ patente: pat }, null, sopt);
    if (!vehiculo) {
      vehiculo = new Vehiculo({
        patente: pat,
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
      console.log('🚗 Vehículo creado:', vehiculo._id);
    } else {
      vehiculo.tipoVehiculo = tipoVehiculo;
      vehiculo.abonado = true;
      vehiculo.cliente = cliente._id;
      await vehiculo.save(sopt);
      console.log('🔗 Vehículo actualizado/vinculado:', vehiculo._id);
    }

    // === 💰 Precio robusto por método + tier (doble intento + fallback opcional) ===
    let baseNuevo;
    try {
      const r = await resolverPrecioSeguro({
        tipoVehiculo,
        metodoPago,
        cochera,
        exclusiva: cochera === 'Fija' ? Boolean(exclusiva) : false,
        precioFront: req.body?.precio ? Number(req.body.precio) : undefined,
        tierFront: req.body?.tierAbono || undefined,
      });
      baseNuevo = r.precio;
    } catch (e) {
      const status = e.code === 'CATALOGO_NO_ENCONTRADO' ? 409 : 400;
      throw Object.assign(new Error(e.message), { httpStatus: status });
    }

    // máximo base ya abonado este mes por el cliente (para la diferencia del mes actual)
    const { maxBase } = await getClienteMaxBaseMensualVigente(cliente._id, new Date(), sopt);

    // multi-mes
    const multi = calcularCobroMultiMes(baseNuevo, maxBase, new Date(), mesesAbonar);
    const montoACobrar = multi.totalCobrar;

    // Crear Abono
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
      patente: pat,
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
      cochera: ['Fija','Móvil'].includes(String(cochera)) ? cochera : '',
      piso: String(piso || ''),
      exclusiva: cochera === 'Fija' ? Boolean(exclusiva) : false
    });
    await AbonoModelo.save(sopt);
    if (!session) created.abono = AbonoModelo;
    console.log('🧾 Abono creado:', AbonoModelo._id);

    // Vinculaciones
    vehiculo.abono = AbonoModelo._id;
    await vehiculo.save(sopt);

    cliente.abonado = true;
    cliente.finAbono = multi.venceEl;

    // Actualizar "tipo" del cliente si corresponde (nos quedamos con el más caro del mes actual)
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
    console.log('🔁 Cliente vinculado a abono/vehículo');

    // ❌ NUNCA crear Movimiento aquí (lo hace movimientoControllers desde el front).

    if (session) {
      await session.commitTransaction();
      session.endSession();
      console.log('✅ Transacción commit');
    }

    const clientePopulado = await Cliente.findById(cliente._id)
      .populate('vehiculos', '_id patente tipoVehiculo abonado')
      .populate('abonos')
      .populate('movimientos');

    return res.status(201).json({
      message:
        montoACobrar > 0
          ? `Abono registrado. Se cobró $${montoACobrar}.`
          : 'Abono registrado sin cargos.',
      cobrado: montoACobrar,
      abono: AbonoModelo,
      vehiculo,
      cliente: clientePopulado,
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
      console.log('↩️ Transacción abort');
    } else {
      // Rollback compensatorio
      try {
        if (created.abono)   await Abono.deleteOne({ _id: created.abono._id });
        if (created.vehiculo) await Vehiculo.deleteOne({ _id: created.vehiculo._id });
        if (created.cliente) await Cliente.deleteOne({ _id: created.cliente._id });
        console.log('🧹 Rollback compensatorio ejecutado');
      } catch (e) {
        console.warn('⚠️ Fallo en rollback compensatorio:', e?.message || e);
      }
    }

    const httpStatus = error.httpStatus || 400;
    return res.status(httpStatus).json({ message: 'Error al registrar abono', error: error.message });
  }
};

exports.agregarAbono = async (req, res) => {
  if (!req.body.cliente && req.body.clienteId) {
    req.body.cliente = req.body.clienteId;
  }
  return exports.registrarAbono(req, res);
};

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
      const c = String(cochera);
      if (['Fija', 'Móvil', ''].includes(c)) q.cochera = c;
    }
    if (exclusiva === 'true' || exclusiva === 'false') q.exclusiva = (exclusiva === 'true');
    if (activo === 'true' || activo === 'false') q.activo = (activo === 'true');

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

    if (String(paginated) === 'true') {
      return res.status(200).json({ total, limit: lim, skip: sk, items });
    }
    return res.status(200).json(items);
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
    res.status(200).json({ total: items.length, items });
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
    res.status(200).json({ total: items.length, items });
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
    const abono = await Abono.findById(id);
    if (!abono) return res.status(404).json({ message: 'Abono no encontrado' });
    res.status(200).json(abono);
  } catch (error) {
    console.error('Error al obtener abono por ID:', error);
    res.status(500).json({ message: 'Error al obtener abono por ID' });
  }
};

// PATCH /api/abonos/:id
exports.actualizarAbono = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    const updates = {};
    const allowed = [
      'nombreApellido','domicilio','localidad','telefonoParticular','telefonoEmergencia',
      'domicilioTrabajo','telefonoTrabajo','email','dniCuitCuil','patente','marca','modelo',
      'color','anio','companiaSeguro','precio','metodoPago','factura','tipoVehiculo',
      'activo',
      'cochera','piso','exclusiva',
      'fotoSeguro','fotoDNI','fotoCedulaVerde',
      // Nota: mesesAbonar no se persiste; la fechaExpiracion ya quedó extendida
    ];

    for (const k of allowed) {
      if (k in req.body) {
        updates[k] = req.body[k];
      }
    }

    // Normalizaciones
    if ('patente' in updates && updates.patente) {
      updates.patente = String(updates.patente).toUpperCase();
    }
    if ('anio' in updates && updates.anio != null) {
      updates.anio = Number(updates.anio);
    }
    if ('exclusiva' in updates) {
      updates.exclusiva = String(updates.exclusiva) === 'true' || updates.exclusiva === true;
    }
    if ('cochera' in updates) {
      const c = String(updates.cochera || '');
      updates.cochera = ['Fija','Móvil',''].includes(c) ? c : '';
    }

    const updated = await Abono.findByIdAndUpdate(id, { $set: updates }, { new: true });
    if (!updated) return res.status(404).json({ message: 'Abono no encontrado' });

    res.json({ ok: true, abono: updated });
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
    res.json({ ok: true, exclusiva: updated.exclusiva, abono: updated });
  } catch (e) {
    console.error('setExclusiva error:', e);
    res.status(500).json({ message: 'Error al actualizar exclusiva' });
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
