> **CÓMO USAR ESTE ARCHIVO:** su contenido es literalmente lo que el usuario pega en el chat nuevo.
> Está escrito en su voz, sin tecnicismos, y apunta a los documentos donde vive el detalle técnico.

---

# Texto para pegar en el chat nuevo

Hola. Continúa este proyecto desde el repositorio oficial:

`https://github.com/Agus-12/HUDDLE`

Soy usuario no técnico, hablo español y quiero respuestas **cortas y en español llano**. El PAT de
GitHub te lo doy en este chat: úsalo solo para clonar y para `push`, **nunca lo escribas en un
archivo ni lo subas** (el repo es público) y recuérdame al final **revocarlo**.

Antes de responder o repetir trabajo:

1. Clona el repo con el PAT y verifica el **commit más nuevo de `main`** (el otro chat también
   publica ahí: haz `git fetch` + `merge` antes de cada `push` y **nunca** `--force`).
2. Lee **completo** `CONTINUACION.md`.
3. Lee, en este orden: `auditorias/CONOCIMIENTOS-Y-METODO.md`, `auditorias/PLAN-LLAVE-CDN.md`,
   `auditorias/MODULO-SDK-DESCIFRADO.md` y `auditorias/REANUDACION-CHAT-CAPTURA-Y-AUDIO.md`
   (este último solo como receta de captura y audio).
4. Trabaja **dentro del clon**. Después de cada avance: actualiza `CONTINUACION.md`, commit y
   `git push origin HEAD:main`.

## La misión

Huddle es mi servidor (Oracle) que junta el catálogo Movie (películas, novelas, series y animación)
con **portadas reales**, **audio latino verificado** y, sobre todo, **reproducción estable y
COMPLETA** («se tienen que ver bien y completas»). Huddle se queda en **HTTP puro** y con **tres
pestañas**. **No presentes el catálogo como completo hasta que la reproducción funcione.**

## Reglas que no se cambian

- Cada bloque de comandos debe decir **dónde se pega**: Oracle, navegador del teléfono o Mac.
  **No tengo SSH en la Mac: no me pidas `scp`.**
- No me pidas trabajo técnico que puedas hacer tú; avanza paso a paso y confírmame.
- Capturas: **no usar el puerto 8080** y **no molestar más al amigo**; usa lo que ya hay en Oracle
  (4 archivos `.pcap` y `~/sslkeylogfile.txt`).
- Si subo un `.pcap`, va **siempre** a `/api/subir-captura` (páginas `/subir` o `/captura`), nunca
  al de llaves. Las llaves van a `/api/subir-llaves` (página `/llaves`).
- **No subas al repo**: PAT, credenciales, tokens, device IDs, APKs, PCAP ni capturas privadas.
- No integres «Amar y Cuidar» ni la ruta `feec4d1e85fe`.
- Audio: verifica que sea **latino** (si hay duda, ASR o escucha) antes de marcarlo.
- Portadas: las originales del origen; si fallan, `/carita.png`.
- Si algo no cede, anótalo en «Descartado» y cambia de ángulo (así aparecieron el keylog, el cuerpo
  real de `search/screen` y los géneros).

## Estado real (19-sep-2026, madrugada — v229)

- **Catálogo**: medido con barrido por géneros/áreas = **485 títulos únicos** (236 tipo 1 + 266
  tipo 2); la app tiene >70 000, así que falta la vía de cuenta (`--token` en
  `auditorias/crack/cosechar-generos.py`). El invitado topa en unos cientos.
- **API**: viva y sin llaves raras: `sign = MD5("47Q8tBqO4YqrMHf4"+device_id+cur_time_ms).upper()`,
  `info_new = MD5("Zox882LYjEn4Rqpa"+device_id+vod_id+cur_time_ms).upper()`, respuestas
  base64→AES-128-CBC (`0123456789123456` / `2015030120123456`), `audio 2 = latino`, `1 = subtítulos`.
- **Capturas**: el HTTPS de la captura ya se abre con el keylog; se ve la API por HTTP/2 y las
  playlists firmadas (`wsSecret=…&wsTime=…`, cortes con `sz=` y `m8=`).
- **Muro (lo que falta)**: la **llave del CDN** (`wsSecret`) para que la reproducción sea completa.
  Los pases capturados duran días y son por archivo: sirven de puente, no de solución.
- **Nuevo (v228.3)**: el **módulo real del reproductor ya está descifrado y leído** con un solo
  comando (`auditorias/crack/descifrar-modulo-hls.py`): dentro están sus funciones (`sim_md5`,
  `sim_buffer_encrypt/decrypt`, `sim_rc4_encrypt`), las plantillas de firma, la **config por defecto
  completa** `[BASE]`/`[P2P]` (con `device_encrypt_key=Zox882LYjEn4Rqpa`, `ck`, su servidor local en
  el **puerto 7000**) y una clave RSA privada de su protocolo de control. Informe:
  `auditorias/MODULO-SDK-DESCIFRADO.md`.
- **Ojo, dos correcciones comprobadas (v229)**: (1) ese módulo **no es código**, es el programa de la
  VM del reproductor: la firma **no** se puede leer desensamblándolo, hay que instrumentar el
  intérprete (está en `.text`, `0xeff80–0xf2300`); (2) el «firmador 0xcc300–0xcca20» que se anotó
  antes era un **falso positivo** (son funciones enanas con comprobación de canario). Por eso ya no
  quedan volcados binarios con la clave privada en el repo: se borraron y se regeneran con el
  comando de arriba.
- **El espejo, medido de verdad (v229)** con el medidor nuevo
  (`scripts/medir-completo-espejo.py`): no pide llave, **pero solo da lo que tiene en caché**, y
  contesta **206** a las peticiones por rango (medir cuesta 1 byte por pedacito). Números del
  19-sep: `65328ba10998` → **54/366 = 14,8 %**; `4acbae6998e7` → **98/396 = 24,7 %**;
  `3605f6781343` → no está. ⇒ **El espejo NO da reproducción completa** (sirve para tramos y para
  probar el reproductor). Informe: `auditorias/ESPEJO-Y-COMPLETITUD.md`.
- **Ya descartado** (no volver a intentarlo): los 51.904 textos del módulo como llave, los 67 nombres
  de config reales pedidos en vivo (todos vacíos salvo `vod_tags`, `ad_appid`, `p2p_config`), la
  tabla de 64 hashes, `strings` sobre el APK, los 140 bordes de CloudFront y las matrices gigantes de
  firmas. El envoltorio `SHOK` **no está** en el APK ni en el módulo: sale del servidor.

## Siguiente paso, en este orden

1. **Llave del CDN por la Vía A con el atajo nuevo**: emular el módulo real ya legible
   (`pphls_inflado.bin`) y poner el gancho en `sim_md5` para ver **qué buffer firma**; comparar con
   las muestras reales (`auditorias/PLAN-LLAVE-CDN.md` §3) y, si coincide, verificarla contra un
   **pedacito frío** (§7, el oráculo) antes de cantar victoria.
2. **Descifrar el envoltorio `SHOK`**: necesitas el **cuerpo crudo** de una petición `get_sys_conf`
   de la captura; el comando (se pega en **Oracle**) es:
   `cd ~/huddle && python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap --paths=get_sys_conf`
   (te diré yo el resultado; no hace falta que lo abuses).
3. **Catálogo grande**: conseguir cuenta/token y correr `cosechar-generos.py --token …` hasta que el
   barrido deje de traer títulos nuevos.
4. **Reproducir TODO desde el espejo `147.124.216.142`** (no pide llave) en cuanto tengamos el
   **id de carpeta por episodio**; el catálogo del espejo cambia por día, así que **re-mide antes de
   concluir**.
5. Cuando la reproducción completa funcione: integrarla en Huddle (3 pestañas, portadas,
   `/carita.png` de respaldo, audio latino) y **solo entonces** decir que el catálogo está listo.

Gracias. Trabaja igual que el chat anterior: paso a paso, en español llano, y subiendo cada avance
al repo. Al terminar, recuérdame revocar el PAT.
