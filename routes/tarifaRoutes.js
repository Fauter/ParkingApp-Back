const express = require('express');
const router = express.Router();
const {
  getTarifas,
  createTarifa,
  updateTarifa,
  deleteTarifa
} = require('../controllers/tarifaControllers');

router.get('/', getTarifas);
router.post('/', createTarifa);
router.put('/:id', updateTarifa);
router.delete('/:id', deleteTarifa);

module.exports = router;
