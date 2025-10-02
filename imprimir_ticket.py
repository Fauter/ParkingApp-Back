# -*- coding: utf-8 -*-
"""
Ticket: imprime encabezado fijo y un código de barras Code128 con el número recibido.
- Impresoras reales: imprime vía GDI (layout con PIL + Code128). Si falla el render, cae a GDI texto.
- Si la impresora es "Microsoft Print to PDF" (o contiene "print to pdf"):
  NO imprime: guarda PREVIEW en PNG y PDF con el mismo layout y lo abre.
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

# PIL opcional
try:
    from PIL import Image, ImageDraw, ImageFont, ImageWin, __version__ as PIL_VERSION
    PIL_OK = True
except Exception as e:
    PIL_OK = False
    PIL_VERSION = "N/A"

# Barcode
try:
    from barcode import Code128
    from barcode.writer import ImageWriter
    BARCODE_OK = True
except Exception:
    BARCODE_OK = False

COMPANY_NAME = "Eleven Park S.A."  # <<<<<< TÍTULO EN TICKET >>>>>>

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
    print(f"PIL_OK={PIL_OK} (Pillow {PIL_VERSION})  BARCODE_OK={BARCODE_OK}")
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
    # térmica típica (heurística)
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

def _make_barcode_image(number: str, target_w: int):
    if not BARCODE_OK:
        raise RuntimeError("python-barcode no disponible (pip install python-barcode)")
    temp_dir = os.environ.get("TEMP", r"C:\Temp")
    _ensure_dir(temp_dir)
    tmp_base = os.path.join(temp_dir, f"barcode_{number}")
    barcode_path = Code128(number, writer=ImageWriter()).save(
        tmp_base,
        {"write_text": False, "module_width": 0.45, "module_height": 20, "quiet_zone": 2}
    )
    img_bar = Image.open(barcode_path).convert("L")
    if img_bar.width > target_w:
        ratio = target_w / float(img_bar.width)
        h = max(1, int(img_bar.height * ratio))
        img_bar = img_bar.resize((target_w, h), Image.LANCZOS)
    return img_bar

def render_ticket_canvas(lines, barcode_number, require_barcode: bool,
                         valor_hora: str = "", patente: str = ""):
    """
    Devuelve un PIL.Image 'L' (grises) del ticket renderizado.
    - require_barcode=True: si no se puede generar Code128 -> lanza excepción.
    - require_barcode=False: si falla Code128, dibuja fallback textual del número.
    - valor_hora / patente: se imprimen debajo del barcode (si faltan, quedan en blanco).
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    # Layout 58mm a 203dpi (~384 px de ancho)
    canvas_w = 384
    margin_top   = 10
    margin_side  = 10
    margin_bottom = 3  # << solo 3px debajo del texto legal
    usable_w = canvas_w - 2 * margin_side
    gap      = 6

    font_title_size  = 29
    font_body_size   = 22   # cuerpo (Aguero, Fecha, Valor de Hora, Patente)
    font_footer_size = 18   # "¡Gracias por su visita!"
    font_title        = _load_font(font_title_size)
    font_body         = _load_font(font_body_size)
    font_footer       = _load_font(font_footer_size)
    # Legal: 40% más chico que el footer -> 0.60x
    font_legal_size   = max(8, int(round(font_footer_size * 0.60)))
    font_footer_small = _load_font(font_legal_size)

    header = lines[0] if lines else COMPANY_NAME
    body   = [t for t in (lines[1:] if len(lines) > 1 else [])]

    dummy = Image.new("L", (1, 1), 255)
    d     = ImageDraw.Draw(dummy)

    # Altura estimada del texto
    _, h_header = _text_wh(d, header, font_title)
    est_text_h  = h_header + gap
    est_text_h += 2 + gap  # separador fino bajo el título
    est_text_h += gap       # padding extra antes del primer renglón del cuerpo

    for t in body:
        _, h = _text_wh(d, t, font_body)
        est_text_h += h + gap
    est_text_h += 10  # antes del barcode

    # Código de barras
    try:
        img_bar = _make_barcode_image(barcode_number, usable_w)
        bar_h = img_bar.height
        has_barcode = True
    except Exception as be:
        if require_barcode:
            raise
        print(f"WARNING: No se pudo generar Code128 real: {be}. Se usará fallback textual.")
        img_bar = None
        bar_h = 0
        has_barcode = False

    # Footer + legal (centrados)
    footer_text = "¡Gracias por su visita!"
    legal_text  = "Aceptación Contrato (Adm.) – Jurisdicción: Tribunales CABA"
    _, h_footer = _text_wh(d, footer_text,      font_footer)
    _, h_legal  = _text_wh(d, legal_text,       font_footer_small)

    # Altura extra por Valor de Hora / Patente
    _, h_body_line = _text_wh(d, "X", font_body)
    after_bar_extra = (h_body_line + gap) * 2  # dos líneas

    # Padding-top/bottom específicos para "Gracias por su visita!"
    thanks_pad_top = 10
    thanks_pad_bottom = 10

    # Altura total (sin padding extra tras legal; solo 3px de bottom)
    canvas_h = (margin_top + est_text_h +
                (bar_h + gap if has_barcode else 22 + gap) +
                after_bar_extra +
                thanks_pad_top + h_footer + thanks_pad_bottom +
                gap + h_legal +
                margin_bottom)

    canvas   = Image.new("L", (canvas_w, canvas_h), 255)
    draw     = ImageDraw.Draw(canvas)

    y = margin_top
    # Título (centrado)
    y = _draw_center(draw, header, y, font_title, canvas_w); y += gap
    # Separador fino (debajo del título)
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 2 + gap

    # Padding extra arriba del cuerpo
    y += gap

    # Cuerpo alineado a la izquierda
    for t in body:
        y = _draw_left(draw, t, y, font_body, margin_side)
    y += 10

    # Código de barras (centrado)
    if has_barcode and img_bar is not None:
        x_bar = margin_side + (usable_w - img_bar.width)//2
        canvas.paste(img_bar, (x_bar, y))
        y += img_bar.height + gap
    else:
        y = _draw_center(draw, f"[{barcode_number}]", y, _load_font(font_body_size), canvas_w)
        y += gap

    # Debajo del barcode: Valor de Hora y Patente (izquierda)
    y = _draw_left(draw, f"Valor de Hora: {valor_hora or ''}", y, font_body, margin_side); y += gap
    y = _draw_left(draw, f"Patente: {patente or ''}",       y, font_body, margin_side); y += gap

    # Footer centrado con padding top/bottom
    y += thanks_pad_top
    y = _draw_center(draw, footer_text, y, font_footer, canvas_w)
    y += thanks_pad_bottom

    # Legal centrado, 40% más chico (0.60x)
    y += gap
    _ = _draw_center(draw, legal_text, y, font_footer_small, canvas_w)
    # No agregamos padding/margen extra después: termina a ~3px (margin_bottom) del borde.

    return canvas

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

def _print_bitmap_via_gdi(printer_name, pil_image_rgb):
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(printer_name)
    _start_doc(hDC, title="Ticket")
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
        _start_doc(hDC, title="Ticket")
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

def build_ticket_lines(ticket_str: str):
    """
    Devuelve (lines, numero_barcode). El número NO se imprime como texto:
    solo en el código de barras (salvo fallback textual/forzado).
    - Se deja el separador fino debajo del título y un padding antes del cuerpo.
    - Orden del cuerpo: 'Aguero 265' y DEBAJO 'Fecha: ...'
    """
    now = _now_str()
    lines = [
        COMPANY_NAME,
        "Aguero 265",
        f"Fecha:  {now}",
        "",
    ]
    return lines, str(ticket_str)

def _save_preview(canvas_img, number_to_encode):
    """Guarda PNG y PDF de PREVIEW con el mismo layout que la térmica."""
    out_dir = os.path.join(os.path.abspath(os.path.dirname(__file__)),
                           "tickets_preview", _today_str())
    _ensure_dir(out_dir)
    base = os.path.join(out_dir, f"Ticket_{number_to_encode}")
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
      - valorHora  (o VALOR_HORA)
      - patente    (o PATENTE)
    """
    valor_hora = os.environ.get("VALOR_HORA", "").strip()
    patente    = os.environ.get("PATENTE", "").strip()

    if len(sys.argv) >= 3:
        raw = (sys.argv[2] or "").strip()
        if raw:
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    valor_hora = str(obj.get("valorHora", valor_hora) or "").strip()
                    patente    = str(obj.get("patente", patente) or "").strip()
            except Exception as e:
                print(f"WARNING: argv[2] no es JSON válido ({e}). Se ignora.")

    return valor_hora, patente

def main():
    _debug_env()

    ticket_str = str(sys.argv[1]).strip() if len(sys.argv) >= 2 else "0000000000"
    printer_name = get_resolved_printer_name()

    # Meta opcional
    valor_hora, patente = _parse_optional_meta()

    # Generar líneas y número a codificar
    lines, number_to_encode = build_ticket_lines(ticket_str)

    # MODO PREVIEW: impresoras PDF (exijo barcode real para no confundir)
    if _is_preview_printer(printer_name):
        if not PIL_OK:
            print("ERROR: Para PREVIEW se requiere Pillow instalado.")
            raise SystemExit(1)
        if not BARCODE_OK:
            print("ERROR: Para PREVIEW se requiere 'python-barcode' para mostrar barras reales.")
            print("Sugerido: pip install python-barcode")
            raise SystemExit(1)
        try:
            canvas = render_ticket_canvas(
                lines, number_to_encode, require_barcode=True,
                valor_hora=valor_hora, patente=patente
            )
            _save_preview(canvas, number_to_encode)
            return
        except Exception as e:
            print(f"ERROR: Falló PREVIEW con barcode real: {e}")
            raise SystemExit(1)

    # MODO IMPRESIÓN REAL
    try:
        if not PIL_OK:
            raise RuntimeError("Pillow no disponible")
        canvas = render_ticket_canvas(
            lines, number_to_encode, require_barcode=False,
            valor_hora=valor_hora, patente=patente
        )
        _print_bitmap_via_gdi(printer_name, canvas.convert("RGB"))
        return
    except Exception as e:
        print(f"WARNING: Render estético falló, uso GDI texto. Motivo: {e}")

    # Fallback total: GDI texto (sin barras ni líneas post-barcode)
    _print_text_gdi(printer_name, lines, font_name="Consolas", font_height=18, left=10, top=10, line_spacing=4)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: excepción no controlada en imprimir_ticket.py: {e}")
        raise
