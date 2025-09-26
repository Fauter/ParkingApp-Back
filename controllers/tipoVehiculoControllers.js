// controllers/tipoVehiculoControllers.js
const TipoVehiculo = require('../models/TipoVehiculo');

/* Utils */
const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return undefined; // “no vino”
};

const normName = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
};

/* =========================
   GET /api/tipos-vehiculo
========================= */
exports.getTiposVehiculo = async (req, res) => {
  try {
    const tipos = await TipoVehiculo.find({}, 'nombre hora mensual').sort({ nombre: 1 });
    res.json(tipos.map(t => ({
      nombre: t.nombre,
      hora: !!t.hora,
      mensual: !!t.mensual
    })));
  } catch (err) {
    console.error('💥 Error al obtener tipos de vehículo:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================
   POST /api/tipos-vehiculo
   body: { nombre, hora?, mensual? }
========================= */
exports.crearTipoVehiculo = async (req, res) => {
  let { nombre, hora, mensual } = req.body;

  nombre = normName(nombre);
  if (!nombre) return res.status(400).json({ msg: 'Nombre es requerido' });

  try {
    const existente = await TipoVehiculo.findOne({ nombre });
    if (existente) return res.status(409).json({ msg: 'Ya existe ese tipo' });

    const nuevo = new TipoVehiculo({
      nombre,
      hora: !!toBool(hora),
      mensual: !!toBool(mensual)
    });

    await nuevo.save();
    return res.status(201).json({
      msg: 'Tipo creado correctamente',
      tipo: { nombre: nuevo.nombre, hora: nuevo.hora, mensual: nuevo.mensual }
    });
  } catch (err) {
    console.error('💥 Error al crear tipo:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================
   DELETE /api/tipos-vehiculo/:nombre
========================= */
exports.eliminarTipoVehiculo = async (req, res) => {
  const { nombre } = req.params;
  try {
    const eliminado = await TipoVehiculo.findOneAndDelete({ nombre });
    if (!eliminado) return res.status(404).json({ msg: 'Tipo no encontrado' });
    return res.json({ msg: 'Tipo eliminado correctamente', tipo: nombre });
  } catch (err) {
    console.error('💥 Error al eliminar tipo:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================
   PUT /api/tipos-vehiculo/:nombre
   body: { nuevoNombre?, hora?, mensual? }
   - Soporta toggle de flags sin rename
   - Ignora nuevoNombre vacío
========================= */
exports.actualizarTipoVehiculo = async (req, res) => {
  const { nombre } = req.params;

  // Normalizar inputs
  const nuevoNombreInput = normName(req.body?.nuevoNombre);
  const horaInput = toBool(req.body?.hora);
  const mensualInput = toBool(req.body?.mensual);

  // Cargar documento actual
  let doc;
  try {
    doc = await TipoVehiculo.findOne({ nombre });
  } catch (err) {
    console.error('💥 Error buscando tipo:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
  if (!doc) return res.status(404).json({ msg: 'Tipo no encontrado' });

  // Preparar cambios
  const update = {};
  let renameTo = undefined;

  if (typeof horaInput !== 'undefined') update.hora = !!horaInput;
  if (typeof mensualInput !== 'undefined') update.mensual = !!mensualInput;

  if (nuevoNombreInput && nuevoNombreInput !== doc.nombre) {
    renameTo = nuevoNombreInput;
  }

  // Si no hay nada para cambiar, cortar
  const noFlagChange =
    (typeof update.hora === 'undefined' || update.hora === doc.hora) &&
    (typeof update.mensual === 'undefined' || update.mensual === doc.mensual);

  if (!renameTo && noFlagChange) {
    return res.status(200).json({
      msg: 'Sin cambios',
      tipo: { nombre: doc.nombre, hora: doc.hora, mensual: doc.mensual }
    });
  }

  try {
    // Chequear colisión de nombre si hay rename
    if (renameTo) {
      const ya = await TipoVehiculo.findOne({ nombre: renameTo });
      if (ya) return res.status(409).json({ msg: 'Ya existe ese tipo con el nuevo nombre' });
      update.nombre = renameTo;
    }

    // Aplicar cambios
    if (Object.keys(update).length > 0) {
      doc.set(update);
      await doc.save();
    }

    return res.json({
      msg: 'Tipo actualizado correctamente',
      tipo: { nombre: doc.nombre, hora: doc.hora, mensual: doc.mensual }
    });
  } catch (err) {
    console.error('💥 Error al actualizar tipo:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================
   POST /api/tipos-vehiculo/poblar
========================= */
exports.poblarTiposBasicos = async (req, res) => {
  try {
    const tiposBasicos = [
      { nombre: 'auto', hora: true, mensual: true },
      { nombre: 'camioneta', hora: true, mensual: true },
      { nombre: 'moto', hora: true, mensual: true }
    ];

    for (const t of tiposBasicos) {
      await TipoVehiculo.updateOne(
        { nombre: t.nombre },
        {
          $setOnInsert: {
            nombre: t.nombre,
            hora: !!t.hora,
            mensual: !!t.mensual
          }
        },
        { upsert: true }
      );
    }

    return res.json({ msg: 'Tipos de vehículo básicos poblados correctamente' });
  } catch (err) {
    console.error('💥 Error al poblar tipos de vehículo:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};
