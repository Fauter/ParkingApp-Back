// routes/movimientoRoutes.js
const express = require('express');
const router = express.Router();
const {
  registrarMovimiento,
  obtenerMovimientos,
  eliminarTodosLosMovimientos
} = require('../controllers/movimientoControllers');

// POST crea SIEMPRE timestamps de mongoose; ignoramos timestamps del body
router.post('/registrar', registrarMovimiento);

// GET ordenado por creación real (createdAt || fecha) DESC
router.get('/', obtenerMovimientos);

// Danger zone: borrar todos (sólo para mantenimiento)
router.delete('/', eliminarTodosLosMovimientos);

module.exports = router;
