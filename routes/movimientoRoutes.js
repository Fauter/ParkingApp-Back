// routes/movimientoRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const {
  registrarMovimiento,
  obtenerMovimientos,
  eliminarTodosLosMovimientos
} = require('../controllers/movimientoControllers');

// POST crea con idempotencia dura (índice único + bucket 2s)
router.post('/registrar', registrarMovimiento);

// GET ordenado por creación real (createdAt || fecha) DESC
router.get('/', obtenerMovimientos);

// Danger zone: borrar todos (sólo mantenimiento)
router.delete('/', eliminarTodosLosMovimientos);

module.exports = router;
