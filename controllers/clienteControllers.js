// controllers/clienteControllers.js
const mongoose = require("mongoose");
const Cliente = require("../models/Cliente");
const Vehiculo = require("../models/Vehiculo");
const Movimiento = require("../models/Movimiento");
const MovimientoCliente = require("../models/MovimientoCliente");

const {
  Types: { ObjectId },
} = mongoose;

// === Cast robusto para ObjectId (string, Buffer, {buffer:{…}}, {_id}, ObjectId)
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
  return toObjectIdSafe(x) || toObjectIdSafe(x && x._id) || toObjectIdSafe(x && x.id) || x;
}

// ---------- Helpers de normalización ----------
function normCochera(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "fija") return "Fija";
  if (v === "movil" || v === "móvil") return "Móvil";
  return ""; // vacío si no vino/indefinida
}
function normExclusiva(raw, cochera) {
  // Solo permitimos exclusiva=true si la cochera es Fija
  return cochera === "Fija" && Boolean(raw);
}
function normPiso(raw) {
  return String(raw || "").trim();
}

// === Fechas auxiliares ===
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

// === Derivar estado de abono por fecha (no persiste, solo adorna la respuesta) ===
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

exports.crearClienteSiNoExiste = async (req, res) => {
  const datos = req.body;
  const { nombreApellido, dniCuitCuil } = datos;

  if (
    !nombreApellido ||
    typeof nombreApellido !== "string" ||
    nombreApellido.trim() === ""
  ) {
    return res
      .status(400)
      .json({ message: 'El campo "nombreApellido" es obligatorio.' });
  }
  if (
    !dniCuitCuil ||
    typeof dniCuitCuil !== "string" ||
    dniCuitCuil.trim() === ""
  ) {
    return res
      .status(400)
      .json({ message: 'El campo "dniCuitCuil" es obligatorio.' });
  }

  try {
    const dni = String(datos.dniCuitCuil || "").trim();
    const email = String(datos.email || "").trim().toLowerCase();
    const nombre = String(nombreApellido || "").trim();

    // Normalización de los nuevos campos
    const cochera = normCochera(datos.cochera);
    const exclusiva = normExclusiva(datos.exclusiva, cochera);
    const piso = normPiso(datos.piso);

    // 🔎 buscar por DNI o email; si nada, fallback a nombre
    let cliente = await Cliente.findOne({
      $or: [{ dniCuitCuil: dni }, ...(email ? [{ email }] : []), { nombreApellido: nombre }],
    });

    if (!cliente) {
      cliente = new Cliente({
        nombreApellido: nombre,
        dniCuitCuil: dni,
        domicilio: String(datos.domicilio || ""),
        localidad: String(datos.localidad || ""),
        telefonoParticular: String(datos.telefonoParticular || ""),
        telefonoEmergencia: String(datos.telefonoEmergencia || ""),
        domicilioTrabajo: String(datos.domicilioTrabajo || ""),
        telefonoTrabajo: String(datos.telefonoTrabajo || ""),
        email,
        precioAbono: String(datos.precioAbono || ""),
        // NUEVO: guardamos estado de cochera del cliente
        cochera,
        exclusiva,
        piso,
      });
      await cliente.save();
      return res.status(201).json(cliente);
    }

    // si existe, actualizar datos básicos (ahora también cochera/exclusiva/piso)
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
      if (
        datos[k] !== undefined &&
        datos[k] !== null &&
        String(datos[k]).trim() !== ""
      ) {
        cliente[k] = String(datos[k]).trim();
      }
    });

    // Actualizamos cochera/exclusiva/piso si vinieron
    if (datos.cochera !== undefined) {
      cliente.cochera = cochera;
      // Si cochera cambió a no-Fija, forzamos exclusiva=false
      if (cliente.cochera !== "Fija") cliente.exclusiva = false;
    }
    if (datos.exclusiva !== undefined) {
      cliente.exclusiva = normExclusiva(datos.exclusiva, cliente.cochera);
    }
    if (datos.piso !== undefined) {
      cliente.piso = piso;
    }

    await cliente.save();
    return res.status(200).json(cliente);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al crear/actualizar cliente", error: err.message });
  }
};

exports.obtenerClientes = async (_req, res) => {
  try {
    const clientes = await Cliente.find()
      .populate("vehiculos", "_id patente")
      .populate("movimientos")
      .populate("abonos");
    const out = clientes.map(deriveEstadoAbono);
    res.status(200).json(out);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al obtener clientes", error: err.message });
  }
};

exports.obtenerClientePorNombre = async (req, res) => {
  const { nombreApellido } = req.params;
  try {
    const cliente = await Cliente.findOne({ nombreApellido })
      .populate("vehiculos", "_id patente")
      .populate("abonos"); // 👈 necesario para derivar por fecha si finAbono es null
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(deriveEstadoAbono(cliente));
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al buscar cliente", error: err.message });
  }
};

exports.obtenerClientePorId = async (req, res) => {
  const { id } = req.params;
  try {
    const cliente = await Cliente.findById(id)
      .populate("vehiculos")
      .populate("movimientos")
      .populate("abonos");
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(deriveEstadoAbono(cliente));
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al buscar cliente por ID", error: err.message });
  }
};

exports.marcarClienteComoAbonado = async (req, res) => {
  const { nombreApellido } = req.body;
  if (
    !nombreApellido ||
    typeof nombreApellido !== "string" ||
    nombreApellido.trim() === ""
  ) {
    return res
      .status(400)
      .json({ message: 'El campo "nombreApellido" es obligatorio.' });
  }
  try {
    const cliente = await Cliente.findOneAndUpdate(
      { nombreApellido: nombreApellido.trim() },
      { abonado: true },
      { new: true }
    );
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado." });
    res
      .status(200)
      .json({ message: "Cliente marcado como abonado.", cliente });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al actualizar cliente", error: err.message });
  }
};

exports.actualizarPrecioAbono = async (req, res) => {
  const { id } = req.params;
  const { tipoVehiculo } = req.body;
  try {
    const cliente = await Cliente.findById(id);
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });
    if (tipoVehiculo) {
      cliente.precioAbono = tipoVehiculo;
      await cliente.save();
      return res.json({
        message: "Precio de abono actualizado correctamente",
        cliente,
      });
    }
    res.json(cliente);
  } catch (err) {
    res.status(500).json({
      message: "Error al actualizar precio de abono",
      error: err.message,
    });
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
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });

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

    res.json({
      message: "Cliente desabonado correctamente",
      cliente: await Cliente.findById(id).populate("vehiculos abonos movimientos"),
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al desabonar cliente", error: err.message });
  }
};

exports.renovarAbono = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { precio, metodoPago, factura, operador, patente, tipoVehiculo } =
      req.body;

    // NUEVO: mesesAbonar para extender fecha
    const mesesAbonar = clampInt(req.body?.mesesAbonar ?? 1, 1, 12);

    // === Permitir actualizar cochera/exclusiva/piso si vienen en la renovación ===
    const cocheraBody = normCochera(req.body.cochera);
    const exclusivaBody =
      req.body.exclusiva !== undefined ? Boolean(req.body.exclusiva) : undefined;
    const pisoBody =
      req.body.piso !== undefined ? normPiso(req.body.piso) : undefined;

    if (!precio || isNaN(precio)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Precio inválido o faltante" });
    }
    if (
      !metodoPago ||
      !["Efectivo", "Transferencia", "Débito", "Crédito", "QR"].includes(
        metodoPago
      )
    ) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Método de pago inválido" });
    }
    if (!tipoVehiculo) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Tipo de vehículo requerido" });
    }

    const cliente = await Cliente.findById(id).populate("abonos").session(session);
    if (!cliente) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const hoy = new Date();
    // ⬇️ Extiende hasta el último día del mes N-ésimo
    const ultimoDiaMesExtendido = getUltimoDiaMes(hoy, mesesAbonar - 1);

    if (cliente.abonos?.length) {
      await Promise.all(
        cliente.abonos.map(async (abono) => {
          abono.activo = true;
          abono.fechaExpiracion = ultimoDiaMesExtendido;
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
    cliente.finAbono = ultimoDiaMesExtendido;
    cliente.precioAbono = tipoVehiculo;
    cliente.updatedAt = new Date();

    // coherencia cochera/exclusiva/piso
    if (cocheraBody !== "") {
      cliente.cochera = cocheraBody;
      if (cliente.cochera !== "Fija") cliente.exclusiva = false;
      if (exclusivaBody !== undefined) {
        cliente.exclusiva = normExclusiva(exclusivaBody, cliente.cochera);
      }
    } else if (exclusivaBody !== undefined) {
      cliente.exclusiva = normExclusiva(exclusivaBody, cliente.cochera);
    }
    if (pisoBody !== undefined) {
      cliente.piso = pisoBody;
    }

    await cliente.save({ session });

    const movimiento = new Movimiento({
      cliente: id,
      descripcion: `Renovación abono ${tipoVehiculo} (${mesesAbonar} mes${mesesAbonar > 1 ? "es" : ""})`,
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
      descripcion: `Renovación abono ${tipoVehiculo} (${mesesAbonar} mes${mesesAbonar > 1 ? "es" : ""})`,
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
      message: "Abono renovado exitosamente.",
      cliente: clienteActualizado,
      movimiento,
      movimientoCliente,
      mesesAbonar, // eco para trazabilidad
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

exports.eliminarTodosLosClientes = async (_req, res) => {
  try {
    await Cliente.deleteMany({});
    res.status(200).json({ message: "Todos los clientes fueron eliminados." });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al eliminar clientes", error: err.message });
  }
};

// NUEVO: update básico (sin tocar abonos/vehículos) con fallback a _id string
exports.actualizarClienteBasico = async (req, res) => {
  try {
    const { id } = req.params;

    // permitimos actualizar datos básicos + cochera/exclusiva/piso
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

    // Normalizamos cochera/exclusiva/piso si vinieron
    const cRaw =
      req.body.cochera !== undefined ? normCochera(req.body.cochera) : undefined;
    const pRaw = req.body.piso !== undefined ? normPiso(req.body.piso) : undefined;
    const eRawPresent = req.body.exclusiva !== undefined;

    let cliente = await Cliente.findById(id);
    if (!cliente) {
      const doc = await Cliente.collection.findOne({ _id: String(id) });
      if (doc) cliente = new Cliente(doc);
    }
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });

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
    if (pRaw !== undefined) {
      cliente.piso = pRaw;
    }

    await cliente.save();
    return res.json({ message: "Cliente actualizado", cliente });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error al actualizar cliente", error: err.message });
  }
};
