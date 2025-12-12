/* eslint-disable no-console */
const mongoose = require("mongoose");
const Cochera = require("../models/Cochera");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");
const Abono = require("../models/Abono");

const {
  Types: { ObjectId },
} = mongoose;

// (el outbox de cocheras para rutas HTTP ahora lo maneja offlineMiddleware.
//  Este helper interno ya no es necesario y se eliminó.)

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
    // ✅ aceptar tanto clienteId como cliente
    const rawClienteId = req.body.clienteId ?? req.body.cliente;
    const { tipo, piso, exclusiva } = req.body;

    if (!rawClienteId) {
      return res.status(400).json({ message: "clienteId es obligatorio" });
    }

    // ✅ castear a ObjectId si aplica
    const clienteId = ObjectId.isValid(String(rawClienteId))
      ? new ObjectId(String(rawClienteId))
      : rawClienteId;

    const cli = await Cliente.findById(clienteId);
    if (!cli) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const tipoNorm = normCochera(tipo) || "Móvil";
    const pisoNorm = tipoNorm === "Fija" ? normPiso(piso) : "";
    const exclusivaNorm =
      tipoNorm === "Fija" ? normExclusiva(exclusiva, tipoNorm) : false;

    let coch = await Cochera.findOne({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
    });

    if (coch) {
      // 👇 IMPORTANTE: también saneamos Cliente.cocheras para no duplicar
      await Cliente.updateOne(
        {
          _id: clienteId,
          "cocheras.cocheraId": { $ne: coch._id },
        },
        {
          $push: { cocheras: { cocheraId: coch._id } },
        }
      );

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

    // 👇 Misma estrategia que en ensureCocheraInterno: no duplicar subdoc
    await Cliente.updateOne(
      {
        _id: clienteId,
        "cocheras.cocheraId": { $ne: coch._id },
      },
      {
        $push: { cocheras: { cocheraId: coch._id } },
      }
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
    // ✅ aceptar tanto clienteId como cliente
    const rawClienteId = req.body.clienteId ?? req.body.cliente;
    const { tipo, piso, exclusiva } = req.body;

    if (!rawClienteId) {
      return res.status(400).json({ message: "clienteId es obligatorio" });
    }

    const clienteId = ObjectId.isValid(String(rawClienteId))
      ? new ObjectId(String(rawClienteId))
      : rawClienteId;

    const cliente = await Cliente.findById(clienteId);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const tipoNorm = normCochera(tipo) || "Móvil";
    const pisoNorm = normPiso(piso);
    const exclusivaNorm = normExclusiva(exclusiva, tipoNorm);

    const existente = await Cochera.findOne({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
    });

    if (existente) {
      // 👇 Igual que en ensure: si ya existe, nos aseguramos de que esté en cliente.cocheras sin duplicar
      await Cliente.updateOne(
        {
          _id: clienteId,
          "cocheras.cocheraId": { $ne: existente._id },
        },
        {
          $push: { cocheras: { cocheraId: existente._id } },
        }
      );

      return res.json({ message: "Cochera ya existía", data: existente });
    }

    const nueva = new Cochera({
      cliente: clienteId,
      tipo: tipoNorm,
      piso: pisoNorm,
      exclusiva: exclusivaNorm,
      vehiculos: [],
    });

    await nueva.save();

    await Cliente.updateOne(
      {
        _id: clienteId,
        "cocheras.cocheraId": { $ne: nueva._id },
      },
      {
        $push: { cocheras: { cocheraId: nueva._id } },
      }
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

    const incoming = req.body;

    if ("cliente" in incoming) delete incoming.cliente;
    if ("vehiculos" in incoming) delete incoming.vehiculos;

    const tipoNorm =
      incoming.tipo !== undefined && incoming.tipo !== ""
        ? normCochera(incoming.tipo)
        : coch.tipo;

    const pisoNorm =
      tipoNorm === "Móvil"
        ? ""
        : incoming.piso !== undefined
          ? normPiso(incoming.piso || "")
          : coch.piso;

    // 👇 Normalizamos "exclusiva" igual que en ensure/servicio
    // - Si viene en el body → usamos eso
    // - Si NO viene → heredamos el valor actual de la cochera
    let exclusivaSource;
    if ("exclusiva" in incoming) {
      exclusivaSource = incoming.exclusiva;
    } else {
      exclusivaSource = coch.exclusiva;
    }

    const exclNorm =
      tipoNorm === "Fija"
        ? normExclusiva(exclusivaSource, tipoNorm)
        : false;

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

    await Vehiculo.updateMany(
      { cocheraId: coch._id },
      { $set: { cocheraId: coch._id, cliente: coch.cliente } }
    );

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
    console.log("==== removerVehiculo() ====");
    console.log("BODY:", req.body);

    const { cocheraId, vehiculoId } = req.body;

    if (!cocheraId || !String(vehiculoId).trim()) {
      return res
        .status(400)
        .json({ message: "cocheraId y vehiculoId obligatorios" });
    }

    // 1) Buscar cochera y vehículo reales
    const coch = await Cochera.findById(cocheraId);
    if (!coch) {
      return res.status(404).json({ message: "Cochera no encontrada" });
    }

    const veh = await Vehiculo.findById(vehiculoId);
    if (!veh) {
      return res.status(404).json({ message: "Vehículo no encontrado" });
    }

    // ⚠️ IMPORTANTE:
    // Priorizar siempre coch.cliente (ObjectId / string limpio) sobre veh.cliente (que puede venir populado)
    const rawCli = coch.cliente || veh.cliente || null;
    let cliIdSafe = null;

    if (rawCli) {
      // Si viene documento populado (tiene _id)
      if (rawCli._id) {
        cliIdSafe = rawCli._id;
      } else {
        const asStr = String(rawCli);
        if (ObjectId.isValid(asStr)) {
          cliIdSafe = new ObjectId(asStr);
        } else {
          cliIdSafe = null; // basura → no lo usamos
        }
      }
    }

    console.log("[removerVehiculo] rawCli:", rawCli);
    console.log("[removerVehiculo] cliIdSafe:", cliIdSafe);

    console.log("COCHERA ANTES:", JSON.stringify(coch.toObject(), null, 2));

    // 2) Desactivar abonos activos asociados a ESTE vehículo (del mismo cliente)
    let abonosDesactivados = 0;
    if (cliIdSafe) {
      const vehIdObj = veh._id;
      const vehIdStr = String(veh._id);

      const abonoFilter = {
        cliente: cliIdSafe,
        activo: true,
        $or: [
          { vehiculo: vehIdObj }, // ObjectId normal
          { vehiculo: vehIdStr }, // legacy string
        ],
      };

      console.log("[removerVehiculo] abonoFilter:", abonoFilter);

      const abonosAntes = await Abono.find(abonoFilter)
        .select("_id fechaExpiracion")
        .lean();

      const abonosIds = abonosAntes.map((a) => a._id);

      if (abonosIds.length) {
        const upd = await Abono.updateMany(
          { _id: { $in: abonosIds } },
          {
            $set: {
              activo: false,
              updatedAt: new Date(),
            },
          }
        );
        abonosDesactivados =
          upd?.modifiedCount ?? upd?.nModified ?? 0;
      }

      console.log(
        "[removerVehiculo] abonos desactivados para vehiculo:",
        abonosDesactivados
      );
    } else {
      console.warn(
        "[removerVehiculo] cliIdSafe nulo: se omite desactivar abonos por cliente."
      );
    }

    // 3) Sacar el vehículo de la cochera
    await Cochera.updateOne(
      { _id: coch._id },
      { $pull: { vehiculos: veh._id } }
    );

    // 4) Sacar el vehículo del cliente (si lo tenía)
    if (cliIdSafe) {
      await Cliente.updateOne(
        { _id: cliIdSafe },
        {
          $pull: { vehiculos: veh._id },
          $set: { updatedAt: new Date() },
        }
      );
    }

    // 5) Desasociar completamente en el propio vehículo
    veh.cocheraId = undefined;
    veh.cliente = null;
    veh.abonado = false;
    veh.abono = null;       // limpio puntero al abono
    veh.abonoExpira = null; // limpio fecha de expiración
    await veh.save();

    // 6) Recalcular estado del cliente (abonado / finAbono) si tenemos cliIdSafe
    if (cliIdSafe) {
      const activos = await Abono.find({
        cliente: cliIdSafe,
        activo: true,
      })
        .select("fechaExpiracion")
        .lean();

      let finAbono = null;
      if (activos.length) {
        const maxTs = Math.max(
          ...activos.map((a) =>
            a.fechaExpiracion
              ? new Date(a.fechaExpiracion).getTime()
              : 0
          )
        );
        finAbono = maxTs > 0 ? new Date(maxTs) : null;
      }

      await Cliente.updateOne(
        { _id: cliIdSafe },
        {
          $set: {
            abonado: activos.length > 0,
            finAbono,
            updatedAt: new Date(),
          },
        }
      );
    }

    const cochFinal = await Cochera.findById(coch._id)
      .populate("vehiculos", "_id patente")
      .lean();

    console.log("COCHERA DESPUÉS:", JSON.stringify(cochFinal, null, 2));

    return res.json({
      message:
        "Vehículo removido de la cochera, del cliente y abonos asociados desactivados",
      data: cochFinal,
      detalle: {
        abonosDesactivados,
      },
    });
  } catch (err) {
    console.error("Error removiendo vehículo:", err);
    return res.status(500).json({
      message: "Error removiendo vehículo",
      error: err.message,
    });
  }
};

