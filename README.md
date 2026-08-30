# 🎬 Huddle — mira videos juntos, en sincronía

Una mini-app estilo **Rave / Teleparty**: creas una sala, compartes el link y todos ven **el mismo video al mismo tiempo**, con chat incluido.

Construida con **Node.js puro (cero dependencias de servidor)** + vanilla JS en el cliente.

---

## 🚀 Cómo correrla

```bash
node server.js        # escucha en http://localhost:3000
# o con otro puerto:
PORT=8080 node server.js
```

## 🧪 Cómo probarla

1. Abre la app y ponte un nombre → **✨ Crear sala**.
2. Copia el link de invitación (botón 🔗) o el código de sala.
3. Abre ese link en **otra pestaña, ventana o dispositivo** con otro nombre.
4. Carga una URL de video (o usa los clips de ejemplo) y dale play — se sincroniza para todos: play, pausa, seek y cambio de video.

## ✨ Funciones

- **Salas con código** + link de invitación (`/#ABC12`).
- **Sincronización** de play / pausa / seek / cambio de video, con corrección automática de desvío (si un cliente se atrasa > 0.75 s, se re-sincroniza).
- **🪞 Modo espejo**: espeja una **página web completa** — un Chrome real corre en el servidor, su pantalla se transmite a todos los de la sala (frames JPEG por SSE, ~6 fps) y los clics/teclado/scroll se reenvían. Es la técnica de los *cloud browsers* (Hyperbeam, Kasm).
- **Chat** en vivo + mensajes del sistema (entradas/salidas).
- **Lista de presencia** con anfitrión (👑) y transferencia automática si se va.
- **Modo control**: "cualquiera controla" o "solo el anfitrión".
- **Fuentes de video**:
  - URLs directas `.mp4` / `.webm` (http/https).
  - Streams **HLS** `.m3u8` (vía `hls.js`, incluido localmente).
  - Los clips de ejemplo se sirven desde `/videos/`.
- Indicador de sync (desvío en segundos), volumen local, pantalla completa.

## 🪞 Modo espejo: notas

```bash
bash setup.sh          # dependencias del sistema: pulseaudio, xvfb, librerías de Chrome
node server.js
```

- En la sala, escribe una URL en el campo **"🌐 Espejar una página web"** → todos ven la misma página en vivo.
- Quien tiene control puede hacer **clic, escribir y hacer scroll** sobre la página; el resto lo ve en tiempo real.
- **🔊 El espejo transmite el audio de la página** (música, videos de la página espejada) a todos en la sala. Cada quien controla su propio volumen. Si tu navegador bloquea el sonido, aparece un chip *"Toca aquí para activar el audio"*.

### Cómo funciona el audio (lo interesante)

```
Chrome real (en Xvfb, monitor virtual)
   │ suena en → PulseAudio "null sink" (sink virtual, sin hardware)
   ▼
parec captura el monitor del sink (PCM 24 kHz mono)
   │ trozos de 100 ms por SSE (¡los silencios no se envían!)
   ▼
Cliente: AudioWorklet + colchón anti-jitter de 250 ms
```

- **Chrome headless NO emite audio** (lo comprobamos a mano: abre streams pero manda puro silencio). Por eso el espejo usa **Chrome real dentro de Xvfb**, que sí suena.
- PulseAudio en contenedores se cuelga en DBUS al arrancar; el truco es apuntar `DBUS_SYSTEM_BUS_ADDRESS` a una ruta inexistente (`setup.sh` lo hace).
- Detalles técnicos del video: `Page.startScreencast` (CDP) genera frames JPEG solo cuando la página cambia.
- Límites del demo: máx. 2 espejos simultáneos, se cierra tras 3 min con la sala vacía (RAM limitada).
- ⚠️ **Chrome for Testing no incluye Widevine** → Netflix/Disney+ **no reproducen** dentro del espejo. Los *cloud browsers* comerciales (p. ej. Hyperbeam) traen Chrome con Widevine — y aun así, compartir una sola cuenta de un servicio de streaming con un grupo viola sus ToS.

## 🏗️ Arquitectura

```
┌──────────┐   SSE (GET /api/events)   ┌──────────┐   SSE   ┌──────────┐
│ Cliente A │ ◀──────────────────────── │  Servidor │ ──────▶ │ Cliente B │
└────┬─────┘                           │ (estado   │        └──────────┘
     │  POST /api/action               │  de la    │
     └────────────────────────────────▶ │  sala)    │
                                       └──────────┘
```

- **Estado de la sala** (fuente de verdad en el servidor):
  `{ videoUrl, videoTitle, isPlaying, position, updatedAt }`
  donde `position` es la posición del video **en** `updatedAt`.
- **Servidor → clientes**: Server-Sent Events (`state`, `users`, `chat`, `hello`).
- **Cliente → servidor**: `POST /api/action` con `{type: 'play'|'pause'|'seek'|'video'|'chat'|'mode'|'ended'}`.
- **Cálculo del objetivo**: si está reproduciendo → `position + (ahora − updatedAt)/1000` (ajustando el desfase de reloj con `serverNow`).
- **Latido**: mientras se reproduce, el servidor re-difunde el estado cada 2.5 s para corregir desvíos.
- Requiere **cero dependencias**: solo `http`, `fs` y `crypto` de Node. `hls.js` se sirve local desde `/vendor/`.

## ⚠️ Lo que NO hace (y por qué)

- **No reproduce Netflix / Disney+ / HBO / Prime**: usan **DRM (Widevine/PlayReady)**. No se puede capturar ni redistribuir su video legalmente. Apps como Rave o Teleparty lo resuelven haciendo que **cada persona reproduzca con su propia cuenta** (en su navegador o en el navegador integrado de la app) y solo **sincronizan los controles**.
- **No bloquea anuncios de YouTube**: quitar anuncios dentro de una app viola los Términos de Servicio de YouTube, y además combaten activamente a los adblockers. Para YouTube existe la API oficial del reproductor embebido (iframe), pero con sus anuncios.
- **Alternativa legal**: contenido propio o libre (archivos directos, HLS propio, Jellyfin + Watch Together, Blender Foundation, etc.) — cero anuncios de por medio. Eso es exactamente lo que usa este demo.

## 📁 Estructura

```
raveroom/
├── server.js            # servidor: salas, SSE, acciones, estáticos con Range
├── public/
│   ├── index.html       # UI (inicio + sala)
│   ├── style.css        # tema neón oscuro
│   ├── app.js           # cliente: sync, chat, controles
│   ├── vendor/hls.min.js
│   └── videos/          # clips de ejemplo (CC / dominio público)
└── README.md
```

## 🗺️ Ideas para seguir

- Historial/cola de videos con votación ⏭️
- Reacciones flotantes (❤️ 🔥 😂) estilo Twitch
- Compartir pantalla por WebRTC (verdadero modo "Rave")
- Salas con contraseña, avatares y cuentas
- Subir tus propios videos al servidor
- Empaquetar como app móvil con **Capacitor** o **React Native** (el backend sirve igual)

## Despliegue en Oracle Cloud (gratis, 8 espejos)

Ver **GUIA-ORACLE.md** — guía paso a paso (cuenta, máquina ARM 2 núcleos/12 GB, instalación con `deploy/oracle/setup-oracle.sh`).
