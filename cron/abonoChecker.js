// cron/abonoChecker.js
const Abono = require('../models/Abono');
const Cliente = require('../models/Cliente');
const Vehiculo = require('../models/Vehiculo');

let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  const startedAt = new Date();
  try {
    const now = new Date();

    // 1) Expiran abonos activos con fecha pasada
    const expirados = await Abono.find({
      activo: true,
      fechaExpiracion: { $lt: now }
    }).select('_id cliente vehiculo').lean();

    if (!expirados.length) {
      return;
    }

    const abonoIds = expirados.map(a => a._id);
    const clienteIds = [...new Set(expirados.map(a => String(a.cliente)).filter(Boolean))];
    const vehiculoIds = expirados.map(a => a.vehiculo).filter(Boolean);

    await Abono.updateMany(
      { _id: { $in: abonoIds } },
      { $set: { activo: false, updatedAt: new Date() } }
    );

    if (vehiculoIds.length) {
      await Vehiculo.updateMany(
        { _id: { $in: vehiculoIds } },
        { $set: { abonado: false, updatedAt: new Date() }, $unset: { abono: "" } }
      );
    }

    // 2) Recalcular estado por cliente (si le queda algún abono activo vigente)
    for (const cid of clienteIds) {
      const activos = await Abono.find({
        cliente: cid,
        activo: true,
        fechaExpiracion: { $gte: now }
      }).select('fechaExpiracion tipoVehiculo').lean();

      if (activos.length) {
        let maxFin = activos[0].fechaExpiracion;
        let tipo = activos[0].tipoVehiculo || '';
        for (const a of activos) {
          if (new Date(a.fechaExpiracion) > new Date(maxFin)) {
            maxFin = a.fechaExpiracion;
            tipo = a.tipoVehiculo || tipo;
          }
        }
        await Cliente.updateOne(
          { _id: cid },
          { $set: { abonado: true, finAbono: maxFin, precioAbono: tipo, updatedAt: new Date() } }
        );
      } else {
        await Cliente.updateOne(
          { _id: cid },
          { $set: { abonado: false, finAbono: null, updatedAt: new Date() } }
        );
      }
    }

    const elapsed = ((new Date()) - startedAt);
    console.log(`[abonoChecker] expirados=${expirados.length}, clientes=${clienteIds.length}, t=${elapsed}ms`);
  } catch (e) {
    console.error('[abonoChecker] error:', e?.message || e);
  } finally {
    running = false;
  }
}

function startAbonoChecker() {
  // 🔒 Singleton guard: evitá dobles timers si el módulo se carga dos veces
  if (globalThis.__abonoCheckerStarted) {
    return { runOnce };
  }
  globalThis.__abonoCheckerStarted = true;

  const intervalMs = Number(process.env.ABONO_CHECKER_INTERVAL_MS) || (15 * 60 * 1000); // 15 min
  // Primera pasada (un toque después de levantar el server)
  setTimeout(() => runOnce().catch(() => {}), 5000);
  // Recurrencia
  setInterval(() => runOnce().catch(() => {}), intervalMs);
  console.log(`[abonoChecker] iniciado. Intervalo: ${intervalMs} ms`);
  return { runOnce };
}

// Auto-start al requerir el módulo (como tu turnoChecker)
startAbonoChecker();

module.exports = { startAbonoChecker, runOnce };
