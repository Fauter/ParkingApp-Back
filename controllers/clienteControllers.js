const mongoose = require('mongoose');
const Cliente = require('../models/Cliente');
const Vehiculo = require('../models/Vehiculo');
const Movimiento = require('../models/Movimiento');
const MovimientoCliente = require('../models/MovimientoCliente');

// === Derivar estado de abono por fecha (no persiste, solo adorna la respuesta) ===
function deriveEstadoAbono(doc) {
  if (!doc) return doc;
  const now = new Date();
  const obj = doc.toObject ? doc.toObject() : { ...doc };

  let fin = obj.finAbono ? new Date(obj.finAbono) : null;
  if ((!fin || isNaN(fin)) && Array.isArray(obj.abonos) && obj.abonos.length) {
    for (const a of obj.abonos) {
      if (a && a.fechaExpiracion) {
        const f = new Date(a.fechaExpiracion);
        if (!isNaN(f) && (!fin || f > fin)) fin = f;
      }
    }
  }

  if (fin && !isNaN(fin)) {
    obj.finAbono = fin;
    obj.abonado = fin >= now;
  } else {
    obj.abonado = false;
  }

  return obj;
}

exports.crearClienteSiNoExiste = async (req, res) => {
  const datos = req.body;
  const { nombreApellido, dniCuitCuil } = datos;

  if (!nombreApellido || typeof nombreApellido !== 'string' || nombreApellido.trim() === '') {
    return res.status(400).json({ message: 'El campo "nombreApellido" es obligatorio.' });
  }
  if (!dniCuitCuil || typeof dniCuitCuil !== 'string' || dniCuitCuil.trim() === '') {
    return res.status(400).json({ message: 'El campo "dniCuitCuil" es obligatorio.' });
  }

  try {
    const dni = String(datos.dniCuitCuil || '').trim();
    const email = String(datos.email || '').trim().toLowerCase();
    const nombre = String(nombreApellido || '').trim();

    // 🔎 buscar por DNI o email; si nada, fallback a nombre
    let cliente = await Cliente.findOne({
      $or: [
        { dniCuitCuil: dni },
        ...(email ? [{ email }] : []),
        { nombreApellido: nombre }
      ]
    });

    if (!cliente) {
      cliente = new Cliente({
        nombreApellido: nombre,
        dniCuitCuil: dni,
        domicilio: String(datos.domicilio || ''),
        localidad: String(datos.localidad || ''),
        telefonoParticular: String(datos.telefonoParticular || ''),
        telefonoEmergencia: String(datos.telefonoEmergencia || ''),
        domicilioTrabajo: String(datos.domicilioTrabajo || ''),
        telefonoTrabajo: String(datos.telefonoTrabajo || ''),
        email,
        precioAbono: String(datos.precioAbono || '')
      });
      await cliente.save();
      return res.status(201).json(cliente);
    }

    // si existe, actualizar datos básicos (no tocamos arrays/abonado)
    const campos = [
      'dniCuitCuil','domicilio','localidad','telefonoParticular','telefonoEmergencia',
      'domicilioTrabajo','telefonoTrabajo','email','nombreApellido'
    ];
    campos.forEach(k => {
      if (datos[k] !== undefined && datos[k] !== null && String(datos[k]).trim() !== '') {
        cliente[k] = String(datos[k]).trim();
      }
    });
    await cliente.save();
    return res.status(200).json(cliente);

  } catch (err) {
    res.status(500).json({ message: 'Error al crear/actualizar cliente', error: err.message });
  }
};

exports.obtenerClientes = async (_req, res) => {
  try {
    const clientes = await Cliente.find()
      .populate('vehiculos', '_id patente')
      .populate('movimientos')
      .populate('abonos');
    const out = clientes.map(deriveEstadoAbono);
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener clientes', error: err.message });
  }
};

exports.obtenerClientePorNombre = async (req, res) => {
  const { nombreApellido } = req.params;
  try {
    const cliente = await Cliente.findOne({ nombreApellido })
      .populate('vehiculos', '_id patente')
      .populate('abonos'); // 👈 necesario para derivar por fecha si finAbono es null
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json(deriveEstadoAbono(cliente));
  } catch (err) {
    res.status(500).json({ message: 'Error al buscar cliente', error: err.message });
  }
};

exports.obtenerClientePorId = async (req, res) => {
  const { id } = req.params;
  try {
    const cliente = await Cliente.findById(id)
      .populate('vehiculos')
      .populate('movimientos')
      .populate('abonos');
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json(deriveEstadoAbono(cliente));
  } catch (err) {
    res.status(500).json({ message: 'Error al buscar cliente por ID', error: err.message });
  }
};

exports.marcarClienteComoAbonado = async (req, res) => {
  const { nombreApellido } = req.body;
  if (!nombreApellido || typeof nombreApellido !== 'string' || nombreApellido.trim() === '') {
    return res.status(400).json({ message: 'El campo "nombreApellido" es obligatorio.' });
  }
  try {
    const cliente = await Cliente.findOneAndUpdate(
      { nombreApellido: nombreApellido.trim() },
      { abonado: true },
      { new: true }
    );
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado.' });
    res.status(200).json({ message: 'Cliente marcado como abonado.', cliente });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar cliente', error: err.message });
  }
};

exports.actualizarPrecioAbono = async (req, res) => {
  const { id } = req.params;
  const { tipoVehiculo } = req.body;
  try {
    const cliente = await Cliente.findById(id);
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado' });
    if (tipoVehiculo) {
      cliente.precioAbono = tipoVehiculo;
      await cliente.save();
      return res.json({ message: 'Precio de abono actualizado correctamente', cliente });
    }
    res.json(cliente);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar precio de abono', error: err.message });
  }
};

exports.desabonarCliente = async (req, res) => {
  const { id } = req.params;
  try {
    const cliente = await Cliente.findByIdAndUpdate(
      id,
      { $set: { abonado: false, finAbono: null } },
      { new: true }
    ).populate('vehiculos abonos movimientos');
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado' });

    if (cliente.vehiculos?.length) {
      await Promise.all(cliente.vehiculos.map(async (vehiculo) => {
        vehiculo.abonado = false;
        vehiculo.abono = undefined;
        await vehiculo.save();
      }));
    }
    if (cliente.abonos?.length) {
      await Promise.all(cliente.abonos.map(async (abono) => {
        abono.activo = false;
        await abono.save();
      }));
    }

    res.json({
      message: 'Cliente desabonado correctamente',
      cliente: await Cliente.findById(id).populate('vehiculos abonos movimientos')
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al desabonar cliente', error: err.message });
  }
};

exports.renovarAbono = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { precio, metodoPago, factura, operador, patente, tipoVehiculo } = req.body;

    if (!precio || isNaN(precio)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Precio inválido o faltante' });
    }
    if (!metodoPago || !['Efectivo', 'Transferencia', 'Débito', 'Crédito', 'QR'].includes(metodoPago)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Método de pago inválido' });
    }
    if (!tipoVehiculo) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Tipo de vehículo requerido' });
    }

    const cliente = await Cliente.findById(id).populate('abonos').session(session);
    if (!cliente) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }

    const hoy = new Date();
    const ultimoDiaMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    ultimoDiaMes.setHours(23, 59, 59, 999);

    if (cliente.abonos?.length) {
      await Promise.all(cliente.abonos.map(async (abono) => {
        abono.activo = true;
        abono.fechaExpiracion = ultimoDiaMes;
        await abono.save({ session });
      }));
    }

    if (patente) {
      const vehiculo = await Vehiculo.findOne({ patente }).session(session);
      if (vehiculo) {
        vehiculo.abonado = true;
        await vehiculo.save({ session });
      }
    }

    cliente.abonado = true;
    cliente.finAbono = ultimoDiaMes;
    cliente.precioAbono = tipoVehiculo;
    cliente.updatedAt = new Date();
    await cliente.save({ session });

    const movimiento = new Movimiento({
      cliente: id,
      descripcion: `Renovación abono ${tipoVehiculo}`,
      monto: precio,
      tipoVehiculo,
      operador: operador || 'Sistema',
      patente: patente || 'No especificada',
      metodoPago,
      factura: factura || 'CC',
      tipoTarifa: 'abono'
    });
    await movimiento.save({ session });

    const movimientoCliente = new MovimientoCliente({
      cliente: id,
      descripcion: `Renovación abono ${tipoVehiculo}`,
      monto: precio,
      tipoVehiculo,
      operador: operador || 'Sistema',
      patente: patente || 'No especificada',
      fecha: new Date()
    });
    await movimientoCliente.save({ session });

    cliente.movimientos.push(movimientoCliente._id);
    await cliente.save({ session });

    await session.commitTransaction();
    session.endSession();

    const clienteActualizado = await Cliente.findById(id).populate('abonos');
    res.status(200).json({
      message: 'Abono renovado exitosamente. Todos los abonos del cliente han sido activados.',
      cliente: clienteActualizado,
      movimiento,
      movimientoCliente
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error al renovar abono:', error);
    res.status(500).json({
      message: 'Error al renovar abono',
      error: error.message
    });
  }
};

exports.eliminarTodosLosClientes = async (_req, res) => {
  try {
    await Cliente.deleteMany({});
    res.status(200).json({ message: 'Todos los clientes fueron eliminados.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar clientes', error: err.message });
  }
};

// NUEVO: update básico (sin tocar abonos/vehículos) con fallback a _id string
exports.actualizarClienteBasico = async (req, res) => {
  try {
    const { id } = req.params;
    const campos = [
      'nombreApellido','dniCuitCuil','domicilio','localidad',
      'telefonoParticular','telefonoEmergencia','domicilioTrabajo',
      'telefonoTrabajo','email'
    ];
    const data = {};
    campos.forEach(k => { if (k in req.body) data[k] = req.body[k]; });

    let cliente = await Cliente.findByIdAndUpdate(id, data, { new: true });
    if (!cliente) {
      // Fallback: puede que _id sea string en la DB local
      const upd = await Cliente.collection.findOneAndUpdate(
        { _id: String(id) },
        { $set: data },
        { returnDocument: 'after' }
      );
      if (upd && upd.value) {
        cliente = new Cliente(upd.value);
      }
    }
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json({ message: 'Cliente actualizado', cliente });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar cliente', error: err.message });
  }
};
