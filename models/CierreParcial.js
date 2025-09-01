// models/CierreParcial.js
'use strict';
const mongoose = require('mongoose');

const cierreParcialSchema = new mongoose.Schema({
  // ⚠️ tu front envía fecha/hora como string (YYYY-MM-DD y HH:mm)
  fecha: { type: String, required: true },
  hora: { type: String, required: true },

  // 💵 monto numérico requerido
  monto: { type: Number, required: true, min: 0 },

  // 🆕 Campos opcionales que agregaste en el front
  // nombre: input texto (max 60)
  nombre: { type: String, default: '', trim: true, maxlength: 60 },
  // texto: textarea (max 300)
  texto: { type: String, default: '', trim: true, maxlength: 300 },

  // 🔐 operador puede venir como objeto en el request; acá persistimos referencias útiles
  // dejamos compat con tu lógica actual: `operador` guarda nombre (string) para mostrar rápido
  operador: { type: String, required: true, trim: true },

  // Además persistimos operadorId y operadorNombre para robustez
  operadorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  operadorNombre: { type: String, trim: true, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('CierreParcial', cierreParcialSchema);
