// controllers/movimientoControllers.js
const Movimiento = require('../models/Movimiento');

// operador desde req.user (ignora body.operador)
function getOperadorNombre(req) {
  const u = req.user || {};
  const nombre = (u.nombre || '').trim();
  const apellido = (u.apellido || '').trim();
  const username = (u.username || '').trim();

  if (nombre || apellido) return `${nombre} ${apellido}`.trim();
  if (username) return username;
  return 'Operador Desconocido';
}

// ⚙️ Util: timestamp de creación real (createdAt || fecha)
function movCreatedTs(m) {
  const src = m.createdAt || m.fecha;
  return src ? new Date(src).getTime() : -Infinity;
}

exports.registrarMovimiento = async (req, res) => {
  try {
    const { patente, tipoVehiculo, metodoPago, factura, monto, descripcion, tipoTarifa, ticket, cliente } = req.body;

    if (!patente || !tipoVehiculo || !metodoPago || !factura || monto == null || !descripcion) {
      return res.status(400).json({ msg: "Faltan datos" });
    }

    const operador = getOperadorNombre(req);

    // ⛔ No aceptamos `fecha`, `createdAt`, `updatedAt` desde el body.
    const nuevoMovimiento = new Movimiento({
      ...(cliente ? { cliente } : {}),
      patente,
      operador,
      tipoVehiculo,
      metodoPago,
      factura,
      monto,
      descripcion,
      tipoTarifa,
      ...(Number.isFinite(ticket) ? { ticket } : {})
    });

    await nuevoMovimiento.save();

    // Normalizamos: siempre devolvemos `createdAt` (o `fecha` si no existiese).
    const createdAt = nuevoMovimiento.createdAt || nuevoMovimiento.fecha;

    return res.status(201).json({
      msg: "Movimiento registrado",
      movimiento: {
        ...nuevoMovimiento.toObject(),
        createdAt
      }
    });
  } catch (err) {
    console.error("Error al registrar movimiento:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

// 🧠 GET: siempre ordenado por la creación real (createdAt || fecha) DESC
exports.obtenerMovimientos = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '0', 10), 0), 500); // opcional, seguro
    const pipeline = [
      {
        $addFields: {
          _createdSort: { $ifNull: ['$createdAt', '$fecha'] }
        }
      },
      { $sort: { _createdSort: -1, _id: -1 } }
    ];
    if (limit) pipeline.push({ $limit: limit });

    const movimientos = await Movimiento.aggregate(pipeline);

    // Compatibilidad: garantizamos createdAt si no viene (usando fecha)
    const normalizados = movimientos.map(m => ({
      ...m,
      createdAt: m.createdAt || m.fecha
    }));

    return res.json(normalizados);
  } catch (err) {
    console.error('obtenerMovimientos error:', err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

exports.eliminarTodosLosMovimientos = async (_req, res) => {
  try {
    console.log("⚠️ Eliminando todos los movimientos...");
    await Movimiento.deleteMany({});
    console.log("✅ Todos los movimientos fueron eliminados.");
    return res.json({ msg: "Todos los movimientos fueron eliminados correctamente." });
  } catch (err) {
    console.error("💥 Error al eliminar los movimientos:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};
