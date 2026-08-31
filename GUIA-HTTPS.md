# 🌐 Huddle con HTTPS y dominio propio (gratis)

## ¿Por qué?

Cuando compartes tu sala, el link se ve así:
```
http://158.101.12.34:3000/#ABC12
```
**WhatsApp no convierte eso en link** (no es un dominio, y no tiene HTTPS), así que
llega como texto plano y nadie puede tocarlo. Con un dominio y HTTPS queda así:
```
https://158-101-12-34.sslip.io/#ABC12
```
→ llega como **link tocable con tarjetita de vista previa** 🎉

Bonus: con HTTPS el botón "Copiar invitación" copia con un solo toque (sin trucos),
y la pantalla completa funciona mejor en algunos navegadores.

---

## Paso 1 · Abre los puertos 80 y 443 en Oracle (1 minuto)

En la consola de Oracle Cloud:

1. Menú ☰ → **Compute → Instances** → tu instancia
2. Abajo en **Detalles**, clic en el nombre de la **Subnet**
3. Clic en tu **Security List** (la de default)
4. **Add Ingress Rules** y agrega DOS reglas:
   - `0.0.0.0/0` · TCP · **80**
   - `0.0.0.0/0` · TCP · **443**

*(son los mismos pasos que seguiste para abrir el 3000 cuando instalaste)*

## Paso 2 · Elige tu modo

### 🅰️ Modo AUTO — sin cuentas, sin páginas externas (recomendado)

```bash
cd ~/HUDDLE && git pull
sudo bash deploy/oracle/https.sh auto
```

Detecta tu IP y arma el dominio solo: `https://158-101-12-34.sslip.io`
(sslip.io es un DNS público que convierte IPs en dominios — gratis, sin registro).

- Si sslip.io está saturado, el script intenta automáticamente con `nip.io` (equivalente)
- ¿Cambió tu IP? Corre el script de nuevo y listo

### 🅱️ Modo DUCKDNS — nombre más bonito (si el auto no te convence)

1. Entra a **https://duckdns.org** e inicia sesión con Google o GitHub
   - *(si no abre: prueba con datos móviles en vez de WiFi, o cambia tu DNS a 1.1.1.1 — el sitio suele estar arriba)*
2. Crea un subdominio, por ejemplo `mi-huddle`
3. Copia tu **token** y corre:

```bash
sudo bash deploy/oracle/https.sh mi-huddle.duckdns.org TU_TOKEN
```

## Después de instalar

- Entra **desde el nuevo dominio** (`https://...`) y comparte las salas desde ahí
- El puerto 3000 viejo sigue funcionando por si acaso; cuando confirmes
  que el dominio te gusta, puedes cerrar el 3000 en la Security List
- El certificado HTTPS se renueva solo (Caddy)
- ¿Se te olvidó la IP? No importa: el dominio siempre apunta a tu servidor

## Si algo falla

```bash
# ver el log de Caddy
journalctl -u caddy --no-pager | tail -30

# probar a mano
curl -v https://TU-DOMINIO/api/health
```

Lo más común: olvidar abrir 80/443 en la **Security List de Oracle** (paso 1).
