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
  agregarAbono
} = require('../controllers/abonoControllers');

const router = express.Router();

// Base de uploads (coincide con server.js)
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
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB por archivo
    files: 3
  },
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

router.get('/', getAbonos);
router.get('/:id', getAbonoPorId);
router.post('/registrar-abono', uploadFields, mapUploadedPaths, registrarAbono);
router.post('/agregar-abono', uploadFields, mapUploadedPaths, agregarAbono);
router.delete('/', eliminarAbonos);

module.exports = router;
