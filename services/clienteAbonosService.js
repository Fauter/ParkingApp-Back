/* =======================================================
   clienteAbonosService.js — VERSIÓN NUEVA (CLEANER DESACTIVADO)
   ---------------------------------------------------------
   ⚠️ IMPORTANTE:
   Ya NO limpiamos arrays ni tocamos cliente.abonos ni cliente.vehiculos
   porque ahora se manejan por cochera y abono individual.
======================================================= */

async function cleanClienteById() {
  return { modified: false, reason: "cleaner-disabled" };
}

async function cleanManyClientes() {
  return { modifiedCount: 0, results: [], reason: "cleaner-disabled" };
}

async function cleanAllClientesOnce() {
  return { modifiedCount: 0, results: [], reason: "cleaner-disabled" };
}

module.exports = {
  cleanClienteById,
  cleanManyClientes,
  cleanAllClientesOnce
};
