// models/Abono.js
const mongoose = require('mongoose');
const { Schema } = mongoose;
const { Types: { ObjectId } } = mongoose;

function toObjectIdSafe(v) {
  if (!v) return v;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) return new ObjectId(v);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v) && (v.length === 12 || v.length === 24)) {
    return new ObjectId(v);
  }
  if (typeof v === 'object' && v.buffer && typeof v.buffer === 'object') {
    try {
      const arr = Object.keys(v.buffer).map(k => v.buffer[k]);
      const buf = Buffer.from(arr);
      if (buf.length === 12 || buf.length === 24) return new ObjectId(buf);
    } catch (_) {}
  }
  return v; // dejar como vino, pero idealmente nunca debería ocurrir
}

const abonoSchema = new Schema({
  nombreApellido: String,
  domicilio: String,
  localidad: String,
  telefonoParticular: String,
  telefonoEmergencia: String,
  domicilioTrabajo: String,
  telefonoTrabajo: String,
  email: String,
  dniCuitCuil: String,

  patente: String,
  marca: String,
  modelo: String,
  color: String,
  anio: Number,
  companiaSeguro: String,

  precio: Number,

  tipoTarifa: {
    type: String,
    default: 'abono'
  },
  tipoAbono: {
    nombre: String,
    dias: Number,
  },

  metodoPago: String,
  factura: String,
  tipoVehiculo: String,

  // ===== NUEVO =====
  cochera: { type: String, enum: ['Fija', 'Móvil', ''] , default: '' },
  piso: { type: String, default: '' },
  exclusiva: { type: Boolean, default: false },

  fechaCreacion: {
    type: Date,
    default: Date.now,
  },
  fechaExpiracion: Date,

  fotoSeguro: String,
  fotoDNI: String,
  fotoCedulaVerde: String,

  activo: {
    type: Boolean,
    default: true
  },

  // >>>> IMPRESCINDIBLE PARA VINCULAR <<<<
  cliente: { 
    type: Schema.Types.ObjectId, 
    ref: 'Cliente',
    set: toObjectIdSafe
  },
  vehiculo: { 
    type: Schema.Types.ObjectId, 
    ref: 'Vehiculo',
    set: toObjectIdSafe
  },
}, { strict: true, timestamps: true });

/**
 * Índices críticos para cron:
 * - Expiración masiva
 * - Recalculo por cliente
 */
abonoSchema.index({ activo: 1, fechaExpiracion: 1 });
abonoSchema.index({ cliente: 1, activo: 1, fechaExpiracion: 1 });

module.exports = mongoose.model('Abono', abonoSchema);
