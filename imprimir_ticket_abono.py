# -*- coding: utf-8 -*-
"""
Ticket ABONO (sin código de barras) – versión estética FINAL:
- Sin "Ticket: NNNNNN".
- "Cochera": si el front manda "Móvil" -> imprime "Cochera: Móvil"; si no, el número (piso).
- Cuerpo en 3 secciones con respiro y separadores finos entre secciones.
- SIN línea separadora bajo el header (sólo espacio).
- Bloque "Gracias..." compacto en PDF y un poco más amplio en ticketera (para no superponer),
  pero con mayor margen superior y menor separación entre líneas.
- "Aceptación..." y "Jurisdicción..." un poco más chicas.
- Dos líneas de 'XXXXX' pegadas al borde de abajo (sin espacio en blanco grande).
- NUEVO: valores debajo de la etiqueta, con sangría breve (no a la misma altura).
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

COMPANY_NAME  = "Estacionamiento Agüero"
LOCATION_TEXT = "Agüero 265"

# ------------------------- Constantes de layout -------------------------
GAP = 6                           # gap vertical base
PAD_AFTER_FECHA = 8               # respiro extra luego de "Fecha Alta"
SECTION_GAP = 6                   # respiro antes/después de cada sección
MARGIN_BOTTOM_PDF = 0             # margen inferior PDF (querés las XXXXX al borde)
MARGIN_BOTTOM_TICKET = 2          # margen inferior mínimo para ticketera

# ------------------------- Utils -------------------------

def _normalize(s: str) -> str:
    return (s or "").strip().lower()

def _today_str():
    return datetime.now().strftime("%Y-%m-%d")

def _today_ddmmyyyy():
    return datetime.now().strftime("%d/%m/%Y")

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

def _fmt_money_str(s_or_num):
    if s_or_num is None:
        return ""
    if isinstance(s_or_num, (int, float)):
        try:
            import locale
            try:
                locale.setlocale(locale.LC_ALL, "es_AR.UTF-8")
                return locale.format_string("%d", int(round(s_or_num)), grouping=True)
            except Exception:
                s = f"{int(round(s_or_num)):,}"
                return s.replace(",", ".")
        except Exception:
            return str(int(round(s_or_num)))
    return str(s_or_num)

def _calc_dias_restantes_fallback():
    from calendar import monthrange
    hoy = datetime.now()
    last_day = monthrange(hoy.year, hoy.month)[1]
    ultimo = datetime(hoy.year, hoy.month, last_day)
    return (ultimo - hoy).days + 1

def _cap_first(s):
    s = (s or "").strip()
    return s[:1].upper() + s[1:] if s else s

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
    left = max(0, center_x - size // 2); right = left + size
    top = y; bottom = y + size
    if fill is not None:
        draw.rectangle([left, top, right, bottom], fill=fill, outline=color, width=stroke)
    else:
        draw.rectangle([left, top, right, bottom], outline=color, width=stroke)
    il = left + padding; ir = right - padding
    it = top + padding; ib = bottom - padding
    draw.line([il, it, ir, ib], fill=color, width=stroke)
    draw.line([il, ib, ir, it], fill=color, width=stroke)
    return bottom

def _split_label_value(line: str):
    """
    Recorta la primera ocurrencia de ":" para separar etiqueta/valor.
    Devuelve (label, value). Si no hay ":", label=line, value="".
    """
    line = (line or "").rstrip()
    if not line:
        return "", ""
    if ":" in line:
        label, value = line.split(":", 1)
        return (label.strip() + ":", value.strip())
    return line.strip(), ""

def render_ticket_canvas(lines, *, not_pdf: bool = False):
    """
    Render del ticket ABONO (sin barcode).
    - Etiquetas arriba y valores debajo con sangría pequeña.
    - Encabezado: [X], razón social y dirección.
    - Cuerpo: 3 secciones con separadores finos (NO hay línea bajo el header).
    - Bloques legales + dos líneas de XXXXX al final.
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    # 58mm a 203dpi ≈ 384 px
    canvas_w = 384

    # Estilos según destino
    scale = 1.5 if not_pdf else 1.0
    heavy = True if not_pdf else False
    margin_top   = 1 if not_pdf else 10
    margin_side  = 1 if not_pdf else 10
    margin_bottom = MARGIN_BOTTOM_TICKET if not_pdf else MARGIN_BOTTOM_PDF

    gap      = GAP
    usable_w = canvas_w - 2 * margin_side

    # Fuentes
    font_title_size   = int(round(29 * scale))                  # Estacionamiento Agüero
    font_loc_size     = int(round(int(round(22 * scale)) * 1.5))# Agüero 265 +50%
    font_body_size    = int(round(22 * scale))
    font_footer_size  = int(round(18 * scale))

    font_title   = _load_font(font_title_size)
    font_loc     = _load_font(font_loc_size)
    font_body    = _load_font(font_body_size)
    font_small   = _load_font(max(10, int(round(font_footer_size * 0.70))))
    # Legales finales "un poquito más chicos"
    font_legal_final = _load_font(int(round(font_footer_size * 0.9)))

    # Sangría y espaciado para el valor debajo de la etiqueta
    VALUE_INDENT = int(round(14 * scale))    # sangría izquierda del valor
    VALUE_GAP    = int(round(2 * scale))     # separación etiqueta -> valor

    header_company = COMPANY_NAME
    header_location = LOCATION_TEXT

    dummy = Image.new("L", (1, 1), 255)
    d     = ImageDraw.Draw(dummy)

    # Texto separadores XXXXX
    xw, _ = _text_wh(d, "X", font_small)
    if xw <= 0: xw = 6
    count = max(1, int(usable_w / xw))
    sep_text = "X" * count
    _, h_sep = _text_wh(d, sep_text, font_small)

    # Bloques legales superiores
    gracias_texts = [
        "Gracias por confiar en nosotros, recuerde que la",
        "mensualidad se paga del 1 al 10 de cada mes",
    ]

    # Espaciado dentro del bloque de "Gracias":
    # - MÁS margen superior (para despegar de "Patente")
    # - MENOS separación entre líneas
    THANKS_MARGIN_TOP = max(10, int(round(14 * scale)))   # ↑ más espacio antes del bloque
    THANKS_LINE_GAP   = max(2, int(round(4 * scale)))     # ↓ menos espacio entre líneas
    # NUEVO: margen inferior del bloque "Gracias" = margin_top (y mantener gap aparte)
    THANKS_MARGIN_BOTTOM = margin_top

    # ==== Cálculo del alto total ====
    # Header
    _, h_header = _text_wh(d, header_company, font_title)
    _, h_loc    = _text_wh(d, header_location, font_loc)

    # Util para calcular altura de una lista de líneas (etiqueta y valor debajo)
    def height_lines(idx_from, idx_to):
        h_sum = 0
        for i in range(idx_from, idx_to + 1):
            t = lines[i]
            label, value = _split_label_value(t)
            # etiqueta
            _, h_lbl = _text_wh(d, label or " ", font_body)
            h_sum += h_lbl
            # pequeño gap etiqueta->valor
            h_sum += VALUE_GAP
            # valor (puede ser vacío)
            _, h_val = _text_wh(d, (value or "-"), font_body)
            h_sum += h_val
            # gap entre campos
            h_sum += gap
            # extra si es "Fecha Alta:"
            if (label or "").lower().startswith("fecha alta"):
                h_sum += PAD_AFTER_FECHA
        return h_sum

    # Secciones: 0..2  | 3..6 | 7..10  (11 es vacío)
    h_sec1 = height_lines(0, 2)
    h_sec2 = height_lines(3, 6)
    h_sec3 = height_lines(7, 10)

    # Gracias (2 líneas, con menos gap entre sí)
    h_gracias_total = 0
    for t in gracias_texts:
        _, h = _text_wh(d, t, font_small)
        h_gracias_total += h + THANKS_LINE_GAP
    # quitar el último gap extra
    h_gracias_total -= THANKS_LINE_GAP
    if h_gracias_total < 0: h_gracias_total = 0

    # Legales finales
    _, h_legal1 = _text_wh(d, "Aceptación Contrato (Adm.)", font_legal_final)
    _, h_legal2 = _text_wh(d, "Jurisdicción: Tribunales CABA", font_legal_final)

    # Altura total (SIN línea bajo header)
    canvas_h = (
        margin_top +
        26 + 8 +                         # caja con X
        h_header + gap +
        h_loc + gap +                    # sólo espacio bajo header
        (SECTION_GAP + h_sec1 + SECTION_GAP + 1) +  # sec1 + línea fina
        (SECTION_GAP + h_sec2 + SECTION_GAP + 1) +  # sec2 + línea fina
        (SECTION_GAP + h_sec3) +                     # sec3 (sin línea abajo)
        THANKS_MARGIN_TOP +               # margen superior antes de Gracias
        h_gracias_total +
        THANKS_MARGIN_BOTTOM +            # NUEVO: margen inferior del bloque Gracias
        gap +                             # mantener gap antes de legales finales
        h_legal1 + max(8, gap) + h_legal2 +
        GAP +                             # respiro antes de XXXXX
        (h_sep + (GAP // 2)) * 2 +        # dos tiras XXXXX
        margin_bottom
    )

    canvas   = Image.new("L", (canvas_w, canvas_h), 255)
    draw     = ImageDraw.Draw(canvas)

    y = margin_top
    center_x = canvas_w // 2

    # Caja con X
    y = _draw_box_with_x(draw, center_x, y, 26, padding=6, stroke=2, color=0, fill=None)
    y += 8

    # Header
    y = _draw_center(draw, header_company, y, font_title, canvas_w, heavy=heavy); y += gap
    y = _draw_center(draw, header_location, y, font_loc, canvas_w, heavy=heavy); y += gap
    # (NO dibujamos línea aquí)

    # Helper para dibujar etiqueta arriba y valor debajo con sangría
    def draw_label_value(line_text, y_local):
        label, value = _split_label_value(line_text)
        # Etiqueta
        y_local = _draw_left(draw, label, y_local, font_body, margin_side, heavy=heavy)
        # Gap pequeño entre etiqueta y valor
        y_local += VALUE_GAP
        # Valor (con sangría)
        y_local = _draw_left(draw, (value or "-"), y_local, font_body, margin_side + VALUE_INDENT, heavy=heavy)
        # Respiro entre campos
        y_local += gap
        # Extra si es "Fecha Alta:"
        if (label or "").lower().startswith("fecha alta"):
            y_local += PAD_AFTER_FECHA
        return y_local

    # ========= Sección 1 =========
    y += SECTION_GAP
    for i in range(0, 3):
        y = draw_label_value(lines[i], y)
    y += SECTION_GAP
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 1

    # ========= Sección 2 =========
    y += SECTION_GAP
    for i in range(3, 7):
        y = draw_label_value(lines[i], y)
    y += SECTION_GAP
    draw.line([(margin_side, y), (canvas_w - margin_side, y)], fill=0, width=1)
    y += 1

    # ========= Sección 3 =========
    y += SECTION_GAP
    for i in range(7, 11):
        y = draw_label_value(lines[i], y)
    y += SECTION_GAP

    # ====== Gracias ======
    y += THANKS_MARGIN_TOP
    for idx, t in enumerate(gracias_texts):
        y = _draw_center(draw, t, y, font_small, canvas_w, heavy=heavy)
        if idx < len(gracias_texts) - 1:
            y += THANKS_LINE_GAP
    # NUEVO: margen inferior del bloque "Gracias" + mantener gap antes de legales
    y += THANKS_MARGIN_BOTTOM
    y += gap

    # ====== Legales finales (más chicos) ======
    y = _draw_center(draw, "Aceptación Contrato (Adm.)", y, font_legal_final, canvas_w, heavy=heavy)
    y += max(8, gap)
    y = _draw_center(draw, "Jurisdicción: Tribunales CABA", y, font_legal_final, canvas_w, heavy=heavy)

    # ====== Dos separadores 'XXXXX' pegados al borde ======
    y += GAP
    y = _draw_center(draw, sep_text, y, font_small, canvas_w, heavy=True)
    y += GAP // 2
    _ = _draw_center(draw, sep_text, y, font_small, canvas_w, heavy=True)

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

def _parse_optional_meta():
    """
    Lee meta opcional desde argv[2] (JSON) o desde variables de entorno.
    """
    def env(k, default=""):
        return os.environ.get(k, default)

    proporcional = env("PROPORCIONAL", "").strip()
    valorMensual = env("VALOR_MENSUAL", "").strip()
    patente      = env("PATENTE", "").strip()
    nombreApellido = env("NOMBRE_APELLIDO", "").strip()
    metodoPago   = env("METODO_PAGO", "").strip()
    tipoVehiculo = env("TIPO_VEHICULO", "").strip()
    marca        = env("MARCA", "").strip()
    modelo       = env("MODELO", "").strip()
    cochera      = env("COCHERA", "").strip()
    piso         = env("PISO", "").strip()
    exclusiva    = env("EXCLUSIVA", "").strip().lower() in ("true","1","si","sí")
    diasRestantes = env("DIAS", "").strip()

    baseMensual = None
    proporcionalRaw = None

    if len(sys.argv) >= 3:
        raw = (sys.argv[2] or "").strip()
        if raw:
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    proporcional = str(obj.get("proporcional", proporcional) or "").strip()
                    valorMensual = str(obj.get("valorMensual", valorMensual) or "").strip()
                    patente      = str(obj.get("patente",      patente)      or "").strip()
                    nombreApellido = str(obj.get("nombreApellido", nombreApellido) or "").strip()
                    metodoPago   = str(obj.get("metodoPago",   metodoPago)   or "").strip()
                    tipoVehiculo = str(obj.get("tipoVehiculo", tipoVehiculo) or "").strip()
                    marca        = str(obj.get("marca",        marca)        or "").strip()
                    modelo       = str(obj.get("modelo",       modelo)       or "").strip()
                    cochera      = str(obj.get("cochera",      cochera)      or "").strip()
                    piso         = str(obj.get("piso",         piso)         or "").strip()
                    exclusiva    = bool(obj.get("exclusiva", exclusiva))
                    diasRestantes = str(obj.get("diasRestantes", diasRestantes) or "").strip()
                    baseMensual = obj.get("baseMensual", None)
                    proporcionalRaw = obj.get("proporcionalRaw", None)
            except Exception as e:
                print(f"WARNING: argv[2] no es JSON válido ({e}). Se ignora.")

    if not valorMensual and baseMensual is not None:
        valorMensual = _fmt_money_str(baseMensual)
    if not proporcional and proporcionalRaw is not None:
        proporcional = _fmt_money_str(proporcionalRaw)
    if not diasRestantes:
        try:
            diasRestantes = str(int(_calc_dias_restantes_fallback()))
        except Exception:
            diasRestantes = ""

    return {
        "proporcional": proporcional,
        "valorMensual": valorMensual,
        "patente": patente,
        "nombreApellido": nombreApellido,
        "metodoPago": metodoPago,
        "tipoVehiculo": tipoVehiculo,
        "marca": marca,
        "modelo": modelo,
        "cochera": cochera,
        "piso": piso,
        "exclusiva": exclusiva,
        "diasRestantes": diasRestantes,
    }

def _cochera_asignada_str(cochera, piso):
    """
    Regla:
      - Si eligió Cochera Móvil -> "Móvil"
      - Si eligió Fija          -> mostrar el "piso" (número de cochera)
    """
    v = (cochera or "").strip().lower()
    if v in ("móvil", "movil"):
        return "Móvil"
    if v == "fija":
        return (piso or "").strip() or "-"
    return (cochera or "").strip() or "-"

def build_ticket_lines(meta):
    fecha_alta = _today_ddmmyyyy()

    nom = meta.get("nombreApellido", "")
    coch = meta.get("cochera", "")
    piso = meta.get("piso", "")
    cochera_asignada = _cochera_asignada_str(coch, piso)

    valor_mensual = _fmt_money_str(meta.get("valorMensual", ""))
    proporcional  = _fmt_money_str(meta.get("proporcional", ""))
    dias_str      = str(meta.get("diasRestantes", "")).strip()

    metodo = meta.get("metodoPago", "")
    tipo   = meta.get("tipoVehiculo", "")
    tipo_cap = _cap_first(tipo)
    marca  = meta.get("marca", "")
    modelo = meta.get("modelo", "")
    patente= meta.get("patente", "")

    lines = [
        f"Fecha Alta: {fecha_alta}",
        f"Cliente: {nom or '-'}",
        f"Cochera: {cochera_asignada}",
        f"Valor Mensual: ${valor_mensual}",
        f"Recibimos: ${proporcional}",
        f"Por días: {dias_str or '-'}",
        f"Pago: {metodo or '-'}",
        f"Vehículo: {tipo_cap or '-'}",
        f"Marca: {marca or '-'}",
        f"Modelo: {modelo or '-'}",
        f"Patente: {patente or '-'}",
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
        os.startfile(pdf_path)
    except Exception as e:
        print(f"WARNING: No se pudo abrir el PDF automáticamente: {e}")

def main():
    _debug_env()

    meta = _parse_optional_meta()
    printer_name = get_resolved_printer_name()
    lines = build_ticket_lines(meta)

    # PREVIEW (PDF)
    if _is_preview_printer(printer_name):
        if not PIL_OK:
            print("ERROR: Para PREVIEW se requiere Pillow instalado.")
            raise SystemExit(1)
        try:
            canvas = render_ticket_canvas(lines, not_pdf=False)
            _save_preview(canvas)
            return
        except Exception as e:
            print(f"ERROR: Falló PREVIEW: {e}")
            raise SystemExit(1)

    # IMPRESIÓN REAL (NO PDF)
    try:
        if not PIL_OK:
            raise RuntimeError("Pillow no disponible")
        canvas = render_ticket_canvas(lines, not_pdf=True)
        _print_bitmap_via_gdi(printer_name, canvas.convert("RGB"))
        return
    except Exception as e:
        print(f"WARNING: Render estético falló, uso GDI texto. Motivo: {e}")

    # Fallback GDI texto (sin header especial ni separadores bonitos)
    _print_text_gdi(printer_name, [COMPANY_NAME, LOCATION_TEXT, ""] + lines,
                    font_name="Consolas", font_height=18, left=10, top=10, line_spacing=4)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: excepción no controlada en imprimir_ticket_abono.py: {e}")
        raise
