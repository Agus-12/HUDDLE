# 🔑 PLAN LLAVE DEL CDN — cómo conseguir la reproducción COMPLETA

**Objetivo del usuario:** que las pelis y series «se vean bien y completas» en Huddle.
Hoy eso no pasa para todos los títulos porque el CDN exige un **pase firmado por archivo** que el
teléfono calcula con una **llave** que vive dentro del SDK. Este documento es el **manual completo**
para seguir por donde quedamos: estado, evidencia, lo probado, lo que falta y las vías ordenadas
por probabilidad, con comandos exactos.

> Regla: **no dar nada por bueno sin probarlo contra un pedacito FRÍO** (ver sección 7).

---

## 1) EL PROBLEMA, EN CORTO

- Cada archivo del CDN (`index5.m3u8` y cada `NNNN.ts`) se pide con `?wsSecret=<md5>&wsTime=<hex>`.
- La fórmula es conocida y está **confirmada** (plantillas halladas dentro del módulo del reproductor):
  ```
  texto = <llave> + <ruta_sin_consulta> + <wsTime>        (plantilla "%s%s%x")
  wsSecret = MD5( texto )                                  (en minúsculas)
  wsTime   = segundos unix en hexadecimal
  ```
  Variantes presentes en el mismo módulo: `wsSecret=%s&wsTime=%u` (mismo tiempo en decimal) y las de
  Wangsu adaptativo (`%s-%d-%d-%d-%s` → `auth_key=%d-%d-%d-%s`) y CloudFront
  (`{"Statement":[{"Resource":"%s%s",...}]}` → `Signature=%s&Expires=%u&Key-Pair-Id=%s`).
- **Falta UNA cosa: la `<llave>`** (16 bytes). Todo lo demás ya se sabe y está implementado.

## 2) QUÉ SE SABE DE LA LLAVE (evidencia)

- **No está escrita en el APK**: se probaron 605 millones de tramos de bytes de los módulos
  (`barrido_llave.c`) y ~700 000 cadenas de dex/assets/módulos (`probar_wssecret_multi.py`) contra
  8 muestras reales y luego contra 252: **nada**.
- **No se deriva de nada conocido**: 3 208 claves sacadas de la propia dirección y 443 derivadas de
  constantes del proyecto (cortes de la `ck`, MD5 de datos, la clave `hls`, el `Badci`…): **nada**.
- **Estructura del CDN**: los pases son **por archivo** (192 archivos → 192 pases distintos), y un
  mismo archivo re-pedido lleva **pase nuevo con wsTime nuevo** → confirma la fórmula con llave fija.
- **Duración**: un pase capturado el 16-sep seguía dando **200 el 19-sep** desde otra IP ⇒ **duran días**.
- **La llave entra al SDK en ejecución**: el módulo del reproductor tiene la tabla de textos cifrada
  (candado 360 Jiagu `pp_hlsProtected`) y el hash se despacha por **una tabla de imports
  (`0x2d5000`) que está VACÍA en el volcado** ⇒ el algoritmo lo provee el entorno interno
  (la VM del SDK), no el módulo.
- **El código de firma está localizado** en el módulo inflado (`auditorias/crack/pphls_elf_interno.so`):
  - Función que arma y usa los pases: **~0xcc1xx–0xccad4** (usa `m3u8`, `#EXTM3U`,
    `source_check_content`, `wsSecret=…`, `auth_key=…`, CloudFront).
  - Llamada al hash: **0xcca6c → 0x9f0a0** (0x9f0a0 es un salto a import: `ldr x17,[x16+0xa68]; br x17`).
  - Tabla K de MD5 presente en **0x229af0**; IVs en **0x2323f0** ⇒ el algoritmo es **MD5**.

## 3) LAS MUESTRAS REALES (para verificar cualquier candidata)

En `~/muestras-wssecret.json` (Oracle) hay **252 muestras** minadas de las capturas del usuario.
Las de referencia en el repo (mismas que usa el probador por defecto):

| ruta | wsTime | wsSecret |
|---|---|---|
| `/vod/1/2026/09/18/65328ba10998/index5.m3u8` | `6aae842f` | `312f56dae7496cd7def3a0fb29889f4a` |
| `/vod/1/2026/09/18/65328ba10998/0000.ts` | `6aae8430` | `537594217d786e4e4e71f80c893d578d` |
| `/vod/1/2026/09/18/65328ba10998/0003.ts` | `6aae8446` | `893d86c22fe0bf8c70ea0160c49c050a` |
| `/vod/1/2026/09/11/9db1ede34113/index5.m3u8` | `6aaa532c` | `101d6a4246d4fe7f260245d75de9d1d5` |

**Prueba rápida de una candidata** (milisegundos, offline):
```bash
cd ~/huddle
python3 auditorias/crack/probar_wssecret_multi.py ~/muestras-wssecret.json --derivadas
# si se quiere agregar una llave a mano: editar CLAVES_FIJAS del script y volver a correr
```

## 4) VÍA A — TERMINAR EL EMULADOR (la más prometedora)

`auditorias/crack/emu_hls.py` (del otro chat) carga `libpp_hls.so` con **Unicorn**, aplica
relocalizaciones, ejecuta `INIT_ARRAY` y llega a `JNI_OnLoad`. **Estado: corre pero termina en
«métodos nativos registrados: 0».** Ejecuta bytecode de la VM y ya descifra textos internos
(se ven cadenas tipo `A101S9v63mXfa`).

**Preparación (una vez):**
```bash
sudo apt-get update && sudo apt-get install -y python3-pip
pip install pyelftools capstone unicorn
mkdir -p ~/apk-trabajo && cd ~/apk-trabajo
[ -f apk.apk ] || curl -sL -o apk.apk "https://app.r2c7a0.com/version/movievn/movievn_sh_1000-V4.0.0.apk"
cd ~/huddle && mkdir -p auditorias/apk/lib/arm64-v8a
python3 - <<'PY'
import zipfile
z = zipfile.ZipFile('/home/ubuntu/apk-trabajo/apk.apk')
open('/home/ubuntu/huddle/auditorias/apk/lib/arm64-v8a/libpp_hls.so','wb').write(z.read('lib/arm64-v8a/libpp_hls.so'))
print('libpp_hls.so lista')
PY
python3 auditorias/crack/emu_hls.py --budget 300 2>&1 | tail -20
```

**Qué falta exactamente y cómo atacarlo (en orden):**
1. **Completar el JNIEnv de juguete.** La VM, después de `GetEnv`, comprueba algo y no llega a
   `RegisterNatives`. En `emu_hls.py` ya hay un esqueleto (`FindClass`, `GetStaticMethodID`,
   `RegisterNatives` están implementados como *stubs*). Plan: instrumentar `GetEnv` para registrar
   qué slots de la tabla JNI llama la VM (imprimir `slot[0]`, `slot[1]`…) y devolver valores
   plausibles (p. ej. un `jclass` falso válido para cualquier `FindClass`, un `jmethodID` distinto
   por nombre). Cuando `RegisterNatives` se dispare, el log dirá los métodos nativos y sus punteros
   — ESOS son los que calculan el sign.
2. **Interceptar el hash.** Aunque el módulo despache el hash por la tabla `0x2d5000` (vacía),
   podemos **parchearla**: escribir en esa dirección del espacio de la VM el puntero a un *hook*
   propio y, en el hook, leer `(ptr, len)` de la memoria del invitado, calcular **MD5 en Python** y
   devolver la cadena hex donde corresponda. Así el módulo «funciona» sin su entorno real.
   (El hook ya está preparado en el emulador: se ven `dlopen/dlsym` interceptados.)
3. **Llamar a la función de firma con datos reales y comparar.** Con la muestra de la sección 3:
   ejecutar el camino de firma con `ruta=/vod/1/2026/09/18/65328ba10998/0000.ts`,
   `wsTime=6aae8430` y **observar los argumentos** que entran a la función de hash (el log del
   emulador permite volcar registros). Comparar con `537594217d786e4e4e71f80c893d578d`.
   - Si coincide: **ya está** — la llave estará en el argumento que se le pasó al hash (o en la
     memoria que apuntaba). Se copia, se prueba contra un pedacito frío (sección 7) y se integra a Huddle.
   - Si no coincide: volcar qué texto exacto se firmó (el `%s%s%x` completo) y comparar con
     `llave+ruta+tiempo` para deducir la parte que falta (p. ej. prefijo de dispositivo).
4. **Si la VM no coopera**: emular directamente la función `0xcc1xx` (es ARM64 nativo, no bytecode).
   Para eso hay que mapear el volcado (`.so` inflado, sin secciones) en las direcciones que espera
   (el emulador ya lo hace) y proveer `snprintf`/`strlen`/`memcpy` (ya hay stubs) + el hook de MD5.

## 5) VÍA B — FRIDA (si aparece un Android con root)

`/control?msg=verify&device_id=…&ts=…` (servidor interno del reproductor en `127.0.0.1:<puerto>`)
devuelve el `verify` que el SDK usa para pedir la ficha. Con root:
- Hookear `Java_com_pp_hls_load` / `Java_com_pp_hls_exec` (los métodos nativos del reproductor) y
  volcar sus argumentos.
- O hookear la función interna que construye los pases (buscar `wsSecret` en memoria y poner un
  `Interceptor`/`Stalker` alrededor de la que escribe esa cadena).
- Con eso sale la **llave** directamente del proceso (es lo que hace el emulador, pero sin emular).

## 6) VÍA C — PUENTE PRÁCTICO (sin llave): reusar los pases capturados

Mientras la llave no salga, se puede **reproducir completo lo que ya está firmado en las capturas**:
- Los pases **duran días** y son **por archivo**: cada `NNNN.ts` con su `wsSecret` funciona desde
  cualquier IP mientras no expire.
- `scripts/minar-capturas.sh` ya saca todas las URLs firmadas de las capturas y guarda
  `~/muestras-wssecret.json` (formato `{ruta, t, s}`).
- **Propuesta para Huddle (pendiente de implementar)**: cargar ese archivo como un mapa
  `ruta_base → {seg: url_firmada}` y, al reproducir un título cuyo CDN coincide, **preferir el pase
  capturado** sobre el espejo; si expira (403), volver al comportamiento actual (espejo + salto de huecos).
- **Rendimiento**: cubre solo los tramos que el amigo reprodujo (no el título entero), pero
  convierte «a medias» en «completo» para esos tramos y sirve como demostración real.

## 7) EL ORÁCULO (cómo se verifica CUALQUIER avance)

Un `200` en un pedacito en caché **no prueba nada** (el borde lo tiene memorizado). La prueba es un
**pedacito frío**:

```bash
# fríos de referencia (19-sep; re-verificar antes de usarlos, la caché es dinámica)
curl -s -o /dev/null -w "%{http_code} frio\n" "http://movievn.j5t2n.com/vod/1/2026/09/08/4acbae6998e7/0010.ts"
curl -s -o /dev/null -w "%{http_code} frio\n" "http://movievn.j5t2n.com/vod/1/2026/09/08/4acbae6998e7/0030.ts"
# control caliente (da 200 aunque la firma sea falsa; no usar como prueba)
curl -s -o /dev/null -w "%{http_code} caliente\n" "http://movievn.j5t2n.com/vod/1/2026/09/02/4acbae6998e7/0020.ts"
```
Con una llave candidata `K`:
```
ruta=/vod/1/2026/09/08/4acbae6998e7/0010.ts
t=$(printf '%x' $(date +%s))
s=$(printf "%s%s%s" "$K" "$ruta" "$t" | md5sum | cut -d' ' -f1)
curl -s -o /dev/null -w "%{http_code}\n" "http://movievn.j5t2n.com${ruta}?wsSecret=${s}&wsTime=${t}"
```
**Éxito = 200 en un pedacito frío.** Si sale 403, la llave o el formato están mal (no insistir con
la misma candidata).

## 8) LO QUE YA NO HAY QUE HACER (gastó horas)

1. Buscar la llave en los PCAP (`captura-nueva`) o barrer bytes/cadenas del APK otra vez.
2. Probar `page/offset/limit/…` en la API (no existe; el catálogo se abre por **género/área**).
3. Esperar enlaces firmados de la API (no los entrega).
4. Probar otros bordes CloudFront (60 + 140 IPs ya probadas).
5. Encabezados mágicos (Badci/Referer/Origin/XFF/UA), HTTPS, firmas falsas.
6. `?c=getts` como servicio de hora.
7. El SDK de anuncios (oktdata) y sus llaves: son de publicidad.
8. Frontales web de otras marcas (marcador `freecine.cn`).
9. Medir el espejo en paralelo (falsos 0 %) o usar `0020.ts` de `4acbae6998e7` como frío (está caliente).

## 9) NUEVOS HALLAZGOS (19-sep, noche) — documentados para el siguiente chat

- **Envoltorio `SHOK`** en `get_sys_conf`: la app manda `conf_key=<nombre>SHOK<bloque1>SHOK<bloque2>`.
  - `<bloque1>` es **el mismo en todas las peticiones de una sesión** (84 caracteres base64 → **61 bytes**
    binarios, no múltiplo de 16 ⇒ **no es AES**; parece una firma/identificador de sesión).
  - `<bloque2>` solo aparece en algunas claves (`p2p_config`) y es más largo y variable; en `conf_key1`
    el bloque 1 y el 2 salen idénticos.
  - Pedir esos nombres «en claro» a la API (`conf_key1`, `conf_key2`, `m3u8_key`, `hls_key`,
    `wsSecret`, `cdn_key`, `secret`, `sign_key`, `device_encrypt_key`, `resource_md5_prefix`…) devuelve
    **vacío**. Solo tienen datos: `vod_tags`, `ad_appid`, `p2p_config` (y `p2p_config` es el único con
    material interesante: `ck` de 64 hex + `backup_domain` + tracker).
  - **Pendiente**: descifrar el bloque 2 (probando con las claves conocidas incluidas las del SDK) y
    ver qué claves pide la app con SHOK en una captura nueva (basta `--paths=get_sys_conf`).
- **`vod_tags` = la lista de géneros de la app** (`动作,喜剧,恐怖` = Acción, Comedia, Terror).
  El cosechador de catálogo debe iterar **exactamente** esos nombres (español con acentos y chino).
- El reproductor firma **también** para el espejo: en la captura se ven pases hacia `147.124.216.142`.
- La app usa **HTTP/2** para la API; el filtro `http2` de tshark 4.2 no acepta algunos campos:
  usar `scripts/ver-llamadas-app.py` (se adapta solo).

## 10) CRITERIOS DE ÉXITO

- **Llave conseguida** = 200 en frío con la fórmula de la sección 7 usando la llave nueva.
- **Reproducción completa** = el título se ve de inicio a fin sin saltos: comprobar pidiendo
  **segmento 0, el de la mitad y el último** de la lista (no basta el primero).
- **Catálogo** = el barrido por géneros deja de aportar títulos nuevos **y** el total cuadra con lo
  que declare la app; si no, hace falta cuenta (`--token`).
- **Audio latino** = escucha/ASR de una muestra de `type 2` antes de marcarlo.

---

### Anexo: archivos que importan para esta misión

| Archivo | Qué es |
|---|---|
| `auditorias/crack/pphls_elf_interno.so` | módulo del reproductor inflado (código de firma y plantillas) |
| `auditorias/crack/v4hls_inflado.bin` | volcado alterno del mismo módulo (sin secciones) |
| `auditorias/crack/emu_hls.py` | emulador Unicorn del reproductor (Vía A) |
| `auditorias/crack/barrido_llave.c` | barrido de bytes como llave (compilado; usa OpenSSL) |
| `auditorias/crack/probar_wssecret_multi.py` | probador offline contra muestras reales |
| `auditorias/crack/rastrear_firma.py` | rastreador del código de firma (Capstone, ADRP+ADD) |
| `scripts/minar-capturas.sh` | saca todas las URLs firmadas de una captura → `~/muestras-wssecret.json` |
| `scripts/descifrar-https.sh` | abre el HTTPS de una captura con `~/sslkeylogfile.txt` |
| `scripts/ver-llamadas-app.py` | lo que la app envía/recibe por llamada (descifra respuestas) |
