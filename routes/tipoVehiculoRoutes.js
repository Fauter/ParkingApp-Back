const express = require('express');
const router = express.Router();
const {
  poblarTiposBasicos,
  getTiposVehiculo,
  crearTipoVehiculo,
  eliminarTipoVehiculo,
  actualizarTipoVehiculo
} = require('../controllers/tipoVehiculoControllers');

// /api/tipos-vehiculo
router.post('/poblar', poblarTiposBasicos);
router.get('/', getTiposVehiculo);
router.post('/', crearTipoVehiculo);
router.delete('/:nombre', eliminarTipoVehiculo);
router.put('/:nombre', actualizarTipoVehiculo);

module.exports = router;
