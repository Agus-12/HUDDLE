#!/usr/bin/env bash
# Caza la llave Wangsu del CDN Movie. v228.9: añade extractor mejorado (llaves
# derivadas + fórmulas alternas + barrido 16/32 bytes). No pide nada al usuario.
set -u
CAPTURA="${1:-}"
[ -z "$CAPTURA" ] && CAPTURA=$(ls -t /home/ubuntu/captura*.pcap /home/ubuntu/*.pcap 2>/dev/null | head -1)
[ -z "$CAPTURA" ] && { echo "no hay .pcap en /home/ubuntu"; exit 1; }
echo "captura: $CAPTURA  ($(du -h "$CAPTURA" | cut -f1))"
echo
echo "== 1) extractor MEJORADO (llaves derivadas + formulas alternas + 16/32 bytes) =="
python3 "$(dirname "$0")/cazar-llave-mejorado.py" "$CAPTURA" /home/ubuntu/movie-cdn-key.txt
if [ -s /home/ubuntu/movie-cdn-key.txt ]; then
  echo; echo "=== ¡LLAVE GUARDADA en /home/ubuntu/movie-cdn-key.txt! ==="
  echo "El server la relee solo en 30 s. Catálogo completo en HTTP real."
  exit 0
fi
echo
echo "== 2) respaldo: extractor ORIGINAL (texto legible + 16 bytes) =="
python3 "$(dirname "$0")/buscar-llave-cdn.py" "$CAPTURA" 2>/dev/null | tail -25
python3 "$(dirname "$0")/cazar-llave-bytes.py" "$CAPTURA" /home/ubuntu/movie-cdn-key.txt 2>/dev/null | tail -8
if [ -s /home/ubuntu/movie-cdn-key.txt ]; then
  echo; echo "=== ¡LLAVE ENCONTRADA (respaldo)! ==="; exit 0
fi
echo; echo "== sin llave en esta captura (todas las vías agotadas) =="
