#!/usr/bin/env python3
# Prueba los endpoints de búsqueda de la API Movie (surfclick.vd7au6.com).
# Uso: python3 scripts/mapi_search_test.py [termino]
import hashlib, time, sys, json, base64, urllib.request
from Crypto.Cipher import AES

API = 'https://surfclick.vd7au6.com/api'
DEV = '687564646c653031'
KEY = b'0123456789123456'
IV = b'2015030120123456'

def cabeceras():
    ms = str(int(time.time() * 1000))
    sign = hashlib.md5(('47Q8tBqO4YqrMHf4' + DEV + ms).encode()).hexdigest().upper()
    return {
        'app_id': 'movievn', 'version': '40000', 'sys_platform': '2',
        'device_id': DEV, 'channel_code': 'movievn_sh_1000', 'cur_time': ms,
        'sign': sign, 'token': '', 'user-agent': 'okhttp/4.12.0',
        'content-type': 'application/x-www-form-urlencoded',
    }

def llama(ruta, body):
    req = urllib.request.Request(API + ruta, data=body.encode(), headers=cabeceras(), method='POST')
    try:
        raw = urllib.request.urlopen(req, timeout=20).read()
    except Exception as e:
        return {'error': str(e)}
    try:
        txt = base64.b64decode(raw)
        txt = AES.new(KEY, AES.MODE_CBC, IV).decrypt(txt)
        pad = txt[-1]
        if 1 <= pad <= 16: txt = txt[:-pad]
        return json.loads(txt)
    except Exception:
        try:
            return {'raw': raw[:200].decode('utf8', 'replace')}
        except Exception:
            return {'raw': str(raw[:100])}

def corta(d, n=300):
    s = json.dumps(d, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + '…'

term = sys.argv[1] if len(sys.argv) > 1 else 'runner'

print('== hot_search =='); print(corta(llama('/search/hot_search', 'channel_id=226')))
print('== recommend =='); print(corta(llama('/search/recommend', 'channel_id=226')))
for body in [
    f'search_key={term}&page=1&pageSize=10&channel_id=226',
    f'key={term}&page=1&channel_id=226',
    f'search_key={term}&page=1&type=1',
    f'wd={term}&page=1',
]:
    r = llama('/search/screen', body)
    res = r.get('result') if isinstance(r, dict) else None
    n = len(res) if isinstance(res, list) else (len(res.get('list', [])) if isinstance(res, dict) else 0)
    print(f'== screen [{body}] -> n={n}'); print(corta(r, 260))
