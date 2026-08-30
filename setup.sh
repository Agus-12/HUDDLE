#!/usr/bin/env bash
# Configura el entorno de Huddle (dependencias del sistema para el espejo con audio).
# Uso: bash setup.sh
set -e

echo "📦 Instalando dependencias (Chrome ya viene con puppeteer via npm)…"
sudo apt-get update -qq || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxdamage1 \
  libxkbcommon0 libasound2t64 libatspi2.0-0 \
  pulseaudio pulseaudio-utils xvfb strace

echo "🎧 Iniciando PulseAudio con sink virtual…"
pkill -9 pulseaudio 2>/dev/null || true
mkdir -p /tmp/.X11-unix && sudo chmod 1777 /tmp/.X11-unix 2>/dev/null || true
# truco clave: romper DBUS para que el demonio no se cuelgue en contenedores
nohup env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/noexistente \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/noexistente \
  pulseaudio -n -F "$(dirname "$0")/pulse.conf" \
  --exit-idle-time=-1 --daemonize=no --log-target=stderr --log-level=1 \
  > /tmp/raveroom-pulse.log 2>&1 &
sleep 1
PULSE_SERVER=unix:/tmp/pulse-native pactl info > /dev/null && echo "   sink virtual OK ✅"

echo "🖥️  Iniciando Xvfb (monitor virtual :99)…"
pkill -9 Xvfb 2>/dev/null || true
nohup Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > /tmp/raveroom-xvfb.log 2>&1 &
sleep 1
[ -e /tmp/.X11-unix/X99 ] && echo "   Xvfb OK ✅"

echo "🔩 Dependencias de node…"
cd "$(dirname "$0")"
npm install --no-audit --no-fund

echo ""
echo "✅ Listo. Arranca la app con:  node server.js"
echo "   (el espejo tendrá audio solo si PulseAudio y Xvfb están corriendo)"
