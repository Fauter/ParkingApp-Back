// routes/cocheraRoutes.js
const express = require("express");
const router = express.Router();

const {
  crearCochera,
  obtenerCocheras,
  obtenerCocheraPorId,
  obtenerCocherasPorCliente,
  actualizarCochera,
  eliminarCochera,
  eliminarTodasLasCocheras,
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

// ✅ Actualizar cochera (PUT y PATCH, mismo handler)
router.put("/:id", actualizarCochera);
router.patch("/:id", actualizarCochera);

router.delete("/:id", eliminarCochera);
router.delete("/", eliminarTodasLasCocheras);

// === VEHÍCULOS ===
router.post("/asignar-vehiculo", asignarVehiculo);
router.post("/remover-vehiculo", removerVehiculo);

module.exports = router;
