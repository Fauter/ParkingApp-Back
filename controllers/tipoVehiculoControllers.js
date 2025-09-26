const TipoVehiculo = require('../models/TipoVehiculo');

// GET /api/tipos-vehiculo
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

// POST /api/tipos-vehiculo
exports.crearTipoVehiculo = async (req, res) => {
  let { nombre, hora, mensual } = req.body;

  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ msg: 'Nombre es requerido' });
  }
  nombre = String(nombre).trim();

  try {
    const existente = await TipoVehiculo.findOne({ nombre });
    if (existente) return res.status(409).json({ msg: 'Ya existe ese tipo' });

    const nuevo = new TipoVehiculo({
      nombre,
      hora: !!hora,
      mensual: !!mensual
    });

    await nuevo.save();
    res.status(201).json({
      msg: 'Tipo creado correctamente',
      tipo: { nombre: nuevo.nombre, hora: nuevo.hora, mensual: nuevo.mensual }
    });
  } catch (err) {
    console.error('💥 Error al crear tipo:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

// DELETE /api/tipos-vehiculo/:nombre
exports.eliminarTipoVehiculo = async (req, res) => {
  const { nombre } = req.params;

  try {
    const eliminado = await TipoVehiculo.findOneAndDelete({ nombre });
    if (!eliminado) return res.status(404).json({ msg: 'Tipo no encontrado' });

    res.json({ msg: 'Tipo eliminado correctamente', tipo: nombre });
  } catch (err) {
    console.error('💥 Error al eliminar tipo:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

// PUT /api/tipos-vehiculo/:nombre
// Acepta rename (nuevoNombre) y/o flags (hora/mensual)
exports.actualizarTipoVehiculo = async (req, res) => {
  const { nombre } = req.params;
  const { nuevoNombre, hora, mensual } = req.body;

  if (!nuevoNombre && typeof hora === 'undefined' && typeof mensual === 'undefined') {
    return res.status(400).json({ msg: 'No hay cambios para aplicar' });
  }

  const update = {};
  if (typeof hora !== 'undefined') update.hora = !!hora;
  if (typeof mensual !== 'undefined') update.mensual = !!mensual;

  if (nuevoNombre) {
    const nn = String(nuevoNombre).trim();
    if (!nn) return res.status(400).json({ msg: 'Nuevo nombre requerido' });
    if (nn !== nombre) {
      const ya = await TipoVehiculo.findOne({ nombre: nn });
      if (ya) return res.status(409).json({ msg: 'Ya existe ese tipo con el nuevo nombre' });
    }
    update.nombre = nn;
  }

  try {
    const actualizado = await TipoVehiculo.findOneAndUpdate(
      { nombre },
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!actualizado) return res.status(404).json({ msg: 'Tipo no encontrado' });

    res.json({
      msg: 'Tipo actualizado correctamente',
      tipo: {
        nombre: actualizado.nombre,
        hora: actualizado.hora,
        mensual: actualizado.mensual
      }
    });
  } catch (err) {
    console.error('💥 Error al actualizar tipo:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

// POST /api/tipos-vehiculo/poblar
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
        { $setOnInsert: { nombre: t.nombre, hora: t.hora, mensual: t.mensual } },
        { upsert: true }
      );
    }

    res.json({ msg: 'Tipos de vehículo básicos poblados correctamente' });
  } catch (err) {
    console.error('💥 Error al poblar tipos de vehículo:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};
