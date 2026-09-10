# 🦆 Plan B — si dynv6 no vuelve (migrar a DuckDNS en 5 minutos)

**Qué pasó**: dynv6 (el servicio gratis que daba el DNS de `play-huddle.dynv6.net`)
lleva caído desde el **2026-09-10** — ni su propia página resuelve. No es tu
servidor ni tu configuración: tu Huddle sigue funcionando perfecto en
`http://129.80.212.92:3000`.

**Si dynv6 vuelve** (suele tardar horas), tu dominio viejo funciona otra vez
solo — no tienes que hacer NADA de esta guía.

Esta guía es solo **si en ~24 horas sigue caído**.

---

## 1) Crea el dominio en DuckDNS (1 minuto, desde tu celu o compu)

1. Entra a **https://www.duckdns.org** → inicia sesión con Google o GitHub
   *(si la página no abre desde tu WiFi: prueba con datos móviles, o cambia
   el DNS del WiFi a 1.1.1.1 — a duckdns a veces lo bloquean los ISP)*
2. Crea un subdominio: escribe **play-huddle** (o el nombre que quieras)
3. Verifica que apunte a tu IP: **129.80.212.92** → botón **update**
4. Copia tu **token** (el código de letras que sale arriba a la izquierda)

## 2) En tu servidor Oracle (2 minutos, desde tu Mac)

```bash
ssh -i ~/Downloads/ssh-key-*.key ubuntu@129.80.212.92
cd ~/huddle && bash actualizar.sh
sudo bash deploy/oracle/https.sh play-huddle.duckdns.org PEGA-TU-TOKEN
```

- El primer comando te deja de paso la **v103** (temporadas completas)
- El segundo instala/actualiza Caddy y saca el certificado HTTPS **solo**

## 3) Listo 🎉

- Tu nueva dirección: **https://play-huddle.duckdns.org**
- El IP viejo (`http://129.80.212.92:3000`) sigue funcionando igual, siempre
- Si dynv6 resucita algún día, el dominio viejo vuelve solo — puedes
  quedarte con los dos, o repetir el paso 2 con el que prefieras

---

## ¿Cómo saber si dynv6 ya volvió?

- Pregúntale al asistente: *"checa el dns"*
- O entra a **https://dynv6.com** desde el celu: si su página abre, ya volvió

## Si algo falla

```bash
# ver el log de Caddy (el que da el HTTPS)
journalctl -u caddy --no-pager | tail -30

# probar a mano
curl -v https://play-huddle.duckdns.org/api/health
```

Lo más común: que DuckDNS haya quedado apuntando a otra IP (revísalo en su
página, paso 1.3).
