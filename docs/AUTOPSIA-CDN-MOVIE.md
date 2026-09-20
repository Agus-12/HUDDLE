# Autopsia técnica: por qué el catálogo "Movie" no reproduce (y se desactivó)

> Resumen ejecutivo: el contenido real de la app **movievn** vive en un CDN
> (Wangsu) cuyas URLs van firmadas con `wsSecret`. La llave para firmar **no se
> pudo extraer** porque se fabrica dentro de una VM blindada (white-box) y nunca
> sale al tráfico de red ni a la memoria en claro. Tras agotar todas las vías de
> extracción (ver §5, con los números), se decidió **desactivar el catálogo Movie**
> (`MOVIE_ENABLED = false`) y quedarse con las fuentes latinas abiertas que **sí**
> reproducen (gopelis, cine-calidad, pelisxd, latanime, series).
>
> Fecha de cierre: 20-sep-2026 · Commit: v230

---

## 1. Arquitectura de la app "Movie" (movievn)

| Pieza | Valor |
|---|---|
| API | `https://surfclick.vd7au6.com` |
| Inicio (token) | `POST /api/public/init` |
| Ficha de video | `POST /api/vod/info_new` |
| Filas/secciones | `POST /api/channel/get_info` (`channel_id=226,225,227,230,228`) |
| Búsqueda | `POST /api/search/hot_search`, `POST /api/search/screen?type_id=` |
| CDN de contenido | `http://movievn.j5t2n.com` (origen, **con firma**) |
| Espejo oficial | `http://147.124.216.142` (HTTP sin firma, **100% relleno**) |
| Tracker P2P | `47.253.51.203:7202` (UDP) |

### Criptografía de la API (todo resuelto y probado)
- **AES de respuestas**: AES-128-CBC, key `0123456789123456`, iv `2015030120123456`.
- **device_id**: `687564646c653031` (hex del ASCII "huddle01").
- **channel_code**: `movievn_sh_1000`. **appid**: `bnmjhbjhvg000002`.
- **Firma de cabecera** (cada request): `MD5("47Q8tBqO4YqrMHf4" + device + ts).upper()`.
- **Firma de body `info_new`**: `MD5("Zox882LYjEn4Rqpa" + device + vodId + ts).upper()`.
  (El ts va en el body; `cur_time` igual.)
- **`init`**: body `device_id=...&channel_code=...`, `content-type: application/x-www-form-urlencoded`.
  Devuelve `result.user_info.token` (válido ~6 h).
- **`info_new`** (header `token`): devuelve `vod_collection[].vod_url` **sin firmar**.
- **Endpoint geo** `post $url` (naive proxy): firma
  `substr(md5("0172lbsj13JhGwqA" + ip + time_s() + ruta), 8, 16)` (16 hex; NO es la del CDN).

### Ojo: límites de la API
- `info_new` tiene **rate-limit por IP** → tras varias llamadas seguidas responde
  `code 40000 "Fracaso"`. Conviene espaciar y NO quemar el device de producción.

---

## 2. El esquema de firma del CDN (Wangsu wsSecret)

Las URLs de video al CDN van así:
```
http://movievn.j5t2n.com/vod/1/<año>/<mes>/<dia>/<hash>/index5.m3u8
    ?wsSecret=<32 hex>          ← firma (md5)
    &wsTime=<segundos unix en HEX, p.ej. 6aae842f>
```
Esquema estándar Wangsu (confirmado por la forma de las 7 ternas capturadas):
```
wsSecret = MD5( llave + pathname + wsTime )
```
- `pathname` = la ruta tal cual (`/vod/1/.../index5.m3u8`).
- `wsTime` = segundos unix **en hex** tal como aparece en la URL.
- `llave` = un secreto por-dominio configurado en la consola de la CDN y
  **embebido en la lib nativa de la app**. Es lo único que no tenemos.

Con la llave correcta y un `wsTime` fresco, cualquier `/vod/...` del catálogo
reproduciría por HTTP directo. Sin ella, el origen responde **403 (cuerpo vacío)**.

---

## 3. El espejo oficial es 100% "relleno" (no sirve de fuente)

`http://147.124.216.142` (el `backup_domain` oficial) **sí** sirve HTTP sin firma,
pero **todo** su contenido es falso. Se midió en 6 títulos reales:

| Título | duración real (ficha) | duración en el espejo |
|---|---|---|
| Matilda | 5889 s | 422 s |
| Harry Potter | largo | 422 s |
| Toy Story | largo | 422 s |
| Shrek | largo | 422 s |
| Avatar | largo | 2573 s |
| Titanic | largo | 0 s / FWD |

Es decir, **todo** cae a un video de error genérico. Heurística de detección de
copia falsa (quedó útil):
- el "default malvado" vive en `3g32mtioo2qs.4j4damaqa.com/vod/fwd/` (~43 min fijos);
- si `duraciónM3U8 < 50% · duraciónFicha` o la ruta contiene `fwd` ⇒ copia falsa.

---

## 4. Vías de extracción de la llave — TODAS agotadas

Hipótesis probadas y descartadas (contra el CDN en vivo y/o la captura de 39.5 MB):

| Vía | Resultado |
|---|---|
| `ck` de `sys_conf` (64-hex) como llave | **No**: 8 variantes (utf8-64, primeros/últimos 16, hex-32b, hex-16b, md5-hex, md5-bytes, sha1-16) → todas 403. Es del tracker P2P. |
| Llave en memoria tras `JNI_OnLoad` limpio | **No**: 2485 cadenas volcadas, 0 candidatas. |
| Espejo como fuente | **Muerto**: 100% relleno (§3). |
| Parcheo del bytecode de la VM | **Cerrado**: la lib se autoverifica y aborta. |
| Llave legible en el PCAP | **No**: 818 → 6,430 tokens legibles (6-48 chars) probados con 6 órdenes × hex/dec. |
| Llave binaria 16 bytes en el PCAP | **No**: barrido exhaustivo, ~69 millones de ventanas. |
| Llave binaria 16/32 bytes, tiempo en **decimal** | **No**: barrido completo con wsTime decimal. |
| Misma, con **ruta sin `/` inicial** y **URL completa** | **No**: 3 variantes de ruta × hex/dec × 2 órdenes. |
| Llaves **derivadas** (md5/sha de device, ck, secretos, canal…) | **No**: contra CDN en vivo y contra las 7 ternas. |

**Conclusión:** la llave **no está** en el tráfico capturado en ninguna forma
(legible, binaria, 16/32 bytes, con tiempo hex o decimal, ni con ninguna variante
de ruta u orden de concatenación razonable). La app la **deriva al firmar, dentro
de una VM white-box**, y ese valor nunca toca la red ni la memoria en claro.

### Lo único que SÍ se capturó
7 ternas firmadas reales (ruta + wsSecret + wsTime), válidas solo para ESA ruta y
ESOS segundos (caducan). Sirven para validar una llave candidata, no para firmar
el catálogo entero.

---

## 5. Única vía teórica que queda (no implementada)

No *extraer* la llave sino **usar la lib nativa como oráculo de firma**: ejecutar el
`.so` de la app en un runtime/emulador Android (ARM) y, por cada ruta del catálogo,
pedirle que devuelva la URL ya firmada. Esto **no** se implementó porque:
- requiere un runtime Android estable y accesible desde el servidor,
- la lib está protegida (VM/anti-tamper) y es frágil fuera del dispositivo,
- el costo/beneficio es malo frente a usar fuentes latinas abiertas que ya reproducen.

Si en el futuro se quisiera retomar: `scripts/buscar-llave-cdn.sh`,
`buscar-llave-cdn.py`, `cazar-llave-bytes.py`, `cazar-llave-mejorado.py`,
`cazar-llave-final.py` documentan la extracción y sirven para re-validar.

---

## 6. Decisión y estado actual (v230)

- `MOVIE_ENABLED = false` en `server.js` apaga todo lo de Movie:
  - `mapiPedir` / `mapiLista` / `mapiFicha` → `null` (sin llamadas a la API Movie);
  - `mapiTarjetasHome` / `mapiSecciones` → `[]` (home y "ver todo" sin Movie);
  - `movieRecargar` → mapa local vacío;
  - `movieCosechaArray` → `[]` (catálogo cosechado ~37k fuera);
  - `resolverMovie` → error claro ("ya no disponible").
- La app queda con las **fuentes latinas abiertas que sí reproducen**: gopelis,
  cine-calidad, pelisxd, latanime, danimados, series, etc. (resolución por proxy
  propio con UA/Referer correctos).

### Lección clave
Una llave de CDN que se deriva en una VM white-box **no se extrae mirando el
tráfico** (por exhaustivo que sea el barrido): hay que ejecutar el código que la
genera. La captura sigue siendo valiosa para **validar** candidatos, pero no puede
**entregar** la llave si el binario la esconde.
