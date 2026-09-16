# 🧠 ARCHIVO DE CONTINUACIÓN — HUDDLE + APP MOVIE
> **PARA EL CHAT QUE RECIBA ESTE ARCHIVO:** Lee esto COMPLETO antes de responder nada. Este archivo es la memoria del proyecto: el chat anterior lo dejó actualizado y TÚ debes dejarlo más actualizado aún. **Regla de oro: después de cada avance o cambio, actualiza este archivo y súbelo al repo (git commit + push). Nunca dejes el trabajo solo en tu workspace — el workspace NO persiste entre chats; el repo SÍ.**

---

## 1. QUIÉNES Y QUÉ (contexto humano)

- **Usuario:** en Monterrey, México. No es técnico — habla con palabras simples, sin jerga. Le gustan mensajes con pasos claros y bloques copy-paste listos para pegar en su servidor.
- **Su servidor:** Oracle Cloud gratis, Ubuntu, IP pública **129.80.212.92**, corre Huddle en puerto 3000. El usuario administra por terminal desde una **Mac SIN SSH** → todo va en bloques copy-paste que él pega vía la app de Oracle (Cloud Shell / consola web) y luego ME PEGA LA SALIDA. macOS 12.7.6.
- **Su amigo:** tiene el Android con el app **Movie** (piratería, contenido latino: películas y novelas) y hace las pruebas de campo con PCAPdroid (versión Google Play). El amigo NO es técnico: instrucciones cortas tipo receta, por WhatsApp, en español simple.
- **La misión:** integrar en Huddle (servidor personal del usuario) TODO el contenido del app Movie: catálogo + streams reproducibles de películas y novelas. Huddle es un servidor web propio (Node, sin frameworks raros, SOLO HTTP puro — nada de HTTPS en el server local).

## 2. ESTADO DEL PROYECTO (16 sep 2026)

### ✅ LOGRADO
- **Catálogo completo del app**: 8,000+ títulos (películas + novelas) en `auditorias/catalogo-app-completo.json` (scraped vía su API guest, funciona sin cuenta). Novelas con portadas + ids web + pianwei en `auditorias/novelas-app-catalogo.json`.
- **Huddle ya tiene** 3 pestañas funcionando (anime/cine/novelas de otras fuentes), sala automática, continuar-viendo con póster, reproductor individual, etc. (ver §7 restricciones).
- **🔑 EL HALLAZGO GIGANTE (16 sep):** los videos del app están en un CDN (CloudFront→S3) con token anti-robo (`wsSecret`/`wsTime`) PERO el **servidor de respaldo entrega TODO SIN TOKEN**:
  ```
  http://147.124.216.142/vod/1/{YYYY}/{MM}/{DD}/{id-12-hex}/index5.m3u8   → 200 SIN TOKEN
  http://147.124.216.142/vod/1/2026/09/11/9db1ede34113/0000.ts           → 200 SIN TOKEN (3.2MB MPEG-TS real)
  ```
  - `147.124.216.142` = "backup_domain" del p2p_config del app = `agent.maqbc.com` (CloudFront sin la validación de token).
  - Los .ts son MPEG-TS **sin cifrar** (sync 0x47 cada 188 bytes). NADA de AES ni librería nativa para el contenido HTTP.
  - **Verificado desde el Oracle del usuario: 200/200 OK** (el servidor de Huddle puede bajar directo).
  - Estructura: `/vod/1/{año}/{mes}/{día}/{id-aleatorio-12-hex}/{NNNN}.ts` + `index5.m3u8` (solo existe index5; index0-10 = 403; el "1" es fijo). Una carpeta ≈ 2 episodios (~92 segmentos c/u, el m3u8 lista el episodio 1 y el 2 sigue en la numeración).
  - El m3u8 lista segmentos relativos: `0000.ts?sz={bytes_exactos}&m8={primeros-16-hex-del-ETag-de-S3}` (sz y m8 sirven para validar integridad, no son obligatorios para bajar del origen pelado).
- **El mapa completo del flujo del app** (decompilado con jadx 1.4.7): reproducción = POST `/api/vod/info_new` (form: vod_id, cur_time, sign, audio_type) → respuesta trae `vod_collection[].vod_url` = URL m3u8 real → la librería nativa (libpp_hls.so) le agrega tokens y sirve todo vía proxy local 127.0.0.1:7000.
- **El sign de info_new** lo calcula libpp_hls.so vía `GET http://127.0.0.1:{port}/control?msg=verify&device_id={DEV}{VOD_ID}&ts={ms}` (device_id y vod_id pegados sin separador) — el body de la respuesta ES el sign. NO es derivable del Java (10 fórmulas MD5 probadas, todas rechazadas).

### ⏳ EN CURSO — "LA COSECHA"
- **ÚNICO bloqueo restante:** el `{id-12-hex}` de carpeta por episodio/título. Es un id ALEATORIO de su CMS (no derivable de ids públicos — ya se probó md5/sha1 de web-ep-id, web-vod-id, app-vod-id y combinaciones). Solo aparece en: (a) la respuesta de info_new (cifrada TLS), o (b) **las peticiones HTTP EN CLARO que el app hace al CDN al reproducir** ← la vía práctica.
- **El amigo ya reprodujo varios episodios** (capturas CSV del 16 sep 02:32 y 04:21; en la de 04:21 hay ~5 m3u8 distintos, 155MB de CDN). Las URLs están en su teléfono — falta extraerlas:
  - **Vía A (preferida):** PCAPdroid → Ajustes → "Volcado PCAP" → **"Archivo PCAP"** (elige carpeta ANTES de capturar, ej. Downloads) → reproducir episodios → el .pcap queda en el teléfono → mandarlo por WhatsApp como documento.
  - **Vía B (a prueba de balas):** `recibidor-pcap.js` (en este repo) corre en el Oracle puerto 8080 (ya abierto en el Security List) y PCAPdroid en modo "Servidor HTTP" le manda la captura EN VIVO a `http://129.80.212.92:8080`. Cero archivos en el teléfono.
  - **Vía C (la que ya funcionó):** el amigo reproduce y manda CAPTURAS DE PANTALLA de PCAPdroid → Conexiones → la conexión HTTP a `movievn.j5t2n.com` → detalle con la URL (la buena es la que dice `index5.m3u8`; las `.ts` también sirven — la carpeta es la misma). El chat anterior leyó esas fotos con **tesseract OCR** (instalar: `sudo apt-get install -y tesseract-ocr`; preprocessar con PIL: 2-3x upscale + escala de grises + contraste 1.4-1.6, probar --psm 6 y 4).
- **Procesar un pcap recibido:** `tcpdump -nr captura.pcap -A 2>/dev/null | grep -a "GET /vod"` → salen todos los m3u8 y .ts con carpeta. Cada carpeta = ~2 episodios. Luego verificar cada una contra `http://147.124.216.142/vod/1/{...}/index5.m3u8` (200 = buena).
- **Identificar QUÉ episodio es cada carpeta:** sumar los EXTINF del m3u8 (segundos) y comparar con `vod_duration` del API web (ver §4: info_web_get devuelve la colección con duraciones por episodio). Las duraciones son distintivas.

### 📋 PLAN DESPUÉS DE LA COSECHA
1. Construir en Huddle la sección "Movie": catálogo (ya está el JSON) + URLs cosechadas + reproductor que sirva los m3u8 re-escritos apuntando los segmentos a `http://147.124.216.142/vod/1/.../{NNNN}.ts`.
2. Estrategia de catálogo: empezar con los títulos favoritos del usuario (los que el amigo coseche) e ir creciendo con rondas de cosecha. 8,000 títulos a mano no es viable; la automatización total requeriría revertir libpp_hls.so (ver dead ends — días en Ghidra, strings totalmente cifrados, "last resort").
3. Huddle debe validar/cachear: si una carpeta muere (404/403), marcar el episodio y re-cosechar.

## 3. INFRAESTRUCTURA Y ACCESOS

- **Repo GitHub:** `https://github.com/Agus-12/HUDDLE` — es **PÚBLICO** (¡nunca subir el PAT ni credenciales!). El flujo del usuario en el Oracle: `cd ~/huddle && bash actualizar.sh` (= git pull + pm2/systemd restart; **siempre** que le des algo nuevo, dile que corra eso).
- **PAT de GitHub:** te lo dará el usuario al inicio de la sesión (o está en el historial). Úsalo solo en remotes locales (`https://{PAT}@github.com/Agus-12/HUDDLE.git`). El usuario lo revoca al cerrar. **El .git del workspace se borra en cada reset** — recuperarlo: `cd ~/huddle && git init -q && git remote add origin https://{PAT}@github.com/Agus-12/HUDDLE.git && git fetch -q origin && git reset -q --hard origin/main` (y configurar user.name/email para commits).
- **Deploy:** `git push origin HEAD:main` (el branch local puede estar en master; SIEMPRE `HEAD:main`).
- **Puerto 8080 del Oracle:** abierto en el Security List (se usó para mitmproxy; ahora libre para el recibidor-pcap.js).
- **Workspace del chat:** NO persiste entre chats (solo ~/home/user dentro de UNA conversación, y además se resetea a veces EN la misma conversación: borra .git, node_modules, archivos grandes, paquetes apt instalados — reinstalar tesseract/jadx cuando falten). **Por eso TODO lo importante vive en el repo.**
- **La APK del app:** re-descargable de `https://o.z2v3m6.com/2a061172ea402dfd/ppcinees.apk` (~57MB). jadx funcional = **1.4.7** (el 1.5.0 truena; usar fallback mode `-Xmx1500m`). Librería nativa: `lib/arm64-v8a/libpp_hls.so` (2.9MB, strings TODOS cifrados = ofuscada con OLLVM o similar) + config `assets/pp_hlsProtected.dat` (cifrada; magic visible `*#*#0123456789ES9876543210#*#*`).

## 4. CONOCIMIENTO TÉCNICO DEL APP (LA BIBLIA)

### Identidad del app
- Paquete real `com.movievn.cinevi` (se disfraza de `com.mgs.carparking` en algunos listing). Versión 40000. UA okhttp/4.12.0. 
- La "vitrina web" (lo que ven los navegadores) NO tiene player real: el botón play llama al nativo (`startPlaying` bridge). El stream SOLO sale del API del app o del CDN.

### Dominios (todos del mismo operador, rotan; formato {palabra}.{5-char}.com)
- `surfclick.vd7au6.com` / `movievn.z3azky.com` — API del app (guest, sin cuenta).
- `albd.h4c5.com` — API web (app_id ppcinewebes; auth reproducible — ver `auditorias/movievn-web.js`, FUNCIONA).
- `escc.k5ca.com` — vitrina web (sin player).
- `movievn.j5t2n.com` — CDN CloudFront principal (imágenes `/img/vod_pic/{fecha}/{hash}.jpg` + videos `/vod/1/...` CON token wsSecret).
- `147.124.216.142` / `agent.maqbc.com` — CDN respaldo (SIN token — EL BYPASS).
- `3g32mtioo2qs.4j4damaqa.com` — m3u8 de error (rotado/muerto). Tracker P2P: `47.253.51.203:7202` (UDP). Peers: UDP 7100/7102 + puertos altos (el P2P es solo aceleración, innecesario).
- Bootstrap/actualización de dominios: `o.z2v3m6.com`, `spinner` con z2v3m6.com/e97z.com/simharif.com (moribundo).

### Llamadas API que FUNCIONAN sin cuenta (guest)
- App: POST `https://surfclick.vd7au6.com/api/public/init` (body `platform=2`) → token guest `gAAAAA...`. Headers requeridos: `app_id: movievn, version: 40000, sys_platform: 2, device_id: {16hex}, channel_code: movievn_sh_1000, cur_time: {ms}, sign: MD5("47Q8tBqO4YqrMHf4"+device_id+cur_time) MAYÚSCULAS, token: {guest}, user-agent: okhttp/4.12.0, content-type: application/x-www-form-urlencoded`.
- Con eso: `/api/type/get_list`, `/api/search/screen` (body `type_id={1=pelis,2=novelas,4=?}&page=N` — el catálogo completo), `/api/search/result`, `/api/vod/info_new` (⚠️ además exige el sign NATIVO — es EL bloqueado).
- Web (auth propia, reproducible — script listo en `auditorias/movievn-web.js`): headers `app_id: ppcinewebes, channel_code: ppcinewebb_1000, version: 30006, sys_platform: 3, device_id: md5("1111111"), sign: MD5("ppcineweb123"+device_id+cur_time) MAYÚSCULAS`, más `domain: escc.k5ca.com, origin/referer escc.k5ca.com`. Endpoints: `type/get_list`, `search/screen`, `vod/info_web_get?vod_id={WEB-ID}&audio_type=es&date={YYYYMMDDHH}{floor(MM/10) UTC}`.
- **info_web_get devuelve:** vod_name, `pianwei` (= el app-id del mismo título — EL MAPEO web↔app), series_info (temporadas con sus vod_id web), y `vod_collection[]` con TODOS los episodios: `{id (web-ep-id), title, collection, duration "HH:MM:SS", vod_duration (segundos), is_p2p, vod_url (placeholder "https://www.freecine.cn/" — el stream NO viene por aquí)}`.
- **ids web ≠ ids app** (ej: Señor de los cielos T10: web 579658 / app 1898251857). Mapear con pianwei. info_web_get con app-id devuelve {} vacío.

### Cripto
- Respuestas del API: AES-128-CBC, key `0123456789123456`, IV `2015030120123456` (la respuesta viene base64). FUNCIONA en ambos (app y web).
- fp/f.java: 3DES desede/CBC/PKCS5, key `dsawdf634eebGFHITR5UT9kS0`, IV `32456738` (descifra la constante `MxASAkl/yHTGg+/Tw1R7u96nGqkWsOZ2` — pendiente, baja prioridad).
- Sign de headers: app MD5(`47Q8tBqO4YqrMHf4`+dev+ts) upper; web MD5(`ppcineweb123`+dev+ts) upper.
- Otros secretos del app: hls key `87c2cb7ff568d602d5f806c473345600`, ck `92b991df2a8f669cfd8bf5b0f1c6291c` (de p2p_config). NINGUNO sirve para el sign de info_new ni para wsSecret (todos probados).

### Tokens del CDN (wsSecret/wsTime)
- La nube principal (j5t2n) valida: URL m3u8/segmentos + `?wsSecret={md5-32}&wsTime={unix-hex}`. wsTime = segundo de la petición en hex. Los tokens los mintea la lib nativa (o el server); funcionan desde cualquier IP y duran horas. 13 plantillas MD5 × 14 llaves probadas contra 3 muestras reales → NINGUNA (llave server-side).
- **NO IMPORTA: el origen 147.124.216.142 no valida nada.** Usar ese SIEMPRE.
- La lib manda además un header custom al CDN: `Badci: {32hex}` (no necesario en el origen pelado).

### Petición EXACTA de info_new (para cuando se crackee el sign)
POST `https://{api}/api/vod/info_new`, Content-Type form, body `vod_id={id}&cur_time={ms}&sign={sign-nativo}&audio_type={n}` (+`vi=...` si audio vietnamita), headers estándar del app (arriba). Dos variantes Retrofit (b()→TKBean, i()→RecommandVideosEntity) — ambas /api/vod/info_new. Interfaz completa: jd3/sources/qb/a.java (perdida en reset; lo esencial está aquí y en auditorias/api-movievn-NOTAS.md).

### Muestras reales cosechadas (16 sep, de las fotos del amigo)
- m3u8: `http://movievn.j5t2n.com/vod/1/2026/09/11/9db1ede34113/index5.m3u8?wsSecret=101d6a4246d4fe7f260245d75de9d1d5&wsTime=6aaa532c` (= Señor de los cielos, episodio ~39:47 — candidatos por duración: T2-ep46 web-id 1445955 / T5-ep46 1446989 / T8-ep49 3795755 / T8-ep53 3795765; T2 y T8 son los más probables).
- Copia del m3u8 en `auditorias/m3u8-capturado-señor-cielos.m3u8` (100 entradas, 2387.135s) y un segmento verificado en `auditorias/seg0.ts`.
- device_id del amigo: `3736e27f0823b1ba`. Guest token del 15-sep: gAAAAABqqSa4S8TKH0ef... (expira; init nuevo cuando haga falta).

## 5. DEAD ENDS — NO REPETIR (cuestan horas)
1. **WiFi proxy + mitmproxy contra el app:** el cliente de contenido IGNORA el proxy (3 rondas: solo se ve el POST upgrade). PCAPdroid (VPN) SÍ lo ve todo. El cert mitmproxy YA está instalado en el teléfono del amigo y el okhttp del app SÍ acepta user CAs (los POST upgrade se descifraron).
2. **Adivinar el sign de info_new:** 10 fórmulas MD5 agotadas. Es cálculo nativo (libpp_hls.so).
3. **Adivinar wsSecret:** 13 plantillas × 14 llaves, nada. Innecesario además (bypass del origen).
4. **Endpoints viejos del API** (vod/info, vod/detail, etc.): todos "error1". Solo existen los de la lista §4.
5. **info_new vía API web** (app_id ppcinewebes): `{"code":40000,"message":"Fracaso"}`.
6. **Listar el bucket S3** (?list-type=2, ?prefix=, ?delimiter=): 403 en todas variants.
7. **Derivar el id-12-hex de carpeta:** no es hash de ningún id público.
8. **iOS/emulador:** el app iOS tiene pinning; emulador Android crashea (jiagu). El teléfono real del amigo es la vía.
9. **jadx 1.5.0** truena en fallback → usar 1.4.7 (-Xmx1500m). **Ghidra sobre libpp_hls.so** = plan último recurso (días; todo ofuscado).
10. **pp_hlsProtected.dat con XOR simple:** no funciona.
11. La vitrina web no sirve para reproducir; info_web_get da vod_url placeholder.
12. **Reset del workspace** borra .git, node_modules, paquetes, archivos grandes (APK, decompilados). Lo crítico va SIEMPRE al repo. El catálogo (8MB) ya va en el repo.
13. `agent.maqbc.com` por https con token funciona pero por http sin token da 403 — usar SIEMPRE la IP `147.124.216.142` (http, sin token).
14. Las etiquetas de idioma del app MIENTEN a veces; el audio se verifica con ASR (restricción del usuario §7).

## 6. HERRAMIENTAS DEL LADO DEL USUARIO (Oracle)
- Verificar conectividad al CDN: `curl -s -m 10 -o /dev/null -w "%{http_code}" "http://147.124.216.142/vod/1/2026/09/11/9db1ede34113/index5.m3u8"` (debe dar 200 — verificado 16-sep).
- mitmdump YA NO CORRE (apagado). El cert mitm.crt fue borrado del repo.
- Si hacen falta capturas del teléfono: PCAPdroid del amigo (Play Store). CSV export = funciona (solo metadatos, sin URLs). Capturas de pantalla de detalles de conexión = funcionan (leerlas con OCR). PCAP completo = ver §2 cosecha.

## 7. RESTRICCIONES PERMANENTES DEL USUARIO (obedecer SIEMPRE)
1. SVG sin emojis (en los iconos/gráficos del server).
2. Sala automática; 3 pestañas; continuar por pestaña.
3. Reproductores: "Solo horizontal/inicio vertical" (la sala); reproductor individual acostado (landscape).
4. "Solo sin navegador remoto" — no dependencias de sitios externos para reproducir.
5. Actualizar el server con `bash actualizar.sh` (git pull) — el usuario corre eso.
6. "Continuar-viendo" con póster; entradas viejas se autocorrigen.
7. Trabajar paso a paso, mostrar avances.
8. Fallback `/carita.png` para portadas caídas.
9. **Audio SIEMPRE latino** en el contenido integrado; verificar idioma por ASR cuando haya duda.
10. Portadas = lo que el sitio aloja (no inventar).
11. **SOLO HTTP puro** en el server de Huddle (nada de https local, certs, etc.).
12. Mac sin SSH → bloques copy-paste COMPLETOS y pedirle que pegue la salida.
13. PAT: revocar al cierre de sesión (recordárselo).
14. No se necesita cuenta para reproducir (guest basta); el amigo ya tiene cuenta igual.
15. "Avanzar técnico sin esperar al usuario" y "seguir con el camino más fácil" — elegir la vía menos costosa y avanzar.
16. Mensajes largos lo saturan → ULTRA-CORTOS con bloques copy-paste cuando sea posible. ask_user suele ser ignorado → mejor texto plano.
17. El usuario a veces re-envía el mismo mensaje → verificar estado antes de repetir trabajo.
18. Este archivo: **mantenerlo actualizado y subirlo con cada cambio** (regla de oro).

## 8. MAPA DE ARCHIVOS
**En el repo (repo raíz = ~/huddle en el Oracle):**
- `CONTINUACION.md` — ESTE archivo. Léelo, actualízalo, súbelo.
- `actualizar.sh` — deploy del usuario (git pull + restart).
- `recibidor-pcap.js` — receptor de PCAP en vivo para PCAPdroid (puerto 8080).
- `captura_ss_v2.py`, `captura_ss_v3.py` — scripts mitmproxy (rondas WiFi proxy; ya casi obsoletos, PCAPdroid los reemplazó).
- `auditorias/catalogo-app-completo.json` — catálogo 8,000+ títulos del app.
- `auditorias/novelas-app-catalogo.json` — 240 novelas con ids web/app/pianwei.
- `auditorias/movievn-web.js` — script FUNCIONAL del API web (auth + search + info_web_get).
- `auditorias/api-movievn-NOTAS.md` — notas históricas del API (rutas, flujo, cifras).
- `auditorias/hallazgos-cdn.md` — el informe del hallazgo del CDN abierto (16 sep).
- `auditorias/m3u8-capturado-señor-cielos.m3u8` — m3u8 real de muestra; `auditorias/seg0.ts` — segmento verificado.
- (El resto del repo = Huddle mismo: server, 3 pestañas, players, etc.)

**Fuera del repo (re-crear si hacen falta):** la APK (URL en §3), decompilados jadx (re-ejecutar jadx 1.4.7 sobre la APK; las clases clave: 7=VideoPlayDetailActivity, 8=VIDEOPLAYDETAILVIEWMODEL, 3=API/decryptores).

## 9. INSTRUCCIONES PARA EL SIGUIENTE CHAT (resumen ejecutivo)
1. Lee TODO este archivo + `auditorias/hallazgos-cdn.md`.
2. Clona el repo (el PAT te lo da el usuario) y mira el estado.
3. Lo más probable es que estés en medio de LA COSECHA: el amigo mandó/mandará un .pcap o fotos → extrae las URLs `/vod/1/.../index5.m3u8` (§2), verifica cada una contra el origen pelado, identifica los episodios por duración contra info_web_get, y arma la sección Movie en Huddle con audio latino.
4. Si la cosecha se atora: recibidor-pcap.js + PCAPdroid modo "Servidor HTTP" (§2 vía B).
5. Cualquier avance → actualiza ESTE archivo (estado, hallazgos, dead ends) → commit → push (`git push origin HEAD:main`).
6. Recuérdale al usuario revocar el PAT al final.
