#!/usr/bin/env bash
# v223.8: mina capturas de PCAPdroid EN ORACLE.
#  - saca TODAS las URLs firmadas (wsSecret/wsTime) y las guarda en ~/muestras-wssecret.json
#  - cuenta también los rastros del servidor interno del reproductor (127.0.0.1, control, m3u8_key)
#  - imprime solo resúmenes (los secretos NO se imprimen completos)
# Uso:  bash scripts/minar-capturas.sh ~/captura-movie.pcap ~/captura-sign.pcap ...
set -u
if [ $# -eq 0 ]; then
  echo "Uso: bash scripts/minar-capturas.sh <captura.pcap> [mas capturas...]"; exit 1
fi
python3 - "$@" <<'PY'
import sys, re, json, os, collections

PAT_FIRMA = re.compile(
    rb'(?:GET|POST) (/vod/[0-9A-Za-z/._\-]{6,140}\?'
    rb'(?:wsSecret=[0-9a-fA-F]{32}&wsTime=[0-9a-fA-F]{6,10}'
    rb'|wsTime=[0-9a-fA-F]{6,10}&wsSecret=[0-9a-fA-F]{32}))')
RASTROS = [b'127.0.0.1:', b'msg=verify', b'm3u8_key', b'resource.m3u8', b'/control', b'getts',
           b'auth_key=', b'Signature=', b'Key-Pair-Id']

def recorrer(ruta, patrones):
    """Lee por trozos: cuenta patrones fijos y junta las URLs firmadas."""
    cuenta = collections.Counter()
    urls = collections.Counter()
    resto = b''
    with open(ruta, 'rb') as f:
        while True:
            b = f.read(16 * 1024 * 1024)
            if not b:
                break
            d = resto + b
            for p in patrones:
                cuenta[p] += d.count(p)
            for m in PAT_FIRMA.finditer(d):
                urls[m.group(1).decode('latin1')] += 1
            resto = d[-300:]
    return cuenta, urls

muestras = []
print("=" * 70)
for ruta in sys.argv[1:]:
    if not os.path.exists(ruta):
        print(f"(no existe: {ruta})"); continue
    print(f"CAPTURA: {ruta}  ({os.path.getsize(ruta):,} bytes)")
    cuenta, urls = recorrer(ruta, RASTROS)
    print(f"  URLs firmadas distintas: {len(urls)}")
    carpetas = collections.Counter()
    for u in urls:
        carp = re.sub(r'/vod/1/(\d{4})/(\d{2})/(\d{2})/([0-9a-f]{12})/.*', r'\4', u)
        carpetas[carp] += 1
    for c, n in carpetas.most_common(6):
        print(f"     carpeta {c}: {n} archivos distintos")
    if urls:
        ejemplo = next(iter(urls))
        print(f"     ejemplo (recortado): {ejemplo[:60]}...")
    print("  rastros del reproductor interno:", {p.decode(): cuenta[p] for p in RASTROS if cuenta[p]})
    # guardar muestras para el probador offline
    for u in urls:
        m = re.match(r'(/vod/[^?]+)\?(?:wsSecret=([0-9a-fA-F]{32})&wsTime=([0-9a-fA-F]+)|wsTime=([0-9a-fA-F]+)&wsSecret=([0-9a-fA-F]{32}))', u)
        if m:
            ruta_vod = m.group(1)
            sec = (m.group(2) or m.group(5)).lower()
            t = (m.group(3) or m.group(4)).lower()
            muestras.append({"ruta": ruta_vod, "t": t, "s": sec})
    print("-" * 70)

salida = os.path.expanduser("~/muestras-wssecret.json")
json.dump(muestras, open(salida, "w"), indent=1)
print(f"muestras totales guardadas en {salida}: {len(muestras)}")
print("siguiente paso (en Oracle):")
print(f"  python3 auditorias/crack/probar_wssecret_multi.py {salida}")
PY
