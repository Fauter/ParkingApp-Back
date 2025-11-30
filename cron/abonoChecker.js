// cron/abonoChecker.js
const Abono = require('../models/Abono');
const Vehiculo = require('../models/Vehiculo');
const Cochera = require('../models/Cochera');

let running = false;

async function runOnce() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    // 1) Buscar abonos expirados activos
    const expirados = await Abono.find({
      activo: true,
      fechaExpiracion: { $lt: now }
    }).select('_id cochera piso exclusiva cliente').lean();

    if (!expirados.length) {
      running = false;
      return;
    }

    const abonoIds = expirados.map(a => a._id);

    // 2) Desactivar abonos vencidos
    await Abono.updateMany(
      { _id: { $in: abonoIds } },
      { $set: { activo: false, updatedAt: new Date() } }
    );

    // 3) Para cada abono, encontrar su cochera real y marcar sus vehículos
    for (const ab of expirados) {
      const coch = await Cochera.findOne({
        cliente: ab.cliente,
        tipo: ab.cochera,
        piso: ab.piso,
        exclusiva: ab.exclusiva
      }).lean();

      if (!coch) continue;

      const vehiculos = await Vehiculo.find({ cocheraId: coch._id })
        .select('_id')
        .lean();

      const vehIds = vehiculos.map(v => v._id);

      if (vehIds.length) {
        await Vehiculo.updateMany(
          { _id: { $in: vehIds } },
          { $set: { abonado: false, abono: null }, $unset: { abonoExpira: "" } }
        );
      }
    }

    console.log(`[abonoChecker] expirados procesados: ${expirados.length}`);

  } catch (e) {
    console.error('[abonoChecker] Error:', e);
  } finally {
    running = false;
  }
}

function startAbonoChecker() {
  if (globalThis.__abonoCheckerStarted) return { runOnce };
  globalThis.__abonoCheckerStarted = true;

  const intervalMs = 15 * 60 * 1000; // 15 min por defecto

  setTimeout(() => runOnce().catch(() => {}), 5000);
  setInterval(() => runOnce().catch(() => {}), intervalMs);

  console.log(`[abonoChecker] iniciado. Intervalo: ${intervalMs}ms`);
  return { runOnce };
}

module.exports = { startAbonoChecker, runOnce };
