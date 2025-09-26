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

// === Helpers de precios/fechas ===
function getBaseMensual(tipoVehiculo) {
  const precios = leerPrecios();
  const tv = (tipoVehiculo || '').toLowerCase();
  const cfg = precios[tv] || {};
  const fallback = { auto: 100000, camioneta: 160000, moto: 50000 }[tv];
  const base = Number(cfg.mensual) || (fallback != null ? fallback : 100000);
  return { base, precios };
}

function getUltimoDiaMes(hoy = new Date()) {
  const d = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function prorratearMonto(base, hoy = new Date()) {
  const ultimoDiaMes = getUltimoDiaMes(hoy);
  const totalDiasMes = ultimoDiaMes.getDate();
  const diaActual = hoy.getDate();
  const diasRestantes = (diaActual === 1) ? totalDiasMes : (totalDiasMes - diaActual + 1);
  const factor = diasRestantes / totalDiasMes;
  const proporcional = Math.round(base * factor);
  return { proporcional, ultimoDiaMes, totalDiasMes, diasRestantes, factor };
}

// Máximo “base mensual” ya abonado por el cliente en el mes vigente
async function getClienteMaxBaseMensualVigente(clienteId, hoy = new Date(), sopt) {
  if (!clienteId) return { maxBase: 0 };

  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finMes = getUltimoDiaMes(hoy);

  const abonos = await Abono.find({
    cliente: clienteId,
    activo: true,
    fechaExpiracion: { $gte: inicioMes, $lte: finMes }
  }, null, sopt).lean();

  if (!abonos || !abonos.length) return { maxBase: 0 };

  const { precios } = getBaseMensual(); // sólo para acceder a mapa
  const baseDe = (tipo) => {
    const tv = (tipo || '').toLowerCase();
    const cfg = (precios || {})[tv] || {};
    const fallback = { auto: 100000, camioneta: 160000, moto: 50000 }[tv];
    return Number(cfg.mensual) || (fallback != null ? fallback : 100000);
  };

  let maxBase = 0;
  for (const a of abonos) {
    const b = baseDe(a.tipoVehiculo);
    if (b > maxBase) maxBase = b;
  }
  return { maxBase };
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

/* =========================
   PREVIEWS
========================= */

// GET /api/abonos/preview?clienteId=...&tipoVehiculo=... (&dniCuitCuil=...)
exports.previewAbono = async (req, res) => {
  try {
    let { clienteId, tipoVehiculo, dniCuitCuil } = req.query;
    if (!tipoVehiculo) {
      return res.status(400).json({ error: 'Falta tipoVehiculo' });
    }

    // Resolver cliente por id o por dni (opcional)
    let cliente = null;
    if (clienteId) {
      cliente = await findClienteFlexible(clienteId, null);
    } else if (dniCuitCuil) {
      cliente = await Cliente.findOne({ dniCuitCuil: String(dniCuitCuil).trim() }).lean();
    }

    const hoy = new Date();
    const { base: baseNuevo } = getBaseMensual(tipoVehiculo);
    let baseActual = 0;

    if (cliente && cliente._id) {
      const { maxBase } = await getClienteMaxBaseMensualVigente(cliente._id, hoy, null);
      baseActual = maxBase || 0;
    }

    const diffBase = Math.max(0, baseNuevo - baseActual);
    const { proporcional, ultimoDiaMes, totalDiasMes, diasRestantes, factor } = prorratearMonto(diffBase, hoy);

    return res.json({
      ok: true,
      baseActual,
      baseNuevo,
      diffBase,
      diasRestantes,
      totalDiasMes,
      factor,
      monto: proporcional,
      venceEl: ultimoDiaMes,
      mensaje:
        diffBase > 0
          ? `Vas a meter un vehículo más caro (+$${proporcional} hoy por los días restantes).`
          : (baseActual === 0
              ? `Alta inicial: prorrateo del tipo ${tipoVehiculo}.`
              : `No hay diferencia a pagar (tier igual o más barato).`)
    });
  } catch (e) {
    console.error('previewAbono error:', e);
    return res.status(500).json({ error: 'Error en preview de abono' });
  }
};

// GET /api/abonos/preview-renovacion?clienteId=...
exports.previewRenovacion = async (req, res) => {
  try {
    const { clienteId } = req.query;
    if (!clienteId) return res.status(400).json({ error: 'Falta clienteId' });

    const cliente = await findClienteFlexible(clienteId, null);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Tier a renovar
    let tipo = (cliente.precioAbono || '').toLowerCase();
    if (!tipo) {
      // inferimos del último abono activo o por fecha
      const ultimo = await Abono.findOne({ cliente: cliente._id })
        .sort({ fechaExpiracion: -1, createdAt: -1 })
        .lean();
      tipo = (ultimo?.tipoVehiculo || '').toLowerCase();
    }
    if (!tipo) return res.status(400).json({ error: 'No hay tipo asignado para renovar' });

    const hoy = new Date();
    const { base: baseNuevo } = getBaseMensual(tipo);
    const { proporcional, ultimoDiaMes, totalDiasMes, diasRestantes, factor } = prorratearMonto(baseNuevo, hoy);

    return res.json({
      ok: true,
      tipoVehiculo: tipo,
      baseNuevo,
      diasRestantes,
      totalDiasMes,
      factor,
      monto: proporcional,
      venceEl: ultimoDiaMes,
      mensaje: `Renovación de ${tipo}: $${proporcional} por los días restantes del mes.`
    });
  } catch (e) {
    console.error('previewRenovacion error:', e);
    return res.status(500).json({ error: 'Error en preview de renovación' });
  }
};

/* =========================
   RENOVAR ABONO
========================= */

// POST /api/abonos/renovar
// body: { clienteId, metodoPago, factura, operador, patente?, cochera?, piso?, exclusiva? }
exports.renovarAbono = async (req, res) => {
  const canTx = await supportsTransactions();
  const session = canTx ? await mongoose.startSession() : null;
  if (session) session.startTransaction();
  const sopt = session ? { session } : {};

  try {
    const {
      clienteId,
      metodoPago='Efectivo',
      factura='CC',
      operador,
      patente,
      cochera = '',     // NUEVO: opcional
      piso = '',        // NUEVO: opcional
      exclusiva = false // NUEVO: opcional
    } = req.body;
    if (!clienteId) throw new Error('Falta clienteId');

    const cliente = await findClienteFlexible(clienteId, sopt);
    if (!cliente) throw new Error('Cliente no encontrado');

    // Determinar tipo a renovar
    let tipo = (cliente.precioAbono || '').toLowerCase();
    if (!tipo) {
      const ultimo = await Abono.findOne({ cliente: cliente._id })
        .sort({ fechaExpiracion: -1, createdAt: -1 })
        .lean();
      tipo = (ultimo?.tipoVehiculo || '').toLowerCase();
    }
    if (!tipo) throw new Error('El cliente no tiene tipo asociado para renovar');

    const hoy = new Date();
    const { base: baseNuevo } = getBaseMensual(tipo);
    const { proporcional, ultimoDiaMes, totalDiasMes } = prorratearMonto(baseNuevo, hoy);
    const monto = proporcional;

    const abono = new Abono({
      nombreApellido: cliente.nombreApellido || '',
      domicilio: cliente.domicilio || '',
      localidad: cliente.localidad || '',
      telefonoParticular: cliente.telefonoParticular || '',
      telefonoEmergencia: cliente.telefonoEmergencia || '',
      domicilioTrabajo: cliente.domicilioTrabajo || '',
      telefonoTrabajo: cliente.telefonoTrabajo || '',
      email: cliente.email || '',
      dniCuitCuil: cliente.dniCuitCuil || '',
      patente: (patente || '').toUpperCase(),
      precio: monto,
      metodoPago,
      factura,
      tipoVehiculo: tipo,
      tipoAbono: { nombre: 'Mensual', dias: totalDiasMes },
      fechaExpiracion: ultimoDiaMes,
      cliente: cliente._id,
      activo: true,
      // NUEVO:
      cochera: ['Fija','Móvil'].includes(String(cochera)) ? cochera : '',
      piso: String(piso || ''),
      exclusiva: Boolean(exclusiva)
    });
    await abono.save(sopt);

    // Reactivar cliente
    cliente.abonado = true;
    cliente.finAbono = ultimoDiaMes;
    if (!cliente.precioAbono) cliente.precioAbono = tipo;
    if (!cliente.abonos.some(id => String(id) === String(abono._id))) {
      cliente.abonos.push(abono._id);
    }
    await cliente.save(sopt);

    // Movimiento
    if (monto > 0) {
      const Movimiento = require('../models/Movimiento');
      const MovimientoCliente = require('../models/MovimientoCliente');
      const operadorNombre = req.user?.nombre || operador || 'Sistema';

      const mov = new Movimiento({
        cliente: cliente._id,
        patente: (patente || '').toUpperCase(),
        operador: operadorNombre,
        tipoVehiculo: tipo,
        metodoPago,
        factura,
        monto,
        descripcion: `Renovación abono ${tipo}`,
        tipoTarifa: 'abono'
      });
      await mov.save(sopt);

      const movCli = new (require('../models/MovimientoCliente'))({
        cliente: cliente._id,
        descripcion: `Renovación abono ${tipo}`,
        monto,
        tipoVehiculo: tipo,
        operador: operadorNombre,
        patente: (patente || '').toUpperCase(),
        fecha: new Date()
      });
      await movCli.save(sopt);

      cliente.movimientos.push(movCli._id);
      await cliente.save(sopt);
    }

    if (session) { await session.commitTransaction(); session.endSession(); }

    const clientePop = await Cliente.findById(cliente._id)
      .populate('abonos')
      .populate('vehiculos', '_id patente tipoVehiculo abonado')
      .populate('movimientos');

    return res.status(201).json({
      ok: true,
      message: `Renovación registrada por $${monto}.`,
      cobrado: monto,
      abono,
      cliente: clientePop
    });
  } catch (error) {
    console.error('renovarAbono error:', error);
    if (session) { try { await session.abortTransaction(); } catch {} session.endSession(); }
    return res.status(500).json({ error: error.message || 'Error al renovar abono' });
  }
};

/* =========================
   REGISTRAR / AGREGAR ABONO
========================= */

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
      operador,
      // NUEVO:
      cochera = '',
      piso = '',
      exclusiva = false
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

    // Fotos
    const fotoSeguro       = buildFotoPath(req, 'fotoSeguro');
    const fotoDNI          = buildFotoPath(req, 'fotoDNI');
    const fotoCedulaVerde  = buildFotoPath(req, 'fotoCedulaVerde');

    // Cliente
    const cliente = await findClienteFlexible(clienteId, sopt);
    if (!cliente) throw new Error('Cliente no encontrado');

    // Vehículo (crear o actualizar)
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

    // Cálculo diferencia
    const hoy = new Date();
    const { base: baseNuevo } = getBaseMensual(tipoVehiculo);
    const { maxBase } = await getClienteMaxBaseMensualVigente(cliente._id, hoy, sopt);

    const diffBase = Math.max(0, baseNuevo - maxBase);
    const { proporcional, ultimoDiaMes, totalDiasMes } = prorratearMonto(diffBase, hoy);
    const montoACobrar = proporcional;

    // Crear Abono
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
      precio: montoACobrar,
      metodoPago,
      factura,
      tipoVehiculo,
      tipoAbono: { nombre: 'Mensual', dias: totalDiasMes },
      fechaExpiracion: ultimoDiaMes,
      fotoSeguro,
      fotoDNI,
      fotoCedulaVerde,
      cliente: cliente._id,
      vehiculo: vehiculo._id,
      // === NUEVO ===
      cochera: ['Fija','Móvil'].includes(String(cochera)) ? cochera : '',
      piso: String(piso || ''),
      exclusiva: Boolean(exclusiva)
    });
    await AbonoModelo.save(sopt);
    if (!session) created.abono = AbonoModelo;
    console.log('🧾 Abono creado:', AbonoModelo._id);

    // Vinculaciones
    vehiculo.abono = AbonoModelo._id;
    await vehiculo.save(sopt);

    cliente.abonado = true;
    cliente.finAbono = ultimoDiaMes;

    // Actualizar tier del cliente si corresponde
    if (baseNuevo >= maxBase) {
      cliente.precioAbono = (tipoVehiculo || '').toLowerCase();
    }

    if (!cliente.abonos.some(id => String(id) === String(AbonoModelo._id))) {
      cliente.abonos.push(AbonoModelo._id);
    }
    if (!cliente.vehiculos.some(id => String(id) === String(vehiculo._id))) {
      cliente.vehiculos.push(vehiculo._id);
    }
    await cliente.save(sopt);
    console.log('🔁 Cliente vinculado a abono/vehículo');

    // Movimientos (si hay diferencia)
    if (montoACobrar > 0) {
      const Movimiento = require('../models/Movimiento');
      const MovimientoCliente = require('../models/MovimientoCliente');

      const descripcion =
        maxBase === 0
          ? 'Alta abono'
          : 'Diferencia por cambio a tier más caro';

      const mov = new Movimiento({
        cliente: cliente._id,
        patente: pat,
        operador: operadorNombre,
        tipoVehiculo,
        metodoPago,
        factura,
        monto: montoACobrar,
        descripcion,
        tipoTarifa: 'abono'
      });
      await mov.save(sopt);
      if (!session) created.mov = mov;
      console.log('💸 Movimiento creado:', mov._id);

      const movCli = new MovimientoCliente({
        cliente: cliente._id,
        descripcion,
        monto: montoACobrar,
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
    } else {
      console.log('ℹ️ Sin diferencia a cobrar: no se crean movs.');
    }

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
      message:
        montoACobrar > 0
          ? `Abono registrado. Se cobró $${montoACobrar} de diferencia.`
          : 'Abono registrado sin cargos adicionales.',
      cobrado: montoACobrar,
      abono: AbonoModelo,
      vehiculo,
      cliente: clientePopulado
    });

  } catch (error) {
    console.error('🔥 Error en registrarAbono:', error);

    // Rollback
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

/* =========================
   LISTADOS / BÚSQUEDAS
========================= */

// GET /api/abonos?cochera=Fija|Móvil&exclusiva=true|false&search=...&limit=&skip=&activo=
exports.getAbonos = async (req, res) => {
  try {
    const {
      cochera,
      exclusiva,
      search,
      activo,
      limit = 50,
      skip = 0,
      clienteId,
      patente,
      paginated // << NUEVO toggle
    } = req.query;

    const q = {};

    // Filtros opcionales (no filtra si no los mandás)
    if (cochera !== undefined) {
      const c = String(cochera);
      if (['Fija', 'Móvil', ''].includes(c)) q.cochera = c;
    }
    if (exclusiva === 'true' || exclusiva === 'false') q.exclusiva = (exclusiva === 'true');
    if (activo === 'true' || activo === 'false') q.activo = (activo === 'true');

    if (clienteId && mongoose.Types.ObjectId.isValid(String(clienteId))) q.cliente = clienteId;
    if (patente) q.patente = String(patente).toUpperCase();

    if (search && String(search).trim()) {
      const s = String(search).trim();
      q.$or = [
        { nombreApellido: { $regex: s, $options: 'i' } },
        { email:          { $regex: s, $options: 'i' } },
        { dniCuitCuil:    { $regex: s, $options: 'i' } },
        { patente:        { $regex: s, $options: 'i' } },
        { piso:           { $regex: s, $options: 'i' } },
        { cochera:        { $regex: s, $options: 'i' } },
        { tipoVehiculo:   { $regex: s, $options: 'i' } },
      ];
    }

    const lim = Math.min(Number(limit) || 50, 500);
    const sk = Math.max(Number(skip) || 0, 0);

    const [items, total] = await Promise.all([
      Abono.find(q).sort({ createdAt: -1 }).skip(sk).limit(lim).lean(),
      Abono.countDocuments(q)
    ]);

    // 🔙 Back-compat: por defecto devolvemos ARRAY
    if (String(paginated) === 'true') {
      return res.status(200).json({ total, limit: lim, skip: sk, items });
    }
    return res.status(200).json(items);
  } catch (error) {
    console.error('Error al obtener abonos:', error);
    res.status(500).json({ message: 'Error al obtener abonos' });
  }
};

// GET /api/abonos/by-cliente/:clienteId
exports.getAbonosPorCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(clienteId))) {
      return res.status(400).json({ message: 'clienteId inválido' });
    }
    const items = await Abono.find({ cliente: clienteId }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ total: items.length, items });
  } catch (error) {
    console.error('getAbonosPorCliente error:', error);
    res.status(500).json({ message: 'Error al obtener abonos por cliente' });
  }
};

// GET /api/abonos/by-patente/:patente
exports.getAbonosPorPatente = async (req, res) => {
  try {
    const { patente } = req.params;
    const pat = String(patente || '').toUpperCase();
    if (!pat) return res.status(400).json({ message: 'Patente requerida' });

    const items = await Abono.find({ patente: pat }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ total: items.length, items });
  } catch (error) {
    console.error('getAbonosPorPatente error:', error);
    res.status(500).json({ message: 'Error al obtener abonos por patente' });
  }
};

// GET /api/abonos/catalogo/cocheras-pisos
exports.getCatalogoCocherasYPisos = async (_req, res) => {
  try {
    const agg = await Abono.aggregate([
      {
        $group: {
          _id: null,
          cocheras: { $addToSet: '$cochera' },
          pisos:    { $addToSet: '$piso' }
        }
      },
      {
        $project: {
          _id: 0,
          cocheras: {
            $filter: {
              input: '$cocheras',
              as: 'c',
              cond: { $ne: ['$$c', ''] }
            }
          },
          pisos: {
            $filter: {
              input: '$pisos',
              as: 'p',
              cond: { $ne: ['$$p', ''] }
            }
          }
        }
      }
    ]);

    const counts = await Abono.aggregate([
      {
        $group: {
          _id: { cochera: '$cochera', piso: '$piso' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.cochera': 1, '_id.piso': 1 } }
    ]);

    res.json({
      cocheras: (agg[0]?.cocheras || []).sort(),
      pisos: (agg[0]?.pisos || []).sort(),
      combinaciones: counts.map(c => ({ cochera: c._id.cochera, piso: c._id.piso, count: c.count }))
    });
  } catch (e) {
    console.error('getCatalogoCocherasYPisos error:', e);
    res.status(500).json({ message: 'Error al obtener catálogo de cocheras/pisos' });
  }
};

/* =========================
   DETALLE / UPDATE
========================= */

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

// PATCH /api/abonos/:id  (permite actualizar cochera/piso/exclusiva y fotos; NO rompe campos previos)
exports.actualizarAbono = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    const updates = {};
    const allowed = [
      'nombreApellido','domicilio','localidad','telefonoParticular','telefonoEmergencia',
      'domicilioTrabajo','telefonoTrabajo','email','dniCuitCuil','patente','marca','modelo',
      'color','anio','companiaSeguro','precio','metodoPago','factura','tipoVehiculo',
      'activo',
      // NUEVOS:
      'cochera','piso','exclusiva',
      // Fotos:
      'fotoSeguro','fotoDNI','fotoCedulaVerde'
    ];

    for (const k of allowed) {
      if (k in req.body) {
        updates[k] = req.body[k];
      }
    }

    // Normalizaciones
    if ('patente' in updates && updates.patente) {
      updates.patente = String(updates.patente).toUpperCase();
    }
    if ('anio' in updates && updates.anio != null) {
      updates.anio = Number(updates.anio);
    }
    if ('exclusiva' in updates) {
      updates.exclusiva = String(updates.exclusiva) === 'true' || updates.exclusiva === true;
    }
    if ('cochera' in updates) {
      const c = String(updates.cochera || '');
      updates.cochera = ['Fija','Móvil',''].includes(c) ? c : '';
    }

    // Si vinieron a través de multer:
    const fotoSeguro       = req.files?.fotoSeguro?.[0]?.filename ? `/uploads/fotos/${req.files.fotoSeguro[0].filename}` : null;
    const fotoDNI          = req.files?.fotoDNI?.[0]?.filename ? `/uploads/fotos/${req.files.fotoDNI[0].filename}` : null;
    const fotoCedulaVerde  = req.files?.fotoCedulaVerde?.[0]?.filename ? `/uploads/fotos/${req.files.fotoCedulaVerde[0].filename}` : null;

    if (fotoSeguro) updates.fotoSeguro = fotoSeguro;
    if (fotoDNI) updates.fotoDNI = fotoDNI;
    if (fotoCedulaVerde) updates.fotoCedulaVerde = fotoCedulaVerde;

    const updated = await Abono.findByIdAndUpdate(id, { $set: updates }, { new: true });
    if (!updated) return res.status(404).json({ message: 'Abono no encontrado' });

    res.json({ ok: true, abono: updated });
  } catch (e) {
    console.error('actualizarAbono error:', e);
    res.status(500).json({ message: 'Error al actualizar abono' });
  }
};

// PATCH /api/abonos/:id/exclusiva   body: { exclusiva: true|false }
exports.setExclusiva = async (req, res) => {
  try {
    const { id } = req.params;
    let { exclusiva } = req.body;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'ID inválido' });
    }
    const bool = String(exclusiva) === 'true' || exclusiva === true;
    const updated = await Abono.findByIdAndUpdate(id, { $set: { exclusiva: bool } }, { new: true });
    if (!updated) return res.status(404).json({ message: 'Abono no encontrado' });
    res.json({ ok: true, exclusiva: updated.exclusiva, abono: updated });
  } catch (e) {
    console.error('setExclusiva error:', e);
    res.status(500).json({ message: 'Error al actualizar exclusiva' });
  }
};

/* =========================
   BORRADO MASIVO
========================= */

exports.eliminarAbonos = async (_req, res) => {
  try {
    await Abono.deleteMany({});
    res.status(200).json({ message: 'Todos los abonos fueron eliminados.' });
  } catch (error) {
    console.error('Error al eliminar abonos:', error);
    res.status(500).json({ message: 'Error al eliminar abonos' });
  }
};
