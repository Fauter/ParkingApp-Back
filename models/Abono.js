const mongoose = require('mongoose');

const abonoSchema = new mongoose.Schema({
  nombreApellido: String,
  domicilio: String,
  localidad: String,
  telefonoParticular: String,
  telefonoEmergencia: String,
  domicilioTrabajo: String,
  telefonoTrabajo: String,
  email: String,
  patente: String,
  marca: String,
  modelo: String,
  color: String,
  anio: Number,
  companiaSeguro: String,
  precio: Number,
  // Eliminás tipoTarifa si ya no lo vas a usar
  tipoAbono: {
    nombre: String,
    dias: Number,
  },
  metodoPago: String,
  factura: String,
  tipoVehiculo: String,
  fechaCreacion: {
    type: Date,
    default: Date.now,
  },
  fechaExpiracion: Date,
  fotoSeguro: String,
  fotoDNI: String,
  fotoCedulaVerde: String,
  fotoCedulaAzul: String,
});

module.exports = mongoose.model('Abono', abonoSchema);
