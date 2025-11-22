// /configuracion/routeToCollection.js

module.exports = {
  /* ============================
     AUTH / USERS
  ============================ */
  '/api/auth': 'users',

  /* ============================
     VEHÍCULOS / ABONOS / COCHERAS
  ============================ */
  '/api/vehiculos': 'vehiculos',

  '/api/abonos': 'abonos',
  '/api/abonos/registrar-abono': 'abonos',   // rutas específicas

  /* ---- COCHERAS (TODOS LOS CASOS) ---- */
  '/api/cocheras': 'cocheras',
  '/api/cocheras/': 'cocheras',
  '/api/cocheras/ensure': 'cocheras',
  '/api/cocheras/asignar': 'cocheras',
  '/api/cocheras/remover': 'cocheras',
  '/api/cocheras/eliminar': 'cocheras',
  '/api/cocheras/eliminar-todas': 'cocheras',
  // fallback: **cualquier cosa que comience con /api/cocheras**
  '/api/cocheras/': 'cocheras',

  /* ============================
     TIPOS DE VEHÍCULO
  ============================ */
  '/api/tipos-vehiculo': 'tipovehiculos',
  '/api/tipovehiculos': 'tipovehiculos', // alias

  /* ============================
     MOVIMIENTOS
  ============================ */
  '/api/movimientos': 'movimientos',
  '/api/movimientos/registrar': 'movimientos',
  '/api/movimientoclientes': 'movimientoclientes',

  /* ============================
     CLIENTES
  ============================ */
  '/api/clientes': 'clientes',

  /* ============================
     CIERRES DE CAJA
  ============================ */
  '/api/cierresDeCaja': 'cierresdecajas',
  '/api/cierresdecaja': 'cierresdecajas',

  /* PARCIALES */
  '/api/cierresDeCaja/parcial': 'cierreparcials',
  '/api/cierresdecaja/parcial': 'cierreparcials',

  /* ============================
     CATÁLOGOS
  ============================ */
  '/api/parametros': 'parametros',
  '/api/impresoras': 'impresoras',
  '/api/precios': 'precios',
  '/api/alertas': 'alertas',
  '/api/auditorias': 'auditorias',
  '/api/promos': 'promos',
  '/api/tarifas': 'tarifas',
  '/api/incidentes': 'incidentes',
  '/api/turnos': 'turnos',
  '/api/config': 'config',

  /* ============================
     TICKETS / COUNTERS
  ============================ */
  '/api/tickets': 'tickets',
  '/api/ticket': 'tickets',
  '/api/counters': 'counters',

  /* ============================
     FOTOS
  ============================ */
  '/api/fotos': 'fotos',
};
