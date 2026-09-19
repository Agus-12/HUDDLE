# Reanudación exacta del proyecto: captura, CDN, búsqueda y audio

Última actualización: 19 de septiembre de 2026. Este archivo es una guía corta para el chat que continúe. La memoria completa está en `CONTINUACION.md`.

## 1. Estado confirmado

- Repositorio oficial: `Agus-12/HUDDLE`.
- Último commit que estaba en GitHub al redactar esta guía: `1c7b633`.
- Huddle de Oracle responde y sirve `app.js?v=v216`.
- v216 ya contiene: fila Movie arriba del inicio, ficha Movie con `Parte 1 · Latino`, arreglo de la `v` del identificador y `/api/subir-captura`.
- La ficha de The Runner ya fue comprobada contra la API: responde una parte reproducible desde Huddle.
- Falta que el CDN Wangsu reproduzca desde Oracle para completar el catálogo. El problema pendiente es la llave de 16 caracteres que firma `wsSecret`.
- La búsqueda MAPI todavía no está resuelta: `/search/screen` responde, pero con los parámetros probados ignora el texto y devuelve una lista general. El probador está en `scripts/mapi_search_test.py`.
- No se suben al repositorio público: PAT, contraseñas, `sslkeylogfile.txt`, PCAP, tokens, identificadores del teléfono ni capturas privadas. Esos archivos solo deben vivir en Oracle o en el teléfono.

## 2. Importante: el error del puerto 8080 del amigo

Para **la captura nueva que se está pidiendo ahora NO hace falta el puerto 8080**.

El puerto 8080 pertenece a procedimientos viejos: proxy WiFi, SOCKS5, mitmproxy o Exportador TCP. Si PCAPdroid dice que el puerto 8080 no funciona, normalmente tiene activado uno de esos modos, pero no hay un servicio compatible escuchando allí o se está usando el tipo equivocado.

### Receta recomendada, sin 8080

En el Android del amigo:

1. Abrir PCAPdroid y aceptar el permiso de VPN.
2. En Ajustes, apagar cualquier opción llamada **SOCKS5**, **proxy externo**, **proxy HTTP** o **Exportador TCP** que apunte a `129.80.212.92:8080`.
3. En Volcado PCAP elegir **archivo local** o **sin exportador**. El nombre exacto cambia según la versión.
4. No hace falta desinstalar el addon. Para esta captura tampoco hace falta activar Descifrado TLS; si está activado y causa avisos, apagarlo solo para esta prueba.
5. Iniciar la captura normal.
6. Abrir Movie, darle Play a una película o novela y dejarla correr dos minutos.
7. Detener la captura.
8. Exportar el archivo `.pcap` al teléfono.
9. Desde el navegador del teléfono abrir:

   `http://129.80.212.92:3000/api/subir-captura`

10. Elegir el `.pcap` y tocar Subir. Debe aparecer un mensaje que empiece por `Listo:`.

No debe configurar ningún puerto 8080 para esta receta. No debe instalar un proxy, escribir una IP de proxy WiFi ni comprar PCAPNG.

### Texto corto para WhatsApp

> No uses el puerto 8080 esta vez. En PCAPdroid apaga SOCKS5, proxy externo y Exportador TCP; elige guardar el PCAP en el teléfono. Inicia la captura, abre Movie, dale Play a una película durante 2 minutos, detén, exporta el archivo .pcap y súbelo desde el navegador a http://129.80.212.92:3000/api/subir-captura. No desinstales nada; solo quita esas opciones que apunten al 8080.

## 3. Qué hacer en Oracle después de la subida

El archivo se guarda como `~/captura-nueva.pcap`. El usuario pega esto **en Oracle**, no en la Mac:

```bash
ls -lh ~/captura-nueva.pcap
cd ~/huddle || exit 1
bash scripts/buscar-llave-cdn.sh ~/captura-nueva.pcap
```

Resultado esperado:

- `LLAVE ENCONTRADA`: el script escribe `~/movie-cdn-key.txt`; Huddle la toma automáticamente y se prueba Play desde Oracle.
- `sin llave`: no se cambia el catálogo todavía; se analiza el tráfico UDP de la captura y se decide el siguiente intento.
- archivo inexistente o tamaño cero: la subida no terminó; no borrar nada y revisar el mensaje de la página.

El PCAP no se sube a GitHub porque es grande y contiene tráfico privado.

## 4. Orden técnico al continuar

1. Confirmar que `~/captura-nueva.pcap` llegó completo.
2. Ejecutar el cazador de llave con el PCAP como argumento.
3. Si aparece la llave, probar desde Huddle una película, una novela y un segmento HLS.
4. Si no aparece, revisar únicamente la nueva captura; no repetir el brute-force viejo ni volver a buscar la llave en el APK sin evidencia nueva.
5. Resolver después el parámetro real de búsqueda MAPI usando el cuerpo de una petición real de `/api/search/screen` del archivo privado de Oracle. La salida que solo muestra `:path`, `:authority` y `:scheme` no contiene el cuerpo.
6. Completar paginación y catálogo únicamente después de tener reproducción estable.
7. Verificar audio: mantener siempre la pista latina; cuando haya duda, comprobarla escuchando o con ASR antes de marcar el episodio como latino.
8. Integrar audio, posters y continuación de reproducción sin inventar portadas. Usar `/carita.png` si la portada de origen falla.

## 5. Límites y decisiones que no deben cambiarse

- No integrar `Amar y Cuidar` ni la ruta `feec4d1e85fe`.
- No presentar los catálogos actuales como completos: todavía falta reproducción CDN y búsqueda/paginación.
- No dejar abierto un mitmproxy con `block_global=false` cuando no se esté haciendo una prueba.
- El servidor Huddle continúa siendo HTTP puro en el puerto 3000.
- El usuario actualiza Oracle con `bash ~/huddle/actualizar.sh`.
- Cada avance se documenta aquí y en `CONTINUACION.md`, se confirma con commit y se sube a GitHub.
- Al terminar la sesión, recordar revocar el PAT usado para el push.
