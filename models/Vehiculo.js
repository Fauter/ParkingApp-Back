// models/Vehiculo.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const estadiaSchema = new Schema({
  entrada: Date,
  salida: Date,
  costoTotal: { type: Number, default: 0 },
  nombreTarifa: { type: String, default: null },
  tipoTarifa: { type: String, default: null },
  operadorNombre: String,
  metodoPago: String,
  monto: Number,
  ticket: Number,
  fotoUrl: String
}, { _id: false });

const vehiculoSchema = new Schema({
  // ✅ ÚNICA definición de índice único
  patente: { type: String, required: true, unique: true },

  tipoVehiculo: String,
  marca: String,
  modelo: String,
  color: String,
  anio: Number,

  abonado: { type: Boolean, default: false },
  abonoExpira: Date,
  abono: { type: Schema.Types.ObjectId, ref: 'Abono' },

  // vínculo con cliente
  cliente: { type: Schema.Types.ObjectId, ref: 'Cliente' },

  turno: { type: Boolean, default: false },

  estadiaActual: { type: estadiaSchema, default: {} },
  historialEstadias: { type: [estadiaSchema], default: [] },
}, { timestamps: true });

// 🔤 Normalizar patente a UPPER
vehiculoSchema.pre('save', function (next) {
  if (this.patente) this.patente = this.patente.trim().toUpperCase();
  next();
});

// ⚙️ Índices útiles para cron / lecturas
// - Ya tenés unique en patente (implícito).
// - Agregamos índice por turno para acelerar { turno: true, patente: { $nin: [...] } }
vehiculoSchema.index({ turno: 1 });

// Handler de error por duplicado
vehiculoSchema.post('save', function (error, doc, next) {
  if (error && error.code === 11000) {
    next(new Error(`Ya existe un vehículo con la patente ${doc.patente}`));
  } else {
    next(error);
  }
});

const Vehiculo = mongoose.model('Vehiculo', vehiculoSchema);

// 🚫 Evitar dropear índices ajenos del cluster.
// ✅ Crear los del schema si faltan.
Vehiculo.createIndexes().catch(err => {
  console.error('[Vehiculo] Error creando índices:', err);
});

module.exports = Vehiculo;
