const express = require('express');
const path = require('path');
const fs = require('fs');

const ticketController = require('../controllers/ticketControllers');
const barcodeController = require('../controllers/barcodeControllers');
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

// Obtener todos los tickets (últimos primero)
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

// Asociar ticket a vehículo
router.put('/:id/asociar', ticketController.asociarTicketAVehiculo);

/**
 * 🔐 PERSISTIR foto del ticket desde captura temporal o desde /uploads
 * PUT /api/tickets/:id/foto
 * Body: { fotoUrl: "/camara/sacarfoto/captura.jpg" | "/uploads/fotos/..." }
 */
router.put('/:id/foto', async (req, res) => {
  try {
    const { id } = req.params;
    const { fotoUrl } = req.body;
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

// 🖨️ Imprimir ticket común (con barcode)
router.post('/imprimir', ticketController.imprimirTicket);

// 🖨️ Imprimir ticket de ABONO (SIN barcode)
router.post('/imprimir-abono', ticketController.imprimirTicketAbono);

// 🖨️ Imprimir ticket de SALIDA (CON barcode)
router.post('/imprimir-salida', ticketController.imprimirTicketSalida);

// 🖨️ Imprimir ticket de ANTICIPADO (CON barcode y leyenda específica)
router.post('/imprimir-anticipado', ticketController.imprimirTicketAnticipado);

// 🖨️ **NUEVO**: Imprimir ticket de CIERRE (caja/parcial) – SIN barcode
// Body: { tipo: "cierreDeCaja" | "cierreParcial", cierre?: {...}, parcial?: {...}, operador?: {...} }
router.post('/imprimir-cierredecaja', ticketController.imprimirTicketCierreCaja);

module.exports = router;
