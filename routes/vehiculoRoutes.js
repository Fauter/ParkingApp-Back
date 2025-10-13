// routes/vehiculoRoutes.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const Vehiculo = require("../models/Vehiculo");

const {
  createVehiculo,
  createVehiculoSinEntrada,
  getVehiculos,
  getVehiculoByPatente,
  getVehiculoById,
  getVehiculoByTicketAdmin,
  getTiposVehiculo,
  asignarAbonoAVehiculo,
  registrarEntrada,
  registrarSalida,
  eliminarTodosLosVehiculos,
  setAbonadoFlagByPatente,
  // ⬇⬇⬇ NUEVOS
  updateVehiculoByPatente,
  syncVehiculoFromAbono,
} = require("../controllers/vehiculoControllers");

const router = express.Router();

/**
 * (Opcional recomendado)
 * const requireAuth = require('../middleware/requireAuth');
 * router.use(requireAuth);
 */

// ---- actualizar costoTotal de la estadía actual por patente
router.put("/:patente/costoTotal", async (req, res) => {
  const patente = (req.params.patente || "").toUpperCase();
  const costoTotalNum = Number(req.body?.costoTotal);
  if (!Number.isFinite(costoTotalNum)) {
    return res.status(400).json({ msg: "Costo total inválido" });
  }
  try {
    const vehiculo = await Vehiculo.findOne({ patente });
    if (!vehiculo) return res.status(404).json({ msg: "Vehículo no encontrado" });
    if (!vehiculo.estadiaActual)
      return res
        .status(400)
        .json({ msg: "No existe estadiaActual para este vehículo" });

    vehiculo.estadiaActual.costoTotal = costoTotalNum;
    await vehiculo.save();
    res.json({ msg: "Costo total actualizado", vehiculo });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Error del servidor" });
  }
});

// ---- CRUD y helpers
router.post("/", createVehiculo);
router.post("/sin-entrada", createVehiculoSinEntrada);
router.get("/", getVehiculos);
router.get("/tipos", getTiposVehiculo);

// Buscar por ticket (versión pública UI handheld)
router.get("/ticket/:ticket", async (req, res) => {
  const ticketNum = parseInt(req.params.ticket, 10);
  if (Number.isNaN(ticketNum))
    return res.status(400).json({ msg: "Ticket inválido" });

  try {
    const vehiculo = await Vehiculo.findOne({
      "estadiaActual.ticket": ticketNum,
    }).select("-historialEstadias -__v");

    if (!vehiculo) {
      return res.status(404).json({
        msg: "No se encontró vehículo con ese ticket",
        ticketBuscado: ticketNum,
        ticketFormateado: String(ticketNum).padStart(10, "0"),
      });
    }

    const v = vehiculo.toObject();
    v.estadiaActual.ticketFormateado = String(
      vehiculo.estadiaActual.ticket
    ).padStart(10, "0");
    res.json(v);
  } catch (err) {
    console.error("Error al buscar por ticket:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
});
router.get("/ticket-admin/:ticket", getVehiculoByTicketAdmin);

// Rutas por ID/patente
router.get("/id/:id", getVehiculoById);
router.get("/:patente", getVehiculoByPatente);

// Entradas y salidas
router.put("/:patente/registrarEntrada", registrarEntrada);
router.put("/:patente/registrarSalida", registrarSalida);

// Abonos
router.put("/asignar-abono/:patente", asignarAbonoAVehiculo);

// (Des)abonar por patente y opcionalmente sacar del cliente
router.patch("/:patente/abonado", setAbonadoFlagByPatente);

// ⬇⬇⬇ NUEVAS RUTAS CLAVE
// 1) Actualizar/renombrar vehículo por patente actual (sin crear si no existe)
router.patch("/:patente", updateVehiculoByPatente);

// 2) Sincronizar vehículo desde un Abono (renombra/actualiza, sin duplicar) + corrige abono.vehiculo
router.patch("/sync-from-abono/:abonoId", syncVehiculoFromAbono);

// Danger zone
router.delete("/", eliminarTodosLosVehiculos);

module.exports = router;
