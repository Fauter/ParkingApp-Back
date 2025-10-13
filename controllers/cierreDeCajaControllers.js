// controllers/cierreDeCajaControllers.js
'use strict';
const mongoose = require('mongoose');
const CierreDeCaja = require('../models/CierreDeCaja');

const { Types } = mongoose;

// ------ helper robusto para normalizar operador ------
function normalizeOperadorId(raw) {
  if (!raw) return null;

  // Si viene como objeto con _id
  if (typeof raw === 'object' && raw !== null) {
    const id = raw._id || raw.id;
    return (typeof id === 'string' && Types.ObjectId.isValid(id)) ? id : null;
  }

  // Si viene como string:
  if (typeof raw === 'string') {
    const s = raw.trim();

    // Si parece JSON, intento parsear
    if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') {
          const id = parsed._id || parsed.id;
          return (typeof id === 'string' && Types.ObjectId.isValid(id)) ? id : null;
        }
      } catch {
        // no es JSON válido, sigo
      }
    }

    // Si es un ObjectId plano
    if (Types.ObjectId.isValid(s)) return s;
    return null;
  }

  return null;
}

// Obtener todos los cierres
const getAll = async (req, res) => {
  try {
    const cierres = await CierreDeCaja.find()
      .populate('operador', 'nombre apellido username role')
      .sort({ _id: -1 });
    res.json(cierres);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Obtener uno por id
const getById = async (req, res) => {
  try {
    const cierre = await CierreDeCaja.findById(req.params.id)
      .populate('operador', 'nombre apellido username role');
    if (!cierre) return res.status(404).json({ message: 'No encontrado' });
    res.json(cierre);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Crear nuevo cierre
const create = async (req, res) => {
  try {
    const { fecha, hora, totalRecaudado, dejoEnCaja, totalRendido, operador } = req.body;

    const operadorId = normalizeOperadorId(operador);
    if (!operadorId) {
      return res.status(400).json({ message: "El campo 'operador' es obligatorio y debe ser un ObjectId válido" });
    }

    const cierre = new CierreDeCaja({
      fecha,
      hora,
      totalRecaudado,
      dejoEnCaja,
      totalRendido,
      operador: operadorId,
      retirado: false
    });

    await cierre.save();

    const cierrePopulado = await cierre.populate('operador', 'nombre apellido username role');
    res.status(201).json(cierrePopulado);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Actualizar cierre por id
const updateById = async (req, res) => {
  try {
    const id = req.params.id;
    const updateData = { ...req.body };

    if (updateData.operador) {
      const operadorId = normalizeOperadorId(updateData.operador);
      if (!operadorId) {
        return res.status(400).json({ message: "El campo 'operador' debe ser un ObjectId válido" });
      }
      updateData.operador = operadorId;
    }

    const cierreActualizado = await CierreDeCaja.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true, context: 'query' }
    ).populate('operador', 'nombre apellido username role');

    if (!cierreActualizado) return res.status(404).json({ message: 'Cierre de caja no encontrado' });
    res.json(cierreActualizado);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Eliminar todos los cierres
const deleteAll = async (req, res) => {
  try {
    await CierreDeCaja.deleteMany({});
    res.json({ message: 'Todos los cierres eliminados' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAll,
  getById,
  create,
  updateById,
  deleteAll,
};
