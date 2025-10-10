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
  actualizarAbono,
  setExclusiva,
  getAbonosPorCliente,
  getAbonosPorPatente,
  getCatalogoCocherasYPisos,
  updateVehiculoDeAbono, // 👈 NUEVO
} = require('../controllers/abonoControllers');

const router = express.Router();

// === UPLOADS ===
const BASE_UPLOADS = process.env.UPLOADS_BASE
  ? path.resolve(process.env.UPLOADS_BASE)
  : path.resolve(__dirname, '..', 'uploads');

// Aseguro la carpeta base /uploads/fotos/abonosFotos
const FOTOS_BASE_DIR = path.join(BASE_UPLOADS, 'fotos', 'abonosFotos');
fs.mkdirSync(FOTOS_BASE_DIR, { recursive: true });

// Helpers de path/archivo
function sanitizePatente(p) {
  return String(p || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '') || 'SINPATENTE';
}

function derivePatente(req, file) {
  // 1) Lo normal: viene en el body (FormData)
  let pat = sanitizePatente(req.body?.patente || '');

  // 2) Fallback: si no llegó aún en body, intento leer de originalname con patrón PATENTE_...
  if (!pat && file?.originalname) {
    const m = String(file.originalname).match(/^([A-Z0-9]{5,8})_/i);
    if (m) pat = sanitizePatente(m[1]);
  }

  return pat || 'SINPATENTE';
}

function ensureDirForPatente(pat) {
  const dir = path.join(FOTOS_BASE_DIR, pat);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  // YYYYMMDDHHmmss
  const d = new Date();
  const s = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    s(d.getMonth() + 1) +
    s(d.getDate()) +
    s(d.getHours()) +
    s(d.getMinutes()) +
    s(d.getSeconds())
  );
}

function makeFilename(dir, fieldname, originalname) {
  const ext = (path.extname(originalname || '') || '.jpg').toLowerCase();
  const base = `${fieldname}${ext}`;
  const full = path.join(dir, base);
  if (!fs.existsSync(full)) return base;
  // Si existe, no piso: agrego sufijo timestamp
  return `${fieldname}-${timestamp()}${ext}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const pat = derivePatente(req, file);
      const dir = ensureDirForPatente(pat);
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    try {
      const pat = derivePatente(req, file);
      const dir = ensureDirForPatente(pat);
      const fname = makeFilename(dir, file.fieldname || 'foto', file.originalname || '');
      cb(null, fname);
    } catch (e) {
      cb(e);
    }
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

/**
 * Mapea las rutas físicas a rutas web relativas bajo /uploads
 * En vez de inventar '/uploads/fotos/...' tomamos el path real retornado por multer
 * y construimos la URL web a partir de BASE_UPLOADS.
 */
function mapUploadedPaths(req, _res, next) {
  const expected = ['fotoSeguro', 'fotoDNI', 'fotoCedulaVerde'];

  expected.forEach((field) => {
    const f = req.files && req.files[field] && req.files[field][0];
    if (f && f.path) {
      // f.path apunta a .../uploads/fotos/abonosFotos/<PATENTE>/<field>.(ext)
      const rel = path.relative(BASE_UPLOADS, f.path).split(path.sep).join('/');
      // => 'fotos/abonosFotos/<PATENTE>/<field>.ext'
      req.body[field] = `/uploads/${rel}`;
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

// Altas (NO crean movimientos — el movimiento lo hace el front contra movimientosController)
router.post('/registrar-abono', uploadFields, mapUploadedPaths, registrarAbono);
router.post('/agregar-abono',   uploadFields, mapUploadedPaths, agregarAbono);

// Renovación (NO crea movimientos)
router.post('/renovar', renovarAbono);

// Updates (con upload opcional)
router.patch('/:id', uploadFields, mapUploadedPaths, actualizarAbono);
router.patch('/:id/exclusiva', setExclusiva);

// NUEVO: actualizar / desvincular vehículo del abono
router.patch('/:id/vehiculo', updateVehiculoDeAbono);

// Borrado masivo
router.delete('/', eliminarAbonos);

module.exports = router;
