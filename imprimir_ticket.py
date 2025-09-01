import sys
import os
import json
import win32print
import win32ui
from PIL import Image, ImageWin
import requests
from io import BytesIO
from datetime import datetime

# Ruta absoluta al archivo impresora.json
CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), 'configuracion', 'impresora.json'))

# ===== Helpers de impresora =====
def obtener_impresora_configurada():
    print(f"DEBUG: Leyendo impresora desde: {CONFIG_PATH}")
    if not os.path.isfile(CONFIG_PATH):
        print("DEBUG: No existe archivo impresora.json")
        return None
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            impresora = data.get('impresora')
            if impresora and isinstance(impresora, str):
                print(f"DEBUG: Impresora configurada: '{impresora}'")
                return impresora
            else:
                print("DEBUG: No hay impresora configurada válida en JSON")
    except Exception as e:
        print(f"No se pudo leer impresora configurada: {e}")
    return None

def impresora_disponible(nombre_impresora):
    try:
        impresoras = [p[2] for p in win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )]
        if nombre_impresora in impresoras:
            return True
        else:
            print(f"WARNING: Impresora configurada '{nombre_impresora}' NO está disponible en el sistema.")
            print(f"Impresoras disponibles: {impresoras}")
            return False
    except Exception as e:
        print(f"Error verificando impresoras instaladas: {e}")
        return False

# ===== Código de barras =====
def imprimir_codigo_barras(pdc, codigo, x, y):
    try:
        barcode_url = 'http://localhost:5000/api/tickets/barcode'
        response = requests.post(barcode_url, json={'text': codigo}, timeout=5)

        if response.status_code != 200:
            print(f"Error API código barras: {response.status_code}")
            return 0

        with Image.open(BytesIO(response.content)) as img:
            # Normalizar a RGB con fondo blanco si hay transparencia
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                fondo = Image.new("RGB", img.size, (255, 255, 255))
                if img.mode in ('RGBA', 'LA'):
                    fondo.paste(img, mask=img.split()[3])
                else:
                    fondo.paste(img)
                bmp = fondo
            else:
                bmp = img.convert("RGB")

            ancho_final, alto_final = bmp.size
            dib = ImageWin.Dib(bmp)
            dib.draw(pdc.GetHandleOutput(), (x, y, x + ancho_final, y + alto_final))

        return alto_final

    except requests.exceptions.RequestException as e:
        print(f"Error de conexión: {e}")
    except Exception as e:
        print(f"Error inesperado: {e}")
    return 0

# ===== Ticket =====
def imprimir_ticket(texto):
    try:
        printer_name = obtener_impresora_configurada()

        if not printer_name:
            print("ERROR: No hay impresora configurada en impresora.json. No se imprimirá.")
            return False

        if not impresora_disponible(printer_name):
            print("ERROR: La impresora configurada no está disponible. No se imprimirá.")
            return False

        # Abrir impresora y DC
        hprinter = win32print.OpenPrinter(printer_name)
        dc = win32ui.CreateDC()
        dc.CreatePrinterDC(printer_name)

        # Iniciar documento
        dc.StartDoc("Ticket de Parking")
        dc.StartPage()

        # ===========================
        # Quitar "margen duro" del driver
        # ===========================
        PHYSICALOFFSETX = 112
        PHYSICALOFFSETY = 113
        phys_x = dc.GetDeviceCaps(PHYSICALOFFSETX)
        phys_y = dc.GetDeviceCaps(PHYSICALOFFSETY)
        dc.SetViewportOrg((-phys_x, -phys_y))

        # Layout sin padding
        X_LEFT = 0
        Y_TOP  = 0

        # Tipografías (una familia; título = bold y más chico)
        font_body = win32ui.CreateFont({
            "name": "Courier New",
            "height": -30,
            "weight": 600,
        })
        font_title_small_bold = win32ui.CreateFont({
            "name": "Courier New",
            "height": -35,
            "weight": 700,   # bold
        })

        # Fondo de texto transparente (no tapa nada, solo por prolijidad)
        dc.SetBkMode(1)  # TRANSPARENT

        # Ticket number = primera línea del texto (NO se imprime como texto)
        ticket_num = texto.split('\n')[0].strip()

        # ----- Título: Eleven Park (bold, chico) -----
        dc.SelectObject(font_title_small_bold)
        y_pos = Y_TOP
        title_text = "Eleven Park"
        dc.TextOut(X_LEFT, y_pos, title_text)

        # Medir altura real del título y dejar margen seguro
        tw, th = dc.GetTextExtent(title_text)  # (ancho, alto) en unidades del dispositivo
        y_pos += th + 12  # << clave: evita que el bitmap del barcode lo pise

        # ----- Código de barras -----
        alto_codigo = imprimir_codigo_barras(dc, ticket_num, X_LEFT, y_pos)
        if alto_codigo > 0:
            y_pos += alto_codigo + 8
        else:
            dc.SelectObject(font_body)
            dc.TextOut(X_LEFT, y_pos, "[CODIGO BARRAS NO DISPONIBLE]")
            y_pos += 40

        # ----- Fecha y Hora (líneas separadas) -----
        dc.SelectObject(font_body)
        ahora = datetime.now()
        fecha_str = ahora.strftime('%d/%m/%Y')
        hora_str  = ahora.strftime('%H:%M:%S')

        dc.TextOut(X_LEFT, y_pos, f"Fecha: {fecha_str}")
        y_pos += 40
        dc.TextOut(X_LEFT, y_pos, f"Hora:  {hora_str}")
        y_pos += 40

        # Cerrar página/doc
        dc.EndPage()
        dc.EndDoc()
        dc.DeleteDC()
        win32print.ClosePrinter(hprinter)

        print("Ticket impreso exitosamente")
        return True

    except Exception as e:
        print(f"Error crítico al imprimir: {e}")
        return False

# ===== Main =====
if __name__ == "__main__":
    if len(sys.argv) > 1:
        texto = sys.argv[1].replace("\\n", "\n")
        exit_code = 0 if imprimir_ticket(texto) else 1
        sys.exit(exit_code)
    else:
        print("Uso: python imprimir_ticket.py 'Texto\\ndel\\nticket'")
        sys.exit(1)
