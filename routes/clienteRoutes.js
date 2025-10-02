const express = require('express');
const router = express.Router();
const Cliente = require('../models/Cliente');
const {
  obtenerClientes,
  obtenerClientePorNombre,
  obtenerClientePorId,
  crearClienteSiNoExiste,
  marcarClienteComoAbonado,
  eliminarTodosLosClientes,
  actualizarPrecioAbono,
  desabonarCliente,
  renovarAbono,
  actualizarClienteBasico
} = require('../controllers/clienteControllers');

router.get('/', obtenerClientes);
router.get('/nombre/:nombreApellido', obtenerClientePorNombre);
router.get('/id/:id', obtenerClientePorId);
router.post('/', crearClienteSiNoExiste);
router.put('/marcar-abonado', marcarClienteComoAbonado);
router.put('/:id/actualizar-precio-abono', actualizarPrecioAbono);
router.put('/:id/desabonar', desabonarCliente);
router.post('/:id/renovar-abono', renovarAbono);

// Update básico (nombre, contactos, cochera/exclusiva/piso)
router.put('/:id', actualizarClienteBasico);

router.delete('/', async (_req, res) => {
  try {
    const { deletedCount } = await Cliente.deleteMany({});
    res.json({ message: `Clientes borrados: ${deletedCount}` });
  } catch (err) {
    res.status(500).json({ error: 'Error al borrar clientes', details: err.message });
  }
});

module.exports = router;
