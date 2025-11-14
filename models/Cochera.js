const mongoose = require("mongoose");
const { Schema } = mongoose;

const cocheraSchema = new Schema(
  {
    cliente: { type: Schema.Types.ObjectId, ref: "Cliente", required: true },

    tipo: { type: String, enum: ["Fija", "Móvil", ""], default: "" },
    exclusiva: { type: Boolean, default: false },
    piso: { type: String, default: "" },

    // Vehículos asociados
    vehiculos: [{ type: Schema.Types.ObjectId, ref: "Vehiculo" }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Cochera", cocheraSchema);
