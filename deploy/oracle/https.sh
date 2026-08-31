#!/usr/bin/env bash
# ============================================================
#  Huddle · HTTPS automático (para que WhatsApp reconozca los links)
#
#  MODO FÁCIL (recomendado — sin cuentas ni páginas externas):
#    sudo bash deploy/oracle/https.sh auto
#    → usa <TU-IP>.sslip.io: un DNS público que convierte tu IP en
#      dominio gratis, sin registrarte en nada. Ej. si tu IP es
#      158.101.12.34 tu Huddle queda en:
#          https://158-101-12-34.sslip.io
#
#  MODO DUCKDNS (si quieres un nombre más bonito):
#    sudo bash deploy/oracle/https.sh mi-huddle.duckdns.org TU_TOKEN
#
#  (sin argumentos: te pregunta)
#
#  Qué hace:
#    1. Detecta tu IP pública y arma el dominio (modo auto)
#    2. Instala Caddy (certificado HTTPS gratis y automático)
#    3. Publica Huddle en https://TU-DOMINIO (puertos 80/443)
#    4. Abre el firewall local (iptables)
#
#  IMPORTANTE: en Oracle Cloud también abre los puertos 80 y 443 en:
#    Consola → Instancia → Subnet → Security List → Add Ingress Rule
#    (0.0.0.0/0 · TCP · 80   y   0.0.0.0/0 · TCP · 443)
# ============================================================
set -euo pipefail

MODE="${1:-}"
DOMAIN=""
TOKEN=""
APP_PORT="${APP_PORT:-3000}"

if [ "$(id -u)" -ne 0 ]; then echo "✋ Corre con sudo: sudo bash $0 [auto | dominio token]"; exit 1; fi

# ---------- detectar IP pública ----------
detect_ip() {
  curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null \
    || curl -fsS --max-time 8 https://checkip.amazonaws.com 2>/dev/null \
    || echo ""
}

# ---------- flujo interactivo si no hubo argumentos ----------
if [ -z "$MODE" ]; then
  echo "═══════════════════════════════════════════════════"
  echo "  Huddle · HTTPS"
  echo "═══════════════════════════════════════════════════"
  echo "  1) auto  — dominio automático con tu IP, SIN cuentas"
  echo "             (queda https://TU-IP.sslip.io)"
  echo "  2) duckdns — nombre a tu gusto (ej. mi-huddle.duckdns.org)"
  echo "             (necesita cuenta gratis en duckdns.org)"
  echo
  read -rp "   ¿Cuál usamos? (1/2): " SEL
  if [ "$SEL" = "2" ]; then MODE="duckdns"; else MODE="auto"; fi
fi

if [ "$MODE" = "auto" ]; then
  IP="$(detect_ip)"
  if [ -z "$IP" ]; then echo "✗ No pude detectar tu IP pública (¿hay internet?)"; exit 1; fi
  DOMAIN="${IP//./-}.sslip.io"        # 158.101.12.34 → 158-101-12-34.sslip.io
  echo "› IP pública detectada: $IP"
  echo "› Dominio automático:   $DOMAIN"
elif [ "$MODE" = "duckdns" ]; then
  DOMAIN="${2:-}"; TOKEN="${3:-}"
  if [ -z "$DOMAIN" ] || [ -z "$TOKEN" ]; then
    echo "1) Entra a https://duckdns.org (si no abre: prueba con datos"
    echo "   móviles, o cambia tu DNS a 1.1.1.1 — el sitio suele estar arriba)"
    echo "2) Crea un subdominio (ej. mi-huddle) — gratis"
    echo "3) Copia tu token (arriba a la izquierda)"
    read -rp "   Subdominio completo (ej. mi-huddle.duckdns.org): " DOMAIN
    read -rp "   Token de duckdns.org: " TOKEN
  fi
  echo "› Apuntando $DOMAIN a esta máquina…"
  curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN%%.*}&token=$TOKEN&ip=" >/dev/null \
    && echo "  ✓ DuckDNS actualizado" || { echo "  ✗ No pude actualizar DuckDNS (revisa dominio/token)"; exit 1; }
else
  # permitir dominio directo: https.sh midominio.com [token]
  DOMAIN="$MODE"; TOKEN="${2:-}"
  if [ -n "$TOKEN" ]; then
    curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN%%.*}&token=$TOKEN&ip=" >/dev/null || true
  fi
fi

echo "═══════════════════════════════════════════════════"

# ---------- instalar Caddy ----------
if ! command -v caddy >/dev/null 2>&1; then
  echo "› Instalando Caddy (servidor HTTPS automático)…"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "  ✓ Caddy $(caddy version | cut -d' ' -f1)"

# ---------- proxy inverso (flush -1 = sin búfer, REQUIRED para SSE/streaming) ----------
write_caddy() {
  cat > /etc/caddy/Caddyfile <<EOF
$1 {
        reverse_proxy localhost:$APP_PORT {
                flush_interval -1
        }
}
EOF
  systemctl restart caddy
}

# ---------- firewall local ----------
echo "› Abriendo puertos 80 y 443 en el firewall local…"
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
netfilter-persistent save >/dev/null 2>&1 || iptables-save >/etc/iptables/rules.v4 2>/dev/null || true

# ---------- certificado y verificación ----------
wait_https() {
  for i in 1 2 3 4 5 6; do
    sleep 5
    if curl -fsS "https://$1/api/health" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

echo "› Configurando $DOMAIN → localhost:$APP_PORT (pidiendo certificado…)…"
write_caddy "$DOMAIN"
if ! wait_https "$DOMAIN" && [ "$MODE" = "auto" ]; then
  # sslip.io a veces está saturado con Let's Encrypt → probar nip.io (equivalente)
  ALT="${DOMAIN%.sslip.io}.nip.io"
  echo "› sslip.io no entregó certificado — probando con nip.io…"
  DOMAIN="$ALT"
  write_caddy "$DOMAIN"
  wait_https "$DOMAIN" || true
fi

echo
echo "═══════════════════════════════════════════════════"
if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  echo "  ✅ ¡LISTO! Tu Huddle ya vive en:"
  echo
  echo "     https://$DOMAIN"
  echo
  echo "  Comparte salas desde ahí y WhatsApp las mandará"
  echo "  como link con vista previa 🎉"
else
  echo "  ⚠️  Aún no responde https://$DOMAIN — revisa:"
  echo "     1. ¿Abriste 80 y 443 en la Security List de Oracle?"
  echo "        (Consola → tu instancia → Subnet → Security List → Ingress)"
  echo "     2. Log de Caddy: journalctl -u caddy --no-pager | tail -20"
  echo "     3. Espera 1-2 min y reintenta: curl https://$DOMAIN/api/health"
fi
echo "═══════════════════════════════════════════════════"
