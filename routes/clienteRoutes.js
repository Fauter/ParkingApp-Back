// routes/clienteRoutes.js
const express = require('express');
const router = express.Router();
const {
  obtenerClientes,
  obtenerClientePorNombre,
  obtenerClientePorId,
  crearClienteSiNoExiste,
  actualizarClienteBasico,
  eliminarTodosLosClientes
} = require('../controllers/clienteControllers');

// === LISTADOS / CONSULTAS ===
router.get('/', obtenerClientes);
router.get('/nombre/:nombreApellido', obtenerClientePorNombre);
router.get('/id/:id', obtenerClientePorId);

// === CREAR / ACTUALIZAR ===
router.post('/', crearClienteSiNoExiste);
router.put('/:id', actualizarClienteBasico);

// === BORRADO MASIVO ===
router.delete('/', eliminarTodosLosClientes);

module.exports = router;
