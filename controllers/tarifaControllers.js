const Tarifa = require('../models/Tarifa');

// === Config "abonos" del sistema (forzados) ===
const ABONO_SYSTEM_NAMES = ['Móvil', 'Fija', 'Exclusiva'];

async function ensureSystemAbonos() {
  // Crea/actualiza las 3 tarifas de "abono" si no existen (idempotente)
  const ops = ABONO_SYSTEM_NAMES.map((nombre) =>
    Tarifa.findOneAndUpdate(
      { tipo: 'abono', nombre },
      // Valores por defecto (no se usan en cálculos de tiempo, pero quedan prolijos)
      { $setOnInsert: { dias: 30, horas: 0, minutos: 0, tolerancia: 0 } },
      { upsert: true, new: true }
    )
  );
  await Promise.all(ops);
}

// GET todas las tarifas
exports.getTarifas = async (req, res) => {
  try {
    // Asegurar que existan las 3 de abono antes de devolver
    await ensureSystemAbonos();

    const tarifas = await Tarifa.find().sort({ tipo: 1, nombre: 1 });
    res.status(200).json(tarifas);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener tarifas' });
  }
};

// POST nueva tarifa
exports.createTarifa = async (req, res) => {
  try {
    // Blindar: no permitir crear "abono" por API normal
    if (String(req.body?.tipo).toLowerCase() === 'abono') {
      return res.status(403).json({ error: 'Las tarifas de abono están bloqueadas. No se pueden crear por API.' });
    }

    const nuevaTarifa = new Tarifa(req.body);
    await nuevaTarifa.save();
    res.status(201).json(nuevaTarifa);
  } catch (err) {
    res.status(400).json({ error: 'Error al crear tarifa' });
  }
};

// PUT actualizar tarifa
exports.updateTarifa = async (req, res) => {
  try {
    const { id } = req.params;
    const actual = await Tarifa.findById(id);
    if (!actual) return res.status(404).json({ error: 'Tarifa no encontrada' });

    // Blindar edición de las 3 "abono" del sistema
    if (
      String(actual.tipo).toLowerCase() === 'abono' &&
      ABONO_SYSTEM_NAMES.includes(actual.nombre)
    ) {
      return res.status(403).json({ error: 'Tarifa de abono del sistema: edición bloqueada.' });
    }

    // También evitar que alguien intente cambiar el tipo a "abono"
    if (String(req.body?.tipo).toLowerCase() === 'abono') {
      return res.status(403).json({ error: 'No podés convertir una tarifa en "abono" por API.' });
    }

    const tarifaActualizada = await Tarifa.findByIdAndUpdate(id, req.body, { new: true });
    res.status(200).json(tarifaActualizada);
  } catch (err) {
    res.status(400).json({ error: 'Error al actualizar tarifa' });
  }
};

// DELETE eliminar tarifa
exports.deleteTarifa = async (req, res) => {
  try {
    const { id } = req.params;
    const actual = await Tarifa.findById(id);
    if (!actual) return res.status(404).json({ error: 'Tarifa no encontrada' });

    if (
      String(actual.tipo).toLowerCase() === 'abono' &&
      ABONO_SYSTEM_NAMES.includes(actual.nombre)
    ) {
      return res.status(403).json({ error: 'Tarifa de abono del sistema: eliminación bloqueada.' });
    }

    await Tarifa.findByIdAndDelete(id);
    res.status(200).json({ mensaje: 'Tarifa eliminada correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar tarifa' });
  }
};
