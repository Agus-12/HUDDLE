#!/usr/bin/env python3
"""v224: analiza capturas de PCAPdroid buscando TODO lo que puede haber quedado
escondido: nombres de servidores TLS (SNI), Host de HTTP, URLs con key/sign/token,
listas m3u8 en texto plano (EXT-X-KEY) y firmas repetidas con distinto resultado.

Uso:  python3 scripts/analizar-capturas.py ~/captura-movie.pcap [mas capturas...]
Lee por trozos (aguanta archivos de 600+ MB) y NO imprime secretos completos.
"""
import sys, os, re, collections, json

TLDS = (b'com', b'net', b'org', b'cn', b'xyz', b'top', b'vip', b'cc', b'io', b'me', b'tv',
        b'app', b'live', b'shop', b'site', b'club', b'online', b'es', b'us', b'mx', b'co',
        b'id', b'th', b'ph', b'fr', b'pt', b'ru', b'info', b'biz', b'store', b'fun')
RE_DOM = re.compile(rb'([a-z0-9][a-z0-9\-\.]{3,60}\.(?:' + b'|'.join(TLDS) + rb'))')
RE_HOST = re.compile(rb'Host: ([A-Za-z0-9\.\-:]{3,80})')
RE_URL = re.compile(rb'(?:GET|POST) ([!-~]{3,300}?) HTTP/1\.[01]')
RE_M3U8 = re.compile(rb'#EXTM3U')
RE_KEY = re.compile(rb'#EXT-X-KEY[^\r\n]{0,200}')
RE_URLSOS = re.compile(rb'[!-~]{0,120}(?:getts|wsSecret|auth_key|Signature=|Key-Pair-Id|token=|sign=|/key)[!-~]{0,40}')
RE_FIRMA = re.compile(rb'/vod/[0-9A-Za-z/._\-]{6,140}\?(?:wsSecret=[0-9a-fA-F]{32}&wsTime=[0-9a-fA-F]{6,10}|wsTime=[0-9a-fA-F]{6,10}&wsSecret=[0-9a-fA-F]{32})')

def tapar(t):
    """Oculta el valor de los pases para que no queden escritos en el chat."""
    if isinstance(t, bytes): t = t.decode('latin1', 'replace')
    return re.sub(r'(wsSecret=|Signature=|auth_key=|token=|sign=)([0-9a-fA-F]{6})[0-9a-fA-F]+', r'\1\2...', t)

def sni_valido(d, i, largo):
    """El nombre va precedido de la longitud (2 bytes) y un 0x00 (tipo de nombre)."""
    if i < 3: return False
    return int.from_bytes(d[i-2:i], 'big') == largo and d[i-3] == 0

def analizar(ruta):
    print("=" * 72)
    print("CAPTURA:", ruta, f"({os.path.getsize(ruta):,} bytes)")
    sni = collections.Counter(); hosts = collections.Counter()
    rutas = collections.Counter(); sospechosas = collections.Counter()
    listas = 0; claves_hls = collections.Counter(); firmas = {}
    repes = collections.Counter(); resto = b''
    with open(ruta, 'rb') as f:
        while True:
            b = f.read(16 * 1024 * 1024)
            if not b: break
            d = resto + b
            resto = d[-600:]
            for m in RE_DOM.finditer(d):
                nombre = m.group(1)
                if sni_valido(d, m.start(), len(nombre)):
                    sni[nombre.decode('latin1', 'replace')] += 1
            for m in RE_HOST.finditer(d):
                hosts[m.group(1).decode('latin1', 'replace').lower()] += 1
            for m in RE_URL.finditer(d):
                rutas[m.group(1).decode('latin1', 'replace')] += 1
            for m in RE_URLSOS.finditer(d):
                sospechosas[m.group(0).decode('latin1', 'replace')] += 1
            listas += len(RE_M3U8.findall(d))
            for m in RE_KEY.findall(d):
                claves_hls[m.decode('latin1', 'replace')[:180]] += 1
            for m in RE_FIRMA.finditer(d):
                u = m.group(0).decode('latin1')
                base, _, q = u.partition('?')
                sec = re.search(r'wsSecret=([0-9a-fA-F]{32})', q).group(1).lower()
                t = re.search(r'wsTime=([0-9a-fA-F]+)', q).group(1).lower()
                if base in firmas and firmas[base] != (t, sec):
                    repes[f"{base}  (tiempo {firmas[base][0]} vs {t})"] += 1
                firmas[base] = (t, sec)

    print("\n  --- SERVIDORES TLS que pidio el telefono (SNI) ---")
    for h, n in sni.most_common(25):
        print(f"     {n:6d}  {h}")
    if not sni:
        print("     (ninguno: puede que el descifrado TLS los tape)")
    print("\n  --- Host de HTTP ---")
    for h, n in hosts.most_common(15):
        print(f"     {n:6d}  {h}")
    print("\n  --- rutas HTTP mas pedidas (pases ocultos) ---")
    for u, n in rutas.most_common(15):
        print(f"     {n:6d}  {tapar(u)[:110]}")
    print("\n  --- lineas con getts / wsSecret / auth_key / Signature / token / sign / key ---")
    if sospechosas:
        for u, n in sospechosas.most_common(20):
            print(f"     {n:6d}  {tapar(u)[:130]}")
    else:
        print("     (ninguna)")
    print(f"\n  --- listas m3u8 en texto plano: {listas} ---")
    for k, n in claves_hls.most_common(10):
        print(f"     {n:4d}x  {k}")
    print("\n  --- verificaciones con las firmas ---")
    print(f"     archivos firmados distintos: {len(firmas)}")
    secretos = set(v[1] for v in firmas.values())
    print(f"     pases distintos: {len(secretos)}  (si hay menos que archivos, la firma no depende del archivo)")
    if repes:
        print(f"     OJO: {sum(repes.values())} casos del MISMO archivo firmado distinto (la firma cambia por peticion)")
        for k, n in repes.most_common(5): print(f"        {n}x {k[:110]}")
    else:
        print("     (cada archivo siempre con la misma firma)")

for r in sys.argv[1:]:
    if os.path.exists(r):
        analizar(r)
    else:
        print("(no existe:", r, ")")
