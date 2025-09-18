const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(__dirname, '..', 'configuracion');
const CONFIG_FILE = path.join(CONFIG_DIR, 'impresora.json');
const PYTHON_SCRIPT = path.join(__dirname, '..', 'services', 'listar_impresoras.py');

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

function spawnWithFallbacks(cmds, args, opts = {}, timeoutMs = 7000) {
  return new Promise((resolve) => {
    let i = 0;
    let proc = null;
    let killed = false;
    let timer = null;

    const tryNext = () => {
      if (i >= cmds.length) return resolve({ rc: -1, out: '', err: 'No executable found' });
      const exe = cmds[i++];
      let out = '';
      let err = '';
      try {
        proc = spawn(exe, args, opts);
      } catch (e) {
        return tryNext();
      }

      timer = setTimeout(() => {
        if (proc && !killed) {
          killed = true;
          proc.kill('SIGKILL');
          // probar siguiente
          tryNext();
        }
      }, timeoutMs);

      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('error', () => {
        clearTimeout(timer);
        tryNext();
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return; // ya pasamos al siguiente
        if (code === 0 && out.trim()) {
          resolve({ rc: code, out, err });
        } else {
          // probar siguiente
          tryNext();
        }
      });
    };

    tryNext();
  });
}

async function runPythonList() {
  // Probar varios lanzadores de Python
  const candidates = [
    'python', 'py', 'py.exe', 'python3', 'python3.exe'
  ];
  const res = await spawnWithFallbacks(
    candidates,
    [PYTHON_SCRIPT],
    {},
    8000
  );
  return res;
}

async function runPowershellDirect() {
  const ps = [
    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Try { $list = Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default; if ($list) { $list | ConvertTo-Json -Compress } else { '[]' } } Catch { '[]' }"
  ];
  return new Promise((resolve) => {
    const child = spawn(ps[0], ps.slice(1));
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ rc: -1, out: '', err: 'powershell timeout' });
    }, 6000);

    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ rc: -1, out: '', err: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ rc: code, out, err });
    });
  });
}

function mergeWithConfigPreference(list, def) {
  let impresoras = Array.isArray(list) ? list.slice() : [];
  let pred = def || '';

  // Prioridad a la elegida por el usuario si existe
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const json = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (json.impresora && impresoras.includes(json.impresora)) {
        pred = json.impresora;
      }
    } catch (e) {
      console.error('⚠️ Error leyendo impresora.json:', e);
    }
  }

  // Si el default no está en la lista pero hay lista, caer al primero
  if (!pred || !impresoras.includes(pred)) {
    pred = impresoras[0] || '';
  }

  // Ordenar default primero
  const resto = impresoras.filter(i => i !== pred);
  return {
    default: pred,
    impresoras: pred ? [pred, ...resto] : impresoras
  };
}

exports.getImpresoras = async (req, res) => {
  try {
    // 1) Intento normal: Python (que ya trae PS/WMIC/Registry adentro)
    const py = await runPythonList();

    let parsed = null;
    if (py.rc === 0 && py.out.trim()) {
      try {
        parsed = JSON.parse(py.out);
      } catch (e) {
        console.warn('parse python json error:', e);
      }
    }

    // 2) Si Python no está o vino vacío, intentamos PowerShell directo
    if (!parsed || (!parsed.impresoras || parsed.impresoras.length === 0)) {
      const ps = await runPowershellDirect();
      if (ps.rc === 0 && ps.out.trim()) {
        try {
          let data = JSON.parse(ps.out);
          if (Array.isArray(data)) {
            const lista = [];
            let pred = '';
            for (const item of data) {
              const name = (item.Name || '').trim();
              const def = (String(item.Default || '').toLowerCase() === 'true');
              if (name) lista.push(name);
              if (def) pred = name;
            }
            parsed = { impresoras: lista, default: pred, source: 'powershell-direct' };
          }
        } catch (e) {
          console.warn('parse powershell json error:', e);
        }
      }
    }

    // 3) Si aún no tenemos nada, devolvemos vacío pero sin 500.
    let impresoras = Array.isArray(parsed?.impresoras) ? parsed.impresoras : [];
    let def = typeof parsed?.default === 'string' ? parsed.default : '';

    const { default: finalDef, impresoras: finalList } = mergeWithConfigPreference(impresoras, def);

    return res.json({
      default: finalDef,
      impresoras: finalList,
      source: parsed?.source || 'fallback',
      diagnostics: parsed?.diagnostics || undefined
    });
  } catch (e) {
    console.error('❌ getImpresoras fatal:', e);
    // Aún en error, respondemos algo razonable
    let pred = '';
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const json = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (json.impresora) pred = json.impresora;
      }
    } catch {}
    return res.json({
      default: pred || '',
      impresoras: pred ? [pred] : [],
      source: 'error-safe'
    });
  }
};

exports.setImpresora = (req, res) => {
  const { impresora } = req.body;
  if (!impresora || typeof impresora !== 'string') {
    return res.status(400).json({ error: 'Nombre de impresora inválido' });
  }

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ impresora }, null, 2));
    res.json({ message: '✅ Impresora guardada correctamente' });
  } catch (e) {
    console.error('❌ Error guardando impresora:', e);
    res.status(500).json({ error: 'No se pudo guardar la impresora' });
  }
};
