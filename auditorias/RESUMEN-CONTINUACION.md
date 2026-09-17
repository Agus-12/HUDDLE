# RESUMEN TÉCNICO — Continuación captura StorySprout (para nuevo chat)

_Fecha: 2026-09-14. Estado: oyente mitmproxy en Oracle, pendiente 1 diagnóstico._

---

## ⚡ ACTUALIZACIÓN FINAL DEL DÍA (leer PRIMERO)

**CULPABLE DE TODOS LOS FALLOS DE CONECTIVIDAD: `block_global`.**
mitmproxy rechaza por defecto clientes de IP pública → mataba las pruebas desde la Mac
(187.189.128.17, visible en el log: "Client connection from ... killed by block_global
option"). Los errores "reset by peer" (8080), "Empty reply" (443) y "Proxy CONNECT
aborted" eran SIEMPRE block_global — nunca el ISP ni los firewalls. Además hay un
servicio ajeno (root, backlog 4096) ocupando el *:443 del server → 443 descartado.

**FIX (kit v3)**: oyente en **8080** con `--set block_global=false`:
```bash
pkill -f mitmdump; sleep 1
nohup ~/.local/bin/mitmdump -s ~/captura_ss.py --listen-host 0.0.0.0 --listen-port 8080 --set block_global=false > ~/captura-sesion.txt 2>&1 &
sleep 3; pgrep -af mitmdump; tail -2 ~/captura-sesion.txt
```
Prueba Mac: `curl -x http://129.80.212.92:8080 http://example.com -m 10` (HTML = vivo) y
`curl -x http://129.80.212.92:8080 https://example.com -m 15 -o /dev/null -w "CONNECT: %{http_code}\n"` (200 = CONNECT ok).
**OUTCOME UNKNOWN — el user no ha reportado el resultado de esta prueba.**
Seguridad: con block_global=false el proxy acepta extraños mientras corre → vida corta,
`pkill -f mitmdump` al terminar. El WhatsApp al amigo usa puerto **8080**.
Pendiente: `cp ~/.mitmproxy/mitmproxy-ca-cert.pem ~/huddle/public/mitm.crt` (cert NO
publicado aún; ~/.mitmproxy ya existe porque mitmdump corrió antes).

---

## 1. CONTEXTO

**App Huddle** (repo https://github.com/Agus-12/HUDDLE, main = `807e7b3` v206.2): watch-together
en español, Node puro (server.js) + vanilla (public/app.js). Servidor: Oracle
`ubuntu@huddle` = `http://129.80.212.92:3000`, carpeta `~/huddle`, se actualiza con
`bash actualizar.sh` + cerrar/reabrir app. REGLA VIGENTE: SOLO HTTP puro (nada de HTTPS propio).

**Misión activa**: capturar el tráfico del app Android "ppcinees" (disfrazado; paquete real
`com.movievn.cinevi`, internal `com.mgs.carparking`, se llama **"Movie"** en el cajón) para
sacar la petición real del player (src m3u8/P2P) y **integrar su catálogo (novelas) a Huddle**.

- APK: https://o.z2v3m6.com/ (también copia local en Mac `~/Downloads/ss-casa/ppcinees.apk`)
- iOS equivalente: "StorySprout" id6798627556 — **MUERTO para MITM (cert pinning), NO reintentar**
- API del app (ya dominada): `https://movievn.z3azky.com/api/<ruta>` con headers
  `app_id: movievn, version: 40000, sys_platform: 2, device_id: <16hex>, cur_time: <ms>,
  token, sign, channel_code: netcine, UA okhttp/4.9.3`
  → `sign = MD5('47Q8tBqO4YqrMHf4'+device_id+cur_time).toUpperCase()`
- Respuestas: base64 sin padding → AES-128-CBC (key `0123456789123456`, IV `2015030120123456`)
  → JSON `{"code":10000,...}`; `error1` = rechazo/rate-limit (~60 s)
- **BLINDADO (no insister)**: `vod/info_new` en z3azky Y en t6p6v — de ahí la necesidad del MITM
  con el APP REAL reproduciendo un capítulo (la petición del player es lo que falta ver)
- Player: proxy local `com.pp.hls`, `/resource.m3u8?src=<tc.f.a(url)>` + verify
  `/control?msg=verify&device_id=<dev><vod_id>&ts=<ms>`, key hls `87c2cb7ff568d602d5f806c473345600`
- El APK **CONFIÁ en CAs de usuario** (`network_security_config` con `<certificates src="user"/>`)
  → MITM con mitmproxy funciona en cualquier Android 7+ sin root. ESTA ES LA LLAVE DEL PLAN B.

## 2. LO QUE PASÓ HOY (para no repetir)

1. **VirtualBox AndroidSS (Android-x86 8.1-r6 Live CD) en la Mac del user = ABANDONADO.**
   Todo funcionó (red manual iface `wifi_eth`, proxy, descargas por LAN_IP 192.168.1.11,
   cert + APK instalados, app = ícono "Movie") PERO el app **crashea al arranque por su
   protección anti-pirata jiagu** (`com.jiagu.sdk.pp_hlsProtected` — detecta emulador y aborta).
   Log fatal visto: `at com.jiagu.sdk.pp_hlsProtected.b ← AppApplication.attachBaseContext`.
   NO reintentar en emulador; disfrazar identidad = ~40 min con ~40-50% de éxito → descartado.
2. **DECIDIDO: Opción B — Android real prestado de un amigo + proxy del servidor Oracle.**
   El amigo puede estar lejos: el proxy es público (puerto abierto en Oracle) y él solo
   instala app + cert + proxy WiFi + reproduce. Mensaje WhatsApp ya redactado (kit FASE 3).

## 3. ESTADO ACTUAL DEL SERVER ORACLE (verificado hoy)

- `~/captura_ss.py` — addon mitmdump creado por nano (63 líneas, funciona: imprime `>>>`
  con API descifrada y videos; usa openssl, sin dependencias extra). Copia canónica:
  `/home/user/auditorias/captura_ss.py` (sandbox) y apéndice de
  `/home/user/auditorias/kit-android-prestado.md`
- mitmproxy **12.2.3** instalado: `pip3 install --user --break-system-packages mitmproxy`
  → binario en `~/.local/bin/mitmdump`
- Puertas: nube Oracle (Security List) = **8080 y 443 abiertos a 0.0.0.0/0 TCP** ✓;
  iptables interno = 8080 agregado (`sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT`
  + `netfilter-persistent save`), 443/80/3000 ya estaban ✓
- Oyente: **estaba en 8080 y funcionaba local** (`local: 200` via 127.0.0.1:8080) pero desde
  la Mac: `Failed to connect ... 8080` → luego movido a 443 → desde la Mac:
  `curl -x http://129.80.212.92:443 http://example.com` = **"Empty reply from server"**
  (la TCP entra pero la conversación muere; sospecha: ISP del user filtra proxy HTTP plano
  en 443 que "debería" ser TLS)
- **DIAGNÓSTICO PENDIENTE (próximo paso #1)** — en server:
  ```bash
  ss -tlnp | grep 443; pgrep -af mitmdump
  curl -sx http://127.0.0.1:443 http://example.com -m 10 -o /dev/null -w "local443: %{http_code}\n"
  tail -5 ~/captura-sesion.txt
  ```
  y en la Mac (prueba CONNECT real, como viaja el tráfico del app):
  ```bash
  curl -v -x http://129.80.212.92:443 https://example.com -m 15 -o /dev/null 2>&1 | tail -8
  ```
  **Lectura**: CONNECT con `HTTP/2 200` o handshake TLS = el proxy SÍ sirve para el app
  (todo su tráfico es CONNECT https) → seguir a paso 2. Si muere también → mover oyente al
  **puerto 80** (`pkill -f mitmdump; sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0;
  nohup ~/.local/bin/mitmdump -s ~/captura_ss.py --listen-host 0.0.0.0 --listen-port 80 >
  ~/captura-sesion.txt 2>&1 &`) y re-probar `curl -x http://129.80.212.92:80 http://example.com`.
  Nota: `curl -sx http://129.80.212.92:443 ... http://...` desde el PROPIO server da 000 por
  hairpin NAT — NO es fallo, ignorar.
- Cert mitmproxy aún NO publicado en la web. Paso #2 del plan:
  `cp ~/.mitmproxy/mitmproxy-ca-cert.pem ~/huddle/public/mitm.crt`
  → queda en `http://129.80.212.92:3000/mitm.crt` (el server.js sirve public/ al vuelo, verificado).
  Si se copia después de arrancar mitmdump la primera vez: `~/.mitmproxy/` ya existe (lo genera al primer arranque).

## 4. PLAN COMPLETO (kit en /home/user/auditorias/kit-android-prestado.md)

1. Diagnosticar/asegurar el puerto ganador (arriba) + publicar cert en la web
2. Verificación desde la Mac del proxy público (curl del paso #1)
3. **Mensaje WhatsApp al amigo** (texto exacto en kit FASE 3):
   instalar APK https://o.z2v3m6.com/2a061172ea402dfd/ppcinees.apk (no abrir aún) →
   bajar `129.80.212.92:3000/mitm.crt` en Chrome → Ajustes "Instalar desde el
   almacenamiento" → nombrar → proxy WiFi manual `129.80.212.92` puerto `<GANADOR>` →
   abrir app "Movie" → permisos → novelas → PLAY 1 min → quitar proxy
4. Botín: en server `grep ">>>" ~/captura-sesion.txt | head -100` → pegarlo al agente
5. Con las `>>>`: armar integración HTTP puro en Huddle (replicar headers/sign de la API
   y la ruta del player que aparezca)
6. **Cerrar**: `pkill -f mitmdump` + `rm ~/huddle/public/mitm.crt && bash actualizar.sh`
   (regla 8080 de la nube: borrarla; 443/80 ya estaban, quedan)

## 5. RESTRICCIONES DEL USER (SIEMPRE)

- **La Mac NO tiene llave SSH**: NUNCA scp/rsync. Método: entrar a `ubuntu@huddle` como
  siempre + `nano archivo` + pegar + Ctrl+O/Enter/Ctrl+X
- macOS 12.7.6 Intel; brew ROTO; sin Android físico; VirtualBox solo vboxvga (hoy abandonado)
- Darle bloques copy-paste completos y pedirle pegar la salida
- PAT de GitHub (revocar AL CERRAR): `PAT-REDACTADO-POR-SEGURIDAD`
  → push: `git push "https://Agus-12:<PAT>@github.com/Agus-12/HUDDLE.git" main` desde /home/user/HUDDLE
- Pendientes permanentes: **revocar PAT al cierre** · test Rosa (`/api/enp/la-rosa-de-guadalupe`)
  · quitar proxy del iPhone del user (pendiente de confirmar)
- En sandbox: SIEMPRE `cd /home/user/HUDDLE` antes de grep/git

## 6. LLAVES DE LA API (cheat-sheet v5, vigente)

- REQUEST: `GET https://movievn.z3azky.com/api/<ruta>?<query>` + headers de sección 1
- Vivos: `type/get_list` · `search/screen?type_id=N&page=1` (items con campo `id`, NO vod_id;
  Señor de los Cielos T10 = **1898251857**, 48 caps; Mentalist=838694823) ·
  `search/hot_search` · `public/init` (guest token gAAAAAB…)
- Blindados: `vod/info_new` (ambos dominios), `register`, `search/result`
- Respaldo base: `surfclick.vd7au6.com`; bootstrap `movievn.m5e7.com/error.png`;
  pics `*.j5t2n.com` / `0000.k0j5n7.com`; tracker P2P `47.253.51.203:7202`
- Web Freecine (vitrina): `https://escc.k5ca.com/play?vod_id=N` — SOLO películas (series 500)

## 7. ARCHIVOS QUE IMPORTAN

- `/home/user/auditorias/kit-android-prestado.md` — kit completo v2 (este plan, con texto WhatsApp)
- `/home/user/auditorias/captura_ss.py` — addon mitmdump canónico
- `/home/user/auditorias/ppcinees.apk` — APK canónico (54 MB)
- `/home/user/auditorias/storysprout-AUDITORIA.md` — auditoría "Ronda 2"
- Mac del user: `~/Downloads/ss-casa/` (apk+cert), `~/Downloads/mitmproxy.app/`, VM VirtualBox AndroidSS (puede borrarse)
