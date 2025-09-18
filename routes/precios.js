// routes/precios.js
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const router = express.Router();

/* ============================
   Config
============================ */
const PRECIOS_REMOTE_URL =
  process.env.PRECIOS_REMOTE_URL || 'https://api.garageia.com/api/precios';

const CACHE_FILE =
  process.env.PRECIOS_CACHE_FILE ||
  path.join(
    process.env.PRECIOS_CACHE_DIR || process.env.UPLOADS_BASE || path.join(process.cwd(), 'uploads', 'cache'),
    'precios.json'
  );

const MEM_TTL_MS = Number(process.env.PRECIOS_MEM_TTL_MS || 30_000); // 30s
const FETCH_TIMEOUT_MS = Number(process.env.PRECIOS_FETCH_TIMEOUT_MS || 5000);
const PRECIOS_DEBUG = String(process.env.PRECIOS_DEBUG || '').trim() === '1';

/* ============================
   Fetch (polyfill seguro)
============================ */
let _fetch = global.fetch;
async function ensureFetch() {
  if (_fetch) return _fetch;
  // CJS dynamic import de node-fetch solo si hace falta
  const mod = await import('node-fetch');
  _fetch = mod.default || mod;
  return _fetch;
}

/* ============================
   Helpers FS
============================ */
async function ensureDirForFile(p) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
}

async function readLocal() {
  try {
    const txt = await fsp.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}

async function writeLocal(jsonObj) {
  await ensureDirForFile(CACHE_FILE);
  await fsp.writeFile(CACHE_FILE, JSON.stringify(jsonObj ?? {}, null, 2), 'utf8');
}

/* ============================
   Fetch con timeout
============================ */
async function fetchWithTimeout(url, ms = 5000) {
  const f = await ensureFetch();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await f(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* ============================
   Normalización de datos
============================ */

// normaliza pequeñas variaciones de claves internas
function fixInnerKey(k) {
  const base = String(k || '').toLowerCase().trim();
  if (base === 'dia') return 'día';
  if (base === 'dias') return 'días';
  if (base === 'media estadia') return 'media estadía';
  if (base === '1 hora') return 'hora'; // por si alguien nombra así
  return base;
}

/**
 * Normaliza estructura completa:
 * - tipos: lower + trim
 * - claves internas: lower + trim + fixes (día/media estadía/etc.)
 */
function normalizeKeys(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const tipoRaw of Object.keys(obj)) {
    const tipo = String(tipoRaw || '').toLowerCase().trim(); // <-- CLAVE: normalizar tipo
    const tabla = obj[tipoRaw] || {};
    const fixed = {};
    for (const k of Object.keys(tabla || {})) {
      fixed[fixInnerKey(k)] = tabla[k];
    }
    out[tipo] = fixed;
  }
  return out;
}

// extrae el objeto de precios aunque venga envuelto en { data: ... }
function extractData(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.data && typeof payload.data === 'object') return payload.data;
  }
  return payload || {};
}

const memoryCache = { data: null, fetchedAt: 0, source: null };
const now = () => Date.now();
const isFresh = (ts) => now() - ts < MEM_TTL_MS;

function debugLog(tag, obj) {
  if (!PRECIOS_DEBUG) return;
  try {
    // logs compactos y útiles
    console.log(`[precios] ${tag}:`, obj);
  } catch {}
}

async function getPrecios() {
  // 1) cache memoria
  if (memoryCache.data && isFresh(memoryCache.fetchedAt)) {
    debugLog('cache-hit', {
      source: memoryCache.source,
      tipos: Object.keys(memoryCache.data || {}),
      horaPorTipo: Object.fromEntries(Object.entries(memoryCache.data || {}).map(([t, tbl]) => [t, 'hora' in (tbl || {})]))
    });
    return { data: memoryCache.data, source: memoryCache.source || 'memory' };
  }

  // 2) remoto
  try {
    const remoteRaw = await fetchWithTimeout(PRECIOS_REMOTE_URL, FETCH_TIMEOUT_MS);
    const normalized = normalizeKeys(extractData(remoteRaw));

    const currentLocal = await readLocal();
    const changed = JSON.stringify(currentLocal) !== JSON.stringify(normalized);
    if (changed) await writeLocal(normalized);

    memoryCache.data = normalized;
    memoryCache.fetchedAt = now();
    memoryCache.source = 'remote';

    debugLog('remote-ok', {
      url: PRECIOS_REMOTE_URL,
      cacheFile: CACHE_FILE,
      tipos: Object.keys(normalized),
      horaPorTipo: Object.fromEntries(Object.entries(normalized).map(([t, tbl]) => [t, 'hora' in (tbl || {})]))
    });

    return { data: normalized, source: 'remote' };
  } catch (e) {
    debugLog('remote-fail', { url: PRECIOS_REMOTE_URL, error: String(e && e.message || e) });

    // 3) fallback archivo local
    const local = normalizeKeys(await readLocal()); // normalizar por si el cache viejo tenía mayúsculas
    memoryCache.data = local;
    memoryCache.fetchedAt = now();
    memoryCache.source = 'local';

    debugLog('local-fallback', {
      cacheFile: CACHE_FILE,
      tipos: Object.keys(local),
      horaPorTipo: Object.fromEntries(Object.entries(local).map(([t, tbl]) => [t, 'hora' in (tbl || {})]))
    });

    return { data: local, source: 'local' };
  }
}

/* ============================
   Rutas
============================ */

// GET /api/precios -> devuelve precios (remoto si hay, sino cache/archivo)
router.get('/', async (_req, res) => {
  try {
    const { data, source } = await getPrecios();
    res.set('X-Precios-Source', source);
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/precios/refresh -> fuerza traer del remoto y persistir
router.post('/refresh', async (_req, res) => {
  try {
    const remoteRaw = await fetchWithTimeout(PRECIOS_REMOTE_URL, FETCH_TIMEOUT_MS);
    const normalized = normalizeKeys(extractData(remoteRaw));
    await writeLocal(normalized);
    memoryCache.data = normalized;
    memoryCache.fetchedAt = now();
    memoryCache.source = 'remote';

    debugLog('manual-refresh', {
      url: PRECIOS_REMOTE_URL,
      tipos: Object.keys(normalized),
      horaPorTipo: Object.fromEntries(Object.entries(normalized).map(([t, tbl]) => [t, 'hora' in (tbl || {})]))
    });

    return res.json({ ok: true, source: 'remote', data: normalized });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// PUT /api/precios/:vehiculo -> sobrescribe tabla de un tipo en el cache/archivo local
router.put('/:vehiculo', async (req, res) => {
  try {
    const vehiculoRaw = req.params.vehiculo;
    const vehiculo = String(vehiculoRaw || '').toLowerCase().trim(); // normalizar tipo
    const nuevosPrecios = req.body;
    if (!nuevosPrecios || typeof nuevosPrecios !== 'object') {
      return res.status(400).json({ error: 'Debes enviar un objeto con los precios' });
    }
    const data = normalizeKeys(await readLocal());
    data[vehiculo] = normalizeKeys({ [vehiculo]: nuevosPrecios })[vehiculo];
    await writeLocal(data);
    memoryCache.data = data;
    memoryCache.fetchedAt = now();
    memoryCache.source = 'local';

    debugLog('put-vehiculo', { vehiculo, keys: Object.keys(data[vehiculo] || {}) });

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// DELETE /api/precios -> limpia archivo local (no afecta el remoto)
router.delete('/', async (_req, res) => {
  try {
    await writeLocal({});
    memoryCache.data = {};
    memoryCache.fetchedAt = now();
    memoryCache.source = 'local';
    debugLog('delete-all', { cacheFile: CACHE_FILE });
    return res.json({ ok: true, message: 'Precios locales eliminados' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/precios/debug -> inspección rápida (opcional)
router.get('/debug', async (_req, res) => {
  try {
    const { data, source } = await getPrecios();
    const tipos = Object.keys(data || {});
    const horaPorTipo = Object.fromEntries(
      tipos.map(t => [t, Object.prototype.hasOwnProperty.call(data[t] || {}, 'hora')])
    );
    return res.json({
      ok: true,
      source,
      cacheFile: CACHE_FILE,
      remoteUrl: PRECIOS_REMOTE_URL,
      tipos,
      horaPorTipo,
      sample: tipos[0] ? data[tipos[0]] : {}
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
