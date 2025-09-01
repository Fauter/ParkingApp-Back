// models/Movimiento.js
const mongoose = require('mongoose');

const MovimientoSchema = new mongoose.Schema({
  cliente: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente' },

  patente: { type: String, required: true },

  // ⛔ Queda fija al momento de creación. No cambia nunca.
  // Importante: `default: Date.now` (sin paréntesis) para evaluar en el create.
  fecha: { type: Date, default: Date.now, immutable: true },

  descripcion: { type: String, required: true },
  operador: { type: String, required: true },
  tipoVehiculo: { type: String, required: true },

  // Si tu app usa otras opciones (p.ej. 'Transferencia'), agregalas acá.
  metodoPago: { type: String, enum: ['Efectivo', 'Débito', 'Crédito', 'QR'], required: true },

  // Ajustá el enum a lo que realmente usás ('CC'/'A'/'B'/'C'/'Final', etc.)
  factura: { type: String, enum: ['CC', 'A', 'Final'], required: true },

  monto: { type: Number, required: true },

  // Si a veces guardás objeto de promo, Mixed = flexible (0 por compatibilidad vieja)
  promo: { type: mongoose.Schema.Types.Mixed, default: 0 },

  tipoTarifa: { type: String },
  ticket: { type: Number }
}, { timestamps: true });

// 🔧 Garantiza que `fecha` exista una sola vez al crear.
// Si por alguna razón no seteó fecha, la copia desde createdAt.
MovimientoSchema.pre('save', function(next) {
  if (!this.fecha) this.fecha = this.createdAt || new Date();
  next();
});

// 🔎 Índices útiles para queries típicas
MovimientoSchema.index({ createdAt: -1 });
MovimientoSchema.index({ fecha: -1 });
MovimientoSchema.index({ patente: 1, createdAt: -1 });

module.exports = mongoose.model('Movimiento', MovimientoSchema);
