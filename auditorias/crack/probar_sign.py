#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probar_sign.py — prueba fórmulas de sign contra /api/vod/info_new de verdad.

Por qué sirve: el servidor responde el error chino EN TEXTO PLANO cuando el sign
es malo, y el JSON cifrado (base64 → AES) cuando es bueno. Así que cada intento
es concluyente, no hay que adivinar nada.

Fórmula base (leída del binario, handler 0xc98f4–0xc9bfc de pphls_elf_interno.so):
    sign = md5( device_id_url ‖ ts ‖ ck )
donde device_id_url es el valor TAL CUAL va en /control?device_id=… (lleva el
vod_id pegado) y ck es el campo 0x38 de la config del SDK. Como ck se entrega
por red, aquí se prueban candidatos y varios órdenes.

Uso:  python3 probar_sign.py [--vod 711142488] [--dev 3736e27f0823b1ba]
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

from Crypto.Cipher import AES

API = 'https://surfclick.vd7au6.com/api/vod/info_new'
KEY = b'0123456789123456'
IV = b'2015030120123456'
ERROR_PLANO = '系统出问题啦'

CANDIDATOS_CK = [
    ('hlskey(load arg2)', '87c2cb7ff568d602d5f806c473345600'),
    ('secreto-app', '47Q8tBqO4YqrMHf4'),
    ('mod:de304f03', 'de304f03fe653f329edfea08ea2046c4'),
    ('mod:1be0ac56', '1be0ac56'),
    ('vacio', ''),
]


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def descifrar(texto):
    """Intenta base64 + AES-128-CBC. Devuelve el JSON o None."""
    try:
        pad = '=' * (-len(texto) % 4)
        raw = base64.b64decode(texto + pad)
        if len(raw) % 16:
            return None
        out = AES.new(KEY, AES.MODE_CBC, IV).decrypt(raw)
        out = out[:-out[-1]] if out[-1] < 16 else out
        return json.loads(out.decode('utf-8', 'replace'))
    except Exception:
        return None


def probar(vod, dev_hdr, ts, sign, audio='es'):
    cuerpo = urllib.parse.urlencode({
        'vod_id': vod, 'cur_time': ts, 'sign': sign, 'audio_type': audio,
    }).encode()
    req = urllib.request.Request(API, data=cuerpo, headers={
        'Content-Type': 'application/x-www-form-urlencoded',
        'app_id': 'movievn', 'version': '40000', 'sys_platform': '2',
        'device_id': dev_hdr, 'channel_code': 'movievn_sh_1000',
        'cur_time': str(ts), 'token': '', 'User-Agent': 'okhttp/4.12.0',
    })
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return 'HTTP %s %s' % (e.code, e.read()[:120].decode('utf-8', 'replace'))
    except Exception as e:
        return 'ERROR %s' % str(e)[:120]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vod', default='711142488')
    ap.add_argument('--dev', default='3736e27f0823b1ba')
    a = ap.parse_args()

    # tal y como va en /control?device_id=…  (device + vod_id pegados)
    dev_url = a.dev + a.vod

    def variantes(ts):
        for nombre, ck in CANDIDATOS_CK:
            base = [(dev_url, str(ts), ck), (dev_url, ck, str(ts)),
                    (ck, dev_url, str(ts)), (str(ts), dev_url, ck)]
            for trio in base:
                h = md5(''.join(trio))
                yield '%s dev+ts+ck=%s' % (nombre, trio is base[0] and 'S' or '?'), h
                yield '%s MAYUS' % nombre, h.upper()

    vistos = set()
    total = exito = 0
    for etiqueta, sign in variantes(int(time.time() * 1000)):
        clave = (etiqueta.split()[0], sign)
        if sign in vistos:
            continue
        vistos.add(sign)
        total += 1
        r = probar(a.vod, a.dev, int(time.time() * 1000), sign)
        j = descifrar(r) if r else None
        if j is not None or ERROR_PLANO not in r:
            exito += 1
            print('\n*** DISTINTO DEL ERROR NORMAL *** %s' % etiqueta)
            print('    sign=%s' % sign)
            print('    resp=%s' % r[:400])
            if j:
                print('    JSON=%s' % json.dumps(j, ensure_ascii=False)[:600])
        else:
            print('  [%3d] %-28s -> error normal' % (total, etiqueta[:28]))
        if total >= 40:
            break
        time.sleep(0.4)

    print('\nintentos: %d | distintos del error: %d' % (total, exito))
    if not exito:
        print('Ninguna fórmula con estos ck funcionó → falta el ck real '
              '(se entrega por red, no está en el binario).')


if __name__ == '__main__':
    sys.exit(main())
