// /configuracion/routeToCollection.js
module.exports = {
  // Auth / Users
  '/api/auth': 'users',

  // Vehículos / Abonos / Cocheras
  '/api/vehiculos': 'vehiculos',
  '/api/abonos': 'abonos',
  '/api/cocheras': 'cocheras',

  // Tipos de vehículo (cole correcta: tipovehiculos)
  '/api/tipos-vehiculo': 'tipovehiculos',
  '/api/tipovehiculos': 'tipovehiculos', // alias, por si en algún lado no va el guión

  // Movimientos (ojo con el nombre de colección)
  '/api/movimientos': 'movimientos',
  '/api/movimientoclientes': 'movimientoclientes',

  // Clientes
  '/api/clientes': 'clientes',

  // Cierres de Caja (mapear ambos casings)
  '/api/cierresDeCaja': 'cierresdecajas',
  '/api/cierresdecaja': 'cierresdecajas',

  // Cierres Parciales (ambos casings; cole real: cierreparcials)
  '/api/cierresDeCaja/parcial': 'cierreparcials',
  '/api/cierresdecaja/parcial': 'cierreparcials',

  // Catálogos y otros
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

  // Tickets / Counters
  '/api/tickets': 'tickets',
  '/api/ticket': 'tickets',
  '/api/counters': 'counters',

  '/api/fotos': 'fotos',
};
