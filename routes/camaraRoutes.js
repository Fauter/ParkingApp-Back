const fs = require('fs');
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const router = express.Router();

const configPath = path.join(__dirname, '..', 'camara', 'config.txt');
const sacarfotoDir = path.join(__dirname, '..', 'camara', 'sacarfoto');
const scriptPath = path.join(sacarfotoDir, 'sacarfoto.py');

const pythonCmd = process.env.PYTHON || 'python'; // si tu entorno usa 'python3' podés setear PYTHON=python3

function runCaptureScript(arg = '') {
  return new Promise((resolve) => {
    const args = arg ? [scriptPath, arg] : [scriptPath];
    const proc = spawn(pythonCmd, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: (stderr + err.message) });
    });
  });
}

// POST /set-ip -> guarda IP en config.txt con formato RTSP_URL=...
router.post('/set-ip', (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).send('Falta la IP');

  const rtspUrl = `RTSP_URL=rtsp://admin:admin@${ip}:554/streaming/channels/1\n`;
  fs.writeFile(configPath, rtspUrl, 'utf8', (err) => {
    if (err) {
      console.error('❌ Error al escribir el archivo:', err);
      return res.status(500).send('Error al guardar la IP');
    }
    console.log('✅ IP de cámara actualizada');
    res.send('IP actualizada correctamente');
  });
});

// GET /get-ip -> lee config.txt y devuelve la IP
router.get('/get-ip', (req, res) => {
  if (!fs.existsSync(configPath)) return res.status(404).send('No hay config');

  const data = fs.readFileSync(configPath, 'utf8');
  const line = data.split('\n').find(l => l.startsWith('RTSP_URL='));
  if (!line) return res.status(404).send('No se encontró RTSP_URL');

  const match = line.match(/rtsp:\/\/[^@]+@(.+?):554/);
  if (!match) return res.status(500).send('Formato de RTSP_URL incorrecto');

  const ip = match[1];
  res.json({ ip });
});

// GET /captura.jpg -> envía captura.jpg si existe
router.get('/captura.jpg', (req, res) => {
  const fotoPath = path.join(sacarfotoDir, 'captura.jpg');
  if (!fs.existsSync(fotoPath)) return res.status(404).send('No hay foto');
  res.sendFile(fotoPath);
});

// GET /capturaTest.jpg -> envía capturaTest.jpg si existe
router.get('/capturaTest.jpg', (req, res) => {
  const fotoTestPath = path.join(sacarfotoDir, 'capturaTest.jpg');
  if (!fs.existsSync(fotoTestPath)) return res.status(404).send('No hay foto test');
  res.sendFile(fotoTestPath);
});

// GET /sacarfoto -> ejecuta sacarfoto.py que genera captura.jpg
router.get('/sacarfoto', async (req, res) => {
  const result = await runCaptureScript();
  console.log('📸 sacarfoto stdout:', result.stdout);
  if (result.code !== 0) {
    console.error('❌ Error en captura:', result.stderr || result.stdout);
    return res.json({ exito: false, mensaje: 'No se pudo capturar la foto.' });
  }
  const fotoPath = path.join(sacarfotoDir, 'captura.jpg');
  if (!fs.existsSync(fotoPath)) {
    return res.json({ exito: false, mensaje: 'El script finalizó pero no se creó captura.jpg' });
  }
  return res.json({ exito: true, mensaje: 'Foto capturada correctamente.' });
});

// GET /sacarfoto-test -> ejecuta sacarfoto.py test que genera capturaTest.jpg
router.get('/sacarfoto-test', async (req, res) => {
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
});

module.exports = router;
