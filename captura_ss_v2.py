# captura_ss.py v2 — captura TODO: API del app (descifrada) + CUALQUIER video de CUALQUIER servidor.
# Se usa con: mitmdump -s captura_ss.py --listen-host 0.0.0.0 --listen-port 8080 --set block_global=false
# Imprime con '>>>' lo interesante. Los m3u8 muestran su CONTENIDO (las URLs de los segmentos).
import re, base64, subprocess
from mitmproxy import http

PATRON = re.compile(r'z3azky|vd7au6|j5t2n|k5ca|freemovies|d9s3x4|movievn|u9m2|r2c7a0|4j4damaqa|k0j5n7|freecine|h4c5', re.I)
VIDEO = re.compile(r'\.m3u8|\.mp4|\.ts\b|\.mkv|/resource|/vod/|segment|playlist|/control\?|verify', re.I)
HEADS = ('app_id', 'version', 'sys_platform', 'device_id', 'cur_time', 'token',
         'sign', 'channel_code', 'user-agent', 'authorization', 'x-', 'key', 'content-type')

VISTOS = set()

def aes_dec(txt):
    b64 = ''.join((txt or '').split()).strip().strip('"')
    if len(b64) < 32 or not re.fullmatch(r'[A-Za-z0-9+/=]+', b64[:200] if len(b64) > 200 else b64):
        return None
    b64 += '=' * (-len(b64) % 4)
    try:
        crudo = base64.b64decode(b64)
    except Exception:
        return None
    p = subprocess.run(
        ['openssl', 'enc', '-d', '-aes-128-cbc',
         '-K', '30313233343536373839313233343536',
         '-iv', '32303135303330313230313233343536'],
        input=crudo, capture_output=True)
    out = p.stdout.decode('utf-8', 'replace')
    return out if out.startswith('{') else None

def request(flow: http.HTTPFlow):
    host = flow.request.pretty_host
    url = flow.request.pretty_url
    if VIDEO.search(url):
        # ORO: cualquier cosa que parezca video — URL completa
        print('\n>>> [VIDEO-REQ] %s %s' % (flow.request.method, url[:400]))
        for k, v in flow.request.headers.items():
            if k.lower() in ('range', 'user-agent', 'referer'):
                print('>>>   H %s = %s' % (k, str(v)[:120]))
        return
    if not PATRON.search(host) and host not in VISTOS:
        VISTOS.add(host)
        print('\n>>> (otro host) %s %s' % (flow.request.method, url[:160]))

def response(flow: http.HTTPFlow):
    url = flow.request.pretty_url
    host = flow.request.pretty_host
    if VIDEO.search(url) and not PATRON.search(host):
        try:
            cuerpo = flow.response.get_text(strict=False) or ''
        except Exception:
            cuerpo = ''
        print('\n>>> [VIDEO-RESP] %s %s' % (flow.request.method, url[:400]))
        print('>>>   contenido: %s' % cuerpo[:600].replace('\n', ' | '))
        return
    if not (PATRON.search(host) or VIDEO.search(url)):
        return
    print('\n>>> ================================================')
    print('>>> %s %s' % (flow.request.method, url[:250]))
    for k, v in flow.request.headers.items():
        kl = k.lower()
        if kl in HEADS or 'sign' in kl or 'token' in kl:
            print('>>>   H %s = %s' % (k, str(v)[:140]))
    try:
        if flow.request.query:
            print('>>>   Q %s' % dict(flow.request.query))
    except Exception:
        pass
    cuerpo = ''
    try:
        cuerpo = flow.response.get_text(strict=False) or ''
    except Exception:
        pass
    if '/api/' in url or 'shareapi' in host:
        d = aes_dec(cuerpo)
        print('>>>   RESP: %s' % (d or cuerpo)[:2500])
    elif VIDEO.search(url):
        print('>>>   VIDEO RESP: %s' % cuerpo[:600].replace('\n', ' | '))
    print('>>> ================================================')
