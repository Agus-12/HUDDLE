# Texto para pegar en el chat nuevo

Hola. Continúa este proyecto desde el repositorio oficial:

`https://github.com/Agus-12/HUDDLE`

Soy usuario no técnico y hablo español. Antes de responder o repetir trabajo:

1. Clona el repositorio usando el PAT que te daré en este chat. Nunca guardes el PAT en un archivo ni lo subas: el repo es público.
2. Lee **completo** `CONTINUACION.md`.
3. Lee `auditorias/REANUDACION-CHAT-CAPTURA-Y-AUDIO.md`.
4. Lee este archivo y revisa el commit remoto antes de confiar en números viejos.
5. Trabaja dentro del clone. Después de cada avance actualiza `CONTINUACION.md`, haz commit y push a `main`.

## Misión

Integrar en Huddle el catálogo Movie de películas, novelas, series y animación, con portadas reales, audio latino verificado y reproducción desde mi Oracle. Huddle debe seguir siendo HTTP puro, sin navegador remoto ni dependencias de sitios externos para reproducir. Conserva las reglas de `CONTINUACION.md`: tres pestañas, continuación con poster, fallback `/carita.png`, audio latino y exclusiones.

## Estado real más reciente

- Último commit público conocido: `dc6eddb` (`v223.1`). Verifica si hay uno más nuevo al clonar.
- El APK v4.0.0 ya fue analizado parcialmente: app `com.movievn.cinevi`, reproductor nativo Wangsu PPHLS, P2P activado y textos protegidos en `assets/pp_hlsProtected.dat`. Los dominios no están escritos en claro en el APK.
- El otro chat avanzó con un emulador de Android («androide de juguete»). **Antes de repetir ingeniería inversa, pregúntame qué llave, enlace firmado, archivo o resultado obtuvo ese otro chat y verifícalo con el oráculo.**
- Oracle fue verificado sirviendo `app.js?v=v222`; el repo tiene trabajo posterior v223/v223.1 todavía pendiente de que el usuario actualice Oracle con `bash ~/huddle/actualizar.sh` cuando corresponda.
- Huddle ya tiene catálogo propio por apartados: 441 títulos medidos desde la API invitada, paginados por el servidor. v222 mide qué títulos tienen segmentos disponibles y muestra completas, parciales o no disponibles.
- Sin la llave Wangsu, el espejo permite algunos títulos y segmentos cuando están en caché; no presentar eso como reproducción completa. La llave/firma del CDN sigue siendo el objetivo principal, salvo que el otro chat ya haya recuperado una.
- La búsqueda MAPI por texto y el catálogo grande de unos 70 000 títulos siguen sin resolverse. La API invitada devuelve conjuntos fijos y la búsqueda ignora los nombres de parámetros probados.
- La siguiente vía propuesta para el catálogo grande es una captura del amigo navegando el catálogo con Descifrado TLS, exportando `sslkeylogfile.txt` y subiendo ambos archivos por las páginas del servidor.

## Error del puerto 8080: qué debe hacer el amigo

El amigo informó que PCAPdroid dice que el puerto 8080 no funciona. **No usar 8080 para la captura nueva.** 8080 pertenecía a procedimientos antiguos de proxy WiFi, SOCKS5, mitmproxy o Exportador TCP. Si está activado:

- apagar SOCKS5/proxy externo;
- apagar Exportador TCP;
- elegir archivo local en Volcado PCAP;
- no configurar `129.80.212.92:8080`;
- no desinstalar el addon.

La captura debe guardarse en el teléfono y luego subirse desde el navegador a `http://129.80.212.92:3000/captura` o `/api/subir-captura`. El archivo de llaves pequeño se sube a `http://129.80.212.92:3000/llaves` o `/api/subir-llaves`.

Hay dos objetivos distintos; no mezclarlos:

### A. Para descubrir el catálogo grande

En PCAPdroid, sin 8080, activar el addon/Descifrado TLS si ya está instalado, aplicar la regla al app Movie, iniciar captura, abrir Movie y **navegar varias pantallas del catálogo** durante unos dos minutos. No es obligatorio reproducir un video para este objetivo. Detener y exportar:

- el PCAP a `/captura`;
- `sslkeylogfile.txt` a `/llaves`.

Después descifrar la petición real de `/api/search/screen` o el endpoint que use la app y replicarlo en Huddle.

### B. Para buscar la llave del CDN

En PCAPdroid, sin 8080, iniciar captura normal, abrir Movie, dar Play a una película o novela y dejarla correr dos minutos. Detener, exportar el `.pcap` y subirlo a `/captura`. En Oracle, no en la Mac:

```bash
ls -lh ~/captura-nueva.pcap
cd ~/huddle || exit 1
bash scripts/buscar-llave-cdn.sh ~/captura-nueva.pcap
```

Si dice `LLAVE ENCONTRADA`, probar inmediatamente un título frío desde Oracle. Si dice `sin llave`, analizar únicamente esa captura y no repetir brute-force agotados sin evidencia nueva.

Mensaje corto para WhatsApp:

> No uses el puerto 8080. En PCAPdroid apaga SOCKS5, proxy externo y Exportador TCP; guarda la captura en el teléfono. Para el catálogo, activa Descifrado TLS si ya lo tienes, abre Movie y navega varias pantallas durante 2 minutos; luego exporta el PCAP y también sslkeylogfile.txt. Súbelos desde el navegador a http://129.80.212.92:3000/captura y http://129.80.212.92:3000/llaves. Si buscamos la llave del video, además dale Play a una película durante 2 minutos.

## Audio y siguientes avances

1. Mantener solo audio latino.
2. No confiar ciegamente en la etiqueta de idioma: escuchar o usar ASR cuando haya duda.
3. No integrar `Amar y Cuidar` (audio tailandés) ni `feec4d1e85fe` (sin manifest válido).
4. Cuando haya reproducción estable, probar películas, novelas, series y animación, comprobar segmentos de inicio/medio/final y marcar completas/parciales.
5. Resolver búsqueda, paginación y catálogo grande solo con datos reales de la API/captura.
6. No inventar portadas: usar las del origen y `/carita.png` si fallan.

## Forma de trabajar con el usuario

- Responder siempre en español, breve y paso a paso.
- Cada bloque debe decir claramente: **Oracle**, **navegador del teléfono** o **Mac**.
- El usuario no tiene SSH en la Mac: no pedir `scp`; preferir navegador o bloques para Oracle.
- Avanzar técnicamente sin esperar tareas innecesarias del usuario.
- No subir PAT, contraseñas, `sslkeylogfile.txt`, PCAP, tokens, device IDs, APKs ni capturas privadas.
- Después de cada avance: actualizar `CONTINUACION.md`, commit y push.
- Al terminar la sesión, recordar revocar el PAT.

Empieza leyendo `CONTINUACION.md` completo, verifica el commit remoto y pregunta primero por los resultados del otro chat del emulador. No repitas cacerías ya marcadas como agotadas.
