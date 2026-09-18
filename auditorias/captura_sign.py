# -*- coding: utf-8 -*-
# captura_sign.py  —  mitmproxy addon para atrapar EL SIGN REAL del app Movie.
#
# Por qué existe: el capturador anterior (captura_ss.py) imprimía cabeceras y
# respuestas, pero NO el cuerpo del POST. Y el `sign` de /api/vod/info_new viaja
# en el CUERPO del POST (form-urlencoded), no en las cabeceras. Este addon guarda
# todo el par petición/respuesta de los hosts del app, sin truncar, a un archivo
# JSONL (una línea por flujo) para poder analizarlo después con calma.
#
# ⚠️ CORRECCIÓN IMPORTANTE (18 sep): la primera versión descifraba las respuestas
# lanzando un `openssl enc` por cada respuesta (subprocess.run). Eso FUGABA
# descriptores de archivo hasta reventar el proxy con:
#     502 Bad Gateway  [Errno 24] Too many open files
# comprobado en vivo desde fuera del servidor. Ahora el AES-128-CBC va en Python
# puro (abajo), sin subprocess y sin abrir procesos. Verificado contra el vector
# FIPS-197 y contra 3 respuestas reales del formato del app.
#
# Uso:
#   mitmdump -s captura_sign.py --listen-host 0.0.0.0 --listen-port 8080 \
#            --set block_global=false
# Salida:
#   ~/captura-sign.jsonl   (cada línea: url, cabeceras, cuerpo POST, respuesta, AES descifrado)
#   la pantalla muestra solo un resumen corto con '>>>'
#
# Regla de oro: NUNCA subir ~/captura-sign.jsonl al repo (contiene tokens y device ids).

import base64
import json
import os
import re
import time

from mitmproxy import http

SALIDA = os.path.expanduser("~/captura-sign.jsonl")

# Hosts conocidos del app Movie / de su CDN. Si aparece uno nuevo se anota igual.
PATRON = re.compile(
    r"z3azky|vd7au6|j5t2n|k5ca|m5e7|movievn|4j4damaqa|freecine|surfclick|h4c5|albd",
    re.I,
)
# Cifrado de las respuestas de la API: base64 -> AES-128-CBC
AES_KEY = b"0123456789123456"
AES_IV = b"2015030120123456"

_FH = None  # handle del JSONL, se abre una sola vez


# ---------------------------------------------------------------- AES-128 puro
def _gf_mul(a, b):
    """Multiplicacion en GF(2^8) con el polinomio del AES (0x11b)."""
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


def _make_sbox():
    """S-box del AES calculada desde su definicion (inverso en GF(2^8) + transformada
    afín). Se calcula en vez de escribirse a mano: una tabla tipeada a mano ya dio un
    byte mal (0x9e donde iba 0xc9) y descifraba basura sin quejarse."""
    inv = [0] * 256
    for i in range(1, 256):
        for j in range(1, 256):
            if _gf_mul(i, j) == 1:
                inv[i] = j
                break
    box = [0] * 256
    for i in range(256):
        x = inv[i]
        y = x
        for _ in range(4):
            y = ((y << 1) | (y >> 7)) & 0xFF
            x ^= y
        box[i] = x ^ 0x63
    return box


_SBOX = _make_sbox()
_INV = [0] * 256
for _x, _y in enumerate(_SBOX):
    _INV[_y] = _x
_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]


def _xtime(a):
    a <<= 1
    if a & 0x100:
        a = (a ^ 0x1b) & 0xFF
    return a


def _mul(a, b):
    r = 0
    for _ in range(8):
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r


def _expand(key):
    w = [list(key[4 * i:4 * i + 4]) for i in range(4)]
    for i in range(4, 44):
        t = list(w[i - 1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [_SBOX[b] for b in t]
            t[0] ^= _RCON[i // 4 - 1]
        w.append([w[i - 4][j] ^ t[j] for j in range(4)])
    return w


_W = None  # round keys, se calculan una sola vez


def _dec_block(b, w):
    s = [b[r + 4 * c] for c in range(4) for r in range(4)]

    def ark(rnd):
        for c in range(4):
            for r in range(4):
                s[r + 4 * c] ^= w[rnd * 4 + c][r]

    ark(10)
    for rnd in range(9, -1, -1):
        for r in range(1, 4):  # InvShiftRows
            fila = [s[r + 4 * c] for c in range(4)]
            fila = fila[-r:] + fila[:-r]
            for c in range(4):
                s[r + 4 * c] = fila[c]
        for i in range(16):  # InvSubBytes
            s[i] = _INV[s[i]]
        ark(rnd)
        if rnd:  # InvMixColumns
            for c in range(4):
                a = s[4 * c:4 * c + 4]
                s[4 * c + 0] = _mul(a[0], 14) ^ _mul(a[1], 11) ^ _mul(a[2], 13) ^ _mul(a[3], 9)
                s[4 * c + 1] = _mul(a[0], 9) ^ _mul(a[1], 14) ^ _mul(a[2], 11) ^ _mul(a[3], 13)
                s[4 * c + 2] = _mul(a[0], 13) ^ _mul(a[1], 9) ^ _mul(a[2], 14) ^ _mul(a[3], 11)
                s[4 * c + 3] = _mul(a[0], 11) ^ _mul(a[1], 13) ^ _mul(a[2], 9) ^ _mul(a[3], 14)
    out = bytearray(16)
    for c in range(4):
        for r in range(4):
            out[r + 4 * c] = s[r + 4 * c]
    return bytes(out)


def aes128_cbc_dec(key, iv, data):
    global _W
    if _W is None:
        _W = _expand(key)
    out = bytearray()
    prev = iv
    for i in range(0, len(data) - 15, 16):
        blk = data[i:i + 16]
        d = _dec_block(blk, _W)
        out += bytes(d[j] ^ prev[j] for j in range(16))
        prev = blk
    if out:
        n = out[-1]
        if 1 <= n <= 16 and bytes(out[-n:]) == bytes([n]) * n:
            del out[-n:]
    return bytes(out)


# ------------------------------------------------------------------- utilería
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
        out = aes128_cbc_dec(AES_KEY, AES_IV, crudo)
    except Exception:
        return None
    txt = out.decode("utf-8", "replace")
    return txt if txt.startswith("{") else None


def _guardar(obj):
    global _FH
    try:
        # Se reintenta en cada llamada: si la primera apertura falla, el addon NO debe
        # quedarse mudo para el resto de la sesion (bug encontrado en prueba).
        if _FH is None or _FH.closed:
            _FH = open(SALIDA, "a", encoding="utf-8")
        _FH.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _FH.flush()
    except Exception as e:  # nunca tumbar el proxy por un disco raro
        _FH = None
        print(">>> ERROR guardando:", e)


def _texto(req):
    try:
        return req.get_text(strict=False) or ""
    except Exception:
        try:
            return req.content.decode("utf-8", "replace")
        except Exception:
            return ""


# --------------------------------------------------------------------- hook
# Con block_global=false el puerto 8080 queda abierto a TODO internet, y los bots que
# escanean puertos abren cientos de conexiones que se quedan colgadas. Con el limite de
# descriptores en 1024 eso saturaba el proxy y dejaba de aceptar conexiones:
#     OSError: [Errno 24] Too many open files   (en sock.accept())
# Comprobado en vivo el 18-sep: 1024/1024 descriptores ocupados, 1019 sockets, 349
# colgados al 8080, y el telefono del amigo no pudo ni conectar (capturadas: 0).
# Este filtro cierra de inmediato cualquier conexion que no sea del app Movie.
def client_connected(client):
    try:
        sni = (getattr(client, "sni", "") or "").lower()
    except Exception:
        sni = ""
    if not sni:
        return  # HTTP plano o TLS sin SNI: se decide despues, en response()
    if PATRON.search(sni):
        return
    try:
        client.close()
    except Exception:
        pass


_HOSTS_VISTOS = set()


def response(flow: http.HTTPFlow):
    host = flow.request.pretty_host
    url = flow.request.pretty_url

    # Anotar TODOS los hosts que pasan, aunque no sean del app: sirve para saber que el
    # telefono si esta conectado y para descubrir hosts nuevos del app.
    if host and host not in _HOSTS_VISTOS:
        _HOSTS_VISTOS.add(host)
        print(">>> (host nuevo) %s" % host)

    if not PATRON.search(host) and not PATRON.search(url):
        return

    cuerpo_req = _texto(flow.request)
    try:
        cuerpo_resp = flow.response.get_text(strict=False) or ""
    except Exception:
        cuerpo_resp = ""

    desc = ""
    if len(cuerpo_resp) < 400000:  # no gastar CPU en cuerpos gigantes
        desc = (_aes_dec(cuerpo_resp) or "")

    reg = {
        "t": time.time(),
        "metodo": flow.request.method,
        "url": url,
        "host": host,
        "cabeceras_req": dict(flow.request.headers),
        "cuerpo_req": cuerpo_req[:20000],   # AQUÍ viene sign=...&cur_time=...
        "estado": flow.response.status_code if flow.response else None,
        "cabeceras_resp": dict(flow.response.headers) if flow.response else {},
        "cuerpo_resp": cuerpo_resp[:60000],
        "resp_descifrada": desc[:60000],
    }
    _guardar(reg)

    print(">>> ================================================")
    print(">>>", flow.request.method, url[:180])
    if cuerpo_req:
        print(">>>   POST:", cuerpo_req[:400].replace("\n", " "))
    for k, v in flow.request.headers.items():
        if k.lower() in ("sign", "device_id", "cur_time", "token", "app_id", "channel_code"):
            print(">>>   H %s = %s" % (k, str(v)[:120]))
    if desc:
        print(">>>   RESP(desc):", desc[:600].replace("\n", " "))
    else:
        print(">>>   RESP:", cuerpo_resp[:300].replace("\n", " "))
    print(">>> ================================================")
