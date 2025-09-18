// back-end/data/fetchData.js
'use strict';

/**
 * Config
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:5000/api';
const BASE_URL = process.env.API_BASE_URL || DEFAULT_BASE_URL;
const TIMEOUT_MS = Number(process.env.API_FETCH_TIMEOUT_MS || 5000);
const RETRIES = Number(process.env.API_FETCH_RETRIES || 2); // total = 1 intento + RETRIES
const DEBUG = String(process.env.API_FETCH_DEBUG || '').trim() === '1';

/**
 * Fetch provider (Node 18+ nativo o fallback a node-fetch)
 */
function getFetch() {
  if (typeof global.fetch === 'function') return global.fetch.bind(global);
  return (...args) => import('node-fetch').then((m) => (m.default || m)(...args));
}
const $fetch = getFetch();

/**
 * Utils
 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await $fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function requestJson(url, options = {}) {
  let attempt = 0;
  let lastErr = null;
  const baseDelay = 200; // ms

  while (attempt <= RETRIES) {
    try {
      if (DEBUG) console.log(`[fetchData] GET ${url} (intento ${attempt + 1}/${RETRIES + 1})`);
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' },
        ...options
      });

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`HTTP ${res.status} ${res.statusText} :: ${truncate(text, 200)}`);
      }

      const body = await safeJson(res);
      return normalizeBody(body);
    } catch (err) {
      lastErr = err;
      const transient = isTransient(err);
      if (DEBUG) console.warn(`[fetchData] fallo ${url}: ${String(err.message || err)} (transient=${transient})`);
      if (!transient || attempt === RETRIES) break;
      // backoff lineal (simple y suficiente acá)
      await sleep(baseDelay * (attempt + 1));
      attempt++;
    }
  }

  throw new Error(`requestJson failed for ${url}: ${String(lastErr && lastErr.message || lastErr)}`);
}

function isTransient(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  // Aborted (timeout), conectividad, 5xx
  return (
    msg.includes('abort') ||
    msg.includes('timed') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    /http 5\d\d/i.test(msg)
  );
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}

function normalizeBody(body) {
  if (body && typeof body === 'object' && 'data' in body) return body.data;
  return body;
}

function truncate(s, n) {
  if (!s) return s;
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * API calls
 * Nota: dejamos GET simples; si en el futuro hay POST/PUT/DELETE,
 * podés exponer helpers adicionales acá.
 */
async function obtenerTarifas() {
  return requestJson(`${BASE_URL}/tarifas`);
}
async function obtenerPrecios() {
  return requestJson(`${BASE_URL}/precios`);
}
async function obtenerParametros() {
  return requestJson(`${BASE_URL}/parametros`);
}

module.exports = {
  obtenerTarifas,
  obtenerPrecios,
  obtenerParametros
};
