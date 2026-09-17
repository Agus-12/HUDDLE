# -*- coding: utf-8 -*-
# captura_sign.py  —  mitmproxy addon para atrapar EL SIGN REAL del app Movie.
#
# Por qué existe: el capturador anterior (captura_ss.py) imprimía cabeceras y
# respuestas, pero NO el cuerpo del POST. Y el `sign` de /api/vod/info_new viaja
# en el CUERPO del POST (form-urlencoded), no en las cabeceras. Este addon guarda
# todo el par petición/respuesta de los hosts del app, sin truncar, a un archivo
# JSONL (una línea por flujo) para poder analizarlo después con calma.
#
# Uso:
#   mitmdump -s captura_sign.py --listen-host 0.0.0.0 --listen-port 8080 \
#            --set block_global=false
# Salida:
#   ~/captura-sign.jsonl   (cada línea: url, cabeceras, cuerpo POST, respuesta, AES descifrado)
#   la pantalla muestra solo un resumen corto con '>>>'
#
# Regla de oro: NUNCA subir este archivo al repo (contiene tokens y device ids).

import base64
import json
import os
import re
import subprocess
import time

from mitmproxy import http

SALIDA = os.path.expanduser("~/captura-sign.jsonl")

# Hosts conocidos del app Movie / de su CDN. Si aparece uno nuevo se anota igual.
PATRON = re.compile(
    r"z3azky|vd7au6|j5t2n|k5ca|m5e7|movievn|4j4damaqa|freecine|surfclick|h4c5|albd",
    re.I,
)
# El cifrado de las respuestas de la API: base64 -> AES-128-CBC
AES_KEY = "30313233343536373839313233343536"  # "0123456789123456"
AES_IV = "32303135303330313230313233343536"   # "2015030120123456"


def _aes_dec(txt):
    """Intenta descifrar una respuesta base64+AES de la API. None si no aplica."""
    b64 = "".join((txt or "").split()).strip().strip('"')
    if len(b64) < 32:
        return None
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", b64[:400]):
        return None
    b64 += "=" * (-len(b64) % 4)
    try:
        crudo = base64.b64decode(b64)
    except Exception:
        return None
    p = subprocess.run(
        ["openssl", "enc", "-d", "-aes-128-cbc", "-K", AES_KEY, "-iv", AES_IV],
        input=crudo,
        capture_output=True,
    )
    out = p.stdout.decode("utf-8", "replace")
    return out if out.startswith("{") else None


def _guardar(obj):
    try:
        with open(SALIDA, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except Exception as e:  # nunca tumbar el proxy por un disco raro
        print(">>> ERROR guardando:", e)


def _texto(req):
    try:
        return req.get_text(strict=False) or ""
    except Exception:
        try:
            return req.content.decode("utf-8", "replace")
        except Exception:
            return ""


def response(flow: http.HTTPFlow):
    host = flow.request.pretty_host
    url = flow.request.pretty_url

    # Guardamos TODO lo que huela a app Movie o a su CDN; lo demás se ignora.
    if not PATRON.search(host) and not PATRON.search(url):
        return

    cuerpo_req = _texto(flow.request)
    try:
        cuerpo_resp = flow.response.get_text(strict=False) or ""
    except Exception:
        cuerpo_resp = ""

    reg = {
        "t": time.time(),
        "metodo": flow.request.method,
        "url": url,
        "host": host,
        "cabeceras_req": dict(flow.request.headers),
        "cuerpo_req": cuerpo_req[:20000],          # AQUÍ viene sign=...&cur_time=...
        "estado": flow.response.status_code if flow.response else None,
        "cabeceras_resp": dict(flow.response.headers) if flow.response else {},
        "cuerpo_resp": cuerpo_resp[:60000],
        "resp_descifrada": (_aes_dec(cuerpo_resp) or "")[:60000],
    }
    _guardar(reg)

    # Resumen corto en pantalla para ver que está funcionando.
    print(">>> ================================================")
    print(">>>", flow.request.method, url[:180])
    if cuerpo_req:
        print(">>>   POST:", cuerpo_req[:400].replace("\n", " "))
    for k, v in flow.request.headers.items():
        if k.lower() in ("sign", "device_id", "cur_time", "token", "app_id", "channel_code"):
            print(">>>   H %s = %s" % (k, str(v)[:120]))
    d = reg["resp_descifrada"]
    if d:
        print(">>>   RESP(desc):", d[:600].replace("\n", " "))
    else:
        print(">>>   RESP:", cuerpo_resp[:300].replace("\n", " "))
    print(">>> ================================================")
