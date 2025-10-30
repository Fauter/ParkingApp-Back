// models/CierreDeCaja.js
'use strict';
const mongoose = require('mongoose');

const cierreDeCajaSchema = new mongoose.Schema({
  fecha: { type: String, required: true }, // "YYYY-MM-DD"
  hora:  { type: String, required: true }, // "HH:mm"
  totalRecaudado: { type: Number, required: true },
  dejoEnCaja:     { type: Number, required: true },
  totalRendido:   { type: Number, required: true },

  // 👉 Ahora es SIEMPRE un string con el username (no ref, no ObjectId)
  operador: { type: String, required: true, trim: true },

  retirado: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('CierreDeCaja', cierreDeCajaSchema);
