// controllers/movimientoControllers.js
'use strict';

const fs = require('fs');
const path = require('path');
const Movimiento = require('../models/Movimiento');
let Vehiculo = null; // lazy require para evitar ciclos

const IDEM_WINDOW_MS = parseInt(process.env.MOV_DEDUP_WINDOW_MS || '2000', 10); // 2s por pedido
const SOFT_DEDUP_MS  = parseInt(process.env.MOV_SOFT_DEDUP_MS  || '15000', 10); // respaldo 15s

// ============================
// 👤 Operador (robusto): req.user > body
// ============================
function pickNonEmpty(...vals) {
  for (const v of vals) {
    const s = (v ?? '').toString().trim();
    if (s) return s;
  }
  return '';
}
function resolveOperadorInfo(req) {
  // 1) Desde auth
  const u = req.user || {};
  const nombreAp = pickNonEmpty(`${u.nombre || ''} ${u.apellido || ''}`);
  const byAuth = pickNonEmpty(u.username, nombreAp);
  const idAuth = (u._id || u.id || '').toString().trim();

  if (byAuth) {
    return { operador: byAuth, operadorId: idAuth || undefined };
  }

  // 2) Desde body (string u objeto)
  const b = req.body || {};
  let operadorStr = '';
  let operadorId = '';

  if (b.operador && typeof b.operador === 'object') {
    operadorStr = pickNonEmpty(b.operador.username, `${b.operador.nombre || ''} ${b.operador.apellido || ''}`, b.operador.email, b.operador.toString && b.operador.toString());
    operadorId = pickNonEmpty(b.operador._id, b.operador.id);
  } else if (b.operador && typeof b.operador === 'string') {
    try {
      // si vino como JSON string (caso reportado):
      const parsed = JSON.parse(b.operador);
      if (parsed && typeof parsed === 'object') {
        operadorStr = pickNonEmpty(parsed.username, `${parsed.nombre || ''} ${parsed.apellido || ''}`, parsed.email);
        operadorId = pickNonEmpty(parsed._id, parsed.id);
      } else {
        operadorStr = b.operador.trim();
      }
    } catch {
      operadorStr = b.operador.trim();
    }
  }

  // 3) Alias directo
  if (!operadorStr) operadorStr = pickNonEmpty(b.operadorUsername, b.username);

  // 4) Fallback
  if (!operadorStr) operadorStr = 'Operador Desconocido';

  return { operador: operadorStr, operadorId: operadorId || undefined };
}

// ============================
// 🗂️ Manejo de fotos
// ============================
const UPLOADS_BASE = process.env.UPLOADS_BASE || path.join(__dirname, '..', 'uploads');
const ENTRADAS_DIR = path.join(UPLOADS_BASE, 'fotos', 'entradas');
const WEBCAM_PROMOS_DIR = path.join(UPLOADS_BASE, 'fotos', 'webcamPromos');

function ensureDirs() {
  try { fs.mkdirSync(ENTRADAS_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(WEBCAM_PROMOS_DIR, { recursive: true }); } catch {}
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

function persistDataUrlToDir(dataUrl, dir, filenameBase) {
  ensureDirs();
  const ext = extFromDataUrl(dataUrl);
  const base64 = dataUrl.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const safeBase = String(filenameBase || 'foto').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const filename = `${safeBase}_${Date.now()}.${ext}`;
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, buf);
  const rel = path.relative(UPLOADS_BASE, abs).replace(/\\/g, '/');
  return `/uploads/${rel}`;
}

function persistDataUrlToEntradas(dataUrl, patente) {
  const safe = `MOV_${String(patente || 'FOTO').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  return persistDataUrlToDir(dataUrl, ENTRADAS_DIR, safe);
}

function persistDataUrlToWebcamPromos(dataUrl, patente) {
  const safe = `PROMO_${String(patente || 'FOTO').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  return persistDataUrlToDir(dataUrl, WEBCAM_PROMOS_DIR, safe);
}

function normalizeFotoUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (isDataUrl(s)) return s; // se persiste afuera si llega así
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

// ============================
// 🔒 Deduplicación defensiva (blanda)
// ============================
async function findRecentDuplicateMovimiento({
  patente, tipoVehiculo, metodoPago, factura, monto, descripcion, tipoTarifa
}) {
  const now = Date.now();
  const since = new Date(now - SOFT_DEDUP_MS);
  return await Movimiento.findOne({
    patente: String(patente).toUpperCase(),
    tipoVehiculo,
    metodoPago,
    factura,
    monto: Number(monto),
    descripcion,
    tipoTarifa,
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 }).lean();
}

// ============================
// 🟢 POST /api/movimientos/registrar
// ============================
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
      promo,                 // opcional: { _id, nombre, descuento, fotoUrl? }
      fotoUrl: fotoUrlInBody,// foto del movimiento
      foto: fotoInBody,      // alias legacy
      operador: _opBody,     // puede venir como string u objeto (soporte en resolveOperadorInfo)
      operadorUsername,      // alias directo
      operadorId: _opIdBody  // opcional para guardar referencia
    } = req.body;

    if (!patente || !tipoVehiculo || !metodoPago || !factura || monto == null || !descripcion) {
      return res.status(400).json({ msg: "Faltan datos" });
    }

    // Operador robusto
    const op = resolveOperadorInfo(req);
    const operador = op.operador || 'Operador Desconocido';
    const operadorId = op.operadorId;

    const patenteUp = String(patente).toUpperCase();
    const montoNum = Number(monto);
    const tarifa = (tipoTarifa ?? '').toString();

    // ── Foto del MOVIMIENTO ───────────────────────────
    let fotoCandidate = fotoUrlInBody || fotoInBody || null;
    let fotoUrl = null;

    if (fotoCandidate) {
      if (isDataUrl(fotoCandidate)) {
        fotoUrl = persistDataUrlToEntradas(fotoCandidate, patenteUp);
      } else {
        fotoUrl = normalizeFotoUrl(fotoCandidate);
      }
    }

    // Sin foto: intentamos recuperar del Vehiculo
    if (!fotoUrl) {
      try {
        if (!Vehiculo) Vehiculo = require('../models/Vehiculo');
        const v = await Vehiculo.findOne({ patente: patenteUp })
          .select('estadiaActual.fotoUrl historialEstadias.ticket historialEstadias.fotoUrl')
          .lean();

        if (v?.estadiaActual?.fotoUrl) {
          fotoUrl = normalizeFotoUrl(v.estadiaActual.fotoUrl);
        }

        if (!fotoUrl && Number.isFinite(Number(ticket)) && Array.isArray(v?.historialEstadias)) {
          const match = v.historialEstadias.find(e => Number(e?.ticket) === Number(ticket) && e?.fotoUrl);
          if (match?.fotoUrl) fotoUrl = normalizeFotoUrl(match.fotoUrl);
        }

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

    // ── Foto PROMO (si viene) ─────────────────────────
    let promoObj = promo && typeof promo === 'object' ? { ...promo } : (promo ?? null);
    if (promoObj && typeof promoObj === 'object' && promoObj.fotoUrl) {
      if (isDataUrl(promoObj.fotoUrl)) {
        promoObj.fotoUrl = persistDataUrlToWebcamPromos(promoObj.fotoUrl, patenteUp);
      } else {
        promoObj.fotoUrl = normalizeFotoUrl(promoObj.fotoUrl);
      }
    }

    // Guard blando (informativo)
    const dupSoft = await findRecentDuplicateMovimiento({
      patente: patenteUp, tipoVehiculo, metodoPago, factura, monto: montoNum, descripcion, tipoTarifa: tarifa
    });
    if (dupSoft) {
      const updates = {};
      if (dupSoft.operador === 'Operador Desconocido' && operador && operador !== 'Operador Desconocido') {
        updates.operador = operador;
      }
      if (!dupSoft.operadorId && operadorId) updates.operadorId = operadorId;
      if (!dupSoft.fotoUrl && fotoUrl) updates.fotoUrl = fotoUrl;
      if (promoObj && !dupSoft.promo) updates.promo = promoObj;

      if (Object.keys(updates).length) {
        const fixed = await Movimiento.findByIdAndUpdate(dupSoft._id, { $set: updates }, { new: true });
        return res.status(200).json({
          msg: "Movimiento (deduplicado) actualizado",
          movimiento: { ...fixed.toObject(), createdAt: fixed.createdAt || fixed.fecha },
          dedup: true,
          mode: 'soft'
        });
      }

      return res.status(200).json({
        msg: "Movimiento ya existente (deduplicado)",
        movimiento: { ...dupSoft, createdAt: dupSoft.createdAt || dupSoft.fecha },
        dedup: true,
        mode: 'soft'
      });
    }

    // Guard duro (índice único con bucket 2s)
    const idemBucket2s = Math.floor(Date.now() / IDEM_WINDOW_MS);

    const baseDoc = {
      ...(cliente ? { cliente } : {}),
      patente: patenteUp,
      operador,
      ...(operadorId ? { operadorId } : {}),
      tipoVehiculo,
      metodoPago,
      factura,
      monto: montoNum,
      descripcion,
      tipoTarifa: tarifa,
      ...(Number.isFinite(Number(ticket)) ? { ticket: Number(ticket) } : {}),
      ...(promoObj ? { promo: promoObj } : {}),
      ...(fotoUrl ? { fotoUrl } : {}),
      idemBucket2s
    };

    try {
      const nuevoMovimiento = new Movimiento(baseDoc);
      await nuevoMovimiento.save();

      const createdAt = nuevoMovimiento.createdAt || nuevoMovimiento.fecha;
      return res.status(201).json({
        msg: "Movimiento registrado",
        movimiento: { ...nuevoMovimiento.toObject(), createdAt },
        dedup: false,
        mode: 'insert'
      });
    } catch (err) {
      // Si colisiona el índice único => ya existe uno idéntico en este bucket
      if (err && err.code === 11000) {
        const existing = await Movimiento.findOne({
          idemBucket2s,
          patente: patenteUp,
          tipoVehiculo,
          metodoPago,
          factura,
          monto: montoNum,
          descripcion,
          tipoTarifa: tarifa
        }).lean();

        if (existing) {
          const patch = {};
          if (existing.operador === 'Operador Desconocido' && operador && operador !== 'Operador Desconocido') {
            patch.operador = operador;
          }
          if (!existing.operadorId && operadorId) patch.operadorId = operadorId;
          if (!existing.fotoUrl && fotoUrl) patch.fotoUrl = fotoUrl;
          if (promoObj && !existing.promo) patch.promo = promoObj;

          let finalDoc = existing;
          if (Object.keys(patch).length) {
            const updated = await Movimiento.findByIdAndUpdate(existing._id, { $set: patch }, { new: true });
            finalDoc = updated.toObject();
          }
          return res.status(200).json({
            msg: "Movimiento ya existente (idempotente)",
            movimiento: { ...finalDoc, createdAt: finalDoc.createdAt || finalDoc.fecha },
            dedup: true,
            mode: 'hard'
          });
        }

        return res.status(409).json({ msg: "Movimiento duplicado en ventana idempotente" });
      }

      console.error("Error al registrar movimiento:", err);
      return res.status(500).json({ msg: "Error del servidor" });
    }
  } catch (err) {
    console.error("Error al registrar movimiento:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

// ============================
// 🔎 GET /api/movimientos
// ============================
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

// ============================
// 🗑️ DELETE /api/movimientos
// ============================
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
