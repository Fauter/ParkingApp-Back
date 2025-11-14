const express = require("express");
const router = express.Router();

const {
  crearCochera,
  obtenerCocheras,
  obtenerCocheraPorId,
  obtenerCocherasPorCliente,
  actualizarCochera,
  eliminarCochera,
  asignarVehiculo,
  removerVehiculo,
  ensureCochera,
} = require("../controllers/cocheraControllers");

// === ENSURE (idempotente) ===
router.post("/ensure", ensureCochera);

// === CRUD ===
router.post("/", crearCochera);
router.get("/", obtenerCocheras);

// ⚠️ IMPORTANTE: ruta más específica ANTES de "/:id"
router.get("/cliente/:clienteId", obtenerCocherasPorCliente);
router.get("/:id", obtenerCocheraPorId);

router.put("/:id", actualizarCochera);
router.delete("/:id", eliminarCochera);

// === VEHÍCULOS ===
router.post("/asignar-vehiculo", asignarVehiculo);
router.post("/remover-vehiculo", removerVehiculo);

module.exports = router;
