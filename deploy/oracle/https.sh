#!/usr/bin/env bash
# ============================================================
#  Huddle · HTTPS con dominio propio (para que WhatsApp
#  reconozca los links de invitación)
#
#  USO:
#    sudo bash deploy/oracle/https.sh mi-huddle.duckdns.org TOKEN_DUCKDNS
#
#  (o sin argumentos y te los pregunta)
#
#  Qué hace:
#    1. Apunta tu subdominio DuckDNS a esta máquina
#    2. Instala Caddy (certificado HTTPS gratis y automático)
#    3. Publica Huddle en https://TU-DOMINIO (puertos 80/443)
#    4. Abre el firewall (iptables) — el de Oracle lo abres tú (ver guía)
#
#  IMPORTANTE: en Oracle Cloud también abre los puertos 80 y 443 en:
#    Consola → Instancia → Detalles → Subnet → Security List → Add Ingress Rule
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
TOKEN="${2:-}"
APP_PORT="${APP_PORT:-3000}"

if [ "$(id -u)" -ne 0 ]; then echo "✋ Corre con sudo: sudo bash $0 dominio token"; exit 1; fi

if [ -z "$DOMAIN" ] || [ -z "$TOKEN" ]; then
  echo "═══════════════════════════════════════════════════"
  echo "  Huddle · HTTPS con dominio DuckDNS"
  echo "═══════════════════════════════════════════════════"
  echo "1) Entra a https://duckdns.org con tu cuenta (Google/GitHub)"
  echo "2) Crea un subdominio (ej. mi-huddle) — gratis"
  echo "3) Copia tu token (arriba a la izquierda)"
  echo
  read -rp "   Tu subdominio completo (ej. mi-huddle.duckdns.org): " DOMAIN
  read -rp "   Tu token de duckdns.org: " TOKEN
fi

echo "═══════════════════════════════════════════════════"

# 1) apuntar el dominio a esta máquina
echo "› Apuntando $DOMAIN a esta máquina…"
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN%%.*}&token=$TOKEN&ip=" >/dev/null \
  && echo "  ✓ DuckDNS actualizado" || { echo "  ✗ No pude actualizar DuckDNS (revisa dominio/token)"; exit 1; }

# 2) instalar Caddy
if ! command -v caddy >/dev/null 2>&1; then
  echo "› Instalando Caddy (servidor HTTPS automático)…"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "  ✓ Caddy $(caddy version | cut -d' ' -f1)"

# 3) configurar proxy inverso (flush -1 = sin búfer, REQUIRED para SSE/streaming)
echo "› Configurando $DOMAIN → localhost:$APP_PORT…"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
        reverse_proxy localhost:$APP_PORT {
                flush_interval -1
        }
}
EOF
systemctl restart caddy
systemctl enable caddy >/dev/null 2>&1 || true

# 4) firewall local (el de Oracle se abre desde la consola web)
echo "› Abriendo puertos 80 y 443 en el firewall local…"
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
netfilter-persistent save >/dev/null 2>&1 || iptables-save >/etc/iptables/rules.v4 2>/dev/null || true

# dar unos segundos al certificado
echo "› Esperando el certificado (10 s)…"
sleep 10

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
  echo "     2. Verifica: journalctl -u caddy --no-pager | tail -20"
fi
echo "═══════════════════════════════════════════════════"
