// controllers/vehiculoControllers.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");

const {
  Types: { ObjectId },
} = mongoose;

const Vehiculo = require("../models/Vehiculo");
const Movimiento = require("../models/Movimiento");
const Turno = require("../models/Turno");
const Tarifa = require("../models/Tarifa");
const Abono = require("../models/Abono");
const Cliente = require("../models/Cliente");
const Counter = require("../models/Counter");

// ===== Config de archivos
const UPLOADS_DIR = path.join(__dirname, "../uploads");
const FOTOS_DIR = path.join(UPLOADS_DIR, "fotos");
const FOTOS_ENTRADAS_DIR = path.join(FOTOS_DIR, "entradas");
const RUTA_FOTO_TEMPORAL = path.join(__dirname, "../camara/sacarfoto/captura.jpg");

[UPLOADS_DIR, FOTOS_DIR, FOTOS_ENTRADAS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ===== Helpers varios
function obtenerPrecios() {
  const filePath = path.join(__dirname, "../data/precios.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

// --- arriba del archivo (junto a otros helpers) ---
async function resolveClienteIdForAbono(abonoDoc) {
  // 1) Intento directo (ObjectId, {_id}, {id}, {buffer})
  const tryId = (v) => {
    const id =
      toObjectIdSafe(v) ||
      toObjectIdSafe(v && v._id) ||
      toObjectIdSafe(v && v.id) ||
      (v && v.buffer ? toObjectIdSafe(v) : undefined);
    return id || null;
  };

  let id = tryId(abonoDoc?.cliente);
  if (id) return id;

  // 2) Heurísticas por datos del abono
  const dni = String(abonoDoc?.dniCuitCuil || "").trim();
  const email = String(abonoDoc?.email || "").trim().toLowerCase();
  const name = String(abonoDoc?.nombreApellido || "").trim();

  if (dni) {
    const c = await Cliente.findOne({ dniCuitCuil: dni }).select("_id").lean();
    if (c) return c._id;
  }
  if (email) {
    const c = await Cliente.findOne({ email }).select("_id").lean();
    if (c) return c._id;
  }
  if (name) {
    const c = await Cliente.findOne({ nombreApellido: name }).select("_id").lean();
    if (c) return c._id;
  }

  return null;
}

async function obtenerProximoTicket() {
  const resultado = await Counter.findOneAndUpdate(
    { name: "ticket" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return resultado.seq;
}
async function obtenerProximoTicketPago() {
  const resultado = await Counter.findOneAndUpdate(
    { name: "ticketPago" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return resultado.seq;
}

async function actualizarEstadoTurnoVehiculo(patente) {
  const ahora = new Date();
  const pat = String(patente || "").toUpperCase();
  const turnos = await Turno.find({ patente: pat });
  const tieneTurnoActivo = turnos.some(
    (turno) => turno.expirado === false && new Date(turno.fin) > ahora && turno.usado === false
  );
  return tieneTurnoActivo;
}

async function guardarFotoVehiculo(patente, fotoUrl) {
  if (!fotoUrl) return null;

  try {
    const response = await axios.get(fotoUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data, "binary");

    const timestamp = Date.now();
    const nombreArchivo = `${String(patente).toUpperCase()}_${timestamp}.jpg`;
    const rutaArchivo = path.join(FOTOS_ENTRADAS_DIR, nombreArchivo);

    fs.writeFileSync(rutaArchivo, buffer);

    if (fs.existsSync(RUTA_FOTO_TEMPORAL)) {
      try {
        fs.unlinkSync(RUTA_FOTO_TEMPORAL);
        console.log("Foto temporal captura.jpg eliminada después de guardarla.");
      } catch (unlinkErr) {
        console.error("Error al eliminar foto temporal captura.jpg:", unlinkErr);
      }
    } else {
      console.log("Foto temporal captura.jpg no encontrada para eliminar.");
    }

    return `/uploads/fotos/entradas/${nombreArchivo}`;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.warn(`No se encontró la foto para ${patente} en ${fotoUrl}`);
      return null;
    }
    throw err;
  }
}

// ---------------- utils operador desde req.user ----------------
function getOperadorNombre(req) {
  const u = req && req.user ? req.user : {};
  const nombre = (u.nombre || "").trim();
  const apellido = (u.apellido || "").trim();
  const username = (u.username || "").trim();
  if (nombre || apellido) return `${nombre} ${apellido}`.trim();
  if (username) return username;
  return null;
}

// ---------------- Helper costo excedente desde fin de turno ----------------
async function calcularCostoExcedente(tipoVehiculo, desde, hasta) {
  try {
    const payload = { tipoVehiculo, desde, hasta };
    const { data } = await axios.post("http://localhost:5000/api/calcular-tarifa", payload);
    const valor = data?.precio ?? data?.monto ?? data?.total ?? 0;
    if (Number.isFinite(Number(valor))) return Number(valor);
  } catch (e) {
    console.warn("[calcularCostoExcedente] fallback por hora:", e.message);
  }

  const precios = obtenerPrecios();
  const base = precios[String(tipoVehiculo || "").toLowerCase()]?.estadia || 0;
  const ms = Math.max(0, new Date(hasta) - new Date(desde));
  const horas = Math.ceil(ms / (60 * 60 * 1000));
  return base * horas;
}

// ===== Normalizaciones =====
function upperOrEmpty(s) {
  const t = (s ?? "").toString().trim();
  return t ? t.toUpperCase() : t;
}
function cap1(s) {
  const t = (s ?? "").toString().trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// === ObjectId safe cast (string 24hex, Buffer, {buffer:{...}}, {_id}, ObjectId) ===
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

// Helper: devuelve un ObjectId válido si puede; si no, deja el valor original
function getIdAny(x) {
  return toObjectIdSafe(x) || toObjectIdSafe(x && x._id) || toObjectIdSafe(x && x.id) || x;
}

// Helper: devuelve ObjectId o null (NUNCA un objeto crudo)
function oidOrNull(x) {
  try {
    return (
      toObjectIdSafe(x) ||
      toObjectIdSafe(x && x._id) ||
      toObjectIdSafe(x && x.id) ||
      (x && x.buffer ? toObjectIdSafe(x) : null) ||
      null
    );
  } catch {
    return null;
  }
}

/* =========================================================================
   🔒 ANTI-DUPLICADOS / CAST ROBUSTO
   ========================================================================= */

// ✅ Sync seguro desde Abono SIN duplicar + fija abono.vehiculo como ObjectId real
async function ensureVehiculoFromAbono(abonoDoc) {
  if (!abonoDoc) throw new Error("Abono inválido");
  const newPat = upperOrEmpty(abonoDoc.patente);
  if (!newPat) throw new Error("El abono no tiene patente definida");

  const abonoId = getIdAny(abonoDoc._id);

  // 1) Preferir el vehículo vinculado a este abono
  let vehiculo = await Vehiculo.findOne({ abono: abonoId });

  // 2) Si no está vinculado por abono, buscar por patente (nueva)
  if (!vehiculo) {
    vehiculo = await Vehiculo.findOne({ patente: newPat });
  }

  // 3) Si existe y la patente difiere, chequeo colisión y renombro
  if (vehiculo && vehiculo.patente !== newPat) {
    const colision = await Vehiculo.findOne({ patente: newPat });
    if (colision && String(colision._id) !== String(vehiculo._id)) {
      const err = new Error(`Ya existe un vehículo con la patente ${newPat}`);
      err.statusCode = 409;
      throw err;
    }
    vehiculo.patente = newPat;
  }

  // 4) Si no existe ninguno, creo uno (caso: no había vehículo todavía)
  if (!vehiculo) {
    vehiculo = new Vehiculo({
      patente: newPat,
      tipoVehiculo: cap1(abonoDoc.tipoVehiculo) || "Auto",
      abonado: true,
    });
  }

  // 5) Actualizar datos básicos + vínculo al abono
  vehiculo.tipoVehiculo = cap1(abonoDoc.tipoVehiculo) || vehiculo.tipoVehiculo;
  vehiculo.marca = abonoDoc.marca ?? vehiculo.marca;
  vehiculo.modelo = abonoDoc.modelo ?? vehiculo.modelo;
  vehiculo.color = abonoDoc.color ?? vehiculo.color;
  vehiculo.anio = abonoDoc.anio ?? vehiculo.anio;
  vehiculo.companiaSeguro = abonoDoc.companiaSeguro ?? vehiculo.companiaSeguro;

  vehiculo.abonado = true;
  try {
    vehiculo.abono = abonoId;
  } catch (_) {}

  await vehiculo.save();

  // 6) Asegurar que abono.vehiculo quede como ObjectId real (no Buffer)
  const vehId = getIdAny(vehiculo._id);
  if (!abonoDoc.vehiculo || String(abonoDoc.vehiculo) !== String(vehId)) {
    abonoDoc.vehiculo = vehId;
    try {
      await abonoDoc.save();
    } catch (e) {
      console.warn("[ensureVehiculoFromAbono] No pude guardar abono.vehiculo:", e?.message);
    }
  }

  // 7) Vínculo en Cliente
  const cliId = await resolveClienteIdForAbono(abonoDoc);
  if (cliId && vehId) {
    try {
      await Cliente.updateOne({ _id: cliId }, { $addToSet: { vehiculos: vehId } });
    } catch (e) {
      console.warn("[ensureVehiculoFromAbono] addToSet cliente.vehiculos:", e?.message);
    }

    // 👉 Outbox
    try {
      const Outbox = require("../models/Outbox");
      await Outbox.create({
        method: "PATCH",
        route: `/api/clientes/${cliId}`,
        collection: "clientes",
        status: "pending",
        document: { _id: String(cliId), vehiculos: [String(vehId)], __merge: "addToSet" },
        createdAt: new Date(),
      });
    } catch (e) {
      console.warn("[ensureVehiculoFromAbono] no pude encolar Outbox clientes:", e?.message);
    }
  } else {
    console.warn(
      "[ensureVehiculoFromAbono] skip addToSet: no pude resolver cliId para el abono",
      String(abonoDoc?._id || "¿?")
    );
  }

  return vehiculo;
}

/* =========================================================================
   🔧 LIMPIEZA Y ORDEN DE RESPUESTA
   ========================================================================= */

// Quita cualquier propiedad 'buffer' anidada y normaliza _id a string donde corresponda
function deepClean(value) {
  // 🧩 1) Fechas = intactas
  if (
    value instanceof Date ||
    (value &&
      typeof value === "object" &&
      Object.prototype.toString.call(value) === "[object Date]" &&
      !isNaN(new Date(value).getTime()))
  ) {
    return value;
  }

  // 🧩 2) ObjectId → string
  if (value instanceof ObjectId) {
    return String(value);
  }

  // 🧩 3) Arrays recursivos
  if (Array.isArray(value)) {
    return value.map((v) => deepClean(v));
  }

  // 🧩 4) Objetos planos sin buffer
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "buffer") continue; // evitar serialización basura
      if (k === "_id") {
        out._id = String(v); // SIEMPRE string
        continue;
      }
      out[k] = deepClean(v);
    }
    return out;
  }

  // 🧩 5) Primitivos → directos
  return value;
}

// Abono “lite”: sin buffers; mantengo campos útiles si vienen “embeddeados”
function formatAbono(ab) {
  if (!ab || typeof ab !== "object") return ab ?? null;
  const x = deepClean(ab);
  const out = {};
  if (x._id) out._id = x._id;
  if (x.tipoTarifa !== undefined) out.tipoTarifa = x.tipoTarifa;
  if (x.activo !== undefined) out.activo = x.activo;
  if (Array.isArray(x.cocheras)) out.cocheras = deepClean(x.cocheras);
  if (x.fechaCreacion) out.fechaCreacion = x.fechaCreacion;
  if (x.patente) out.patente = x.patente;
  if (x.tipoVehiculo) out.tipoVehiculo = x.tipoVehiculo;
  if (x.precio !== undefined) out.precio = x.precio;
  return out;
}

// Cliente “lite”: sin buffers, mantengo lo relevante si vino “embeddeado”
function formatCliente(cli) {
  if (!cli || typeof cli !== "object") return cli ?? null;
  const x = deepClean(cli);
  const out = {};
  // Identidad si estuviera
  if (x._id) out._id = x._id;
  if (x.nombreApellido) out.nombreApellido = x.nombreApellido;
  if (x.dniCuitCuil) out.dniCuitCuil = x.dniCuitCuil;
  if (x.email) out.email = x.email;

  // Estado que usás en front
  if (x.abonado !== undefined) out.abonado = x.abonado;
  if (x.finAbono) out.finAbono = x.finAbono;
  if (x.precioAbono !== undefined) out.precioAbono = x.precioAbono;
  if (x.cochera !== undefined) out.cochera = x.cochera;
  if (x.exclusiva !== undefined) out.exclusiva = x.exclusiva;
  if (x.piso !== undefined) out.piso = x.piso;
  if (x.balance !== undefined) out.balance = x.balance;

  // Referencias si vinieran
  if (Array.isArray(x.vehiculos)) out.vehiculos = x.vehiculos.map((v) => deepClean(v));
  if (Array.isArray(x.abonos)) out.abonos = x.abonos.map((v) => deepClean(v));
  if (Array.isArray(x.movimientos)) out.movimientos = x.movimientos.map((v) => deepClean(v));

  return out;
}

// Orden y limpieza final de un vehículo (objeto plain)
function formatVehiculo(v) {
  const x = deepClean(v || {});
  const ordered = {
    _id: x._id,
    patente: x.patente,
    tipoVehiculo: x.tipoVehiculo,
    abonado: x.abonado,
    turno: x.turno,
    abono: formatAbono(x.abono),
    cliente: formatCliente(x.cliente),
    marca: x.marca,
    modelo: x.modelo,
    color: x.color,
    anio: x.anio,
    companiaSeguro: x.companiaSeguro,
    operador: x.operador,
    estadiaActual: x.estadiaActual ? deepClean(x.estadiaActual) : undefined,
    historialEstadias: Array.isArray(x.historialEstadias) ? deepClean(x.historialEstadias) : [],
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    __v: x.__v,
  };

  // Quitar claves undefined para no ensuciar
  Object.keys(ordered).forEach((k) => ordered[k] === undefined && delete ordered[k]);
  return ordered;
}

/* =========================================================================
   Handlers
   ========================================================================= */

// Crear Vehículo (con entrada)
exports.createVehiculo = async (req, res) => {
  try {
    const {
      patente,
      tipoVehiculo,
      abonado = false,
      turno = false,
      operador,
      metodoPago,
      monto,
      ticket,
      entrada,
      fotoUrl,
    } = req.body;

    if (!patente || !tipoVehiculo) {
      return res.status(400).json({ msg: "Faltan datos" });
    }

    const operadorNombre =
      (typeof operador === "string" && operador.trim()) || getOperadorNombre(req) || "Operador Desconocido";

    const rutaFotoGuardada = await guardarFotoVehiculo(patente, fotoUrl);

    const pat = upperOrEmpty(patente);
    let vehiculo = await Vehiculo.findOne({ patente: pat });

    if (!vehiculo) {
      vehiculo = new Vehiculo({
        patente: pat,
        tipoVehiculo,
        abonado: !!abonado,
        turno: !!turno,
      });

      if (abonado) {
        const precios = obtenerPrecios();
        const precioAbono = precios[tipoVehiculo.toLowerCase()]?.estadia || 0;

        vehiculo.abonoExpira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const nuevoMovimiento = new Movimiento({
          patente: pat,
          operador: "Sistema",
          tipoVehiculo,
          metodoPago: "Efectivo",
          factura: "CC",
          monto: precioAbono,
          descripcion: "Pago por Abono",
        });

        await nuevoMovimiento.save();
      }

      const ticketNum = ticket || (await obtenerProximoTicket());
      const fechaEntrada = entrada ? new Date(entrada) : new Date();

      vehiculo.estadiaActual = {
        entrada: fechaEntrada,
        operadorNombre,
        metodoPago: metodoPago || null,
        monto: monto || null,
        ticket: ticketNum,
        fotoUrl: rutaFotoGuardada,
      };

      await vehiculo.save();
      return res.status(201).json({ msg: "Vehículo creado y entrada registrada", vehiculo: formatVehiculo(vehiculo.toObject()) });
    }

    if (vehiculo.estadiaActual?.entrada) {
      return res.status(400).json({ msg: "Este vehículo ya tiene una estadía en curso" });
    }

    const ticketNum = ticket || (await obtenerProximoTicket());
    const fechaEntrada = entrada ? new Date(entrada) : new Date();

    vehiculo.estadiaActual = {
      entrada: fechaEntrada,
      operadorNombre,
      metodoPago: metodoPago || null,
      monto: monto || null,
      ticket: ticketNum,
      fotoUrl: rutaFotoGuardada,
    };

    await vehiculo.save();
    return res.status(200).json({ msg: "Entrada registrada para vehículo existente", vehiculo: formatVehiculo(vehiculo.toObject()) });
  } catch (err) {
    console.error("💥 Error en createVehiculo:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

exports.createVehiculoSinEntrada = async (req, res) => {
  try {
    const { patente, tipoVehiculo, abonado, turno } = req.body;

    if (!patente || !tipoVehiculo) {
      return res.status(400).json({ msg: "Faltan datos" });
    }

    const pat = upperOrEmpty(patente);
    let vehiculo = await Vehiculo.findOne({ patente: pat });

    if (!vehiculo) {
      vehiculo = new Vehiculo({
        patente: pat,
        tipoVehiculo,
        abonado: !!abonado,
        turno: !!turno,
      });

      if (abonado) {
        const precios = obtenerPrecios();
        const precioAbono = precios[tipoVehiculo.toLowerCase()]?.estadia || 0;

        vehiculo.abonoExpira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const nuevoMovimiento = new Movimiento({
          patente: pat,
          operador: "Sistema",
          tipoVehiculo,
          metodoPago: "Efectivo",
          factura: "CC",
          monto: precioAbono,
          descripcion: "Pago de Abono",
        });

        await nuevoMovimiento.save();
      }

      await vehiculo.save();
      return res.status(201).json({ msg: "Vehículo creado sin entrada registrada", vehiculo: formatVehiculo(vehiculo.toObject()) });
    }

    return res.status(200).json({ msg: "Vehículo ya existe", vehiculo: formatVehiculo(vehiculo.toObject()) });
  } catch (err) {
    console.error("💥 Error en createVehiculoSinEntrada:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// Obtener todos los vehículos (🧹 limpio y ordenado – AHORA CON COCHERA REAL)
exports.getVehiculos = async (_req, res) => {
  try {
    const vehiculos = await Vehiculo.find()
      .populate("cliente", "_id nombreApellido dniCuitCuil email balance")           // OK
      .populate("abono", "_id activo patente tipoVehiculo fechaExpiracion cliente")  // NO COCHERA AQUÍ
      .populate("cocheraId", "_id tipo piso exclusiva cliente vehiculos");           // 👈 ESTA ES LA COCHERA REAL

    // IMPORTANTE: inserto cochera limpia dentro del objeto final
    const out = vehiculos.map((v) => {
      const vObj = v.toObject();

      // limpiar cochera para no mandar basura
      const coch = vObj.cocheraId
        ? {
            _id: String(vObj.cocheraId._id),
            tipo: vObj.cocheraId.tipo,
            piso: vObj.cocheraId.piso,
            exclusiva: vObj.cocheraId.exclusiva,
          }
        : null;

      const vehLimpio = formatVehiculo(vObj);
      vehLimpio.cochera = coch;  // 👈 Esto aparece en React como corresponde

      delete vehLimpio.cocheraId; // no lo exponemos más
      return vehLimpio;
    });

    res.json(out);
  } catch (err) {
    console.error("Error en getVehiculos:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// ==========================================================
// GET Vehículo por Patente — con cliente, abono y cochera real
// ==========================================================
exports.getVehiculoByPatente = async (req, res) => {
  try {
    const patente = upperOrEmpty(req.params.patente);

    const vehiculoDoc = await Vehiculo.findOne({ patente })
      .populate("cliente", "_id nombreApellido dniCuitCuil email balance")
      .populate("abono", "_id activo patente tipoVehiculo fechaExpiracion cliente")
      .populate("cocheraId", "_id tipo piso exclusiva cliente vehiculos");

    if (!vehiculoDoc) {
      return res.status(404).json({ msg: "Vehículo no encontrado" });
    }

    // Sincronizar turno activo
    const tieneTurnoActivo = await actualizarEstadoTurnoVehiculo(patente);
    if (vehiculoDoc.turno !== tieneTurnoActivo) {
      await Vehiculo.updateOne(
        { _id: vehiculoDoc._id },
        { $set: { turno: tieneTurnoActivo, updatedAt: new Date() } }
      );
      vehiculoDoc.turno = tieneTurnoActivo;
    }

    // Formato UNIFICADO con cochera
    const v = vehiculoDoc.toObject();
    const coch = v.cocheraId
      ? {
          _id: String(v.cocheraId._id),
          tipo: v.cocheraId.tipo,
          piso: v.cocheraId.piso,
          exclusiva: v.cocheraId.exclusiva,
        }
      : null;

    const vehiculoLimpio = formatVehiculo(v);
    vehiculoLimpio.cochera = coch;
    delete vehiculoLimpio.cocheraId;

    res.json(vehiculoLimpio);
  } catch (err) {
    console.error("Error en getVehiculoByPatente:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// ==========================================================
// GET Vehículo por ID — unificado con cochera, cliente y abono
// ==========================================================
exports.getVehiculoById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ msg: "ID inválido" });
    }

    const vehiculoDoc = await Vehiculo.findById(id)
      .populate("cliente", "_id nombreApellido dniCuitCuil email balance")
      .populate("abono", "_id activo patente tipoVehiculo fechaExpiracion cliente")
      .populate("cocheraId", "_id tipo piso exclusiva cliente vehiculos");

    if (!vehiculoDoc) {
      return res.status(404).json({ msg: "Vehículo no encontrado." });
    }

    const v = vehiculoDoc.toObject();
    const coch = v.cocheraId
      ? {
          _id: String(v.cocheraId._id),
          tipo: v.cocheraId.tipo,
          piso: v.cocheraId.piso,
          exclusiva: v.cocheraId.exclusiva,
        }
      : null;

    const vehiculoLimpio = formatVehiculo(v);
    vehiculoLimpio.cochera = coch;
    delete vehiculoLimpio.cocheraId;

    res.json(vehiculoLimpio);
  } catch (err) {
    console.error("Error en getVehiculoById:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// Tipos de vehículo
exports.getTiposVehiculo = (_req, res) => {
  try {
    const precios = obtenerPrecios();
    const tipos = Object.keys(precios || {}).map((nombre) => ({ nombre }));
    const out = tipos.length ? tipos : [{ nombre: "auto" }, { nombre: "camioneta" }, { nombre: "moto" }];
    res.json(out);
  } catch (err) {
    console.error("💥 Error al obtener tipos de vehículo:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// Registrar entrada
exports.registrarEntrada = async (req, res) => {
  try {
    const patente = upperOrEmpty(req.params.patente);
    const { operador, metodoPago, monto, ticket, entrada, fotoUrl } = req.body;

    const rutaFotoGuardada = await guardarFotoVehiculo(patente, fotoUrl);
    const vehiculo = await Vehiculo.findOne({ patente });

    if (!vehiculo) {
      return res.status(404).json({ msg: "Vehículo no encontrado." });
    }

    if (vehiculo.estadiaActual?.entrada) {
      return res.status(400).json({ msg: "Este vehículo ya tiene una estadía en curso" });
    }

    const ticketNum = ticket || (await obtenerProximoTicket());
    const fechaEntrada = entrada ? new Date(entrada) : new Date();

    const operadorNombre =
      (typeof operador === "string" && operador.trim()) || getOperadorNombre(req) || "Operador Desconocido";

    vehiculo.estadiaActual = {
      entrada: fechaEntrada,
      operadorNombre,
      metodoPago: metodoPago || null,
      monto: monto || null,
      ticket: ticketNum,
      fotoUrl: rutaFotoGuardada,
    };

    await vehiculo.save();

    res.status(200).json({ msg: "Entrada registrada para vehículo", vehiculo: formatVehiculo(vehiculo.toObject()) });
  } catch (err) {
    console.error("Error en registrarEntrada:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// Registrar salida (ATÓMICO con Movimiento)
exports.registrarSalida = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const patente = upperOrEmpty(req.params.patente);
    const {
      salida: salidaBody,
      costo: costoBody,
      metodoPago: mpBody,
      factura: facturaBody,
      tipoTarifa: tipoTarifaBody,
      descripcion: descripcionBody,
      operador: operadorBody,
      tiempoHoras: tiempoHorasBody,
      promo: promoBody,
      fotoUrl: fotoMovBody,
    } = req.body || {};

    const vehiculo = await Vehiculo.findOne({ patente }).session(session);
    if (!vehiculo) throw new Error("Vehículo no encontrado");
    if (!vehiculo.estadiaActual || !vehiculo.estadiaActual.entrada || vehiculo.estadiaActual.salida) {
      throw new Error("No hay estadía activa para este vehículo");
    }

    const salida = salidaBody ? new Date(salidaBody) : new Date();
    const entrada = new Date(vehiculo.estadiaActual.entrada);

    // snapshot ANTES de tocar nada
    // ⚠️ FIX CRÍTICO: estadiaActual a veces trae _id basura (Buffer->objeto plano)
    // Eso rompe el $push dentro de la transacción y NO guarda la salida.
    // Lo eliminamos SIEMPRE antes del snapshot.
    if (vehiculo.estadiaActual._id) {
      delete vehiculo.estadiaActual._id;
    }

    // Snapshot limpio
    const estadiaSnapshot = JSON.parse(JSON.stringify(vehiculo.estadiaActual));
    estadiaSnapshot.salida = salida;

    const patenteUp = patente;
    const turnoElegible = await Turno.findOneAndUpdate(
      {
        patente: patenteUp,
        usado: false,
        fin: { $gt: entrada },
        inicio: { $lt: salida },
      },
      { $set: { usado: true, updatedAt: new Date() } },
      { new: true, session, sort: { fin: -1 } }
    );

    let costoFinal =
      typeof costoBody === "number" && !Number.isNaN(costoBody)
        ? costoBody
        : typeof estadiaSnapshot.costoTotal === "number"
        ? estadiaSnapshot.costoTotal
        : 0;

    if (turnoElegible) {
      const inicioCubierto = new Date(Math.max(entrada.getTime(), new Date(turnoElegible.inicio).getTime()));
      const finCubierto = new Date(Math.min(salida.getTime(), new Date(turnoElegible.fin).getTime()));

      const cubreTodo = inicioCubierto <= entrada && finCubierto >= salida;
      if (cubreTodo) {
        costoFinal = 0;
      } else if (salida > turnoElegible.fin) {
        const desdeExcedente = new Date(Math.max(turnoElegible.fin.getTime(), entrada.getTime()));
        const hastaExcedente = salida;
        const costoExcedente = await calcularCostoExcedente(
          vehiculo.tipoVehiculo || "auto",
          desdeExcedente,
          hastaExcedente
        );
        costoFinal = Number(costoExcedente) || 0;
      } else {
        costoFinal = 0;
      }
    }

    estadiaSnapshot.costoTotal = Number(costoFinal) || 0;

    // Pasar estadía actual al historial + limpiar estadíaActual
    await Vehiculo.updateOne(
      { _id: vehiculo._id },
      {
        $push: { historialEstadias: estadiaSnapshot },
        $unset: { estadiaActual: "" },
        $set: { updatedAt: new Date() },
      },
      { session }
    );

    // Mantener flag turno coherente
    const ahora = new Date();
    const sigueConTurnoActivo = await Turno.exists({
      patente: patenteUp,
      expirado: false,
      usado: false,
      fin: { $gt: ahora },
    }).session(session);
    if (!sigueConTurnoActivo) {
      await Vehiculo.updateOne(
        { _id: vehiculo._id },
        { $set: { turno: false, updatedAt: new Date() } },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    // ========================================================
    // 🔥 2) NO crear movimiento para abonados o turnos
    // ========================================================
    let movimientoDoc = null;  // ← NECESARIO

    const esAbonado = vehiculo.abonado === true;
    const teniaTurnoAlEntrar = vehiculo.turno === true;
    const turnoActivoDespues = !!sigueConTurnoActivo;

    // 🔧 IMPORTANTE: sincronizar objeto en memoria
    if (!sigueConTurnoActivo) {
      vehiculo.turno = false;
    }

    if (esAbonado || teniaTurnoAlEntrar || turnoElegible || turnoActivoDespues) {
      const vehiculoActualizado = await Vehiculo.findOne({ _id: vehiculo._id }).lean();
      return res.json({
        msg: "Salida registrada (abonado/turno: sin movimiento)",
        estadia: estadiaSnapshot,
        movimiento: null,
        turnoUsado: turnoElegible
          ? { _id: turnoElegible._id, inicio: turnoElegible.inicio, fin: turnoElegible.fin }
          : null,
        vehiculo: formatVehiculo(vehiculoActualizado),
      });
    }

    // 🟢 Solo si NO es abonado ni turno → crear movimiento
    try {
      const horas =
        Number.isFinite(Number(tiempoHorasBody)) && Number(tiempoHorasBody) > 0
          ? Number(tiempoHorasBody)
          : 1;

      const tipoTarifa = tipoTarifaBody || "hora";
      const descripcion =
        descripcionBody ||
        `Pago por ${horas} Hora${horas > 1 ? "s" : ""}`;

      const metodoPago = mpBody || estadiaSnapshot.metodoPago || "Efectivo";
      const factura = facturaBody || "Final";

      const authHeader =
        req.headers["authorization"] || req.headers["Authorization"];

      let operadorNombreFinal = getOperadorNombre(req) || "Operador Desconocido";
      let operadorIdFinal = null;

      if (operadorBody && typeof operadorBody === "object") {
        operadorNombreFinal =
          operadorBody.username ||
          `${operadorBody.nombre || ""} ${operadorBody.apellido || ""}`.trim() ||
          operadorBody.email ||
          "Operador Desconocido";

        operadorIdFinal = operadorBody._id || operadorBody.id || null;
      }

      const datosMovimiento = {
        patente: patenteUp,
        tipoVehiculo: vehiculo.tipoVehiculo || "Desconocido",
        metodoPago,
        factura,
        descripcion,
        monto: Number(costoFinal) || 0,
        tipoTarifa,
        ticket: estadiaSnapshot.ticket || undefined,
        fotoUrl: fotoMovBody || estadiaSnapshot.fotoUrl || undefined,
        entrada: estadiaSnapshot.entrada || undefined,
        salida: salida,
        tiempoHoras: horas,
        operador: operadorNombreFinal,
        operadorId: operadorIdFinal,
        promo: promoBody || undefined,
        ticketPago: await obtenerProximoTicketPago(),
      };

      const respMov = await axios.post(
        "http://localhost:5000/api/movimientos/registrar",
        datosMovimiento,
        {
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
        }
      );

      if (respMov.data && respMov.data.movimiento) {
        movimientoDoc = respMov.data.movimiento;
      }
    } catch (e) {
      console.error("[registrarSalida] Error creando Movimiento:", e.message || e);
    }

    const vehiculoActualizado = await Vehiculo.findOne({ _id: vehiculo._id }).lean();

    return res.json({
      msg: "Salida registrada",
      estadia: estadiaSnapshot,
      movimiento: movimientoDoc || null,
      turnoUsado: turnoElegible
        ? { _id: turnoElegible._id, inicio: turnoElegible.inicio, fin: turnoElegible.fin }
        : null,
      vehiculo: formatVehiculo(vehiculoActualizado),
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error("💥 Error en registrarSalida:", err);
    res.status(500).json({ msg: err.message || "Error del servidor" });
  }
};

// Asignar abono
exports.asignarAbonoAVehiculo = async (req, res) => {
  const patente = upperOrEmpty(req.params.patente);
  const { abonoId } = req.body;

  try {
    const vehiculo = await Vehiculo.findOne({ patente });
    if (!vehiculo) return res.status(404).json({ message: "Vehículo no encontrado." });

    const abono = await Abono.findById(getIdAny(abonoId));
    if (!abono) return res.status(404).json({ message: "Abono no encontrado" });

    vehiculo.abonado = true;
    try {
      vehiculo.abono = getIdAny(abono._id);
    } catch (_) {}

    await vehiculo.save();

    // además dejo el vínculo correcto en el abono
    const vehId = getIdAny(vehiculo._id);
    if (!abono.vehiculo || String(abono.vehiculo) !== String(vehId)) {
      abono.vehiculo = vehId;
      try {
        await abono.save();
      } catch (e) {
        console.warn("[asignarAbonoAVehiculo] No pude guardar abono.vehiculo:", e?.message);
      }
    }

    return res.status(200).json({ message: "Vehículo actualizado con éxito", vehiculo: formatVehiculo(vehiculo.toObject()) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al actualizar el vehículo" });
  }
};

// Buscar vehículo por número de ticket
exports.getVehiculoByTicket = async (req, res) => {
  try {
    const { ticket } = req.params;
    const ticketNum = parseInt(ticket);

    if (isNaN(ticketNum)) {
      return res.status(400).json({ msg: "Número de ticket inválido" });
    }

    const vehiculo = await Vehiculo.findOne({ "estadiaActual.ticket": ticketNum });
    if (!vehiculo) {
      return res.status(404).json({ msg: "Vehículo no encontrado para este ticket" });
    }

    res.json(formatVehiculo(vehiculo.toObject()));
  } catch (err) {
    console.error("Error en getVehiculoByTicket:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// Buscar vehículo por número de ticket (modo admin: incluye historial y fallback)
exports.getVehiculoByTicketAdmin = async (req, res) => {
  try {
    const { ticket } = req.params;
    const ticketNum = parseInt(ticket, 10);

    if (isNaN(ticketNum)) {
      return res.status(400).json({ msg: "Número de ticket inválido" });
    }

    // 1️⃣ Buscar en estadía actual o historial
    let vehiculo = await Vehiculo.findOne({
      $or: [{ "estadiaActual.ticket": ticketNum }, { "historialEstadias.ticket": ticketNum }],
    }).select("-__v");

    if (!vehiculo) {
      return res.status(404).json({ msg: "Vehículo no encontrado para este ticket" });
    }

    // 2️⃣ Determinar la estadía exacta
    let estadia = null;

    if (vehiculo.estadiaActual && vehiculo.estadiaActual.ticket === ticketNum) {
      estadia = { ...vehiculo.estadiaActual };
    } else if (Array.isArray(vehiculo.historialEstadias)) {
      estadia = vehiculo.historialEstadias.find((e) => e.ticket === ticketNum) || null;
    }

    // 3️⃣ Si no hay salida en la estadía, intentar completarla
    if (estadia && !estadia.salida) {
      const mov = await Movimiento.findOne({ ticket: ticketNum }).sort({ createdAt: -1 }).lean();

      if (mov) {
        estadia.salida = mov.fecha || mov.createdAt || mov.updatedAt || new Date();
        estadia.metodoPago = mov.metodoPago || estadia.metodoPago || null;
        estadia.operadorNombre = mov.operador || estadia.operadorNombre || "Operador desconocido";
        estadia.descripcion = mov.descripcion || estadia.descripcion || null;
      }
    }

    // 4️⃣ Si sigue sin estadía válida, fabricarla básica (caso extremo)
    if (!estadia) {
      estadia = {
        entrada: null,
        salida: null,
        ticket: ticketNum,
        operadorNombre: "Desconocido",
      };
    }

    // 5️⃣ Formato y salida final
    estadia.ticketFormateado = String(estadia.ticket).padStart(10, "0");
    return res.json({ vehiculo: formatVehiculo(vehiculo.toObject()), estadia });
  } catch (err) {
    console.error("💥 Error en getVehiculoByTicketAdmin:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

exports.setAbonadoFlagByPatente = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const patente = upperOrEmpty(req.params.patente);
    const { abonado, detachFromCliente, clienteId: cliIdFromReq } = req.body || {};

    if (typeof abonado !== "boolean") {
      return res.status(400).json({ msg: 'Campo "abonado" requerido (boolean).' });
    }

    const vehiculo = await Vehiculo.findOne({ patente }).session(session);
    if (!vehiculo) return res.status(404).json({ msg: "Vehículo no encontrado" });

    vehiculo.abonado = abonado;

    // === LIMPIEZA Y DESVINCULACIÓN ===
    if (!abonado) {
      vehiculo.abonado = false;
      // vehiculo.abono se mantiene
      // vehiculo.cliente se mantiene
    }

    await vehiculo.save({ session });

    // === Si hay que desvincular del cliente ===
    if (detachFromCliente) {
      // 1️⃣ Intentar obtener cliente confiable
      let clienteId = null;
      if (cliIdFromReq && ObjectId.isValid(cliIdFromReq)) {
        clienteId = new ObjectId(cliIdFromReq);
      } else if (vehiculo.cliente && ObjectId.isValid(vehiculo.cliente)) {
        clienteId = vehiculo.cliente;
      } else {
        const abonoActivo = await Abono.findOne({ patente, activo: true }).session(session);
        if (abonoActivo && ObjectId.isValid(abonoActivo.cliente))
          clienteId = abonoActivo.cliente;
      }

      // 2️⃣ Ejecutar pull robusto
      if (clienteId) {
        await Cliente.updateOne(
          { _id: clienteId },
          {
            $pull: {
              vehiculos: {
                $or: [
                  { _id: vehiculo._id },
                  { patente: vehiculo.patente }
                ]
              }
            },
            $set: { updatedAt: new Date() }
          },
          { session }
        );

        // 3️⃣ Outbox sincronización remota
        try {
          const Outbox = require("../models/Outbox");
          await Outbox.create({
            method: "PATCH",
            route: `/api/clientes/${clienteId}`,
            collection: "clientes",
            status: "pending",
            document: { _id: String(clienteId), vehiculos: [String(vehiculo._id)], __merge: "pull" },
            createdAt: new Date()
          });
        } catch (e) {
          console.warn("[setAbonadoFlagByPatente] Outbox clientes fallo:", e?.message);
        }
      } else {
        console.warn("[setAbonadoFlagByPatente] No se pudo resolver clienteId");
      }
    }

    // === Actualizar abono asociado si existiera ===
    const abonoAsociado = await Abono.findOne({ patente }).session(session);
    if (abonoAsociado && !abonado) {
      abonoAsociado.activo = false;
      abonoAsociado.vehiculo = null;
      await abonoAsociado.save({ session });

      try {
        const Outbox = require("../models/Outbox");
        await Outbox.create({
          method: "PATCH",
          route: `/api/abonos/${abonoAsociado._id}`,
          collection: "abonos",
          status: "pending",
          document: { _id: String(abonoAsociado._id), activo: false, vehiculo: null },
          createdAt: new Date()
        });
      } catch (e) {
        console.warn("[setAbonadoFlagByPatente] Outbox abono fallo:", e?.message);
      }
    }

    await session.commitTransaction();
    session.endSession();

    const vehiculoActualizado = await Vehiculo.findOne({ patente }).lean();
    return res.json({ msg: "Vehículo actualizado correctamente", vehiculo: formatVehiculo(vehiculoActualizado) });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error("💥 Error en setAbonadoFlagByPatente:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

// Eliminar todos los vehículos
exports.eliminarTodosLosVehiculos = async (_req, res) => {
  try {
    console.log("Eliminando todos los vehículos...");
    await Vehiculo.deleteMany({});
    console.log("Todos los vehículos fueron eliminados.");
    res.json({ msg: "Todos los vehículos fueron eliminados correctamente." });
  } catch (err) {
    console.error("💥 Error al eliminar los vehículos:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

/* =========================================================================
   NUEVOS HANDLERS PARA EDICIÓN / SYNC
   ========================================================================= */

/**
 * PATCH /api/vehiculos/:patente
 */
exports.updateVehiculoByPatente = async (req, res) => {
  try {
    const patenteActual = upperOrEmpty(req.params.patente);
    const {
      patente: nuevaPatenteRaw,
      marca,
      modelo,
      color,
      anio,
      tipoVehiculo,
      companiaSeguro,
      ensureAbonado,
    } = req.body || {};

    const nuevaPatente = upperOrEmpty(nuevaPatenteRaw);

    let vehiculo = await Vehiculo.findOne({ patente: patenteActual });
    if (!vehiculo) {
      return res.status(404).json({ msg: "Vehículo no encontrado por patente actual." });
    }

    // Renombrar patente con chequeo de colisión
    if (nuevaPatente && nuevaPatente !== vehiculo.patente) {
      const colision = await Vehiculo.findOne({ patente: nuevaPatente });
      if (colision && String(colision._id) !== String(vehiculo._id)) {
        return res.status(409).json({ msg: `Ya existe un vehículo con patente ${nuevaPatente}` });
      }
      vehiculo.patente = nuevaPatente;
    }

    // Actualizar campos provistos
    if (marca !== undefined) vehiculo.marca = marca;
    if (modelo !== undefined) vehiculo.modelo = modelo;
    if (color !== undefined) vehiculo.color = color;
    if (anio !== undefined) vehiculo.anio = anio;
    if (tipoVehiculo !== undefined) vehiculo.tipoVehiculo = cap1(tipoVehiculo);
    if (companiaSeguro !== undefined) vehiculo.companiaSeguro = companiaSeguro;

    if (ensureAbonado === true) {
      vehiculo.abonado = true;
    }

    await vehiculo.save();
    res.json({ msg: "Vehículo actualizado", vehiculo: formatVehiculo(vehiculo.toObject()) });
  } catch (err) {
    console.error("💥 Error en updateVehiculoByPatente:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};

/**
 * PATCH /api/vehiculos/sync-from-abono/:abonoId
 */
exports.syncVehiculoFromAbono = async (req, res) => {
  try {
    const { abonoId } = req.params;
    if (!abonoId?.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ msg: "abonoId inválido" });
    }
    const abono = await Abono.findById(abonoId);
    if (!abono) return res.status(404).json({ msg: "Abono no encontrado" });

    try {
      const vehiculo = await ensureVehiculoFromAbono(abono);

      // Garantizo vínculo en cliente (por si el helper no pudo setear por alguna razón),
      // PERO SIN USAR getIdAny: casteo fuerte a ObjectId o salteo.
      const cliId = (await resolveClienteIdForAbono(abono)) || oidOrNull(abono.cliente);
      const vehId = oidOrNull(vehiculo?._id);

      if (cliId && vehId) {
        try {
          await Cliente.updateOne({ _id: cliId }, { $addToSet: { vehiculos: vehId } });
        } catch (e) {
          console.warn("[syncVehiculoFromAbono] addToSet cliente.vehiculos:", e?.message);
        }
      } else {
        console.warn("[syncVehiculoFromAbono] skip addToSet (no cliId o vehId casteables)", {
          cliId: String(cliId || ""),
          vehId: String(vehId || ""),
        });
      }

      return res.json({ msg: "Vehículo sincronizado desde Abono", vehiculo: formatVehiculo(vehiculo.toObject()) });
    } catch (e) {
      if (e?.statusCode === 409) {
        return res.status(409).json({ msg: e.message });
      }
      throw e;
    }
  } catch (err) {
    console.error("💥 Error en syncVehiculoFromAbono:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};
