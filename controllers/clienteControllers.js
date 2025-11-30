/* eslint-disable no-console */
const mongoose = require("mongoose");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");
const Movimiento = require("../models/Movimiento");
const MovimientoCliente = require("../models/MovimientoCliente");
const {
  cleanAllClientesOnce,
  cleanClienteById,
} = require("../services/clienteAbonosService");

/* =======================================================
   HELPERS DE CAST
======================================================= */
function toObjectIdSafe(v) {
  if (!v) return undefined;
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v.trim())) {
    return new mongoose.Types.ObjectId(v.trim());
  }
  return undefined;
}

function getIdAny(x) {
  return (
    toObjectIdSafe(x) ||
    toObjectIdSafe(x && x._id) ||
    toObjectIdSafe(x && x.id) ||
    x
  );
}

/* =======================================================
   🔥 LIMPIAR cocheras[] PARA EL OUTPUT
======================================================= */
function stripCocheras(cliente) {
  if (!cliente) return cliente;
  const obj = cliente.toObject ? cliente.toObject() : { ...cliente };

  if (Array.isArray(obj.cocheras)) {
    obj.cocheras = obj.cocheras.map((c) => ({
      cocheraId: c.cocheraId,
    }));
  }
  return obj;
}

/* =======================================================
   CREAR / ACTUALIZAR CLIENTE
======================================================= */
exports.crearClienteSiNoExiste = async (req, res) => {
  try {
    const datos = req.body;
    const dni = String(datos.dniCuitCuil || "").trim();
    const nombre = String(datos.nombreApellido || "").trim();

    if (!nombre || !dni) {
      return res.status(400).json({ message: "nombreApellido y dniCuitCuil son obligatorios" });
    }

    let cliente = await Cliente.findOne({ dniCuitCuil: dni });

    if (!cliente) {
      cliente = new Cliente({
        nombreApellido: nombre,
        dniCuitCuil: dni,
        domicilio: datos.domicilio || "",
        localidad: datos.localidad || "",
        telefonoParticular: datos.telefonoParticular || "",
        telefonoEmergencia: datos.telefonoEmergencia || "",
        domicilioTrabajo: datos.domicilioTrabajo || "",
        telefonoTrabajo: datos.telefonoTrabajo || "",
        email: String(datos.email || "").toLowerCase(),
        cocheras: []
      });

      await cliente.save();
      return res.status(201).json(stripCocheras(cliente));
    }

    // Update fields if exists
    const campos = [
      "dniCuitCuil",
      "domicilio",
      "localidad",
      "telefonoParticular",
      "telefonoEmergencia",
      "domicilioTrabajo",
      "telefonoTrabajo",
      "email",
      "nombreApellido",
    ];

    campos.forEach((k) => {
      if (datos[k] !== undefined && datos[k] !== null) {
        cliente[k] = String(datos[k]).trim();
      }
    });

    await cliente.save();
    return res.status(200).json(stripCocheras(cliente));
  } catch (err) {
    console.error("Error en crearClienteSiNoExiste:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* =======================================================
   CONSULTAS (versión sin cleaner)
======================================================= */
exports.obtenerClientes = async (_req, res) => {
  try {
    // cleaner desactivado
    const clientes = await Cliente.find()
      .populate("vehiculos", "_id patente")
      .populate("abonos");

    const out = clientes.map(stripCocheras);
    res.status(200).json(out);
  } catch (err) {
    console.error("Error al obtener clientes:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

exports.obtenerClientePorNombre = async (req, res) => {
  try {
    const { nombreApellido } = req.params;

    // cleaner desactivado
    const cliente = await Cliente.findOne({ nombreApellido })
      .populate("vehiculos")
      .populate("movimientos")
      .populate("abonos");

    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    res.json(stripCocheras(cliente));
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

exports.obtenerClientePorId = async (req, res) => {
  try {
    const { id } = req.params;

    // cleaner desactivado
    const cliente = await Cliente.findById(id)
      .populate("vehiculos")
      .populate("movimientos")
      .populate("abonos");

    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    res.json(stripCocheras(cliente));
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* =======================================================
   ACTUALIZAR CLIENTE BÁSICO
======================================================= */
exports.actualizarClienteBasico = async (req, res) => {
  try {
    const { id } = req.params;
    const campos = [
      "nombreApellido",
      "dniCuitCuil",
      "domicilio",
      "localidad",
      "telefonoParticular",
      "telefonoEmergencia",
      "domicilioTrabajo",
      "telefonoTrabajo",
      "email",
    ];

    let cliente = await Cliente.findById(id);
    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    campos.forEach((k) => {
      if (k in req.body) cliente[k] = req.body[k];
    });

    await cliente.save();
    res.json({ message: "Cliente actualizado", cliente: stripCocheras(cliente) });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* =======================================================
   BORRAR TODOS
======================================================= */
exports.eliminarTodosLosClientes = async (_req, res) => {
  try {
    await Cliente.deleteMany({});
    res.status(200).json({ message: "Clientes eliminados" });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};
