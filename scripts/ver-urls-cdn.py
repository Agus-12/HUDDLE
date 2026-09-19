#!/usr/bin/env python3
"""v223: mira QUE URLs pidio el telefono en una captura (pcap de PCAPdroid).
No busca llaves: busca las peticiones (ruta + parametros) al CDN, para ver
si el reproductor firma o no, y con que nombres de parametro.
Uso:  python3 scripts/ver-urls-cdn.py <captura.pcap>"""
import sys, re, collections

def leer(p):
    d = open(p, 'rb').read()
    print(f"archivo: {p} ({len(d)} bytes)")
    return d

def main():
    if len(sys.argv) < 2:
        print(__doc__); return
    d = leer(sys.argv[1])
    # peticiones HTTP en texto plano (el CDN va por http)
    pide = re.findall(rb'(?:GET|POST|HEAD) ([!-~]{3,600}?) HTTP/1\.[01]', d)
    hosts = re.findall(rb'Host: ([A-Za-z0-9\.\-:]{3,80})', d)
    print(f"peticiones encontradas: {len(pide)} | cabeceras Host: {len(hosts)}")
    ch = collections.Counter(h.decode('latin1').lower() for h in hosts)
    print("hosts:", ch.most_common(8))
    urls = collections.Counter(u.decode('latin1') for u in pide)
    conq = [u for u in urls if '?' in u]
    print(f"URLs distintas: {len(urls)} | con parametros ('?'): {len(conq)}")
    if conq:
        params = collections.Counter()
        for u in conq:
            q = u.split('?', 1)[1]
            for kv in q.split('&'):
                params[kv.split('=')[0]] += 1
        print("NOMBRES DE PARAMETRO:", params.most_common(20))
        print("--- 40 URLs con parametros (recortadas) ---")
        for u in conq[:40]:
            print('   ', u[:200])
    else:
        print("ninguna URL con '?': el telefono pidio todo SIN firma visible")
    sospechosas = [u for u in urls if re.search(r'(?i)(secret|wstime|wssecret|auth|token|sign|expire|e=|key)', u)]
    if sospechosas:
        print(f"--- {len(sospechosas)} URLs que parecen firmadas ---")
        for u in sospechosas[:25]: print('   ', u[:220])
    print("--- 30 URLs mas pedidas (sin recortar el inicio) ---")
    for u, n in urls.most_common(30):
        print(f"   {n:5d}x {u[:160]}")
    seg = collections.Counter(re.sub(r'\?.*$', '?<firma>', u) for u in urls if re.search(r'(?i)\.ts$|\?.*', u))
    print("--- rutas de pedacitos (.ts) ---")
    for u, n in seg.most_common(15): print(f"   {n:5d}x {u[:160]}")

main()
