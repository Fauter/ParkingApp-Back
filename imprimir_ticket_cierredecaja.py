# -*- coding: utf-8 -*-
"""
Ticket de CIERRE:
- Soporta 2 modos: "cierreDeCaja" (total) y "cierreParcial".
- Imprime encabezado con caja [X], "Eleven Park S.A.", "Aguero 256", separador.
- Cierre de Caja: Fecha, Hora, Operador, Total en Caja, Queda en Caja, Total Rendido.
- Cierre Parcial: Fecha, Hora, Operador, Monto y, si existe, Nombre (sin descripción).
- Si la impresora es "Microsoft Print to PDF" (o contiene "print to pdf"):
  NO imprime: guarda PREVIEW en PNG y PDF y lo abre.
- Pie con agradecimiento y texto legal ("Jurisdicción...").

Entrada (argv[1]): JSON con forma:
{
  "tipo": "cierreDeCaja" | "cierreParcial",
  "cierre": { "fecha": "...", "hora": "...", "totalRecaudado": 0, "dejoEnCaja": 0, "totalRendido": 0 },
  "parcial": { "fecha": "...", "hora": "...", "monto": 0, "nombre": "..." },
  "operador": { "_id":"...", "username":"...", "nombre":"...", "apellido":"..." }
}
"""

import os, sys, json
from datetime import datetime

# Salida UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# PyWin32
try:
    import win32print, win32ui, win32con
except Exception as e:
    print(f"ERROR: PyWin32 no disponible: {e}")
    raise SystemExit(1)

# PIL
try:
    from PIL import Image, ImageDraw, ImageFont, ImageWin, __version__ as PIL_VERSION
    PIL_OK = True
except Exception as e:
    PIL_OK = False
    PIL_VERSION = "N/A"

COMPANY_NAME = "Estacionamiento."
LOCATION_TEXT = "Aguero 256"  # segunda línea de encabezado

# ------------------------- Utils -------------------------
def _normalize(s: str) -> str:
    return (s or "").strip().lower()

def _today_str():
    return datetime.now().strftime("%Y-%m-%d")

def _now_str_ar():
    return datetime.now().strftime("%d/%m/%Y %H:%M:%S")

def _ensure_dir(p):
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:
        pass

def _debug_env():
    print("==== DEBUG ENTORNO ====")
    print(f"Pillow={PIL_OK} (v{PIL_VERSION})")
    print(f"Python: {sys.executable}")
    print("=======================")

def money_ar(num) -> str:
    try:
        n = float(num)
    except Exception:
        return str(num)
    # miles con '.', sin decimales
    s = f"{n:,.0f}"
    return s.replace(",", ".")

def _pick_operador_str(op: dict) -> str:
    if not isinstance(op, dict):
        return ""
    username = (op.get("username") or "").strip()
    nombre = (op.get("nombre") or "").strip()
    apellido = (op.get("apellido") or "").strip()
    if username:
        return username
    full = f"{nombre} {apellido}".strip()
    if full:
        return full
    return (op.get("_id") or "")[:8]

# ---------------------- Config impresora ------------------
def _load_configured_printer_name():
    base_dir = os.path.abspath(os.path.dirname(__file__))
    cfg_path = os.path.join(base_dir, "configuracion", "impresora.json")
    print(f"DEBUG: Leyendo impresora desde: {cfg_path}")
    if not os.path.exists(cfg_path):
        print("WARNING: impresora.json no existe. Se usará fallback.")
        return None
    data = None
    for enc in ("utf-8", "latin-1"):
        try:
            with open(cfg_path, "r", encoding=enc) as f:
                data = json.load(f)
            break
        except Exception:
            data = None
    if not isinstance(data, dict):
        print("WARNING: impresora.json inválido. Se usará fallback.")
        return None
    raw = (data.get("nombre") or data.get("impresora") or "").strip()
    if not raw:
        print("WARNING: impresora.json sin campo 'nombre'/'impresora'. Se usará fallback.")
        return None
    return raw

def _list_printers_and_default():
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    try:
        printers = [p[2] for p in win32print.EnumPrinters(flags)]
    except Exception as e:
        print(f"ERROR: EnumPrinters falló: {e}")
        printers = []
    try:
        default_name = win32print.GetDefaultPrinter()
    except Exception:
        default_name = None
    printers = [(n or "").strip() for n in printers if n]
    default_name = (default_name or "").strip() or None
    return printers, default_name

def _pick_fallback(config_name, printers, default_name):
    by_norm = {_normalize(n): n for n in printers}
    if config_name:
        n_cfg = _normalize(config_name)
        if n_cfg in by_norm:
            return by_norm[n_cfg], "config"
        for n in printers:
            if _normalize(n) == n_cfg:
                return n, "config"
    for n in printers:
        ln = _normalize(n)
        if ("58" in ln) or ("xp-58" in ln) or ("pos" in ln):
            return n, "fallback-termica"
    if default_name:
        nd = _normalize(default_name)
        if nd in by_norm:
            return by_norm[nd], "default"
        for n in printers:
            if _normalize(n) == nd:
                return n, "default"
    if printers:
        return printers[0], "primera"
    return None, "none"

def get_resolved_printer_name():
    cfg = _load_configured_printer_name()
    if cfg:
        print(f"DEBUG: Impresora configurada en JSON: '{cfg}'")
    printers, default_name = _list_printers_and_default()
    print(f"DEBUG: Impresoras disponibles: {printers}")
    if default_name:
        print(f"DEBUG: Impresora predeterminada del sistema: '{default_name}'")
    chosen, reason = _pick_fallback(cfg, printers, default_name)
    if not chosen:
        print("ERROR: No hay impresoras. Abortando.")
        raise SystemExit(1)
    if cfg and _normalize(chosen) != _normalize(cfg):
        print(f"WARNING: La impresora configurada no está. Usando '{chosen}' ({reason}).")
    else:
        print(f"INFO: Usando impresora '{chosen}' (motivo: {reason}).")
    return chosen

def _is_preview_printer(printer_name: str) -> bool:
    n = _normalize(printer_name)
    return ("microsoft print to pdf" in n) or ("print to pdf" in n)

# ---------------------- Render (PIL) ----------------------
def _load_font(size):
  try:
      return ImageFont.truetype("consola.ttf", size)
  except Exception:
      try:
          return ImageFont.truetype("DejaVuSans.ttf", size)
      except Exception:
          return ImageFont.load_default()

def _text_wh(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]

def _draw_text(draw, xy, text, font, fill=0, heavy=False):
    x, y = xy
    try:
        draw.text((x, y), text, fill=fill, font=font,
                  stroke_width=(1 if heavy else 0), stroke_fill=fill)
    except TypeError:
        if heavy:
            draw.text((x, y), text, fill=fill, font=font)
            draw.text((x+1, y), text, fill=fill, font=font)
        else:
            draw.text((x, y), text, fill=fill, font=font)

def _draw_center(draw, text, y, font, canvas_w, fill=0, heavy=False):
    w, h = _text_wh(draw, text, font)
    x = max(0, (canvas_w - w) // 2)
    _draw_text(draw, (x, y), text, font, fill=fill, heavy=heavy)
    return y + h

def _draw_left(draw, text, y, font, x_left, fill=0, heavy=False):
    _, h = _text_wh(draw, text, font)
    _draw_text(draw, (x_left, y), text, font, fill=fill, heavy=heavy)
    return y + h

def _draw_box_with_x(draw, center_x, y, size, padding=6, stroke=2, color=0, fill=None):
    half = size // 2
    left = max(0, center_x - half)
    right = left + size
    top = y
    bottom = y + size
    if fill is not None:
        draw.rectangle([left, top, right, bottom], fill=fill, outline=color, width=stroke)
    else:
        draw.rectangle([left, top, right, bottom], outline=color, width=stroke)

    il = left + padding
    ir = right - padding
    it = top + padding
    ib = bottom - padding

    draw.line([il, it, ir, ib], fill=color, width=stroke)
    draw.line([il, ib, ir, it], fill=color, width=stroke)
    return bottom

def render_ticket_cierre(payload: dict, not_pdf: bool = False):
    """
    Devuelve PIL.Image 'L' con el ticket del cierre (total o parcial).
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    tipo = (payload.get("tipo") or "").strip()
    cierre = payload.get("cierre") or {}
    parcial = payload.get("parcial") or {}
    operador = payload.get("operador") or {}

    # Layout 58mm a 203dpi (~384 px de ancho)
    canvas_w = 384

    # Estilos
    scale = 1.5 if not_pdf else 1.0
    heavy = True if not_pdf else False
    margin_top   = 2 if not_pdf else 10
    margin_side  = 2 if not_pdf else 10
    margin_bottom = 3
    gap = 6

    font_title_size  = int(round(30 * scale))
    font_huge_size   = int(round(32 * scale))
    font_body_size   = int(round(22 * scale))
    font_footer_size = int(round(18 * scale))
    font_small_size  = max(8, int(round(font_footer_size * 0.60)))

    font_title   = _load_font(font_title_size)
    font_huge    = _load_font(font_huge_size)
    font_body    = _load_font(font_body_size)
    font_footer  = _load_font(font_footer_size)
    font_small   = _load_font(font_small_size)

    # Data normalizada
    if tipo == "cierreDeCaja":
        fecha = cierre.get("fecha") or ""
        hora  = cierre.get("hora") or ""
        totalRecaudado = cierre.get("totalRecaudado") or 0
        dejoEnCaja     = cierre.get("dejoEnCaja") or 0
        totalRendido   = cierre.get("totalRendido") or 0
        titulo = "CIERRE DE CAJA"
        cuerpo = [
            ("Fecha", fecha),
            ("Hora", hora),
            ("Operador", _pick_operador_str(operador)),
            ("Total en Caja", f"${money_ar(totalRecaudado)}"),
            ("Queda en Caja", f"${money_ar(dejoEnCaja)}"),
            ("Total Rendido", f"${money_ar(totalRendido)}"),
        ]
        base_name = "CierreDeCaja"
    elif tipo == "cierreParcial":
        fecha = parcial.get("fecha") or ""
        hora  = parcial.get("hora") or ""
        monto = parcial.get("monto") or 0
        nombre = parcial.get("nombre") or ""
        titulo = "CIERRE PARCIAL"
        cuerpo = [
            ("Fecha", fecha),
            ("Hora", hora),
            ("Operador", _pick_operador_str(operador)),
            ("Monto", f"${money_ar(monto)}"),
        ]
        if nombre:
            cuerpo.append(("Nombre", nombre))
        base_name = "CierreParcial"
    else:
        # fallback
        fecha = datetime.now().strftime("%Y-%m-%d")
        hora  = datetime.now().strftime("%H:%M")
        titulo = "CIERRE"
        cuerpo = [
            ("Fecha", fecha),
            ("Hora", hora),
            ("Operador", _pick_operador_str(operador)),
        ]
        base_name = "Cierre"

    # Footer & legal
    footer_texts = ["¡Gracias por elegirnos!"]
    legal_texts  = ["Aceptación Contrato (Adm.) – Jurisdicción: Tribunales CABA"]

    # Cálculo de altura
    dummy = Image.new("L", (1,1), 255)
    d = ImageDraw.Draw(dummy)

    _, h_title = _text_wh(d, COMPANY_NAME, font_title)
    _, h_loc   = _text_wh(d, LOCATION_TEXT, font_body)
    _, h_big   = _text_wh(d, titulo, font_huge)

    h_cuerpo = 0
    for k, v in cuerpo:
        _, h = _text_wh(d, f"{k}: {v}", font_body)
        h_cuerpo += h + gap

    h_footer = 0
    for t in footer_texts:
        _, h = _text_wh(d, t, font_footer)
        h_footer += h + 2
    h_legal = 0
    for t in legal_texts:
        _, h = _text_wh(d, t, font_small)
        h_legal += h + gap

    cross_size = 26
    cross_gap  = 8

    canvas_h = (
        margin_top +
        cross_size + cross_gap +
        h_title + gap +
        h_loc + gap +
        2 + gap +   # línea separadora
        6 +         # padding extra
        h_big + gap +
        h_cuerpo +
        8 +         # margen top footer
        h_footer +
        h_legal +
        margin_bottom
    )

    canvas = Image.new("L", (canvas_w, canvas_h), 255)
    draw   = ImageDraw.Draw(canvas)

    y = margin_top
    center_x = canvas_w // 2

    # [X] caja con cruz
    y = _draw_box_with_x(draw, center_x, y, cross_size, padding=6, stroke=2, color=0, fill=None)
    y += cross_gap

    # Header
    y = _draw_center(draw, COMPANY_NAME, y, font_title, canvas_w, heavy=heavy); y += gap
    y = _draw_center(draw, LOCATION_TEXT, y, font_body, canvas_w, heavy=heavy); y += gap
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 2 + gap
    y += 6

    # Título de sección
    y = _draw_center(draw, titulo, y, font_huge, canvas_w, heavy=True); y += gap

    # Cuerpo (labels + valores)
    x_left = margin_side
    for k, v in cuerpo:
        y = _draw_left(draw, f"{k}: {v}", y, font_body, x_left, heavy=heavy)
        y += 2

    # Footer
    y += 8
    for idx, t in enumerate(footer_texts):
        y = _draw_center(draw, t, y, font_footer, canvas_w, heavy=heavy)
        if idx == 0: y += 2

    # Legal
    for t in legal_texts:
        y += gap
        y = _draw_center(draw, t, y, font_small, canvas_w, heavy=heavy)

    return canvas, base_name

# ---------------------- Impresión GDI ---------------------
def _start_doc(dc, title="Ticket"):
    dc.StartDoc(str(title))
    dc.StartPage()

def _end_doc(dc):
    try:
        dc.EndPage()
    finally:
        try:
            dc.EndDoc()
        except Exception:
            pass

def _print_bitmap_via_gdi(printer_name, pil_image_rgb, title="Ticket"):
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(printer_name)
    _start_doc(hDC, title=title)
    dib_hw = ImageWin.Dib(pil_image_rgb)
    w, h = pil_image_rgb.size
    dib_hw.draw(hDC.GetHandleOutput(), (0, 0, w, h))
    _end_doc(hDC)
    print("INFO: Impresión bitmap vía GDI completada.")

# ---------------------- PREVIEW ---------------------------
def _save_preview(canvas_img, base_name):
    out_dir = os.path.join(os.path.abspath(os.path.dirname(__file__)),
                           "tickets_preview", _today_str())
    _ensure_dir(out_dir)
    stamp = datetime.now().strftime("%H%M%S")
    base = os.path.join(out_dir, f"{base_name}_{stamp}")
    png_path = base + ".png"
    pdf_path = base + ".pdf"

    canvas_img.convert("RGB").save(png_path, "PNG", optimize=True)
    canvas_img.convert("RGB").save(pdf_path, "PDF")

    print(f"INFO: PREVIEW guardado en:\n - {png_path}\n - {pdf_path}")
    try:
        os.startfile(pdf_path)
    except Exception as e:
        print(f"WARNING: No se pudo abrir el PDF automáticamente: {e}")

# ---------------------- Parse args ------------------------
def _parse_payload():
    """
    Lee JSON desde argv[1]. Alternativa: env var CIERRE_JSON.
    Estructura esperada en el docstring superior.
    """
    raw = os.environ.get("CIERRE_JSON", "").strip()
    if len(sys.argv) >= 2 and (sys.argv[1] or "").strip():
        raw = sys.argv[1].strip()
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except Exception as e:
        print(f"WARNING: argv[1] no es JSON válido ({e}).")
    return {}

# ---------------------- Main ------------------------------
def main():
    _debug_env()

    payload = _parse_payload()
    if not payload:
        print("ERROR: Sin payload de cierre/parcial.")
        raise SystemExit(1)

    printer_name = get_resolved_printer_name()

    # Render
    canvas, base_name = render_ticket_cierre(payload, not_pdf=(not _is_preview_printer(printer_name)))

    # PREVIEW vs impresión real
    if _is_preview_printer(printer_name):
        _save_preview(canvas, base_name)
        return

    # Impresión real (bitmap)
    try:
        _print_bitmap_via_gdi(printer_name, canvas.convert("RGB"), title=base_name)
    except Exception as e:
        print(f"ERROR: impresión falló: {e}")
        raise

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: excepción no controlada en imprimir_ticket_cierredecaja.py: {e}")
        raise
