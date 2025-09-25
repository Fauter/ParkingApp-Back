// models/Movimiento.js
const mongoose = require('mongoose');

const MovimientoSchema = new mongoose.Schema({
  cliente: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente' },

  patente: { type: String, required: true },

  // ⛔ Queda fija al momento de creación.
  fecha: { type: Date, default: Date.now, immutable: true },

  descripcion: { type: String, required: true },
  operador: { type: String, required: true },
  tipoVehiculo: { type: String, required: true },

  metodoPago: { type: String, enum: ['Efectivo', 'Transferencia', 'Débito', 'Crédito', 'QR'], required: true },
  factura: { type: String, enum: ['CC', 'A', 'Final'], required: true },

  monto: { type: Number, required: true },

  promo: { type: mongoose.Schema.Types.Mixed, default: 0 },

  tipoTarifa: { type: String },
  ticket: { type: Number },

  // ✅ Foto asociada al movimiento (misma que el vehículo)
  fotoUrl: { type: String, default: null }
}, { timestamps: true });

MovimientoSchema.pre('save', function(next) {
  if (!this.fecha) this.fecha = this.createdAt || new Date();
  next();
});

MovimientoSchema.index({ createdAt: -1 });
MovimientoSchema.index({ fecha: -1 });
MovimientoSchema.index({ patente: 1, createdAt: -1 });
MovimientoSchema.index({ ticket: -1 });
MovimientoSchema.index({ fotoUrl: 1 });

module.exports = mongoose.model('Movimiento', MovimientoSchema);
