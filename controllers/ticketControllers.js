const Ticket = require('../models/Ticket');
const Counter = require('../models/Counter');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');

// =====================
// Paths de fotos
// =====================
const FOTOS_DIR = path.join(__dirname, '../uploads/fotos');
const FOTOS_ENTRADAS_DIR = path.join(FOTOS_DIR, 'entradas');
const FOTOS_TICKETS_DIR = path.join(FOTOS_DIR, 'tickets');

[FOTOS_DIR, FOTOS_ENTRADAS_DIR, FOTOS_TICKETS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =====================
// Helpers
// =====================
async function guardarFotoTicket(ticketId, fotoUrl) {
  if (!fotoUrl || !fotoUrl.includes('captura.jpg')) return null;

  try {
    const headResponse = await axios.head(fotoUrl);
    if (headResponse.status !== 200) return null;

    const response = await axios.get(fotoUrl, { 
      responseType: 'arraybuffer',
      validateStatus: status => status === 200
    });

    const buffer = Buffer.from(response.data, 'binary');
    const nombreArchivo = `ticket_${ticketId}.jpg`;
    const rutaArchivo = path.join(FOTOS_ENTRADAS_DIR, nombreArchivo);
    
    fs.writeFileSync(rutaArchivo, buffer);
    return `/uploads/fotos/entradas/${nombreArchivo}`;
  } catch (error) {
    if (error.response && error.response.status === 404) return null;
    console.error('Error al guardar la foto del ticket:', error.message);
    return null;
  }
}

function runPython(scriptPath, args, res, okMsg, errMsg) {
  const pythonProcess = execFile('python', [scriptPath, ...args], {
    encoding: 'utf8',
    windowsHide: true
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ ${errMsg}:`, error);
      return res.status(500).send(`❌ ${errMsg}`);
    }
    console.log(`✅ Salida Python: ${stdout}`);
    if (stderr) console.error(`⚠ Python stderr: ${stderr}`);
    return res.send(okMsg);
  });

  pythonProcess.stdout.on('data', (data) => console.log(`Python stdout: ${data}`));
  pythonProcess.stderr.on('data', (data) => console.error(`Python stderr: ${data}`));
}

// ---- Formateos/compat impresión SALIDA ----
function padTicket10(n) {
  if (n == null) return '0000000000';
  const s = String(n).replace(/\D/g, '');
  return s.padStart(10, '0').slice(-10);
}

function formatIsoToAR(isoMaybe) {
  if (!isoMaybe) return '';
  try {
    const d = new Date(isoMaybe);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
  } catch { return ''; }
}

function formatMontoAR(value) {
  if (value == null || value === '') return '';
  const num = Number(value);
  if (!isFinite(num)) return String(value);
  return '$' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// =====================
// Controllers de dominio
// =====================
exports.crearTicket = async (req, res) => {
  try {
    // nuevo número con Counter
    let nuevoNumero = await Counter.increment('ticket');

    // protección extra por si existiera duplicado
    while (await Ticket.exists({ ticket: nuevoNumero })) {
      console.warn(`⚠️ Ticket ${nuevoNumero} ya existe, avanzando al siguiente`);
      nuevoNumero = await Counter.increment('ticket');
    }

    const nuevoTicket = new Ticket({
      ticket: nuevoNumero,
      estado: 'pendiente'
    });

    await nuevoTicket.save();

    res.status(201).json({
      msg: 'Ticket creado',
      ticket: {
        ...nuevoTicket.toObject(),
        ticketFormateado: String(nuevoTicket.ticket).padStart(10, '0')
      }
    });
  } catch (err) {
    console.error('❌ Error al crear ticket:', err);
    res.status(500).json({ msg: 'Error del servidor', error: err.message });
  }
};

exports.obtenerUltimoTicketPendiente = async (_req, res) => {
  try {
    const ticket = await Ticket.findOne({ estado: 'pendiente' }).sort({ creadoEn: -1 });

    if (!ticket) return res.status(404).json({ msg: 'No hay tickets pendientes' });

    res.json({
      ...ticket.toObject(),
      ticketFormateado: String(ticket.ticket).padStart(6, '0')
    });
  } catch (err) {
    console.error('Error al obtener ticket pendiente:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

exports.asociarTicketAVehiculo = async (req, res) => {
  try {
    const { id } = req.params;
    const { patente, tipoVehiculo, operadorNombre, fotoUrl } = req.body;

    const rutaFotoGuardada = await guardarFotoTicket(id, fotoUrl);

    const ticket = await Ticket.findByIdAndUpdate(
      id,
      {
        patente,
        tipoVehiculo,
        operadorNombre,
        estado: 'asociado',
        fotoUrl: rutaFotoGuardada || fotoUrl
      },
      { new: true }
    );

    if (!ticket) return res.status(404).json({ msg: 'Ticket no encontrado' });

    res.json({ 
      msg: 'Ticket asociado correctamente',
      ticket: {
        ...ticket.toObject(),
        ticketFormateado: String(ticket.ticket).padStart(6, '0')
      }
    });
  } catch (err) {
    console.error('Error al asociar ticket:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

exports.actualizarFotoTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { fotoUrl } = req.body;

    const ticket = await Ticket.findByIdAndUpdate(
      ticketId,
      { fotoUrl },
      { new: true }
    );

    if (!ticket) return res.status(404).json({ msg: 'Ticket no encontrado' });

    res.json({
      msg: 'Foto actualizada correctamente',
      ticket: {
        ...ticket.toObject(),
        ticketFormateado: String(ticket.ticket).padStart(6, '0')
      }
    });
  } catch (err) {
    console.error('Error al actualizar foto del ticket:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

// =====================
// 🖨️ Impresión
// =====================

// Ticket común (barcode) -> imprimir_ticket.py
exports.imprimirTicket = (req, res) => {
  // no enviar a outbox
  res.locals.__skipOutbox = true;

  let { texto, ticketNumero, valorHora, patente, tipoVehiculo } = req.body || {};

  if (ticketNumero !== undefined) {
    texto = String(ticketNumero).padStart(10, '0');
  }
  if (!texto) {
    return res.status(400).send('Falta texto o ticketNumero para imprimir');
  }

  const scriptPath = path.join(__dirname, '..', 'imprimir_ticket.py');
  const arg1 = String(texto).replace(/\n/g, '\\n'); // argv[1]
  const meta = {
    valorHora:    valorHora ? String(valorHora)    : '',
    patente:      patente   ? String(patente)      : '',
    tipoVehiculo: tipoVehiculo ? String(tipoVehiculo) : ''
  };
  const arg2 = JSON.stringify(meta);

  runPython(
    scriptPath,
    [arg1, arg2],
    res,
    '✅ Ticket impreso correctamente',
    'Error al imprimir ticket'
  );
};

// Ticket de ABONO (SIN barcode) -> imprimir_ticket_abono.py
exports.imprimirTicketAbono = (req, res) => {
  // no enviar a outbox
  res.locals.__skipOutbox = true;

  const {
    proporcional,
    valorMensual,
    baseMensual,
    proporcionalRaw,
    nombreApellido,
    metodoPago,
    tipoVehiculo,
    marca,
    modelo,
    patente,
    cochera,
    piso,
    exclusiva,
    diasRestantes
  } = req.body || {};

  const tieneProporcionalString = typeof proporcional === 'string' && proporcional.trim() !== '';
  const tieneProporcionalNum = Number.isFinite(Number(proporcionalRaw));

  if (!tieneProporcionalString && !tieneProporcionalNum) {
    return res.status(400).send('Falta "proporcional" (string) o "proporcionalRaw" (numérico) para imprimir ticket de abono');
  }

  const scriptPath = path.join(__dirname, '..', 'imprimir_ticket_abono.py');
  const arg1 = 'abono';

  const meta = {
    proporcional: tieneProporcionalString ? String(proporcional) : '',
    valorMensual: typeof valorMensual === 'string' ? valorMensual : '',
    baseMensual: Number.isFinite(Number(baseMensual)) ? Number(baseMensual) : undefined,
    proporcionalRaw: Number.isFinite(Number(proporcionalRaw)) ? Number(proporcionalRaw) : undefined,

    nombreApellido: nombreApellido ? String(nombreApellido) : '',
    metodoPago: metodoPago ? String(metodoPago) : '',
    tipoVehiculo: tipoVehiculo ? String(tipoVehiculo) : '',
    marca: marca ? String(marca) : '',
    modelo: modelo ? String(modelo) : '',
    patente: patente ? String(patente) : '',

    cochera: cochera ? String(cochera) : '',
    piso: piso ? String(piso) : '',
    exclusiva: Boolean(exclusiva),

    diasRestantes: Number.isFinite(Number(diasRestantes)) ? Number(diasRestantes) : undefined
  };

  const arg2 = JSON.stringify(meta);

  runPython(
    scriptPath,
    [arg1, arg2],
    res,
    '✅ Ticket de abono impreso correctamente',
    'Error al imprimir ticket de abono'
  );
};

// Ticket de SALIDA (CON barcode) -> imprimir_ticket_salida.py
exports.imprimirTicketSalida = (req, res) => {
  // no enviar a outbox
  res.locals.__skipOutbox = true;

  const {
    texto,
    ticketNumero,
    ingreso,
    egreso,
    totalConDescuento,
    patente,
    tipoVehiculo
  } = req.body || {};

  const barcodeNum = padTicket10(ticketNumero != null ? ticketNumero : texto);

  if (!barcodeNum || !/^\d{10}$/.test(barcodeNum)) {
    return res.status(400).send('Falta ticketNumero/texto válido para barcode (10 dígitos)');
  }

  const ingresoAR = formatIsoToAR(ingreso);
  const egresoAR  = formatIsoToAR(egreso);
  const valorFinalStr = formatMontoAR(totalConDescuento);

  const scriptPath = path.join(__dirname, '..', 'imprimir_ticket_salida.py');
  const arg1 = barcodeNum;

  const meta = {
    valorFinal:   valorFinalStr || (totalConDescuento != null ? String(totalConDescuento) : ''),
    patente:      patente ? String(patente).toUpperCase() : '',
    tipoVehiculo: tipoVehiculo ? String(tipoVehiculo) : '',
    ingreso:      ingresoAR,
    egreso:       egresoAR
  };

  const arg2 = JSON.stringify(meta);

  runPython(
    scriptPath,
    [arg1, arg2],
    res,
    '✅ Ticket de salida impreso correctamente',
    'Error al imprimir ticket de salida'
  );
};

// Ticket de ANTICIPADO (CON barcode) -> imprimir_ticket_anticipado.py
// Acepta (flexible para compat con front actual):
//  - ticketNumero (o texto)         -> barcode
//  - nombreTurno                    -> para la leyenda "(NombreTurno)"
//  - valorAnticipado | precio | valorHora (string o number) -> "(precio)"
//  - patente, tipoVehiculo          -> bajo barcode
//  - (opcional) metodoPago, factura, operador, fin, duracionHoras (no se imprimen ahora, pero pueden viajar)
exports.imprimirTicketAnticipado = (req, res) => {
  // no enviar a outbox
  res.locals.__skipOutbox = true;

  const {
    texto,
    ticketNumero,
    nombreTurno,
    valorAnticipado,
    precio,
    valorHora,        // compat con lo que ya envía DatosAutoTurnos.jsx
    patente,
    tipoVehiculo
  } = req.body || {};

  // Número de barcode: aceptar 6..10 dígitos, pad a 10 (mismo criterio que salida para evitar sorpresas)
  const barcodeNum = padTicket10(ticketNumero != null ? ticketNumero : texto);
  if (!barcodeNum || !/^\d{10}$/.test(barcodeNum)) {
    return res.status(400).send('Falta ticketNumero/texto válido para barcode (10 dígitos)');
  }

  // Precio textual amigable
  let precioTxt = '';
  if (valorAnticipado != null) precioTxt = String(valorAnticipado);
  else if (precio != null)     precioTxt = String(precio);
  else if (valorHora != null)  precioTxt = String(valorHora);

  // Script Python
  const scriptPath = path.join(__dirname, '..', 'imprimir_ticket_anticipado.py');
  const arg1 = barcodeNum;

  const meta = {
    // el script acepta alias: valorAnticipado | precio | valorHora
    valorAnticipado: precioTxt,
    nombreTurno: nombreTurno ? String(nombreTurno) : '',
    patente:      patente ? String(patente).toUpperCase() : '',
    tipoVehiculo: tipoVehiculo ? String(tipoVehiculo) : ''
  };

  const arg2 = JSON.stringify(meta);

  runPython(
    scriptPath,
    [arg1, arg2],
    res,
    '✅ Ticket de anticipado impreso correctamente',
    'Error al imprimir ticket de anticipado'
  );
};
