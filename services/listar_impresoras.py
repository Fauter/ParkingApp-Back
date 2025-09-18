import subprocess
import json
import sys
import re
import os
import itertools

# Python 3 stdlib
try:
    import winreg  # type: ignore
except Exception:
    winreg = None  # en teoría siempre está en Windows, pero lo cuidamos

def _run(cmd, timeout=5):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as e:
        return -1, "", str(e)

def _from_powershell():
    """
    1) PowerShell moderno: Get-CimInstance Win32_Printer → JSON
    """
    ps = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        # Seleccionamos Name y Default y convertimos a JSON compact:
        "Try { "
        "$list = Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default; "
        "if ($list) { $list | ConvertTo-Json -Compress } else { '[]' } "
        "} Catch { '[]' }"
    ]
    rc, out, err = _run(ps, timeout=6)
    if rc != 0:
        return None, f"PowerShell rc={rc} err={err or ''}"
    try:
        data = json.loads(out or "[]")
        if isinstance(data, dict):
            data = [data]
        names = []
        default_name = None
        for item in data or []:
            name = (item.get("Name") or "").strip()
            if name:
                names.append(name)
            if (str(item.get("Default")).lower() == "true") and name:
                default_name = name
        return {"impresoras": names, "default": default_name, "source": "powershell"}, None
    except Exception as e:
        return None, f"PowerShell parse error: {e}"

def _from_wmic():
    """
    2) WMIC (deprecated) – fallback. Parsea bloques Name= / Default=
    """
    rc, out, err = _run(["wmic", "printer", "get", "Name,Default", "/format:list"], timeout=5)
    if rc != 0:
        return None, f"WMIC rc={rc} err={err or ''}"
    # Normalizamos saltos (\r\n, etc.)
    text = out.replace("\r\n", "\n").strip()
    if not text:
        return {"impresoras": [], "default": None, "source": "wmic"}, None

    # Split por bloques con una o más líneas en blanco
    bloques = re.split(r"\n\s*\n", text)
    impresoras = []
    default_name = None

    for b in bloques:
        if not b.strip():
            continue
        nombre_match = re.search(r"^Name=(.+)$", b, flags=re.MULTILINE)
        default_match = re.search(r"^Default=(.+)$", b, flags=re.MULTILINE)
        if nombre_match:
            nombre = nombre_match.group(1).strip()
            if nombre:
                impresoras.append(nombre)
                if default_match:
                    raw = (default_match.group(1) or "").strip().lower()
                    if raw in ("true", "1", "yes"):
                        default_name = nombre

    return {"impresoras": impresoras, "default": default_name, "source": "wmic"}, None

def _default_from_registry():
    """
    Lee default: HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows\Device
    Valor típico: 'PrinterName,winspool,Ne00:' → tomamos lo que está antes de la primera coma.
    """
    if not winreg:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Windows") as k:
            val, _ = winreg.QueryValueEx(k, "Device")
            if isinstance(val, str) and val:
                return val.split(",")[0].strip()
    except Exception:
        pass
    return None

def _list_from_registry():
    """
    3) Lista desde registro como última chance:
       - HKLM\SYSTEM\CurrentControlSet\Control\Print\Printers (locales)
       - HKCU\Printers\Connections (red compartidas por usuario)
    """
    names = set()
    if not winreg:
        return []

    # Local printers
    try:
        path = r"SYSTEM\CurrentControlSet\Control\Print\Printers"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as k:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(k, i)
                    if sub:
                        names.add(sub.strip())
                except OSError:
                    break
                i += 1
    except Exception:
        pass

    # Network per-user printers
    try:
        path = r"Printers\Connections"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(k, i)
                    # sub suele incluir servidor, etc. Usamos el nombre tal cual.
                    if sub:
                        names.add(sub.strip())
                except OSError:
                    break
                i += 1
    except Exception:
        pass

    return sorted(n for n in names if n)

def dedupe_preserve_order(seq):
    seen = set()
    out = []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out

def obtener_impresoras():
    diagnostics = []

    # 1) PowerShell
    ps_res, ps_err = _from_powershell()
    if ps_res and ps_res.get("impresoras"):
        ps_res["diagnostics"] = diagnostics + ["powershell:ok"]
        return ps_res
    diagnostics.append(f"powershell: {ps_err or 'sin datos'}")

    # 2) WMIC fallback
    wmic_res, wmic_err = _from_wmic()
    if wmic_res and wmic_res.get("impresoras"):
        wmic_res["diagnostics"] = diagnostics + ["wmic:ok"]
        return wmic_res
    diagnostics.append(f"wmic: {wmic_err or 'sin datos'}")

    # 3) Registro fallback (última chance)
    reg_list = _list_from_registry()
    default_reg = _default_from_registry()

    impresoras = dedupe_preserve_order(reg_list)
    default_name = default_reg if default_reg in impresoras else (impresoras[0] if impresoras else None)

    return {
        "impresoras": impresoras,
        "default": default_name,
        "source": "registry",
        "diagnostics": diagnostics + ["registry:used"]
    }

if __name__ == "__main__":
    try:
        result = obtener_impresoras()
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"Error al obtener impresoras: {str(e)}"}))
