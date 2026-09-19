#!/usr/bin/env bash
# v225: descifra el HTTPS de una captura del telefono usando el archivo de llaves TLS
# (sslkeylogfile.txt) y muestra lo que el telefono REALMENTE pidio por HTTPS:
# rutas de la API, cuerpos enviados y rastros de llaves.
#
# Uso:  bash scripts/descifrar-https.sh ~/captura-sign.pcap [~/sslkeylogfile.txt]
#
# Nota: en capturas grandes (600+ MB) esto puede tardar varios minutos.
set -u
CAP="${1:?Uso: bash scripts/descifrar-https.sh <captura.pcap> [keylog]}"
KL="${2:-$HOME/sslkeylogfile.txt}"
if ! command -v tshark >/dev/null 2>&1; then
  echo "Falta tshark. Instalalo con:"
  echo "  sudo apt-get update && sudo apt-get install -y tshark"
  exit 1
fi
if [ ! -f "$KL" ]; then
  echo "No encuentro el archivo de llaves TLS: $KL"
  exit 1
fi

echo "########## $CAP  (llaves: $KL) ##########"
echo
echo "=== 1) PETICIONES HTTPS TIPO HTTP/1.1 (host, verbo, ruta) ==="
tshark -r "$CAP" -o tls.keylog_file:"$KL" -Y "http.request" \
       -T fields -e http.host -e http.request.method -e http.request.uri 2>/dev/null \
  | sort | uniq -c | sort -rn | head -40

echo
echo "=== 2) PETICIONES HTTPS TIPO HTTP/2 (host, verbo, ruta) ==="
tshark -r "$CAP" -o tls.keylog_file:"$KL" -Y "http2.headers.path" \
       -T fields -e http2.headers.authority -e http2.headers.method -e http2.headers.path 2>/dev/null \
  | sort | uniq -c | sort -rn | head -40

echo
echo "=== 3) LO QUE EL TELEFONO ENVIO (cuerpos de formularios) ==="
tshark -r "$CAP" -o tls.keylog_file:"$KL" -Y "http.request.method == \"POST\"" \
       -T fields -e http.host -e http.file_data 2>/dev/null | head -40 | cut -c1-400

echo
echo "=== 4) RASTROS DE LLAVES EN EL TRAFICO DESCIFRADO ==="
python3 - "$CAP" "$KL" <<'PY'
import subprocess, binascii, re, sys

cap, kl = sys.argv[1], sys.argv[2]
patrones = re.compile(rb"m3u8_key|wsSecret|wsTime|secret|password|license|/control|verify|"
                      rb"aes|chacha|app_secret|sign_key|private_key|bearer|authorization", re.I)

def flujo(campo, filtro):
    p = subprocess.Popen(["tshark", "-r", cap, "-o", f"tls.keylog_file:{kl}",
                          "-Y", filtro, "-T", "fields", "-e", campo],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    vistos = set()
    for linea in p.stdout:
        h = linea.strip().replace(":", "").replace(",", "")
        if len(h) < 8:
            continue
        try:
            b = binascii.unhexlify(h)
        except Exception:
            continue
        for m in patrones.finditer(b):
            trozo = b[max(0, m.start() - 60):m.start() + 90].decode("latin1", "replace")
            trozo = re.sub(r"([0-9a-zA-Z]{8})[0-9a-zA-Z]{12,}", r"\1...", trozo)
            if trozo in vistos:
                continue
            vistos.add(trozo)
            print("   ", trozo.replace("\r", " ").replace("\n", " ")[:180])
            if len(vistos) >= 30:
                p.kill(); return
    p.wait()

print("  -- cuerpos HTTP/1.1 --")
flujo("http.file_data", "http.file_data")
print("  -- cuerpos HTTP/2 --")
flujo("http2.data.data", "http2.data.data")
print("  (si no aparece nada arriba, el telefono no mando ninguna llave por HTTPS)")
PY

echo
echo "=== 5) PISTAS DE SERVIDORES QUE RESPONDIERON (por si hay uno de configuracion) ==="
tshark -r "$CAP" -o tls.keylog_file:"$KL" -Y "tls.handshake.type == 1" \
       -T fields -e ip.dst 2>/dev/null | sort | uniq -c | sort -rn | head -15

echo "########## fin ##########"
