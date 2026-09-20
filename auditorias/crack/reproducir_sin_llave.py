#!/usr/bin/env python3
"""
reproducir_sin_llave.py — Reproduce CUALQUIER video del catálogo SIN wsSecret.
Uso: python3 reproducir_sin_llave.py [vod_id]
Ejemplo: python3 reproducir_sin_llave.py 98331
"""
import sys, time, json, hashlib, base64, urllib.request, ssl

HOST = 'https://surfclick.vd7au6.com'
DEV  = 'huddle_player_001'
SEC  = 'Zox882LYjEn4Rqpa'
HDR_KEY = '47Q8tBqO4YqrMHf4'
AES_KEY, AES_IV = b'0123456789123456', b'2015030120123456'
ESPEJO = '147.124.216.142'

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def descifrar(txt):
    raw = base64.b64decode(txt)
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    c = Cipher(algorithms.AES(AES_KEY), modes.CBC(AES_IV))
    dec = c.decryptor()
    d = dec.update(raw) + dec.finalize()
    return json.loads(d[:-d[-1]].decode('utf-8'))

def pedir(ruta, body, token=''):
    ts = int(time.time() * 1000)
    h = {'app_id': 'movievn', 'version': '40000', 'sys_platform': '2',
         'device_id': DEV, 'channel_code': 'movievn_sh_1000',
         'cur_time': str(ts),
         'sign': hashlib.md5((HDR_KEY + DEV + str(ts)).encode()).hexdigest().upper(),
         'token': token, 'user-agent': 'okhttp/4.12.0',
         'content-type': 'application/x-www-form-urlencoded'}
    req = urllib.request.Request(HOST + ruta, data=body.encode(), headers=h)
    return urllib.request.urlopen(req, timeout=25, context=ctx).read().decode()

def obtener_token():
    j = descifrar(pedir('/api/public/init', f'device_id={DEV}&channel_code=movievn_sh_1000'))
    return j['result']['user_info']['token']

def obtener_video(vod_id, token):
    ts = int(time.time() * 1000)
    sign = hashlib.md5((SEC + DEV + str(vod_id) + str(ts)).encode()).hexdigest().upper()
    body = f'vod_id={vod_id}&cur_time={ts}&sign={sign}&audio_type=0'
    j = descifrar(pedir('/api/vod/info_new', body, token))
    return j.get('result', {})

def url_espejo(url_original):
    """Cambia el dominio CDN por el espejo abierto."""
    return url_original.replace('movievn.j5t2n.com', ESPEJO)

if __name__ == '__main__':
    vod_id = sys.argv[1] if len(sys.argv) > 1 else '98331'
    
    print(f'=== REPRODUCTOR SIN LLAVE ===')
    print(f'Obteniendo token...')
    token = obtener_token()
    print(f'Token OK: {token[:30]}...')
    
    print(f'\nBuscando video ID={vod_id}...')
    result = obtener_video(vod_id, token)
    
    nombre = result.get('vod_name', 'Desconocido')
    year = result.get('vod_year', '?')
    print(f'Título: {nombre} ({year})')
    
    col = result.get('vod_collection', [])
    if not col:
        print('Sin URLs de video')
        sys.exit(1)
    
    print(f'\nEpisodios/partes: {len(col)}')
    print(f'\n=== URLs LISTAS PARA VER (espejo sin llave) ===')
    for i, c in enumerate(col[:10]):
        url = c.get('vod_url', '')
        if url:
            mirror = url_espejo(url)
            tipo = 'Doblaje' if c.get('type') == 2 else 'Subtitulos'
            titulo = c.get('title', f'Parte {i+1}')
            print(f'  [{titulo}] ({tipo}): {mirror}')
    
    if len(col) > 10:
        print(f'  ... y {len(col)-10} más')
    
    # Guardar playlist
    playlist = []
    for c in col:
        url = c.get('vod_url', '')
        if url:
            playlist.append({
                'titulo': c.get('title', ''),
                'tipo': c.get('type'),
                'url': url_espejo(url),
                'duracion': c.get('duration', 0)
            })
    
    outfile = f'playlist_{vod_id}.json'
    with open(outfile, 'w') as f:
        json.dump(playlist, f, indent=2)
    print(f'\nPlaylist guardada: {outfile} ({len(playlist)} videos)')
