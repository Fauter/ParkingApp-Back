// controllers/abonoControllers.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Abono = require('../models/Abono');
const Vehiculo = require('../models/Vehiculo');
const Cliente = require('../models/Cliente');

function leerPrecios() {
  try {
    const p = path.join(__dirname, '../data/precios.json');
    return JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function calcularPrecioProporcional(tipoVehiculo, hoy = new Date()) {
  const precios = leerPrecios();
  const tv = (tipoVehiculo || '').toLowerCase();
  const baseCfg = precios[tv] || {};
  const base = Number(baseCfg.mensual) || { auto: 100000, camioneta: 160000, moto: 50000 }[tv] || 100000;

  const ultimoDiaMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  ultimoDiaMes.setHours(23, 59, 59, 999);

  const totalDiasMes = ultimoDiaMes.getDate();
  const diaActual = hoy.getDate();

  const proporcional = (diaActual === 1)
    ? base
    : Math.round((base / totalDiasMes) * (totalDiasMes - diaActual + 1));

  return { precio: proporcional, ultimoDiaMes, totalDiasMes };
}

function buildFotoPath(req, field) {
  const f = req.files?.[field]?.[0]?.filename;
  return f ? `/uploads/fotos/${f}` : (req.body?.[field] || '');
}

async function supportsTransactions() {
  try {
    const admin = mongoose.connection.db.admin();
    let info;
    try { info = await admin.command({ hello: 1 }); }
    catch { info = await admin.command({ isMaster: 1 }); }
    return Boolean(info.setName || info.msg === 'isdbgrid');
  } catch {
    return false;
  }
}

// 🔧 Busca cliente tanto si _id es String como si es ObjectId
async function findClienteFlexible(id, sopt) {
  if (!id) return null;
  const rawId = String(id);

  try {
    const first = await Cliente.collection.findOne(
      { _id: rawId },
      sopt?.session ? { session: sopt.session } : undefined
    );
    if (first) return new Cliente(first);
  } catch {}

  if (mongoose.Types.ObjectId.isValid(rawId)) {
    const byObj = await Cliente.findById(rawId, null, sopt);
    if (byObj) return byObj;
  }

  try {
    const agg = await Cliente.aggregate([
      { $addFields: { _idStr: { $toString: '$_id' } } },
      { $match: { _idStr: rawId } },
      { $limit: 1 },
    ]).session(sopt?.session || null);
    if (agg && agg[0] && agg[0]._id) {
      const again = await Cliente.findById(agg[0]._id, null, sopt);
      if (again) return again;
    }
  } catch {}

  return null;
}

exports.registrarAbono = async (req, res) => {
  console.log('📨 [registrarAbono] body:', JSON.stringify({ ...req.body, _files: !!req.files }, null, 2));

  const canTx = await supportsTransactions();
  const session = canTx ? await mongoose.startSession() : null;
  if (session) session.startTransaction();
  const sopt = session ? { session } : {};

  const created = { vehiculo: null, abono: null, mov: null, movCli: null };

  try {
    const {
      nombreApellido,
      domicilio,
      localidad,
      telefonoParticular,
      telefonoEmergencia,
      domicilioTrabajo,
      telefonoTrabajo,
      email,
      patente,
      marca,
      modelo,
      color,
      anio,
      companiaSeguro,
      metodoPago = 'Efectivo',
      factura = 'CC',
      tipoVehiculo,
      dniCuitCuil,
      cliente: clienteIdBody,
      clienteId: clienteIdAlt,
      operador
    } = req.body;

    const clienteId = clienteIdBody || clienteIdAlt;

    if (!String(nombreApellido || '').trim()) throw new Error('Falta nombreApellido');
    if (!String(email || '').trim()) throw new Error('Falta email');
    if (!String(patente || '').trim()) throw new Error('Falta patente');
    if (!String(tipoVehiculo || '').trim()) throw new Error('Falta tipoVehiculo');
    if (!String(dniCuitCuil || '').trim()) throw new Error('Falta dniCuitCuil');
    if (!clienteId) throw new Error('Falta cliente (ObjectId)');

    const pat = String(patente).trim().toUpperCase();
    const operadorNombre = req.user?.nombre || operador || 'Sistema';

    const { precio, ultimoDiaMes, totalDiasMes } = calcularPrecioProporcional(tipoVehiculo);

    const fotoSeguro       = buildFotoPath(req, 'fotoSeguro');
    const fotoDNI          = buildFotoPath(req, 'fotoDNI');
    const fotoCedulaVerde  = buildFotoPath(req, 'fotoCedulaVerde');

    const cliente = await findClienteFlexible(clienteId, sopt);
    if (!cliente) throw new Error('Cliente no encontrado');

    let vehiculo = await Vehiculo.findOne({ patente: pat }, null, sopt);
    if (!vehiculo) {
      vehiculo = new Vehiculo({
        patente: pat,
        tipoVehiculo,
        marca: marca || '',
        modelo: modelo || '',
        color: color || '',
        anio: anio ? Number(anio) : null,
        abonado: true,
        cliente: cliente._id
      });
      await vehiculo.save(sopt);
      if (!session) created.vehiculo = vehiculo;
      console.log('🚗 Vehículo creado:', vehiculo._id);
    } else {
      vehiculo.tipoVehiculo = tipoVehiculo;
      vehiculo.abonado = true;
      vehiculo.cliente = cliente._id;
      await vehiculo.save(sopt);
      console.log('🔗 Vehículo actualizado/vinculado:', vehiculo._id);
    }

    const AbonoModelo = new Abono({
      nombreApellido: String(nombreApellido).trim(),
      domicilio,
      localidad,
      telefonoParticular,
      telefonoEmergencia,
      domicilioTrabajo,
      telefonoTrabajo,
      email,
      dniCuitCuil,
      patente: pat,
      marca: marca || '',
      modelo: modelo || '',
      color: color || '',
      anio: anio ? Number(anio) : null,
      companiaSeguro: companiaSeguro || '',
      precio,
      metodoPago,
      factura,
      tipoVehiculo,
      tipoAbono: { nombre: 'Mensual', dias: totalDiasMes },
      fechaExpiracion: ultimoDiaMes,
      fotoSeguro,
      fotoDNI,
      fotoCedulaVerde,
      cliente: cliente._id,
      vehiculo: vehiculo._id
    });
    await AbonoModelo.save(sopt);
    if (!session) created.abono = AbonoModelo;
    console.log('🧾 Abono creado:', AbonoModelo._id);

    vehiculo.abono = AbonoModelo._id;
    await vehiculo.save(sopt);

    cliente.abonado = true;
    cliente.finAbono = ultimoDiaMes;
    cliente.precioAbono = tipoVehiculo;

    if (!cliente.abonos.some(id => String(id) === String(AbonoModelo._id))) {
      cliente.abonos.push(AbonoModelo._id);
    }
    if (!cliente.vehiculos.some(id => String(id) === String(vehiculo._id))) {
      cliente.vehiculos.push(vehiculo._id);
    }
    await cliente.save(sopt);
    console.log('🔁 Cliente vinculado a abono/vehículo');

    // 💸 Movimiento (ahora con cliente)
    const Movimiento = require('../models/Movimiento');
    const MovimientoCliente = require('../models/MovimientoCliente');

    const mov = new Movimiento({
      cliente: cliente._id,
      patente: pat,
      operador: operadorNombre,
      tipoVehiculo,
      metodoPago,
      factura,
      monto: precio,
      descripcion: 'Pago por Abono',
      tipoTarifa: 'abono'
    });
    await mov.save(sopt);
    if (!session) created.mov = mov;
    console.log('💸 Movimiento creado:', mov._id);

    const movCli = new MovimientoCliente({
      cliente: cliente._id,
      descripcion: 'Pago por Abono',
      monto: precio,
      tipoVehiculo,
      operador: operadorNombre,
      patente: pat,
      fecha: new Date()
    });
    await movCli.save(sopt);
    if (!session) created.movCli = movCli;

    cliente.movimientos.push(movCli._id);
    await cliente.save(sopt);
    console.log('📒 MovimientoCliente creado y vinculado:', movCli._id);

    if (session) {
      await session.commitTransaction();
      session.endSession();
      console.log('✅ Transacción commit');
    }

    const clientePopulado = await Cliente.findById(cliente._id)
      .populate('vehiculos', '_id patente tipoVehiculo abonado')
      .populate('abonos')
      .populate('movimientos');

    return res.status(201).json({
      message: 'Abono mensual registrado exitosamente',
      abono: AbonoModelo,
      vehiculo,
      cliente: clientePopulado
    });

  } catch (error) {
    console.error('🔥 Error en registrarAbono:', error);

    if (session) {
      try { await session.abortTransaction(); } catch {}
      session.endSession();
      console.log('↩️ Transacción abort');
    } else {
      try {
        const Movimiento = require('../models/Movimiento');
        const MovimientoCliente = require('../models/MovimientoCliente');

        if (created.movCli) await MovimientoCliente.deleteOne({ _id: created.movCli._id });
        if (created.mov)    await Movimiento.deleteOne({ _id: created.mov._id });
        if (created.abono)  await Abono.deleteOne({ _id: created.abono._id });
        if (created.vehiculo) await Vehiculo.deleteOne({ _id: created.vehiculo._id });
        console.log('🧹 Rollback compensatorio ejecutado');
      } catch (e) {
        console.warn('⚠️ Fallo en rollback compensatorio:', e?.message || e);
      }
    }

    return res.status(500).json({ message: 'Error al registrar abono', error: error.message });
  }
};

exports.agregarAbono = async (req, res) => {
  if (!req.body.cliente && req.body.clienteId) {
    req.body.cliente = req.body.clienteId;
  }
  return exports.registrarAbono(req, res);
};

exports.getAbonos = async (_req, res) => {
  try {
    const abonos = await Abono.find().sort({ createdAt: -1 });
    res.status(200).json(abonos);
  } catch (error) {
    console.error('Error al obtener abonos:', error);
    res.status(500).json({ message: 'Error al obtener abonos' });
  }
};

exports.getAbonoPorId = async (req, res) => {
  try {
    const { id } = req.params;
    const abono = await Abono.findById(id);
    if (!abono) return res.status(404).json({ message: 'Abono no encontrado' });
    res.status(200).json(abono);
  } catch (error) {
    console.error('Error al obtener abono por ID:', error);
    res.status(500).json({ message: 'Error al obtener abono por ID' });
  }
};

exports.eliminarAbonos = async (_req, res) => {
  try {
    await Abono.deleteMany({});
    res.status(200).json({ message: 'Todos los abonos fueron eliminados.' });
  } catch (error) {
    console.error('Error al eliminar abonos:', error);
    res.status(500).json({ message: 'Error al eliminar abonos' });
  }
};
