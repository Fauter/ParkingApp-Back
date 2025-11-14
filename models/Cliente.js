const mongoose = require('mongoose');
const { Schema } = mongoose;

// ==== Esquema principal Cliente ====
const clienteSchema = new Schema({
  nombreApellido: { type: String, index: true },
  dniCuitCuil: String,
  domicilio: String,
  localidad: String,
  telefonoParticular: String,
  telefonoEmergencia: String,
  domicilioTrabajo: String,
  telefonoTrabajo: String,
  email: String,

  abonado: { type: Boolean, default: false },
  finAbono: { type: Date, default: null },
  precioAbono: { type: String, default: '' },

  // ===== CAMPOS HISTÓRICOS (retrocompatibilidad) =====
  cochera: { type: String, enum: ['Fija', 'Móvil', ''], default: '' },
  exclusiva: { type: Boolean, default: false },
  piso: { type: String, default: '' },

  // ===== RELACIONES =====
  vehiculos: [{ type: Schema.Types.ObjectId, ref: 'Vehiculo' }],
  abonos: [{ type: Schema.Types.ObjectId, ref: 'Abono' }],
  movimientos: [{ type: Schema.Types.ObjectId, ref: 'MovimientoCliente' }],

  balance: { type: Number, default: 0 },
}, { timestamps: true });

// ===== Índices recomendados =====
clienteSchema.index({ nombreApellido: 1 });
clienteSchema.index({ dniCuitCuil: 1 });

module.exports = mongoose.model('Cliente', clienteSchema);
