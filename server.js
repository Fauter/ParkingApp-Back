// server.js
require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { MongoClient } = require('mongodb'); // para leer max remoto de tickets

const { startLocalMongo, stopLocalMongo } = require('./services/localMongo');
// ⬇️ IMPORTANTE: offlineMiddleware se monta DESPUÉS de los handlers especiales
const offlineMiddleware = require('./middlewares/offlineMiddleware');
const { startPeriodicSync } = require('./services/syncService');

const app = express();
app.disable('x-powered-by');

// Helper: normaliza módulos de rutas que exportan {router}, default, etc.
const normalizeRouter = (m) => {
  if (typeof m === 'function') return m;               // ya es un Router
  if (m && typeof m === 'object') {
    return m.router || m.default || m.routes || m.route || m;
  }
  return m;
};

// =====================
// 🛡️ CORS robusto
// =====================
const DEFAULT_ALLOWED = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'https://admin.garageia.com',
  'https://operador.garageia.com',
  // esquemas
  'app://',
  'file://',
  'capacitor://',
  'tauri://'
];
const ENV_ALLOWED = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...DEFAULT_ALLOWED, ...ENV_ALLOWED])];

// Compila cada item a RegExp (soporta '*')
function compileOriginPatterns(list) {
  return list.map(item => {
    const s = item.replace(/\/+$/, '');
    if (s === 'null') return { type: 'null' };
    if (s.endsWith('://')) return { type: 'scheme', value: s };
    const rx = new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m).replace(/\\\*/g, '.*') + '$');
    return { type: 'regex', value: rx };
  });
}
const originPatterns = compileOriginPatterns(allowedOrigins);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  for (const rule of originPatterns) {
    if (rule.type === 'null' && origin === 'null') return true;
    if (rule.type === 'scheme' && origin.startsWith(rule.value)) return true;
    if (rule.type === 'regex' && rule.value.test(origin)) return true;
  }
  return false;
}

app.use(cors({
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('No permitido por CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Body parsers
const BODY_LIMIT = process.env.BODY_LIMIT || '50mb';
app.use(cookieParser());
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// =====================
// 📂 UPLOADS (estáticos) — una sola vez acá
// =====================
// Todo esto va a rutas ESCRIBIBLES. Electron main nos pasa UPLOADS_BASE y CAMARA_DIR.
const baseUploads = process.env.UPLOADS_BASE || path.join(process.cwd(), 'uploads');
const uploadsDir = path.resolve(baseUploads);
const fotosDir = path.join(uploadsDir, 'fotos');
const entradasDir = path.join(fotosDir, 'entradas');
const auditoriasDir = path.join(uploadsDir, 'auditorias');

// Cámara (sacarfoto) fuera del asar:
const camaraBaseDir = process.env.CAMARA_DIR || path.join(uploadsDir, 'camara');
const sacarfotoDir = path.join(camaraBaseDir, 'sacarfoto');

[uploadsDir, fotosDir, entradasDir, auditoriasDir, camaraBaseDir, sacarfotoDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/uploads', express.static(uploadsDir, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

app.use('/uploads/fotos', express.static(fotosDir, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Credentials', 'false');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

app.use('/uploads/auditorias', express.static(auditoriasDir, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

// ⬅️ IMPORTANTÍSIMO: servir /camara/sacarfoto desde carpeta ESCRIBIBLE
app.use('/camara/sacarfoto', express.static(sacarfotoDir, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

/* =======================================================
   LOGS PRECIOS (diagnóstico)
   — Ubicado tras definir uploads y antes de montar rutas
   — Consolidados para activar/desactivar fácil
========================================================== */
console.log('========== LOGS PRECIOS ==========');
console.log(`[precios] PRECIOS_REMOTE_URL=${process.env.PRECIOS_REMOTE_URL || 'https://api.garageia.com/api/precios'}`);
console.log(`[precios] PRECIOS_CACHE_FILE=${process.env.PRECIOS_CACHE_FILE || '(default under uploads/cache/precios.json)'}`);
if (String(process.env.PRECIOS_DEBUG || '').trim() === '1') {
  console.log('[precios] DEBUG habilitado (PRECIOS_DEBUG=1)');
}
console.log('==================================');

// Health/status liviano del server (no del sync)
let syncStatus = { lastRun: null, lastError: null, online: false, pendingOutbox: 0, lastPullCounts: {} };

// =====================
// 🔄 Sincronización de counters (local >= max(local, remoto))
// =====================
async function sincronizarCounters() {
  const Ticket = require('./models/Ticket');
  const Counter = require('./models/Counter');

  // Max local robusto
  let localMax = 0;
  try {
    const localAgg = await Ticket.collection.aggregate([
      { $project: { t: { $convert: { input: '$ticket', to: 'double', onError: 0, onNull: 0 } } } },
      { $group: { _id: null, max: { $max: '$t' } } }
    ]).toArray();
    if (localAgg[0] && Number.isFinite(localAgg[0].max)) localMax = localAgg[0].max;
  } catch {
    const localMaxDoc = await Ticket.findOne().sort({ ticket: -1 }).select('ticket').lean();
    localMax = (localMaxDoc && typeof localMaxDoc.ticket === 'number' && !isNaN(localMaxDoc.ticket))
      ? localMaxDoc.ticket : 0;
  }

  // Max remoto (si hay Atlas disponible)
  const atlasUri = process.env.MONGO_URI;
  const remoteDbName = process.env.MONGO_DBNAME_REMOTE || process.env.MONGO_DBNAME || 'parking';

  let remoteMax = 0;
  if (atlasUri) {
    let client = null;
    try {
      client = new (require('mongodb').MongoClient)(atlasUri, { serverSelectionTimeoutMS: 2500 });
      await client.connect();
      const remoteAgg = await client.db(remoteDbName).collection('tickets').aggregate([
        { $project: { t: { $convert: { input: '$ticket', to: 'double', onError: 0, onNull: 0 } } } },
        { $group: { _id: null, max: { $max: '$t' } } }
      ]).toArray();
      if (remoteAgg[0] && Number.isFinite(remoteAgg[0].max)) remoteMax = remoteAgg[0].max;
    } catch (e) {
      console.warn('[server] no se pudo leer max ticket remoto:', e.message);
    } finally {
      try { if (client) await client.close(); } catch {}
    }
  }

  const maxNumero = Math.max(localMax, remoteMax || 0);
  const seqActual = await Counter.ensureAtLeast('ticket', maxNumero);
  console.log(`✅ Counter 'ticket' sincronizado. seq actual: ${seqActual} (>= ${maxNumero})`);
}

// Exponer status básico
app.get('/api/status', (_req, res) => {
  res.json({
    online: true,
    mode: process.env.NODE_ENV || 'development',
    timestamp: new Date(),
    dbName: mongoose?.connection?.name || null,
    syncStatus
  });
});

/**
 * ⛑️ Handler ESPECIAL para borrar la foto temporal de la cámara.
 */
app.delete('/api/vehiculos/eliminar-foto-temporal', (_req, res) => {
  try {
    const fotoPath = path.join(sacarfotoDir, 'captura.jpg');
    if (fs.existsSync(fotoPath)) {
      fs.unlinkSync(fotoPath);
      return res.json({ msg: "Foto temporal eliminada" });
    }
    return res.json({ msg: "No se encontró foto temporal" });
  } catch (err) {
    console.error("Error al eliminar foto temporal:", err);
    return res.status(500).json({ msg: "Error del servidor", error: err.message });
  }
});

/**
 * 🔔 Endpoint ESPECIAL para disparar el pull “YA”
 */
let syncHandle = null;
app.post('/api/sync/run-now', async (_req, res) => {
  try {
    if (!syncHandle) return res.status(503).json({ error: 'sync deshabilitado' });
    await syncHandle.runOnce();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Status del sincronizador (del handle)
app.get('/api/sync/status', (_req, res) => {
  try {
    const handleStatus = syncHandle ? syncHandle.getStatus() : null;
    return res.json({ ok: true, handleStatus, serviceStatus: syncStatus });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * 🔍 Diagnóstico remoto: contadores por colección y DB en uso
 */
app.get('/api/sync/inspect', async (req, res) => {
  try {
    if (!syncHandle) return res.status(503).json({ error: 'sync deshabilitado' });
    const cols = String(req.query.cols || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const info = await syncHandle.inspectRemote(cols);
    return res.json({ ok: true, ...info });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

async function main() {
  try {
    const { uri } = await startLocalMongo();

    await mongoose.connect(uri, {
      dbName: process.env.MONGO_DBNAME || 'parking_local',
      retryWrites: true,
      w: 'majority'
    });

    console.log('✅ Conectado a Mongo local (Replica Set)');
    console.log('   URI:', uri);

    await sincronizarCounters();

    // ⏱️ Cron turnos: inicia y corre una vuelta (se auto-programa cada minuto)
    require('./cron/turnoChecker');
    require('./cron/abonoChecker');

    // ⬇️ A PARTIR DE ACÁ se capturan requests para Outbox
    app.use(offlineMiddleware);

    // ---- Rutas ----
    const authRoutes               = require('./routes/authRoutes.js');
    const vehiculoRoutes           = require('./routes/vehiculoRoutes');
    const abonoRoutes              = require('./routes/abonoRoutes');
    const tipoVehiculoRoutes       = require('./routes/tipoVehiculoRoutes');
    const movimientoRoutes         = require('./routes/movimientoRoutes');
    const movimientoClienteRoutes  = require('./routes/movimientoClienteRoutes');
    const tarifaRoutes             = require('./routes/tarifaRoutes');
    const preciosRoutes            = require('./routes/precios');
    const parametrosRoutes         = require('./routes/parametros.js');
    const calcularTarifaRoutes     = require('./routes/calcularTarifaRoutes.js');
    const turnoRoutes              = require('./routes/turnoRoutes.js');
    const clienteRoutes            = require('./routes/clienteRoutes');
    const promoRoutes              = require('./routes/promoRoutes');
    const cierreDeCajaRoutes       = require('./routes/cierreDeCajaRoutes');
    const incidenteRoutes          = require('./routes/incidenteRoutes');
    const alertaRoutes             = require('./routes/alertaRoutes');
    const auditoriaRoutes          = require('./routes/auditoriaRoutes');
    const camaraRoutes             = require('./routes/camaraRoutes');
    const ticketRoutes             = require('./routes/ticketRoutes');
    const counterRoutes            = require('./routes/counterRoutes');
    const fotoRoutes               = require('./routes/fotoRoutes');
    const impresoraRoutes          = require('./routes/impresoraRoutes');
    const configRoutes             = require('./routes/configRoutes');

    // Montaje con normalización defensiva
    app.use('/api/auth',               normalizeRouter(authRoutes));
    app.use('/api/vehiculos',          normalizeRouter(vehiculoRoutes));
    app.use('/api/abonos',             normalizeRouter(abonoRoutes));
    app.use('/api/tipos-vehiculo',     normalizeRouter(tipoVehiculoRoutes));
    app.use('/api/movimientos',        normalizeRouter(movimientoRoutes));
    app.use('/api/movimientosClientes',normalizeRouter(movimientoClienteRoutes));
    app.use('/api/tarifas',            normalizeRouter(tarifaRoutes));
    app.use('/api/precios',            normalizeRouter(preciosRoutes));
    app.use('/api/parametros',         normalizeRouter(parametrosRoutes));
    app.use('/api/calcular-tarifa',    normalizeRouter(calcularTarifaRoutes));
    app.use('/api/turnos',             normalizeRouter(turnoRoutes));
    app.use('/api/clientes',           normalizeRouter(clienteRoutes));
    app.use('/api/promos',             normalizeRouter(promoRoutes));
    app.use('/api/cierresDeCaja',      normalizeRouter(cierreDeCajaRoutes));
    app.use('/api/incidentes',         normalizeRouter(incidenteRoutes));
    app.use('/api/alertas',            normalizeRouter(alertaRoutes));
    app.use('/api/auditorias',         normalizeRouter(auditoriaRoutes));
    app.use('/api/camara',             normalizeRouter(camaraRoutes));
    app.use('/api/webcam',             require('./routes/webcam'));
    // ⬇️ esta ruta ya está montada arriba con 'sacarfotoDir'; la dejo por compat pero no sirve archivos:
    // app.use('/camara/sacarfoto', express.static(path.join(__dirname, 'camara', 'sacarfoto'), { index: false, dotfiles: 'deny' }));
    app.use('/api/fotos',              normalizeRouter(fotoRoutes));
    app.use('/api/tickets',            normalizeRouter(ticketRoutes));
    app.use('/api/ticket',             normalizeRouter(ticketRoutes));
    app.use('/api/counters',           normalizeRouter(counterRoutes));
    app.use('/api/impresoras',         normalizeRouter(impresoraRoutes));
    app.use('/api/config',             normalizeRouter(configRoutes));

    // =====================
    // Front estático (producción para Electron)
    // =====================
    if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
      // En el paquete, front-end/dist queda como hermano de back-end
      const clientPath = path.join(__dirname, '..', 'front-end', 'dist');
      const indexPath = path.join(clientPath, 'index.html');

      if (fs.existsSync(indexPath)) {
        console.log(`[server] Sirviendo front desde: ${clientPath}`);
        app.use(express.static(clientPath, { index: false }));
        app.get('*', (req, res) => {
          if (req.originalUrl.startsWith('/api/')) {
            return res.status(404).json({ error: 'API route not found' });
          }
          res.sendFile(indexPath);
        });
      } else {
        console.warn('[server] front-end/dist no encontrado. Solo API disponible.');
      }
    }

    // Handler de errores global de Express
    app.use((err, req, res, next) => {
      console.error('[GLOBAL ERROR]', err);
      if (res.headersSent) return;
      res.status(err.status || 500).json({ error: err.message || 'Error del servidor' });
    });

    // Hard-crashes también loggean
    process.on('uncaughtException', (e) => { console.error('[UNCAUGHT]', e); });
    process.on('unhandledRejection', (e) => { console.error('[UNHANDLED REJECTION]', e); });

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor corriendo en http://0.0.0.0:${PORT}`));

    // ⬇️ Arrancar el sincronizador y GUARDAR EL HANDLE
    if (process.env.MONGO_URI) {
      // === NUEVO: defaults “liberados” ===
      const envPull = (process.env.SYNC_PULL || '').trim();
      const pullAll = (envPull === '' || envPull === '*' || envPull.toUpperCase() === 'ALL');
      const pullCollections = pullAll ? [] : envPull.split(',').map(s => s.trim()).filter(Boolean);

      const mirrorEnv = (process.env.SYNC_MIRROR || '*').trim();
      const mirrorAll = (mirrorEnv === '' || mirrorEnv === '*' || mirrorEnv.toUpperCase() === 'ALL');
      const mirrorCollections = mirrorAll ? [] : mirrorEnv.split(',').map(s => s.trim()).filter(Boolean);

      const syncOpts = {
        intervalMs: Number(process.env.SYNC_INTERVAL_MS) || 30000,

        // ✅ por defecto: pull all (si SYNC_PULL no está o está vacío/*/ALL)
        pullCollections,
        pullAll,

        // ✅ por defecto: mirror all (si SYNC_MIRROR no está o está vacío/*/ALL)
        mirrorAll,
        mirrorCollections,

        remoteDbName: process.env.MONGO_DBNAME_REMOTE || process.env.MONGO_DBNAME || 'parking',
        skipCollections: (process.env.SYNC_BLOCKLIST || '')
          .split(',').map(s => s.trim()).filter(Boolean)
      };

      console.log(`[server] SYNC config => pullAll=${syncOpts.pullAll}, mirrorAll=${syncOpts.mirrorAll}, mirrorCollections=[${syncOpts.mirrorCollections.join(', ')}]`);
      syncHandle = startPeriodicSync(process.env.MONGO_URI, syncOpts, (s) => {
        syncStatus = {
          lastRun: s.lastRun,
          lastError: s.lastError,
          online: s.online,
          pendingOutbox: s.pendingOutbox,
          lastPullCounts: s.lastPullCounts
        };
      });
    } else {
      console.warn('[server] no se encontró MONGO_URI en .env — sincronizador deshabilitado');
    }

    process.on('SIGINT', async () => {
      console.log('SIGINT -> cerrando...');
      await stopLocalMongo();
      process.exit(0);
    });

  } catch (err) {
    console.error('Error arrancando server:', err);
    process.exit(1);
  }
}

main();
