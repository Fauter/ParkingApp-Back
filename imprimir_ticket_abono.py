# -*- coding: utf-8 -*-
"""
Ticket ABONO: SIN código de barras. Muestra Pago Proporcional y pie especial.
- Si la impresora es "Microsoft Print to PDF" (o contiene "print to pdf"):
  NO imprime: guarda PREVIEW en PNG y PDF con el mismo layout y lo abre.

Entrada:
  argv[1]: puede ser un identificador de operación (no se imprime).
  argv[2] (JSON opcional) o variables de entorno:
    - proporcional  (o PROPORCIONAL)  -> string/importe para "Pago Proporcional: $..."
    - patente       (o PATENTE)       -> opcional: se puede mostrar debajo como referencia
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

COMPANY_NAME = "Eleven Park S.A."

# ------------------------- Constantes de layout -------------------------
GAP = 6                     # gap vertical base
PAD_AFTER_FECHA = 10        # padding extra debajo de "Fecha"
PAD_AFTER_PATENTE = 20      # padding extra debajo de "Patente"
LEGAL_GAP = 10              # separación entre líneas legales (más aire)

# ------------------------- Utils -------------------------

def _normalize(s: str) -> str:
    return (s or "").strip().lower()

def _today_str():
    return datetime.now().strftime("%Y-%m-%d")

def _now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def _ensure_dir(p):
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:
        pass

def _debug_env():
    print("==== DEBUG ENTORNO ====")
    print(f"PIL_OK={PIL_OK} (Pillow {PIL_VERSION})")
    print(f"Python: {sys.executable}")
    print("=======================")

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
    # térmica típica
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

def _draw_center(draw, text, y, font, canvas_w, fill=0):
    w, h = _text_wh(draw, text, font)
    x = max(0, (canvas_w - w) // 2)
    draw.text((x, y), text, fill=fill, font=font)
    return y + h

def _draw_left(draw, text, y, font, x_left, fill=0):
    _, h = _text_wh(draw, text, font)
    draw.text((x_left, y), text, fill=fill, font=font)
    return y + h

def render_ticket_canvas(lines, proporcional: str = "", patente: str = ""):
    """
    Devuelve un PIL.Image 'L' (grises) del ticket de ABONO (sin barcode).
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    # Layout 58mm a 203dpi (~384 px de ancho)
    canvas_w = 384
    margin_top   = 10
    margin_side  = 10
    margin_bottom = 3
    gap      = GAP

    font_title_size  = 29
    font_body_size   = 22
    font_footer_size = 18
    font_title        = _load_font(font_title_size)
    font_body         = _load_font(font_body_size)
    font_footer       = _load_font(font_footer_size)
    font_small_size   = max(8, int(round(font_footer_size * 0.60)))
    font_small        = _load_font(font_small_size)

    header = lines[0] if lines else COMPANY_NAME
    body   = [t for t in (lines[1:] if len(lines) > 1 else [])]

    dummy = Image.new("L", (1, 1), 255)
    d     = ImageDraw.Draw(dummy)

    # Alturas
    _, h_header = _text_wh(d, header, font_title)
    est_text_h  = h_header + gap
    est_text_h += 2 + gap  # separador fino bajo el título
    est_text_h += gap

    for t in body:
        _, h = _text_wh(d, t, font_body)
        est_text_h += h + gap
        if t.startswith("Fecha:"):
            est_text_h += PAD_AFTER_FECHA  # padding extra bajo "Fecha"

    # Footer especial abono (sin "Gracias por su visita")
    footer_texts = []  # vacío
    legal_texts  = [
        "Gracias por confiar en nosotros, recuerde que la mensualidad",
        "se paga del 1 al 10 de cada mes",
        "Ticket sin valor fiscal",
    ]

    h_footer_total = 0
    for t in footer_texts:
        _, h = _text_wh(d, t, font_footer)
        h_footer_total += h + 10

    # Altura de legal con más separación (LEGAL_GAP)
    h_legal_total = 0
    for t in legal_texts:
        _, h = _text_wh(d, t, font_small)
        h_legal_total += LEGAL_GAP + h

    # Altura de la línea "Patente" (si aplica) + su padding extra
    after_patente = 0
    if patente:
        _, hpat = _text_wh(d, f"Patente: {patente}", font_body)
        after_patente = gap + hpat + PAD_AFTER_PATENTE

    canvas_h = (margin_top + est_text_h + after_patente +
                h_footer_total + h_legal_total + margin_bottom)

    canvas   = Image.new("L", (canvas_w, canvas_h), 255)
    draw     = ImageDraw.Draw(canvas)

    y = margin_top
    # Título
    y = _draw_center(draw, header, y, font_title, canvas_w); y += gap
    # Separador fino bajo el título
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 2 + gap
    # Padding extra
    y += gap

    # Cuerpo
    for t in body:
        y = _draw_left(draw, t, y, font_body, margin_side)
        y += gap
        if t.startswith("Fecha:"):
            y += PAD_AFTER_FECHA  # **padding 10px debajo de Fecha**

    # Patente (opcional) con padding extra
    if patente:
        y = _draw_left(draw, f"Patente: {patente}", y, font_body, margin_side)
        y += PAD_AFTER_PATENTE  # **padding 20px debajo de Patente**

    # Footer (no se usa en abono, pero se deja por consistencia)
    for t in footer_texts:
        y += 10
        y = _draw_center(draw, t, y, font_footer, canvas_w)
        y += 10

    # Legal / pie pequeño — queda abajo de todo con más aire entre líneas
    for t in legal_texts:
        y += LEGAL_GAP
        _ = _draw_center(draw, t, y, font_small, canvas_w)

    return canvas

# ---------------------- Impresión GDI ---------------------

def _start_doc(dc, title="Ticket Abono"):
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

def _print_bitmap_via_gdi(printer_name, pil_image_rgb):
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(printer_name)
    _start_doc(hDC, title="Ticket Abono")
    dib_hw = ImageWin.Dib(pil_image_rgb)
    w, h = pil_image_rgb.size
    dib_hw.draw(hDC.GetHandleOutput(), (0, 0, w, h))
    _end_doc(hDC)
    print("INFO: Impresión estética completada (bitmap vía GDI).")

def _print_text_gdi(printer_name, lines, font_name="Consolas", font_height=18, left=10, top=10, line_spacing=4):
    hPrinter = None
    try:
        hPrinter = win32print.OpenPrinter(printer_name)
        hDC = win32ui.CreateDC()
        hDC.CreatePrinterDC(printer_name)
        hDC.SetMapMode(win32con.MM_TEXT)
        lf = win32ui.CreateFont({"name": font_name, "height": -font_height, "weight": 400})
        hDC.SelectObject(lf)
        _start_doc(hDC, title="Ticket Abono")
        x, y = left, top
        for line in lines:
            hDC.TextOut(x, y, line)
            w, h = hDC.GetTextExtent(line)
            y += (h + line_spacing)
        _end_doc(hDC)
        print("INFO: Impresión GDI (texto) completada.")
    except Exception as e:
        print(f"ERROR: falló impresión GDI: {e}")
        raise
    finally:
        try:
            if hPrinter: win32print.ClosePrinter(hPrinter)
        except Exception:
            pass

# ---------------------- Build & Main ----------------------

def build_ticket_lines(proporcional: str):
    """
    Devuelve (lines).
    Formato:
      - Eleven Park S.A.
      - Aguero 265
      - Fecha: YYYY-MM-DD HH:MM:SS
      - Pago Proporcional: $<proporcional>
      - (línea en blanco)
    """
    now = _now_str()
    lines = [
        COMPANY_NAME,
        "Aguero 265",
        f"Fecha:  {now}",
        f"Pago Proporcional: ${proporcional or ''}",
        "",
    ]
    return lines

def _save_preview(canvas_img):
    out_dir = os.path.join(os.path.abspath(os.path.dirname(__file__)),
                           "tickets_preview", _today_str())
    _ensure_dir(out_dir)
    base = os.path.join(out_dir, f"Ticket_ABONO")
    png_path = base + ".png"
    pdf_path = base + ".pdf"

    canvas_img.convert("RGB").save(png_path, "PNG", optimize=True)
    canvas_img.convert("RGB").save(pdf_path, "PDF")

    print(f"INFO: PREVIEW guardado en:\n - {png_path}\n - {pdf_path}")
    try:
        os.startfile(pdf_path)  # no bloquea
    except Exception as e:
        print(f"WARNING: No se pudo abrir el PDF automáticamente: {e}")

def _parse_optional_meta():
    """
    Lee meta opcional desde argv[2] (JSON) o desde variables de entorno:
      - proporcional (o PROPORCIONAL)
      - patente      (o PATENTE)  -> opcional, se muestra como referencia
    """
    proporcional = os.environ.get("PROPORCIONAL", "").strip()
    patente      = os.environ.get("PATENTE", "").strip()

    if len(sys.argv) >= 3:
        raw = (sys.argv[2] or "").strip()
        if raw:
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    proporcional = str(obj.get("proporcional", proporcional) or "").strip()
                    patente      = str(obj.get("patente",      patente)      or "").strip()
            except Exception as e:
                print(f"WARNING: argv[2] no es JSON válido ({e}). Se ignora.")

    return proporcional, patente

def main():
    _debug_env()

    _ = str(sys.argv[1]).strip() if len(sys.argv) >= 2 else ""  # id/placeholder no usado
    printer_name = get_resolved_printer_name()

    proporcional, patente = _parse_optional_meta()

    # Build
    lines = build_ticket_lines(proporcional)

    # PREVIEW (PDF)
    if _is_preview_printer(printer_name):
        if not PIL_OK:
            print("ERROR: Para PREVIEW se requiere Pillow instalado.")
            raise SystemExit(1)
        try:
            canvas = render_ticket_canvas(lines, proporcional=proporcional, patente=patente)
            _save_preview(canvas)
            return
        except Exception as e:
            print(f"ERROR: Falló PREVIEW: {e}")
            raise SystemExit(1)

    # IMPRESIÓN REAL
    try:
        if not PIL_OK:
            raise RuntimeError("Pillow no disponible")
        canvas = render_ticket_canvas(lines, proporcional=proporcional, patente=patente)
        _print_bitmap_via_gdi(printer_name, canvas.convert("RGB"))
        return
    except Exception as e:
        print(f"WARNING: Render estético falló, uso GDI texto. Motivo: {e}")

    # Fallback total: GDI texto simple
    _print_text_gdi(printer_name, lines, font_name="Consolas", font_height=18, left=10, top=10, line_spacing=4)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: excepción no controlada en imprimir_ticket_abono.py: {e}")
        raise
