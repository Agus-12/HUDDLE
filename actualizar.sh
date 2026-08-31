#!/usr/bin/env bash
# =============================================================
#  Huddle — Actualizar la app en el servidor (Oracle)
#  Uso (conectado por SSH a tu servidor):
#     cd ~/huddle && bash actualizar.sh
# =============================================================
set -e
cd "$(dirname "$0")"
CLONE="$HOME/HUDDLE"

echo "==> Buscando la última versión en GitHub ..."
if [ -d .git ]; then
  # caso A: la app ES el clon de git
  git fetch origin
  git reset --hard "origin/$(git rev-parse --abbrev-ref HEAD)"
elif [ -d "$CLONE/.git" ]; then
  # caso B: la app es una copia — actualizar el clon y recopiar
  (cd "$CLONE" && git fetch origin && git reset --hard "origin/$(git rev-parse --abbrev-ref HEAD)")
  echo "==> Copiando la nueva versión ..."
  (cd "$CLONE" && tar --exclude=./node_modules --exclude=./.git -cf - .) | tar -xf -
else
  echo "ERROR: no encontré el repositorio git en $CLONE — avísanos" >&2
  exit 1
fi

echo "==> Instalando dependencias (si cambiaron) ..."
npm install --no-audit --no-fund --silent

echo "==> Reiniciando la app (3 segundos) ..."
sudo systemctl restart huddle

sleep 3
if curl -sf -m 3 http://localhost:3000/ >/dev/null; then
  IP="$(curl -sf -m 5 https://api.ipify.org || echo TU-IP)"
  echo ""
  echo "=============================================================="
  echo "  APP ACTUALIZADA Y CORRIENDO:  http://$IP:3000"
  echo "  Los usuarios conectados se recargarán solos."
  echo "=============================================================="
else
  echo ""
  echo "  La app no respondió. Pásame lo que salga de:"
  echo "     sudo journalctl -u huddle -n 30 --no-pager"
  exit 1
fi
