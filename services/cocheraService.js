// services/cocheraService.js
/* eslint-disable no-console */
const Cochera = require("../models/Cochera");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");
const mongoose = require("mongoose");

const {
  Types: { ObjectId },
} = mongoose;

// =======================================================
// 🔥 Outbox interno (UPDATE idempotente de cochera)
// =======================================================
async function registrarOutboxCocheraInterna(doc) {
  try {
    const Outbox = require("../models/Outbox");

    const id = String(doc._id || "");
    if (!id) {
      console.warn("[cocheras] registrarOutboxCocheraInterna sin _id, skip");
      return;
    }

    await Outbox.create({
      // ⚠️ Acá tiene que ser UPDATE, no alta nueva
      method: "PATCH",
      route: `/api/cocheras/${id}`,
      collection: "cocheras",
      document: {
        _id: id,
        // el modelo se llama 'cliente' (ObjectId), no 'clienteId'
        cliente: String(doc.cliente || ""),
        tipo: doc.tipo,
        piso: doc.piso,
        exclusiva: doc.exclusiva,
        vehiculos: (doc.vehiculos || []).map((v) => String(v)),
      },
      params: { id },
      query: {},
      status: "pending",
      createdAt: new Date(),
    });

    console.log(`[cocheras] ✔ Outbox PATCH generado para cochera: ${id}`);
  } catch (e) {
    console.error("[cocheras] ❌ Error generando outbox interno:", e.message);
  }
}

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

// =======================================================
// 🚫 NO MÁS DUPLICADOS — 1 cochera por (tipo,piso,exclusiva)
// cliente ya NO forma parte del filtro
// =======================================================
async function ensureCocheraInterno({ clienteId, tipo, piso, exclusiva, session }) {
  const tipoNorm = normTipo(tipo) || "Móvil";
  const pisoNorm = normPiso(piso);
  const exclusivaNorm = normExclusiva(exclusiva, tipoNorm);

  // 🔎 filtro SIN cliente — evita duplicar cocheras
  const filter = {
    cliente: clienteId,
    tipo: tipoNorm,
    piso: pisoNorm,
    exclusiva: exclusivaNorm
  };

  // upsert atómico, sin duplicados
  let coch = await Cochera.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        tipo: tipoNorm,
        piso: pisoNorm,
        exclusiva: exclusivaNorm,
        cliente: clienteId,
        vehiculos: []
      }
    },
    { new: true, upsert: true, session }
  );

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

  // vincular cochera + cliente del vehículo
  await Cochera.updateOne(
    { _id: cocheraId },
    {
      $addToSet: { vehiculos: vehiculoId },
      $set: { cliente: clienteId }   // actualizo dueño si antes era null
    },
    { session }
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
  registrarOutboxCocheraInterna
};
