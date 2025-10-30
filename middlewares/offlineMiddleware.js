// middlewares/offlineMiddleware.js
/* eslint-disable no-console */
const Outbox = require('../models/Outbox');
const routeToCollection = require('../configuracion/routeToCollection');

const WRAPPED = Symbol('offline_mw_wrapped');

// Rutas que no deben guardarse en el outbox
const excludedPaths = [
  '/api/auth/login',
  '/api/tickets/barcode',
  '/api/tickets/imprimir',
  '/api/sync/run-now',
  '/api/vehiculos/eliminar-foto-temporal'
];

// Busca el mapping por prefijo (match más largo)
function findCollectionForPath(path) {
  const keys = Object.keys(routeToCollection).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (path.startsWith(k)) return routeToCollection[k];
  }
  return null;
}

// Heurística simple para detectar ids en segmentos de URL
function findIdInPath(path) {
  const parts = path.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/^[a-fA-F0-9]{24}$/.test(p) || /^[0-9]+$/.test(p)) return p;
  }
  return null;
}

// Determina si la respuesta parece un "envelope" tipo { msg, token } sin documento
function looksLikeEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (!keys.length) return true;
  const allowed = new Set(['msg', 'message', 'ok', 'token', 'status', 'error']);
  const hasOnlyEnvelopeKeys = keys.every(k => allowed.has(k));
  const hasDomainKeys = keys.some(k =>
    ['_id','id','user','ticket','vehiculo','cliente','data','result','document','item','payload','username','email','operador'].includes(k)
  );
  return hasOnlyEnvelopeKeys && !hasDomainKeys;
}

// Función mejorada para detectar si un valor parece un documento válido
function looksLikeValidDocument(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj._id !== undefined) return true; // típico de Mongo/Mongoose
  const envelopeKeys = new Set(['msg', 'message', 'ok', 'token', 'status', 'error']);
  const keys = Object.keys(obj);
  const hasNonEnvelopeKeys = keys.some(k => !envelopeKeys.has(k));
  return hasNonEnvelopeKeys && keys.length > 0;
}

/* =======================================================
   Helpers nuevos: aplanar refs pobladas a ObjectId string
======================================================= */

// Extrae un ObjectId en string desde múltiples formas comunes: string hex, {_id}, {id}, {$oid}, {_id: {$oid: ...}}, Buffer-like.
function pluckHexObjectId(ref) {
  try {
    if (!ref) return null;

    if (typeof ref === 'string') {
      return /^[a-fA-F0-9]{24}$/.test(ref.trim()) ? ref.trim() : null;
    }

    if (typeof ref === 'object') {
      // Formas directas
      if (typeof ref._id === 'string' && /^[a-fA-F0-9]{24}$/.test(ref._id)) return ref._id;
      if (typeof ref.id === 'string'  && /^[a-fA-F0-9]{24}$/.test(ref.id))  return ref.id;
      if (typeof ref.$oid === 'string' && /^[a-fA-F0-9]{24}$/.test(ref.$oid)) return ref.$oid;

      // _id como documento BSON con $oid
      if (ref._id && typeof ref._id === 'object' && typeof ref._id.$oid === 'string' && /^[a-fA-F0-9]{24}$/.test(ref._id.$oid)) {
        return ref._id.$oid;
      }

      // Buffer/bytes de 12
      if (ref._bsontype === 'ObjectId' && ref.id && ref.id.length === 12) {
        return Buffer.from(ref.id).toString('hex');
      }
      if (ref.buffer && typeof ref.buffer === 'object') {
        const keys = Object.keys(ref.buffer).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
        if (keys.length === 12) return Buffer.from(keys.map(k => Number(ref.buffer[k]))).toString('hex');
      }
      const directKeys = Object.keys(ref).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
      if (directKeys.length === 12) return Buffer.from(directKeys.map(k => Number(ref[k]))).toString('hex');
    }
  } catch (_) { /* ignore */ }
  return null;
}

// Aplana refs conocidas a su _id si vienen pobladas (sin _id → se deja como venía)
function flattenRefFields(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const REF_KEYS = ['operador', 'cliente', 'vehiculo', 'abono', 'user', 'usuario'];
  for (const k of REF_KEYS) {
    if (candidate[k] !== undefined && candidate[k] !== null) {
      const hex = pluckHexObjectId(candidate[k]);
      if (hex) candidate[k] = hex; // sustituye objeto por su ObjectId string
    }
  }
  return candidate;
}

/* =======================================================
   Fix clave: asegurar operador en cierres de caja
======================================================= */
function ensureOperadorForCierre(candidate, req) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  if (candidate.operador) return candidate;

  // intentá recuperar desde req.user si el controller no lo puso en body/respuesta
  const opHex =
    pluckHexObjectId(req?.user) ||
    pluckHexObjectId(req?.user?._id) ||
    pluckHexObjectId(req?.user?.id) ||
    null;

  if (opHex) candidate.operador = opHex;
  return candidate;
}

/* =======================================================
   Selección de documento para el Outbox (AJUSTADA)
   - Nunca "pisa" el _id si la respuesta lo trae
   - Mergea campos útiles desde req.body (p.ej. operador)
   - Para cierresdecajas, fuerza operador desde req.user si falta
======================================================= */
function pickDocumentForOutbox(method, collection, req, capturedBody) {
  const reqBody = (req && req.body && typeof req.body === 'object') ? req.body : null;

  // 1) Elegir base: si la respuesta trae un doc válido (mejor si trae _id), usarla. Si es envelope o inválida, usar req.body
  let candidate = null;
  if (looksLikeValidDocument(capturedBody) && !looksLikeEnvelope(capturedBody)) {
    candidate = capturedBody;
  } else if (reqBody && typeof reqBody === 'object') {
    candidate = reqBody;
  } else {
    candidate = {};
  }

  // 2) Si la respuesta vino envuelta tipo {document: {...}} o similares, extraer
  if (candidate && typeof candidate === 'object') {
    const keysToTry = ['document','result','data','item','payload','ticket','vehiculo','cliente'];
    for (const k of keysToTry) {
      if (candidate[k] && typeof candidate[k] === 'object' && candidate[k]._id) {
        candidate = candidate[k];
        break;
      }
    }
  }

  // 3) Merge conservador: NO perder _id de la respuesta. Copiamos desde req.body solo si faltan en candidate.
  if (reqBody && typeof reqBody === 'object') {
    const MERGE_KEYS = ['operador','cliente','vehiculo','abono','user','usuario','fecha','hora'];
    for (const k of MERGE_KEYS) {
      if (candidate[k] === undefined && reqBody[k] !== undefined) {
        candidate[k] = reqBody[k];
      }
    }
  }

  // 4) Caso especial: cierresdecajas → asegurar operador (desde req.user si falta)
  if (String(collection).toLowerCase() === 'cierresdecajas') {
    candidate = ensureOperadorForCierre(candidate, req);
  }

  // 5) Aplanar refs pobladas
  if (candidate && typeof candidate === 'object') {
    candidate = flattenRefFields(candidate);
  }

  // 6) Limpieza final
  if (candidate && typeof candidate === 'object') {
    const { __v, _v, createdAt, updatedAt, ...cleanDoc } = candidate;
    return cleanDoc;
  }
  return {};
}

module.exports = function offlineMiddleware(req, res, next) {
  try {
    // ⬅️ nuevo: si piden explícitamente operación local, NO envolvemos la respuesta
    const q = req.query || {};
    const localOnly = ['1','true','yes'].includes(String(q.localOnly || req.headers['x-local-only'] || '').toLowerCase());
    if (localOnly) return next();

    // Solo mutaciones sobre /api/*
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) || !req.originalUrl.startsWith('/api/')) {
      return next();
    }

    // No procesar rutas excluidas (permitir querystring)
    if (excludedPaths.some(p => req.originalUrl.startsWith(p))) {
      return next();
    }

    const collection = findCollectionForPath(req.originalUrl);
    if (!collection) return next();

    // Evitar doble envoltura
    if (res[WRAPPED]) return next();
    res[WRAPPED] = true;

    let capturedBody = null;
    let alreadySent = false;

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      try { capturedBody = body; } catch (_) {}
      alreadySent = true;
      return originalJson(body);
    };

    const originalSend = res.send.bind(res);
    res.send = function (body) {
      try {
        if (!alreadySent) {
          if (typeof body === 'string') {
            try { capturedBody = JSON.parse(body); } catch (_) { capturedBody = body; }
          } else {
            capturedBody = body;
          }
        }
      } catch (_) {}
      alreadySent = true;
      return originalSend(body);
    };

    // Cuando la respuesta termine, procesar offline
    res.on('finish', () => {
      Promise.resolve()
        .then(async () => {
          if (res.locals && res.locals.__skipOutbox) return;
          if (!res.statusCode || res.statusCode >= 400) return;

          const method = req.method;
          const docCandidate = pickDocumentForOutbox(method, collection, req, capturedBody) || {};

          // Extraer id de doc o de la URL
          let idFromDoc = (docCandidate && (docCandidate._id || docCandidate.id)) || null;
          if (!idFromDoc) idFromDoc = findIdInPath(req.originalUrl);

          // Construir params
          const params = { ...req.params };
          if (idFromDoc) {
            params._id = idFromDoc;
            params.id = idFromDoc;
          }

          // Construir query base desde req.query
          const query = { ...req.query };

          // === MARCA BULK DELETE CUANDO NO HAY ID ===
          if (method === 'DELETE' && !idFromDoc) {
            // Flag que el sincronizador interpretará para deleteMany()
            query.__bulk = true; // o query.all = true;

            // Si vino un filtro explícito en body/candidato, lo pasamos (opcional)
            const candidateFilter =
              (req.body && typeof req.body === 'object' && req.body.filter) ||
              (docCandidate && typeof docCandidate === 'object' && docCandidate.filter);

            if (candidateFilter && typeof candidateFilter === 'object') {
              query.filter = candidateFilter;
            }
          }

          await Outbox.create({
            method,
            route: req.originalUrl,
            collection,
            document: docCandidate,
            params,
            query,
            status: 'pending',
            createdAt: new Date()
          });

          const extra = (method === 'DELETE' && !idFromDoc) ? ' (bulk=true)' : '';
          console.log(`[offlineMiddleware] Outbox creado: ${method} ${req.originalUrl} -> ${collection} id=${idFromDoc || '(sin id)'}${extra}`);
        })
        .catch(err => {
          console.error('[offlineMiddleware] error creando outbox post-response:', err?.message || err);
        });
    });

    return next();
  } catch (err) {
    console.error('[offlineMiddleware] fallo inicial:', err?.message || err);
    return next(err);
  }
};
