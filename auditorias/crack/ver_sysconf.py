#!/usr/bin/env python3
"""v223.4: pide public/init EN VIVO y muestra TODO el sys_conf (buscando llaves)."""
import sys, time, json, hashlib, base64, urllib.request
sys.path.insert(0, '/home/user/HUDDLE/auditorias/crack')
from info_new_vivo import pedir, aes_puro, DEV

j = aes_puro(pedir('/api/public/init', 'device_id=%s&channel_code=movievn_sh_1000' % DEV))
r = j.get('result') or {}
print('code:', j.get('code'))
sc = r.get('sys_conf') or {}
print('--- sys_conf completo ---')
print(json.dumps(sc, ensure_ascii=False, indent=1)[:3000])
print('--- resto de result (claves de primer nivel) ---')
print(list(r.keys()))
for k in ('user_info','config','app_conf','conf'):
    if k in r: print(k, '=', json.dumps(r[k], ensure_ascii=False)[:600])
open('/tmp/sysconf.json','w').write(json.dumps(r, ensure_ascii=False, indent=1))
print('(guardado en /tmp/sysconf.json)')
