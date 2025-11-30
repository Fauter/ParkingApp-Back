// models/Cliente.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/* =======================================================
   SUBESQUEMA: cocheras[] (sistema real)
======================================================= */
const clienteCocheraSchema = new Schema(
  {
    cocheraId: { type: Schema.Types.ObjectId, ref: "Cochera", required: true },
  },
  { _id: false }
);

/* =======================================================
   ESQUEMA PRINCIPAL CLIENTE — LIMPIO
======================================================= */
const clienteSchema = new Schema(
  {
    nombreApellido: { type: String, index: true },
    dniCuitCuil: String,
    domicilio: String,
    localidad: String,
    telefonoParticular: String,
    telefonoEmergencia: String,
    domicilioTrabajo: String,
    telefonoTrabajo: String,
    email: String,

    /* ===== SISTEMA NUEVO REAL ===== */
    cocheras: [clienteCocheraSchema],

    /* ===== RELACIONES ===== */
    vehiculos: [{ type: Schema.Types.ObjectId, ref: "Vehiculo" }],
    abonos: [{ type: Schema.Types.ObjectId, ref: "Abono" }],
    movimientos: [{ type: Schema.Types.ObjectId, ref: "MovimientoCliente" }],

    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

clienteSchema.index({ nombreApellido: 1 });
clienteSchema.index({ dniCuitCuil: 1 });

module.exports = mongoose.model("Cliente", clienteSchema);
