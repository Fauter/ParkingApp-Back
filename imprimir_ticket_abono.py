# -*- coding: utf-8 -*-
"""
Ticket ABONO: SIN código de barras. Muestra Pago Proporcional y pie especial.
- Si la impresora es "Microsoft Print to PDF" (o contiene "print to pdf"):
  NO imprime: guarda PREVIEW en PNG y PDF con el mismo layout y lo abre.

Entrada:
  argv[1]: puede ser un identificador de operación (no se imprime).
  argv[2] (JSON opcional) o variables de entorno:
    - proporcional  (o PROPORCIONAL)  -> string (formateado) para "Pago en este acto: $..."
    - valorMensual  (o VALOR_MENSUAL) -> string (formateado) para "Valor Mensual: $..."
    - baseMensual                      -> número de respaldo
    - proporcionalRaw                  -> número de respaldo
    - diasRestantes (o DIAS)           -> entero con los días usados para el prorrateo
    - nombreApellido                   -> "A nombre de: ..."
    - metodoPago                       -> "Método de Pago: ..."
    - tipoVehiculo                     -> "Tipo de Vehículo: ..."
    - marca                            -> "Marca: ..."
    - modelo                           -> "Modelo: ..."
    - patente   (o PATENTE)            -> "Patente: ..."
    - cochera                          -> "Fija" | "Móvil"
    - piso                             -> si es Fija, se mostrará acá
    - exclusiva                        -> bool (no se pide mostrar, pero puede afectar valor mensual en el front)
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

COMPANY_NAME  = "Eleven Park S.A."
LOCATION_TEXT = "Aguero 256"  # Debajo de la razón social en el encabezado

# ------------------------- Constantes de layout -------------------------
GAP = 6                         # gap vertical base
PAD_AFTER_FECHA = 10            # padding extra debajo de "Fecha de Alta"
PAD_AFTER_PATENTE = 20          # padding extra debajo de "Patente" (si la usamos con bloque aparte)
LEGAL_GAP = 10                  # separación entre líneas legales
BOTTOM_LEGAL_TOP_GAP = 8        # separación ANTES de la última línea
MARGIN_BOTTOM_PIXELS = 3        # margen real inferior deseado (3 px)

# ------------------------- Utils -------------------------

def _normalize(s: str) -> str:
    return (s or "").strip().lower()

def _today_str():
    return datetime.now().strftime("%Y-%m-%d")

def _today_ddmmyyyy():
    # Formato requerido: 03/10/2025
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
    """
    Recibe un string ya formateado (ej: '123.456') o un número.
    Devuelve string sin símbolo, listo para anteponer '$'.
    """
    if s_or_num is None:
        return ""
    if isinstance(s_or_num, (int, float)):
        try:
            # Formato es-AR sin decimales
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
    hoy = datetime.now()
    if hoy.month == 12:
        ultimo = datetime(hoy.year, 12, 31)
    else:
        from calendar import monthrange
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
    half = size // 2
    left = max(0, center_x - half); right = left + size
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

def render_ticket_canvas(lines):
    """
    Devuelve un PIL.Image 'L' (grises) del ticket de ABONO (sin barcode).
    Encabezado: [X] centrado, COMPANY_NAME centrado, LOCATION_TEXT centrado, línea separadora.
    Alineación: desde "A nombre de:" hasta "Patente:" en dos columnas (etiqueta/valor).
    """
    if not PIL_OK:
        raise RuntimeError("Pillow (PIL) no disponible")

    # Layout 58mm a 203dpi (~384 px de ancho)
    canvas_w = 384
    margin_top   = 10
    margin_side  = 10
    margin_bottom = MARGIN_BOTTOM_PIXELS

    gap      = GAP

    font_title_size  = 29
    font_body_size   = 22
    font_footer_size = 18
    font_title   = _load_font(font_title_size)
    font_body    = _load_font(font_body_size)
    font_small   = _load_font(max(10, int(round(font_footer_size * 0.70))))
    font_bottom  = _load_font(max(8,  int(round(font_footer_size * 0.55))))

    header = lines[0] if lines else COMPANY_NAME
    body   = [t for t in (lines[1:] if len(lines) > 1 else [])]
    if body:
        body[0] = LOCATION_TEXT
    else:
        body = [LOCATION_TEXT]

    dummy = Image.new("L", (1, 1), 255)
    d     = ImageDraw.Draw(dummy)

    _, h_header = _text_wh(d, header, font_title)
    _, h_loc    = _text_wh(d, LOCATION_TEXT, font_body)

    legal_texts  = [
        "Gracias por confiar en nosotros, recuerde que la",
        "mensualidad se paga del 1 al 10 de cada mes",
    ]
    bottom_legal = "Aceptación Contrato (Adm.) – Jurisdicción: Tribunales CABA"

    # --- Preparar cuerpo: detectar la primera (Fecha de Alta) y el bloque alineado ---
    other_body = body[1:] if len(body) > 1 else []
    fecha_line = None
    aligned_pairs = []  # (label_with_colon, value)
    for t in other_body:
        if fecha_line is None and t.startswith("Fecha de Alta:"):
            fecha_line = t
            continue
        # split etiqueta:valor (solo primera aparición de ':')
        if ":" in t:
            label, value = t.split(":", 1)
            label = (label or "").strip() + ":"
            value = (value or "").lstrip()
            aligned_pairs.append((label, value))
        else:
            # fallback raro: tratarlo como texto plano
            aligned_pairs.append((t, ""))

    # Calcular alto estimado para canvas (como antes)
    est_text_h = 0
    if fecha_line:
        _, hf = _text_wh(d, fecha_line, font_body)
        est_text_h += hf + gap + PAD_AFTER_FECHA
    # Para el bloque alineado: cada par ocupa una línea con font_body
    for _ in aligned_pairs:
        _, h = _text_wh(d, "X", font_body)
        est_text_h += h + gap

    # Legales
    h_legal_total = 0
    for t in legal_texts:
        _, h = _text_wh(d, t, font_small)
        h_legal_total += LEGAL_GAP + h
    _, h_bottom = _text_wh(d, bottom_legal, font_bottom)

    # Alto total con la última línea anclada al fondo
    canvas_h = (margin_top +
                26 + 8 +           # caja con cruz
                h_header + gap +
                h_loc + gap +
                (2 + gap) +
                gap +
                est_text_h +
                h_legal_total +
                BOTTOM_LEGAL_TOP_GAP +
                h_bottom +
                margin_bottom)

    canvas   = Image.new("L", (canvas_w, canvas_h), 255)
    draw     = ImageDraw.Draw(canvas)

    y = margin_top
    center_x = canvas_w // 2
    y = _draw_box_with_x(draw, center_x, y, 26, padding=6, stroke=2, color=0, fill=None)
    y += 8

    y = _draw_center(draw, header, y, font_title, canvas_w); y += gap
    y = _draw_center(draw, LOCATION_TEXT, y, font_body, canvas_w); y += gap

    line_y_start = y
    draw.line([(margin_side, line_y_start), (canvas_w - margin_side, line_y_start)], fill=0, width=1)
    y += 2 + gap
    y += gap

    # 1) Fecha (sin alinear)
    if fecha_line:
        y = _draw_left(draw, fecha_line, y, font_body, margin_side)
        y += PAD_AFTER_FECHA

    # 2) Bloque alineado etiqueta/valor
    if aligned_pairs:
        # ancho máximo de etiqueta (incluyendo ":")
        max_label_w = 0
        for label, _ in aligned_pairs:
            w, _ = _text_wh(draw, label, font_body)
            if w > max_label_w:
                max_label_w = w
        value_x = margin_side + max_label_w + 12  # 12px de separación visual

        for label, value in aligned_pairs:
            # etiqueta
            draw.text((margin_side, y), label, fill=0, font=font_body)
            # valor
            draw.text((value_x, y), value, fill=0, font=font_body)
            _, hline = _text_wh(draw, label, font_body)
            y += hline + gap

    # Legales (dos renglones pequeños centrados)
    for t in legal_texts:
        y += LEGAL_GAP
        _ = _draw_center(draw, t, y, font_small, canvas_w)

    # Posición FINAL de la última línea (anclada al fondo con margin_bottom exacto)
    y_bottom_legal = canvas_h - margin_bottom - h_bottom
    _ = _draw_center(draw, bottom_legal, y_bottom_legal, font_bottom, canvas_w)

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
        "diasRestantes": diasRestantes
    }

def _cochera_asignada_str(cochera, piso):
    """
    Regla pedida:
      - Si eligió Cochera Móvil -> "Móvil"
      - Si eligió Fija           -> mostrar el "piso" (número de cochera)
    """
    v = (cochera or "").strip().lower()
    if v == "móvil" or v == "movil":
        return "Móvil"
    if v == "fija":
        return (piso or "").strip() or "-"
    return (cochera or "").strip() or "-"

def build_ticket_lines(meta):
    """
    Orden EXACTO del cuerpo (después del header y la barra):
      Fecha Alta:
      A nombre de:
      Cochera Asignada:
      Valor Mensual:
      Pago en este acto:
      Por días:
      Método de Pago:
      Tipo de Vehículo:
      Marca:
      Modelo:
      Patente:
    """
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
        COMPANY_NAME,
        LOCATION_TEXT,
        f"Fecha de Alta: {fecha_alta}",
        f"A nombre de: {nom or '-'}",
        f"Cochera Asignada: {cochera_asignada}",
        f"Valor Mensual: ${valor_mensual}",
        f"Pago en este acto: ${proporcional}",
        f"Por días: {dias_str or '-'}",
        f"Método de Pago: {metodo or '-'}",
        f"Tipo de Vehículo: {tipo_cap or '-'}",
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

    _ = str(sys.argv[1]).strip() if len(sys.argv) >= 2 else ""  # id/placeholder no usado
    printer_name = get_resolved_printer_name()

    meta = _parse_optional_meta()
    lines = build_ticket_lines(meta)

    # PREVIEW (PDF)
    if _is_preview_printer(printer_name):
        if not PIL_OK:
            print("ERROR: Para PREVIEW se requiere Pillow instalado.")
            raise SystemExit(1)
        try:
            canvas = render_ticket_canvas(lines)
            _save_preview(canvas)
            return
        except Exception as e:
            print(f"ERROR: Falló PREVIEW: {e}")
            raise SystemExit(1)

    # IMPRESIÓN REAL
    try:
        if not PIL_OK:
            raise RuntimeError("Pillow no disponible")
        canvas = render_ticket_canvas(lines)
        _print_bitmap_via_gdi(printer_name, canvas.convert("RGB"))
        return
    except Exception as e:
        print(f"WARNING: Render estético falló, uso GDI texto. Motivo: {e}")

    _print_text_gdi(printer_name, lines, font_name="Consolas", font_height=18, left=10, top=10, line_spacing=4)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: excepción no controlada en imprimir_ticket_abono.py: {e}")
        raise
