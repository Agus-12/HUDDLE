#!/usr/bin/env bash
# =============================================================
#  Huddle — Instalador para Oracle Cloud (Ubuntu 24.04 ARM64)
#  Instala TODO en una sola pasada: Chrome, Node, audio, pantalla
#  virtual, cortafuegos y servicios que se auto-reinician.
#
#  Uso (después de clonar tu repo):
#     cd raveroom && sudo bash deploy/oracle/setup-oracle.sh
# =============================================================
set -e

# ---- dónde está el proyecto -------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ ! -f "$REPO_DIR/server.js" ]; then
  echo "ERROR: no encuentro server.js junto a este script." >&2
  exit 1
fi

# ---- usuario y carpeta final de la app ---------------------------------
APP_USER="${SUDO_USER:-ubuntu}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
APP_DIR="$APP_HOME/huddle"

echo "==> Usuario de la app: $APP_USER"
echo "==> Carpeta destino:   $APP_DIR"

# El código debe vivir en ~/raveroom (así lo esperan los servicios)
if [ "$REPO_DIR" != "$APP_DIR" ]; then
  echo "==> Copiando el proyecto a $APP_DIR ..."
  rm -rf "$APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  cp -a "$REPO_DIR" "$APP_DIR"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ---- 1) paquetes del sistema -------------------------------------------
echo "==> Instalando paquetes del sistema (2-3 min) ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# nombres de librerías cambian entre versiones de Ubuntu (sufijo t64)
for p in git curl xvfb pulseaudio pulseaudio-utils fonts-liberation \
         fonts-dejavu-core libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
         libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
         libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64; do
  apt-get install -y -qq "$p" 2>/dev/null || apt-get install -y -qq "${p%t64}" 2>/dev/null || true
done

# ---- 2) Node.js 22 (ARM64) --------------------------------------------
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  echo "==> Instalando Node.js 22 ..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y -qq nodejs \
    || { echo "   (NodeSource falló, usando el de Ubuntu)"; apt-get install -y -qq nodejs npm; }
fi
echo "    Node $(node -v) OK"

# ---- 3) abrir el puerto 3000 en el cortafuegos local -------------------
# (las imágenes de Oracle traen reglas restrictivas dentro de la máquina)
echo "==> Abriendo puerto 3000 en el cortafuegos ..."
iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
if ! command -v netfilter-persistent >/dev/null; then
  apt-get install -y -qq iptables-persistent || true
fi
netfilter-persistent save 2>/dev/null || iptables-save >/etc/iptables/rules.v4 2>/dev/null || true

# ---- 4) dependencias de node + Chrome ----------------------------------
echo "==> Instalando dependencias y Chrome (3-5 min, descarga ~160 MB) ..."
cd "$APP_DIR"
sudo -u "$APP_USER" env HOME="$APP_HOME" npm install --no-audit --no-fund
# Chrome con binario ARM REAL: la versión que pinnea puppeteer (148) no trae
# build ARM y descarga un binario x86 que no arranca en Oracle ARM (verificado).
# 154.0.8034.0 sí trae chrome-linux-arm64 de verdad.
CHROME_ARM_VER=154.0.8034.0
# IMPORTANTE: el instalador incluido en puppeteer 24 descarga un binario x86
# aunque le pidas ARM (verificado). El @puppeteer/browsers nuevo sí baja el
# chrome-linux-arm64 real. Instalamos con --path fijo y leemos la ruta exacta.
CHROME_OUT="$(sudo -u "$APP_USER" env HOME="$APP_HOME" npx --yes @puppeteer/browsers@latest install "chrome@$CHROME_ARM_VER" --path "$APP_HOME/.cache/puppeteer" 2>/dev/null | tail -n1)"
CHROME_BIN="$(echo "$CHROME_OUT" | awk '{print $2}')"
if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then
  echo "    Chrome ARM (${CHROME_ARM_VER}) en: $CHROME_BIN"
else
  echo "    AVISO: Chrome ARM no quedó instalado (salida: $CHROME_OUT)"
  echo "           El espejo podría fallar — avísanos"
fi

# ---- 5) servicios del sistema (auto-arranque y auto-reinicio) -----------
echo "==> Instalando servicios del sistema ..."
for unit in xvfb pulse huddle; do
  sed -e "s|__APP_USER__|$APP_USER|g" -e "s|__APP_HOME__|$APP_HOME|g" \
      -e "s|__CHROME_BIN__|${CHROME_BIN:-}|g" \
      "$APP_DIR/deploy/oracle/$unit.service" > "/etc/systemd/system/$unit.service"
done
# si no se encontró Chrome, quitar la línea CHROME_PATH vacía
sed -i '\|^Environment=CHROME_PATH=$|d' /etc/systemd/system/huddle.service
systemctl daemon-reload

systemctl enable --now xvfb.service pulse.service
echo "==> Esperando pantalla virtual y audio ..."
for i in $(seq 1 15); do
  [ -e /tmp/.X11-unix/X99 ] && [ -e /tmp/pulse-native ] && break
  sleep 1
done
[ -e /tmp/.X11-unix/X99 ]  && echo "    Pantalla virtual OK" || echo "    AVISO: pantalla virtual no inició (ver: journalctl -u xvfb)"
[ -e /tmp/pulse-native ]   && echo "    Audio virtual OK"    || echo "    AVISO: audio virtual no inició (ver: journalctl -u pulse)"

systemctl enable --now huddle.service
echo "==> Arrancando Huddle ..."
OK=""
for i in $(seq 1 20); do
  sleep 1
  curl -sf -m 2 http://localhost:3000/ >/dev/null && OK=1 && break
done

IP="$(curl -sf -m 5 https://api.ipify.org || curl -sf -m 5 http://ifconfig.me || echo TU-IP)"

echo ""
if [ -n "$OK" ]; then
  echo "=============================================================="
  echo "  LISTO. Tu app está corriendo en:"
  echo ""
  echo "     http://$IP:3000"
  echo ""
  echo "  * Se reinicia sola si algo falla o al reiniciar la máquina."
  echo "  * Espejos simultáneos configurados: 8"
  echo "  * Si no abre desde fuera, revisa la regla del puerto 3000"
  echo "    en la lista de seguridad de Oracle (ver GUIA-ORACLE.md)."
  echo "=============================================================="
else
  echo "=============================================================="
  echo "  La app no respondió. Ejecuta esto y pásame el resultado:"
  echo ""
  echo "     sudo journalctl -u huddle -n 50 --no-pager"
  echo "     systemctl status xvfb pulse --no-pager"
  echo "=============================================================="
  journalctl -u huddle -n 20 --no-pager || true
  exit 1
fi
