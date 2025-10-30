// controllers/cierreDeCajaControllers.js
'use strict';
const mongoose = require('mongoose');
const { Types } = mongoose;

const CierreDeCaja = require('../models/CierreDeCaja');
const User = require('../models/User'); // resolver legacy -> username

/* ============================
   Helpers
============================ */

/** ¿Parece un ObjectId (24 hex) y es válido para Mongoose? */
function isLikelyObjectIdString(s) {
  return typeof s === 'string'
    && /^[a-fA-F0-9]{24}$/.test(s)
    && Types.ObjectId.isValid(s);
}

/** Normaliza a username (string) si viene como objeto o string "normal".
 *  Si viene un string que parece ObjectId (24 hex), devuelve null (para tratarlo como legacy id). */
function normalizeOperadorUsername(raw) {
  if (raw == null) return null;

  // Objeto con "username" (o alias)
  if (typeof raw === 'object' && raw !== null) {
    const u = raw.username || raw.user || raw.usuario || raw.name || null;
    if (typeof u === 'string' && u.trim()) return u.trim();
    return null;
  }

  // String / JSON
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;

    // Si parece JSON, intento parsear y extraer username
    if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') {
          const u = parsed.username || parsed.user || parsed.usuario || parsed.name || null;
          if (typeof u === 'string' && u.trim()) return u.trim();
          return null;
        }
      } catch { /* no es JSON, sigo */ }
    }

    // Si es un ObjectId "puro", NO lo tomo como username (lo tratamos como legacy id)
    if (isLikelyObjectIdString(s)) return null;

    // Literal: es un username común
    return s;
  }

  return null;
}

/** Extrae un id legacy (ObjectId/Buffer/obj) como string de 24 hex o null */
function extractLegacyUserId(raw) {
  if (raw == null) return null;

  // ObjectId nativo
  if (raw && typeof raw === 'object' && raw._bsontype === 'ObjectID') {
    try { return String(raw); } catch { return null; }
  }

  // Buffer 12 bytes -> 24 hex
  if (Buffer.isBuffer(raw) && raw.length === 12) {
    const hex = raw.toString('hex');
    return Types.ObjectId.isValid(hex) ? hex : null;
  }

  // { $oid: '...' }
  if (raw && typeof raw === 'object' && typeof raw.$oid === 'string' && Types.ObjectId.isValid(raw.$oid)) {
    return raw.$oid;
  }

  // String 24 hex
  if (typeof raw === 'string' && isLikelyObjectIdString(raw)) return raw;

  // Objeto que esconda id
  if (raw && typeof raw === 'object') {
    const cand = raw._id || raw.id;
    if (typeof cand === 'string' && isLikelyObjectIdString(cand)) return cand;
    if (Buffer.isBuffer(cand) && cand.length === 12) {
      const hex = cand.toString('hex');
      return Types.ObjectId.isValid(hex) ? hex : null;
    }
  }

  return null;
}

/** Aplana un doc a { ... , operador: <username> } usando mapa id->username */
function flattenCierre(doc, usersById) {
  if (!doc) return doc;
  const d = { ...doc };

  // 1) Si ya vino como username válido, úsalo
  let op = normalizeOperadorUsername(d.operador);

  // 2) Si NO, intentar resolver id legacy -> username
  if (!op) {
    const legacyId = extractLegacyUserId(d.operador);
    if (legacyId && usersById && usersById.has(legacyId)) {
      op = usersById.get(legacyId);
    }
  }

  // 3) Fallback final: stringificar lo que haya (para que no crashee)
  if (!op) op = String(d.operador ?? '');

  d.operador = op;
  return d;
}

/* ============================
   GET /api/cierresDeCaja
============================ */
const getAll = async (_req, res) => {
  try {
    const cierres = await CierreDeCaja.find({}).sort({ _id: -1 }).lean();

    // Juntamos ids legacy (incluye strings 24hex, buffers, ObjectId)
    const legacyIds = [];
    for (const c of cierres) {
      if (!normalizeOperadorUsername(c.operador)) {
        const id = extractLegacyUserId(c.operador);
        if (id) legacyIds.push(id);
      }
    }

    let usersById = null;
    if (legacyIds.length) {
      const validIds = [...new Set(legacyIds)].filter(id => Types.ObjectId.isValid(id));
      if (validIds.length) {
        const users = await User.find({ _id: { $in: validIds } }).select('username').lean();
        usersById = new Map(users.map(u => [String(u._id), u.username]));
      }
    }

    const salida = cierres.map(c => flattenCierre(c, usersById));
    res.json(salida);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* ============================
   GET /api/cierresDeCaja/:id
============================ */
const getById = async (req, res) => {
  try {
    const c = await CierreDeCaja.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ message: 'No encontrado' });

    let usersById = null;
    if (!normalizeOperadorUsername(c.operador)) {
      const id = extractLegacyUserId(c.operador);
      if (id && Types.ObjectId.isValid(id)) {
        const u = await User.findById(id).select('username').lean();
        if (u) usersById = new Map([[String(u._id), u.username]]);
      }
    }

    res.json(flattenCierre(c, usersById));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* ============================
   POST /api/cierresDeCaja
   (guarda SIEMPRE operador como username string)
============================ */
const create = async (req, res) => {
  try {
    const { fecha, hora, totalRecaudado, dejoEnCaja, totalRendido, operador } = req.body;

    // 1) ¿Vino username directo?
    let operadorUsername = normalizeOperadorUsername(operador);

    // 2) Si no, ¿vino id legacy? -> buscar username
    if (!operadorUsername) {
      const legacyId = extractLegacyUserId(operador);
      if (legacyId) {
        const u = await User.findById(legacyId).select('username').lean();
        operadorUsername = u?.username || null;
      }
    }

    if (!operadorUsername) {
      return res.status(400).json({ message: "El campo 'operador' es obligatorio y debe resolverse a un username válido" });
    }

    const cierre = await CierreDeCaja.create({
      fecha,
      hora,
      totalRecaudado,
      dejoEnCaja,
      totalRendido,
      operador: operadorUsername,
      retirado: false
    });

    res.status(201).json({
      _id: cierre._id,
      fecha: cierre.fecha,
      hora: cierre.hora,
      totalRecaudado: cierre.totalRecaudado,
      dejoEnCaja: cierre.dejoEnCaja,
      totalRendido: cierre.totalRendido,
      operador: cierre.operador, // username string
      retirado: cierre.retirado,
      createdAt: cierre.createdAt,
      updatedAt: cierre.updatedAt,
      __v: cierre.__v
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

/* ============================
   PUT /api/cierresDeCaja/:id
   (si viene operador, lo normaliza a username string)
============================ */
const updateById = async (req, res) => {
  try {
    const id = req.params.id;
    const body = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(body, 'operador')) {
      let operadorUsername = normalizeOperadorUsername(body.operador);
      if (!operadorUsername) {
        const legacyId = extractLegacyUserId(body.operador);
        if (legacyId) {
          const u = await User.findById(legacyId).select('username').lean();
          operadorUsername = u?.username || null;
        }
      }
      if (!operadorUsername) {
        return res.status(400).json({ message: "El campo 'operador' debe resolverse a un username válido" });
      }
      body.operador = operadorUsername;
    }

    const cierre = await CierreDeCaja.findByIdAndUpdate(
      id,
      body,
      { new: true, runValidators: true, context: 'query' }
    ).lean();

    if (!cierre) return res.status(404).json({ message: 'Cierre de caja no encontrado' });

    res.json(flattenCierre(cierre, null));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

/* ============================
   DELETE /api/cierresDeCaja
============================ */
const deleteAll = async (_req, res) => {
  try {
    await CierreDeCaja.deleteMany({});
    res.json({ message: 'Todos los cierres eliminados' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAll,
  getById,
  create,
  updateById,
  deleteAll,
};
