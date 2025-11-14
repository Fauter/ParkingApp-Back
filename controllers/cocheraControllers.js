/* eslint-disable no-console */
const mongoose = require("mongoose");
const Cochera = require("../models/Cochera");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");

const {
  Types: { ObjectId },
} = mongoose;

/* =======================================================
   HELPERS – NORMALIZACIÓN A PRUEBA DE BASURA
======================================================= */

function normCochera(raw) {
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
  if (["true", "1", "si", "sí", "yes", "y"].includes(s)) return true;

  return false;
}

/* =======================================================
   🅿️ ENSURE COCHERA (IDEMPOTENTE y 100% Estable)
======================================================= */

exports.ensureCochera = async (req, res) => {
  try {
    const { clienteId, tipo, piso, exclusiva } = req.body;

    if (!clienteId)
      return res.status(400).json({ message: "clienteId es obligatorio" });

    const cli = await Cliente.findById(clienteId);
    if (!cli)
      return res.status(404).json({ message: "Cliente no encontrado" });

    const tipoNorm = normCochera(tipo) || "Móvil";
    const pisoNorm = normPiso(piso);
    const exclusivaNorm = normExclusiva(exclusiva, tipoNorm);

    // Buscar cochera idéntica
    let coch = await Cochera.findOne({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
    });

    if (coch) {
      return res.json({
        message: "Cochera existente reutilizada",
        cocheraId: coch._id,
        cochera: coch,
      });
    }

    // Crear nueva
    coch = new Cochera({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
      vehiculos: [],
    });

    await coch.save();

    return res.status(201).json({
      message: "Cochera creada",
      cocheraId: coch._id,
      cochera: coch,
    });
  } catch (err) {
    console.error("Error ensureCochera:", err);
    return res.status(500).json({ message: "Error interno", error: err.message });
  }
};

/* =======================================================
   CRUD
======================================================= */

exports.crearCochera = async (req, res) => {
  try {
    const { clienteId, tipo, piso, exclusiva } = req.body;

    if (!clienteId)
      return res.status(400).json({ message: "clienteId es obligatorio" });

    const cliente = await Cliente.findById(clienteId);
    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    const tipoNorm = normCochera(tipo) || "Móvil";
    const pisoNorm = normPiso(piso);
    const exclusivaNorm = normExclusiva(exclusiva, tipoNorm);

    const existente = await Cochera.findOne({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
    });

    if (existente)
      return res.json({ message: "Cochera ya existía", cochera: existente });

    const nueva = new Cochera({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
      vehiculos: [],
    });

    await nueva.save();
    res.status(201).json({ message: "Cochera creada", cochera: nueva });
  } catch (err) {
    console.error("Error creando cochera:", err);
    res.status(500).json({ message: "Error interno", error: err.message });
  }
};

exports.obtenerCocheras = async (_req, res) => {
  try {
    const data = await Cochera.find()
      .populate("cliente", "nombreApellido")
      .populate("vehiculos", "_id patente");

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: "Error al obtener cocheras", error: err.message });
  }
};

exports.obtenerCocheraPorId = async (req, res) => {
  try {
    const coch = await Cochera.findById(req.params.id)
      .populate("cliente", "nombreApellido")
      .populate("vehiculos", "_id patente");

    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    res.json(coch);
  } catch (err) {
    res.status(500).json({ message: "Error al obtener cochera", error: err.message });
  }
};

exports.obtenerCocherasPorCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;

    const data = await Cochera.find({ cliente: clienteId })
      .populate("cliente", "nombreApellido")
      .populate("vehiculos", "_id patente");

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Error al obtener cocheras del cliente", error: err.message });
  }
};

exports.actualizarCochera = async (req, res) => {
  try {
    const { id } = req.params;
    const { tipo, piso, exclusiva } = req.body;

    const coch = await Cochera.findById(id);
    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    const tipoNorm = tipo !== undefined ? normCochera(tipo) || "Móvil" : coch.tipo;
    const pisoNorm = piso !== undefined ? normPiso(piso) : coch.piso;
    const exclNorm = exclusiva !== undefined ? normExclusiva(exclusiva, tipoNorm) : coch.exclusiva;

    const existe = await Cochera.findOne({
      cliente: coch.cliente,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclNorm,
      _id: { $ne: coch._id },
    });

    if (existe) {
      return res.status(400).json({
        message: "Ya existe otra cochera con esos datos para este cliente",
        existente: existe._id,
      });
    }

    coch.tipo = tipoNorm;
    coch.piso = pisoNorm;
    coch.exclusiva = exclNorm;

    await coch.save();

    res.json({ message: "Cochera actualizada", cochera: coch });
  } catch (err) {
    res.status(500).json({ message: "Error al actualizar cochera", error: err.message });
  }
};

exports.eliminarCochera = async (req, res) => {
  try {
    const { id } = req.params;
    const coch = await Cochera.findById(id);
    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    await coch.deleteOne();
    res.json({ message: "Cochera eliminada" });
  } catch (err) {
    res.status(500).json({ message: "Error al eliminar cochera", error: err.message });
  }
};

/* =======================================================
   🚗 RELACIÓN VEHÍCULO ↔ COCHERA (BIDIRECCIONAL REAL)
======================================================= */

exports.asignarVehiculo = async (req, res) => {
  try {
    const { cocheraId, vehiculoId } = req.body;

    if (!cocheraId || !vehiculoId)
      return res.status(400).json({ message: "cocheraId y vehiculoId obligatorios" });

    const coch = await Cochera.findById(cocheraId);
    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    const veh = await Vehiculo.findById(vehiculoId);
    if (!veh) return res.status(404).json({ message: "Vehículo no encontrado" });

    const cliId = coch.cliente;

    /* ===================================================
       🧹 1) Si el vehículo está en OTRA cochera → limpiar
    =================================================== */
    if (veh.cocheraId && String(veh.cocheraId) !== String(cocheraId)) {
      console.log(
        `🔄 Corrigiendo: vehículo ${veh._id} estaba en otra cochera ${veh.cocheraId}`
      );

      await Cochera.updateOne(
        { _id: veh.cocheraId },
        { $pull: { vehiculos: vehiculoId } }
      );
    }

    /* ===================================================
       🧲 2) Vincular VEHÍCULO → COCHERA
    =================================================== */
    veh.cocheraId = cocheraId;
    veh.cliente = cliId;
    await veh.save();

    /* ===================================================
       🧲 3) Vincular COCHERA → VEHÍCULO
    =================================================== */
    await Cochera.updateOne(
      { _id: cocheraId },
      { $addToSet: { vehiculos: vehiculoId } }
    );

    /* ===================================================
       🧲 4) Vincular CLIENTE → VEHÍCULO
    =================================================== */
    await Cliente.updateOne(
      { _id: cliId },
      { $addToSet: { vehiculos: vehiculoId } }
    );

    /* ===================================================
       🔍 5) Leer cochera final y devolver
    =================================================== */
    const cochFinal = await Cochera.findById(cocheraId)
      .populate("vehiculos", "_id patente");

    return res.json({
      message: "Vehículo asignado correctamente",
      cochera: cochFinal,
    });

  } catch (err) {
    console.error("Error asignando vehículo a cochera:", err);
    res.status(500).json({ message: "Error asignando vehículo", error: err.message });
  }
};

/* =======================================================
   ❌ REMOVER VEHÍCULO (manteniendo consistencia)
======================================================= */

exports.removerVehiculo = async (req, res) => {
  try {
    const { cocheraId, vehiculoId } = req.body;
    const coch = await Cochera.findById(cocheraId);
    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    await Cochera.updateOne(
      { _id: cocheraId },
      { $pull: { vehiculos: vehiculoId } }
    );

    await Vehiculo.updateOne(
      { _id: vehiculoId },
      { $unset: { cocheraId: "" } }
    );

    const cochFinal = await Cochera.findById(cocheraId)
      .populate("vehiculos");

    res.json({ message: "Vehículo removido", cochera: cochFinal });
  } catch (err) {
    res.status(500).json({ message: "Error removiendo vehículo", error: err.message });
  }
};
