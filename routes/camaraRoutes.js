// camaraRoutes.js
// Versión robusta: soporta set-ip, set-credentials, set-rtsp (url completa) y get-config.
// Mantiene la compatibilidad con config.txt que contiene al menos RTSP_URL=...
// Usa fs.promises, hace backup del config antes de sobrescribir y valida inputs.

const fs = require('fs');
const fsp = fs.promises;
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const router = express.Router();

const configPath = path.join(__dirname, '..', 'camara', 'config.txt');
const sacarfotoDir = path.join(__dirname, '..', 'camara', 'sacarfoto');
const scriptPath = path.join(sacarfotoDir, 'sacarfoto.py');

const pythonCmd = process.env.PYTHON || 'python'; // 'python' o 'python3' según ambiente

// --- Helpers ---------------------------------------------------------------

function isValidIPv4(ip) {
  // acepta también nombres de host (letras, números, guiones, puntos)
  const ipv4 = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
  const hostname = /^[a-zA-Z0-9\-._]+$/;
  return ipv4.test(ip) || hostname.test(ip);
}

function isValidPort(port) {
  const p = Number(port);
  return Number.isInteger(p) && p > 0 && p <= 65535;
}

function atomicWrite(filePath, content) {
  // escribe a temp y renombra (reduce chance de archivo corrupto)
  const tmpPath = `${filePath}.tmp`;
  return fsp.writeFile(tmpPath, content, 'utf8')
    .then(() => fsp.rename(tmpPath, filePath));
}

async function backupConfigIfExists() {
  try {
    if (fs.existsSync(configPath)) {
      const stat = fs.statSync(configPath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${configPath}.bak.${timestamp}`;
      await fsp.copyFile(configPath, backupPath);
      console.log(`🔁 Backup creado: ${backupPath} (${stat.size} bytes)`);
    }
  } catch (err) {
    console.warn('⚠️ No se pudo crear backup del config (no crítico):', err.message);
  }
}

function parseConfigText(text) {
  // devuelve objeto con keys de config (RTSP_URL, RTSP_USER, RTSP_PASS, etc)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > -1) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      out[key] = val;
    }
  }
  return out;
}

function buildRtspFromParts({ user, pass, host, port = 554, path = '/streaming/channels/1' }) {
  // Escapa caracteres básicos en user/pass
  const cred = (user && pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` :
               (user && !pass) ? `${encodeURIComponent(user)}@` : '';
  const hostPart = host;
  const portPart = port ? `:${port}` : '';
  // Aseguramos que path comience con slash
  const p = path && path.startsWith('/') ? path : `/${path}`;
  return `rtsp://${cred}${hostPart}${portPart}${p}`;
}

function extractPartsFromRtsp(rtsp) {
  // Intenta parsear distintos formatos:
  // rtsp://user:pass@host:port/path
  // rtsp://host:port/path
  // devuelve { user, pass, host, port, path }
  try {
    const withoutProto = rtsp.replace(/^rtsp:\/\//i, '');
    // split creds and host
    let user = null, pass = null;
    let hostAndRest = withoutProto;
    if (withoutProto.includes('@')) {
      const [creds, rest] = withoutProto.split('@');
      hostAndRest = rest;
      if (creds.includes(':')) {
        const [u, p] = creds.split(':');
        user = decodeURIComponent(u);
        pass = decodeURIComponent(p);
      } else {
        user = decodeURIComponent(creds);
      }
    }
    // hostAndRest: host:port/path...
    const slashIndex = hostAndRest.indexOf('/');
    const hostPort = slashIndex === -1 ? hostAndRest : hostAndRest.slice(0, slashIndex);
    const restPath = slashIndex === -1 ? '' : hostAndRest.slice(slashIndex);
    let host = hostPort;
    let port = 554;
    if (hostPort.includes(':')) {
      const [h, p] = hostPort.split(':');
      host = h;
      const pn = Number(p);
      if (!Number.isNaN(pn)) port = pn;
    }
    const pathPart = restPath || '/';
    return { user, pass, host, port, path: pathPart };
  } catch (err) {
    return { user: null, pass: null, host: null, port: 554, path: '/streaming/channels/1' };
  }
}

// --- Config read / write --------------------------------------------------

async function readConfigFile() {
  if (!fs.existsSync(configPath)) return {};
  const text = await fsp.readFile(configPath, 'utf8');
  const parsed = parseConfigText(text);
  const out = {};
  if (parsed.RTSP_URL) {
    out.RTSP_URL = parsed.RTSP_URL;
    const parts = extractPartsFromRtsp(parsed.RTSP_URL);
    out.RTSP_USER = parts.user || parsed.RTSP_USER || '';
    out.RTSP_PASS = parts.pass || parsed.RTSP_PASS || '';
    out.HOST = parts.host || '';
    out.PORT = parts.port || 554;
    out.PATH = parts.path || '/streaming/channels/1';
  } else {
    // fallback to separate keys if RTSP_URL faltante
    out.RTSP_USER = parsed.RTSP_USER || '';
    out.RTSP_PASS = parsed.RTSP_PASS || '';
    out.HOST = parsed.HOST || '';
    out.PORT = parsed.PORT || 554;
    out.PATH = parsed.PATH || '/streaming/channels/1';
    if (out.HOST) {
      out.RTSP_URL = buildRtspFromParts({ user: out.RTSP_USER, pass: out.RTSP_PASS, host: out.HOST, port: out.PORT, path: out.PATH });
    }
  }
  return out;
}

async function writeConfigFile({ rtspUrl, user, pass, host, port, path: pth }) {
  // Construye contenido y hace backup antes de escribir (si existe)
  await backupConfigIfExists();
  const lines = [];
  if (rtspUrl) {
    lines.push(`RTSP_URL=${rtspUrl}`);
    // Try to also parse parts and store separately for convenience
    const parts = extractPartsFromRtsp(rtspUrl);
    if (parts.user) lines.push(`RTSP_USER=${parts.user}`);
    if (parts.pass) lines.push(`RTSP_PASS=${parts.pass}`);
    if (parts.host) lines.push(`HOST=${parts.host}`);
    if (parts.port) lines.push(`PORT=${parts.port}`);
    if (parts.path) lines.push(`PATH=${parts.path}`);
  } else {
    // build from parts
    const built = buildRtspFromParts({ user, pass, host, port, path: pth });
    lines.push(`RTSP_URL=${built}`);
    if (user) lines.push(`RTSP_USER=${user}`);
    if (pass) lines.push(`RTSP_PASS=${pass}`);
    if (host) lines.push(`HOST=${host}`);
    if (port) lines.push(`PORT=${port}`);
    if (pth) lines.push(`PATH=${pth}`);
  }
  const content = lines.join('\n') + '\n';
  await atomicWrite(configPath, content);
  console.log('✅ Config escrito en', configPath);
  return true;
}

// --- Script runner --------------------------------------------------------

function runCaptureScript(arg = '') {
  return new Promise((resolve) => {
    const args = arg ? [scriptPath, arg] : [scriptPath];
    const proc = spawn(pythonCmd, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: 1, stdout, stderr: (stderr + err.message) }));
  });
}

// --- Routes ---------------------------------------------------------------

// GET /get-config -> devuelve estructura del config
router.get('/get-config', async (_req, res) => {
  try {
    const cfg = await readConfigFile();
    if (!cfg.RTSP_URL) return res.status(404).json({ exito: false, mensaje: 'No hay config (RTSP_URL no encontrado).' });
    // devolver campos útiles
    return res.json({
      exito: true,
      config: {
        RTSP_URL: cfg.RTSP_URL,
        RTSP_USER: cfg.RTSP_USER || '',
        RTSP_PASS: cfg.RTSP_PASS ? '***' : '',
        HOST: cfg.HOST || '',
        PORT: cfg.PORT || 554,
        PATH: cfg.PATH || ''
      }
    });
  } catch (err) {
    console.error('❌ Error leyendo config:', err);
    return res.status(500).json({ exito: false, mensaje: 'Error al leer config.' });
  }
});

// POST /set-ip -> actualiza sólo el host/IP (preserva credenciales si están)
router.post('/set-ip', async (req, res) => {
  try {
    const { ip, port } = req.body;
    if (!ip) return res.status(400).json({ exito: false, mensaje: 'Falta parámetro ip' });
    if (!isValidIPv4(ip)) return res.status(400).json({ exito: false, mensaje: 'IP/host inválido' });

    const cfg = await readConfigFile();
    const usuario = cfg.RTSP_USER || null;
    const clave = cfg.RTSP_PASS || null;
    const portToUse = port ? Number(port) : (cfg.PORT || 554);
    if (port && !isValidPort(portToUse)) return res.status(400).json({ exito: false, mensaje: 'Puerto inválido' });

    const newRtsp = buildRtspFromParts({ user: usuario, pass: clave, host: ip, port: portToUse, path: cfg.PATH || '/streaming/channels/1' });
    await writeConfigFile({ rtspUrl: newRtsp });

    return res.json({ exito: true, mensaje: 'IP actualizada correctamente', RTSP_URL: newRtsp });
  } catch (err) {
    console.error('❌ Error en set-ip:', err);
    return res.status(500).json({ exito: false, mensaje: 'Error al actualizar IP' });
  }
});

// POST /set-credentials -> actualizar usuario/contraseña (preserva host)
router.post('/set-credentials', async (req, res) => {
  try {
    const { user, pass } = req.body;
    if (!user) return res.status(400).json({ exito: false, mensaje: 'Falta user' });
    // pass puede ser vacío string si no hay pass
    const cfg = await readConfigFile();
    const host = cfg.HOST || cfg.RTSP_URL ? extractPartsFromRtsp(cfg.RTSP_URL).host : null;
    if (!host) return res.status(400).json({ exito: false, mensaje: 'No hay host en config. Seteá la IP primero o usa /set-rtsp.' });

    const port = cfg.PORT || 554;
    const path = cfg.PATH || '/streaming/channels/1';
    const newRtsp = buildRtspFromParts({ user, pass, host, port, path });
    await writeConfigFile({ rtspUrl: newRtsp });

    return res.json({ exito: true, mensaje: 'Credenciales guardadas', RTSP_URL: newRtsp });
  } catch (err) {
    console.error('❌ Error en set-credentials:', err);
    return res.status(500).json({ exito: false, mensaje: 'Error al guardar credenciales' });
  }
});

// POST /set-rtsp -> escribir la URL RTSP exacta (permite reemplazar todo)
router.post('/set-rtsp', async (req, res) => {
  try {
    const { rtsp } = req.body;
    if (!rtsp) return res.status(400).json({ exito: false, mensaje: 'Falta parámetro rtsp' });
    if (!/^rtsp:\/\//i.test(rtsp)) return res.status(400).json({ exito: false, mensaje: 'RTSP debe comenzar con rtsp://'} );

    // extraer y validar host
    const parts = extractPartsFromRtsp(rtsp);
    if (!parts.host || !isValidIPv4(parts.host)) {
      // allow hostnames too
      if (!parts.host || !/^[a-zA-Z0-9\-._]+$/.test(parts.host)) {
        return res.status(400).json({ exito: false, mensaje: 'Host/IP inválido en RTSP' });
      }
    }
    if (parts.port && !isValidPort(parts.port)) return res.status(400).json({ exito: false, mensaje: 'Puerto inválido en RTSP' });

    await writeConfigFile({ rtspUrl: rtsp });
    return res.json({ exito: true, mensaje: 'RTSP guardado correctamente', RTSP_URL: rtsp });
  } catch (err) {
    console.error('❌ Error en set-rtsp:', err);
    return res.status(500).json({ exito: false, mensaje: 'Error al guardar RTSP' });
  }
});

// === Entrega de imágenes y HEADs ===
router.get('/captura.jpg', (_req, res) => {
  const fotoPath = path.join(sacarfotoDir, 'captura.jpg');
  if (!fs.existsSync(fotoPath)) return res.status(404).send('No hay foto');
  res.sendFile(fotoPath);
});
router.head('/captura.jpg', (_req, res) => {
  const fotoPath = path.join(sacarfotoDir, 'captura.jpg');
  return fs.existsSync(fotoPath) ? res.status(200).end() : res.status(404).end();
});

router.get('/capturaTest.jpg', (_req, res) => {
  const fotoTestPath = path.join(sacarfotoDir, 'capturaTest.jpg');
  if (!fs.existsSync(fotoTestPath)) return res.status(404).send('No hay foto test');
  res.sendFile(fotoTestPath);
});
router.head('/capturaTest.jpg', (_req, res) => {
  const fotoTestPath = path.join(sacarfotoDir, 'capturaTest.jpg');
  return fs.existsSync(fotoTestPath) ? res.status(200).end() : res.status(404).end();
});

// GET /sacarfoto -> ejecuta sacarfoto.py que genera captura.jpg
router.get('/sacarfoto', async (_req, res) => {
  try {
    const result = await runCaptureScript();
    console.log('📸 sacarfoto stdout:', result.stdout);
    if (result.code !== 0) {
      console.error('❌ Error en captura:', result.stderr || result.stdout);
      return res.status(500).json({ exito: false, mensaje: 'No se pudo capturar la foto.' });
    }
    const fotoPath = path.join(sacarfotoDir, 'captura.jpg');
    if (!fs.existsSync(fotoPath)) {
      return res.status(500).json({ exito: false, mensaje: 'El script finalizó pero no se creó captura.jpg' });
    }
    return res.json({ exito: true, mensaje: 'Foto capturada correctamente.' });
  } catch (err) {
    console.error('❌ Error ejecutando sacarfoto:', err);
    return res.status(500).json({ exito: false, mensaje: 'Error interno ejecutando captura.' });
  }
});

// GET /sacarfoto-test -> ejecuta sacarfoto.py test que genera capturaTest.jpg
router.get('/sacarfoto-test', async (_req, res) => {
  try {
    const result = await runCaptureScript('test');
    console.log('📸 sacarfoto-test stdout:', result.stdout);
    if (result.code !== 0) {
      console.error('❌ Error ejecutando el script test:', result.stderr || result.stdout);
      return res.status(500).json({ exito: false, mensaje: 'Error al ejecutar la captura test.' });
    }
    const fotoTestPath = path.join(sacarfotoDir, 'capturaTest.jpg');
    if (!fs.existsSync(fotoTestPath)) {
      console.error('❌ Script terminó OK pero no existe capturaTest.jpg');
      return res.status(500).json({ exito: false, mensaje: 'No se generó capturaTest.jpg.' });
    }
    return res.json({ exito: true, mensaje: 'Foto test capturada correctamente.' });
  } catch (err) {
    console.error('❌ Error en sacarfoto-test:', err);
    return res.status(500).json({ exito: false, mensaje: 'Error interno en capture test.' });
  }
});

module.exports = router;
