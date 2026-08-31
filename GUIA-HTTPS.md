# 🌐 Huddle con HTTPS y dominio propio (gratis)

## ¿Por qué?

Cuando compartes tu sala, el link se ve así:
```
http://158.101.12.34:3000/#ABC12
```
**WhatsApp no convierte eso en link** (no es un dominio, y no tiene HTTPS), así que
llega como texto plano y nadie puede tocarlo. Con un dominio y HTTPS queda así:
```
https://play-huddle.dynv6.net/#ABC12
```
→ llega como **link tocable con tarjetita de vista previa** 🎉

Bonus: con HTTPS el botón "Copiar invitación" copia con un solo toque (sin trucos),
y la pantalla completa funciona mejor en algunos navegadores.

---

## Paso 0 · Abre los puertos 80 y 443 en Oracle (1 minuto, obligatorio siempre)

En la consola de Oracle Cloud:

1. Menú ☰ → **Compute → Instances** → tu instancia
2. Abajo en **Detalles**, clic en el nombre de la **Subnet**
3. Clic en tu **Security List** (la de default)
4. **Add Ingress Rules** y agrega DOS reglas:
   - `0.0.0.0/0` · TCP · **80**
   - `0.0.0.0/0` · TCP · **443**

*(son los mismos pasos que seguiste para abrir el 3000 cuando instalaste)*

## Elige tu dominio (todas las opciones terminan igual)

| Opción | Ejemplo | Precio | Cuenta | ¿Cuál es su chiste? |
|---|---|---|---|---|
| 🅰️ **auto** (sslip.io) | `158-101-12-34.sslip.io` | gratis | no | Ya funciona solo, pero no es "bonita" |
| 🅱️ **dynv6** ⭐ gratis | `play-huddle.dynv6.net` | gratis | sí (mail) | Nombre a tu GUSTO, gratis, sin confirmaciones mensuales |
| 🅲 **comprar dominio** 🏆 | `play-huddle.xyz` | ~1-2 USD/año | sí | La URL es TUYA de verdad, la más profesional |
| 🅳 No-IP | `play-huddle.ddns.net` | gratis | sí (mail) | Similar a dynv6 pero te manda confirmación cada 30 días |

### 🅰️ Modo AUTO — sin cuentas (el que ya tienes en el script)

```bash
cd ~/HUDDLE && git pull
sudo bash deploy/oracle/https.sh auto
```

### 🅱️ dynv6 — nombre bonito GRATIS (recomendado)

1. Entra a **https://dynv6.com** → créate una cuenta (solo pide correo)
2. **New Domain** → escribe `play-huddle` y elige `dynv6.net`
3. En la pestaña **IPv4** pon la IP pública de tu servidor Oracle
   *(la ves en el servidor con: `curl ifconfig.me`)*
4. En el servidor:

```bash
sudo bash deploy/oracle/https.sh play-huddle.dynv6.net
```

### 🅲 Comprar el dominio — la más bonita de todas (~1-2 USD el primer año)

1. Entra a **https://porkbun.com** (o namecheap.com) y busca `play-huddle.xyz`
   *(los .xyz y .online cuestan ~1-2 USD el primer año; un .com ~10 USD/año)*
2. Cómpralo y en **DNS** agrega un registro **A**:
   - Nombre: `@`   →   Valor: la IP pública de tu servidor (`curl ifconfig.me`)
3. En el servidor:

```bash
sudo bash deploy/oracle/https.sh play-huddle.xyz
```

Ya no dependes de nadie: el dominio es tuyo y se renueva cada año.

### 🅳 No-IP / DuckDNS (otros gratuitos)

- No-IP: `play-huddle.ddns.net` en **https://no-ip.com** (confirma por correo cada 30 días)
- DuckDNS: `play-huddle.duckdns.org` en **https://duckdns.org** (si te abre; a veces
  hay que cambiar el DNS del WiFi a 1.1.1.1 o usar datos móviles)

## Después de instalar

- Entra **desde el nuevo dominio** (`https://...`) y comparte las salas desde ahí
- El puerto 3000 viejo sigue funcionando por si acaso; cuando confirmes
  que el dominio te gusta, puedes cerrar el 3000 en la Security List
- El certificado HTTPS se renueva solo (Caddy)
- Si tu IP cambia: en auto/dynv6 actualízala y listo; con dominio comprado,
  actualiza el registro A

## Si algo falla

```bash
# ver el log de Caddy
journalctl -u caddy --no-pager | tail -30

# probar a mano
curl -v https://TU-DOMINIO/api/health
```

Lo más común: olvidar abrir 80/443 en la **Security List de Oracle** (paso 0).
