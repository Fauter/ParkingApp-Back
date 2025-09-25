// controllers/movimientoControllers.js
const fs = require('fs');
const path = require('path');
const Movimiento = require('../models/Movimiento');
let Vehiculo = null; // lazy require para evitar ciclos

// operador desde req.user (ignora body.operador)
function getOperadorNombre(req) {
  const u = req.user || {};
  const nombre = (u.nombre || '').trim();
  const apellido = (u.apellido || '').trim();
  const username = (u.username || '').trim();

  if (nombre || apellido) return `${nombre} ${apellido}`.trim();
  if (username) return username;
  return 'Operador Desconocido';
}

// ⚙️ Util: timestamp de creación real (createdAt || fecha)
function movCreatedTs(m) {
  const src = m.createdAt || m.fecha;
  return src ? new Date(src).getTime() : -Infinity;
}

/** ============================
 *  Manejo de foto del movimiento
 *  ============================
 */
const UPLOADS_BASE = process.env.UPLOADS_BASE || path.join(__dirname, '..', 'uploads');
const ENTRADAS_DIR = path.join(UPLOADS_BASE, 'fotos', 'entradas');

function ensureDirs() {
  try { fs.mkdirSync(ENTRADAS_DIR, { recursive: true }); } catch {}
}

function isDataUrl(s) {
  return typeof s === 'string' && /^data:image\/(png|jpg|jpeg);base64,/i.test(s);
}

function extFromDataUrl(s) {
  const m = /^data:image\/(png|jpg|jpeg);base64,/i.exec(s || '');
  if (!m) return 'jpg';
  const t = m[1].toLowerCase();
  return t === 'png' ? 'png' : 'jpg';
}

function persistDataUrlToEntradas(dataUrl, patente) {
  ensureDirs();
  const ext = extFromDataUrl(dataUrl);
  const base64 = dataUrl.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const safePat = String(patente || 'foto').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const filename = `${safePat}_${Date.now()}_mov.${ext}`;
  const abs = path.join(ENTRADAS_DIR, filename);
  fs.writeFileSync(abs, buf);
  return `/uploads/fotos/entradas/${filename}`;
}

function normalizeFotoUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (isDataUrl(s)) return s; // se persiste afuera
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.pathname && /\/uploads\//.test(u.pathname)) return u.pathname;
    } catch { /* ignore */ }
    return s;
  }
  if (s.startsWith('/uploads/')) return s;
  if (!s.includes('/')) return `/uploads/fotos/entradas/${s}`;
  return '/' + s.replace(/^\/+/, '');
}

// POST /api/movimientos/registrar
exports.registrarMovimiento = async (req, res) => {
  try {
    const {
      patente,
      tipoVehiculo,
      metodoPago,
      factura,
      monto,
      descripcion,
      tipoTarifa,
      ticket,
      cliente,
      promo,       // Mixed opcional
      fotoUrl: fotoUrlInBody, // puede venir como dataURL o ruta
      foto: fotoInBody        // alias aceptado
    } = req.body;

    if (!patente || !tipoVehiculo || !metodoPago || !factura || monto == null || !descripcion) {
      return res.status(400).json({ msg: "Faltan datos" });
    }

    const operador = getOperadorNombre(req);

    // === FOTO: priorizamos body.fotoUrl / body.foto; si no, reciclamos la del vehículo ===
    let fotoCandidate = fotoUrlInBody || fotoInBody || null;
    let fotoUrl = null;

    if (fotoCandidate) {
      if (isDataUrl(fotoCandidate)) {
        fotoUrl = persistDataUrlToEntradas(fotoCandidate, patente);
      } else {
        fotoUrl = normalizeFotoUrl(fotoCandidate);
      }
    }

    // Sin foto en el body: intentamos del vehículo (estadiaActual o historial)
    if (!fotoUrl) {
      try {
        if (!Vehiculo) Vehiculo = require('../models/Vehiculo');

        // Traemos foto de estadía actual + historial para fallback por ticket o última con foto
        const v = await Vehiculo.findOne({ patente: String(patente).toUpperCase() })
          .select('estadiaActual.fotoUrl historialEstadias.ticket historialEstadias.fotoUrl')
          .lean();

        // 1) estadiaActual
        if (v?.estadiaActual?.fotoUrl) {
          fotoUrl = normalizeFotoUrl(v.estadiaActual.fotoUrl);
        }

        // 2) historial por ticket (si mandaron ticket y aún no resolvimos foto)
        if (!fotoUrl && Number.isFinite(ticket) && Array.isArray(v?.historialEstadias)) {
          const match = v.historialEstadias.find(e => Number(e?.ticket) === Number(ticket) && e?.fotoUrl);
          if (match?.fotoUrl) {
            fotoUrl = normalizeFotoUrl(match.fotoUrl);
          }
        }

        // 3) última del historial con foto
        if (!fotoUrl && Array.isArray(v?.historialEstadias) && v.historialEstadias.length) {
          for (let i = v.historialEstadias.length - 1; i >= 0; i--) {
            const e = v.historialEstadias[i];
            if (e?.fotoUrl) { fotoUrl = normalizeFotoUrl(e.fotoUrl); break; }
          }
        }
      } catch (e) {
        console.warn('[movimientos] no se pudo leer fotoUrl desde Vehiculo:', e.message);
      }
    }

    // ⛔ No aceptamos `fecha`, `createdAt`, `updatedAt` desde el body.
    const nuevoMovimiento = new Movimiento({
      ...(cliente ? { cliente } : {}),
      patente,
      operador,
      tipoVehiculo,
      metodoPago,
      factura,
      monto,
      descripcion,
      tipoTarifa,
      ...(Number.isFinite(ticket) ? { ticket } : {}),
      ...(promo ? { promo } : {}),
      ...(fotoUrl ? { fotoUrl } : {})
    });

    await nuevoMovimiento.save();

    const createdAt = nuevoMovimiento.createdAt || nuevoMovimiento.fecha;

    return res.status(201).json({
      msg: "Movimiento registrado",
      movimiento: {
        ...nuevoMovimiento.toObject(),
        createdAt
      }
    });
  } catch (err) {
    console.error("Error al registrar movimiento:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

// GET /api/movimientos (ordenado por creación real)
exports.obtenerMovimientos = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '0', 10), 0), 500);
    const pipeline = [
      { $addFields: { _createdSort: { $ifNull: ['$createdAt', '$fecha'] } } },
      { $sort: { _createdSort: -1, _id: -1 } }
    ];
    if (limit) pipeline.push({ $limit: limit });

    const movimientos = await Movimiento.aggregate(pipeline);

    const normalizados = movimientos.map(m => ({
      ...m,
      createdAt: m.createdAt || m.fecha
    }));

    return res.json(normalizados);
  } catch (err) {
    console.error('obtenerMovimientos error:', err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

exports.eliminarTodosLosMovimientos = async (_req, res) => {
  try {
    console.log("⚠️ Eliminando todos los movimientos...");
    await Movimiento.deleteMany({});
    console.log("✅ Todos los movimientos fueron eliminados.");
    return res.json({ msg: "Todos los movimientos fueron eliminados correctamente." });
  } catch (err) {
    console.error("💥 Error al eliminar los movimientos:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};
