const mongoose = require('mongoose');
const { Schema } = mongoose;

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

  // Guarda la categoría del abono (auto|camioneta|moto) que usás como “precioAbono”
  precioAbono: { type: String, default: '' },

  // ===== NUEVO: estado de cochera del cliente =====
  // Guardamos exactamente "Fija" o "Móvil" (con tilde), o vacío si no definido.
  cochera: { type: String, enum: ['Fija', 'Móvil', ''], default: '' },
  exclusiva: { type: Boolean, default: false },
  piso: { type: String, default: '' },

  // >>>> ARRAYS REFERENCIADOS <<<<
  vehiculos: [{ type: Schema.Types.ObjectId, ref: 'Vehiculo' }],
  abonos:    [{ type: Schema.Types.ObjectId, ref: 'Abono' }],
  movimientos: [{ type: Schema.Types.ObjectId, ref: 'MovimientoCliente' }],

  balance: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Cliente', clienteSchema);
