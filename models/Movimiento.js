// models/Movimiento.js
'use strict';

const mongoose = require('mongoose');

const MovimientoSchema = new mongoose.Schema({
  cliente: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente' },

  patente: { type: String, required: true },

  // ⛔ Fija al momento de creación
  fecha: { type: Date, default: Date.now, immutable: true },

  descripcion: { type: String, required: true },

  // 👤 Operador (string mostrado) + referencia opcional
  operador: { type: String, required: true },
  operadorId: { type: String }, // opcional (por si querés enlazar al usuario)

  tipoVehiculo: { type: String, required: true },

  metodoPago: {
    type: String,
    enum: ['Efectivo', 'Transferencia', 'Débito', 'Crédito', 'QR'],
    required: true
  },
  factura: {
    type: String,
    enum: ['CC', 'A', 'Final'],
    required: true
  },

  monto: { type: Number, required: true },

  // 🎟️ Info de promo asociada (objeto libre) o null
  promo: { type: mongoose.Schema.Types.Mixed, default: null },

  tipoTarifa: { type: String },
  ticket: { type: Number },

  // ✅ Foto asociada al movimiento
  fotoUrl: { type: String, default: null },

  // 🔑 Bucket de idempotencia en milisegundos (p.ej. 2s => floor(now/2000))
  idemBucket2s: { type: Number, default: null }
}, { timestamps: true });

MovimientoSchema.pre('save', function(next) {
  if (!this.fecha) this.fecha = this.createdAt || new Date();
  next();
});

// Índices útiles
MovimientoSchema.index({ createdAt: -1 });
MovimientoSchema.index({ fecha: -1 });
MovimientoSchema.index({ patente: 1, createdAt: -1 });
MovimientoSchema.index({ ticket: -1 });
MovimientoSchema.index({ fotoUrl: 1 });
MovimientoSchema.index({ operador: 1 });
MovimientoSchema.index({ operadorId: 1 });

// 🧱 Índice ÚNICO de idempotencia (solo si idemBucket2s existe)
MovimientoSchema.index({
  idemBucket2s: 1,
  patente: 1,
  tipoVehiculo: 1,
  metodoPago: 1,
  factura: 1,
  monto: 1,
  descripcion: 1,
  tipoTarifa: 1
}, {
  unique: true,
  name: 'uniq_mov_bucket',
  partialFilterExpression: { idemBucket2s: { $exists: true } }
});

module.exports = mongoose.model('Movimiento', MovimientoSchema);
