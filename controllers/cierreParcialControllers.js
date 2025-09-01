/* eslint-disable no-console */
// controllers/cierreParcialControllers.js
'use strict';

const CierreParcial = require('../models/CierreParcial');
// Si tu modelo de usuario se llama distinto, ajustá esta import
const User = require('../models/User');

const isObjectIdString = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);
const pickUserName = (u) => u?.nombre || u?.name || u?.username || u?.email || null;

// Helper: sanea strings con límite
const sanitizeStr = (v, maxLen) => {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!maxLen) return s;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
};

async function extractOperador(body) {
  let operadorId = null;
  let operadorNombre = null;

  const op = body?.operador;

  if (typeof op === 'object' && op !== null) {
    operadorId = op._id?.toString?.() || op.id || null;
    operadorNombre = op.nombre || op.name || op.username || op.email || body.operadorNombre || null;
  } else if (typeof op === 'string') {
    if (op === '[object Object]') {
      operadorNombre = null;
    } else if (isObjectIdString(op)) {
      operadorId = op;
    } else {
      operadorNombre = op;
    }
  } else if (!op) {
    operadorNombre = body?.operadorNombre || null;
    operadorId = body?.operadorId || null;
  }

  if (operadorId && !operadorNombre) {
    try {
      const user = await User.findById(operadorId).select('nombre name username email').lean();
      operadorNombre = pickUserName(user) || operadorId;
    } catch (_) {}
  }

  return { operadorId, operadorNombre };
}

function normalizeOut(doc, usersById = {}) {
  const d = doc?.toObject ? doc.toObject() : doc;

  let nombreOperador = d.operadorNombre || null;

  if (!nombreOperador) {
    const op = d.operador;
    if (typeof op === 'string') {
      if (op === '[object Object]') {
        nombreOperador = null;
      } else if (isObjectIdString(op)) {
        nombreOperador = usersById[op] || op;
      } else {
        nombreOperador = op;
      }
    } else if (op && typeof op === 'object') {
      nombreOperador = pickUserName(op) || op._id || null;
    }
  }

  // Devuelve `operador` como string amigable (como venías usando en front)
  return {
    ...d,
    operador: nombreOperador || '---',
  };
}

exports.create = async (req, res) => {
  try {
    const payload = { ...req.body };

    // 🧹 Saneamos y limitamos los campos nuevos del front
    payload.nombre = sanitizeStr(payload.nombre, 60);
    payload.texto  = sanitizeStr(payload.texto, 300);

    // Aseguramos monto numérico >= 0 (tu front ya valida, pero reforzamos)
    if (typeof payload.monto !== 'number') {
      payload.monto = Number(payload.monto);
    }
    if (Number.isNaN(payload.monto) || payload.monto < 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const { operadorId, operadorNombre } = await extractOperador(req.body);

    if (operadorId) payload.operadorId = operadorId;
    if (operadorNombre) {
      payload.operadorNombre = operadorNombre;
      payload.operador = operadorNombre; // guardamos string amigable
    } else {
      // fallback para cumplir con schema.required de operador
      payload.operador = payload.operador || '---';
    }

    const saved = await CierreParcial.create(payload);
    res.status(201).json(normalizeOut(saved));
  } catch (err) {
    console.error('Error create CierreParcial:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.getAll = async (req, res) => {
  try {
    const cierres = await CierreParcial.find().lean();

    // Resolver posibles ObjectId guardados en `operador`
    const ids = [
      ...new Set(
        cierres
          .map(d => d.operador)
          .filter(v => typeof v === 'string' && isObjectIdString(v))
      ),
    ];

    let usersById = {};
    if (ids.length) {
      try {
        const users = await User.find({ _id: { $in: ids } })
          .select('nombre name username email')
          .lean();
        usersById = Object.fromEntries(
          users.map(u => [u._id.toString(), pickUserName(u) || u._id.toString()])
        );
      } catch (_) {}
    }

    const out = cierres.map(d => normalizeOut(d, usersById));
    res.json(out);
  } catch (err) {
    console.error('Error getAll CierreParcial:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const cierre = await CierreParcial.findById(req.params.id).lean();
    if (!cierre) return res.status(404).json({ error: 'Cierre no encontrado' });

    let usersById = {};
    if (typeof cierre.operador === 'string' && isObjectIdString(cierre.operador)) {
      try {
        const u = await User.findById(cierre.operador).select('nombre name username email').lean();
        if (u) usersById[cierre.operador] = pickUserName(u) || u._id.toString();
      } catch (_) {}
    }

    res.json(normalizeOut(cierre, usersById));
  } catch (err) {
    console.error('Error getById CierreParcial:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateById = async (req, res) => {
  try {
    const payload = { ...req.body };

    // 🧹 Saneamos y limitamos los campos nuevos
    if ('nombre' in payload) payload.nombre = sanitizeStr(payload.nombre, 60);
    if ('texto'  in payload) payload.texto  = sanitizeStr(payload.texto, 300);

    if ('monto' in payload) {
      if (typeof payload.monto !== 'number') {
        payload.monto = Number(payload.monto);
      }
      if (Number.isNaN(payload.monto) || payload.monto < 0) {
        return res.status(400).json({ error: 'Monto inválido' });
      }
    }

    const { operadorId, operadorNombre } = await extractOperador(req.body);
    if (operadorId) payload.operadorId = operadorId;
    if (operadorNombre) {
      payload.operadorNombre = operadorNombre;
      payload.operador = operadorNombre;
    }

    const actualizado = await CierreParcial.findByIdAndUpdate(req.params.id, payload, { new: true });
    if (!actualizado) return res.status(404).json({ error: 'Cierre no encontrado' });

    res.json(normalizeOut(actualizado));
  } catch (err) {
    console.error('Error updateById CierreParcial:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.deleteAll = async (req, res) => {
  try {
    await CierreParcial.deleteMany();
    res.json({ message: 'Todos los cierres parciales fueron eliminados' });
  } catch (err) {
    console.error('Error deleteAll CierreParcial:', err);
    res.status(500).json({ error: err.message });
  }
};
