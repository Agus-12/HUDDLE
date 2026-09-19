# EL MÓDULO REAL DEL REPRODUCTOR, DESCIFRADO Y LEÍDO (v228.3, 19-sep-2026)

Este documento es el **resultado del "siguiente paso"** que quedó pendiente en
`PLAN-LLAVE-CDN.md` (§ envoltorio `SHOK`): volcar la tabla de textos del SDK
nativo. Se hizo, y trajo bastante más que eso.

> Regla de oro que sale de aquí: **buscar cosas con `strings` en el APK es
> buscar en el sitio equivocado.** Los `.so` del APK no tienen texto: todo el
> código y todos los textos del reproductor viven **cifrados** dentro de la
> sección `.mips`. Solo se ven después de descifrar e inflar (un comando, abajo).

---

## 1) Receta reproducible (un comando)

```bash
# en el taller (o donde tengas el APK) — necesita: pyelftools + zlib
cd auditorias/crack
python3 descifrar-modulo-hls.py /ruta/a/libpp_hls.so pphls
```

Qué hace, paso a paso (todo comprobado, no teoría):

1. Toma la sección **`.mips`** = offset `0x1507d0`, tamaño **1.532.446 B**
   (entropía 7,9999: cifrada).
2. La descifra con la **RC4 no estándar de jiagu** (`rc4_sbox_1.bin`, PRGA
   `i+2`, `j+1`, estado inicial `i0=3 j0=5` — el S-box se capturó con
   `emu_jiagu.py` y ya está en el repo, 256 B).
3. El resultado trae 4 bytes de cabecera = tamaño descomprimido en
   little-endian; `zlib` devuelve **exactamente 3.391.425 B** →
   `pphls_inflado.bin` = **el módulo real del reproductor**.
4. Vuelca sus textos a `pphls-textos.txt` (**18.996 cadenas**) y señala los
   puntos de interés con sus offsets.

Verificado en esta sesión: volvió a salir 3.391.425 B y 18.996 cadenas (el
mismo volcado que ya se venía usando). En el repo va el **volcado de textos**
(`auditorias/crack/hls-textos-sdk.txt`, 324 KB) para no depender de binarios;
los `.bin` de 3,4 MB no se suben (se regeneran con el comando de arriba).

---

## 2) Qué hay dentro del módulo (offsets exactos en `pphls_inflado.bin`)

| Offset | Qué es |
|---|---|
| `0x07a5xx` | **Tabla de símbolos del SDK**: `sim_md5`, `sim_buffer_encrypt`, `sim_buffer_decrypt`, **`sim_rc4_encrypt`**, `sim_config_set_value`, `sim_load_config_file`, `sim_load_config_buffer` |
| `0x07b7xx` | `hls_config_dump` / `hls_config_load` / `hls_config_init`, `g_hls_config` |
| `0x07cxxx` | `g_hls_process`, `hls_disk_*`, `hls_resource_*`, `hls_p2p_*` (bind/parse/share/upload/proxy…) |
| `0x27f8c1` | **config por defecto** empieza en `[BASE]` |
| `0x27f311` | plantilla de URL firmada: `%s%s%x` |
| `0x27f319` | plantilla de firma: **`wsSecret=%s&wsTime=%x`** |
| `0x27f259` | `Range: bytes=%s` y **`%s?c=getts`** |
| `0x27e0f9` / `0x27e161` | `m8=` y `sz=` (los dos parámetros que llevan los cortes) |
| `0x27e1xx` | errores: `m3u8 file format error, missing m8/sz…`, `m3u8 key download error` |
| `0x31e12d` | **lista de nombres de API de la app** (`info_new`, `get_sys_conf`, `search/screen`, `vod_share`, `user_vod`…) |
| `0x31e799` | **tabla de 64 hashes** de 32 hex |
| `0x31efd9` | config por defecto `[BASE]` completa (58 líneas) |
| `0x31f3e8` | config por defecto `[P2P]` (28 líneas) |
| `0x31bc39` | **clave RSA privada en PEM** (1.670 B) — NO se copia al repo |

Notas:

- El módulo **no contiene** la palabra `SHOK` ni `conf_key` (comprobado). El
  envoltorio `SHOK` sale, por tanto, **de otro sitio**: servidor o capa
  superior (la guarda jiagu / el servidor de control local del reproductor).
- Las **clamplillas de firma** están aquí, lo que confirma que el reproductor
  firma él mismo cada `m3u8`/`.ts` con `wsSecret=…&wsTime=…` (coincide con lo
  minado de los PCAP).
- La **RSA privada** explica el protocolo local del reproductor: escucha en
  **`player_listen_port=7000`** y su control (`/control?msg=verify`) puede ir
  firmado con esa clave. Es material para la Vía A (emulador) y para entender
  el empaquetado `pp_hlsProtected.dat` — **pero no es la llave del CDN**.

---

## 3) Config por defecto del SDK (verbatim, 19-sep-2026)

```
[BASE]
player_listen_port=7000
mp4_pre_proxy_size=10485760
mp4_pre_load_size=0
mp4_proxy_rate_min=1048576
mp4_proxy_delay_max=1500000
mp4_bitrate_default=262144
mp4_bitrate_adpercent=20
device_encrypt_key=Zox882LYjEn4Rqpa
ck=92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7
ck_t=1
ck_p=0
ck_e=10
ck_tf=16
ck_tt=999
cci=-1
autenable=1
nurl=http://fxuo.386m1.com/nft/get_info
cellular_net_upload_enable=0
backup_domain=null
resource_md5_prefix=null
resource_report_percent_min=23
clog_enable=0
ext_header_enable=1
dle_quick_report=0
dcontent_check_flag=15
download_http_error_limit=7
play_http_error_limit=50
connect_timeout=3000
download_retry_count=2
download_file_timeout=300000
download_concurrent_count=1
busyhours_timeframe_weekdays=10-0
busyhours_timeframe_weekends=10-0
busyhours_download_limit_level=3
hls_ts_count_max=20480
hls_ts_size_max=30728640
hls_m3u8_size_max=11534336
disk_cache_enable=1
disk_cache_count_max=200
disk_cache_size_max=9663676416
disk_cache_use_percent=27
disk_cache_memory_size_max=314572800

[P2P]
p2p_enable=1
p2p_port=7100
p2p_thread_add_percent=80
p2p_play_thread_count=3
p2p_download_thread_count=3
p2p_upload_thread_count=13
p2p_upload_total_rate=3145728
p2p_slice_size=1200
p2p_play_preload_offset=3
p2p_play_preload_count=20
p2p_play_request_timeout=40000
p2p_peer_keepalive_interval=11000
p2p_peer_use_timeout=600000
p2p_download_rate=2097152
p2p_download_rate_min=131072
p2p_download_time_min=3500
p2p_download_peer_count_max=6
p2p_download_fdata_timeout=2000
p2p_download_recv_timeout=200
p2p_tracker_addr=138.113.22.150:7202        <-- por defecto
p2p_tracker_request_timeout=200
p2p_tracker_peerlist_interval=60000
p2p_tracker_report_resource_interval=60000
p2p_tracker_report_log_interval=200000
p2p_stunserver_addr=stun.syncthing.net
```

**Lo importante de esta tabla:**

1. `device_encrypt_key=Zox882LYjEn4Rqpa` — es la clave que ya conocíamos:
   confirma que **las claves de firma de la API vienen de la config**, y que el
   servidor solo manda **los valores que cambia** (`p2p_config` en vivo trae
   solo 9 campos: `backup_domain=http://147.124.216.142`, `sec_domain=null`,
   `ck_t`, `ck_tt`, `ck_p`, `ck`, tracker `47.253.51.203:7202`,
   `p2p_stunserver_addr=stun.l.google.com`).
2. El tracker por defecto (`138.113.22.150:7202`) es distinto del vivo
   (`47.253.51.203:7202`): el servidor manda el suyo.
3. El SDK tiene **su propio servidor HTTP local** (`player_listen_port=7000`)
   con rutas `m3u8_key`, `ts`, `resource`, `control`, `src`, `msg`, `fd`… — es
   el que el reproductor de la app consulta; no confundir con el CDN.

---

## 4) Los 67 nombres de config, probados EN VIVO (resultado: nada nuevo)

Con los nombres **reales** (sacados del módulo, no inventados) se pidió
`/api/public/get_sys_conf` uno por uno — nombre por nombre, 67 + 8 extra:

* `player_listen_port`, `mp4_*`, `device_encrypt_key`, `ck`, `ck_*`, `cci`,
  `autenable`, `nurl`, **`backup_domain`**, `resource_md5_prefix`,
  `resource_report_percent_min`, `download_*`, `play_*`, `busyhours_*`,
  `hls_ts_count_max`, `hls_ts_size_max`, `hls_m3u8_size_max`, `disk_cache_*`,
  `p2p_*` (24 nombres)…
* extra: `m3u8_key`, `wsSecret`, `ws_key`, `cdn_key`, `sign_key`, `hls_key`,
  `secret`, `vod_tags`.

**Resultado (19-sep-2026):** todas devuelven `{"code": 10000, "message":
"éxito", "result": ""}` — **vacío** — salvo las 3 conocidas (`vod_tags`,
`ad_appid`, `p2p_config`). Formato de respuesta confirmado: JSON plano (no AES).

Conclusión: **el servidor no entrega ninguna clave por nombre que no sean las
tres que ya sabemos.** Herramienta: `auditorias/crack/probar_conf_nombres.py`.

---

## 5) Lo que se probó con este módulo y **no** dio resultado (no repetir)

| Prueba | Volumen | Resultado |
|---|---|---|
| Todos los textos del módulo como llave del CDN (`probar-textos-sdk-como-llave.py`) | **51.904 candidatas × 13 formas** (incluye `device_encrypt_key`, `ck`, la tabla de 64 hashes y todas las cadenas, con variantes hex/base64/md5) | **sin coincidencia** |
| Las mismas 51.904 contra 2 muestras con formas HMAC-MD5 y MD5 dobles (`md5(k+md5(…))`, `md5(md5(…)+k)`) | 51.904 × 17 formas | **sin coincidencia** |
| La tabla de 64 hashes de `0x31e799` | 64 constantes como llave y como md5 de los nombres vecinos | **no son llave; tampoco `md5(nombre)`** |
| Los 67 nombres reales de config contra la API viva | 75 peticiones | vacío (ver §4) |
| Buscar `SHOK` / `conf_key` dentro del módulo | — | **no están** |

Muestras usadas (las únicas locales, `muestras-wssecret.json`):
`/vod/1/2026/09/18/65328ba10998/0000.ts` → `t=6aae8430 s=537594217d786e4e4e71f80c893d578d`
`/vod/1/2026/09/18/65328ba10998/index5.m3u8` → `t=6aae842f s=312f56dae7496cd7def3a0fb29889f4a`

> Con solo 2 muestras no se puede *demostrar* una llave, pero sí **descartar**
> candidatas: ninguna de las 51.904 reproduce las dos a la vez.

---

## 6) Qué significa esto para conseguir la llave (hipótesis de trabajo)

1. **La llave no está en el APK** (ni en los textos del módulo real). Las dos
   candidatas que quedaban vivas: (a) la manda **el servidor** dentro de la
   respuesta que trae la URL (patrón visto: `error_m3u8_url`, `vod_url`), o
   (b) es **por archivo y por sesión** (los pases capturados duran días y
   cambian en cada petición con el mismo archivo → el tiempo entra en la firma,
   la llave no cambia).
2. El módulo **delega la firma**: `sim_md5` + plantilla `wsSecret=%s&wsTime=%x`.
   El único sitio donde puede entrar la llave es un ajuste de config **no
   entregado aún** o un **parámetro de la URL** que el servidor añade.
3. La vía que sigue siendo la más barata no cambia: **Vía A del PLAN**
   (emulador + interceptar el hash) y **Vía C** (puente: los pases capturados
   siguen valiendo días y son por archivo). Lo nuevo es que ahora la Vía A
   tiene un atajo: el módulo real ya está legible y **su servidor de control
   local (puerto 7000) puede firmar por nosotros** si se le da el mismo
   `[BASE]`/`[P2P]` y se le pide `m3u8_key`/`ts` con `src=`.

---

## 6b) DOS CORRECCIONES IMPORTANTES (v229, 19-sep — comprobadas, ahorran horas)

1. **El módulo inflado NO es código ARM64.** Se desensambló entero con Capstone: solo aparecen
   **2 pares ADRP+ADD en 3,4 MB** (y apuntan a páginas raras, `0xcebd2000`/`0xd2552000`, típicas de
   basura decodificada), frente a 18.996 cadenas de texto y tablas de símbolos. Es decir: el módulo
   es el **programa y los datos de la VM propia del SDK** (el intérprete está en el `.text` de
   `libpp_hls.so`, en `0xeff80–0xf2300`). **Consecuencia práctica: la firma no se puede leer
   desensamblando el módulo; hay que instrumentar el intérprete (Vía A).**
2. **El «firmador en `0xcc300–0xcca20`» de `libpp_hls.so` era un falso positivo.** Ese tramo son
   ~35 funciones diminutas con comprobación de canario (`mrs x8, tpidr_el0` → `bl 0x6d140` → `ret`):
   456 instrucciones y 35 `ret`. No hay firma ahí.

También comprobado: no hay **ninguna** tabla de punteros a los textos (0 punteros de 8 bytes a
`0x27f319`, `0x27f311`, `0x27f201` ni `0x27f259`), así que las direcciones de esos textos se calculan
en tiempo de ejecución (bytecode), no están enlazadas de forma estática.

Herramienta para repetirlo: `auditorias/crack/xrefs-modulo-hls.py`
(`python3 xrefs-modulo-hls.py --regiones` / `--texto "wsSecret=%s&wsTime=%x"`).

## 6c) ¿Y el espejo? — medido (v229)

Con `scripts/medir-completo-espejo.py`: el espejo `147.124.216.142` **no pide llave** pero **solo
entrega lo cacheado**, y contesta **206** a las peticiones por rango. Números de hoy:
`65328ba10998` → 54/366 (**14,8 %**), `4acbae6998e7` → 98/396 (**24,7 %**), `3605f6781343` → no está.
⇒ El espejo **no** da reproducción completa. Detalles: `auditorias/ESPEJO-Y-COMPLETITUD.md`.

## 7) Siguiente paso concreto (por orden)

1. **Vía A con el módulo legible** (PLAN §5): cargar `pphls_inflado.bin` en
   Unicorn y gancho en `sim_md5` para imprimir el buffer que se firma (la
   plantilla `%s%s%x` + `wsSecret=%s&wsTime=%x` da el formato exacto esperado:
   `md5( <llave> + <ruta> + <tiempo_hex> )`).
2. **Descifrar el envoltorio `SHOK`** del tráfico real: hace falta el **cuerpo
   crudo** de una petición `get_sys_conf` (el usuario lo tiene en la captura;
   se lee con `scripts/ver-llamadas-app.py --paths=get_sys_conf`). Ya sabemos
   que no está en el APK, así que se ataca como dato, no como código.
3. **Catálogo 70k**: sigue pendiente la cuenta/token (`--token` en
   `cosechar-generos.py`); con invitado el techo medido es ~485.
4. **Reproducir TODO desde `.142`** en cuanto tengamos el id de carpeta por
   episodio (el espejo cacheado no pide llave).

---

## 8) Herramientas que se suman al repo en este avance

| Archivo | Qué hace |
|---|---|
| `auditorias/crack/descifrar-modulo-hls.py` | **de cero al módulo real en un comando** (RC4 jiagu + zlib + textos + offsets) |
| `auditorias/crack/hls-textos-sdk.txt` | los 18.996 textos del módulo (no hace falta el binario de 3,4 MB) |
| `auditorias/crack/probar_conf_nombres.py` | pide a la API viva los **nombres reales** de config y marca material |
| `auditorias/crack/probar-textos-sdk-como-llave.py` | prueba cualquier volcado de textos como llave del CDN (13 formas, exige todas las muestras) |
| `auditorias/crack/rc4_sbox_1.bin` | el S-box (256 B) sin el cual el `.mips` no se puede descifrar |
