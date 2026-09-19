#!/bin/bash
# Cazador de la llave Wangsu del CDN Movie (v217).
#   uso:  bash scripts/buscar-llave-cdn.sh ~/captura-nueva.pcap
# Saca de la propia captura las ternas reales (ruta + wsSecret + wsTime), junta
# candidatos del tráfico del teléfono y valida. Si acierta, deja la llave en
# ~/movie-cdn-key.txt y Huddle la usa sola (server.js la relee cada 30 s).
# Nada de esto se sube a GitHub: la captura y la llave viven solo en Oracle.
set -u
PCAP="${1:-}"
if [ -z "$PCAP" ]; then
  for c in "$HOME/captura-nueva.pcap" /home/ubuntu/captura-nueva.pcap /root/captura-nueva.pcap; do
    [ -f "$c" ] && PCAP="$c" && break
  done
fi
[ -n "$PCAP" ] || PCAP="$HOME/captura-nueva.pcap"
OUT="${MOVIE_CDN_KEY:-/home/ubuntu/movie-cdn-key.txt}"
AQUI="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$PCAP" ]; then
  echo "NO EXISTE $PCAP"
  echo "Revisa la subida: abre http://129.80.212.92:3000/api/subir-captura desde el teléfono,"
  echo "o mira el estado con:  curl -s http://127.0.0.1:3000/api/captura-estado"
  exit 1
fi

TAM=$(stat -c %s "$PCAP" 2>/dev/null || echo 0)
echo "captura: $PCAP  ($((TAM / 1048576)) MB)"
if [ "$TAM" -lt 100000 ]; then
  echo "AVISO: el archivo pesa muy poco ($TAM bytes) — probablemente la subida quedó a medias."
fi

python3 "$AQUI/buscar-llave-cdn.py" "$PCAP" "$OUT"
