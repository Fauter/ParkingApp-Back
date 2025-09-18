# -*- coding: utf-8 -*-
"""
Ticket: imprime encabezado fijo y un código de barras Code128 con el número recibido.
Fallback seguro a GDI texto si PIL no está o falla.
"""

import os, sys, json
from datetime import datetime

# Salida UTF-8
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

# PyWin32
try:
    import win32print, win32ui, win32con
except Exception as e:
    print(f"ERROR: PyWin32 no disponible: {e}")
    raise SystemExit(1)

# PIL opcional
try:
    from PIL import Image, ImageDraw, ImageFont, ImageWin
    PIL_OK = True
except Exception:
    PIL_OK = False

# Barcode
try:
    from barcode import Code128
    from barcode.writer import ImageWriter
    BARCODE_OK = True
except Exception:
    BARCODE_OK = False

COMPANY_NAME = "Eleven Park S.A."  # <<<<<<<<<<<<<<<< TÍTULO

def _normalize(s: str) -> str:
    return (s or "").strip().lower()

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
    # Aceptar "nombre" o "impresora"
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

def _start_doc(dc, title="Ticket"):
    # StartDoc espera STRING
    dc.StartDoc(str(title))
    dc.StartPage()

def _end_doc(dc):
    try:
        dc.EndPage()
    finally:
        try: dc.EndDoc()
        except Exception: pass

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
        print("INFO: Impresión GDI completada.")
    except Exception as e:
        print(f"ERROR: falló impresión GDI: {e}")
        raise
    finally:
        try:
            if hPrinter: win32print.ClosePrinter(hPrinter)
        except Exception:
            pass

def _load_font(size):
    # Intenta Consolas / DejaVu; cae a la default
    try:
        return ImageFont.truetype("consola.ttf", size)
    except Exception:
        try:
            return ImageFont.truetype("DejaVuSans.ttf", size)
        except Exception:
            return ImageFont.load_default()

def _draw_center(draw, text, y, font, canvas_w, fill=0):
    w, h = draw.textsize(text, font=font)
    x = max(0, (canvas_w - w)//2)
    draw.text((x, y), text, fill=fill, font=font)
    return y + h

def _load_font(size):
    # Intenta Consolas / DejaVu; cae a la default
    try:
        return ImageFont.truetype("consola.ttf", size)
    except Exception:
        try:
            return ImageFont.truetype("DejaVuSans.ttf", size)
        except Exception:
            return ImageFont.load_default()

def _text_wh(draw, text, font):
    # Usa textbbox (Pillow 10+)
    bbox = draw.textbbox((0,0), text, font=font)
    return bbox[2]-bbox[0], bbox[3]-bbox[1]

def _draw_center(draw, text, y, font, canvas_w, fill=0):
    w, h = _text_wh(draw, text, font)
    x = max(0, (canvas_w - w)//2)
    draw.text((x, y), text, fill=fill, font=font)
    return y + h

def _load_font(size):
    try:
        return ImageFont.truetype("consola.ttf", size)
    except Exception:
        try:
            return ImageFont.truetype("DejaVuSans.ttf", size)
        except Exception:
            return ImageFont.load_default()

def _text_wh(draw, text, font):
    bbox = draw.textbbox((0,0), text, font=font)
    return bbox[2]-bbox[0], bbox[3]-bbox[1]

def _draw_center(draw, text, y, font, canvas_w, fill=0):
    w, h = _text_wh(draw, text, font)
    x = max(0, (canvas_w - w)//2)
    draw.text((x, y), text, fill=fill, font=font)
    return y + h

def _render_and_print_canvas(printer_name, lines, barcode_number):
    if not (PIL_OK and BARCODE_OK):
        raise RuntimeError("PIL o python-barcode no disponibles")

    # Generar barcode PNG (sin texto del writer)
    temp_dir = os.environ.get("TEMP", r"C:\Temp")
    try: os.makedirs(temp_dir, exist_ok=True)
    except Exception: pass
    tmp_base = os.path.join(temp_dir, f"barcode_{barcode_number}")
    barcode_path = Code128(barcode_number, writer=ImageWriter()).save(
        tmp_base,
        {"write_text": False, "module_width": 0.45, "module_height": 20, "quiet_zone": 2}
    )
    img_bar = Image.open(barcode_path).convert("L")

    # Layout
    canvas_w = 384
    margin   = 10
    usable_w = canvas_w - 2*margin
    gap      = 6

    # Tipos: +20% en título y cuerpo (fecha/dirección)
    font_title  = _load_font(29)  # 24 -> 29
    font_body   = _load_font(22)  # 18 -> 22
    font_footer = _load_font(18)  # footer bajo el código

    header = lines[0] if lines else COMPANY_NAME
    body   = lines[1:] if len(lines) > 1 else []

    dummy = Image.new("L", (1,1), 255)
    d     = ImageDraw.Draw(dummy)

    # Altura estimada de texto
    _, h_header = _text_wh(d, header, font_title)
    est_text_h  = h_header + gap        # header
    est_text_h += 2 + gap               # separador
    for t in body:
        _, h = _text_wh(d, t, font_body)
        est_text_h += h + gap
    est_text_h += 10                    # antes del barcode

    # Ajuste de ancho del barcode
    if img_bar.width > usable_w:
        ratio = usable_w / float(img_bar.width)
        img_bar = img_bar.resize((usable_w, max(1, int(img_bar.height * ratio))), Image.LANCZOS)

    # Footer: “Gracias por su visita!”
    footer_text = "¡Gracias por su visita!"
    _, h_footer = _text_wh(d, footer_text, font_footer)

    canvas_h = margin + est_text_h + img_bar.height + gap + h_footer + margin
    canvas   = Image.new("L", (canvas_w, canvas_h), 255)
    draw     = ImageDraw.Draw(canvas)

    y = margin
    # Título
    y = _draw_center(draw, header, y, font_title, canvas_w); y += gap
    # Separador fino
    draw.line([(margin, y), (canvas_w - margin, y)], fill=0, width=1)
    y += 2 + gap
    # Cuerpo (fecha + dirección + separadores)
    for t in body:
        y = _draw_center(draw, t, y, font_body, canvas_w)
    y += 10
    # Código de barras centrado
    x_bar = margin + (usable_w - img_bar.width)//2
    canvas.paste(img_bar, (x_bar, y))
    y += img_bar.height + gap
    # Footer centrado
    y = _draw_center(draw, footer_text, y, font_footer, canvas_w)

    # Imprimir bitmap vía GDI
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(printer_name)
    _start_doc(hDC, title="Ticket")
    dib_hw = ImageWin.Dib(canvas.convert("RGB"))
    dib_hw.draw(hDC.GetHandleOutput(), (0, 0, canvas_w, canvas_h))
    _end_doc(hDC)
    print("INFO: Impresión estética con cambios aplicados.")
def build_ticket_lines(ticket_str: str):
    """
    Devuelve (lines, numero_barcode). El número no se imprime como texto: solo en el código de barras.
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        COMPANY_NAME,
        "------------------------------",
        f"Fecha:  {now}",
        "Aguero 265",
        "------------------------------",
        "",
    ]
    return lines, str(ticket_str)
def main():
    ticket_str = str(sys.argv[1]).strip() if len(sys.argv) >= 2 else "0000000000"
    printer_name = get_resolved_printer_name()

    # Generar líneas y número a codificar
    lines, number_to_encode = build_ticket_lines(ticket_str)

    # Intentar PIL+barcode; si falla, GDI texto
    try:
        _render_and_print_canvas(printer_name, lines, number_to_encode)
        return
    except Exception as e:
        print(f"WARNING: PIL/barcode falló, uso GDI texto. Motivo: {e}")

    _print_text_gdi(printer_name, lines, font_name="Consolas", font_height=18, left=10, top=10, line_spacing=4)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: excepción no controlada en imprimir_ticket.py: {e}")
        raise





