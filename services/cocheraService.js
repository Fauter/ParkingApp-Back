// services/cocheraService.js
/* eslint-disable no-console */
const Cochera = require("../models/Cochera");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");
const mongoose = require("mongoose");

const {
  Types: { ObjectId },
} = mongoose;

function normTipo(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "fija") return "Fija";
  if (v === "movil" || v === "móvil") return "Móvil";
  return "";
}

function normPiso(raw) {
  return String(raw || "").trim();
}

function normExclusiva(raw, tipo) {
  if (tipo !== "Fija") return false;
  const s = String(raw ?? "").trim().toLowerCase();
  return ["true", "1", "si", "sí", "yes", "y"].includes(s);
}

/* =======================================================
   ✔ ensureCocheraInterno (NO HTTP)
======================================================= */
async function ensureCocheraInterno({ clienteId, tipo, piso, exclusiva, session }) {
  const cli = await Cliente.findById(clienteId).session(session);
  if (!cli) throw new Error("Cliente no encontrado");

  const tipoNorm = normTipo(tipo) || "Móvil";
  const pisoNorm = normPiso(piso);
  const exclusivaNorm = normExclusiva(exclusiva, tipoNorm);

  let coch = await Cochera.findOne({
    cliente: clienteId,
    tipo: tipoNorm,
    piso: pisoNorm,
    exclusiva: exclusivaNorm,
  }).session(session);

  if (coch) return coch;

  coch = new Cochera({
    cliente: clienteId,
    tipo: tipoNorm,
    piso: pisoNorm,
    exclusiva: exclusivaNorm,
    vehiculos: [],
  });

  await coch.save({ session });
  return coch;
}

/* =======================================================
   ✔ asignarVehiculoInterno (NO HTTP)
======================================================= */
async function asignarVehiculoInterno({ cocheraId, vehiculoId, session }) {
  const coch = await Cochera.findById(cocheraId).session(session);
  if (!coch) throw new Error("Cochera no encontrada");

  const veh = await Vehiculo.findById(vehiculoId).session(session);
  if (!veh) throw new Error("Vehículo no encontrado");

  const clienteId = coch.cliente;

  // 🔥 limpiar si estaba en otra cochera
  if (veh.cocheraId && String(veh.cocheraId) !== String(cocheraId)) {
    await Cochera.updateOne(
      { _id: veh.cocheraId },
      { $pull: { vehiculos: vehiculoId } },
      { session },
    );
  }

  // vincular vehículo
  veh.cocheraId = cocheraId;
  veh.cliente = clienteId;
  await veh.save({ session });

  // vincular cochera
  await Cochera.updateOne(
    { _id: cocheraId },
    { $addToSet: { vehiculos: vehiculoId } },
    { session },
  );

  // vincular cliente
  await Cliente.updateOne(
    { _id: clienteId },
    { $addToSet: { vehiculos: vehiculoId } },
    { session },
  );

  return Cochera.findById(cocheraId)
    .populate("vehiculos", "_id patente")
    .session(session);
}

module.exports = {
  ensureCocheraInterno,
  asignarVehiculoInterno,
};
