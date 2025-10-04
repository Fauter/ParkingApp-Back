#!/usr/bin/env python3
import cv2
import os
import sys
import time
import subprocess
import shutil
import re

# UTF-8 en stdout (para Windows)
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# === Directorios & config ===
# - El OUTPUT (captura.jpg) se guarda en CAMARA_DIR (si existe) o en la carpeta del script.
# - El config.txt se busca en: CAMARA_DIR, carpeta del script, carpeta padre (..\camara) y cwd.
ENV_CAMARA_DIR = os.environ.get('CAMARA_DIR')
BASE_DIR = os.path.abspath(os.path.dirname(__file__))                      # ...\camara\sacarfoto
PARENT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))                 # ...\camara
CWD_DIR = os.getcwd()

# Donde guardar la captura
CAMARA_DIR = ENV_CAMARA_DIR if ENV_CAMARA_DIR else BASE_DIR
try:
    os.makedirs(CAMARA_DIR, exist_ok=True)
except Exception as e:
    print(f"⚠️ No pude crear CAMARA_DIR={CAMARA_DIR}: {e}", flush=True)

# Dónde buscar el config.txt
CANDIDATE_DIRS = []
if ENV_CAMARA_DIR:
    CANDIDATE_DIRS.append(ENV_CAMARA_DIR)
CANDIDATE_DIRS += [BASE_DIR, PARENT_DIR, CWD_DIR]

def find_config_path():
    for d in CANDIDATE_DIRS:
        p = os.path.join(d, "config.txt")
        if os.path.exists(p):
            return p
    return None

CONFIG_PATH = find_config_path()

def cargar_rtsp():
    # Permite override por variable de entorno
    rtsp_env = os.environ.get("RTSP_URL")
    if rtsp_env:
        print("ℹ️ RTSP_URL tomado de variable de entorno.", flush=True)
        return rtsp_env.strip()

    if not CONFIG_PATH:
        rutas = "\n  - " + "\n  - ".join(CANDIDATE_DIRS)
        print(f"❌ No se encontró config.txt en ninguna de las rutas candidatas:{rutas}", flush=True)
        return None

    print(f"📝 Usando config: {CONFIG_PATH}", flush=True)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip().startswith("RTSP_URL="):
                    return line.strip().split("=", 1)[1]
    except Exception as e:
        print(f"❌ Error leyendo {CONFIG_PATH}: {e}", flush=True)
        return None

    print("❌ No se encontró RTSP_URL en config.txt.", flush=True)
    return None

def sanitize_rtsp(rtsp):
    if not rtsp:
        return rtsp
    rtsp = rtsp.strip()
    rtsp = rtsp.replace("::", ":")
    rtsp = re.sub(r":554:554", ":554", rtsp)
    return rtsp

# === Parámetros de timeout (ajustados para no colgar el flujo) ===
# - Watchdog total: corta todo el proceso si se excede.
# - Timeouts por backend OpenCV y por ffmpeg más cortos.
MAX_TOTAL_SECONDS = float(os.environ.get("CAPTURE_TIMEOUT_TOTAL", "7"))   # antes ~20s; ahora 7s total
OPENCV_TIMEOUT_SEC = float(os.environ.get("CAPTURE_TIMEOUT_OPENCV", "3"))
FFMPEG_TIMEOUT_SEC = float(os.environ.get("CAPTURE_TIMEOUT_FFMPEG", "4"))

def remaining_time(deadline):
    return max(0.0, deadline - time.time())

def try_opencv_capture(rtsp_url, output_path, timeout, deadline):
    """Intenta capturar con OpenCV usando varios backends, respetando timeout corto y watchdog."""
    backends = []
    if hasattr(cv2, "CAP_FFMPEG"):
        backends.append(cv2.CAP_FFMPEG)
    if hasattr(cv2, "CAP_GSTREAMER"):
        backends.append(cv2.CAP_GSTREAMER)
    backends.append(None)  # default

    for backend in backends:
        # Si ya no queda tiempo total, cortamos
        if remaining_time(deadline) <= 0.05:
            return False

        # Timeout efectivo: no superar el remaining del watchdog
        eff_timeout = min(timeout, remaining_time(deadline))
        if eff_timeout <= 0.05:
            return False

        try:
            cap = cv2.VideoCapture(rtsp_url, backend) if backend is not None else cv2.VideoCapture(rtsp_url)
        except Exception as e:
            print(f"⚠️ Error abriendo VideoCapture con backend {backend}: {e}", flush=True)
            continue

        start = time.time()
        opened = False
        # Espera de apertura, corta rápido
        while time.time() - start < eff_timeout:
            if cap.isOpened():
                opened = True
                break
            time.sleep(0.15)

        if not opened:
            cap.release()
            print(f"⚠️ Backend {backend} no pudo abrir stream (timeout).", flush=True)
            continue

        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

        # Intento de lectura de frame con ventana corta
        read_window = min(1.5, eff_timeout)  # no te quedes leyendo eternamente
        read_start = time.time()
        while time.time() - read_start < read_window:
            ret, frame = cap.read()
            if ret and frame is not None:
                try:
                    cv2.imwrite(output_path, frame)
                    cap.release()
                    return True
                except Exception as e:
                    print(f"❌ Error guardando imagen: {e}", flush=True)
                    cap.release()
                    return False
            time.sleep(0.1)

        cap.release()
        print(f"⚠️ Backend {backend} abrió stream pero no devolvió frame.", flush=True)

    return False

def try_ffmpeg_capture(rtsp_url, output_path, timeout, deadline):
    """Fallback con ffmpeg con timeout estricto y corte inmediato si hay 401."""
    ffmpeg_bin = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if not ffmpeg_bin:
        print("⚠️ ffmpeg no está disponible en PATH. No se puede usar fallback.", flush=True)
        return False

    # No ejecutes si no queda tiempo de watchdog
    eff_timeout = min(timeout, remaining_time(deadline))
    if eff_timeout <= 0.05:
        return False

    cmd = [
        ffmpeg_bin,
        "-rtsp_transport", "tcp",
        # Limita I/O de red de ffmpeg para que no se quede colgado (cuando se respeta)
        "-rw_timeout", "2000000",  # 2s en microsegundos
        "-y",
        "-i", rtsp_url,
        "-frames:v", "1",
        "-q:v", "2",
        output_path
    ]

    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=eff_timeout)
        stderr = proc.stderr.decode(errors="ignore")
        # Corte inmediato si credenciales inválidas
        if "401 Unauthorized" in stderr:
            print("❌ Error en captura: 401 Unauthorized (credenciales RTSP).", flush=True)
            return False
        if proc.returncode == 0 and os.path.exists(output_path):
            return True
        else:
            print("⚠️ ffmpeg falló:", proc.returncode, stderr[:200], flush=True)
            return False
    except subprocess.TimeoutExpired:
        # Aseguramos que no quede zombie
        print("⚠️ ffmpeg timeout (corte por watchdog).", flush=True)
        return False
    except Exception as e:
        print("❌ Error ejecutando ffmpeg:", e, flush=True)
        return False

def main():
    filename = "captura.jpg"
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        filename = "capturaTest.jpg"

    output_path = os.path.join(CAMARA_DIR, filename)

    rtsp = cargar_rtsp()
    if not rtsp:
        print("ERROR", flush=True)
        sys.exit(1)

    rtsp = sanitize_rtsp(rtsp)

    print(f"📁 CAMARA_DIR={CAMARA_DIR}", flush=True)
    print(f"🔍 Intentando capturar desde: {rtsp}", flush=True)

    # Watchdog total para impedir bloqueos largos
    deadline = time.time() + MAX_TOTAL_SECONDS

    ok = try_opencv_capture(rtsp, output_path, timeout=OPENCV_TIMEOUT_SEC, deadline=deadline)

    if not ok and remaining_time(deadline) > 0.05:
        print("🔁 Fallback a ffmpeg...", flush=True)
        ok = try_ffmpeg_capture(rtsp, output_path, timeout=FFMPEG_TIMEOUT_SEC, deadline=deadline)

    if ok and os.path.exists(output_path):
        print(f"✅ Foto guardada en {output_path}", flush=True)
        print("OK", flush=True)
        sys.exit(0)
    else:
        # Si el problema fue credenciales, ya se informó en ffmpeg; igual devolvemos error genérico
        print("❌ No se pudo capturar la imagen.", flush=True)
        print("ERROR", flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
