#!/bin/bash
# busca la llave Wangsu (resource_md5_prefix) dentro de la captura del teléfono
# y, si la encuentra, la deja en ~/movie-cdn-key.txt para que server.js firme al vuelo.
set -u
PCAP="${1:-$HOME/captura-sign.pcap}"
OUT="${MOVIE_CDN_KEY:-/home/ubuntu/movie-cdn-key.txt}"
[ -f "$PCAP" ] || { echo "NO EXISTE $PCAP"; exit 1; }
command -v tshark >/dev/null || { echo "falta tshark"; exit 1; }
tshark -r "$PCAP" -Y 'ip.addr==47.253.51.203' -w /tmp/tracker.pcap 2>/dev/null
SRC=/tmp/tracker.pcap
[ -s "$SRC" ] || SRC="$PCAP"
python3 - "$SRC" "$OUT" <<'PYEOF'
import sys, re, hashlib, subprocess
src, out = sys.argv[1], sys.argv[2]
TRIAS = [('/vod/1/2026-09-18/1a2be57006bb/index5.m3u8', '6aae4ba8', '9144b8696261d6fc907ff5930e61749b'),
         ('/vod/1/2026-09-18/1a2be57006bb/0000.ts', '6aae4ba8', '9d826a9e8405c018a30d0bd594ee39eb')]
def md5(s): return hashlib.md5(s.encode()).hexdigest()
def valida(k):
    for path, wt, real in TRIAS:
        if md5(k + path + wt) != real and md5(k + path[1:] + wt) != real:
            return False
    return True
cands = set()
raw = subprocess.run(['strings', '-n', '6', src], capture_output=True).stdout.decode('latin1')
for m in re.finditer(r'resource_md5_prefix[=\s:^]+([^\s\x00-\x1f]{4,64})', raw):
    cands.add(m.group(1))
for m in re.finditer(r'\b[0-9a-f]{16,64}\b', raw):
    cands.add(m.group(0))
for m in re.finditer(r'[\x20-\x7e]{8,40}', raw):
    s = m.group(0).strip()
    if re.fullmatch(r'[A-Za-z0-9_\-]{8,40}', s): cands.add(s)
print('candidatos:', len(cands))
hit = None
for k in sorted(cands, key=len):
    if valida(k): hit = k; break
if not hit:
    # tambien con el PCAP completo por si el prefix vino por otra via
    raw2 = subprocess.run(['strings', '-n', '8', sys.argv[1]], capture_output=True).stdout.decode('latin1')
    for m in re.finditer(r'resource_md5_prefix[=\s:^]+([^\s\x00-\x1f]{4,64})', raw2):
        if valida(m.group(1)): hit = m.group(1); break
if hit:
    open(out, 'w').write(hit + '\n')
    print('LLAVE ENCONTRADA Y GUARDADA en', out, '->', hit)
else:
    print('sin llave en esta captura')
PYEOF
