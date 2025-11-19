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

const {
  Types: { ObjectId },
} = mongoose;

/* =======================================================
   HELPERS DE CAST
======================================================= */
function toObjectIdSafe(v) {
  if (!v) return undefined;
  if (v instanceof ObjectId) return v;
  if (typeof v === "string") {
    const s = v.trim();
    return /^[0-9a-fA-F]{24}$/.test(s) ? new ObjectId(s) : undefined;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    if (v.length === 12 || v.length === 24) return new ObjectId(v);
  }
  if (typeof v === "object") {
    if (v._id) return toObjectIdSafe(v._id);
    if (v.id) return toObjectIdSafe(v.id);
    if (v.buffer && typeof v.buffer === "object") {
      try {
        const arr = Object.keys(v.buffer)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => v.buffer[k]);
        const buf = Buffer.from(arr);
        if (buf.length === 12 || buf.length === 24) return new ObjectId(buf);
      } catch (_) {}
    }
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
   NORMALIZADORES
======================================================= */
function normCochera(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "fija") return "Fija";
  if (v === "movil" || v === "móvil") return "Móvil";
  return "";
}
function normExclusiva(raw, cochera) {
  return cochera === "Fija" && Boolean(raw);
}
function normPiso(raw) {
  return String(raw || "").trim();
}

/* =======================================================
   FECHAS AUXILIARES
======================================================= */
function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}
function getUltimoDiaMes(baseDate = new Date(), offsetMonths = 0) {
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth() + 1 + offsetMonths;
  const d = new Date(y, m, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

/* =======================================================
   ESTADO DE ABONO
======================================================= */
function deriveEstadoAbono(doc) {
  if (!doc) return doc;
  const now = new Date();
  const obj = doc.toObject ? doc.toObject() : { ...doc };

  let fin = obj.finAbono ? new Date(obj.finAbono) : null;
  if ((!fin || isNaN(fin)) && Array.isArray(obj.abonos) && obj.abonos.length) {
    for (const a of obj.abonos) {
      if (a && a.fechaExpiracion) {
        const f = new Date(a.fechaExpiracion);
        if (!isNaN(f) && (!fin || f > fin)) fin = f;
      }
    }
  }

  if (fin && !isNaN(fin)) {
    obj.finAbono = fin;
    obj.abonado = fin >= now;
  } else {
    obj.abonado = false;
  }
  return obj;
}

/* =======================================================
   🔥 NUEVO: LIMPIAR cocheras[] PARA EL OUTPUT
======================================================= */
function stripCocheras(cliente) {
  if (!cliente) return cliente;

  const obj = cliente.toObject ? cliente.toObject() : { ...cliente };

  if (Array.isArray(obj.cocheras)) {
    obj.cocheras = obj.cocheras.map((c) => ({
      _id: c._id,
      cocheraId: c.cocheraId,
    }));
  }

  return obj;
}

/* =======================================================
   CREAR / ACTUALIZAR (SIN TOCAR cocheras[])
======================================================= */
exports.crearClienteSiNoExiste = async (req, res) => {
  const datos = req.body;
  const { nombreApellido, dniCuitCuil } = datos;

  if (!nombreApellido || !dniCuitCuil) {
    return res.status(400).json({ message: "Campos obligatorios faltantes" });
  }

  try {
    const dni = String(datos.dniCuitCuil || "").trim();
    const email = String(datos.email || "").trim().toLowerCase();
    const nombre = String(nombreApellido || "").trim();

    const cochera = normCochera(datos.cochera);
    const exclusiva = normExclusiva(datos.exclusiva, cochera);
    const piso = normPiso(datos.piso);

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
        email,
        precioAbono: datos.precioAbono || "",

        // retrocompatibilidad
        cochera,
        exclusiva,
        piso,

        // sistema nuevo
        cocheras: [],
      });

      await cliente.save();
      return res.status(201).json(stripCocheras(cliente));
    }

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
      if (datos[k] !== undefined && datos[k] !== null && String(datos[k]).trim() !== "") {
        cliente[k] = String(datos[k]).trim();
      }
    });

    if (datos.cochera !== undefined) {
      cliente.cochera = cochera;
      if (cliente.cochera !== "Fija") cliente.exclusiva = false;
    }
    if (datos.exclusiva !== undefined) {
      cliente.exclusiva = normExclusiva(datos.exclusiva, cliente.cochera);
    }
    if (datos.piso !== undefined) {
      cliente.piso = piso;
    }

    await cliente.save();
    return res.status(200).json(stripCocheras(cliente));
  } catch (err) {
    console.error("Error en crearClienteSiNoExiste:", err);
    res.status(500).json({
      message: "Error al crear/actualizar cliente",
      error: err.message,
    });
  }
};

/* =======================================================
   CONSULTAS
======================================================= */

exports.obtenerClientes = async (_req, res) => {
  try {
    await cleanAllClientesOnce();
    const clientes = await Cliente.find()
      .populate("vehiculos", "_id patente")
      .populate({
        path: "abonos",
        select: "-cliente -vehiculo",
      });

    const out = clientes.map(stripCocheras);
    res.status(200).json(out);
  } catch (err) {
    console.error("Error al obtener clientes:", err);
    res.status(500).json({
      message: "Error al obtener clientes",
      error: err.message,
    });
  }
};

exports.obtenerClientePorNombre = async (req, res) => {
  const { nombreApellido } = req.params;
  try {
    const base = await Cliente.findOne({ nombreApellido }).select("_id").lean();
    if (base?._id) await cleanClienteById(base._id);

    const cliente = await Cliente.findOne({ nombreApellido })
      .populate("vehiculos", "_id patente")
      .populate({
        path: "abonos",
        select: "-cliente -vehiculo",
      });

    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    res.json(stripCocheras(deriveEstadoAbono(cliente)));
  } catch (err) {
    console.error("Error al buscar cliente por nombre:", err);
    res.status(500).json({
      message: "Error al buscar cliente",
      error: err.message,
    });
  }
};

exports.obtenerClientePorId = async (req, res) => {
  const { id } = req.params;
  try {
    await cleanClienteById(id);
    const cliente = await Cliente.findById(id)
      .populate("vehiculos")
      .populate("movimientos")
      .populate({
        path: "abonos",
        select: "-cliente -vehiculo",
      });

    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    res.json(stripCocheras(deriveEstadoAbono(cliente)));
  } catch (err) {
    console.error("Error al obtener cliente por ID:", err);
    res.status(500).json({
      message: "Error al obtener cliente por ID",
      error: err.message,
    });
  }
};

/* =======================================================
   ACCIONES
======================================================= */

exports.marcarClienteComoAbonado = async (req, res) => {
  const { nombreApellido } = req.body;
  if (!nombreApellido) {
    return res.status(400).json({ message: "nombreApellido es obligatorio" });
  }
  try {
    const cliente = await Cliente.findOneAndUpdate(
      { nombreApellido: nombreApellido.trim() },
      { abonado: true },
      { new: true }
    );
    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    res.status(200).json({
      message: "Cliente marcado como abonado",
      cliente: stripCocheras(cliente),
    });
  } catch (err) {
    console.error("Error al marcar cliente como abonado:", err);
    res.status(500).json({
      message: "Error al actualizar cliente",
      error: err.message,
    });
  }
};

exports.actualizarPrecioAbono = async (req, res) => {
  const { id } = req.params;
  const { tipoVehiculo } = req.body;
  try {
    const cliente = await Cliente.findById(id);
    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    if (tipoVehiculo) {
      cliente.precioAbono = tipoVehiculo;
      await cliente.save();
    }

    res.json({ message: "Precio actualizado", cliente: stripCocheras(cliente) });
  } catch (err) {
    console.error("Error al actualizar precio de abono:", err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

exports.desabonarCliente = async (req, res) => {
  const { id } = req.params;
  try {
    const cliente = await Cliente.findByIdAndUpdate(
      id,
      { $set: { abonado: false, finAbono: null } },
      { new: true }
    ).populate("vehiculos abonos movimientos");

    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    if (cliente.vehiculos?.length) {
      await Promise.all(
        cliente.vehiculos.map(async (vehiculo) => {
          vehiculo.abonado = false;
          vehiculo.abono = undefined;
          await vehiculo.save();
        })
      );
    }

    if (cliente.abonos?.length) {
      await Promise.all(
        cliente.abonos.map(async (abono) => {
          abono.activo = false;
          await abono.save();
        })
      );
    }

    res.json({ message: "Cliente desabonado", cliente: stripCocheras(cliente) });
  } catch (err) {
    console.error("Error al desabonar cliente:", err);
    res.status(500).json({
      message: "Error al desabonar cliente",
      error: err.message,
    });
  }
};

/* =======================================================
   RENOVAR
======================================================= */

exports.renovarAbono = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { precio, metodoPago, factura, operador, patente, tipoVehiculo } =
      req.body;
    const mesesAbonar = clampInt(req.body?.mesesAbonar ?? 1, 1, 12);

    if (!precio || isNaN(precio)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Precio inválido" });
    }
    if (!metodoPago) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Método de pago requerido" });
    }
    if (!tipoVehiculo) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Tipo de vehículo requerido" });
    }

    const cliente = await Cliente.findById(id).populate("abonos").session(session);
    if (!cliente) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const hoy = new Date();
    const ultimoDia = getUltimoDiaMes(hoy, mesesAbonar - 1);

    if (cliente.abonos?.length) {
      await Promise.all(
        cliente.abonos.map(async (abono) => {
          abono.activo = true;
          abono.fechaExpiracion = ultimoDia;
          await abono.save({ session });
        })
      );
    }

    if (patente) {
      const vehiculo = await Vehiculo.findOne({ patente }).session(session);
      if (vehiculo) {
        vehiculo.abonado = true;
        await vehiculo.save({ session });
      }
    }

    cliente.abonado = true;
    cliente.finAbono = ultimoDia;
    cliente.precioAbono = tipoVehiculo;
    cliente.updatedAt = new Date();

    await cliente.save({ session });

    const movimiento = new Movimiento({
      cliente: id,
      descripcion: `Renovación abono ${tipoVehiculo} (${mesesAbonar} mes/es)`,
      monto: precio,
      tipoVehiculo,
      operador: operador || "Sistema",
      patente: patente || "No especificada",
      metodoPago,
      factura: factura || "CC",
      tipoTarifa: "abono",
    });
    await movimiento.save({ session });

    const movimientoCliente = new MovimientoCliente({
      cliente: id,
      descripcion: `Renovación abono ${tipoVehiculo} (${mesesAbonar} mes/es)`,
      monto: precio,
      tipoVehiculo,
      operador: operador || "Sistema",
      patente: patente || "No especificada",
      fecha: new Date(),
    });
    await movimientoCliente.save({ session });

    cliente.movimientos.push(movimientoCliente._id);
    await cliente.save({ session });

    await session.commitTransaction();
    session.endSession();

    const clienteActualizado = await Cliente.findById(id).populate("abonos");
    res.status(200).json({
      message: "Abono renovado",
      cliente: stripCocheras(clienteActualizado),
      movimiento,
      movimientoCliente,
      mesesAbonar,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error al renovar abono:", error);
    res.status(500).json({
      message: "Error al renovar abono",
      error: error.message,
    });
  }
};

/* =======================================================
   ELIMINAR
======================================================= */
exports.eliminarTodosLosClientes = async (_req, res) => {
  try {
    await Cliente.deleteMany({});
    res.status(200).json({ message: "Clientes eliminados" });
  } catch (err) {
    console.error("Error al eliminar clientes:", err);
    res.status(500).json({
      message: "Error al eliminar clientes",
      error: err.message,
    });
  }
};

/* =======================================================
   ACTUALIZAR CLIENTE BÁSICO (SIN TOCAR cocheras[])
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
    const data = {};
    campos.forEach((k) => {
      if (k in req.body) data[k] = req.body[k];
    });

    const cRaw = req.body.cochera !== undefined ? normCochera(req.body.cochera) : undefined;
    const pRaw = req.body.piso !== undefined ? normPiso(req.body.piso) : undefined;
    const eRawPresent = req.body.exclusiva !== undefined;

    let cliente = await Cliente.findById(id);
    if (!cliente) {
      const doc = await Cliente.collection.findOne({ _id: String(id) });
      if (doc) cliente = new Cliente(doc);
    }
    if (!cliente)
      return res.status(404).json({ message: "Cliente no encontrado" });

    Object.keys(data).forEach((k) => {
      cliente[k] = data[k];
    });

    if (cRaw !== undefined) {
      cliente.cochera = cRaw;
      if (cliente.cochera !== "Fija") cliente.exclusiva = false;
    }
    if (eRawPresent) {
      cliente.exclusiva = normExclusiva(req.body.exclusiva, cliente.cochera);
    }
    if (pRaw !== undefined) cliente.piso = pRaw;

    await cliente.save();
    return res.json({ message: "Cliente actualizado", cliente: stripCocheras(cliente) });
  } catch (err) {
    console.error("Error al actualizar cliente básico:", err);
    res.status(500).json({
      message: "Error al actualizar cliente",
      error: err.message,
    });
  }
};
