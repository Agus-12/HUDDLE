# 🧠 ARCHIVO DE CONTINUACIÓN — HUDDLE + APP MOVIE

## 🚀 EMPIEZA AQUÍ (nuevo chat: haz esto EN ORDEN, sin saltar nada)
1. **Clona el repo** (el PAT te lo da el usuario en el chat, NUNCA está en este archivo porque el repo es público): `git clone https://{PAT}@github.com/Agus-12/HUDDLE.git ~/huddle`
2. **Lee ESTE archivo completo** + `auditorias/hallazgos-cdn.md` + `auditorias/RESUMEN-COSECHA-PCAP.md` (el mapa con carpetas por novela/episodio).
3. **Trabaja SIEMPRE dentro del clone del repo** (`~/huddle`). EL REPO ES EL WORKSPACE OFICIAL del proyecto — nada de trabajo importante fuera de él. Así el contexto del chat no se satura: el estado REAL siempre está aquí, en archivos.
4. La **acción pendiente de este momento** está en §2 "📋 SIGUIENTE PASO" (al día: la integración de las 5 rutas latinas en Huddle YA está hecha en el server (v207) — falta que el usuario corra `actualizar.sh` + genere el mapa + pegue la salida de `/api/movie/probar`).
5. **Después de CADA avance o cambio** (sin excepción): actualiza este archivo (estado, hallazgos, dead ends) → `git add -A` → `git commit -m "..."` → `git push origin HEAD:main`. El usuario recibe los cambios en su servidor con `bash actualizar.sh`.
6. Si el sandbox se resetea a media sesión (pasa: borra .git, node_modules, paquetes, archivos grandes): re-clona o recupera con `git init + git fetch origin + git reset --hard origin/main`, reinstala lo que falte y SIGUE. Nunca empieces de cero: todo lo importante vive aquí.

> **PARA EL CHAT QUE RECIBA ESTE ARCHIVO:** Este archivo es la memoria del proyecto: el chat anterior lo dejó actualizado y TÚ debes dejarlo más actualizado aún. **Regla de oro 1: después de cada avance, actualiza este archivo y súbelo al repo. Regla de oro 2: el repo es el workspace — trabaja desde el clone, no desde archivos sueltos. El workspace del chat NO persiste; el repo SÍ.**
> **PARA EL CHAT QUE RECIBA ESTE ARCHIVO:** Lee esto COMPLETO antes de responder nada. Este archivo es la memoria del proyecto: el chat anterior lo dejó actualizado y TÚ debes dejarlo más actualizado aún. **Regla de oro: después de cada avance o cambio, actualiza este archivo y súbelo al repo (git commit + push). Nunca dejes el trabajo solo en tu workspace — el workspace NO persiste entre chats; el repo SÍ.**

---

## 1. QUIÉNES Y QUÉ (contexto humano)

- **Usuario:** en Monterrey, México. No es técnico — habla con palabras simples, sin jerga. Le gustan mensajes con pasos claros y bloques copy-paste listos para pegar en su servidor.
- **Su servidor:** Oracle Cloud gratis, Ubuntu, IP pública **129.80.212.92**, corre Huddle en puerto 3000. El usuario administra por terminal desde una **Mac SIN SSH** → todo va en bloques copy-paste que él pega vía la app de Oracle (Cloud Shell / consola web) y luego ME PEGA LA SALIDA. macOS 12.7.6.
- **Su amigo:** tiene el Android con el app **Movie** (piratería, contenido latino: películas y novelas) y hace las pruebas de campo con PCAPdroid (versión Google Play). El amigo NO es técnico: instrucciones cortas tipo receta, por WhatsApp, en español simple.
- **La misión:** integrar en Huddle (servidor personal del usuario) TODO el contenido del app Movie: catálogo + streams reproducibles de películas y novelas. Huddle es un servidor web propio (Node, sin frameworks raros, SOLO HTTP puro — nada de HTTPS en el server local).

## 2. ESTADO DEL PROYECTO (17 sep 2026)

### 📡 CAMBIO DE MÉTODO OBLIGATORIO (19 sep): **EL PROXY DE WiFi NO SIRVE — el app lo ignora**

Confirmado por el amigo: **con el proxy de WiFi puesto, el app Movie reproducía video
normal.** Es decir, el app hace sus peticiones por un camino que **ignora el proxy del
sistema**. Por eso en las **tres** capturas con mitmproxy cayó siempre lo mismo: una sola
llamada (`POST /api/public/upgrade`, respuesta `code:10000`) y nunca el `info_new`.

Las 3 capturas (18-sep 07:33, 07:34 y 07:46) son idénticas en eso. El proxy de WiFi queda
**DESCARTADO** para atrapar el `info_new`. No volver a intentarlo.

**✅ Lo que sí quedó confirmado cuatro veces:** la fórmula de las cabeceras reproduce la
firma real de las cuatro capturas hechas hasta ahora:

| fecha (UTC) | sign real | `MD5('47Q8tBqO4YqrMHf4'+dev+ts).upper()` |
|---|---|---|
| 15-sep 23:44:24 | `A526BDCB05C2CD7AE5EF38D96E56687F` | coincide |
| 18-sep 07:33:15 | `9EBD0276525BF792F7E2CB50796B779E` | coincide |
| 18-sep 07:34:01 | `73A9C8A5AAF25B13C97A3629813BF72A` | coincide |
| 18-sep 07:46:37 | `4815E4E9258C6B7333A2C3FB7E64081E` | coincide |

**🚫 Descartado también: que la diferencia sea el `token`.** Con el `device_id`, la
fórmula y el `token` **exactos** del teléfono (`gAAAAABqqSpPhjbhvV8e…`), `public/init`
desde fuera sigue dando `系统出问题啦~请稍后再试` mientras al teléfono le da `code:10000`.
Parece un filtro por origen o por huella TLS. **Consecuencia: no se puede verificar
ninguna fórmula desde el servidor; hace falta la captura.**

**➡️ Nueva vía: PCAPdroid con descifrado TLS + TCP Exporter.** Captura a nivel de VPN, así
que ve el tráfico aunque el app ignore el proxy. Es el método que ya funcionó en ese
teléfono (de ahí salió el PCAP de 636 MB con los manifests). Receta completa:
**`auditorias/captura-pcapdroid-RECESTA.md`**. El recibidor es `recibidor-pcap.js`
(modo `tcp`, puerto 8080). **OJO:** usar `PCAP_OUT=/home/ubuntu/captura-sign.pcap` para
NO pisar el PCAP viejo de 636 MB.

**Estado del rastreador:** la API web (`albd.h4c5.com/api/vod/info_web_get`) también está
dando el error chino, así que el rastreador se dejó APAGADO a propósito: con la API caída
no guarda nada (exige `vod_name` o `vod_collection`, línea 135 de `catalogo-movie.js`, así
que **el catálogo no se contaminó**: 0 fichas sin nombre ni sin portada). Revivirlo solo
cuando `verificar_api.py` dé luz verde. Último avance real: **28 463 fichas, id 65 272**.

### 🎯🎯🎯 CORRECCIÓN MAYOR (18 sep, madrugada del 19): **EL 3er TROZO DEL SIGN NO ES `ck`, ES `device_encrypt_key` = `Zox882LYjEn4Rqpa`**

Todo lo anterior que decía *"sign = md5(device_id + ts + ck)"* estaba **MAL**. El error: se
leyó `ldr x2,[x2,#0x38]` en el handler `verify` y se asumió que `0x38` era el `ck`. No lo es.

**Cómo se corrigió (evidencia, no suposición):** dentro del módulo hay una función que
**IMPRIME la config campo por campo** (`0xb55f4`, formatos en `.rodata` `0x22ba48`–`0x22bd30`).
Sus `ldr x2,[x21,#N]` emparejados con cada formato dan el mapa real de la struct:

| offset | campo | formato |
|---|---|---|
| `[cfg+0x00]` | `player_listen_port` | `%lld` |
| **`[cfg+0x38]`** | **`device_encrypt_key`** | **`%s`** ← el que usa el sign |
| `[cfg+0x40]` | `ck` | `%s` |
| `[cfg+0x48]` | `ck_t` | `%lld` |
| `[cfg+0x50]` | `ck_p` | `%lld` |
| `[cfg+0x68]` | `ck_tt` | `%lld` |
| `[cfg+0x70]` | `cci` | `%lld` |
| `[cfg+0xa0]` | `cellular_net_upload_enable` | `%lld` |
| `[cfg+0xa8]` | `backup_domain` | `%s` |
| `[cfg+0xb0]` | `resource_md5_prefix` | `%s` |

Y el **valor**, encontrado en texto plano: el módulo de `libpp_hls` trae **toda la config por
defecto embebida** en `auditorias/crack/pphls_mips_inflado.bin`, offsets **`0x31efd9`–`0x31f6c5`**
(1772 bytes, formato `clave=valor\n`, secciones `[BASE]` y `[P2P]`). Entre otras cosas:
```
player_listen_port=7000
device_encrypt_key=Zox882LYjEn4Rqpa          ← EL TERCER TROZO DEL SIGN
ck=92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7
ck_t=1  ck_p=0  ck_e=10  ck_tf=16  ck_tt=999  cci=-1
nurl=http://fxuo.386m1.com/nft/get_info
p2p_tracker_addr=138.113.22.150:7202
p2p_stunserver_addr=stun.syncthing.net
disk_cache_size_max=9663676416
```
**Corroboración de que el mapa está bien leído:** el `ck` de esta config por defecto es
**idéntico** al que llegó vivo en `public/init` → `sys_conf.p2p_config`
(`92b991…d291c7`). Si los offsets estuvieran corridos, no coincidiría.

⇒ **Fórmula probable del sign del cuerpo, ahora con el secreto correcto:**
```
sign = md5( device_id ‖ cur_time ‖ "Zox882LYjEn4Rqpa" )   → hex, 32 caracteres
```
**Sigue sin poder verificarse en vivo** porque el backend está caído (ver bloque ⛔). Es el
primer candidato en `resolver_sign.py`; en cuanto la API responda o llegue la captura, se
confirma en segundos. Esto **explica por qué fallaron las 440 variantes**: todas usaban `ck`
u otros secretos, ninguna usaba `Zox882LYjEn4Rqpa` (que no se conocía).

**Lección:** cuando un binario tiene una función que *imprime* su propia configuración, esa
función ES el mapa de la struct. Buscarla antes que adivinar offsets. Y nunca afirmar un
offset sin una segunda fuente que lo corrobore.

### 📸 FOTO FIJA — 18 sep, fin de sesión (leer esto primero si llegas de otro chat)

**Dónde estamos:** el catálogo está rastreado (≈27 000 fichas de 650 000 ids recorridos,
en curso) pero **ninguna tiene URL de video**: la API devuelve un placeholder. Lo único que
da las URLs reales es el `sign` del POST `/api/vod/info_new`, que firma el código nativo.
Ese es EL candado y todo lo demás es secundario.

**Lo que está CERRADO y probado (no volver a dudar de esto):**
1. **Fórmula de las cabeceras de la API — verificada contra una captura real del teléfono:**
   `sign = MD5('47Q8tBqO4YqrMHf4' + device_id + cur_time)` en **mayúsculas**.
   Prueba: `MD5('47Q8tBqO4YqrMHf4'+'3736e27f0823b1ba'+'1789515864447').upper()`
   = `A526BDCB05C2CD7AE5EF38D96E56687F` = el `sign` real capturado. Coincidencia exacta.
2. **Descifrado de respuestas:** base64 → AES-128-CBC, key `0123456789123456`, IV `2015030120123456`.
3. **Cifrado de las libs:** RC4 con PRGA no estándar (`i+=2`, `j=S[i]+j+1`, `k=S[(a+b)&0xff]`),
   S-box capturado en `auditorias/crack/rc4_sbox_1.bin`. Formato `u32 LE (tamaño final) || zlib`.
   Sirve igual para `libjiagu` y para `libpp_hls`.
4. **Dentro del módulo de `libpp_hls` hay un ELF AArch64 completo** en el offset `0x50429`
   → `auditorias/crack/pphls_elf_interno.so`. Ahí está el servidor de control del SDK.

**Lo que NO está resuelto (el candado):**
- El `sign` del **cuerpo** del POST `info_new` lo calcula el nativo. Del código se lee
  `sprintf("%s%s%s", device_id, ts, cfg[0x38])` → hash → hex de 16 bytes, pero **el valor de
  `cfg[0x38]` (el `ck`) no se pudo confirmar** y la fórmula no se pudo verificar en vivo.
- **Motivo: el backend del app está CAÍDO.** `POST /api/public/init` con sign correcto y
  verificado devuelve `系统出问题啦~请稍后再试` en `surfclick.vd7au6.com`,
  `movievn.z3azky.com` y `albd.h4c5.com`; los demás hosts dan 403. Comprobado de nuevo al
  cierre de esta sesión (18 sep, noche).
- **Regla: si `public/init` con sign conocido no devuelve `code:10000`, NINGUNA prueba de
  fórmula significa nada.** Las 440 variantes probadas el 18-sep NO están descartadas.
- Candidatos a `ck` ya listados (ninguno confirmado): `92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7`
  (leído de `p2p_config` en una respuesta real de `public/init`), `87c2cb7ff568d602d5f806c473345600`,
  `47Q8tBqO4YqrMHf4`, `de304f03fe653f329edfea08ea2046c4`, `1be0ac56`,
  `6A21635498FB7F1E13648270050E1346E`, `6BE2FB29B23E42031B1900D85E0756B75` (esta última
  encontrada en `classes7.dex`, sin probar).

**🔴 ACCIÓN PENDIENTE, bloqueada en el usuario:**
Capturar **un `info_new` real** del teléfono del amigo. El `sign` viaja en el **cuerpo del
POST**, que sí es tráfico de internet y sí se descifra (el app Android acepta CAs de usuario;
el iOS tiene pinning y no sirve; el emulador Android lo detecta jiagu y se cierra).
- Receta completa y al día: **`auditorias/captura-sign-RECESTA.md`** (paso 1 Oracle,
  paso 2 mensaje de WhatsApp, paso 3 recolección, paso 4 apagar).
- Capturador: **`auditorias/captura_sign.py`** — guarda cada flujo a `~/captura-sign.jsonl`
  **incluido el cuerpo del POST**, que es donde vive el `sign`. (El capturador viejo
  `captura_ss.py` NO lo guardaba; por eso la captura del 15-sep no sirvió.)
- **El proxy DEBE arrancarse con `ulimit -n 65536`** o se satura solo con bots de internet
  y la captura sale vacía (pasó el 18-sep, `capturadas: 0`). Detalles en la receta.
- **Con una sola terna `(device_id, cur_time, sign)` real** se resuelve el `ck` por fuerza
  bruta local en segundos y se valida la fórmula. Y de la misma captura caen las URLs de
  video reales, sin depender del candado.

**Estado del servidor del usuario (129.80.212.92):**
- Huddle en `:3000` → 200 ✔. Novelas externas ocultas (v208). Lacartoons arreglado (v209).
- Proxy mitmproxy en `:8080` con el capturador nuevo y `ulimit 65536` → `proxy -> 200` ✔
  (comprobado desde fuera al cierre de la sesión).
- `~/captura-sign.jsonl` **aún no existe**: el amigo hizo una prueba pero el proxy estaba
  saturado y no se capturó nada. Hay que repetirla.
- El cert mitmproxy del teléfono del amigo es del 15-sep y sigue siendo el mismo que sirve
  el server → no necesita reinstalarlo.

**⚠️ ROLLBACKS DEL SANDBOX (van 15).** El patrón es siempre el mismo y ya no debe asustar:
`git log` muestra un HEAD viejo (típicamente `244e3b5`) y `git status` lleno de cambios, pero
**el remoto tiene todo y los archivos del working tree sobreviven**. Receta fija:
```bash
cd ~/huddle && git fetch -q "https://{PAT}@github.com/Agus-12/HUDDLE.git" main && git reset --hard FETCH_HEAD
```
Después **verificar con `grep -c` que las ediciones nuevas siguen en el archivo** antes de
dar por hecho que están: en esta sesión se perdieron dos veces ediciones ya hechas.
Nunca `push` sin comprobar antes que el remoto es ancestro del HEAD local.

**🧰 HERRAMIENTAS NUEVAS (18 sep, ya probadas):**
- **`auditorias/crack/resolver_sign.py`** — el que abre el candado. Con UNA terna real
  `(device_id, cur_time, sign)` prueba en local todas las combinaciones de secreto, orden y
  hash hasta reproducir ese sign exacto. Lee directo el `~/captura-sign.jsonl` de la captura.
  Uso: `python3 resolver_sign.py --jsonl ~/captura-sign.jsonl`
  (o `--dev/--ts/--sign` a mano; `--extra-secreto` para candidatos nuevos).
  Probado con 4 casos: ck conocido en minúsculas ✔, en mayúsculas ✔, ck desconocido →
  falla limpio y explica el siguiente paso ✔, ck pasado por `--extra-secreto` → resuelve ✔.
  También probado leyendo un JSONL sintético con registros basura (ignora los que no son
  `info_new` y los incompletos sin caerse) ✔.
- **`auditorias/crack/verificar_api.py`** — ¿el backend está vivo? Manda `public/init` con un
  sign que SABEMOS correcto y solo da luz verde si vuelve `code:10000`. Sale con código 1 si
  está caído. **Correrlo SIEMPRE antes de probar fórmulas.** Al cierre de la sesión: caído en
  los 6 hosts (3 dan el error chino, 3 dan 403). Con `--probar` corre la batería de fórmulas,
  pero solo si antes dio ✅. Su AES es el mismo código verificado que el del addon.

**Rastreador del catálogo:** `node catalogo-movie.js` (reanudable, checkpoint en
`auditorias/catalogo-web/checkpoint.json`). Al cierre: **27 160 fichas**, siguiente id 62 295
de 650 000. Se muere con cada rollback del sandbox: revivirlo y seguir.


### 🩺 CAPTURA (18 sep, noche): **POR QUÉ LA CAPTURA DEL AMIGO SALIÓ VACÍA — el proxy se saturaba solo**
El amigo hizo la prueba completa (proxy manual + abrir fichas) y el resultado fue
`capturadas: 0` / `no hay archivo de captura`. Diagnóstico en vivo desde el servidor:
```
PID mitmdump: 119076 | limite de archivos: 1024 | abiertos ahora: 1024
sockets: 1019 | conexiones colgadas al 8080: 349
OSError: [Errno 24] Too many open files   (en sock.accept(), asyncio selector_events.py:178)
```
**Causa raíz:** `mitmdump` arranca con el límite de descriptores del shell (**1024**). Con
`block_global=false` el 8080 está abierto a todo internet y los bots que escanean puertos
abren cientos de conexiones que quedan colgadas; en minutos el proxy llega al tope y
**deja de aceptar conexiones nuevas** — el teléfono nunca pudo conectar. No fue culpa del
addon ni del teléfono.
**Arreglos (ambos ya en el repo, verificados):**
1. Arrancar con `ulimit -n 65536` (bloque corregido en `auditorias/captura-sign-RECESTA.md`).
   Tras el cambio: `Max open files 65536` y `proxy -> 200` desde dentro y desde internet.
2. Hook `client_connected` en `captura_sign.py`: cierra de inmediato toda conexión cuyo SNI
   no coincida con los dominios del app, así los bots no consumen descriptores. Probado con
   7 casos (4 dominios del app → se conservan; 2 ajenos → se cierran; sin SNI → se conserva).
**Otros dos bugs propios encontrados y arreglados al probar el addon de verdad:**
- La primera versión descifraba lanzando un `openssl enc` por respuesta (`subprocess.run`):
  ahora el AES-128-CBC va en Python puro.
- La S-box estaba **tipeada a mano y tenía un byte mal** (`0x9e` donde va `0xc9`) → descifraba
  basura sin avisar. Ahora se **calcula** desde la definición del AES (`_make_sbox`); verificada
  contra la tabla FIPS de referencia y contra el vector ECB de FIPS-197.
- `_guardar` no reintentaba si la primera apertura del JSONL fallaba → el addon se quedaba
  mudo toda la sesión. Ahora reintenta en cada llamada.
**Batería de pruebas del addon (5/5 OK):** filtro de bots · guarda el cuerpo del POST ·
descifra el formato real del app · se recupera tras fallo de disco · 2000 peticiones con
fuga de descriptores = 1 (el handle del JSONL).
**Lección:** el proxy se prueba ANTES de llamar al amigo (`curl -x ...8080` debe dar 200),
no después.

### ✅ CRACK (18 sep): **FÓRMULA DE LAS CABECERAS VERIFICADA CONTRA UNA CAPTURA REAL — coincidencia exacta**
El usuario pegó el resultado de una captura mitmproxy anterior (`~/captura-sesion.txt` en Oracle). Petición real del teléfono:
```
POST https://surfclick.vd7au6.com/api/public/upgrade
  app_id: movievn      version: 40000     sys_platform: 2
  device_id: 3736e27f0823b1ba             channel_code: movievn_sh_1000
  cur_time: 1789515864447                 (= 2026-09-15 23:44:24 UTC)
  token: gAAAAABqqSpPhjbhvV8e08AIfhMyEJjy1TGDSPXEHr18SpQdCUFXWUPzeL6OYKNKo-JeoSCUVAz7nfMh6So7BhIRg10KQhdHLYFvDOlijjuM8GPW-T0DjTJP9sp_GmAzKW-lm0Kicp5J
  sign: A526BDCB05C2CD7AE5EF38D96E56687F
  user-agent: okhttp/4.12.0
  RESP: {"code": 10000, "message": "Success", "result": null}
```
Comprobado en Python: `MD5('47Q8tBqO4YqrMHf4' + '3736e27f0823b1ba' + '1789515864447').hexdigest().upper()`
= `A526BDCB05C2CD7AE5EF38D96E56687F` → **COINCIDE byte a byte**. Descartadas en el mismo lote:
`md5(dev+ts+salt)`, `md5(salt+ts+dev)`, `sha1[:32]`, `sha256[:32]`.
⇒ **La fórmula de las cabeceras de la API está CERRADA y probada con evidencia real.** Lo que sigue
sin probar es el `sign` del CUERPO del POST de `/api/vod/info_new` (ese lo firma el nativo con `ck`).

**Diagnóstico de por qué la captura anterior no sirvió (leído de esos mismos datos):**
- En toda la sesión cayó **UNA sola petición** (`public/upgrade`). No hay `public/init` (el `token`
  venía cacheado de una sesión anterior) y **no hay ningún `info_new`** → el app nunca pidió el video.
- El usuario relata que con el proxy puesto "al entrar a la app no se reproducía nada" y que el otro
  chat le indicó poner una excepción de localhost en "omitir proxy".
- **Causa:** el app levanta un servidor propio en `127.0.0.1` y el reproductor se conecta a él; con el
  proxy de WiFi esa llamada local se intenta enrutar por el proxy y se rompe → nada reproduce → nunca
  se pide el video.
- **Corrección del plan:** para conseguir el `info_new` **NO hace falta que el video se reproduzca**.
  El `info_new` se pide al **abrir la ficha**, antes del PLAY. Nueva receta (paso 0 = revisar el PCAP
  viejo, coste cero; paso 2 = abrir 2-3 fichas sin necesidad de PLAY; proxy con bypass
  `localhost, 127.0.0.1, 10.*, 192.168.*`): `auditorias/captura-sign-RECESTA.md`.
- **OJO con los rollbacks (van 13):** en esta tanda el sandbox se reinició a mitad de un `commit` y el
  HEAD local quedó colgando de `244e3b5` (historial viejo), lo que hizo que el push fuera rechazado.
  Además **dos ediciones ya hechas a CONTINUACION.md y a la receta desaparecieron del árbol de trabajo**.
  Recuperación: `git fetch {PAT} main` → `git reset --hard FETCH_HEAD` → rehacer las ediciones → commit.
  **Regla: verificar con `grep -c` que la edición sigue en el archivo ANTES de dar por hecho que está.**

### ⛔⛔⛔ CRACK (18 sep, TARDE): **CORRECCIÓN — las pruebas en vivo NO eran válidas. La API está caída.**
Todo lo probado "en vivo" hoy contra `https://surfclick.vd7au6.com` **no prueba nada**, y la nota anterior que decía *"la prueba es concluyente porque public/init devuelve code:10000"* quedó **desmentida**:
- Verificación directa (6 repeticiones, misma petición, mismo host): `POST /api/public/init` con **sign correcto y verificado** (`MD5('47Q8tBqO4YqrMHf4'+device_id+cur_time)` en mayúsculas) devuelve **`系统出问题啦~请稍后再试`** ("problema del sistema, inténtalo después"). `type/get_list` igual.
- Otros hosts: `escc.k5ca.com`, `o.z2v3m6.com`, `movievn.m5e7.com` → **403 Forbidden**. `movievn.z3azky.com`, `albd.h4c5.com` → mismo error chino.
- **Regla nueva: antes de dar por fallida una fórmula, comprobar que `public/init` con sign conocido devuelve `code:10000`.** Si no, el servidor está caído y el resultado no significa nada. (El texto plano `error1` que apareció en una tanda fue transitorio: la misma petición dio después el error chino.)
- **Consecuencia: las 360 variantes de fórmula probadas hoy (5 hashes × órdenes × trozos) y las 80 de llaves de app NO están descartadas.** Hay que repetirlas cuando el backend responda.

**Hallazgos NUEVOS y sólidos de hoy (independientes del servidor):**
1. **`ck` completo, leído de la red** (respuesta real de `public/init` guardada antes): `result.sys_conf.p2p_config` contiene
   `[BASE]^backup_domain=http://147.124.216.142^sec_domain=null^ck_t=1^ck_tt=1^ck_p=0^ck=92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7^[P2P]^p2p_tracker_addr=47.253.51.203:7202^p2p_stunserver_addr=stun.l.google.com^`
   → **`ck = 92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7`** (64 hex; antes solo se tenía el valor truncado `92b991…291c7`). Este string `p2p_config` es exactamente lo que Java le pasa al SDK nativo, así que es el candidato nº 1 a `cfg[0x38]`.
2. **DOS llaves de app en el DEX** (`classes7.dex`), formato `LLAVE+com.movievn.cinevi+63`:
   - `6A21635498FB7F1E13648270050E1346E` ← la que ya se sabía (da el salt `47Q8tBqO4YqrMHf4` de las cabeceras)
   - `6BE2FB29B23E42031B1900D85E0756B75` ← **NUEVA, sin probar** (aparece en un okhttp 4.9.3, o sea una versión anterior del app)
3. **Decodificado confirmado del handler `verify`** (revisado instrucción por instrucción, `0xc98f4`–`0xc9bfc`):
   `strcmp(msg,"verify")` en `0x9cd40` → si `*device_id==0` o `*ts==0` error → `[ctx+0x10c4]=9` → `sprintf(buf,"%s%s%s", device_id, ts, [ [0x2d9000+0x5a8] + 0x38 ])` → `hash` → `hex` → `memcpy(resp,hex,0x10)`.
   **OJO, corrección:** `0x22e020` NO es un formato, es el nombre de función **`resource_update_cookie_exec`** (etiqueta de log). Y `0xc9344` es el epílogo (`ldr x21,[x21,#0xb68]` = comprobación de canario + `ret`), no la construcción de la respuesta. El formato de respuesta es **`verify=%u-%s`** en `0x22efef`, referenciado desde `0xcc9f4`.
4. **El firmador NO está localizado todavía.** La función que referencia `verify=%u-%s` (`0xcc900`–`0xccad8`) es un **constructor de query strings / cliente HTTP** (usa `%s-%s#%s` en 7 sitios, `snprintf` en `0x9d140` llamado 255 veces), no el cálculo del hash. Buscar el `ck` estáticamente sigue siendo dead end (279 sitios `STR [xN,#0x38]`, ninguno en la zona del parser de config `0xd4000`–`0xd8000`).
5. **Decisión: dejar de adivinar y capturar.** El `sign` real viaja **en el cuerpo del POST** de `/api/vod/info_new`, que SÍ es tráfico de internet y SÍ se captura (el certificado mitmproxy ya está instalado en el teléfono del amigo y el okhttp del app acepta user CAs). Con un `info_new` capturado se tiene `(device_id, cur_time, sign)` real → el `ck` sale por fuerza bruta local en segundos, y de paso se valida la fórmula.
   → **Addon nuevo: `auditorias/captura_sign.py`** (el anterior `captura_ss.py` imprimía cabeceras y respuestas pero **NO el cuerpo del POST**, que es donde vive el `sign`). Guarda cada flujo a `~/captura-sign.jsonl` sin truncar.
6. **Rollback de sandbox nº 12** durante esta tanda: `HEAD` local había retrocedido a `244e3b5` (v207) y el ref `origin/main` estaba viejo en `b8df245`, pero **el remoto real sí tenía `069bc22`** y **todos los archivos de trabajo sobrevivieron en disco** (`rc4_jiagu.py`, `rc4_sbox_1.bin`, `probar_sign.py`, `pphls_elf_interno.so`, `pphls_mips_inflado.bin`). Se recuperó con `git fetch {PAT} main` + `git reset --soft FETCH_HEAD`. **Lección: un `HEAD` viejo no significa trabajo perdido — comprobar `git fetch` antes de asumir nada.**

### 🎯🎯🎯 CRACK (18 sep): **FÓRMULA DEL SIGN ENCONTRADA** — `sign = md5(device_id + ts + ck)` en minúsculas
> ⚠️ **Leer primero el bloque ⛔ de arriba:** la fórmula está leída del código pero **NO verificada en vivo** (el backend está caído). Tratarla como hipótesis fuerte, no como hecho.
- Dentro del módulo descifrado de `libpp_hls` hay **un ELF AArch64 completo embebido en el offset 0x50429** (`e_type=ET_DYN`, `e_machine=EM_AARCH64`, entry `0xa6570`, 3,062,680 B). Extraído a **`auditorias/crack/pphls_elf_interno.so`**. Sus program headers están borrados pero **el código es ARM64 real y desensambla** (`.text` ≈ 0x80000–0x1e0000). El resto del módulo (0–0x50429) es bytecode de la VM 360 (0 % decodificable como ARM; los `ret` que aparecen son ruido: 1/2³² × 3.4 M ≈ 800 esperados, hay 5561).
- **El handler de `control?msg=verify` está en `0xc98f4`–`0xc9bfc`** (se llega comparando el param `msg` con `"verify"` vía `strcmp` en `0x9cd40`). Lo que hace, instrucción por instrucción:
  ```
  0xc990c  x3 = &param_device_id            ; x19-0x4c8
  0xc9910  si *device_id == 0 → error "request 'control' verify, missing param"
  0xc9918  x4 = &param_ts                   ; x19-0x488
  0xc991c  si *ts == 0      → mismo error
  0xc9ba8  [ctx+0x10c4] = 9                 ; tipo de respuesta
  0xc9bac  x20 = ctx-0x208                  ; buffer de salida
  0xc9bb8  x2 = [ [0x2d9000+0x5a8] + 0x38 ] ; ← 3er trozo: campo 0x38 de la config global
  0xc9bbc  x1 = "%s%s%s"
  0xc9bc8  sprintf(buf, "%s%s%s", device_id, ts, cfg[0x38])
  0xc9bd0  w1 = hash(buf)                   ; longitud
  0xc9be0  hex(buf, w1, x19-0x598)          ; a hexadecimal
  0xc9bf0  w2 = 0x10                        ; ← 16 bytes = MD5
  0xc9bf8  memcpy(resp, hex, 16)
  ```
  → **`sign = md5( device_id ‖ ts ‖ ck )` escrito como hex de 16 caracteres.** El ELF tiene el IV de MD5 en `0x2323f0` (`67452301 efcdab89 98badcfe 10325476`) y la tabla de constantes en `0x229af0` (`d76aa478…`); también hay SHA-256 (`0x428a2f98` en `0x23249c`), así que **si md5 no cuaja, probar sha256 truncado a 16 bytes** — pero `w2=0x10` apunta a MD5.
- **`ck` NO es un secreto fijo del binario:** es el campo `0x38` de la config global, y el propio servidor tiene `msg=up_ck` (handler en `0xc9a2c`) y la función `update_ck` para actualizarlo. Por eso **los 10 intentos MD5 con secretos fijos fallaron** (`47Q8tBqO4YqrMHf4`, `92b991…`, `87c2cb7f…`): falta el `ck` que el app recibe del backend.
- **Parámetros exactos:** `device_id` es el valor TAL CUAL viene en la URL (en la captura real: `3736e27f0823b1ba711142488`, que ya lleva el `vod_id` pegado) y `ts` los milisegundos. No se trocean ni se reordenan.
- **Lo único que falta para el oráculo: el valor de `ck`.** Vías, en orden de coste: (1) verlo en la respuesta de `/api/public/init` (la llamada de prueba sin firma correcta devolvió `系统出问题啦~请稍后再试`); (2) capturar `GET /control?msg=up_ck` en el teléfono; (3) buscar el setter del campo `0x38` en el ELF interno y ver de dónde lo saca.
- **Mapa de referencias ya resuelto** (ADRP+ADD decodificados a mano sobre el ELF interno, 7460 refs, 3023 a cadenas): `init done, port:%u`←0xc89a4 · `msg`←0xc93c8 · `device_id`←0xc93f0 · `nettype`←0xc93dc · `download_control`←0xc951c · `resource.m3u8`←0xc9630 · `m3u8_key`←0xc9684 · `net_info`←0xc96e8 · **`verify`←0xc98fc** · **`up_ck`←0xc9a34** · **`%s%s%s`←0xc9bbc** · `client_request_thread`←0xca39c · `wsSecret=%s&wsTime=%u`←0xcc6ec · `auth_key=%d-%d-%d-%s`←0xcc7b8 · `Signature=%s&Expires=%u&Key-Pair-Id=%s`←0xcc91c · `source_get_request_uri`←0xcc878 · `1be0ac56`←0xcd6f8 · `de304f03fe653f329edfea08ea2046c4`←0xd45a8 · `server_port`←0xd67dc,0xd7274 · `update_ck`←0xd6818.
- **OJO con capstone:** el `disasm` lineal se detiene en el primer byte no decodificable y este binario tiene datos intercalados → hay que decodificar ADRP/ADD a mano palabra por palabra (el script está implícito en el comando del commit; `adrp` = `(w&0x9f000000)==0x90000000`, `add imm` = `(w&0xff800000)==0x91000000`).

### 🔓🔓🔓🔓🔓 CRACK (18 sep, EL AVANCE GRANDE): `libpp_hls.so` DESCIFRADO — EL SERVIDOR DE CONTROL AL DESNUDO
- **El `.mips` de `libpp_hls.so` usa EL MISMO cifrado que jiagu** (mismo S-box capturado, misma PRGA). `python3 rc4_jiagu.py ../apk/lib/arm64-v8a/libpp_hls.so rc4_sbox_1.bin pphls_mips` → `COINCIDE ✔`.
  - `.mips`: va 0x1607d0, off 0x1507d0, **1,532,446 B** (0x17621e). Descifrado → header LE `0x0033bfc1` = **3,391,425** y zlib dio exactamente 3,391,425 B → **`pphls_mips_inflado.bin`** (3.3 MB, en `.gitignore` por tamaño; se regenera con ese comando).
  - **Esto invalida dos notas previas:** NO hay KSA/PRGA en el `.text` de libpp_hls (0 referencias a `[xN,#0x100]`/`[xN,#0x101]`/`cmp #0x100` en 0x6d350–0xfa1e8), y su `.mips` **no** está en 0x1607d0 con tamaño 0x17621e "sin descifrar": ya está descifrado.
- **El módulo NO es un ELF**: empieza `e1 c0 01 00 00 e0 e1 e1 e1 …` (0xe0/0xe1 por todas partes) → es **bytecode de la VM**, igual que el módulo de jiagu. Por eso no se puede desensamblar directamente.
- **EL SERVIDOR HTTP ESTÁ AQUÍ** (esto es lo que faltaba). Cadena literal `Server: bad_sdk`. Rutas que acepta:
  `control` (con `msg=verify` y `msg=up_ck`), `download_control`, `download_info`, `net_info`, `resource` (`resource.mp4`/`resource.m3u8`), `ts`, `m3u8_key`, `/favicon.ico`.
  Parámetros: `src`, `type`, `resource`, `msg`, `nettype`, `device_id`.
  Respuestas: `HTTP/1.1 200 OK`, `206 Partial Content`, `403 Forbidden`, `400 Bad Request`, `416`, `503`; JSON `{"code":%d,"message":"%s","resource":"%s"}`; `Content-Range: bytes %lld-%lld/%d`.
  Nombres internos: `client_accept`, `client_request_thread`, `client_request_init`, `client_recv`, `client_destroy`, `init_interface`, `init done, port:%u`, `create p2p interface failed`, `0.0.0.0`, clave de config **`server_port`** (= el puerto que devuelve `com.pp.hls.load(...)`), `p2p_tracker_addr`, `p2p_port`, `update_config`, `get1_config`, `get1_resource`, `get1_download_info`, `preload_mp4`.
  Es un **SDK de caché P2P**: baja el stream del CDN, lo cachea y lo sirve por HTTP local, con `Range`, `mp4`/`m3u8`/`ts` y llaves HLS.
- **Los formatos de firma del CDN están todos aquí** (los genera el SDK para ir al origen):
  - Wangsu: **`wsSecret=%s&wsTime=%x`** (y variante `%u`)
  - Aliyun: **`auth_key=%d-%d-%d-%s`** (plantilla `%s-%d-%d-%d-%s`)
  - **CloudFront: `Signature=%s&Expires=%u&Key-Pair-Id=%s`** con policy **`{"Statement":[{"Resource":"%s%s","Condition":{"DateLessThan":{"AWS:EpochTime":%u}}}]}`** y el error `sign error` → **esto explica los 403 `FunctionGeneratedResponse` del CDN: son URLs firmadas CloudFront con caducidad.**
  - **`verify=%u-%s`** ← formato de la respuesta del `control?msg=verify`: `<ts>-<firma>`. Y justo entre `verify` y `up_ck` está **`%s%s%s`** = la receta de concatenación de 3 trozos con la que se arma la firma.
- **Constantes candidatas a sal encontradas en el módulo:** `de304f03fe653f329edfea08ea2046c4` (32 hex, junto a `tracker_report_resource`/`update_config`), `1be0ac56` (junto a `tracker_recv_message`), `abcdef0123456789`, `2021-12-30` ("current version"). El MD5/SHA/HMAC que aparece es de **libcurl + OpenSSL embebidos** (`Curl_MD5_*`, `md5_block_data_order`, `hmac_pkey_meth`), NO primitivas propias.
- **Ningún secreto conocido del app está en el módulo:** 0 coincidencias de `47Q8tBqO4YqrMHf4`, `ppcineweb123`, `87c2cb7ff568d602d5f806c473345600`, `dsawdf634eebGFHITR5UT9kS0`, `32456738`, `0123456789123456`, `2015030120123456`, `com.movievn`. → **la sal del sign NO es una de las ya probadas** (coherente con los 10 intentos MD5 fallidos de `auditorias/api-movievn-NOTAS.md`).
- **Lo que falta para cerrar el sign:** saber los 3 trozos del `%s%s%s` y el hash. Como el módulo es bytecode de VM, la vía es **ejecutarlo**: arrancar el servidor del módulo en el emulador y consultar `GET /control?msg=verify&device_id=…&ts=…` (el emu ya encola esa petición en `emu_jiagu.jni_onload`). Alternativa barata: probar `md5/sha1/sha256(device_id + ts + sal)` con las sales de arriba contra `/api/vod/info_new` — pero sin una muestra real de sign no se puede verificar localmente, así que conviene primero la vía del emulador.

### 🔓🔓🔓🔓 CRACK (18 sep, VERIFICADO): CIFRADO DE JIAGU RESUELTO — RC4 con PRGA no estándar
- **Se descifró la sección `.mips` de `jiagu_descifrada.so` de punta a punta y está COMPROBADO**, no es conjetura:
  1. `emu_jiagu.py` ahora pone un hook de bloque en `JBASE+0x64bc` y vuelca el **S-box ya inicializado** (`rc4_sbox_1.bin`, 256 B, i0=3 j0=5) en el momento de la llamada. Llamada observada: `buf=0x200198f0 len=599897 estado=0x20019740` — `len` == tamaño exacto de `.mips`.
  2. `rc4_jiagu.py` reproduce la PRGA y descifra: cabeza `81fd1400 789c7cdd…`
  3. **Doble prueba de corrección:** los primeros 4 bytes son el tamaño descomprimido en little-endian (`0x0014fd81` = **1,375,617**) y `zlib.decompress(blob[4:])` devuelve **exactamente 1,375,617 B** → `mips_inflado.bin`. Coincide byte a byte en contenido con `jiagu_modulo_vivo.bin` capturado antes en el emulador (3× `HTTP/1.1`, 7× `sign`, desplazados por la base de carga).
- **La PRGA NO es RC4 estándar** (leída de `0x64bc..0x6540`; esto es lo que hizo fracasar los intentos anteriores con RC4 normal):
  ```
  i = (i + 2) & 0xff            # ¡+2, no +1!
  j = (S[i] + j + 1) & 0xff     # ¡+1 extra!
  a, b = S[i], S[j]             # valores ANTES del swap
  S[i], S[j] = b, a
  ks = S[(a + b) & 0xff]        # índice con los valores pre-swap
  out ^= ks
  ```
  Estado: `[0x000..0x0ff]` = S-box, `[0x100]` = i, `[0x101]` = j. La KSA está en otra parte y **ya no hace falta reimplementarla**: basta capturar el S-box con el hook.
- **Formato del blob:** `u32 LE (tamaño final) || zlib(deflate)`. Herramienta reutilizable: **`auditorias/crack/rc4_jiagu.py`** (`python3 rc4_jiagu.py [lib.so] [sbox.bin] [prefijo]`) — imprime `COINCIDE ✔` cuando el tamaño declarado y el de zlib cuadran, o `zlib FALLÓ` si el S-box no corresponde. Sirve para cualquier otra lib cifrada igual.
- **El sign NO está en este módulo.** Búsqueda en `mips_inflado.bin`: `/control` 0, `msg=` 0, `device_id` 0, `verify` 0, `/api/` 0, `info_new` 0, `wsSecret` 0. Sus plantillas HTTP son de **cliente** (`GET %s HTTP/1.1`, `POST %s HTTP/1.1`). → **Siguiente objetivo: aplicar exactamente este mismo método (hook de S-box + `rc4_jiagu.py`) al `.mips` de `libpp_hls.so`** (0x1607d0, 0x17621e B), que es donde vive `com.pp.hls.load()` y, por tanto, el servidor de control.

### ⚠️ GIT (18 sep, LEER PRIMERO): el repo estaba desincronizado — ya corregido
- **El remoto era la verdad: `origin/main = 9aabe50`** con 22 commits que este workspace no tenía (v208 `ffc2b66`, v209 `771dd96` y TODO el crack). La rama local era una **reconstrucción divergente** hecha por el snapshot (v207 local = `244e3b5`, v207 remoto = `1f19000`: mismo mensaje, distinto SHA). Se hizo `git reset --hard` al remoto; los archivos de código (`server.js`, `CONTINUACION.md`, `public/`, `catalogo-movie.js`) eran **byte a byte idénticos** al remoto, no se perdió nada.
- **`.git/config` lo borra el snapshot** (excluye rutas de credenciales) → `git remote -v` salía vacío y no se podía hacer push. Restaurado con `origin = https://github.com/Agus-12/HUDDLE.git` (URL sin token) + `user.name "Huddle Bot"` / `user.email huddle@local`. **El push se hace con la URL one-shot del PAT, nunca se guarda el token en el repo.**
- Si vuelve a pasar: `git fetch <URL-con-PAT> main` → comparar `git diff --stat FETCH_HEAD HEAD` → `git reset --hard FETCH_HEAD`.
- `auditorias/apk/` (APK de 55 MB) quedó en `.gitignore` — el remoto ya la tenía commiteada antes; no re-subirla.

### 🔎 CRACK (18 sep): barrido 0x91c0–0xd7c0 + cadenas decodificadas POR EJECUCIÓN (no a mano)
- **`sub_b71c` (0xb71c) NO es anti-frida: es el detector de EMULADORES.** Arma 22 cadenas en pila y hace `access()`/`stat()` sobre cada una, sumando el resultado. Las 22 rutas, **leídas de la memoria tras ejecutar el código en Unicorn**:
  `/sys/devices/virtual/misc/qemu_pipe`, `/system/lib/egl/libEGL_emulation.so`, `/sys/module/vboxsf`, `/system/droid4x`, `/system/bin/droid4x-vbox-sf`, `/system/lib/egl/libEGL_tiantianVM.so`, `/system/bin/ttVM-vbox-sf`, `/system/lib/libnox.so`, `/system/lib/libnoxd.so`, `/system/lib/libnb.so`, `/system/bin/nox-vbox-sf`, `/system/bin/androVM-vbox-sf`, `/ueventd.vbox86.rc`, `/dev/qemu_pipe`, `/sys/class/misc/qemu_pipe`, `/sys/qemu_trace`, `/dev/com.bluestacks.superuser.daemon`, `/system/framework/libqemu_wl.txt`, `/system/lib/libc_malloc_debug_qemu.so-arm`, `/data/downloads/qemu_list.txt`, `/system/bin/yiwan-prop`, `/system/bin/yiwan-sf`.
- **⚠️ CONSECUENCIA PARA EL EMULADOR:** jiagu detecta emuladores por filesystem. Si el emu llega a ejecutar esta ruta, hay que responder "no existe" a esas 22 rutas o el flujo cambia.
- **Método nuevo (reproducible): `auditorias/crack/dec_stack_strings.py`.** Decodifica cadenas de pila **ejecutando** el tramo que arma el arreglo (parcha la .plt 0x2d70–0x3400 con `ret`, para en la 1ª instrucción del bucle y vuelca el arreglo). **Sustituye a la lectura manual de `mov wN,#inm`, que dio resultados FALSOS** (los `mov` re-asignan wN a mitad del bloque). Regla: no confiar en cadenas decodificadas a mano.
- **Tabla JNIEnv CORREGIDA contra `jni.h` canónico (desplazamiento = índice×8), verificada sitio por sitio:** 0x30 FindClass(6) · 0x80 Throw(16) · 0x88 ExceptionClear(17) · 0xb8 DeleteLocalRef(23) · **0x108 CallObjectMethod(34)** · 0x130 CallBooleanMethodV(38) · 0x190 CallBooleanMethodV(50) · 0x2f0 NewObject(94) · 0x2f8 GetObjectClass(31) · 0x320 CallIntMethodV(64) · **0x388 GetStaticMethodID(113)** · 0x390 CallStaticObjectMethod(114) · 0x410 CallStaticBooleanMethodV(130) · 0x538 GetArrayLength(171) · **0x548 GetStringUTFChars(169)** · **0x550 ReleaseStringUTFChars(170)** · 0x568 GetObjectArrayElement(173) · **0x720 ExceptionCheck(228)**.
  - **CORRECCIÓN IMPORTANTE (dos errores previos):** 0x548/0x550 **NO** son Get/SetByteArrayRegion (son GetStringUTFChars/ReleaseStringUTFChars, y encaja con el bucle que itera un `StackTraceElement[]`); y **0x388 es GetStaticMethodID, no GetMethodID** — lo confirma el sitio `FindClass("android/app/ActivityThread")` + `GetStaticMethodID("currentActivityThread","()Landroid/app/ActivityThread;")`.
  - 0x108 = `CallObjectMethod` (instancia). Los `+0x108` con `x2=nombre, x3=firma` que se veían "estáticos" son en realidad `CallObjectMethod(obj, methodID_de_equals/getClassName, …)`, coherente con `String.equals(Object)` y `StackTraceElement.getClassName()`.
- **La rutina 0x9fa8–0xaf68 = verificación de pila de llamadas (anti-hook), ya con nombres reales:** `Thread.currentThread().getStackTrace()` → recorre los `StackTraceElement` con `GetObjectArrayElement`+`GetStringUTFChars`+`strcmp` y `StackTraceElement.getClassName().equals(...)`; además `ActivityThread.currentActivityThread()`, `Instrumentation`, `getApplication()`, `getPackageName()`, `java/lang/String`. Las cadenas `.rodata` eran **texto plano** (no cifradas): `getClassName`, `equals (Ljava/lang/Object;)Z`, `android.app.ActivityThread`, `android.app.Instrumentation`, `getApplication`, `android/app/Application`, `getPackageName`, `(I)Ljava/lang/Object;`, `%s_%d`, `get`.
- **El módulo 360 descifrado (`jiagu_modulo_vivo.bin`) NO tiene servidor HTTP:** sus plantillas son de **cliente** (`GET %s HTTP/1.1`, `POST %s HTTP/1.1`, `HOST: %s:%d`, `Content-Type:application/x-www-form-urlencoded`, `Content-Length: %zd`). Cero coincidencias de `/control`, `msg=verify`, `device_id`, `wsSecret`, `info_new`. Los 7 "sign" eran `GET_SIGNATURES`/`signature` y símbolos C++ (`_ZNSt…shared…`). Tampoco hay constantes MD5/SHA. **Conclusión: el handler del sign NO está en texto plano en ninguna de las dos libs → sigue dentro de una región cifrada.**
- **`.rodata` de jiagu es CASI TODO TEXTO PLANO** (no cifrado) — inventario verificado: `/proc/self/maps`, `cdlsym` (anti-hook: busca "dlsym" parcheado), `.symtab`/`.strtab`, `__system_property_get`, `signal`/`sigprocmask`/`sigaction`, `libmono.so`, `dladdr`, `dl_iterate_phdr`, `libdl.so`, `%lx-%lx %*s %*x %*x:%*x %*d%n` (parser de maps), `fake-libs`, los 23 nombres `IN_*` de inotify, `ro.build.version.sdk`, **`qhptserv%s_%d`** (nombre del socket unix del watchdog, 0x1fe50), `utf-8`, `java/lang/String.getBytes(Ljava/lang/String;)[B`, **cadena completa para obtener la ruta del APK** (`ActivityThread.currentActivityThread/currentPackageName/getSystemContext`, `PackageManager.getApplicationInfo(String,int)`, `Context.getPackageManager`, `ApplicationInfo`, **`getPackageCodePath`**, `ActivityThread.mAllApplications:Ljava/util/ArrayList;`, `ArrayList.size()I`/`get(I)Ljava/lang/Object;`), **`127.0.0.1`** + `/proc/net/tcp` + `%s %x:%x …` + **`AUTH`** + **`REJECT`** (el watchdog anti-frida), `/proc/%d/mounts`, **`which su`**, `/proc/%d/maps`, **`edxposed`**, `vndk-sp`, `*.so`, `JNI_OnLoad`, `System.getProperty(String)String`, `currentActivityThread`, `getApplication`, `getPackageName`.
- **Solo DOS cadenas están ofuscadas en `.rodata`, y son triviales (resta 1 por byte):** `0x202e1 "^YPJBCGUVSQ@F"` → **`libpp_hls.so`** y `0x202f2 "jBCGUVp@YV[U"` → **`libjiagu.so`**. O sea: jiagu busca por nombre esas dos libs (para `dlopen`/`dladdr`/verificación).
- **`sub_8d78` no ofusca nada:** su "plantilla" de 0x70 B en `0x201d0` es literalmente **`/data/data/`** en texto plano + ceros. La función compone `/data/data/<paquete>` (de ahí el `getPackageCodePath`/`getPackageName` de arriba) y luego `mprotect`. **Queda sin verificar** qué hace con esa ruta y qué significa el flag `0xc8e54` / el `0x31` de `sub_9008` (no se ejecutó, solo se leyó el código).
- **Bloque de alta entropía `0x1f6ee–0x1fd5a` y `0x20438–0x205e4`:** sin clave de un byte; probablemente bytecode/datos de la VM, no cadenas.
- **Catálogo:** rastreador **reanudado** (estaba muerto tras el reset). Arrancó en 49,333 y sube a ~4 títulos/s de recorrido. El checkpoint del remoto era 49,333 / 21,597 fichas; el local decía 51,412 / 22,640 → se re-recorre un tramo ya visto (es idempotente, `cubiertos` lo salta).

### 🔓🔓🔓 CRACK (18 sep): MÓDULO 360 VIVO EN EL EMULADOR — RegisterNatives disparado
- **El emulador dual (`auditorias/crack/emu_jiagu.py --run`) ahora ejecuta el módulo 360 completo:** la VM #6 (bytecode 0x501c7e5c) corre el módulo recién descomprimido, que hace `dlopen("libjiagu.so")` + `doSetShellState(10)`, consulta props del sistema, y **llama RegisterNatives: `interface14(I)Ljava/lang/String;` y `interface11(I)V`** (clase vacía = el stub). Antes la VM moría en la llamada #5; ahora llega a la #6 y hace reflexión Android completa (ActivityThread, File, List, LoadedApk, Application, DexPathList, BaseDexClassLoader, Build$VERSION.SDK_INT).
- **Qué desbloqueó la VM (todos parcheados en emu_jiagu.py/emu_hls.py):** (1) `dlsym("__sF"/"__stack_chk_guard")` ahora devuelve los símbolos de datos del emu (antes 0 → el loader abortaba en silencio); (2) `sscanf` funcional (el stub devolvía 0 y rompía el parseo de `/proc/self/maps`); (3) `/proc/self/maps` incluye los segmentos de jiagu; (4) **zlib streaming real** (deflateInit2_/deflate/inflate/compress2/crc32/adler32… sobre el zlib de Python) — el módulo resuelve ~20 símbolos zlib por dlsym y sin ellos abortaba; (5) dlsym genérico: cualquier símbolo desconocido recibe un stub dinámico (ya no hay "NO RESUELTO"); (6) `sprintf` real; (7) `__system_property_get` real (SDK 33, Pixel 6, arm64); (8) tabla JNI completa: GetStaticMethodID/CallStaticObjectMethod(V/A)/GetObjectField/GetStaticIntField(SDK_INT=33)/arrays/etc con respuestas Android plausibles.
- **Watchdog entendido (corrección):** el handler de pthread del servidor AF_UNIX es **0x7ef8** (legible) y `sub_7de4` es solo un epoll-wait→close; el hilo termina con `kill(getpid(), SIGKILL)`. El bloque TCP 0xdec0-0xe0b4 es un **watchdog anti-frida**: lee `/proc/net/tcp`, y si no, conecta a 127.0.0.1:**27042** (puerto frida) mandando `"AUTH\r\n"` esperando `"REJECT"`. NO es el servidor HTTP.
- **Región 2 (0x37000..0xc8000) sigue cifrada:** 0 escrituras durante JNI_OnLoad; 0 referencias adrp/bl desde la zona clara a 0x6f000-0x72000 → sólo la VM entra ahí. El handler HTTP real (0x70ef8) sigue siendo el objetivo; su descifrado probablemente ocurre al ejecutarse el bytecode del native real (load/exec), no en JNI_OnLoad.
- **Módulo 360:** la zona 0x8000-0x28000 del dump sigue cifrada tras JNI_OnLoad (ent 7.99); se descifrará cuando Java llame los natives del stub (interface14/11 devuelven vacío por ahora porque el flujo real los invoca con objetos Java reales). `--natives` los ejercita; `jiagu_modulo_vivo.bin` = dump post-ejecución.
- **Estado de red:** nada de sockets nuevos en JNI_OnLoad ni en los exports __arm_a_* — el servidor TCP se arranca desde el bytecode del native `load`, que aún no logramos ejecutar (la VM lo difiere hasta que el contexto Java es real).
- **Catálogo (18 sep):** rastreador vivo, checkpoint 48473 subiendo, **21,140 fichas encontradas** (~44% de densidad). Sigue el walk 1→650000.

### 🔓🔓 CRACK (17 sep, AVANCE MAYOR): libjiagu DESCIFRADA — código del servidor de control legible
- **El flujo completo ya está probado desde el DEX:** `AppApplication.loadP2pSdk()` llama `new com.pp.hls().load(dir1, "87c2cb7ff568d602d5f806c473345600", "com.movievn.cinevi", "63", dir2, tc/l0.L(), "1")` → **DEVUELVE EL PUERTO** del servidor de control. `com.pp.hls` tiene 2 métodos NATIVOS (`load`, `exec`) — los únicos del APK junto con los del jiagu. Luego `getSignInfo()` hace GET `http://127.0.0.1:{puerto}/control?msg=verify&device_id={ub/a.a(ctx)}{I}&ts={currentTimeMillis}` y **el cuerpo de la respuesta ES el sign** que va a `info_new` (parámetros: vod_id, cur_time, sign, audio_type).
- **Cifrado de la lib jiagu ROTO:** su DT_INIT (0x2bc8, en claro) descifra .text con XOR encadenado hacia atrás sobre el byte YA descifrado: `b'[N-1]=b[N-1]^semilla; b'[k-1]=b[k-1]^b'[k]`, región va 0x33d0..0x1f318 (=.text exacto), semilla=(0x33d0+0x1bf48)&0xff=0x18. La "tabla" es el propio header ELF (reloc RELATIVE addend 0 → el linker escribe la base). Script reproducible: `auditorias/crack/descifrar_jiagu.py` → `auditorias/crack/jiagu_descifrada.so` (**100% de .text decodifica como ARM64**).
- Los exports descifrados son stubs delgados que llaman al PLT 0x2ed0 → GOT 0x35cc8 → RELATIVE addend **0x1d10c** (dentro de la propia lib — el intérprete/VM local) con (bytecode, len, datos, vm?, ...): JNI_OnLoad usa bytecode 0x205c8 len 0xb48; __arm_a_2 usa 0x20438 len 0x190. O sea: la lógica vive en BYTECODE de una VM interna (igual que libpp_hls) — pero ahora los stubs, el cargador y las strings son legibles.
- **Servidor de control localizado en la lib descifrada:** función 0x84d8 hace `socket(AF_UNIX,SOCK_STREAM)` + nombre abstracto `qhp_tserv_%d_%d` (getuid + pid, string en 0x1fe50) + `bind`(0x85ac) + `listen(20)`(0x85bc) + `fork`(0x85c4); el hijo corre 0x83b4: ptrace(0,0,0,0) antidebug, señales ignoradas, `prctl(PR_SET_PDEATHSIG=1, SIGKILL)`, bucle `accept`(0x8468) → pthread con handler **0x70ef8**. Hay además un cliente/sonda en 0x8240 (connect al socket, reintenta EINTR) y otro socket+pthread_create en 0xdf1c-0xe0b4 (recv/send — quizá el puente TCP↔unix, porque Java habla HTTP por TCP 127.0.0.1:puerto).
- **Catálogo (17 sep):** confirmado por sondeo que **no hay nada más allá de 650k** (zonas 660k/700k/800k/900k/1M/1.2M/1.5M/2M → 0/40 fichas cada una). `search/screen` web sigue roto para paginar (page=1..50 devuelve SIEMPRE los mismos 20). La caminata de ids 1→650000 es EL método; con la densidad actual (~37%) el catálogo completo saldrá solo — el usuario dice que son >70k títulos y el ritmo apunta a eso o más. Rastreador reactivado (checkpoint 33255→ subiendo, 12.2k+ encontrados).
- **Segunda región cifrada (va 0x37000..0xc8000):** NO la descifra ningún código nativo visible de la lib (0 referencias adrp a esas páginas salvo la 0xc8000 de datos; 0 bucles ldrb/eor/sturb en la lib; XOR encadenado con las 256 semillas y ambas direcciones no produce la prología del handler 0x70ef8). Conclusión: la descifra/descomprime la **VM** (JNI_OnLoad bytecode 0x205c8) o el cargador de libpp_hls (MEMORYMODULE/Cryptor). Además la región podría estar COMPRIMIDA (uncompress@mmap en sub_3940) más que cifrada in-place.
- **VM interna de jiagu:** todos los exports desembocan en el PLT 0x2ed0 → GOT 0x35cc8 → 0x1d10c que resulta ser un **handler de closure libffi** (salva regs, prepara cif/rvalue/avalue) y llama a la VM real en **0x1b4d0**. Tipos de retorno 0xa/0xb/0xc = uint8/float/double.
- **Siguiente paso concreto:** emulador DUAL (libpp_hls en 0x40000000 + libjiagu_descifrada en otra base) reutilizando emu_hls.py: stubs nuevos (socket/bind/listen/accept/recv/send/epoll/fork/pthread/getuid/prctl/ptrace/signal/inotify/popen), imports interpreter_wrap_* de jiagu resueltos a los exports reales de libpp_hls, y llamar JNI_OnLoad de jiagu. Al aceptar una conexión, inyectar `GET /control?msg=verify&device_id=X&ts=T` y capturar la respuesta = **oráculo de sign**.
- **MÓDULO 360 AL DESCUBIERTO (17 sep):** el JNI_OnLoad de jiagu descomprime (zlib 0x92755→0x1d37e8) un **segundo ELF completo** (360 Jiagu real: com/stub/StubApp, JIAGU_*, sigCheck, device fingerprint) y lo mapea en un mmap anónimo. Extraído VIVO con el emulador dual: `auditorias/crack/jiagu_modulo_uncompress.bin` (1.9 MB, entry 0x2bb70, phdrs borrados, zona 0x10000-0x30000 aún cifrada, GOT sin relocar). El blob zlib NO está en el archivo ni en el APK: lo construye la VM en el heap (src volcado: `uncompress_src_0.bin`, empieza 789c).
- **Servidor /control emulado:** start_server=0x8634 (probe connect→socket→bind→listen→fork→child 0x83b4 accept→pthread_create). El hilo de conexión 0x7ef8 = wrapper (SO_PEERCRED uid check + epoll + eventfd); el **handler REAL del HTTP es 0x70ef8 = región 2** (aún cifrada; nadie la escribe durante JNI_OnLoad ni exports — se descifrará al llamar el native real).
- **Quién es quién:** la única clase jiagu en dex plano es `com.jiagu.sdk.pp_hlsProtected` con UN native `interface14(I)String` (descifrador de strings con caché). `com.pp.hls.load` está en el **dex cifrado** (StubApp lo carga en runtime). El manifiesto dice `com.mgs.carparking.app.AppApplication` (disfraz de re-pack). RegisterNatives no ocurre en ningún JNI_OnLoad emulado → el registro es diferido vía VM+carga del dex.
- **Emulador dual:** `auditorias/crack/emu_jiagu.py` (--load/--run/--modinit/--server-directo/--exports-j). Stubs de red completos con SO_PEERCRED, epoll real (struct con padding aarch64), fork=child, hilos encolados. Falta: descifrar región 2 / correr la VM con clases Java simuladas.
- **H5 web API completa (del JS de escc.k5ca.com):** base https://albd.h4c5.com/api; VIVOS nuevos: `topic/list`, `topic/vod_list` (listas curadas con pianwei), `search/hot_search` (fichas con pianwei), `channel_web/get_list`, `channel_web/get_info`. MUERTOS: search/result (siempre []), order/get_list_by_uid. El H5 NO reproduce (no hay endpoint de stream) → info_new+sign sigue siendo la única vía de URLs.
- **Rollback de sandbox #8** en este tramo: git local cayó otra vez a 244e3b5 a mitad del push; rescate con fetch + reset --hard FETCH_HEAD (8d06c02) + re-aplicar el cambio de CONTINUACION. Archivos de trabajo intactos; crawler vivo.

- **OJO — segunda región cifrada:** va **0x37000..0xc8000 (~580 KB, entropía 8)** contiene el handler 0x70ef8 y cía. El segmento es RW (sin X) e importan `mprotect` → se descifra/marca ejecutable en runtime, seguramente desde el bytecode de la VM interna (JNI_OnLoad usa bytecode 0x205c8 len 0xb48; el intérprete está en 0x1d10c de esta misma lib). Las strings de esa región NO son legibles todavía.
- **Siguiente paso:** (a) localizar el handler del servidor de control en la lib descifrada (imports socket/bind/listen/accept/recv/send ya resueltos por nombre — buscar las llamadas PLT y x-ref); (b) entender `verify` (¿firma MD5/AES con el device_id+ts?) — si es cripto estándar, reimplementarla en Huddle sin emular nada; (c) si no, emular la lib descifrada (su .text ya es código real, más fácil que la VM de libpp_hls).
- El sign de la API WEB (ppcinewebes) sigue siendo MD5 conocido; esto es para la API del APP (info_new).

### 🔓 CRACK (17 sep): ENCONTRADO el servidor de control + candidata a función sign
- **El servidor HTTP de control NO está en libpp_hls.so**: está en **`lib/arm64-v8a/libjiagu_sdk_pp_hlsProtected.so`** (759 KB, ya extraída al repo). Imports REALES de red: `socket, bind, listen, accept, recv, send, connect, epoll_*, inet_aton, fork, pthread_create` + string `127.0.0.1`. Esta lib es el cargador jiagu que además sirve `/control?msg=verify...`.
- Sus 8 exports tienen NOMBRE REAL: `JNI_OnLoad`, `__arm_a_0()`, **`__arm_a_1(_JavaVM*, _JNIEnv*, void*, int&)`**, **`__arm_a_2(char*, ulong, char*, int&, int)` ← candidata FUERTE a la función sign** (datos, largo, buffer salida, largo salida&, flags), `__arm_a_20()`, `__arm_a_21()`, `DynCryptor::__arm_c_0()`, `__arm_c_1::__arm_c_0()`.
- Su .text está CIFRADO en disco (entropía 7.65; los exports empiezan con un prefijo común de 20 bytes = stub de descifrado/VM). Estático no se puede leer — hay que emularla y volcar el .text descifrado (igual que con libpp_hls).
- libpp_hls.so: los 46 exports de la zona JNI son **cascarones vacíos** (solo ret). `__arm_a_0(soinfo*)` sí trabaja: parsea, arma estructuras y por ffi llama a lib+0xf8ba4 que guarda `(JavaVM*, ptr)` en un ctx. `__arm_a_1(MEMORYMODULE*, Cryptor*)` corre otra VM (bytecode 0xfaa04, 372 B) que por ffi llama a lib+0xfa29c: valida el Cryptor (vtable+0x18), copia 2 punteros al ctx, crea un objeto y lo encadena en una lista global (0x5d8e20, eslabones +0x1d8) — plomería cripto interna. Ni dlopen/dlsym ni SVC en ninguna de estas rutas.
- DEX: el APK completo tiene **solo 2 métodos nativos** (compose + ironsource, irrelevantes) → Java NO llama natives del pp_hls directamente; todo va por el servidor de control 127.0.0.1 y/o RegisterNatives del jiagu en runtime.
- **Plan:** emular libjiagu_sdk_pp_hlsProtected.so (759 KB, 106 imports — hay que añadir stubs socket/epoll/pthread/fork al harness), correr su init/JNI_OnLoad, volcar el .text descifrado, desensamblar `__arm_a_2` y el servidor de control. Si `__arm_a_2` es el sign → oráculo directo; si no, alimentar `msg=verify` al servidor emulado.

### 🩹 v209 — Lacartoons: capítulo borrado daba un error críptico («aborted») (17 sep, este chat)
El usuario reportó que *Un Show Más* no reproducía y salía un error tipo «aborted». **No fue causado por v208** — el diagnóstico real:
- *Un Show Más* 1x1 (`lacartoons.com/serie/capitulo/22984`) tiene el player id `lbrig`, y la API del player responde **404 `Video not found or deleted`**: la fuente borró ESE capítulo. Los caps 1x2/1x3 (ids `ejla6`/`mlhop`) responden 200 y reproducen bien (m3u8 200 + segmentos 200 verificados).
- Antes, el 404 del player caía al respaldo de navegador, que moría con un error sin traducir («aborted»/«el navegador no está disponible») → el usuario veía eso.
- **v209:** si el player responde 404/410, `resolverRpmvidHttp` lanza «Ese capítulo ya no está disponible en Lacartoons — el player lo borró; prueba otro» (encaja con `EP_MUERTO_RE`, así que en sala el **salto automático lo brinca** y sigue con el siguiente). `resolverLacartoons` ya no manda al navegador cuando el capítulo está borrado.
- **Medido:** cap borrado → 404 con el mensaje claro en 3.3 s (antes: ~15-30 s y error críptico); cap sano → 200 en 0.8 s.
- **Rollback de sandbox #6** durante este cambio: git local cayó a 244e3b5 otra vez; los archivos del working tree conservaron los cambios. Rescate = fetch + reset --hard FETCH_HEAD (ffc2b66). El crawler sobrevivió de nuevo.
### 🙈 v208 — NOVELAS EXTERNAS OCULTAS (17 sep, este chat)
El usuario pidió OCULTAR las dos fuentes de novelas agregadas a mano (Novelas360 + EnPantallaTV) porque **se ven en mala calidad**. Implementado con un interruptor, sin borrar nada:
- `server.js` (junto a `NV_BASE`, ~línea 643): `const NOVELAS_EXTERNAS_ON = false;` ← **para reactivarlas solo se cambia a `true`**.
- Con el interruptor apagado: el buscador NO consulta `buscarNovelas`/`nv2Buscar`; la fila «Novelas» de portada (`/api/trending`) y el «Ver todo» (`/api/catalogo/novelas`) devuelven SOLO `movieTarjetas()` (app Movie, calidad buena). Los endpoints `/api/novelas/...` y `/api/enp/...` siguen existiendo pero la UI no los alcanza.
- `public/app.js`: entrada «Novelas» comentada en la lista de fuentes (pageDrop).
- **Verificado en vivo (:3000):** portada → 2 novelas, todas site `Movie`, 0 externas; ver-todo → igual; `/api/search?q=maria` → 18 resultados, 0 de Novelas360/EnPantalla.
- Cuando el crack del sign funcione: el catálogo Movie completo entra por `movieTarjetas()`/mapa; no hace falta reactivar las fuentes externas.
- **Rollback de sandbox #5 durante este cambio:** el git local cayó a 244e3b5 a mitad del push; se rescató con fetch + reset --hard FETCH_HEAD (7c50257) + re-aplicar el parche v208. El crawler sobrevivió (sigue vivo, checkpoint 33255 / 12,211 encontrados).

### ✅ INTEGRACIÓN MOVIE EN HUDDLE — v207 (17 sep, este chat)
Las 5 rutas latinas del mapa ya están integradas en el server (`server.js` + `public/app.js`):
- **Lectura:** solo el mapa local (`~/movie-mapa-secuencias.json`, env `MOVIE_MAPA` para probar). Se recarga solo cuando el archivo cambia; si el mapa se regenera, se olvidan las caídas (evidencia nueva).
- **Doble guarda de audio:** el server vuelve a exigir `audio.clasificacion === 'latino-inequivoco'` + `disponibleParaMovieAhora` — *Amar y Cuidar* y `feec4d1e85fe` no pueden entrar aunque el mapa cambiara.
- **Dónde aparece:** las tarjetas Movie abren la fila **Novelas** (inicio) y cascan primero en el buscador; un toque abre el selector de capítulos de siempre. Sala: se reproducen NATIVAS (playlist local, sin Chrome). Solo: por `/api/solo` como cualquier fuente. Continuar-viendo, vistos y cadena de episodios funcionan con las URLs `https://movie.huddle/ver/{clave}/{T}x{E}`.
- **Allowlist ESTRICTA (no hay proxy abierto):** `/api/movie/hls/{clave}/{T}x{E}/index5.m3u8|NNNN.ts` solo sirve rutas exactas del mapa activo contra `http://147.124.216.142` (env `MOVIE_ORIGEN` solo para pruebas); segmentos solo `NNNN.ts` (index0-4/6-10, extensiones raras y `../` = 403; `/api/hls?u=` NO acepta el origen). El m3u8 se reescribe a rutas propias (sz/m8 se caen, no hacen falta).
- **Caídas:** si el origen responde 403/404/410 (manifest o segmento), el episodio se marca en `~/movie-rutas-caidas.json` (ignorado por Git), desaparece de fichas/buscador y se espera evidencia nueva — nunca se sustituye la ruta. Verifiables en `/api/estado` (bloque `movie`).
- **Diagnóstico:** `curl -s http://127.0.0.1:3000/api/movie/probar` comprueba m3u8 + primer .ts de cada ruta activa contra el origen y marca caídas. **OJO: llamarlo marca caídas si algo responde 403.**
- **Portadas:** `/api/movie/poster/{clave}` proxya la portada alojada por Movie (cache 1 h); si falla → 302 `/carita.png`.
- **Probado end-to-end** con origen simulado Y contra el origen real: m3u8 real reescrito (201 segmentos, 0 con sz/m8), segmentos con Range (206), búsqueda/ficha/trending/solo, 8 negativas de allowlist, flujo completo de caída (marcar → ocultar → olvidar al regenerar mapa), portada real (webp 13 KB).

### 🔴 HALLAZGO NUEVO (17 sep): el bypass del origen ahora discrimina por antigüedad
Comprobado desde el sandbox (mismos resultados que verá cualquier IP):
- `…/2024/07/25/{carpeta}/index5.m3u8` → **200** pero es `X-Cache: Hit from cloudfront` (Age ≈ 2.3 días: lo dejó cacheado la captura del 16-sep; cuando el TTL venza también dará 403).
- `…/2024/…/0000.ts` → **403** con `X-Cache: FunctionGeneratedResponse` (una función de CloudFront valida token en los cache-MISS de contenido viejo). Ni con sz/m8, ni Badci, ni UA okhttp, ni por `agent.maqbc.com`/https.
- Contenido NUEVO sigue abierto: `…/2026/09/11/9db1ede34113/0000.ts` → **200** (3,248,640 bytes) incluso en Miss.
- Es decir: **hoy los 5 capítulos latinos tienen manifest vivo (cacheado) pero segmentos 403** desde el sandbox. El token capturado del 16-sep ya expiró y `info_new` sigue necesitando el sign nativo (dead end 2).
- **Pendiente de verificar DESDE EL ORACLE del usuario** (otra POP puede tener otra caché): `curl -s http://127.0.0.1:3000/api/movie/probar`. Si los ts dan 403 también ahí, las rutas quedan marcadas caídas y la integración queda lista esperando evidencia nueva (nueva captura con el app reproduciendo esos capítulos).
- El API del app SIGUE VIVA (17 sep): `public/init` con el device del amigo devuelve token guest nuevo (code 10000).

### 🟡 CATÁLOGO COMPLETO — RASTREO EN CURSO (17 sep)
`search/screen` no pagina (dead end 16), pero `info_web_get` responde CUALQUIER id web → se puede reconstruir el catálogo recorriendo ids. Herramienta nueva: **`catalogo-movie.js`** (en el repo):
- Recorre ids 1→650 000 (margen sobre el mayor visto, 594285) con 3 obreros × 250 ms (~5.5 ids/s, cortés; pausa 20 s ante 429/5xx).
- **Reanudable:** checkpoint en `auditorias/catalogo-web/checkpoint.json` (VA AL REPO — sobrevive resets). Fichas por bloques de 25 000 ids en `auditorias/catalogo-web/bloque-{N}.json` (también al repo).
- Cuando una ficha trae `series_info`, los ids de las demás temporadas se marcan cubiertos (no se re-piden).
- Guarda por título: nombre, tipo, año, idioma, portada Movie, pianwei (app-id), si terminó, temporadas (ids web) y **capítulos [web-ep-id, duración s]** — sirve de huella para futuras cosechas (probado: LQV T1 → 197 caps, E1 = 2789 s = la huella exacta).
- Prueba real (17 sep): 21 ids → 7 títulos (~33 % de densidad en zona poblada; la zona baja <81 000 va vacía). Estimado total: ~30-33 h de rastreo; se puede correr en el Oracle igual (`cd ~/huddle && nohup node catalogo-movie.js > ~/catalogo.log 2>&1 &` — es reanudable, si se corta se relanza y sigue).
- **Falta (siguiente tanda):** integrar el catálogo rastreado en Huddle (buscador/feed con portadas Movie). Catálogo ≠ video: las URLs de stream siguen saliendo solo de capturas frescas (sign nativo sigue bloqueado) y el contenido viejo hoy exige tokens (dead end 19).

### 🔓 PLAN B EN MARCHA (17 sep): reconocimiento de libpp_hls.so COMPLETADO
Recon binario real (este chat) sobre `auditorias/apk/lib/arm64-v8a/libpp_hls.so` (2.9 MB, ARM64, stripped):
- **PROTECCIÓN = MÁQUINA VIRTUAL PROPIA (estilo VMProtect), no un packer simple.** Evidencia:
  - init #1 (`0xe7bd8`) llama a **`interpreter_wrap_int64_t`** con 5 args: blob de bytecode de 936 B (`0xfab78`), región de 1.5 MB en `0x1606f0` y la sección **`.mips` (`0x1607d0`, 1,532,446 B)** + su tamaño. `.mips` tiene **entropía 7.9999 bits/byte** = cifrada a tope (sin atajo zlib offline; probado).
  - Familia `interpreter_wrap_{int64_t,float,double}(+_bridge)` = el dispatcher de la VM; **libffi embebido** (`ffi_prep_closure_loc`, `ffi_java_raw_call`…) = cómo el bytecode llama funciones nativas/Java.
  - Los **9,674 exports ofuscados** (`A101S9v63mXfa`…) son casi seguro stubs de entrada a la VM.
  - `.text` visible = solo 577 KB (VM + pegamento); `.bss` de 3 MB = zona de trabajo; `.data` arranca cifrado. Anti-análisis: `sigaction`, `dl_iterate_phdr`, `dladdr`, lectura de `/proc/self/maps`; APIs de red/threads ocultas vía `dlopen/dlsym`.
- **Consecuencia dura:** Ghidra estático sobre el archivo = prácticamente inútil (dead end 9 confirmado y AMPLIADO: no hay solo ofuscación OLLVM, hay bytecode cifrado de una VM custom). Revertir la VM a mano = semanas.
- **Vía viva = ORÁCULO DINÁMICO** (no entender el algoritmo, solo USARLO): correr la lib en un entorno Android real/emulado con un JNIEnv de juguete, dejar que levante su servidor 127.0.0.1 y pedirle `/control?msg=verify&device_id={DEV}{VOD_ID}&ts={ms}` → el body ES el sign. Si funciona, el mismo arnés corre en el Oracle (Ampere A1 = ARM64) y Huddle mintea signs solos → automatización TOTAL (info_new → vod_url de cualquier título).
- **Herramientas:** capstone + unicorn + pyelftools (pip). qemu-aarch64-static y el NDK se instalan/descargan si hacen falta, pero **no se usaron**: el emulador Unicorn puro resultó viable y no necesita sysroot de Android.
- **Root descartado:** el usuario confirmó el 17-sep que no tiene Android rooteado → la vía Frida queda fuera; seguimos por emulación.

### 🛠️ EMULADOR FUNCIONANDO (17 sep) — `auditorias/crack/`
`emu_hls.py` (Unicorn ARM64, sin Android) ya hace, verificado por ejecución:
1. Carga los 2 segmentos PT_LOAD, aplica las 164 relocalizaciones
   (`R_AARCH64_RELATIVE` + `GLOB_DAT`/`JUMP_SLOT`; 30 apuntan a símbolos
   internos como `interpreter_wrap_int64_t` y `ffi_*`, el resto a trampolines).
2. Implementa la libc que la lib importa (malloc/calloc/memcpy/mmap/mprotect/
   `uncompress`/fopen/fgets/strstr/sigaction/`dlopen`/`dlsym`…) y un `dlsym`
   falso que anuncia ~70 APIs (socket/bind/pthread/…) para ver qué pide.
3. Reimplementa el **libffi embebido** (la lib lo usa para llamar a Java):
   `ffi_prep_cif*` rellena el cif, `ffi_call(cif, fn, rvalue, avalue)` ejecuta
   `fn` con los args desreferenciados de `avalue`, `ffi_closure_*` crea
   trampolines reales (`ldr x17,#8; br x17`) porque el ABI de esta lib lee el
   descriptor desde x17.
4. Ejecuta `INIT_ARRAY[0]` (`0xe7bd8`) hasta retornar.
5. Construye un `JavaVM`/`JNIEnv` de juguete (232 slots con trampolines
   propios) y llama `JNI_OnLoad` (`0xe7c34`).

**Hasta dónde llega:** `JNI_OnLoad` se ejecuta, la VM corre 988 opcodes y pide
`GetEnv` con versión `0x10004` (JNI 1.4). Ahí se detiene: devuelve 0 en vez de
`0x10006` y no llega a `RegisterNatives`, así que `jni_natives.txt` sale vacío.
Falta satisfacer lo que la VM comprueba justo después de `GetEnv`.

**Detalle del intérprete (para quien siga):** decodifica un bitstream con
campos de 5/6 bits y despacha por tabla (`br x0` en `0xf0154`). Bytecode de
`JNI_OnLoad` = 2,904 B en `0xfaf20`, entropía 7.09 (cifrado), no cambia durante
la ejecución. Opcodes vistos: 0,1,2,4,5,6,9,18,19,25 y 735,959,1074,1187,
1683,1692,1700.

**Reproducir:** `pip install pyelftools capstone unicorn && python3 auditorias/crack/emu_hls.py --budget 400`
- Nota: `pp_hlsProtected.dat` (assets) trae magic `*#*#0123456789ES9876543210#*#*` — probable config cifrada que la VM consume; el arnés debe poder leérsela (ruta del "apk").

### ✅ LOGRADO

### ✅ LOGRADO
- **Catálogo histórico (CORRECCIÓN 16 sep):** `auditorias/catalogo-app-completo.json` tiene 8,000 FILAS y `novelas-app-catalogo.json` 240, pero al revisarlos solo hay **20 IDs únicos por tipo**: el scrape anterior repitió la primera página. Sirven como muestra y para los 20 títulos actuales, pero **NO son el catálogo completo**. `search/screen` ignora todos los parámetros de página probados; habrá que reconstruir el catálogo por otra vía más adelante.
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
- **Recibidor PCAP v3 (16 sep, este chat):** se corrigió un error del plan anterior tras revisar la guía oficial de PCAPdroid: su modo **"Servidor HTTP" NO envía nada a Oracle**, convierte al teléfono en servidor para descargar desde la misma red. `recibidor-pcap.js` ahora usa por defecto el **"TCP Exporter" / pcap-over-IP** de PCAPdroid en el puerto 8080: escribe por streaming a un temporal y publica el PCAP completo al terminar, valida cabecera PCAP/PCAPNG, rechaza conexiones simultáneas y limita a 1 GiB por defecto. Guarda bytes en vivo en `~/captura-movie.pcap.status.json` (se actualiza al primer dato y luego cada ≤750 ms), así se puede comprobar antes de pedir una captura larga. Alternativa segura para un archivo ya guardado: `PCAP_MODE=http` abre una página de carga con `PCAP_TOKEN` opcional. Probado localmente: TCP con cabecera partida, bytes en vivo antes de detener y rechazo de datos inválidos; HTTP health, clave y carga correcta.

### ✅ COSECHA HISTÓRICA Y MAPA DE SECUENCIAS (16 sep)
- **Captura #1 conservada:** `~/captura-movie.pcap` tiene 39 rutas Movie únicas. No pedir otra captura ni volver a consultar esas rutas por CDN para identificarlas.
- **Manifests desde el PCAP:** `cosechar-pcap-movie.js ~/captura-movie.pcap ~/movie-cosecha.json` se ejecutó correctamente sobre el PCAP clásico microsegundo RAW (`link type 101`): **38/39** respuestas HTTP históricas M3U8 con estado capturado `200`, duración `EXTINF` y segmentos. La comprobación actual sigue separada: sus `403` no contradicen el `200` histórico ni significan que la ruta se deba borrar.
- **Método que sí dio certeza:** se comparó el orden de cada grupo por fecha con secuencias completas de duraciones de las fichas públicas Movie, no con una duración aislada. La huella exige que cada ruta con manifest propio coincida en su posición, con tolerancia de 1 s y mínimo cuatro coincidencias. Se ampliaron temporalmente las fichas de vitrina y se consultaron rangos históricos de IDs solo para encontrar las series; no se subieron esas cachés ni reportes crudos.
- **38 rutas ya tienen asignación individual fuerte:**
  - `2026/09/16` → **Amar y Cuidar**, T1 E1, E3, E5, E7 y E9; 5/5, error absoluto total **1.400 s**. **EXCLUIDA**: el TS revisado tiene audio `tha` y apertura tailandesa; no cuenta como latino aunque tenga subtítulos en español.
  - `2024/07/25` → **Lo que la vida me robó**, T1 E1, E3, …, E19; 10/10, error **0.930 s**. Latino inequívoco (telenovela mexicana original en español).
  - `2024/02/28` → **Soy tu dueña**, T1 E1, E3, …, E19; 10/10, error **0.920 s**. Latino inequívoco.
  - `2025/06/12` → **La usurpadora**, T1 E1, E3, E7, …, E19; 9/9 manifests recuperados, error **2.895 s**. Latino inequívoco.
  - `2024/03/27` → **Marimar**, T1 E1, E3, E5 y E7; 4/4, error **1.173 s**. Latino inequívoco.
- **Límite deliberado:** `feec4d1e85fe` es la única ruta sin respuesta HTTP/M3U8 recuperable. Aunque pertenece al grupo temporal de *La usurpadora*, queda **sin título/episodio individual, sin duración y sin estado histórico inferido**. No rellenarla por sus vecinas.
- **Disponibilidad actual útil:** de las rutas mapeadas hay cinco latino reproducibles en esta comprobación: *Soy tu dueña* T1E5 y *Lo que la vida me robó* T1E9, E13, E17 y E19. La ruta de *Amar y Cuidar* que hoy responde se mantiene fuera por audio.
- **Mapa local reproducible:** `mapear-secuencias-movie.js` lee exclusivamente `~/movie-cosecha-pcap.json` y las huellas públicas versionadas en `auditorias/huellas-secuencias-movie.json`; crea `~/movie-mapa-secuencias.json/.txt`. El mapa contiene rutas locales saneadas, por eso está en `.gitignore`; el script y las huellas no contienen rutas, bodies, consultas ni tokens y sí están publicados. Se probó con fixture: 39 rutas, 38 manifests, 5 grupos confirmados, 38 asignadas, 1 sin asignar, 5 latino activas y 5 excluidas por audio.

### 📋 SIGUIENTE PASO
0. **🔴 PRIORIDAD 1 (18 sep tarde) — CAPTURA DEL SIGN REAL.** El backend de la API está caído (ver bloque ⛔), así que adivinar la fórmula no se puede validar. La vía barata y definitiva: capturar un `POST /api/vod/info_new` del teléfono del amigo (el `sign` viene en el cuerpo del POST, que sí es tráfico de internet y sí se descifra porque el cert mitmproxy ya está instalado). Pasos:
   - **Usuario, en Oracle:** pegar el bloque "CAPTURA DEL SIGN" de `auditorias/captura-sign-RECESTA.md` (instala `captura_sign.py`, enciende el proxy 8080, sirve el cert).
   - **Amigo:** receta de WhatsApp en ese mismo archivo (10 min: proxy manual + abrir Movie + darle PLAY 1 minuto + quitar proxy).
   - **Usuario:** `grep -c '>>>' ~/captura-sesion.txt` y luego `cat ~/captura-sign.jsonl | tail -40` → pegarme la salida.
   - **Yo:** con `(device_id, cur_time, sign)` reales resuelvo el `ck` por fuerza bruta local (espacio: los 5 candidatos ya listados + variantes de orden/hash) y valido la fórmula `md5(device_id‖ts‖ck)`.
   - Cerrar al terminar: `pkill -f mitmdump` (con `block_global=false` el proxy acepta a cualquiera mientras viva).
1. **Usuario, en Oracle (bloques copy-paste):**
   ```bash
   cd ~/huddle || exit 1
   bash actualizar.sh
   node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json
   curl -s http://127.0.0.1:3000/api/movie/probar
   ```
   Y pegar la salida aquí. `/api/movie/probar` dice m3u8/ts de cada capítulo (y marca caídas si el origen dice 403).
2. **Según lo que diga probar:**
   - Si algún ts da 200/206 → ese capítulo ya se ve en Huddle (fila Novelas / buscador). Probar reproducción real.
   - Si todos dan 403 → las rutas quedan marcadas caídas (correcto). Para revivirlas hace falta **evidencia nueva**: que el amigo reproduzca en el app esos capítulos con PCAPdroid capturando (Exportador TCP → `recibidor-pcap.js`) y repetir cosecha → mapa (el mapa regenerado olvida las caídas y trae rutas nuevas).
3. La ventana de los manifests cacheados de 2024 es corta (TTL de ~días desde el 16-sep). No bombardear el origen con comprobaciones repetidas: usar `/api/movie/probar` una vez y listo.
4. El catálogo completo sigue siendo un trabajo separado: las muestras históricas con paginación defectuosa no deben presentarse como catálogo completo.
5. Recordatorio: revocar el PAT al cerrar la sesión.

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
- Con eso: `/api/type/get_list`, `/api/search/screen` (body `type_id={1=pelis,2=novelas,4=?}`; **no asumir que `page=N` pagina**, ver corrección §2 y dead end 16), `/api/search/result`, `/api/vod/info_new` (⚠️ además exige el sign NATIVO — es EL bloqueado).
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
15. **PCAPdroid "Servidor HTTP" como emisor hacia Oracle:** NO funciona; la guía oficial confirma que ese modo sirve el PCAP DESDE el teléfono para alguien en la misma red. Para recibir en Oracle usar **TCP Exporter / pcap-over-IP** con `recibidor-pcap.js` (por defecto), o Archivo PCAP + WhatsApp / `PCAP_MODE=http`.
16. **Paginación de `search/screen`:** los archivos que decían 8,000/240 títulos repiten los mismos 20 IDs; POST con `page`, `page_num`, `pageNo`, `page_no`, `current_page`, `offset`, `limit` y GET con esos parámetros devolvieron la misma primera lista. No tratar esas filas repetidas como catálogo completo ni bombardear la API pidiendo la misma ficha; `identificar-movie.js` deduplica por web-id.
17. **Filtrar el PCAP con BPF/tcpdump para obtener orden:** tanto el filtro por offset TCP como `tcp dst port 80` dieron cero en la captura real pese a que el URI existe. No repetirlos ni asumir que no hay GET; usar la versión binaria actual de `ordenar-pcap-movie.js`.
18. **`vod_id` del proxy localhost:** PCAPdroid sí capturó CDN HTTP, pero no las llamadas locales `/control?msg=verify`; el análisis binario real encontró 0. No insistir con esa pista en este PCAP; recuperar los M3U8 originales desde sus respuestas TCP ya guardadas.
19. **Los .ts viejos por el origen pelado (17 sep):** el bypass `147.124.216.142` ya NO sirve segmentos de carpetas 2024/2025 en cache-miss (`X-Cache: FunctionGeneratedResponse` = 403 de una función de CloudFront que valida token). Los m3u8 de 2024 que aún dan 200 son **cache hits** de la captura del 16-sep y caducan solos. Contenido nuevo (2026) sí sigue abierto. NO reintentar los .ts viejos con variantes (sz/m8, Badci, UA okhttp, https, agent.maqbc.com — todas probadas, 403) ni dar por muerta una ruta sin comprobarla DESDE ORACLE (la caché es por POP). El token capturado caduca en horas: no guardarlo como vía.
20. **Rutas del CDN con guiones:** la ruta real es `/vod/1/YYYY/MM/DD/{carpeta}/…` con **diagonales**. Con guiones (`2024-02-28`) todo da 403/404 y parece que el origen "cayó" — error ya cometido una vez; el mapa guarda la fecha como `YYYY-MM-DD` y `server.js` la convierte con `movieFechaRuta()` antes de pedir.

## 6. HERRAMIENTAS DEL LADO DEL USUARIO (Oracle)
- Verificar conectividad al CDN: `curl -s -m 10 -o /dev/null -w "%{http_code}" "http://147.124.216.142/vod/1/2026/09/11/9db1ede34113/index5.m3u8"` (debe dar 200 — verificado 16-sep).
- mitmdump YA NO CORRE (apagado). El cert mitm.crt fue borrado del repo.
- **Recibidor PCAP v3 (recomendado):** en Oracle, pegar:
  ```bash
  cd ~/huddle || exit 1
  pkill -f '[r]ecibidor-pcap.js' 2>/dev/null || true
  rm -f ~/captura-movie.pcap
  PCAP_MODE=tcp PCAP_OUT=/home/ubuntu/captura-movie.pcap nohup node recibidor-pcap.js > ~/recibidor.log 2>&1 &
  sleep 1
  cat ~/recibidor.log
  ```
  En PCAPdroid: **engrane Ajustes** → **Exportador TCP/UDP** → **Host del colector** = `129.80.212.92`, **Puerto del colector** = `8080`; volver y en **Volcado PCAP** seleccionar **"Exportador TCP"**. Luego capturar/reproducir/detener. Comprobar: `cat ~/captura-movie.pcap.status.json; ls -lh ~/captura-movie.pcap`. TCP no lleva clave: arrancarlo solo para la captura y detenerlo después con `pkill -f '[r]ecibidor-pcap.js'`.
- **Alternativa al tener el archivo en el teléfono:** en Oracle, pegar:
  ```bash
  cd ~/huddle || exit 1
  pkill -f '[r]ecibidor-pcap.js' 2>/dev/null || true
  PCAP_MODE=http PCAP_TOKEN='UNA-CLAVE-LARGA' nohup node recibidor-pcap.js > ~/recibidor.log 2>&1 &
  sleep 1
  curl -s http://127.0.0.1:8080/health
  ```
  Abrir `http://129.80.212.92:8080/` en el navegador del teléfono, elegir el PCAP y escribir la misma clave. Variables: `PCAP_OUT`, `PCAP_PORT`, `PCAP_MAX_MB` (1024 por defecto), `PCAP_IDLE_SECONDS`.
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
- **Integración Movie (v207)** — vive dentro de `server.js` (bloque `v207: MOVIE`) y `public/app.js` (`elegirTitulo`/`abrirSeriePicker`). Endpoints: `/api/movie/ficha/{clave}`, `/api/movie/poster/{clave}`, `/api/movie/hls/{clave}/{T}x{E}/{index5.m3u8|NNNN.ts}`, `/api/movie/probar`; más el bloque `movie` de `/api/estado`. Env: `MOVIE_MAPA` (ruta del mapa), `MOVIE_ORIGEN` (solo pruebas), `MOVIE_CAIDAS`.
- `recibidor-pcap.js` — receptor de PCAP para PCAPdroid (puerto 8080): por defecto TCP Exporter / pcap-over-IP con streaming, temporal atómico, validación PCAP y archivo `.status.json`; `PCAP_MODE=http` da página de carga + `GET /health` + `PCAP_TOKEN`.
- `cosechar-movie.js` — toma `~/movie-m3u8.txt`, revisa los manifests con concurrencia limitada y deja reporte local de estado HTTP, duración `EXTINF` y número de segmentos en `~/movie-cosecha.json` y `~/movie-cosecha.txt`; no descarga .ts ni guarda tokens.
- `cosechar-pcap-movie.js` — reconstruye únicamente respuestas HTTP de manifest ya presentes en el PCAP clásico, mediante dos pasadas y reensamble TCP, para recuperar estado/duración/segmentos capturados sin llamar al CDN ni guardar video/bodies/tokens. Deja `~/movie-cosecha-pcap.json/.txt` ignorados por git.
- `identificar-movie.js` — toma el reporte de cosecha, suma las fichas actuales de `?channel_id=230` de la vitrina al catálogo local, consulta `vod/info_web_get`, cachea las colecciones y propone título/temporada/episodio por duración; deduplica el catálogo defectuoso por `id`. `MOVIE_VITRINA=0` lo limita a la muestra local. Sus coincidencias son candidatas, no asignaciones definitivas si hay empate.
- `mapear-secuencias-movie.js` — toma exclusivamente `~/movie-cosecha-pcap.json`, preserva el orden de cada fecha y contrasta las respuestas históricas contra las huellas aprobadas. Solo asigna una ruta con su propio manifest coincidente; si falta manifest no infiere episodio. Genera `~/movie-mapa-secuencias.json/.txt`, ambos ignorados por Git.
- `catalogo-movie.js` — rastreador del catálogo completo vía `info_web_get` (ids 1→650 000, cortés y reanudable). Salidas AL REPO: `auditorias/catalogo-web/checkpoint.json` + `bloque-{N}.json`. Ver §2 "CATÁLOGO COMPLETO".
- `ordenar-pcap-movie.js` — escanea directamente PCAP/PCAPNG YA recibido, por bloques y sin depender de `tcpdump`, para generar orden temporal de rutas M3U8 + posibles requests HTTP de portada/ficha. También extrae solo el app `vod_id` (nunca device_id/query/sign) de `/control?msg=verify` y lo cruza con la caché/manifest cercano. No descarga video ni altera el PCAP; reportes locales ignorados por git.
- `captura_ss_v2.py`, `captura_ss_v3.py` — scripts mitmproxy (rondas WiFi proxy; ya casi obsoletos, PCAPdroid los reemplazó).
- `auditorias/catalogo-app-completo.json` — 8,000 filas históricas, pero solo 20 IDs únicos por tipo (paginación repetida; NO catálogo completo).
- `auditorias/novelas-app-catalogo.json` — 240 filas históricas, pero solo 20 IDs únicos repetidos; contiene ids web/app/pianwei de esa muestra.
- `auditorias/movievn-web.js` — script FUNCIONAL del API web (auth + search + info_web_get).
- `auditorias/api-movievn-NOTAS.md` — notas históricas del API (rutas, flujo, cifras).
- `auditorias/hallazgos-cdn.md` — el informe del hallazgo del CDN abierto (16 sep).
- `auditorias/huellas-secuencias-movie.json` — cinco firmas públicas de duración y metadatos de serie (sin rutas ni tokens) que permiten regenerar el mapa local de 38 asignaciones confirmadas; *Amar y Cuidar* está marcada excluida por audio tailandés.
- `auditorias/m3u8-capturado-señor-cielos.m3u8` — m3u8 real de muestra.
- `auditorias/RESUMEN-CONTINUACION.md` — resumen técnico de la era mitmproxy/StorySprout (el hallazgo de block_global, etc.).
- `auditorias/INFORME-PPCINE-OTRO-CHAT.md` — análisis del PPCine original hecho en otro chat (tc.f.a, proxy local, veredicto de semanas de reversa).
- `auditorias/kit-android-prestado.md` — el kit de instrucciones para la captura con el teléfono del amigo.
- `auditorias/seg0.ts` — segmento MPEG-TS verificado (3.2MB) del CDN abierto.
- `auditorias/capturas-y-fotos/` — los CSV de PCAPdroid y las fotos del teléfono del amigo con las URLs capturadas (evidencia original; legibles con OCR: tesseract + PIL 2-3x contraste 1.4).
- `auditorias/apk/ppcinees.apk` — la APK COMPLETA del app (57MB, respaldada aquí por si el link de descarga muere; extraer con `unzip`). Contiene: `lib/arm64-v8a/libpp_hls.so` (la lib nativa para el plan Ghidra de último recurso), `assets/pp_hlsProtected.dat` (su config cifrada), `AndroidManifest.xml` y `resources.arsc` (también sueltos en `auditorias/apk/`).

- (El resto del repo = Huddle mismo: server, 3 pestañas, players, etc.)

**Fuera del repo (re-crear si hacen falta):** la APK (URL en §3), decompilados jadx (re-ejecutar jadx 1.4.7 sobre la APK; las clases clave: 7=VideoPlayDetailActivity, 8=VIDEOPLAYDETAILVIEWMODEL, 3=API/decryptores).

## 9. INSTRUCCIONES PARA EL SIGUIENTE CHAT (resumen ejecutivo)
1. Lee TODO este archivo, en especial §2, §7 y `auditorias/huellas-secuencias-movie.json`; revisa `git status` antes de cambiar nada.
2. La captura #1 YA está en Oracle (`~/captura-movie.pcap`, 636.6 MiB), ya fue reconstruida desde el propio PCAP y **no se repite ni se borra**. Resultado final: 39 rutas, 38 manifests históricos, 38 asignaciones de título/T/E por secuencia y una ruta (`feec4d1e85fe`) sin asignación individual por falta de manifest. No subir PCAP, reportes ni mapa local al repo público.
3. Tras actualizar Oracle, el mapa se regenera sin red ni CDN con:
   ```bash
   cd ~/huddle || exit 1
   node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json
   cat ~/movie-mapa-secuencias.txt
   ```
   El server (v207) lo lee SOLO: integra únicamente rutas `disponibleParaMovieAhora` con audio `latino-inequivoco` (*Soy tu dueña* T1E5 y *Lo que la vida me robó* T1E9/E13/E17/E19 al 16-sep). *Amar y Cuidar* y la ruta sin manifest no pueden entrar (doble guarda en el server).
4. La integración Movie YA está hecha (v207): mapa local, reproductor nativo HLS (playlist reescrito propio), allowlist estricta, portada Movie + fallback `/carita.png`, caídas marcadas sin sustitutos. Antes de sumar otra ruta, verificar que el audio sea latino; ASR si hay duda. El estado real de cada ruta se comprueba con `/api/movie/probar` (una sola vez, marca caídas).
5. Si más adelante hace falta una captura diferente: PCAPdroid **"Exportador TCP" / pcap-over-IP**, no "Servidor HTTP". Pero no pedirla para resolver esta tanda ya cerrada.
6. Cualquier avance → actualiza ESTE archivo (estado, hallazgos, dead ends) → commit → push (`git push origin HEAD:main`). Recuérdale al usuario revocar el PAT al final.
