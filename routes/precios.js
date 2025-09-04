// routes/precios.js
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const router = express.Router();

// ============================
// Config
// ============================
const PRECIOS_REMOTE_URL =
  process.env.PRECIOS_REMOTE_URL || 'https://api.garageia.com/api/precios';

const CACHE_FILE =
  process.env.PRECIOS_CACHE_FILE ||
  path.join(
    process.env.PRECIOS_CACHE_DIR || process.env.UPLOADS_BASE || path.join(process.cwd(), 'uploads', 'cache'),
    'precios.json'
  );

const MEM_TTL_MS = Number(process.env.PRECIOS_MEM_TTL_MS || 30_000); // 30s por defecto
const FETCH_TIMEOUT_MS = Number(process.env.PRECIOS_FETCH_TIMEOUT_MS || 5000);

// ============================
// Helpers
// ============================
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

async function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// extrae el objeto de precios aunque venga envuelto en { data: ... }
function extractData(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.data && typeof payload.data === 'object') return payload.data;
  }
  return payload || {};
}

// normaliza pequeñas variaciones de claves (opcional)
function normalizeKeys(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const fix = (k) => {
    const base = String(k).toLowerCase();
    if (base === 'dia') return 'día';
    if (base === 'media estadia') return 'media estadía';
    return k;
  };
  const out = {};
  for (const tipo of Object.keys(obj)) {
    const tabla = obj[tipo] || {};
    const fixed = {};
    for (const k of Object.keys(tabla || {})) fixed[fix(k)] = tabla[k];
    out[tipo] = fixed;
  }
  return out;
}

const memoryCache = { data: null, fetchedAt: 0 };
const now = () => Date.now();
const isFresh = (ts) => now() - ts < MEM_TTL_MS;

async function getPrecios() {
  // 1) cache memoria
  if (memoryCache.data && isFresh(memoryCache.fetchedAt)) {
    return { data: memoryCache.data, source: 'memory' };
  }

  // 2) remoto
  try {
    const remoteRaw = await fetchWithTimeout(PRECIOS_REMOTE_URL, FETCH_TIMEOUT_MS);
    const normalized = normalizeKeys(extractData(remoteRaw));

    // persistimos si cambió
    const currentLocal = await readLocal();
    const changed = JSON.stringify(currentLocal) !== JSON.stringify(normalized);
    if (changed) await writeLocal(normalized);

    memoryCache.data = normalized;
    memoryCache.fetchedAt = now();
    return { data: normalized, source: 'remote' };
  } catch {
    // 3) fallback archivo local
    const local = await readLocal();
    memoryCache.data = local;
    memoryCache.fetchedAt = now();
    return { data: local, source: 'local' };
  }
}

// ============================
// Rutas
// ============================

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
    return res.json({ ok: true, source: 'remote', data: normalized });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// PUT /api/precios/:vehiculo -> sobrescribe tabla de un tipo en el cache/archivo local
router.put('/:vehiculo', async (req, res) => {
  try {
    const { vehiculo } = req.params;
    const nuevosPrecios = req.body;
    if (!nuevosPrecios || typeof nuevosPrecios !== 'object') {
      return res.status(400).json({ error: 'Debes enviar un objeto con los precios' });
    }
    const data = await readLocal();
    data[vehiculo] = normalizeKeys({ [vehiculo]: nuevosPrecios })[vehiculo];
    await writeLocal(data);
    memoryCache.data = data;
    memoryCache.fetchedAt = now();
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
    return res.json({ ok: true, message: 'Precios locales eliminados' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
