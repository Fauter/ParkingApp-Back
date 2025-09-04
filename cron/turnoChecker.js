// cron/turnoChecker.js
const cron = require('node-cron');
const Vehiculo = require('../models/Vehiculo');
const Turno = require('../models/Turno');
const { expirarTurnosAutomaticamente } = require('../controllers/turnoControllers');

let isRunning = false;

async function runOnce() {
  if (isRunning) {
    console.warn('[turnoCron] ya hay una ejecución en curso, salto esta vuelta');
    return;
  }
  isRunning = true;
  const started = Date.now();

  try {
    // 1) Expirar turnos que ya terminaron
    await expirarTurnosAutomaticamente();

    // 2) Determinar patentes con turnos activos (no expirados, no usados, fin > ahora)
    const ahora = new Date();
    const patentesActivasRaw = await Turno.distinct('patente', {
      expirado: false,
      usado: false,
      fin: { $gt: ahora }
    });

    // ⚠️ Crítico: forzar UPPER para alinear con normalización de Turno y posibles datos viejos en Vehiculo
    const patentesActivas = (patentesActivasRaw || []).map(p =>
      String(p || '').trim().toUpperCase()
    ).filter(Boolean);

    // 3) Setear Vehiculo.turno=true para esas patentes (solo si está en false)
    if (patentesActivas.length > 0) {
      const r1 = await Vehiculo.updateMany(
        { patente: { $in: patentesActivas }, turno: { $ne: true } },
        { $set: { turno: true, updatedAt: new Date() } }
      );
      if (r1?.modifiedCount) {
        console.log(`[turnoCron] vehículos marcados con turno=true: ${r1.modifiedCount}`);
      }
    }

    // 4) Setear Vehiculo.turno=false para los que no están en la lista pero quedaron en true
    const r2 = await Vehiculo.updateMany(
      { turno: true, patente: { $nin: patentesActivas } },
      { $set: { turno: false, updatedAt: new Date() } }
    );
    if (r2?.modifiedCount) {
      console.log(`[turnoCron] vehículos marcados con turno=false: ${r2.modifiedCount}`);
    }

  } catch (err) {
    console.error('[turnoCron] error en runOnce:', err);
  } finally {
    isRunning = false;
    const ms = Date.now() - started;
    if (ms > 2000) console.log(`[turnoCron] corrida terminó en ${ms} ms`);
  }
}

// Programa: cada minuto
cron.schedule('* * * * *', runOnce, { timezone: 'America/Argentina/Buenos_Aires' });

// Bootstrap: corre una vez al cargar el módulo
runOnce();

module.exports = { runOnce };
