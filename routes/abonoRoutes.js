// routes/abonoRoutes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
  getAbonos,
  getAbonoPorId,
  registrarAbono,
  eliminarAbonos,
  agregarAbono,
  previewAbono,
  previewRenovacion,
  renovarAbono,
  actualizarAbono,           // NUEVO
  setExclusiva,              // NUEVO
  getAbonosPorCliente,       // NUEVO
  getAbonosPorPatente,       // NUEVO
  getCatalogoCocherasYPisos, // NUEVO
} = require('../controllers/abonoControllers');

const router = express.Router();

// === UPLOADS ===
const BASE_UPLOADS = process.env.UPLOADS_BASE
  ? path.resolve(process.env.UPLOADS_BASE)
  : path.resolve(__dirname, '..', 'uploads');

const FOTOS_DIR = path.join(BASE_UPLOADS, 'fotos');
fs.mkdirSync(FOTOS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FOTOS_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(
      (path.extname(file.originalname || '') || '').toLowerCase()
    );
    if (!ok) return cb(new Error('Formato de imagen no soportado'));
    cb(null, true);
  }
});

const uploadFields = upload.fields([
  { name: 'fotoSeguro', maxCount: 1 },
  { name: 'fotoDNI', maxCount: 1 },
  { name: 'fotoCedulaVerde', maxCount: 1 },
]);

function mapUploadedPaths(req, _res, next) {
  const expected = ['fotoSeguro', 'fotoDNI', 'fotoCedulaVerde'];
  expected.forEach((field) => {
    const f = req.files && req.files[field] && req.files[field][0];
    if (f) {
      const fileName = f.filename || path.basename(f.path);
      req.body[field] = `/uploads/fotos/${fileName}`;
    }
  });
  next();
}

// === RUTAS ===

// Listado con filtros & paginación
router.get('/', getAbonos);

// Catálogo de valores de cochera/pisos (distintos + conteos)
router.get('/catalogo/cocheras-pisos', getCatalogoCocherasYPisos);

// Previews (antes que "/:id")
router.get('/preview', previewAbono);
router.get('/preview-renovacion', previewRenovacion);

// Búsquedas útiles (antes de "/:id")
router.get('/by-cliente/:clienteId', getAbonosPorCliente);
router.get('/by-patente/:patente',   getAbonosPorPatente);

// Detalle por id
router.get('/:id', getAbonoPorId);

// Altas
router.post('/registrar-abono', uploadFields, mapUploadedPaths, registrarAbono);
router.post('/agregar-abono',   uploadFields, mapUploadedPaths, agregarAbono);

// Renovación
router.post('/renovar', renovarAbono);

// Updates
router.patch('/:id', uploadFields, mapUploadedPaths, actualizarAbono);
router.patch('/:id/exclusiva', setExclusiva);

// Borrado masivo
router.delete('/', eliminarAbonos);

module.exports = router;
