// services/cocheraService.js
/* eslint-disable no-console */
const mongoose = require('mongoose');
const Cliente = require('../models/Cliente');
const Abono = require('../models/Abono');
const Vehiculo = require('../models/Vehiculo');
const Cochera = require('../models/Cochera');
const Outbox = require('../models/Outbox');

const {
  Types: { ObjectId },
} = mongoose;

/* =======================================================
   HELPERS ID / STR
======================================================= */

function asObjectId(id) {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) return new ObjectId(id);
  return null;
}
const toIdString = (x) => (x && x._id ? String(x._id) : String(x || ''));

function toUpperSafe(s) {
  return (s || '').toString().trim().toUpperCase();
}

/* =======================================================
   NORMALIZACIÓN COCHERA / PISO / EXCLUSIVA
   (alineada con cocheraControllers.js)
======================================================= */

function normCochera(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'fija') return 'Fija';
  if (v === 'movil' || v === 'móvil') return 'Móvil';
  return '';
}
function normPiso(raw) {
  return String(raw || '').trim();
}
function normExclusiva(raw, tipo) {
  if (tipo !== 'Fija') return false;
  const s = String(raw ?? '').trim().toLowerCase();
  return ['true', '1', 'si', 'sí', 'yes', 'y'].includes(s);
}

// 🅿️ ENSURE COCHERA INTERNO (IDEMPOTENTE + SANEANDO cliente SIEMPRE)
async function ensureCocheraInterno({
  clienteId,
  tipo,
  piso,
  exclusiva,
  session,
} = {}) {
  if (!clienteId) return null;

  const cliId =
    asObjectId(clienteId) ||
    (typeof clienteId === 'string' ? clienteId : null);

  if (!cliId) {
    console.warn('[ensureCocheraInterno] clienteId inválido:', clienteId);
    return null;
  }

  const cli = await Cliente.findById(cliId).session(session || null);
  if (!cli) {
    console.warn('[ensureCocheraInterno] cliente no encontrado:', cliId);
    return null;
  }

  const tipoNorm = normCochera(tipo) || 'Móvil';
  const pisoNorm = tipoNorm === 'Fija' ? normPiso(piso) : '';
  const exclusivaNorm =
    tipoNorm === 'Fija' ? normExclusiva(exclusiva, tipoNorm) : false;

  let coch = await Cochera.findOne({
    cliente: cli._id,
    tipo: tipoNorm,
    piso: pisoNorm,
    exclusiva: exclusivaNorm,
  }).session(session || null);

  if (coch) {
    // 🧼 SANEAMOS cochera.cliente si está mal o apunta a otro lado
    const currentCliId =
      asObjectId(coch.cliente) ||
      (coch.cliente && coch.cliente._id && asObjectId(coch.cliente._id));

    if (!currentCliId || String(currentCliId) !== String(cli._id)) {
      coch.cliente = cli._id;
      try {
        await coch.save({ session });
      } catch (e) {
        console.warn('[ensureCocheraInterno] no pude sanear cochera.cliente:', e.message || e);
      }
    }

    return coch;
  }

  // 🆕 Creación de cochera nueva, siempre con cliente bien seteado
  coch = new Cochera({
    cliente: cli._id,
    tipo: tipoNorm,
    piso: pisoNorm,
    exclusiva: exclusivaNorm,
    vehiculos: [],
  });

  await coch.save({ session });

  // MODELO A: referencia única por cocheraId (sin duplicados)
  await Cliente.updateOne(
    {
      _id: cli._id,
      "cocheras.cocheraId": { $ne: coch._id }   // si NO existe, lo agregamos
    },
    {
      $push: {
        cocheras: { cocheraId: coch._id }       // subdoc SIN _id → NO duplica más
      }
    },
    { session }
  );

  return coch;
}

/* =======================================================
   🚗 ASIGNAR VEHÍCULO INTERNO
   Ahora con fallback usando clienteId (del flujo de abono)
======================================================= */

async function asignarVehiculoInterno({
  cocheraId,
  vehiculoId,
  clienteId,   // 👈 NUEVO parámetro opcional
  session,
} = {}) {
  if (!cocheraId || !vehiculoId) {
    console.warn('[asignarVehiculoInterno] faltan ids', { cocheraId, vehiculoId });
    return null;
  }

  const cochId =
    asObjectId(cocheraId) ||
    (typeof cocheraId === 'string' ? cocheraId : null);
  const vehId =
    asObjectId(vehiculoId) ||
    (typeof vehiculoId === 'string' ? vehiculoId : null);

  if (!cochId || !vehId) {
    console.warn('[asignarVehiculoInterno] ids inválidos', { cocheraId, vehiculoId });
    return null;
  }

  const coch = await Cochera.findById(cochId).session(session || null);
  if (!coch) {
    console.warn('[asignarVehiculoInterno] cochera no encontrada:', cochId);
    return null;
  }

  const veh = await Vehiculo.findById(vehId).session(session || null);
  if (!veh) {
    console.warn('[asignarVehiculoInterno] vehiculo no encontrado:', vehId);
    return null;
  }

  // 1️⃣ Intento normal: sacar cliId desde cochera.cliente
  let cliId =
    asObjectId(coch.cliente) ||
    (coch.cliente && coch.cliente._id && asObjectId(coch.cliente._id));

  // 2️⃣ Fallback: si cochera.cliente está roto, uso clienteId que viene del flujo
  if (!cliId && clienteId) {
    const fromParam =
      asObjectId(clienteId) ||
      (clienteId && clienteId._id && asObjectId(clienteId._id)) ||
      (typeof clienteId === 'string' ? clienteId : null);

    if (fromParam) {
      cliId = fromParam;
      coch.cliente = fromParam;
      try {
        await coch.save({ session });
      } catch (e) {
        console.warn(
          '[asignarVehiculoInterno] no pude sanear cochera.cliente desde clienteId:',
          e.message || e
        );
      }
    }
  }

  if (!cliId) {
    console.warn(
      '[asignarVehiculoInterno] cochera.cliente inválido incluso con fallback:',
      coch.cliente
    );
    return null;
  }

  // Si el vehículo estaba en otra cochera, limpiamos
  if (veh.cocheraId && String(veh.cocheraId) !== String(cochId)) {
    await Cochera.updateOne(
      { _id: veh.cocheraId },
      { $pull: { vehiculos: vehId } },
      { session }
    );
  }

  veh.cocheraId = cochId;
  veh.cliente = cliId;
  await veh.save({ session });

  await Cochera.updateOne(
    { _id: cochId },
    { $addToSet: { vehiculos: vehId } },
    { session }
  );

  await Cliente.updateOne(
    { _id: cliId },
    { $addToSet: { vehiculos: vehId } },
    { session }
  );

  return Cochera.findById(cochId)
    .populate('vehiculos', '_id patente')
    .session(session || null);
}

/* =======================================================
   📤 OUTBOX COCHERA INTERNO (para sync remoto)
======================================================= */

async function registrarOutboxCocheraInterna({
  _id,
  cliente,
  tipo,
  piso,
  exclusiva,
  vehiculos = [],
} = {}) {
  try {
    if (!_id) return;
    if (process.env.SYNC_DISABLE_PUSH === '1') return;

    const cochId = asObjectId(_id) || _id;
    if (!cochId) return;

    let cliId = null;

    if (cliente) {
      if (typeof cliente === "string") {
        cliId = asObjectId(cliente) || cliente;
      } else if (cliente._id) {
        cliId = asObjectId(cliente._id) || String(cliente._id);
      }
    }
    const vehIds = (vehiculos || [])
      .map((v) => asObjectId(v) || (typeof v === 'string' ? v : null))
      .filter(Boolean);

    const doc = {
      _id: cochId,
      cliente: cliId,
      tipo: normCochera(tipo) || 'Móvil',
      piso: normPiso(piso),
      exclusiva: !!exclusiva,
      vehiculos: vehIds,
    };

    await Outbox.create({
      method: 'PATCH',
      route: `/api/cocheras/${String(cochId)}`,
      params: { id: String(cochId) },
      document: doc,
      status: 'pending',
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn(
      '[cocheraService] registrarOutboxCocheraInterna error:',
      e.message || e
    );
  }
}

/* =======================================================
   UTILIDADES EXISTENTES: saneo de clientes/abonos
   (lo que ya tenías, intacto)
======================================================= */

function maxDate(dates) {
  const ms = dates
    .map((d) => (d instanceof Date ? d : new Date(d)))
    .filter((d) => !Number.isNaN(+d))
    .map((d) => +d);
  if (!ms.length) return null;
  return new Date(Math.max(...ms));
}

function splitIdsForPull(ids) {
  const out = { oids: [], strings: [] };
  for (const x of ids || []) {
    try {
      if (!x) continue;
      if (x instanceof mongoose.Types.ObjectId) {
        out.oids.push(x);
        out.strings.push(String(x));
      } else if (typeof x === 'string') {
        out.strings.push(x);
        const oid = asObjectId(x);
        if (oid) out.oids.push(oid);
      } else if (x && x._id) {
        const s = String(x._id);
        out.strings.push(s);
        const oid = asObjectId(s);
        if (oid) out.oids.push(oid);
      }
    } catch (_) {}
  }
  out.oids = Array.from(new Set(out.oids.map(String))).map(
    (s) => new mongoose.Types.ObjectId(s)
  );
  out.strings = Array.from(new Set(out.strings.map(String)));
  return out;
}

async function tryPullVariants(model, filter, field, ids, { session } = {}) {
  const { oids, strings } = splitIdsForPull(ids);
  if (oids.length) {
    await model.updateOne(
      filter,
      { $pull: { [field]: { $in: oids } } },
      { session }
    );
  }
  if (strings.length) {
    await model.updateOne(
      filter,
      { $pull: { [field]: { $in: strings } } },
      { session }
    );
  }
  if (oids.length) {
    await model.updateOne(
      filter,
      { $pull: { [field]: { _id: { $in: oids } } } },
      { session }
    );
  }
  if (strings.length) {
    await model.updateOne(
      filter,
      { $pull: { [field]: { _id: { $in: strings } } } },
      { session }
    );
  }
}

/** Fallback: reescribe arrays filtrados sí o sí */
async function forceOverwriteArrays(
  clienteId,
  {
    abonoIdsToRemove = [],
    vehiculoIdsToRemove = [],
    patentesInactivas = [],
    session,
  } = {}
) {
  const c = await Cliente.findById(clienteId).session(session).lean();
  if (!c) return;

  const removeAbonoStr = new Set(
    (abonoIdsToRemove || []).map((x) => String(x))
  );
  const removeVehStr = new Set(
    (vehiculoIdsToRemove || []).map((x) => String(x))
  );
  const patsSet = new Set((patentesInactivas || []).map(toUpperSafe));

  const filteredAbonos = (c.abonos || []).filter((item) => {
    const idStr = String(item && item._id ? item._id : item);
    return !removeAbonoStr.has(idStr);
  });

  const filteredVehiculos = (c.vehiculos || []).filter((item) => {
    const idStr = String(item && item._id ? item._id : item);
    if (removeVehStr.has(idStr)) return false;
    if (item && item.patente && patsSet.has(toUpperSafe(item.patente)))
      return false;
    return true;
  });

  await Cliente.updateOne(
    { _id: clienteId },
    { $set: { abonos: filteredAbonos, vehiculos: filteredVehiculos } },
    { session }
  );
}

/**
 * Core de saneo
 */
async function _applyCleanCliente(clienteDoc, { session, dryRun = false } = {}) {
  if (!clienteDoc) return { modified: false, reason: 'not-found' };

  const cliente = await Cliente.findById(clienteDoc._id)
    .populate({
      path: 'abonos',
      select: '_id activo patente fechaExpiracion',
      options: { lean: true },
    })
    .populate({
      path: 'vehiculos',
      select: '_id patente',
      options: { lean: true },
    })
    .session(session)
    .lean();

  if (!cliente) return { modified: false, reason: 'not-found' };

  const abonosInactivos = (cliente.abonos || []).filter(
    (a) => a && a.activo === false
  );
  if (!abonosInactivos.length) {
    return { modified: false, reason: 'no-inactive-abonos' };
  }

  const abonoIdsToPull = abonosInactivos
    .map((a) => asObjectId(a._id) || String(a._id))
    .filter(Boolean);
  const patentesInactivas = Array.from(
    new Set(
      abonosInactivos
        .map((a) => toUpperSafe(a.patente))
        .filter(Boolean)
    )
  );

  const vehIdsInCliente = (cliente.vehiculos || [])
    .map((v) => asObjectId(v._id) || String(v._id))
    .filter(Boolean);
  let vehiculoIdsToPull = [];
  if (vehIdsInCliente.length && patentesInactivas.length) {
    const vehs = await Vehiculo.find({
      _id: { $in: vehIdsInCliente },
      patente: { $in: patentesInactivas },
    })
      .select('_id patente')
      .session(session)
      .lean();
    vehiculoIdsToPull = (vehs || [])
      .map((v) => asObjectId(v._id) || String(v._id))
      .filter(Boolean);
  }

  const removeSet = new Set(abonoIdsToPull.map(String));
  const abonosRestantes = (cliente.abonos || []).filter(
    (a) => !removeSet.has(String(a._id))
  );
  const activosRestantes = abonosRestantes.filter(
    (a) => a && a.activo !== false
  );
  const finAbonoNuevo = maxDate(
    activosRestantes.map((a) => a.fechaExpiracion).filter(Boolean)
  );
  const abonadoNuevo = !!(finAbonoNuevo && finAbonoNuevo >= new Date());

  if (dryRun) {
    return {
      modified: true,
      dryRun: true,
      updatePlan: {
        pullAbonos: abonoIdsToPull,
        pullVehiculos: vehiculoIdsToPull,
        set: { abonado: abonadoNuevo, finAbono: finAbonoNuevo || null },
      },
      details: {
        clienteId: cliente._id,
        removeAbonos: abonoIdsToPull,
        removeVehiculos: vehiculoIdsToPull,
        abonadoNuevo,
        finAbonoNuevo,
      },
    };
  }

  // 1) Pulls normales
  if (abonoIdsToPull.length) {
    await tryPullVariants(
      Cliente,
      { _id: cliente._id },
      'abonos',
      abonoIdsToPull,
      { session }
    );
  }
  if (vehiculoIdsToPull.length) {
    await tryPullVariants(
      Cliente,
      { _id: cliente._id },
      'vehiculos',
      vehiculoIdsToPull,
      { session }
    );
  }

  // 2) Fallback: overwrite forzado de arrays
  await forceOverwriteArrays(cliente._id, {
    abonoIdsToRemove: abonoIdsToPull,
    vehiculoIdsToRemove: vehiculoIdsToPull,
    patentesInactivas,
    session,
  });

  // 3) Flags siempre
  await Cliente.updateOne(
    { _id: cliente._id },
    { $set: { abonado: abonadoNuevo, finAbono: finAbonoNuevo || null } },
    { session }
  );

  return {
    modified: true,
    dryRun: false,
    details: {
      clienteId: cliente._id,
      removeAbonos: abonoIdsToPull,
      removeVehiculos: vehiculoIdsToPull,
      abonadoNuevo,
      finAbonoNuevo,
    },
  };
}

/* ===== Transacción opcional (fallback sin sesión si no hay RS) ===== */
async function runWithOptionalTx(fn) {
  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (_e) {
    if (session) {
      try {
        await session.endSession();
      } catch {}
    }
    return fn(undefined);
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch {}
    }
  }
}

async function cleanClienteById(clienteId, { session, dryRun = false } = {}) {
  const _id =
    asObjectId(clienteId) ||
    (typeof clienteId === 'string' ? clienteId : null);
  if (!_id) return { modified: false, reason: 'bad-id' };
  if (session) return _applyCleanCliente({ _id }, { session, dryRun });
  return runWithOptionalTx((s) =>
    _applyCleanCliente({ _id }, { session: s, dryRun })
  );
}

async function cleanManyClientes({ clienteIds = [], session } = {}) {
  const ids = (clienteIds || [])
    .map((x) => asObjectId(x) || (typeof x === 'string' ? x : null))
    .filter(Boolean);
  if (!ids.length) return { modifiedCount: 0, results: [] };

  const runBatch = async (sess) => {
    const results = [];
    for (const _id of ids) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await _applyCleanCliente({ _id }, { session: sess }));
    }
    return { modifiedCount: results.filter((r) => r.modified).length, results };
  };

  if (session) return runBatch(session);
  return runWithOptionalTx(runBatch);
}

async function cleanAllClientesOnce({ session } = {}) {
  const runAll = async (sess) => {
    const cursor = Cliente.find({}, { _id: 1 }).cursor({ batchSize: 200 });
    let modifiedCount = 0;
    const results = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      // eslint-disable-next-line no-await-in-loop
      const r = await _applyCleanCliente({ _id: doc._id }, { session: sess });
      if (r.modified) modifiedCount += 1;
      results.push(r);
    }
    return { modifiedCount, results };
  };
  if (session) return runAll(session);
  return runWithOptionalTx(runAll);
}

module.exports = {
  ensureCocheraInterno,
  asignarVehiculoInterno,
  registrarOutboxCocheraInterna,

  cleanClienteById,
  cleanManyClientes,
  cleanAllClientesOnce,
};
