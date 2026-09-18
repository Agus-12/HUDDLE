# -*- coding: utf-8 -*-
"""
verificar_api.py — ¿el backend del app Movie está vivo?

Por qué existe: el 18-sep se perdieron horas probando 440 variantes de la fórmula del
sign contra un servidor que estaba CAÍDO. Todas "fallaron" y no significaba nada.
La comprobación es simple: `POST /api/public/init` con un sign que SABEMOS correcto
(la fórmula de las cabeceras está verificada contra una captura real). Si eso no
devuelve `code:10000`, el backend está caído y NINGUNA prueba de fórmula vale.

Uso:
    python3 verificar_api.py            # solo salud (rápido)
    python3 verificar_api.py --probar   # si está vivo, corre la batería de fórmulas
    python3 verificar_api.py --vod 711142488

Sale con código 0 si el backend está vivo, 1 si está caído.
"""

import argparse
import base64
import hashlib
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# La fórmula de las cabeceras, VERIFICADA contra una captura real del teléfono:
#   MD5('47Q8tBqO4YqrMHf4' + device_id + cur_time) en mayúsculas
#   prueba: dev 3736e27f0823b1ba + ts 1789515864447 -> A526BDCB05C2CD7AE5EF38D96E56687F
SALT_CABECERAS = "47Q8tBqO4YqrMHf4"
DEVICE = "3736e27f0823b1ba"          # device_id real del teléfono del amigo
CHANNEL = "movievn_sh_1000"
APP_ID = "movievn"
VERSION = "40000"

HOSTS = [
    "https://surfclick.vd7au6.com",
    "https://movievn.z3azky.com",
    "https://movievn.m5e7.com",
    "https://escc.k5ca.com",
    "https://o.z2v3m6.com",
    "https://albd.h4c5.com",
]

# Cifrado de las respuestas: base64 -> AES-128-CBC
AES_KEY = b"0123456789123456"
AES_IV = b"2015030120123456"

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


# --- AES-128-CBC en Python puro (mismo código probado que en captura_sign.py) ---
def _gf_mul(a, b):
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
_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _xtime(a):
    a <<= 1
    if a & 0x100:
        a = (a ^ 0x1B) & 0xFF
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


_W = None


def _dec_block(b, w):
    s = [b[r + 4 * c] for c in range(4) for r in range(4)]

    def ark(rnd):
        for c in range(4):
            for r in range(4):
                s[r + 4 * c] ^= w[rnd * 4 + c][r]

    ark(10)
    for rnd in range(9, -1, -1):
        for r in range(1, 4):
            fila = [s[r + 4 * c] for c in range(4)]
            fila = fila[-r:] + fila[:-r]
            for c in range(4):
                s[r + 4 * c] = fila[c]
        for i in range(16):
            s[i] = _INV[s[i]]
        ark(rnd)
        if rnd:
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


def descifrar(txt):
    """base64 -> AES-128-CBC -> dict, o None si no es una respuesta cifrada."""
    b64 = "".join((txt or "").split()).strip().strip('"')
    if len(b64) < 32:
        return None
    b64 += "=" * (-len(b64) % 4)
    try:
        crudo = base64.b64decode(b64)
    except Exception:
        return None
    global _W
    if _W is None:
        _W = _expand(AES_KEY)
    out = bytearray()
    prev = AES_IV
    for i in range(0, len(crudo) - 15, 16):
        blk = crudo[i:i + 16]
        d = _dec_block(blk, _W)
        out += bytes(d[j] ^ prev[j] for j in range(16))
        prev = blk
    if out:
        n = out[-1]
        if 1 <= n <= 16 and bytes(out[-n:]) == bytes([n]) * n:
            del out[-n:]
    try:
        return json.loads(out.decode("utf-8", "replace"))
    except Exception:
        return None


def sign_cabeceras(ts, dev=DEVICE, salt=SALT_CABECERAS):
    return hashlib.md5((salt + dev + str(ts)).encode()).hexdigest().upper()


def llamar(host, ruta, datos, dev=DEVICE):
    ts = datos.get("cur_time") or int(time.time() * 1000)
    datos = dict(datos)
    datos.setdefault("cur_time", ts)
    cuerpo = urllib.parse.urlencode(datos).encode()
    req = urllib.request.Request(
        host + "/api" + ruta, data=cuerpo,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "app_id": APP_ID, "version": VERSION, "sys_platform": "2",
            "device_id": dev, "channel_code": CHANNEL, "cur_time": str(ts),
            "token": "", "User-Agent": "okhttp/4.12.0",
        })
    try:
        with urllib.request.urlopen(req, timeout=20, context=_CTX) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as e:
        return None, str(e)[:120]


def salud():
    """Devuelve (host_vivo, detalle). El backend está vivo si public/init con sign
    correcto devuelve code 10000."""
    print("Comprobando el backend con un sign que SABEMOS correcto...")
    print("(fórmula de cabeceras verificada contra captura real el 18-sep)\n")
    for host in HOSTS:
        ts = int(time.time() * 1000)
        st, body = llamar(host, "/public/init", {"cur_time": ts, "sign": sign_cabeceras(ts)})
        j = descifrar(body)
        if j and j.get("code") == 10000:
            print("  %-32s HTTP %s  code=10000  ✅ VIVO" % (host, st))
            return host, j
        texto = (j.get("message") if j else body)[:48].replace("\n", " ")
        print("  %-32s HTTP %s  %s" % (host, st, texto))
        time.sleep(0.4)
    return None, None


def probar(host, vod):
    """Batería de fórmulas para el sign del CUERPO de info_new. Solo correr con el
    backend VIVO, si no el resultado no significa nada."""
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from resolver_sign import CANDIDATOS, ordenes, variantes_de  # noqa

    print("\nBackend vivo en %s. Probando fórmulas contra vod_id=%s ...\n" % (host, vod))
    n = 0
    for nombre, secreto in CANDIDATOS:
        for nom_orden, plantilla in ordenes(DEVICE + vod, str(int(time.time() * 1000)), secreto):
            pass  # las plantillas dependen de ts; se rehacen abajo por intento
        for dev in (DEVICE, DEVICE + str(vod)):
            for nom_orden, salto in ordenes(dev, "TS", secreto):
                ts = int(time.time() * 1000)
                real = salto.replace("TS", str(ts))
                for nom_hash, candidato in variantes_de(real):
                    n += 1
                    st, body = llamar(host, "/vod/info_new", {
                        "vod_id": vod, "cur_time": ts, "sign": candidato, "audio_type": "es"})
                    j = descifrar(body)
                    if j and j.get("code") == 10000:
                        print("  ✅ ACIERTO: secreto=%r orden=%s hash=%s" % (secreto, nom_orden, nom_hash))
                        print("     " + json.dumps(j, ensure_ascii=False)[:400])
                        return True
                    if n % 25 == 0:
                        print("     ...%d probadas" % n)
                    time.sleep(0.12)
    print("\n  Ninguna de las %d combinaciones funcionó con el backend vivo." % n)
    print("  => el ck es otro: hace falta la captura real (resolver_sign.py).")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probar", action="store_true", help="si está vivo, correr la batería")
    ap.add_argument("--vod", default="711142488")
    args = ap.parse_args()

    host, j = salud()
    if not host:
        print("\n❌ El backend está CAÍDO en los %d hosts conocidos." % len(HOSTS))
        print("   Cualquier prueba de fórmula ahora mismo NO significa nada.")
        print("   Volver a correr esto más tarde; cuando salga ✅, recién probar.")
        return 1

    print("\n✅ Backend vivo. Se pueden hacer pruebas de verdad.")
    if j:
        sc = (j.get("result") or {}).get("sys_conf") or {}
        pc = sc.get("p2p_config") or ""
        if "ck=" in pc:
            ck = pc.split("ck=", 1)[1].split("^", 1)[0]
            print("   ck actual leído de p2p_config: %s" % ck)
            print("   (pasarlo a resolver_sign.py con --extra-secreto)")
    if args.probar:
        probar(host, args.vod)
    return 0


if __name__ == "__main__":
    sys.exit(main())
