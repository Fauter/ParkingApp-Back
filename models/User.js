const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  apellido: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["operador", "admin", "superAdmin"], default: "operador" },
  ultimoAcceso: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
