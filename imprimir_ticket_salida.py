# -*- coding: utf-8 -*-
"""
Ticket SALIDA: imprime encabezado fijo y un código de barras Code128 con el número recibido.
- Si la impresora es "Microsoft Print to PDF" (o contiene "print to pdf"):
  NO imprime: guarda PREVIEW en PNG y PDF con el mismo layout y lo abre.
- Debajo del barcode: "Valor: ...", "Patente: ...", "Vehículo: ...".
- Encabezado visual (en orden):
    Ticket: NNNNNNN (centrado, un poco más chico que el título)
    Estacionamiento Agüero  (centrado)
    Agüero 265              (centrado, +50% de tamaño)
    [Línea separadora]
    Ingreso:
      DD/MM/YYYY
      HH:MM:SS
    Egreso:
      DD/MM/YYYY
      HH:MM:SS
    ... resto normal ...
- Sección legal en dos líneas apiladas y +20% de tamaño:
    "Aceptación Contrato (Adm.)"
    "Jurisdicción: Tribunales CABA"
- Doble línea de 'X' al pie (en PDF y en térmica).
- El "Valor" se muestra sin centavos.
"""

import os, sys, json, re
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

COMPANY_NAME = "Estacionamiento Agüero"
LOCATION_TEXT = "Agüero 265"  # Texto de la segunda línea del encabezado

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

def _split_fecha_hora(s: str):
    """
    Intenta separar 'DD/MM/YYYY HH:MM:SS' en (fecha, hora).
    Si no se puede, devuelve (s, "").
    """
    s = (s or "").strip()
    if not s:
        return "", ""
    if " " in s:
        fecha, hora = s.split(" ", 1)
        return fecha.strip(), hora.strip()
    if "T" in s:
        fecha, hora = s.split("T", 1)
        hora = hora.replace("Z", "").strip()
        return fecha.strip(), hora.strip()
    return s, ""

def _format_valor_sin_centavos(valor_str: str) -> str:
    """
    Toma un string con precio y devuelve el mismo valor SIN centavos.
    Conserva '$' si estaba presente y usa miles con puntos.
    """
    raw = (valor_str or "").strip()
    if not raw:
        return raw
    moneda = "$" if "$" in raw else ""
    m = re.search(r"[\d\.,]+", raw)
    if not m:
        return (moneda + " " if moneda else "") + raw
    num = m.group(0)

    def to_int(nstr: str) -> int:
        if "." in nstr and "," in nstr:
            if re.search(r",[0-9]{1,2}$", nstr):
                entero = nstr.rsplit(",", 1)[0].replace(".", "")
                return int(re.sub(r"\D", "", entero) or "0")
            if re.search(r"\.[0-9]{1,2}$", nstr):
                entero = nstr.rsplit(".", 1)[0].replace(",", "")
                return int(re.sub(r"\D", "", entero) or "0")
            return int(re.sub(r"\D", "", nstr) or "0")
        if "," in nstr and re.search(r",[0-9]{1,2}$", nstr):
            entero = nstr.rsplit(",", 1)[0]
            entero = re.sub(r"\.", "", entero)
            return int(re.sub(r"\D", "", entero) or "0")
        if "." in nstr and re.search(r"\.[0-9]{1,2}$", nstr):
            entero = nstr.rsplit(".", 1)[0]
            entero = re.sub(r",", "", entero)
            return int(re.sub(r"\D", "", entero) or "0")
        return int(re.sub(r"\D", "", nstr) or "0")

    try:
        entero = to_int(num)
    except Exception:
        return (moneda + " " if moneda else "") + raw

    entero_fmt = f"{entero:,}".replace(",", ".")
    return f"{moneda} {entero_fmt}".strip()

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
    left = max(0, center_x - half); right = left + size
    top = y; bottom = y + size
    if fill is not None:
        draw.rectangle([left, top, right, bottom], fill=fill, outline=color, width=stroke)
    else:
        draw.rectangle([left, top, right, bottom], outline=color, width=stroke)
    il = left + padding; ir = right - padding; it = top + padding; ib = bottom - padding
    draw.line([il, it, ir, ib], fill=color, width=stroke)
    draw.line([il, ib, ir, it], fill=color, width=stroke)
    return bottom

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
    from PIL import Image as PILImage
    img_bar = PILImage.open(barcode_path).convert("L")
    if img_bar.width > target_w:
        ratio = target_w / float(img_bar.width)
        h = max(1, int(img_bar.height * ratio))
        img_bar = img_bar.resize((target_w, h), PILImage.LANCZOS)
    return img_bar

def render_ticket_canvas(lines, barcode_number,
                         valor_final: str = "", patente: str = "", tipo_vehiculo: str = "",
                         not_pdf: bool = False,
                         ticket_number: str = ""):
    """
    Devuelve un PIL.Image 'L' (grises) del ticket de SALIDA.
    Misma disposición en PDF y en térmica. En térmica se usa escala mayor y “heavy”.
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    # Ancho fijo 58mm @203dpi
    canvas_w = 384

    # Estilos por destino
    scale = 1.5 if not_pdf else 1.0
    heavy = True if not_pdf else False
    margin_top   = 1 if not_pdf else 10
    margin_side  = 1 if not_pdf else 10
    margin_bottom = 3
    usable_w = canvas_w - 2 * margin_side
    gap      = 6

    # Fuentes
    font_title_size   = int(round(29 * scale))                 # Estacionamiento Agüero
    font_ticket_size  = max(10, int(round(font_title_size * 0.85)))  # Ticket: NNN
    font_body_size    = int(round(22 * scale))
    font_loc_size     = int(round(font_body_size * 1.50))      # Agüero 265 (+50%)
    font_footer_size  = int(round(18 * scale))
    font_small_size   = max(8, int(round(font_footer_size * 0.60)))
    font_legal_size   = max(8, int(round(font_small_size * 1.35)))    # +20%

    font_title   = _load_font(font_title_size)
    font_ticket  = _load_font(font_ticket_size)
    font_body    = _load_font(font_body_size)
    font_loc     = _load_font(font_loc_size)
    font_footer  = _load_font(font_footer_size)
    font_small   = _load_font(font_small_size)
    font_legal   = _load_font(font_legal_size)

    # Interpreto lines
    header = COMPANY_NAME
    body   = [t for t in (lines[1:] if len(lines) > 1 else [])]
    if body:
        body[0] = LOCATION_TEXT
    else:
        body = [LOCATION_TEXT]

    # Evitar duplicar "Ingreso" y "Egreso" (se dibujan con formato lindo más abajo)
    other_body = [t for t in body[1:] if t and not _normalize(t).startswith(("ingreso:", "egreso:"))]

    # Para calcular separadores 'X'
    dummy = Image.new("L", (1, 1), 255)
    d     = ImageDraw.Draw(dummy)
    xw, _ = _text_wh(d, "X", font_small)
    if xw <= 0: xw = 6
    count_x = max(1, int(usable_w / xw))
    sep_text = "X" * count_x

    # --- RENDER EN CANVAS ALTO Y LUEGO CROP (evita cortes) ---
    SAFE_H = 4000  # altura muy amplia para no quedarnos cortos
    canvas = Image.new("L", (canvas_w, SAFE_H), 255)
    draw   = ImageDraw.Draw(canvas)

    y = margin_top

    # [X] caja con cruz
    center_x = canvas_w // 2
    cross_size = 26; cross_pad = 6; cross_gap = 8
    y = _draw_box_with_x(draw, center_x, y, cross_size, padding=cross_pad, stroke=2, color=0, fill=None)
    y += cross_gap

    # "Ticket: NNNNN"
    y = _draw_center(draw, f"Ticket: {ticket_number}", y, font_ticket, canvas_w, heavy=heavy); y += gap

    # "Estacionamiento Agüero"
    y = _draw_center(draw, header, y, font_title, canvas_w, heavy=heavy); y += gap

    # "Agüero 265"
    y = _draw_center(draw, LOCATION_TEXT, y, font_loc, canvas_w, heavy=heavy); y += gap

    # Línea separadora
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 2 + gap
    y += gap

    # ---- Ingreso / Egreso (apilados) ----
    ingreso_str = ""
    egreso_str  = ""
    for t in lines:
        if t.startswith("Ingreso:"):
            ingreso_str = t.replace("Ingreso:", "").strip()
        if t.startswith("Egreso:"):
            egreso_str = t.replace("Egreso:", "").strip()
    fi, hi = _split_fecha_hora(ingreso_str)
    fe, he = _split_fecha_hora(egreso_str)

    y = _draw_left(draw, "Ingreso:", y, font_body, margin_side, heavy=heavy)
    if fi: y = _draw_left(draw, f"  {fi}", y, font_body, margin_side, heavy=heavy)
    if hi: y = _draw_left(draw, f"  {hi}", y, font_body, margin_side, heavy=heavy)
    y += 4
    y = _draw_left(draw, "Egreso:", y, font_body, margin_side, heavy=heavy)
    if fe: y = _draw_left(draw, f"  {fe}", y, font_body, margin_side, heavy=heavy)
    if he: y = _draw_left(draw, f"  {he}", y, font_body, margin_side, heavy=heavy)
    y += 10

    # (otras líneas del cuerpo, si existieran)
    for t in other_body:
        y = _draw_left(draw, t, y, font_body, margin_side, heavy=heavy)
    y += 6

    # Barcode
    img_bar = None
    try:
        img_bar = _make_barcode_image(barcode_number, usable_w)
    except Exception as be:
        print(f"WARNING: No se pudo generar Code128 real: {be}. Se omitirá el barcode.")
    if img_bar is not None:
        x_bar = margin_side + (usable_w - img_bar.width)//2
        canvas.paste(img_bar, (x_bar, y))
        y += img_bar.height + gap
    else:
        y += gap

    # Debajo del barcode
    valor_fmt = _format_valor_sin_centavos(valor_final or "")
    y = _draw_left(draw, f"Valor: {valor_fmt}",             y, font_body, margin_side, heavy=heavy); y += gap
    y = _draw_left(draw, f"Patente: {patente or ''}",       y, font_body, margin_side, heavy=heavy); y += gap
    y = _draw_left(draw, f"Vehículo: {(tipo_vehiculo or '').title()}", y, font_body, margin_side, heavy=heavy); y += gap

    # Footer
    footer_text = "¡Gracias por su visita!"
    y += 8
    y = _draw_center(draw, footer_text, y, font_footer, canvas_w, heavy=heavy)
    y += 8

    # Legales apilados (+20%)
    y += gap
    y = _draw_center(draw, "Aceptación Contrato (Adm.)", y, font_legal, canvas_w, heavy=heavy)
    y += 2
    y = _draw_center(draw, "Jurisdicción: Tribunales CABA", y, font_legal, canvas_w, heavy=heavy)

    # Doble línea de 'X' (PDF y térmica)
    for _ in range(2):
        y += gap
        y = _draw_center(draw, sep_text, y, font_small, canvas_w, heavy=True)

    # --- Recorte exacto del alto usado ---
    final_h = min(SAFE_H, y + margin_bottom)
    return canvas.crop((0, 0, canvas_w, final_h))

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
        COMPANY_NAME,        # header (no se usa directo, pero se mantiene por compat)
        LOCATION_TEXT,
        f"Ingreso: {ingreso_str}",   # re-formateado en el render
        f"Egreso:  {egreso_str}",
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
      - ingreso       (o INGRESO)
      - egreso        (o EGRESO)
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
                    patente       = str(obj.get("patente",      patente)      or "").strip()
                    tipo_vehiculo = str(obj.get("tipoVehiculo", tipo_vehiculo) or "").strip()
                    ingreso       = str(obj.get("ingreso",      ingreso)      or "").strip()
                    egreso        = str(obj.get("egreso",       egreso)       or "").strip()
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
                valor_final=valor_final, patente=patente, tipo_vehiculo=tipo_vehiculo,
                not_pdf=False,
                ticket_number=number_to_encode
            )
            _save_preview(canvas, number_to_encode)
            return
        except Exception as e:
            print(f"ERROR: Falló PREVIEW: {e}")
            raise SystemExit(1)

    # IMPRESIÓN REAL (NO PDF)
    try:
        if not PIL_OK:
            raise RuntimeError("Pillow no disponible")
        canvas = render_ticket_canvas(
            lines, number_to_encode,
            valor_final=valor_final, patente=patente, tipo_vehiculo=tipo_vehiculo,
            not_pdf=True,
            ticket_number=number_to_encode
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
