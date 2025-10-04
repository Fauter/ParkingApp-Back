# -*- coding: utf-8 -*-
"""
Ticket SALIDA: imprime encabezado fijo y un código de barras Code128 con el número recibido.
- Si la impresora es "Microsoft Print to PDF" (o contiene "print to pdf"):
  NO imprime: guarda PREVIEW en PNG y PDF con el mismo layout y lo abre.
- Debajo del barcode: "Valor Final: ...", "Patente: ...", "Tipo de Vehículo: ...".
- Encabezado visual (en orden):
    [X]  (caja con cruz - "no es factura", con padding interno)
    Eleven Park S.A   (centrado)
    Aguero 256        (centrado, tamaño igual al anterior)
    [Línea separadora]
    Ingreso: ...
    Egreso: ...
    ... resto normal ...
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

# Barcode
try:
    from barcode import Code128
    from barcode.writer import ImageWriter
    BARCODE_OK = True
except Exception:
    BARCODE_OK = False

COMPANY_NAME = "Eleven Park S.A."
LOCATION_TEXT = "Aguero 256"  # Texto de la segunda línea del encabezado

# ------------------------- Utils -------------------------
def _normalize(s: str) -> str:
    return (s or "").strip().lower()

def _today_str():
    return datetime.now().strftime("%Y-%m-%d")

def _now_str_ar():
    # DD/MM/YYYY HH:MM:SS
    return datetime.now().strftime("%d/%m/%Y %H:%M:%S")

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

def _draw_box_with_x(draw, center_x, y, size, padding=6, stroke=2, color=0, fill=None):
    """
    Dibuja una caja cuadrada con una 'X' con padding interno.
    - size: lado total del cuadrado.
    - padding: margen interior entre el borde del cuadrado y la 'X'.
    """
    half = size // 2
    left = max(0, center_x - half)
    right = left + size
    top = y
    bottom = y + size

    # Contorno del cuadrado
    if fill is not None:
        draw.rectangle([left, top, right, bottom], fill=fill, outline=color, width=stroke)
    else:
        draw.rectangle([left, top, right, bottom], outline=color, width=stroke)

    # Coordenadas internas para la 'X' respetando padding
    il = left + padding
    ir = right - padding
    it = top + padding
    ib = bottom - padding

    # Diagonales con padding
    draw.line([il, it, ir, ib], fill=color, width=stroke)
    draw.line([il, ib, ir, it], fill=color, width=stroke)

    return bottom  # y siguiente

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
    from PIL import Image as PILImage  # evitar sombra de nombre
    img_bar = PILImage.open(barcode_path).convert("L")
    if img_bar.width > target_w:
        ratio = target_w / float(img_bar.width)
        h = max(1, int(img_bar.height * ratio))
        img_bar = img_bar.resize((target_w, h), PILImage.LANCZOS)
    return img_bar

def render_ticket_canvas(lines, barcode_number, valor_final: str = "", patente: str = "", tipo_vehiculo: str = ""):
    """
    Devuelve un PIL.Image 'L' (grises) del ticket de SALIDA.
    Encabezado: [X], COMPANY_NAME, LOCATION_TEXT, línea separadora.
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    # Layout 58mm a 203dpi (~384 px de ancho)
    canvas_w = 384
    margin_top   = 10
    margin_side  = 10
    margin_bottom = 3  # evitar cortes
    usable_w = canvas_w - 2 * margin_side
    gap      = 6

    font_title_size  = 29
    font_body_size   = 22
    font_footer_size = 18
    font_title        = _load_font(font_title_size)
    font_body         = _load_font(font_body_size)
    font_footer       = _load_font(font_footer_size)
    font_small_size   = max(8, int(round(font_footer_size * 0.60)))
    font_small        = _load_font(font_small_size)

    # Interpreto lines
    header = (lines[0] if lines else COMPANY_NAME) or COMPANY_NAME
    body   = [t for t in (lines[1:] if len(lines) > 1 else [])]
    if body:
        body[0] = LOCATION_TEXT
    else:
        body = [LOCATION_TEXT]

    dummy = Image.new("L", (1, 1), 255)
    d     = ImageDraw.Draw(dummy)

    # Alturas estimadas de header
    _, h_header = _text_wh(d, header, font_title)
    _, h_loc    = _text_wh(d, LOCATION_TEXT, font_body)

    # Footer y legal
    footer_texts = [
        "¡Gracias por su visita!",
    ]
    legal_texts  = ["Aceptación Contrato (Adm.) – Jurisdicción: Tribunales CABA"]

    # Footer compactado
    footer_top_margin = 8
    footer_between    = 2
    footer_bottom_margin = 8

    footer_heights = []
    for t in footer_texts:
        _, h = _text_wh(d, t, font_footer)
        footer_heights.append(h)
    h_footer_total = (footer_top_margin +
                      sum(footer_heights) +
                      footer_between * max(0, (len(footer_heights) - 1)) +
                      footer_bottom_margin) if footer_heights else 0

    # Legal
    h_legal_total = 0
    for t in legal_texts:
        _, h = _text_wh(d, t, font_small)
        h_legal_total += gap + h

    # Barcode
    img_bar = None
    try:
        img_bar = _make_barcode_image(barcode_number, usable_w)
        bar_h = img_bar.height
    except Exception as be:
        print(f"WARNING: No se pudo generar Code128 real: {be}. Se omitirá el barcode.")
        bar_h = 0
        img_bar = None

    # Cuerpo (sin LOCATION_TEXT, que va arriba)
    other_body = body[1:] if len(body) > 1 else []
    est_text_h = 0
    for t in other_body:
        _, h = _text_wh(d, t, font_body)
        est_text_h += h + gap
    est_text_h += 10  # antes del área del barcode

    # Altura extra por líneas debajo del barcode
    _, h_body_line = _text_wh(d, "X", font_body)
    # 3 líneas: Valor Final + Patente + Tipo de Vehículo
    after_bar_extra = (h_body_line + gap) * 3

    # Caja con cruz
    cross_size = 26
    cross_pad  = 6
    cross_gap  = 8

    canvas_h = (margin_top +
                cross_size + cross_gap +
                h_header + gap +
                h_loc + gap +
                (2 + gap) +
                gap +
                est_text_h +
                ((bar_h + gap) if img_bar is not None else (gap)) +
                after_bar_extra +
                h_footer_total +
                h_legal_total +
                margin_bottom)

    canvas   = Image.new("L", (canvas_w, canvas_h), 255)
    draw     = ImageDraw.Draw(canvas)

    y = margin_top

    # [X] caja con cruz
    center_x = canvas_w // 2
    y = _draw_box_with_x(draw, center_x, y, cross_size, padding=cross_pad, stroke=2, color=0, fill=None)
    y += cross_gap

    # "Eleven Park S.A." (centrado)
    y = _draw_center(draw, header, y, font_title, canvas_w); y += gap

    # "Aguero 256" (centrado)
    y = _draw_center(draw, LOCATION_TEXT, y, font_body, canvas_w); y += gap

    # Línea separadora
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 2 + gap

    # Padding extra
    y += gap

    # Resto del cuerpo
    for t in other_body:
        y = _draw_left(draw, t, y, font_body, margin_side)
    y += 10

    # Barcode
    if img_bar is not None:
        x_bar = margin_side + (usable_w - img_bar.width)//2
        canvas.paste(img_bar, (x_bar, y))
        y += img_bar.height + gap
    else:
        y += gap

    # Debajo del barcode (3 líneas)
    y = _draw_left(draw, f"Valor Final: {valor_final or ''}",                 y, font_body, margin_side); y += gap
    y = _draw_left(draw, f"Patente: {patente or ''}",                        y, font_body, margin_side); y += gap
    y = _draw_left(draw, f"Tipo de Vehículo: {(tipo_vehiculo or '').title()}", y, font_body, margin_side); y += gap

    # ===== Footer =====
    if footer_texts:
        y += footer_top_margin
        y = _draw_center(draw, footer_texts[0], y, font_footer, canvas_w)
        y += footer_bottom_margin

    # Legal
    for t in legal_texts:
        y += gap
        y = _draw_center(draw, t, y, font_small, canvas_w)

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
    _start_doc(hDC, title="Ticket SALIDA")
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
        _start_doc(hDC, title="Ticket SALIDA")
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
def build_ticket_lines(ticket_str: str, ingreso: str = "", egreso: str = ""):
    """
    Devuelve (lines, numero_barcode).
    - ingreso/egreso deben venir en formato DD/MM/YYYY HH:MM:SS si se pasan.
      Si egreso no viene, se usa ahora. Ingreso puede quedar vacío.
    """
    ingreso_str = (ingreso or "").strip()
    egreso_str  = (egreso or "").strip() or _now_str_ar()

    lines = [
        COMPANY_NAME,        # header (centrado)
        LOCATION_TEXT,       # se fuerza en el render y se centra
        f"Ingreso:  {ingreso_str}",   # puede ir vacío
        f"Egreso:   {egreso_str}",
        "",
    ]
    number = str(ticket_str or "000000")
    return lines, number

def _save_preview(canvas_img, number_to_encode):
    out_dir = os.path.join(os.path.abspath(os.path.dirname(__file__)),
                           "tickets_preview", _today_str())
    _ensure_dir(out_dir)
    base = os.path.join(out_dir, f"TicketSalida_{number_to_encode or 'PREVIEW'}")
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
      - valorFinal    (o VALOR_FINAL)
      - patente       (o PATENTE)
      - tipoVehiculo  (o TIPO_VEHICULO)
      - ingreso       (o INGRESO)  -> DD/MM/YYYY HH:MM:SS (opcional)
      - egreso        (o EGRESO)   -> DD/MM/YYYY HH:MM:SS (opcional; default: ahora)
    """
    valor_final   = os.environ.get("VALOR_FINAL", "").strip()
    patente       = os.environ.get("PATENTE", "").strip()
    tipo_vehiculo = os.environ.get("TIPO_VEHICULO", "").strip()
    ingreso       = os.environ.get("INGRESO", "").strip()
    egreso        = os.environ.get("EGRESO", "").strip()

    if len(sys.argv) >= 3:
        raw = (sys.argv[2] or "").strip()
        if raw:
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    valor_final   = str(obj.get("valorFinal",   valor_final)   or "").strip()
                    patente       = str(obj.get("patente",     patente)       or "").strip()
                    tipo_vehiculo = str(obj.get("tipoVehiculo", tipo_vehiculo) or "").strip()
                    ingreso       = str(obj.get("ingreso",      ingreso)       or "").strip()
                    egreso        = str(obj.get("egreso",       egreso)        or "").strip()
            except Exception as e:
                print(f"WARNING: argv[2] no es JSON válido ({e}). Se ignora.")

    return valor_final, patente, tipo_vehiculo, ingreso, egreso

def main():
    _debug_env()

    ticket_str = str(sys.argv[1]).strip() if len(sys.argv) >= 2 else "0000000000"
    printer_name = get_resolved_printer_name()

    # Meta
    valor_final, patente, tipo_vehiculo, ingreso, egreso = _parse_optional_meta()

    # Build
    lines, number_to_encode = build_ticket_lines(ticket_str, ingreso=ingreso, egreso=egreso)

    # PREVIEW (PDF)
    if _is_preview_printer(printer_name):
        if not PIL_OK:
            print("ERROR: Para PREVIEW se requiere Pillow instalado.")
            raise SystemExit(1)
        if not BARCODE_OK:
            print("ERROR: Para PREVIEW con código de barras se requiere 'python-barcode'.")
            print("Sugerido: pip install python-barcode")
            raise SystemExit(1)
        try:
            canvas = render_ticket_canvas(
                lines, number_to_encode,
                valor_final=valor_final, patente=patente, tipo_vehiculo=tipo_vehiculo
            )
            _save_preview(canvas, number_to_encode)
            return
        except Exception as e:
            print(f"ERROR: Falló PREVIEW: {e}")
            raise SystemExit(1)

    # IMPRESIÓN REAL
    try:
        if not PIL_OK:
            raise RuntimeError("Pillow no disponible")
        canvas = render_ticket_canvas(
            lines, number_to_encode,
            valor_final=valor_final, patente=patente, tipo_vehiculo=tipo_vehiculo
        )
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
        print(f"ERROR: excepción no controlada en imprimir_ticket_salida.py: {e}")
        raise
