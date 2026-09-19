#!/usr/bin/env python3
"""v223.4: pide public/init EN VIVO y muestra TODO el sys_conf (buscando llaves)."""
import sys, json
sys.path.insert(0, '/home/user/HUDDLE/auditorias/crack')
from info_new_vivo import pedir, aes_puro, DEV
j = aes_puro(pedir('/api/public/init', 'device_id=%s&channel_code=movievn_sh_1000' % DEV))
r = j.get('result') or {}
print('code:', j.get('code'))
print(json.dumps(r.get('sys_conf') or {}, ensure_ascii=False, indent=1)[:3000])
open('/tmp/sysconf.json', 'w').write(json.dumps(r, ensure_ascii=False, indent=1))
