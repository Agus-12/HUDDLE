#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
info_new_vivo.py — LA VIA ABIERTA (19 sep 2026, verificado en vivo).

EL CANDADO NO ERA LA HUELLA TLS NI EL SECRETO: era el Content-Type.
Sin `content-type: application/x-www-form-urlencoded` el servidor no parsea
el body y devuelve el error chino `系统出问题啦~请稍后再试` a CUALQUIER cliente
(okhttp, urllib, curl, node). Con la cabecera puesta, TODO pasa desde cualquier
IP y cualquier cliente (probado con urllib SIN huella).

Fórmula del sign del body (derivada de 3 firmas reales capturadas al amigo y
verificada contra las 3):

    sign = MD5( "Zox882LYjEn4Rqpa" + device_id + vod_id + cur_time_ms ).upper()

Sign de cabecera (el de siempre, verificado):
    MD5( "47Q8tBqO4YqrMHf4" + device_id + cur_time_ms ).upper()

Token: POST /api/public/init  ->  result.user_info.token

Respuesta de info_new: base64 -> AES-128-CBC key 0123456789123456
iv 2015030120123456. En result.vod_collection[] vienen:
    vod_url  = http://movievn.j5t2n.com/vod/.../index5.m3u8  (CDN plano, directo)
    type     = 1 Subtitulos / 2 Doblaje   (regla de la casa: usar SIEMPRE 2,
               y si no hay, 1 verificando audio latino)
    duration, title (numero de episodio/parte)

Uso:  python3 info_new_vivo.py 711142488
"""
import sys, time, json, hashlib, base64, urllib.request

HOST = 'https://surfclick.vd7au6.com'
DEV  = 'bddd070962dc473e'          # device propio de este sandbox; puede ser cualquiera
SEC  = 'Zox882LYjEn4Rqpa'          # device_encrypt_key por defecto = el vivo
AES_KEY, AES_IV = b'0123456789123456', b'2015030120123456'


def descifrar(txt):
    raw = base64.b64decode(txt)
    from Crypto.Cipher import AES
    c = AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
    d = c.decrypt(raw)
    return json.loads(d[:-d[-1]].decode('utf-8'))


def aes_puro(txt):
    # descifrado sin pycryptodome (AES del repo: verificar_api)
    try:
        return descifrar(txt)
    except ImportError:
        sys.path.insert(0, __file__.rsplit('/', 1)[0])
        import verificar_api
        return verificar_api.descifrar(txt)


def pedir(ruta, body, token=''):
    ts = int(time.time() * 1000)
    h = {'app_id': 'movievn', 'version': '40000', 'sys_platform': '2',
         'device_id': DEV, 'channel_code': 'movievn_sh_1000',
         'cur_time': str(ts),
         'sign': hashlib.md5(('47Q8tBqO4YqrMHf4' + DEV + str(ts)).encode()).hexdigest().upper(),
         'token': token, 'user-agent': 'okhttp/4.12.0',
         'content-type': 'application/x-www-form-urlencoded'}   # <-- LA CLAVE
    req = urllib.request.Request(HOST + ruta, data=body.encode(), headers=h)
    return urllib.request.urlopen(req, timeout=25).read().decode()


def token_nuevo():
    j = aes_puro(pedir('/api/public/init',
                       'device_id=%s&channel_code=movievn_sh_1000' % DEV))
    return j['result']['user_info']['token']


def ficha(vod_id, token):
    ts = int(time.time() * 1000)
    sign = hashlib.md5((SEC + DEV + str(vod_id) + str(ts)).encode()).hexdigest().upper()
    body = 'vod_id=%s&cur_time=%d&sign=%s&audio_type=0' % (vod_id, ts, sign)
    return aes_puro(pedir('/api/vod/info_new', body, token))


def url_latina(result):
    """Regla de la casa: audio latino/doblaje (type 2) primero; si no, type 1."""
    col = result.get('vod_collection') or []
    for t in (2, 1):
        for c in col:
            if c.get('type') == t and c.get('vod_url'):
                return c['vod_url'], t
    return (col[0].get('vod_url') if col else None), None


if __name__ == '__main__':
    vod = sys.argv[1] if len(sys.argv) > 1 else '711142488'
    tok = token_nuevo()
    j = ficha(vod, tok)
    r = j.get('result') or {}
    print('code   :', j.get('code'))
    print('nombre :', r.get('vod_name'), '|', r.get('vod_year'), '|', r.get('vod_lang'))
    print('poster :', r.get('vod_pic'))
    url, t = url_latina(r)
    print('video  :', url, '(type', t, ')')
    print('sinopsis:', (r.get('vod_blurb') or '')[:200])
