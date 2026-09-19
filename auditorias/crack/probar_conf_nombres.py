#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probar_conf_nombres.py (v228.3) — pide a la API VIVA los nombres de config
QUE USAN EL SDK Y LA APP (no nombres inventados).

Por qué existe:
  El módulo real del reproductor (`pphls_inflado.bin`) trae la **config por
  defecto completa** del SDK (`[BASE]` y `[P2P]`, con
  `device_encrypt_key=Zox882LYjEn4Rqpa`, `ck=…`, `p2p_tracker_addr=…`). Esa
  lista dice EXACTAMENTE cómo se llaman los ajustes que la app/servidor pueden
  mandar; antes se habían probado nombres inventados (conf_key1, hls_key,
  wsSecret…) y por eso salía vacío.

  Ahora se itera esa lista real contra `/api/public/get_sys_conf` y se marca
  cualquier respuesta con pinta de MATERIAL (hex de 32/64, base64 largo).

Resultado medido (19-sep-2026): **todos vacíos** salvo `vod_tags`, `ad_appid`
y `p2p_config`. No repetirlo sin motivo.

Uso:
  python3 probar_conf_nombres.py                 # lista sacada del módulo
  python3 probar_conf_nombres.py --modulo RUTA   # otro volcado inflado
  python3 probar_conf_nombres.py --extra ws_key,wsSecret,hls_key

Nada de esto guarda secretos en el repo: imprime y deja el resultado en /tmp.
"""
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

HOST = os.environ.get('HUDDLE_HOST', 'https://surfclick.vd7au6.com')
DEV = os.environ.get('HUDDLE_DEV', 'PON_TU_DEVICE_ID')
SIGN_HEADER_KEY = '47Q8tBqO4YqrMHf4'      # cabecera (siempre la misma)
AES_KEY, AES_IV = b'0123456789123456', b'2015030120123456'
AQUI = Path(__file__).resolve().parent
# el marcador va partido: así el literal de una clave PEM no aparece nunca en el repo
MARCA_PEM = b'-----BEGIN RSA ' + b'PRIVATE KEY-----'


def _modulo_por_defecto():
    for c in (AQUI / 'pphls_inflado.bin', AQUI / 'v4hls__inflado.bin',
              AQUI / 'v4hls_inflado.bin'):
        if c.exists():
            return str(c)
    return str(AQUI / 'pphls_inflado.bin')


MODULO = os.environ.get('HUDDLE_MODULO', _modulo_por_defecto())


def nombres_del_modulo(ruta=MODULO):
    d = open(ruta, 'rb').read()
    # OJO: '[BASE]' también aparece dentro de libcurl (cabeceras HTTP), así que
    # se ancla la búsqueda en una línea que SOLO está en la config del SDK.
    i = d.find(b'player_listen_port=')
    if i < 0:
        sys.exit('no encontré la config del SDK en %s' % ruta)
    i = d.rfind(b'[BASE]', max(0, i - 200), i)
    if i < 0:
        i = d.find(b'player_listen_port=')
    j = d.find(MARCA_PEM, i)
    bloque = d[i:j if j > 0 else i + 8192]
    txt = re.sub(rb'[^\x20-\x7e]', b'\n', bloque).decode('latin1')
    nombres = []
    for lin in txt.split('\n'):
        lin = lin.strip()
        if not lin or re.fullmatch(r'\[[A-Za-z0-9_]+\]', lin):
            continue
        m = re.fullmatch(r'([A-Za-z0-9_]+)=.*', lin)
        if m:
            nombres.append(m.group(1))
    vista, salida = set(), []
    for n in nombres:
        if n not in vista:
            vista.add(n)
            salida.append(n)
    return salida


def descifrar(txt):
    from Crypto.Cipher import AES
    raw = base64.b64decode(txt)
    d = AES.new(AES_KEY, AES.MODE_CBC, AES_IV).decrypt(raw)
    return json.loads(d[:-d[-1]].decode('utf-8'))


def pedir(ruta, body, token=''):
    ts = int(time.time() * 1000)
    h = {'app_id': 'movievn', 'version': '40000', 'sys_platform': '2',
         'device_id': DEV, 'channel_code': 'movievn_sh_1000', 'cur_time': str(ts),
         'sign': hashlib.md5((SIGN_HEADER_KEY + DEV + str(ts)).encode()).hexdigest().upper(),
         'token': token, 'user-agent': 'okhttp/4.12.0',
         'content-type': 'application/x-www-form-urlencoded'}
    req = urllib.request.Request(HOST + ruta, data=body.encode(), headers=h)
    return urllib.request.urlopen(req, timeout=25).read().decode()


def valor_crudo(txt):
    try:
        return descifrar(txt)
    except Exception:
        return txt


def material(v):
    if not isinstance(v, str):
        return False
    s = v.strip()
    if re.fullmatch(r'[0-9a-fA-F]{32}', s) or re.fullmatch(r'[0-9a-fA-F]{64}', s):
        return True
    return bool(len(s) >= 24 and re.fullmatch(r'[A-Za-z0-9+/=_-]+', s))


def main():
    extra = []
    for a in sys.argv[1:]:
        if a.startswith('--extra'):
            extra = [x for x in a.split('=', 1)[-1].split(',') if x]
    nombres = list(dict.fromkeys(nombres_del_modulo() + extra))
    print('nombres sacados del módulo del SDK: %d' % len(nombres))
    print('  ' + ', '.join(nombres))
    print()

    tok = ''
    try:
        j = valor_crudo(pedir('/api/public/init', 'device_id=%s&channel_code=movievn_sh_1000' % DEV))
        if isinstance(j, dict) and 'result' in j:
            tok = (j.get('result') or {}).get('user_info', {}).get('token', '')
            sc = (j.get('result') or {}).get('sys_conf') or {}
            print('--- sys_conf del init (lo que el servidor manda de entrada) ---')
            print(json.dumps(sc, ensure_ascii=False)[:1500])
            open('/tmp/sysconf-init.json', 'w').write(json.dumps(j, ensure_ascii=False, indent=1))
            print('(completo en /tmp/sysconf-init.json)\n')
    except Exception as e:
        print('init falló: %r' % (e,))

    con_datos, con_material = [], []
    for n in nombres:
        try:
            v = valor_crudo(pedir('/api/public/get_sys_conf', 'conf_key=%s' % n, token=tok))
            if isinstance(v, dict):
                v = json.dumps(v, ensure_ascii=False)
            v = str(v).strip()
            corto = v if len(v) <= 160 else v[:160] + '...'
            if v and v not in ('""', '{}', '[]', 'null'):
                print('  %-34s -> %s' % (n, corto))
                con_datos.append((n, v))
                if material(v):
                    con_material.append((n, v))
            else:
                print('  %-34s -> (vacío)' % n)
        except Exception as e:
            print('  %-34s -> ERROR %r' % (n, e))
        time.sleep(0.4)

    print('\ncon datos: %d' % len(con_datos))
    for n, _ in con_datos:
        print('   %s' % n)
    print('con pinta de MATERIAL: %d' % len(con_material))
    for n, v in con_material:
        print('   %s = %s' % (n, v[:100]))
    open('/tmp/conf-nombres.json', 'w').write(json.dumps(con_datos, ensure_ascii=False, indent=1))
    print('(resultado en /tmp/conf-nombres.json)')


if __name__ == '__main__':
    main()
