// routes/fotoRoutes.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();

/** Bases alineadas con server.js */
const uploadsBase = process.env.UPLOADS_BASE || path.join(__dirname, '..', 'uploads');
const uploadsDir  = path.resolve(uploadsBase);
const fotosDir    = path.join(uploadsDir, 'fotos');
const entradasDir = path.join(fotosDir, 'entradas');

[uploadsDir, fotosDir, entradasDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/** Util */
function safeJoinUploads(rel) {
  // Normaliza y evita path traversal
  const clean = String(rel || '')
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|\\)/g, '')
    .trim();
  return {
    clean,
    abs: path.join(uploadsDir, clean)
  };
}

/** Multer con destino dinámico según subpath (upload-any) */
const storageAny = multer.diskStorage({
  destination: (req, _file, cb) => {
    const subpath = (req.body?.subpath || '').toString();
    const { abs } = safeJoinUploads(subpath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    cb(null, path.dirname(abs));
  },
  filename: (req, file, cb) => {
    const subpath = (req.body?.subpath || '').toString();
    const { abs } = safeJoinUploads(subpath);
    const fname = path.basename(abs) || path.basename(file.originalname);
    cb(null, fname);
  }
});
const uploadAny = multer({ storage: storageAny });

/** Multer fijo para entradas/ (compat histórica) */
const storageEntradas = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, entradasDir),
  filename: (req, file, cb) => {
    const nombre = (req.body?.nombre || '').toString().trim();
    if (nombre) return cb(null, path.basename(nombre));
    cb(null, path.basename(file.originalname));
  }
});
const uploadEntradas = multer({ storage: storageEntradas });

/** Diagnóstico */
router.get('/where', (_req, res) => {
  res.json({
    uploadsDir, fotosDir, entradasDir,
    existsUploads: fs.existsSync(uploadsDir),
    existsEntradas: fs.existsSync(entradasDir)
  });
});

/** Servir foto puntual (compat antigua) */
router.get('/entradas/:nombreFoto', (req, res) => {
  try {
    const nombre = path.basename(req.params.nombreFoto);
    const fotoPath = path.join(entradasDir, nombre);
    if (!fs.existsSync(fotoPath)) return res.status(404).send('Foto no encontrada');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(fotoPath);
  } catch (e) {
    console.error('Error al servir foto:', e);
    res.status(500).send('Error al cargar la foto');
  }
});

/** Compat: subir SOLO a entradas/ */
router.post('/entradas/upload', uploadEntradas.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta archivo (file)' });
    const nombre = path.basename(req.file.filename);
    const url = `/uploads/fotos/entradas/${nombre}`;
    res.json({ ok: true, url });
  } catch (e) {
    console.error('upload entradas error:', e);
    res.status(500).json({ ok: false, error: 'Upload failed' });
  }
});

/** 🚀 Nuevo: subir a CUALQUIER subruta relativa dentro de /uploads
 *  - campo de archivo: "file"
 *  - body.subpath = 'fotos/entradas/RET123_123.jpg' (o cualquier otra ruta relativa)
 *  Respuesta: { ok:true, url:"/uploads/<subpath>" }
 */
router.post('/upload-any', uploadAny.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta archivo (file)' });
    const subpath = (req.body?.subpath || '').toString();
    const { clean } = safeJoinUploads(subpath);
    if (!clean) return res.status(400).json({ ok: false, error: 'subpath inválido' });
    const url = `/uploads/${clean.replace(/^\/+/, '')}`;
    res.json({ ok: true, url });
  } catch (e) {
    console.error('upload-any error:', e);
    res.status(500).json({ ok: false, error: 'Upload-any failed' });
  }
});

module.exports = router;
