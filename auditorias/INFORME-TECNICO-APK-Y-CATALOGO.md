# Informe técnico público: APK Movie, API y catálogo

Fecha del corte: 19 de septiembre de 2026.

Este informe separa con cuidado lo **comprobado**, lo **reconstruido** y lo que todavía **no se obtuvo**. No debe decirse que Huddle ya tiene las 70 000 películas y series: esa cifra no fue descargada ni verificada en este proyecto.

## 1. Resultado corto

- APK analizada: Movie v4.0.0, paquete `com.movievn.cinevi`.
- APK de referencia: `https://app.r2c7a0.com/version/movievn/movievn_sh_1000-V4.0.0.apk`.
- Reproductor: Wangsu PPHLS, con librería nativa `com.pp.hls` y P2P activado.
- API móvil observada: `https://surfclick.vd7au6.com/api`.
- API invitada comprobada: devuelve conjuntos fijos; no entregó el catálogo de 70 000.
- Catálogo que sí se obtuvo de forma reproducible: 441 títulos únicos de cuatro canales, agrupados por Huddle y paginados por el servidor.
- Catálogo de 70 000: **pendiente**. La explicación más probable es que la cuenta del amigo recibe un catálogo distinto o que la aplicación usa un endpoint/cursor que todavía no se ha identificado.
- Siguiente vía técnica: captura del tráfico del amigo mientras navega el catálogo, junto con `sslkeylogfile.txt`, o recuperar el resultado del otro chat que usó un emulador Android.

## 2. Cómo se obtuvo y desarmó el APK

1. Se descargó la APK desde la URL recomendada por la configuración de la propia aplicación.
2. Se desempacaron los `classes*.dex`, `assets` y las librerías nativas de las arquitecturas disponibles.
3. El código Java/Kotlin legible se revisó con extracción de cadenas y decompilación. El reproductor nativo no quedó completamente legible porque está protegido y carga textos en tiempo de ejecución.
4. Se localizaron las llamadas del reproductor, los nombres de las rutas API y el flujo de reproducción.
5. Se compararon esos hallazgos con capturas de red del teléfono y respuestas descifradas de la API.

### Componentes relevantes

- `com.movievn.cinevi`: paquete principal.
- `com.pp.hls`: reproductor Wangsu. Sus métodos nativos importantes son `load(...)` y `exec(...)`.
- `com.jiagu.sdk.pp_hlsProtected`: capa protectora que carga la librería y textos.
- `assets/pp_hlsProtected.dat`: aproximadamente 27 KB; comienza con el marcador
  `*#*#0123456789ES9876543210#*#*`. El resto es una tabla de textos protegidos.
- `lib/arm64-v8a/libpp_hls.so`: aproximadamente 2.9 MB y sin las cadenas útiles en claro.
- La búsqueda de dominios dentro de los dex y assets no encontró los dominios de servicio completos. Se concluyó que se construyen durante la ejecución o salen de la tabla protegida.

### Flujo nativo observado

La aplicación inicia el SDK P2P/Wangsu con información semejante a:

- nombre del paquete `com.movievn.cinevi`;
- identificador de aplicación del reproductor;
- una clave/configuración interna del SDK;
- `is_p2p=1` recibido de la API.

El SDK devuelve un puerto local de control. Después la aplicación consulta una dirección local equivalente a:

`http://127.0.0.1:{puerto}/control?msg=verify&device_id=...&ts=...`

El cuerpo de esa respuesta se usa como `sign` en la consulta de información del video. Esto explica por qué intentar fabricar el `sign` solamente desde Oracle no fue suficiente.

La URL de video que devuelve la API es un m3u8 base. El reproductor del teléfono agrega la firma del CDN a la playlist y a los segmentos. Por eso la API puede entregar una URL sin `wsSecret`, mientras que el teléfono sí consigue reproducirla.

## 3. Protocolo de la API móvil

La API móvil observada es:

`https://surfclick.vd7au6.com/api`

Las peticiones usan, entre otras, estas cabeceras de aplicación:

```text
app_id: movievn
version: 40000
sys_platform: 2
device_id: identificador del dispositivo
channel_code: movievn_sh_1000
cur_time: milisegundos Unix
sign: firma MD5 en mayúsculas
token: token de invitado o de sesión
user-agent: okhttp/4.12.0
content-type: application/x-www-form-urlencoded
```

La cabecera general comprobada se reconstruye como:

```text
MD5("47Q8tBqO4YqrMHf4" + device_id + cur_time)
```

La firma del cuerpo de `vod/info_new`, cuando se dispone de la fórmula de la versión comprobada, es:

```text
MD5("Zox882LYjEn4Rqpa" + device_id + vod_id + cur_time)
```

La respuesta de la API llega como base64 y se descifra con AES-128-CBC usando las constantes del protocolo de la aplicación:

```text
clave: 0123456789123456
IV:    2015030120123456
```

Estas constantes no son tokens personales. No deben confundirse con el `device_id`, el token de sesión ni con la llave del CDN.

### Inicio de sesión de invitado

La aplicación puede obtener un token de invitado mediante `public/init`. Después consulta configuración, canales, tipos y fichas. No se necesitó una cuenta para obtener los 441 títulos de las filas públicas.

### Ficha y audio

La llamada importante para una ficha es `vod/info_new`. Su cuerpo contiene, según el caso:

```text
vod_id=...
cur_time=...
sign=...
audio_type=...
```

La respuesta contiene `vod_collection[]`. En cada elemento pueden aparecer:

- identificador del episodio o parte;
- nombre de la pista;
- idioma o etiqueta de audio;
- `vod_url`, normalmente un m3u8;
- duración y otros metadatos.

La etiqueta de idioma no se considera suficiente por sí sola. Huddle mantiene la regla de comprobar el audio por escucha o ASR cuando haya duda.

## 4. Cómo se obtuvo el catálogo que sí está comprobado

Se consultaron los endpoints públicos de invitado y se descifraron sus respuestas:

1. `type/get_list`: entregó tipos equivalentes a Películas y Novela.
2. `channel/get_list`: entregó los canales públicos principales:
   - 225: Inicio;
   - 230: Telenovela;
   - 226: Películas;
   - 227: Series;
   - 228: Animación.
3. `channel/get_info` se consultó para 226, 230, 227 y 228.
4. Se deduplicaron los títulos por `vod_id`.
5. Huddle construyó su catálogo propio y lo pagina de 24 tarjetas por página para no depender de que la API remota pagine.

Resultado medido:

| Apartado | Títulos únicos aproximados |
|---|---:|
| Películas | 159 |
| Telenovelas | 86 |
| Series | 94 |
| Animación | 102 |
| **Total** | **441** |

También se comprobó:

- `hot_search`: conjunto pequeño, aproximadamente 10 elementos en la respuesta de invitado.
- `recommend`: aproximadamente 20 elementos.
- `search/screen` con tipos de película/novela: aproximadamente 20 elementos por conjunto.
- Cambiar `page`, `page_no`, `pageNo`, `offset`, `start`, `limit`, `last_id`, `pageindex` y otros nombres no cambió las respuestas.
- En las pruebas, `key`, `wd`, `keyword`, `search_key`, `story`, `name`, `q` y otros nombres no hicieron que el texto de búsqueda filtrara los resultados.

Los scripts y el catálogo de diagnóstico están en el historial del repositorio. Huddle no declara esos 441 como el catálogo total del servicio: son el conjunto público que se pudo obtener sin cuenta.

## 5. La verdad sobre las 70 000 películas y series

**No se obtuvo el catálogo de 70 000.** No existe en este repositorio un archivo verificado con esa cantidad y no sería correcto inventarlo.

Lo que sí se sabe:

- La API invitada entrega conjuntos fijos y pequeños.
- La aplicación del amigo puede mostrar más contenido por tener cuenta, sesión, canal diferente o una ruta que no se reprodujo desde el cliente invitado.
- La paginación que se probó contra la API invitada fue ignorada o devolvió el mismo conjunto.
- Por lo tanto, sumar páginas con un `page=2` no produce los 70 000.
- No se debe presentar el catálogo de 441 como los 70 000.

### Cómo se debe obtener el catálogo grande

La vía técnica correcta es observar una petición real del teléfono que sí muestre más elementos:

1. En PCAPdroid, evitar el puerto 8080: apagar SOCKS5, proxy externo y Exportador TCP.
2. Elegir guardar la captura en el teléfono.
3. Si el addon ya está instalado, activar Descifrado TLS y la regla para Movie.
4. Iniciar la captura.
5. Abrir Movie y navegar varias pantallas del catálogo durante aproximadamente dos minutos.
6. Detener y exportar el PCAP.
7. Subir el PCAP a `http://129.80.212.92:3000/captura`.
8. Subir el `sslkeylogfile.txt` a `http://129.80.212.92:3000/llaves`.
9. Descifrar los cuerpos HTTP/2 y localizar la petición real de búsqueda, canal, cursor o lista.
10. Repetir desde Oracle el endpoint comprobado y validar que la respuesta sea realmente paginable antes de incorporarla a Huddle.

El otro chat informó de un emulador Android. Antes de repetir el procedimiento, hay que pedir qué consiguió ese emulador: llave, enlace firmado, salida del endpoint, archivo de configuración o captura. Cualquier hallazgo debe validarse con una petición de prueba y no se debe aceptar como llave solo porque parezca una cadena hexadecimal.

## 6. CDN, firma y por qué faltan videos

Los m3u8 y segmentos del CDN usan parámetros parecidos a:

```text
wsSecret=...
wsTime=...
```

El desensamblado del reproductor mostró una rama Wangsu para claves de longitud 16 con una entrada equivalente a:

```text
MD5(llave + ruta_sin_consulta + wsTime_hex)
```

La ruta se corta antes del primer `?`. La firma se genera en el teléfono por el reproductor y no viene necesariamente en la respuesta de la API.

Se observó una función de borde de CloudFront:

- objeto caliente en el borde: puede responder 200 sin que Huddle conozca la llave;
- objeto frío: responde 403 si no lleva una firma válida;
- por eso algunos títulos empiezan y otros se cortan en un segmento posterior.

Se probaron muchas llaves candidatas, fórmulas, hosts, cabeceras y bordes. Ninguna de las candidatas públicas produjo una respuesta 200 en un objeto frío de control. El cazador actual está en:

```text
scripts/buscar-llave-cdn.sh
scripts/cazar-llave-bytes.py
```

El cazador prueba texto y ventanas de bytes del tráfico capturado, incluyendo el tráfico UDP del rastreador. Los PCAP se procesan únicamente en Oracle y no se suben al repo.

## 7. Capturas y qué se aprendió

Capturas anteriores permitieron observar:

- enlaces HLS y segmentos;
- varias ternas reales `wsSecret`/`wsTime`;
- tráfico del rastreador `47.253.51.203`;
- que el `resource_md5_prefix` no apareció en una de las capturas;
- que el teléfono obtiene o calcula información adicional durante la reproducción.

El `sslkeylogfile.txt` sirve para descifrar TLS cuando el tráfico del cliente pasa por el mecanismo de captura. No debe publicarse porque contiene material sensible de la sesión. El PCAP también puede contener identificadores, sesiones y tráfico privado.

Para la captura nueva de CDN, después de reproducir dos minutos se usa en Oracle:

```bash
cd ~/huddle || exit 1
bash scripts/buscar-llave-cdn.sh ~/captura-nueva.pcap
```

Para la captura del catálogo grande, además del PCAP hace falta subir el keylog por separado.

## 8. Audio latino y exclusiones

La API ofrece etiquetas de audio y Huddle conserva `audio_type`, pero la aplicación puede etiquetar mal una pista. Por eso el flujo correcto es:

1. obtener el m3u8 y los segmentos;
2. extraer o escuchar una muestra de audio;
3. usar ASR cuando el idioma no sea evidente;
4. marcar solo `latino-inequivoco` como disponible para Movie.

Se excluye expresamente:

- `Amar y Cuidar`: la muestra tenía audio tailandés;
- `feec4d1e85fe`: no tenía manifest válido.

El servidor tiene doble guarda para que una ruta excluida no entre aunque aparezca en un mapa antiguo.

## 9. Archivos públicos relevantes

- `CONTINUACION.md`: memoria y estado completo del proyecto.
- `auditorias/PROMPT-PARA-NUEVO-CHAT.md`: texto para continuar en otro chat.
- `auditorias/REANUDACION-CHAT-CAPTURA-Y-AUDIO.md`: receta corta de captura, CDN y audio.
- `auditorias/crack/`: notas y herramientas de análisis del APK y firmas.
- `scripts/ver-urls-cdn.py`: muestra rutas y parámetros pedidos en una captura, sin publicar llaves.
- `scripts/buscar-llave-cdn.sh`: busca la llave del CDN en una captura local de Oracle.
- `scripts/cazar-llave-bytes.py`: búsqueda exhaustiva de candidatas binarias en el tráfico.
- `scripts/mapi_search_test.py`: probador de `hot_search`, `recommend` y `search/screen`.
- `server.js`: proxy, catálogo, fichas Movie, reproducción espejo y páginas de subida.
- `public/app.js`: catálogo, ficha, reproductor y medición de disponibilidad.

No se publica la APK binaria, el PCAP, el keylog, tokens, identificadores del teléfono ni credenciales. La APK se puede volver a descargar desde la URL indicada arriba.

## 10. Regla para futuros chats

Antes de decir «ya obtuve las 70 000», el siguiente agente debe demostrar:

- archivo o respuesta con el total;
- endpoint real y parámetros;
- paginación que cambie los resultados;
- deduplicación por identificador;
- prueba de varias páginas;
- y, si se afirma reproducción, comprobación de segmentos de inicio, medio y final.

Hasta entonces, la afirmación correcta es: **Huddle tiene 441 títulos públicos medidos, más contenido parcial de caché, y la ruta para descubrir el catálogo grande está pendiente de una captura real o del resultado del emulador del otro chat.**
