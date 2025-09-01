// routes/cierresDeCaja.js
'use strict';
const express = require('express');
const router = express.Router();

const cierreDeCajaControllers = require('../controllers/cierreDeCajaControllers');
const cierreParcialControllers = require('../controllers/cierreParcialControllers');

// CIERRE PARCIAL 
router.get('/parcial', cierreParcialControllers.getAll);
router.get('/parcial/:id', cierreParcialControllers.getById);
router.post('/parcial', cierreParcialControllers.create);
router.put('/parcial/:id', cierreParcialControllers.updateById);
router.delete('/parcial', cierreParcialControllers.deleteAll);

// CIERRE DE CAJA 
router.get('/', cierreDeCajaControllers.getAll);
router.get('/:id', cierreDeCajaControllers.getById);
router.post('/', cierreDeCajaControllers.create);
router.put('/:id', cierreDeCajaControllers.updateById);
router.delete('/', cierreDeCajaControllers.deleteAll);

module.exports = router;
