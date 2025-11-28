// middleware/sanitizeIds.js
const mongoose = require('mongoose');
const { Types: { ObjectId } } = mongoose;

function toId(v) {
  if (!v) return null;
  if (v instanceof ObjectId) return String(v);
  if (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) return v;
  if (v && typeof v === 'object') {
    if (v._id && typeof v._id === 'string' && /^[0-9a-fA-F]{24}$/.test(v._id)) {
      return v._id;
    }
    if (v.buffer && typeof v.buffer === 'object') {
      try {
        const arr = Object.keys(v.buffer).map(k => v.buffer[k]);
        const buf = Buffer.from(arr);
        if (buf.length === 12 || buf.length === 24) return String(new ObjectId(buf));
      } catch {}
    }
  }
  return null;
}

module.exports = function sanitizeIds(req, _res, next) {
  const keys = [
    'cliente', 'clienteId',
    'vehiculo', 'vehiculoId',
    'cochera', 'cocheraId',
    'abono', 'abonoId'
  ];

  for (const k of keys) {
    if (req.body[k]) {
      const clean = toId(req.body[k]);
      if (clean) req.body[k] = clean;
      else delete req.body[k];
    }
  }

  next();
};
