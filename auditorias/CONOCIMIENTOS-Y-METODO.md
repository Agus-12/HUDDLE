# 🧠 CONOCIMIENTOS Y MÉTODO — HUDDLE + APP MOVIE

**Documento de traspaso completo.** Escrito el 19 de septiembre de 2026 por el chat que trabajó
con el usuario desde v217 hasta v226. Está pensado para que **otro chat continúe sin repetir nada**.
Contiene: qué sabemos (técnico), cómo se trabaja aquí (método), qué herramientas existen y
dónde, qué está descartado (para no repetirlo) y qué sigue.

> Regla de oro del proyecto: **no decir que algo funciona hasta verificarlo con una prueba real**.
> No presentar los 441 títulos como «catálogo completo». No presentar la reproducción como
> «completa» mientras falten pedacitos por la llave del CDN.

---

## 0) CÓMO REANUDAR EN 10 MINUTOS

1. Clonar el repo con el PAT que el usuario da **en el chat** (nunca escribirlo en archivos ni
   subirlo; el repo es público). Al final de cada sesión, recordar al usuario **revocar el PAT**.
2. Leer, en este orden:
   - `auditorias/CONOCIMIENTOS-Y-METODO.md` ← **este documento** (lo que sabemos y cómo trabajar).
   - `CONTINUACION.md` (últimas actualizaciones: cabecera y las 3-4 secciones de arriba).
   - `auditorias/INFORME-TECNICO-APK-Y-CATALOGO.md` (informe del otro chat).
   - `auditorias/REANUDACION-CHAT-CAPTURA-Y-AUDIO.md` (receta de captura y audio).
3. Verificar el estado del servidor en Oracle con el bloque 1 de la sección «Bloques típicos».
4. Mirar la sección «Qué sigue» (al final) antes de inventar plan nuevo.

Contexto humano: el usuario es hispanohablante, quiere **respuestas en español llano y cortas**,
sin jerga (una vez dijo que le hablaban «en otro idioma» por usar muchos tecnicismos).
No tiene SSH en la Mac: **no pedirle `scp`**. Cada bloque de comandos debe decir **dónde se pega**
(Oracle / navegador del teléfono / Mac). Prefiere que el agente haga el trabajo, no él.

---

## 1) LA MISIÓN Y LAS REGLAS DEL USUARIO

**Misión:** Huddle (servidor propio en Node) debe dar el catálogo de la app **Movie** con portadas
reales, **audio latino** y **reproducción estable y COMPLETA** («se tienen que ver bien y completas»).

**Reglas permanentes del usuario (no violar):**
- Respuestas **en español llano y cortas**.
- Repo: trabajar en el clon; tras cada avance, actualizar `CONTINUACION.md`, commit y **push a `main`**.
- **No subir al repo**: PAT, credenciales, `sslkeylogfile.txt`, PCAP, tokens, device IDs, APKs, capturas privadas.
- Capturas del teléfono: **PCAPdroid en local, sin el puerto 8080** (métodos viejos). El amigo sube
  desde el navegador del teléfono a las páginas del servidor.
- No presentar el catálogo como completo hasta que la reproducción funcione.
- No integrar «Amar y Cuidar» ni el id `feec4d1e85fe`.
- Mantener portadas **originales** del origen; usar `/carita.png` solo de respaldo.
- Si hay duda del audio, verificarlo (escucha o ASR) antes de marcarlo latino.

---

## 2) QUÉ HAY EN EL REPO (arquitectura actual)

- `server.js` — el servidor Huddle. Versión de interfaz `UI_VERSION` (van v221→v222→…). Contiene:
  proxy de flujos, catálogo Movie por apartados (`mapiSecciones()`, caché 10 min),
  `/api/movie/catalogo`, `/api/movie/v-vid` (espejo-primero → original), `/api/movie/espejos`,
  `/api/movie/disponibles` (v222: medición real de qué se ve), páginas `/subir`, `/captura`(≡`/pcap`),
  `/llaves`, subida por partes, `esStreamPropioUS` (reproducir nativos en sala y «Solo»).
- `public/app.js` — interfaz: `CATALOGOS.movie`, salto de huecos del reproductor (v220),
  barra «Se ven ahora: N completas / M a medias» y etiquetas por tarjeta (v222).
- `prueba-vNNN.js` — pruebas con puppeteer (correr desde la raíz del repo con el servidor en PORT=3999).
- `scripts/` — herramientas (ver sección 8).
- `auditorias/` — memoria, informes y la carpeta `crack/` con el análisis del APK y sus módulos.

**Oracle** (`~/huddle`, IP `129.80.212.92:3000`): servidor desplegado del usuario. Se actualiza con
`bash actualizar.sh`. Tiene las capturas del teléfono y el `sslkeylogfile.txt`.

---

## 3) LA API DEL SERVICIO (probado y verificado)

**Host principal:** `https://surfclick.vd7au6.com/api` (otros: `movievn.z3azky.com`, `albd.h4c5.com`,
espejos web `escc.k5ca.com` etc. — estos dos últimos son de la versión web).

**Cabeceras de la app (HTTP/2, okhttp):**
```
app_id: movievn ; version: 40000 ; sys_platform: 2
device_id: <el del teléfono o cualquiera>   ; channel_code: movievn_sh_1000
cur_time: <ms epoch>
sign: MD5("47Q8tBqO4YqrMHf4" + device_id + cur_time).toUpperCase()
token: <de public/init>   content-type: application/x-www-form-urlencoded
```
- **El `content-type` es obligatorio**: sin él el servidor devuelve el error chino
  `系统出问题啦~请稍后再试` y parece «caído». (Este error hacía fallar la sonda de
  `verificar_api.py`: se corrigió mandando también la cabecera `sign`.)
- **Las respuestas vienen en base64 y se descifran con AES-128-CBC**: clave `0123456789123456`,
  IV `2015030120123456`. (Constantes del protocolo, no tokens personales.)

**Token:** `POST /api/public/init` → `result.user_info.token`. Fórmula del cuerpo de `info_new`:
`sign = MD5("Zox882LYjEn4Rqpa" + device_id + vod_id + cur_time_ms).toUpperCase()`
(derivada y verificada contra 3 firmas reales capturadas al amigo).

**Endpoints útiles (todos POST, cuerpo formulario):**
| Ruta | Para qué |
|---|---|
| `/api/public/init` | token de invitado + `sys_conf` (incluye `p2p_config`) |
| `/api/type/get_list` | tipos: 1 Películas, 2 Novela |
| `/api/channel/get_list` | canales: 225 Inicio, 230 Telenovela, 226 Películas, 227 Series, 228 Animación |
| `/api/channel/get_info` | títulos de un canal (aquí salen los 441) |
| `/api/vod/info_new` | ficha + `vod_collection[]` con `vod_url` (m3u8 del CDN) |
| `/api/search/screen` | **búsqueda/filtros (ver sección 4: la vía del catálogo grande)** |
| `/api/search/hot_search` | ~10 títulos |
| `/api/search/recommend` | ~20 títulos |
| `/api/public/get_sys_conf` | config por clave (`p2p_config` da datos reales) |
| `/api/user_vod/get_list` | listas del usuario: `type=1`, `type=2` |
| `/api/invited/vod_share` | `vod_id=…&vod_from_id=0` |
| `/api/user_history/add`, `/api/data/action`, `/api/ad/get_list`, `/api/log/ad`, `/api/public/feedback`, `/api/barrage/get_list`, `/api/discuss/get_list_new` | telemetría/anuncios/comentarios (vistos en captura) |

**Ficha (`info_new`)**: `vod_collection[]` trae `id, title, collection, vod_url, type, duration,
vod_duration, is_p2p`. Regla de audio: `type 2` = doblaje/latino, `type 1` = subtitulado (usar 2
primero; si no hay, 1 y verificar). La API **no** entrega enlaces firmados: el `vod_url` es un
m3u8 sin firma.

---

## 4) EL CATÁLOGO GRANDE (los «70 000») — LO NUEVO Y MÁS IMPORTANTE

**Lo que ya sabíamos (y sigue siendo cierto):** con invitado, `channel/get_info` de los 4 canales
da 441 títulos únicos (159 Películas / 86 Telenovelas / 94 Series / 102 Animación). Probar
`page`, `offset`, `limit`, `page_no`, `pageindex`, `last_id`, etc. **no cambia nada** (10 nombres
probados). Tampoco funciona mandar `key/wd/keyword/search_key/story/name/q` como término.

**LO NUEVO (19-sep, leído del cuerpo real que manda la app en la captura descifrada):**
```
POST /api/search/screen
type_id=1&psize=6&is_random=1&area=94407&type=Terror%2FChoque
```
- **`psize`** = cuántos quiere (tope duro 20 por llamada; psize=200 sigue devolviendo 20).
- **`is_random`** = 1 azar / 0 fijo. En la práctica devuelve **el mismo conjunto** cada vez
  (probado 12 veces) → sirve para pedir «un bloque».
- **`type`** = **género en texto** (funciona en español CON acentos y en chino).
- **`area`** = número (visto 94407 y 114110; devuelve conjuntos distintos).
- **`page` sigue sin funcionar** (con o sin azar).

**El hallazgo práctico:** **barrer géneros devuelve títulos NUEVOS**. Prueba hecha desde el taller:
sweep de 45 nombres de género sobre `type_id=1` → **221 títulos distintos en 17 segundos**
(empezando de 20). Géneros que respondieron: Acción, Comedia, Terror/Choque, Drama, Suspenso,
Animación, Aventura, Fantasía, Guerra, Familia, Historia, Deportes, Accion/Comedia, 恐怖, 科幻,
犯罪, 纪录片, 奇幻, 悬疑, 剧情, 惊悚, 音乐, 家庭, 历史. (Romance, Bélica, Crimen, Documental,
Fantasía, Musical, Misterio, Thriller, Anime dieron 0: **probar las variantes chinas**).
Números de género en chino ya verificados que dan títulos: 恐怖 (terror), 科幻 (ciencia ficción),
犯罪 (crimen), 纪录片 (documental), 奇幻 (fantasía), 悬疑, 剧情 (drama), 惊悚, 音乐 (música).

**Camino recomendado para el catálogo completo:**
1. Sacar la lista de géneros de la propia app: `get_sys_conf` devuelve `vod_tags` (chino) y la
   app usa etiquetas en español; ampliar la lista con variantes (con acento / sin / chino).
2. Barrer **género × área × type_id (1 y 2)**; deduplicar por `id`; guardar en JSON
   (script listo: `auditorias/crack/cosechar-generos.py`).
3. Confirmar el tope real: si un barrido completo se estanca, el techo del invitado es menor que
   70k y hará falta **cuenta** (la del amigo) — su token se puede probar en el mismo script.
4. Verificar con la captura: `python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap --paths=screen`
   muestra qué manda la app exactamente al abrir cada pantalla del catálogo.

---

## 5) LA REPRODUCCIÓN (el muro de la llave) — ESTADO EXACTO

**Cómo salen los videos:** `vod_url` = `http://movievn.j5t2n.com/vod/1/{año}/{mes}/{día}/{id12}/index5.m3u8`.
La lista trae los pedacitos con `?sz=<bytes>&m8=<8 bytes>`. El player **firma cada petición**:
`wsSecret=MD5(llave + ruta + wsTime)&wsTime=hex(segundos)` (plantillas exactas halladas en el módulo
del reproductor: `%s%s%x` → `wsSecret=%s&wsTime=%x`; variantes `%u`, `%s-%d-%d-%d-%s` de Wangsu
adaptativo y las de CloudFront).

**Lo que funciona hoy sin llave:**
- El **espejo `147.124.216.142`** sirve **solo lo que tiene en memoria** (caché **dinámica**:
  un objeto puede pasar de 403 a 200 y viceversa). Su memoria **rota**: carpetas que ayer estaban
  completas hoy dan 403 hasta el playlist.
- Prueba en vivo (19-sep): el token capturado el 16-sep **seguía dando 200** → los pases
  **duran días**, no horas. Están **amarrados al archivo**: el mismo pase sobre otro `.ts` da 403.
- **Cada archivo lleva su propio pase** (192 archivos → 192 pases distintos en la captura grande).
  Un mismo archivo re-pedido lleva pase nuevo con `wsTime` nuevo.
- El reproductor **firma igual para el espejo** que para la nube principal (visto en la captura).
- Pedir **otros bordes CloudFront** (140 IPs) no sirve: ninguno tenía pedacitos fríos.
- `?c=getts` (ruta interna del SDK para pedir la hora) sobre el CDN devuelve el mismo m3u8: no firma.

**Por qué no hemos sacado la llave (todo probado, sin resultado):**
- **605 millones** de tramos de bytes de los módulos (C compilado, `barrido_llave.c`).
- **480 661** cadenas del APK/módulos × 6 muestras × 3 rutas × 13 formas (`probar_wssecret_multi.py`).
- 3 208 claves derivadas de la propia dirección; 443 derivadas de constantes (cortes de la `ck`,
  MD5 de datos conocidos); matriz MD5/SHA1/SHA256/HMAC × 13 llaves × 15 formas.
- Encabezados del reproductor (Badci, Referer, Origin, UA, XFF), HTTPS, firmas falsas → 403 siempre.
- Los 8 endpoints de la API: ninguno entrega enlace firmado (`error1`).
⇒ **La llave no está en el APK como texto ni se deriva de nada conocido: es aleatoria y vive dentro
del motor interno del SDK (entra por un servicio de configuración en tiempo de ejecución).**

**Lo que falta por probar (en orden de valor):**
1. **Descifrar la captura y ver si `get_sys_conf`/`vod_share` traen material de llave** (herramienta lista).
2. **Terminar el emulador del otro chat** (`emu_hls.py`): corre, pero termina en «métodos nativos
   registrados: 0». Falta completar el `JNIEnv` de juguete (`FindClass`/`GetStaticMethodID`).
   Alternativa equivalente: **correr la función de firma del módulo con la configuración viva** y
   ver si reproduce la firma capturada (la función está localizada: ~`0xcc1xx–0xccad4`; el hash es
   un import de la VM; tabla K de MD5 en `0x229af0`).
3. **Frida sobre un Android con root** en `/control?msg=verify` (si aparece un teléfono rooteado).

---

## 6) LA APK (todo lo que sabemos por dentro)

- App: **`com.movievn.cinevi`** («Movie», v4.0.0). APK: `https://app.r2c7a0.com/version/movievn/movievn_sh_1000-V4.0.0.apk`
  (56 977 665 B). Extraer a `/home/user/apk-trabajo/` (no se sube al repo).
- Reproductor: **Wangsu PPHLS** (`com.pp.hls` con métodos nativos `load(...)` y `exec(...)`) con
  **P2P activado** (`is_p2p=1`). P2P = aceleración (tracker `47.253.51.203:7202`); el espejo hace
  innecesario el P2P.
- Protección: **360 Jiagu** (`libjiagu_sdk_pp_hlsProtected.so` + `assets/pp_hlsProtected.dat`,
  27 097 B, magic `*#*#0123456789ES9876543210#*#*`). Es un **candado de textos**: `pp_hlsProtected.a(0)`
  devuelve el nombre de librería que se carga al arrancar; el `.dat` es la tabla de textos cifrados.
- El código Java **sí es legible** (jadx): los `dex` no están cifrados. El `.mips` dentro de
  `libpp_hls.so` (1,5 MB, entropía 7.9999) y el módulo de Jiagu **sí** están cifrados; el otro chat
  logró inflarlos (`pphls_elf_interno.so`, `jiagu_modulo_vivo.bin` en `auditorias/crack/`).
- **Los dominios del servicio NO están escritos en el APK** (ni en dex ni en assets): se arman en
  ejecución (probablemente desde la tabla protegida o la config remota). Igual pasa con la llave.
- SDK de anuncios: **oktdata.com** (`com.yk.e`, hosts `sdkapi-ga.biggogo.com`, `sdkapi-ga.smallyy.com`),
  con su propio AES (`QwEr12TyUi!@Op34AsDf#$GhJk56L%^Z`) — **no sirve** para la firma del CDN.
  Ojo: `sdkapi-ga.*` responde 403 sin credenciales.
- La app **ignora el proxy** (WiFi+mitmproxy no ve el contenido; solo el POST `upgrade`). **PCAPdroid
  con VPN sí lo ve todo**. El certificado mitmproxy ya está instalado en el teléfono del amigo y el
  okhttp de la app acepta CAs de usuario.

---

## 7) LAS CAPTURAS Y EL DESCIFRADO TLS (lo que abrió el muro)

En Oracle hay 4 capturas (todas con PCAPdroid, sin 8080):
`captura-movie.pcap` (667 MB), `captura-sintls.pcap` (220 MB), `captura-sign.pcap` (116 MB),
`captura-nueva.pcap` (41 MB) + **`~/sslkeylogfile.txt`** (641 sesiones).

**Hecho medido:** el keylog **descifra la captura**. Con `scripts/descifrar-https.sh` se ven:
- HTTP/1.1 del video: los `.ts`/`.m3u8` firmados hacia `movievn.j5t2n.com` y hacia el espejo.
- **HTTP/2 de la API (antes invisible)**: `info_new` (3), `get_sys_conf` (3), `search/screen` (2),
  `channel/get_info` (2), `channel/get_list`, `recommend`, `hot_search`, `user_vod/get_list` (2),
  `user_history/add` (3), `invited/vod_share` (3), `user/info`, `public/upgrade`, `data/action`,
  `ad/get_list`, `log/ad` (38), `public/feedback` (13), `barrage/get_list`, `discuss/get_list_new`.

**Cuerpos reales vistos (19-sep):**
- `info_new`: `sign=…&vod_id=562930699&cur_time=…&audio_type=0` (igual que los nuestros ✔).
- `search/screen`: `area=94407&psize=6&is_random=1&type_id=1&type=Terror%2FChoque` (¡la clave!).
- `get_sys_conf`: `conf_key=ad_appid` y `conf_key=p2p_config`, **a veces con el valor ofuscado**:
  `conf_key=<valor>SHOK<base64>SHOK<base64>` — la app envuelve valores en un esquema propio
  (marca `SHOK`, varios bloques base64). **Pendiente: descifrar ese envoltorio** (candidato: AES del
  SDK o el propio `ck`; probar longitudes y el patrón `SHOK`).
- `user_vod/get_list`: `type=1` / `type=2`. `invited/vod_share`: `vod_id=…&vod_from_id=0`.
- `m3u8` descargados: `#EXTM3U…#EXTINF…0000.ts?sz=…&m8=…` (y pedacitos MPEG-TS con cabecera
  `FFmpeg  Service01`).

**Cómo capturar de nuevo (si hace falta):** PCAPdroid en el teléfono, **sin 8080**, con Descifrado
TLS + regla para Movie, capturar y exportar `.pcap` + `sslkeylogfile.txt`; subir el PCAP a
`http://129.80.212.92:3000/captura` y las llaves a `.../llaves` desde el navegador del teléfono.

---

## 8) HERRAMIENTAS (todas dentro del repo)

| Herramienta | Para qué | Cómo se corre |
|---|---|---|
| `scripts/descifrar-https.sh` | abre el HTTPS de una captura con el keylog: rutas HTTP/1.1 y HTTP/2, cuerpos y rastros | `bash scripts/descifrar-https.sh ~/captura-sign.pcap` (necesita `tshark`) |
| `scripts/ver-llamadas-app.py` | **por llamada: lo que la app ENVÍA y lo que RECIBE (descifrado)**; se adapta a la versión de tshark | `python3 scripts/ver-llamadas-app.py ~/captura.pcap --paths=info_new,screen` |
| `scripts/minar-capturas.sh` | saca TODAS las URLs firmadas y rastros del SDK de una captura; guarda `~/muestras-wssecret.json` | `bash scripts/minar-capturas.sh ~/*.pcap` |
| `scripts/analizar-capturas.sh`→`.py` | servidores TLS (SNI), Host, `getts`, listas m3u8 con `EXT-X-KEY`, firmas repetidas | `python3 scripts/analizar-capturas.py ~/captura-movie.pcap` |
| `scripts/ver-urls-cdn.py` | qué URLs pidió el teléfono (ruta + parámetros) y cómo le fue (200/403) | `python3 scripts/ver-urls-cdn.py ~/captura.pcap` |
| `auditorias/crack/probar_wssecret_multi.py` | probador **offline** de la llave con muestras reales (rápido; `--derivadas` incluye claves sacadas de la URL) | `python3 auditorias/crack/probar_wssecret_multi.py ~/muestras-wssecret.json --derivadas` |
| `auditorias/crack/barrido_llave.c` | barrido de **cada tramo de bytes** como llave (compilado, usa OpenSSL) | `gcc -O2 -o barrido_llave barrido_llave.c -lcrypto && ./barrido_llave <archivos>` |
| `auditorias/crack/rastrear_firma.py` | rastrea el código que arma la firma en el módulo (Capstone, ADRP+ADD con `immlo` bien decodificado) | `python3 auditorias/crack/rastrear_firma.py pphls_elf_interno.so` |
| `auditorias/crack/info_new_vivo.py` | llama la API en vivo (token, sign, AES) | `python3 auditorias/crack/info_new_vivo.py 711142488` |
| `auditorias/crack/ver_sysconf.py` | pide `public/init` y muestra `sys_conf` completo | `python3 auditorias/crack/ver_sysconf.py` |
| `auditorias/crack/verificar_api.py` | salud del backend + probar firmas | `python3 auditorias/crack/verificar_api.py --probar` |
| `auditorias/crack/cosechar-generos.py` | **cosecha el catálogo barriendo géneros/áreas** (nuevo, sección 4) | `python3 auditorias/crack/cosechar-generos.py > ~/catalogo-generos.json` |
| `auditorias/crack/emu_hls.py` | emulador Unicorn del reproductor (del otro chat): corre, no registra nativos | `python3 auditorias/crack/emu_hls.py --budget 200` (necesita `pyelftools capstone unicorn`) |
| `prueba-vNNN.js` | pruebas de interfaz con puppeteer (servidor en PORT=3999) | `PORT=3999 node server.js &` y luego `node prueba-v222.js` |

**Detalle importante de entorno:** el taller del agente **se reinicia entre sesiones largas** y con él
se pierden `/tmp`, los programas instalados (tshark, jadx, unicorn) y la carpeta `.git` del clon.
Los archivos del repo y `~/apk-trabajo/` sí sobreviven. Si algo falla con «no such file», reinstalar:
`sudo apt-get update && sudo apt-get install -y tshark nghttp2-server`, `pip install pyelftools capstone unicorn pycryptodome`.

---

## 9) DESCARTADO — NO REPETIR (costó horas)

1. **Buscar la llave en el PCAP viejo** (`captura-nueva.pcap`): agotado con 2 herramientas (texto y bytes).
2. **Fórmulas y llaves ya probadas**: ver sección 5. Cualquier «nueva» candidata debe pasar por
   `probar_wssecret_multi.py` **antes** de decir que sirve.
3. **Paginación de la API** por `page/offset/limit/…`: no existe; el camino es **género/área** (sección 4).
4. **URL firmadas por la API**: no las entrega; no insistir.
5. **Otros bordes CloudFront** (60 y 140 IPs probadas): no tienen los fríos.
6. **Encabezados mágicos** (Badci, Referer, Origin, XFF, UA), HTTPS, firmas falsas: 403.
7. **`?c=getts`** sobre el CDN: devuelve la lista, no un servicio de hora.
8. **SDK de anuncios** (oktdata / `sdkapi-ga.*`): es de publicidad; su AES no firma el CDN.
9. **Frontales de otras marcas** (`idbbu`, `phbbu`, `frbbu`, `ptbbu`): mismo marcador `freecine.cn`.
10. **Proxy WiFi + mitmproxy contra la app**: el cliente de contenido lo ignora. Usar PCAPdroid.
11. **Medir el espejo en paralelo**: da falsos 0 %. Medir en serie o con pausas. Y **re-verificar**
    un «frío» (la caché es dinámica: un 403 puede volverse 200).
12. **`/vod/1/2026/09/02/4acbae6998e7/0020.ts`** está caliente: no usarlo como control de frío.
13. **No comparar el `.dat` con `libjiagu...so` byte a byte**: el `.elf` del `.dat` (magic `69 00 00 d7`)
    es dato binario, no código.
14. **La vía web** (`info_web_get`) devuelve `vod_url = https://www.freecine.cn/` (marcador, no stream).

---

## 10) MÉTODO DE TRABAJO (cómo trabaja este agente; sirve para el siguiente)

1. **Primero el taller, después el usuario.** Todo lo que se pueda probar sin red o con pruebas
   sintéticas se prueba aquí; al usuario se le piden solo bloques ya verificados (probados con
   capturas falsas o sesiones locales).
2. **Cada bloque dice dónde se pega**: **ORACLE** (servidor del usuario), **navegador del teléfono**
   (subidas) o Mac. Nunca pedir `scp`.
3. **Verificar antes de afirmar**: si una herramienta da un resultado raro (p. ej. «backend caído»),
   sospechar de la herramienta primero (pasó: faltaba la cabecera `sign`, y el `content-type`).
4. **Enmascarar secretos** en todo lo que se imprime o sube (pases, tokens, device ids). Los PCAP y
   el keylog **nunca** van al repo.
5. **Medir en serie** contra el espejo; en paralelo da falsos negativos.
6. **Escritura de archivos**: usar herramientas de archivo (no scripts embebidos con comillas) para
   textos largos; así se evitan los errores de escapado que ya rompieron un script.
7. **Cada avance**: `CONTINUACION.md` + commit + `git push origin HEAD:main`. Si el push es rechazado,
   hay trabajo de otro chat: `git fetch` + `merge` y reintentar.
8. **Verificar el commit remoto** antes de repetir trabajo (el otro chat publica cosas).
9. **Probar los scripts con datos sintéticos** (PCAP falsos, respuestas cifradas de prueba) antes de
   pedirle al usuario que los corra en Oracle. Ya se hizo con: visor de URLs, minero, analizador,
   descifrador (con una sesión TLS real) y lector de llamadas (con HTTP/2 real y respuesta cifrada).
10. **Cuando algo no cede**: anotar el resultado exacto en «Descartado» y cambiar de ángulo
    (así aparecieron: el keylog, el cuerpo real de `search/screen`, los géneros).

---

## 11) QUÉ SIGUE (plan priorizado, 19-sep noche)

1. **Catálogo (abierto, en curso)**: barrer géneros/áreas con `cosechar-generos.py`; ampliar la lista
   de géneros (español con acentos + chino) y confirmar el techo del invitado. Comparar contra los
   441 y contra el total que declare la app. Si se estanca: probar el token del amigo (cuenta).
2. **Llave del CDN (muro)**: descifrar el envoltorio `SHOK` de `get_sys_conf` (cuerpos de la captura
   descifrada) y completar el emulador (`JNIEnv` de juguete) o correr la función de firma con la
   configuración viva.
3. **Reproducción**: con la llave, firmar en Huddle (`MD5(llave+ruta+wsTime)`) y verificar
   inicio/mitad/final de un título. Sin llave, seguir usando el espejo + salto de huecos (v220) y
   avisar al usuario qué se ve y qué no (v222).
4. **Audio latino**: escucha/ASR de muestras de `type 2` antes de marcarlo latino.
5. **Portadas**: mantener las originales; `/carita.png` de respaldo.
6. **Interfaz**: el catálogo de Huddle ya se pagina solo (24 por página) y muestra disponibilidad;
   cuando llegue el catálogo grande, revisar el rendimiento de `mapiSecciones()`/caché.

---

## 12) PREGUNTAS FRECUENTES DEL USUARIO (respuestas cortas ya dadas)

- **¿Por qué se ve «por pedacitos»?** Porque el video vive en el CDN del origen y solo se suelta lo
  que está en la memoria del espejo; lo demás pide un pase firmado con una llave que el teléfono
  calcula por dentro.
- **¿Por qué no están los 70 000?** Porque la API de invitado solo entrega bloques fijos; las filas
  públicas dan 441. El camino nuevo (géneros/áreas) los va sumando; si no alcanza, hace falta cuenta.
- **¿Hace falta molestar al amigo otra vez?** No por ahora: con las 4 capturas y el keylog hay
  material para rato. Solo si se necesita una captura nueva de algo concreto.
- **¿El audio es latino?** Se marca `type 2` como doblaje y se verifica con escucha/ASR en caso de duda.
