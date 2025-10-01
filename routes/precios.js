// routes/precios.js
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const router = express.Router();

/* ============================
   Config
============================ */
const PRECIOS_REMOTE_URL = String(process.env.PRECIOS_REMOTE_URL || '').trim();           // efectivo
const PRECIOS_REMOTE_URL_OTROS = String(process.env.PRECIOS_REMOTE_URL_OTROS || '').trim(); // otros

const CACHE_FILE =
  process.env.PRECIOS_CACHE_FILE ||
  path.join(
    process.env.PRECIOS_CACHE_DIR || process.env.UPLOADS_BASE || path.join(process.cwd(), 'uploads', 'cache'),
    'precios.json'
  );

const MEM_TTL_MS = Number(process.env.PRECIOS_MEM_TTL_MS || 30_000); // 30s
const FETCH_TIMEOUT_MS = Number(process.env.PRECIOS_FETCH_TIMEOUT_MS || 5000);
const PRECIOS_DEBUG = String(process.env.PRECIOS_DEBUG || '').trim() === '1';
const PRECIOS_ALLOW_MUTATIONS = String(process.env.PRECIOS_ALLOW_MUTATIONS || '0').trim() === '1';

const BUCKETS = Object.freeze(['efectivo', 'otros']);

/* ============================
   Fetch (polyfill seguro)
============================ */
let _fetch = global.fetch;
async function ensureFetch() {
  if (_fetch) return _fetch;
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

async function safeReadJSON(p) {
  try {
    const txt = await fsp.readFile(p, 'utf8');
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}

async function atomicWriteJSON(p, obj) {
  await ensureDirForFile(p);
  const tmp = p + '.tmp';
  const bak = p + '.bak';
  try {
    // backup previo si existe
    try {
      if (fs.existsSync(p)) await fsp.copyFile(p, bak);
    } catch {}
    await fsp.writeFile(tmp, JSON.stringify(obj ?? {}, null, 2), 'utf8');
    await fsp.rename(tmp, p);
  } finally {
    try { if (fs.existsSync(tmp)) await fsp.unlink(tmp); } catch {}
  }
}

/* ============================
   Normalización de datos
============================ */
function fixInnerKey(k) {
  const base = String(k || '').toLowerCase().trim();
  if (base === 'dia') return 'día';
  if (base === 'dias') return 'días';
  if (base === 'media estadia') return 'media estadía';
  if (base === '1 hora') return 'hora';
  return base;
}

function normalizeTablaPlano(objPlano) {
  if (!objPlano || typeof objPlano !== 'object') return {};
  const out = {};
  for (const tipoRaw of Object.keys(objPlano)) {
    const tipo = String(tipoRaw || '').toLowerCase().trim();
    const tabla = objPlano[tipoRaw] || {};
    const fixed = {};
    for (const k of Object.keys(tabla || {})) {
      fixed[fixInnerKey(k)] = tabla[k];
    }
    out[tipo] = fixed;
  }
  return out;
}

// Estructura canónica en disco:
// { efectivo: { <vehiculo>: {tarifas...} }, otros: { <vehiculo>: {tarifas...} } }
function isLegacyPlano(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const keys = Object.keys(obj);
  const looksBucketed = keys.some(k => k === 'efectivo' || k === 'otros');
  return !looksBucketed;
}

async function readStore() {
  const raw = await safeReadJSON(CACHE_FILE);
  if (isLegacyPlano(raw)) {
    return {
      efectivo: normalizeTablaPlano(raw),
      otros: {}
    };
  }
  const store = { efectivo: {}, otros: {} };
  for (const b of BUCKETS) {
    store[b] = normalizeTablaPlano(raw[b] || {});
  }
  return store;
}

async function writeStore(store) {
  const canonical = {
    efectivo: normalizeTablaPlano(store.efectivo || {}),
    otros: normalizeTablaPlano(store.otros || {})
  };
  await atomicWriteJSON(CACHE_FILE, canonical);
}

/* ============================
   Fetch con timeout
============================ */
async function fetchWithTimeout(url, ms = 5000) {
  if (!url) throw new Error('remote-disabled');
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
   Cache en memoria
============================ */
const memoryCache = {
  store: null,      // {efectivo, otros}
  fetchedAt: 0,     // ts
  source: null,     // 'remote'|'local'|'mixed'
  warning: null     // string | null
};
const now = () => Date.now();
const isFresh = (ts) => now() - ts < MEM_TTL_MS;

function debugLog(tag, obj) {
  if (!PRECIOS_DEBUG) return;
  try { console.log(`[precios] ${tag}:`, obj); } catch {}
}

/* ============================
   Utils
============================ */
function parseMetodo(qs) {
  const q = String(qs || '').toLowerCase().trim();
  if (['otros', 'resto', 'otrosmetodos', 'otros_metodos'].includes(q)) return 'otros';
  return 'efectivo';
}
function pickBucket(store, metodo) {
  const m = BUCKETS.includes(metodo) ? metodo : 'efectivo';
  return store[m] || {};
}
function notEmptyObject(o) {
  return o && typeof o === 'object' && Object.keys(o).length > 0;
}
function extractData(payload) {
  // Acepta `{data: {...}}` o `{...}`
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data;
  }
  return payload;
}

/* ============================
   Core: cargar precios
============================ */
async function getStore({ forceRemote = false, forceEmpty = false } = {}) {
  // 1) cache memoria
  if (!forceRemote && memoryCache.store && isFresh(memoryCache.fetchedAt)) {
    debugLog('cache-hit', {
      source: memoryCache.source,
      buckets: Object.fromEntries(BUCKETS.map(b => [b, Object.keys(memoryCache.store[b] || {})])),
      warning: memoryCache.warning || null
    });
    return { store: memoryCache.store, source: memoryCache.source || 'memory', warning: memoryCache.warning };
  }

  let warning = null;

  // 2) intentar remoto (efectivo + otros por separado)
  let fetchedEfectivo = null, fetchedOtros = null;
  let remoteTried = false, remoteOk = false;

  try {
    if (PRECIOS_REMOTE_URL) {
      remoteTried = true;
      const raw = await fetchWithTimeout(PRECIOS_REMOTE_URL, FETCH_TIMEOUT_MS);
      fetchedEfectivo = normalizeTablaPlano(extractData(raw));
    }
    if (PRECIOS_REMOTE_URL_OTROS) {
      remoteTried = true;
      const raw2 = await fetchWithTimeout(PRECIOS_REMOTE_URL_OTROS, FETCH_TIMEOUT_MS);
      fetchedOtros = normalizeTablaPlano(extractData(raw2));
    }
    remoteOk = true;
  } catch (e) {
    debugLog('remote-fail', { error: String(e && e.message || e) });
  }

  const currentLocal = await readStore();
  let next = {
    efectivo: currentLocal.efectivo || {},
    otros: currentLocal.otros || {}
  };

  // Merge de lo remoto solo si **no está vacío** o si pidieron forceEmpty
  if (remoteOk || forceRemote) {
    if (forceEmpty) {
      next = { efectivo: {}, otros: {} };
    } else {
      // Si vino algo no vacío, lo tomamos. Si vino vacío, mantenemos cache local.
      if (notEmptyObject(fetchedEfectivo)) {
        next.efectivo = fetchedEfectivo;
      } else if (remoteTried) {
        warning = (warning || ''); warning += '[efectivo vacío remoto → mantengo cache] ';
      }
      if (notEmptyObject(fetchedOtros)) {
        next.otros = fetchedOtros;
      } else if (remoteTried && PRECIOS_REMOTE_URL_OTROS) {
        warning = (warning || ''); warning += '[otros vacío remoto → mantengo cache] ';
      }
    }
    // Persistimos si al menos uno de los buckets vino con datos
    if (notEmptyObject(fetchedEfectivo) || notEmptyObject(fetchedOtros) || forceEmpty) {
      await writeStore(next);
      memoryCache.source = (notEmptyObject(fetchedEfectivo) || notEmptyObject(fetchedOtros)) ? 'remote' : 'local';
    } else {
      memoryCache.source = 'local';
    }
  } else {
    memoryCache.source = 'local';
  }

  memoryCache.store = next;
  memoryCache.fetchedAt = now();
  memoryCache.warning = warning;

  debugLog('store-ready', {
    source: memoryCache.source,
    tiposEfectivo: Object.keys(next.efectivo || {}),
    tiposOtros: Object.keys(next.otros || {}),
    warning
  });

  return { store: next, source: memoryCache.source, warning };
}

/* ============================
   Rutas
============================ */

// GET /api/precios[?metodo=efectivo|otros]
// Headers: X-Precios-Source, X-Precios-Warning
router.get('/', async (req, res) => {
  try {
    const metodo = parseMetodo(req.query.metodo || req.query.method);
    const forceRemote = String(req.query.refresh || '').trim() === '1';
    const forceEmpty = String(req.query.forceEmpty || '').trim() === '1'; // cuidado: solo para pruebas

    const { store, source, warning } = await getStore({ forceRemote, forceEmpty });
    const bucket = pickBucket(store, metodo);

    res.set('X-Precios-Source', source);
    if (warning) res.set('X-Precios-Warning', warning.trim());
    res.set('X-Precios-Metodo', metodo);

    return res.json(bucket);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/precios/refresh
// Fuerza traer de remoto (ambos buckets si hay URLs) y persistir sin pisar con vacío
router.post('/refresh', async (_req, res) => {
  try {
    const { store, source, warning } = await getStore({ forceRemote: true, forceEmpty: false });
    res.set('X-Precios-Source', source);
    if (warning) res.set('X-Precios-Warning', warning.trim());
    return res.json({ ok: true, source, warning, buckets: {
      efectivo: Object.keys(store.efectivo || {}),
      otros: Object.keys(store.otros || {})
    }});
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// PUT /api/precios/:vehiculo[?metodo=efectivo|otros]
// body: { <tarifa>: <numero>, ... }
router.put('/:vehiculo', async (req, res) => {
  try {
    if (!PRECIOS_ALLOW_MUTATIONS) {
      return res.status(403).json({ error: 'Mutaciones deshabilitadas (PRECIOS_ALLOW_MUTATIONS=0)' });
    }
    const metodo = parseMetodo(req.query.metodo || req.query.method);
    const vehiculo = String(req.params.vehiculo || '').toLowerCase().trim();
    const nuevosPrecios = req.body;

    if (!nuevosPrecios || typeof nuevosPrecios !== 'object') {
      return res.status(400).json({ error: 'Debes enviar un objeto con los precios' });
    }

    const store = await readStore();
    const bucket = pickBucket(store, metodo);

    const normalizedVehiculoTabla = {};
    for (const k of Object.keys(nuevosPrecios || {})) {
      normalizedVehiculoTabla[fixInnerKey(k)] = nuevosPrecios[k];
    }
    bucket[vehiculo] = normalizedVehiculoTabla;

    const next = { ...store, [metodo]: bucket };
    await writeStore(next);

    // invalidar cache memoria
    memoryCache.store = next;
    memoryCache.fetchedAt = now();
    memoryCache.source = 'local';
    memoryCache.warning = null;

    debugLog('put-vehiculo', { metodo, vehiculo, keys: Object.keys(bucket[vehiculo] || {}) });

    return res.json({ ok: true, data: bucket });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// DELETE /api/precios[?metodo=efectivo|otros]
// sin metodo => limpia ambos; con metodo => limpia solo ese bucket
router.delete('/', async (req, res) => {
  try {
    if (!PRECIOS_ALLOW_MUTATIONS) {
      return res.status(403).json({ error: 'Mutaciones deshabilitadas (PRECIOS_ALLOW_MUTATIONS=0)' });
    }
    const metodo = req.query.metodo ? parseMetodo(req.query.metodo) : null;
    const store = await readStore();

    if (metodo) {
      store[metodo] = {};
    } else {
      store.efectivo = {};
      store.otros = {};
    }

    await writeStore(store);

    memoryCache.store = store;
    memoryCache.fetchedAt = now();
    memoryCache.source = 'local';
    memoryCache.warning = null;

    debugLog('delete', { metodo: metodo || 'all', cacheFile: CACHE_FILE });
    return res.json({ ok: true, message: metodo ? `Precios ${metodo} eliminados` : 'Precios locales eliminados' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/precios/debug
router.get('/debug', async (_req, res) => {
  try {
    const store = await readStore();
    const tiposEfectivo = Object.keys(store.efectivo || {});
    const tiposOtros = Object.keys(store.otros || {});
    const sampleEfectivo = tiposEfectivo[0] ? store.efectivo[tiposEfectivo[0]] : {};
    const sampleOtros = tiposOtros[0] ? store.otros[tiposOtros[0]] : {};

    return res.json({
      ok: true,
      cacheFile: CACHE_FILE,
      remoteUrl: PRECIOS_REMOTE_URL || '(disabled)',
      remoteUrlOtros: PRECIOS_REMOTE_URL_OTROS || '(disabled)',
      buckets: {
        efectivo: { tipos: tiposEfectivo, sample: sampleEfectivo },
        otros: { tipos: tiposOtros, sample: sampleOtros }
      }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
