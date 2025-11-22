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
  operadorId: { type: String },

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

  promo: { type: mongoose.Schema.Types.Mixed, default: null },

  tipoTarifa: { type: String },
  ticket: { type: Number },

  // ✔ NUEVO: ticketPago autoincremental
  ticketPago: { type: Number, default: null },

  fotoUrl: { type: String, default: null },

  idemBucket2s: { type: Number, default: null }
}, { timestamps: true });

MovimientoSchema.pre('save', async function(next) {
  try {
    // Fecha fija al crear
    if (!this.fecha) {
      this.fecha = this.createdAt || new Date();
    }

    // Autoincremento simple basado en la colección
    if (this.isNew && (this.ticketPago == null)) {
      const Modelo = this.constructor;

      // Buscar SOLO movimientos reales
      const last = await Modelo
        .findOne(
          {
            ticketPago: { $gte: 1 },        // solo válidos
            movimiento: { $exists: false }  // ignora basura del syncService
          },
          { ticketPago: 1 }
        )
        .sort({ ticketPago: -1 })
        .lean()
        .catch(() => null);

      // 🎯 EXACTAMENTE como vos querés:
      // Si no hay movimientos válidos → ticketPago = 1
      // Si hay → ticketPago = último + 1
      const lastValue = Number(last?.ticketPago) || 0;
      this.ticketPago = lastValue + 1;
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Índices útiles
MovimientoSchema.index({ createdAt: -1 });
MovimientoSchema.index({ fecha: -1 });
MovimientoSchema.index({ patente: 1, createdAt: -1 });
MovimientoSchema.index({ ticket: -1 });
MovimientoSchema.index({ ticketPago: 1 });
MovimientoSchema.index({ fotoUrl: 1 });
MovimientoSchema.index({ operador: 1 });
MovimientoSchema.index({ operadorId: 1 });

// 🧱 Índice ÚNICO de idempotencia
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
