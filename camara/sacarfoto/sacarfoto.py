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

# === Directorios ===
# Usá el CAMARA_DIR que setea Electron/Backend (userData/camara)
CAMARA_DIR = os.environ.get('CAMARA_DIR')
if not CAMARA_DIR:
    # fallback: carpeta del script (dev)
    CAMARA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__)))
try:
    os.makedirs(CAMARA_DIR, exist_ok=True)
except Exception as e:
    print(f"❌ No pude crear CAMARA_DIR={CAMARA_DIR}: {e}", flush=True)

CONFIG_PATH = os.path.join(CAMARA_DIR, "config.txt")

def cargar_rtsp():
    if not os.path.exists(CONFIG_PATH):
        print(f"❌ No se encontró config.txt en {CONFIG_PATH}.", flush=True)
        return None
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith("RTSP_URL="):
                return line.strip().split("=", 1)[1]
    print("❌ No se encontró RTSP_URL en config.txt.", flush=True)
    return None

def sanitize_rtsp(rtsp):
    if not rtsp:
        return rtsp
    rtsp = rtsp.strip()
    rtsp = rtsp.replace("::", ":")
    rtsp = re.sub(r":554:554", ":554", rtsp)
    return rtsp

def try_opencv_capture(rtsp_url, output_path, timeout=8):
    backends = []
    if hasattr(cv2, "CAP_FFMPEG"):
        backends.append(cv2.CAP_FFMPEG)
    if hasattr(cv2, "CAP_GSTREAMER"):
        backends.append(cv2.CAP_GSTREAMER)
    backends.append(None)  # default

    for backend in backends:
        try:
            cap = cv2.VideoCapture(rtsp_url, backend) if backend is not None else cv2.VideoCapture(rtsp_url)
        except Exception as e:
            print(f"⚠️ Error abriendo VideoCapture con backend {backend}: {e}", flush=True)
            continue

        start = time.time()
        opened = False
        while time.time() - start < timeout:
            if cap.isOpened():
                opened = True
                break
            time.sleep(0.3)

        if not opened:
            cap.release()
            print(f"⚠️ Backend {backend} no pudo abrir stream (timeout).", flush=True)
            continue

        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

        read_start = time.time()
        while time.time() - read_start < timeout:
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
            time.sleep(0.25)

        cap.release()
        print(f"⚠️ Backend {backend} abrió stream pero no devolvió frame.", flush=True)

    return False

def try_ffmpeg_capture(rtsp_url, output_path, timeout=12):
    ffmpeg_bin = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if not ffmpeg_bin:
        print("⚠️ ffmpeg no está disponible en PATH. No se puede usar fallback.", flush=True)
        return False

    cmd = [
        ffmpeg_bin,
        "-rtsp_transport", "tcp",
        "-y",
        "-i", rtsp_url,
        "-frames:v", "1",
        "-q:v", "2",
        output_path
    ]

    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if proc.returncode == 0 and os.path.exists(output_path):
            return True
        else:
            print("⚠️ ffmpeg falló:", proc.returncode, proc.stderr.decode(errors="ignore")[:200], flush=True)
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
    ok = try_opencv_capture(rtsp, output_path, timeout=8)

    if not ok:
        print("🔁 Fallback a ffmpeg...", flush=True)
        ok = try_ffmpeg_capture(rtsp, output_path, timeout=12)

    if ok and os.path.exists(output_path):
        print(f"✅ Foto guardada en {output_path}", flush=True)
        print("OK", flush=True)
        sys.exit(0)
    else:
        print("❌ No se pudo capturar la imagen.", flush=True)
        print("ERROR", flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
