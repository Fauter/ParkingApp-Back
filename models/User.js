// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    nombre:   { type: String, required: true },
    apellido: { type: String, required: true },
    username: { type: String, required: true, unique: true, index: true },
    // visible por defecto
    password: { type: String, required: true },
    role:     { type: String, enum: ["operador", "auditor", "cargaMensuales", "admin", "superAdmin"], default: "operador" },
    ultimoAcceso: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// No tocamos password; solo _id -> string y limpiamos __v
function transformOut(_doc, ret) {
  if (ret && ret._id != null) ret._id = String(ret._id);
  delete ret.__v;
  return ret;
}
UserSchema.set('toJSON',  { transform: transformOut });
UserSchema.set('toObject', { transform: transformOut });

module.exports = mongoose.model('User', UserSchema);
