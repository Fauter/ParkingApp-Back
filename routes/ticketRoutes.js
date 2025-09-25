const express = require('express');
const ticketController = require('../controllers/ticketControllers');
const barcodeController = require('../controllers/barcodeControllers'); 
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const Ticket = require('../models/Ticket');

const router = express.Router();

/* ===========================
   Helpers para persistencia de foto
=========================== */
const uploadsBase = process.env.UPLOADS_BASE || path.join(process.cwd(), 'uploads');
const entradasDir = path.join(uploadsBase, 'fotos', 'entradas');
if (!fs.existsSync(entradasDir)) fs.mkdirSync(entradasDir, { recursive: true });

// Normaliza una URL interna a un path real en disco
function resolveLocalPathFromUrl(url) {
  if (!url) return null;

  // /api/camara/captura.jpg o /camara/sacarfoto/captura.jpg -> back-end/camara/sacarfoto/captura.jpg
  if (url.includes('/api/camara/captura.jpg') || url.includes('/camara/sacarfoto/captura.jpg')) {
    return path.join(__dirname, '..', 'camara', 'sacarfoto', 'captura.jpg');
  }

  // /uploads/... -> ruta dentro de uploads
  if (url.includes('/uploads/')) {
    const rel = url.split('/uploads/')[1];
    return path.join(uploadsBase, rel);
  }

  return null;
}

/* ===========================
   Rutas
=========================== */

// Obtener todos los tickets
router.get('/', async (req, res) => {
  try {
    const tickets = await Ticket.find().sort({ creadoEn: -1 });
    res.json(tickets);
  } catch (err) {
    console.error('Error al obtener tickets:', err.message);
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// Crear ticket
router.post('/', ticketController.crearTicket);

// Obtener último ticket pendiente
router.get('/pendiente', ticketController.obtenerUltimoTicketPendiente);

// Asociar ticket a vehículo (esta ruta ya PERSISTE foto vía controller.guardarFotoTicket)
router.put('/:id/asociar', ticketController.asociarTicketAVehiculo);

/**
 * 🔐 PERSISTIR foto del ticket desde captura temporal o desde /uploads
 * PUT /api/tickets/:id/foto
 * Body: { fotoUrl: "/camara/sacarfoto/captura.jpg" | "/uploads/fotos/..." }
 */
router.put('/:id/foto', async (req, res) => {
  try {
    const { id } = req.params;
    const { fotoUrl } = req.body || {};
    if (!fotoUrl) return res.status(400).json({ error: 'fotoUrl requerida' });

    const ticket = await Ticket.findById(id);
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

    const src = resolveLocalPathFromUrl(fotoUrl);
    if (!src || !fs.existsSync(src)) {
      return res.status(400).json({ error: 'No existe la captura temporal' });
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    const ticketNum = String(ticket.ticket || ticket._id || 'sinticket');
    const fileName = `entrada_${ticketNum}_${y}${m}${d}_${hh}${mm}${ss}.jpg`;
    const dst = path.join(entradasDir, fileName);

    fs.copyFileSync(src, dst);

    const publicUrl = `/uploads/fotos/entradas/${fileName}`;
    ticket.fotoUrl = publicUrl;
    await ticket.save();

    return res.json({
      ok: true,
      ticket: {
        ...ticket.toObject(),
        ticketFormateado: String(ticket.ticket).padStart(6, '0')
      },
      fotoUrl: publicUrl
    });
  } catch (e) {
    console.error('PUT /tickets/:id/foto error:', e);
    return res.status(500).json({ error: 'Error al guardar foto del ticket' });
  }
});

// Generar código de barras (API)
router.post('/barcode', barcodeController.generateBarcode);

// Imprimir ticket
router.post('/imprimir', (req, res) => {
  // ❌ IMPORTANTE: NO generar Outbox para esta ruta
  res.locals.__skipOutbox = true;

  let { texto, ticketNumero } = req.body;

  // Si viene ticketNumero, usarlo para armar texto solo con número con ceros
  if (ticketNumero !== undefined) {
    const ticketFormateado = String(ticketNumero).padStart(10, '0');
    texto = ticketFormateado;
  } else if (!texto) {
    return res.status(400).send('Falta texto o ticketNumero para imprimir');
  }

  const scriptPath = path.join(__dirname, '..', 'imprimir_ticket.py');
  
  // Convertir saltos de línea para pasar como argumento
  const ticketText = texto.replace(/\n/g, '\\n');
  
  const pythonProcess = execFile('python', [scriptPath, ticketText], { 
    encoding: 'utf8',
    windowsHide: true 
  }, (error, stdout, stderr) => {
    if (error) {
      console.error('❌ Error ejecutando Python:', error);
      return res.status(500).send('❌ Error al imprimir ticket');
    }
    console.log('✅ Salida Python:', stdout);
    if (stderr) {
      console.error('⚠ Advertencia Python:', stderr);
    }
    return res.send('✅ Ticket impreso correctamente');
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`Python stdout: ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`Python stderr: ${data}`);
  });
});

module.exports = router;
