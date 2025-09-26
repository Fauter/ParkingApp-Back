const mongoose = require('mongoose');

const TipoVehiculoSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
  nombre: { type: String, required: true, unique: true, trim: true },
  hora:   { type: Boolean, default: false },
  mensual:{ type: Boolean, default: false }
}, { timestamps: true });

TipoVehiculoSchema.index({ nombre: 1 }, { unique: true });

module.exports = mongoose.model('TipoVehiculo', TipoVehiculoSchema);
