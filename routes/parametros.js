// /back-end/routes/parametros.js
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const router = express.Router();

const parametrosPath = path.join(__dirname, '../data/parametrosGlobales.json');

// ---------- Utilidades ----------
async function ensureParametrosFile() {
  try {
    await fsp.access(parametrosPath, fs.constants.F_OK);
  } catch {
    const defaults = {
      fraccionarDesde: "60",
      toleranciaInicial: 0,
      permitirCobroAnticipado: false,
      apartirdia11: 0,
      apartirdia22: 0
    };
    await fsp.mkdir(path.dirname(parametrosPath), { recursive: true });
    await fsp.writeFile(parametrosPath, JSON.stringify(defaults, null, 2), 'utf8');
  }
}

async function readParametros() {
  await ensureParametrosFile();
  const raw = await fsp.readFile(parametrosPath, 'utf8');
  return JSON.parse(raw || '{}');
}

async function writeParametros(obj) {
  await fsp.writeFile(parametrosPath, JSON.stringify(obj, null, 2), 'utf8');
}

// Normaliza % a número entero >=0
function toPct(val) {
  if (val === '' || val === null || val === undefined) return undefined;
  const n = Number(String(val).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.round(n));
}

// ---------- Rutas ----------
router.get('/', async (req, res) => {
  try {
    const parametros = await readParametros();
    return res.json(parametros);
  } catch (err) {
    console.error('Error al leer parámetros:', err);
    return res.status(500).json({ message: 'Error al leer parámetros' });
  }
});

router.post('/', async (req, res) => {
  try {
    const current = await readParametros();

    // Campos soportados (merge: solo actualizamos los provistos)
    const {
      fraccionarDesde,
      toleranciaInicial,
      permitirCobroAnticipado,
      apartirdia11,
      apartirdia22
    } = req.body || {};

    const next = { ...current };

    if (fraccionarDesde !== undefined) next.fraccionarDesde = String(fraccionarDesde);
    if (toleranciaInicial !== undefined) next.toleranciaInicial = Number(toleranciaInicial) || 0;
    if (permitirCobroAnticipado !== undefined) next.permitirCobroAnticipado = !!permitirCobroAnticipado;

    // Recargos (porcentaje entero, >=0)
    const p11 = toPct(apartirdia11);
    const p22 = toPct(apartirdia22);
    if (p11 !== undefined) next.apartirdia11 = p11;
    if (p22 !== undefined) next.apartirdia22 = p22;

    await writeParametros(next);
    return res.json({ success: true, parametros: next });
  } catch (err) {
    console.error('Error al guardar parametros:', err);
    return res.status(500).json({ success: false, message: 'Error al guardar parámetros' });
  }
});

module.exports = router;
