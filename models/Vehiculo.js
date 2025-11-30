// models/Vehiculo.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/* =======================================================
   ESQUEMA ESTADÍA
======================================================= */

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

/* =======================================================
   ESQUEMA VEHÍCULO
======================================================= */

const vehiculoSchema = new Schema({

  // Identificación
  patente: { type: String, required: true, unique: true },

  // Datos del vehículo
  tipoVehiculo: String,
  marca: String,
  modelo: String,
  color: String,
  anio: Number,

  // Estado de abono
  abonado: { type: Boolean, default: false },
  abonoExpira: Date,
  abono: { type: Schema.Types.ObjectId, ref: 'Abono' },

  // Relación directa al cliente
  cliente: { type: Schema.Types.ObjectId, ref: 'Cliente' },

  /*
   * Relación REAL a la cochera asignada.
   * La manejan ensureCocheraInterno + asignarVehiculo.
   */
  cocheraId: { type: Schema.Types.ObjectId, ref: 'Cochera' },  // 👈 IMPORTANTE: ref agregado

  // Estadía / turnos
  turno: { type: Boolean, default: false },
  estadiaActual: { type: estadiaSchema, default: {} },
  historialEstadias: { type: [estadiaSchema], default: [] }

}, { timestamps: true });

/* =======================================================
   PRE-SAVE: NORMALIZACIÓN
======================================================= */

// Normalizar patente
vehiculoSchema.pre('save', function (next) {
  if (this.patente) {
    this.patente = this.patente.trim().toUpperCase();
  }
  next();
});

/* =======================================================
   PRE-SAVE: VALIDACIÓN DE cocheraId
======================================================= */

vehiculoSchema.pre('save', async function (next) {
  try {
    if (!this.cocheraId) return next();

    const Cochera = mongoose.model('Cochera');
    const exists = await Cochera.exists({ _id: this.cocheraId });

    if (!exists) {
      // Seguridad silenciosa: si la cochera desapareció, lo limpiamos
      this.cocheraId = undefined;
    }

    next();
  } catch (err) {
    console.error("Error en pre-save (Vehiculo.cocheraId):", err);
    next(err);
  }
});

/* =======================================================
   ÍNDICES
======================================================= */

vehiculoSchema.index({ cliente: 1 });
vehiculoSchema.index({ cocheraId: 1 });
vehiculoSchema.index({ turno: 1 });

/* =======================================================
   ERROR DE DUPLICADO (patente)
======================================================= */

vehiculoSchema.post('save', function (error, doc, next) {
  if (error && error.code === 11000) {
    next(new Error(`Ya existe un vehículo con la patente ${doc.patente}`));
  } else {
    next(error);
  }
});

/* =======================================================
   EXPORT
======================================================= */

const Vehiculo = mongoose.model('Vehiculo', vehiculoSchema);

Vehiculo.createIndexes().catch(err => {
  console.error('[Vehiculo] Error creando índices:', err);
});

module.exports = Vehiculo;
