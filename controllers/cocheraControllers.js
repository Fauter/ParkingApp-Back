/* eslint-disable no-console */
const mongoose = require("mongoose");
const Cochera = require("../models/Cochera");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");
const Abono = require("../models/Abono");

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
  return ["true", "1", "si", "sí", "yes", "y"].includes(s);
}

/* =======================================================
   🅿️ ENSURE COCHERA (IDEMPOTENTE)
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

    let coch = await Cochera.findOne({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
    });

    if (coch) {
      return res.json({
        message: "Cochera existente reutilizada",
        data: coch,
        cocheraId: coch._id,
      });
    }

    coch = new Cochera({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
      vehiculos: [],
    });

    await coch.save();

    // registrar en cliente.cocheras[]
    await Cliente.updateOne(
      { _id: clienteId },
      { $push: { cocheras: { cocheraId: coch._id } } }
    );

    return res.status(201).json({
      message: "Cochera creada",
      data: coch,
      cocheraId: coch._id,
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
      return res.json({ message: "Cochera ya existía", data: existente });

    const nueva = new Cochera({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
      vehiculos: [],
    });

    await nueva.save();

    await Cliente.updateOne(
      { _id: clienteId },
      { $push: { cocheras: { cocheraId: nueva._id } } }
    );

    res.status(201).json({ message: "Cochera creada", data: nueva });
  } catch (err) {
    console.error("Error creando cochera:", err);
    res.status(500).json({ message: "Error interno", error: err.message });
  }
};

/* =======================================================
   OBTENER COCHERAS
======================================================= */
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

/* =======================================================
   PATCH / PUT — NO DESTRUCTIVO
======================================================= */
exports.actualizarCochera = async (req, res) => {
  try {
    const { id } = req.params;

    const coch = await Cochera.findById(id);
    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    // Campos entrantes → SOLO se usan si están definidos Y no son vacíos destructivos
    const incoming = req.body;

    // PROTECCIÓN TOTAL:

    // 1) cliente NUNCA se actualiza desde aquí
    if ("cliente" in incoming) delete incoming.cliente;

    // 2) vehiculos JAMÁS se pisa desde un PATCH general
    if ("vehiculos" in incoming) delete incoming.vehiculos;

    // 3) normalización condicionada
    const tipoNorm =
      incoming.tipo !== undefined && incoming.tipo !== ""
        ? normCochera(incoming.tipo)
        : coch.tipo;

    const pisoNorm =
      incoming.piso !== undefined && incoming.piso !== ""
        ? normPiso(incoming.piso)
        : coch.piso;

    const exclNorm =
      incoming.exclusiva !== undefined
        ? normExclusiva(incoming.exclusiva, tipoNorm)
        : coch.exclusiva;

    // Validación anti-duplicado
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
        existenteId: existe._id,
      });
    }

    const pisoViejo = coch.piso;
    const tipoViejo = coch.tipo;

    coch.tipo = tipoNorm;
    coch.piso = pisoNorm;
    coch.exclusiva = exclNorm;
    await coch.save();

    // actualizar en cliente.cocheras[]
    await Cliente.updateOne(
      { _id: coch.cliente, "cocheras.cocheraId": coch._id },
      {
        $set: {
          "cocheras.$.piso": coch.piso,
          "cocheras.$.cochera": coch.tipo,
          "cocheras.$.exclusiva": coch.exclusiva,
        },
      }
    );

    // sincronizar vehículos
    await Vehiculo.updateMany(
      { cocheraId: coch._id },
      { $set: { cocheraId: coch._id, cliente: coch.cliente } }
    );

    // actualizar abonos vinculados
    await Abono.updateMany(
      { cliente: coch.cliente, cochera: tipoViejo, piso: pisoViejo },
      { $set: { cochera: coch.tipo, piso: coch.piso, exclusiva: coch.exclusiva } }
    );

    const cocheraActualizada = await Cochera.findById(coch._id)
      .populate("cliente", "nombreApellido")
      .populate("vehiculos", "_id patente")
      .lean();

    return res.json({
      message: "Cochera actualizada + sincronizada",
      data: cocheraActualizada,
      cocheraId: coch._id,
    });
  } catch (err) {
    console.error("Error al actualizar cochera:", err);
    return res.status(500).json({
      message: "Error al actualizar cochera",
      error: err.message,
    });
  }
};

/* =======================================================
   ELIMINAR
======================================================= */
exports.eliminarCochera = async (req, res) => {
  try {
    const { id } = req.params;
    const coch = await Cochera.findById(id);
    if (!coch) return res.status(404).json({ message: "Cochera no encontrada" });

    await Vehiculo.updateMany(
      { cocheraId: id },
      { $unset: { cocheraId: "" } }
    );

    await Cliente.updateOne(
      { _id: coch.cliente },
      { $pull: { cocheras: { cocheraId: id } } }
    );

    await coch.deleteOne();

    res.json({ message: "Cochera eliminada" });
  } catch (err) {
    res.status(500).json({ message: "Error al eliminar cochera", error: err.message });
  }
};

exports.eliminarTodasLasCocheras = async (_req, res) => {
  try {
    await Cochera.deleteMany({});
    await Cliente.updateMany({}, { $set: { cocheras: [] } });
    res.status(200).json({ message: "Todas las cocheras eliminadas" });
  } catch (err) {
    console.error("Error al eliminar todas las cocheras:", err);
    res.status(500).json({
      message: "Error al eliminar todas las cocheras",
      error: err.message,
    });
  }
};

/* =======================================================
   🚗 VEHÍCULO ↔ COCHERA
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

    if (veh.cocheraId && String(veh.cocheraId) !== String(cocheraId)) {
      await Cochera.updateOne(
        { _id: veh.cocheraId },
        { $pull: { vehiculos: vehiculoId } }
      );
    }

    veh.cocheraId = cocheraId;
    veh.cliente = cliId;
    await veh.save();

    await Cochera.updateOne(
      { _id: cocheraId },
      { $addToSet: { vehiculos: vehiculoId } }
    );

    await Cliente.updateOne(
      { _id: cliId },
      { $addToSet: { vehiculos: vehiculoId } }
    );

    const cochFinal = await Cochera.findById(cocheraId)
      .populate("vehiculos", "_id patente");

    return res.json({
      message: "Vehículo asignado correctamente",
      data: cochFinal,
    });
  } catch (err) {
    console.error("Error asignando vehículo:", err);
    res.status(500).json({ message: "Error asignando vehículo", error: err.message });
  }
};

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
      .populate("vehiculos", "_id patente");

    res.json({ message: "Vehículo removido", data: cochFinal });
  } catch (err) {
    res.status(500).json({ message: "Error removiendo vehículo", error: err.message });
  }
};
