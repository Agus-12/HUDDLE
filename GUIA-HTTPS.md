# 🌐 Huddle con HTTPS y dominio propio (2 minutos, gratis)

## ¿Por qué?

Cuando compartes tu sala, el link se ve así:
```
http://158.101.12.34:3000/#ABC12
```
**WhatsApp no convierte eso en link** (no es un dominio, y no tiene HTTPS), así que
llega como texto plano y nadie puede tocarlo. Con un dominio y HTTPS queda así:
```
https://mi-huddle.duckdns.org/#ABC12
```
→ llega como **link tocable con tarjetita de vista previa** 🎉

Bonus: con HTTPS el botón "Copiar invitación" copia con un solo toque (sin trucos),
y la pantalla completa funciona mejor en algunos navegadores.

---

## Paso 1 · Crea tu subdominio gratis (1 minuto)

1. Entra a **https://duckdns.org** e inicia sesión con Google o GitHub
2. En el recuadro crea un subdominio, por ejemplo `mi-huddle`
3. Copia tu **token** (cadena larga que aparece arriba a la izquierda)

## Paso 2 · Abre los puertos 80 y 443 en Oracle (1 minuto)

En la consola de Oracle Cloud:

1. Menú ☰ → **Compute → Instances** → tu instancia
2. Abajo en **Detalles**, clic en el nombre de la **Subnet**
3. Clic en tu **Security List** (la de default)
4. **Add Ingress Rules** y agrega DOS reglas:
   - `0.0.0.0/0` · TCP · **80**
   - `0.0.0.0/0` · TCP · **443**

*(son los mismos pasos que seguiste para abrir el 3000 cuando instalaste)*

## Paso 3 · Corre el script (1 minuto)

En tu servidor:

```bash
cd ~/HUDDLE && git pull
sudo bash deploy/oracle/https.sh mi-huddle.duckdns.org TU_TOKEN
```

Si todo sale bien verás **✅ ¡LISTO!** y tu Huddle quedará en `https://mi-huddle.duckdns.org`.

## Después de instalar

- Entra **desde el nuevo dominio** y comparte las salas desde ahí
- El puerto 3000 viejo sigue funcionando por si acaso; cuando confirmes
  que el dominio te gusta, puedes cerrar el 3000 en la Security List
- DuckDNS renueva tu IP solo; el certificado HTTPS se renueva solo (Caddy)
- ¿Se te olvidó la IP? No importa: el dominio siempre apunta a tu servidor

## Si algo falla

```bash
# ver el log de Caddy
journalctl -u caddy --no-pager | tail -30

# probar a mano
curl -v https://mi-huddle.duckdns.org/api/health
```

Lo más común: olvidar abrir 80/443 en la **Security List de Oracle** (paso 2).
