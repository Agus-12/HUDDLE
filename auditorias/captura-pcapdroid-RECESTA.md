# 📡 CAPTURA CON PCAPdroid — receta (19 sep 2026)

## Por qué cambiamos de método

Se comprobó con el amigo: **con el proxy de WiFi puesto, el app Movie reproducía video
normal**. O sea que el app hace sus peticiones por un camino que **ignora el proxy del
WiFi**. Por eso en las tres capturas con mitmproxy solo cayó una llamada
(`public/upgrade`) y nunca el `info_new` que buscamos.

**El proxy de WiFi quedó descartado para esto.** La vía que sí ve todo es **PCAPdroid**,
que captura a nivel de VPN (no depende de que el app respete el proxy). Es el método que
ya funcionó antes en ese teléfono: de ahí salió la captura de 636 MB con los manifests.

Lo que sí se confirmó de paso (y vale oro): la fórmula de las cabeceras reproduce la firma
de las **cuatro** capturas hechas hasta ahora.

---

## PASO 1 — Tú, en Oracle

Apaga el mitmproxy (ya no lo necesitamos y ocupa el puerto 8080) y enciende el recibidor:

```bash
pkill -f mitmdump; sleep 2
cd ~/huddle || exit 1
bash actualizar.sh
PCAP_MODE=tcp PCAP_OUT=/home/ubuntu/captura-sign.pcap PCAP_PORT=47823 PCAP_MAX_MB=1024 \
  nohup node recibidor-pcap.js --matar-puerto > ~/recibidor.log 2>&1 &
sleep 3
pgrep -af recibidor-pcap
tail -5 ~/recibidor.log
```

⚠️ El `PCAP_OUT` es a propósito distinto del de siempre: **no queremos pisar
`~/captura-movie.pcap`**, que es la captura vieja de 636 MB.

⚠️ El `--matar-puerto` es obligatorio: en el servidor quedan procesos `mitmdump` colgados
de sesiones anteriores que **`pkill -f mitmdump` no alcanza**, y sin esa bandera el
recibidor muere con `EADDRINUSE: address already in use 0.0.0.0:8080`. Fue exactamente lo
que pasó el 19-sep: el pid 120950 seguía ocupando el 8080 y el recibidor no arrancó dos
veces seguidas. Con la bandera, el recibidor mata él mismo al ocupante antes de escuchar.

Comprobar que arrancó de verdad:

```bash
sleep 3
pgrep -af recibidor-pcap || echo "NO ARRANCÓ"
tail -5 ~/recibidor.log
ss -tlnp | grep 47823
```

La última línea debe decir `node`. Si dice `mitmdump`, algo falló.

### Por qué el puerto 47823 y no el 8080

El 8080 lo prueban los escáneres de internet constantemente. El 19-sep eso provocó dos
problemas seguidos: primero un `mitmdump` colgado lo tenía ocupado (`EADDRINUSE`) y luego,
ya libre, **decenas de bots por segundo** se conectaban y el log se llenó de
`TCP rechazado de 91.148.245.43… / ya hay una captura en curso`.

Aparte se corrigió un fallo real del recibidor: asignaba el lugar de captura (`activo`)
**antes** de comprobar que los primeros 4 bytes fueran una cabecera PCAP válida. Con el
bombardeo de bots el lugar quedaba ocupado casi todo el tiempo, así que una conexión
legítima caía en «ya hay una captura en curso». Ahora `activo` se asigna **después** de
validar la cabecera.

Probado: con 150 conexiones de basura simultáneas, el cliente legítimo conecta y guarda
19.6 KiB (`/tmp/bots.pcap`). Antes no podía.

Opcional, si aun así molestan: `PCAP_ALLOW_IP=<IP-del-telefono>` descarta en silencio todo
lo que no venga de esa IP (el log deja de llenarse).

Debe listar el proceso y algo como escuchando en el 8080.

---

## PASO 2 — Mensaje para tu amigo (WhatsApp)

> Va la buena, ahora con otro app que sí ve todo 🙌 (el anterior no servía porque el
> Movie lo ignoraba)
>
> 1. Instala **PCAPdroid** de la Play Store (es gratis).
> 2. Ábrelo. Si pide permiso de VPN, acéptalo.
> 3. Toca el menú (las tres rayitas) → **Ajustes** → busca **"Descifrado TLS"**
>    o **"MITM"** → **actívalo**. Si pide instalar un certificado, acepta todo.
> 4. Otra vez en el menú → **"Volcado PCAP"** → **"Exportador TCP"**
>    (en inglés: *TCP Exporter*). Ahí escribe:
>    - IP / destino: `129.80.212.92`
>    - Puerto: `47823`
>    → Guardar / activar
> 5. En la pantalla principal, si te deja **filtrar por app**, elige solo **Movie**.
>    (Si no te deja, no importa, dale igual.)
> 6. Toca **INICIAR** (el botón de empezar a capturar).
> 7. Abre el app **Movie** → toca una película → **dale PLAY y déjalo correr 1 minuto**
>    de verdad, que se vea el video.
> 8. Hazlo con **2 películas o novelas distintas**.
> 9. Vuelve a PCAPdroid y toca **DETENER**.
> 10. Ya puedes desactivar el exportador TCP. 🙌
>
> Avísame cuando termines.

---

## PASO 3 — Ver si llegó algo (mientras él captura, o al terminar)

```bash
ls -lh ~/captura-sign.pcap 2>/dev/null
cat ~/captura-sign.pcap.status.json 2>/dev/null
tail -20 ~/recibidor.log
```

## PASO 4 — Extraer el sign (cuando el archivo esté completo)

```bash
cd ~/huddle
node cosechar-pcap-movie.js ~/captura-sign.pcap ~/sign-cosecha.json 2>&1 | tail -30
LC_ALL=C grep -a -o -E '.{0,80}(info_new|vod_id=[0-9]+&[^"]{0,200}|sign=[0-9a-fA-F]{32})' \
  ~/captura-sign.pcap | head -40
```

Pegarme la salida completa.

---

## PASO 5 — Cerrar

```bash
pkill -f recibidor-pcap
```

---

## Notas técnicas

- **Qué buscamos:** un `POST /api/vod/info_new` con su cuerpo
  `vod_id=…&cur_time=…&sign=…&audio_type=…`. Esa terna `(device_id, cur_time, sign)`
  resuelve el candado con `auditorias/crack/resolver_sign.py`.
- **Candidato principal ya identificado por ingeniería inversa:** el tercer trozo del sign
  es `device_encrypt_key` = **`Zox882LYjEn4Rqpa`** (campo `[cfg+0x38]`, NO el `ck` que está
  en `[cfg+0x40]`). Encontrado en la config por defecto embebida en texto plano dentro del
  módulo de `libpp_hls` (`pphls_mips_inflado.bin`, `0x31efd9`–`0x31f6c5`). Sin verificar.
- **Por qué no se puede verificar desde el servidor:** la API responde
  `系统出问题啦~请稍后再试` a cualquier petición hecha desde fuera, **incluso con el
  `device_id`, la fórmula y el `token` exactos del teléfono**, mientras que al teléfono le
  responde `code:10000`. Comprobado el 18-sep con las dos cosas. Parece un filtro por
  origen/huella TLS. Por eso hace falta la captura.
- **El PCAP NO se sube al repo** (es público y el archivo pesa cientos de MB).
- `cosechar-pcap-movie.js` ya existe y funcionó sobre el PCAP anterior (link type 101).

## PASO 0 — El addon NO está en la Play Store (descubierto el 19-sep)

El addon de descifrado **no aparece en la Play Store** (solo salen PCAPdroid y USB WiFi
Monitor al buscar el autor). Se instala por APK directo de GitHub:

- **v2.4 (arm64, la recomendada):**
  `https://github.com/emanuele-f/PCAPdroid-mitm/releases/download/v2.4/PCAPdroid-mitm_v2.4_arm64-v8a.apk`
- **v1.4 (respaldo; incluye armeabi-v7a para teléfonos viejos):**
  `https://github.com/emanuele-f/PCAPdroid-mitm/releases/download/v1.4/PCAPdroid-mitm_v1.4_arm64-v8a.apk`
  `https://github.com/emanuele-f/PCAPdroid-mitm/releases/download/v1.4/PCAPdroid-mitm_v1.4_armeabi-v7a.apk`

En el teléfono: abrir el enlace en Chrome → descargar → tocar la notificación → Instalar
(aceptar "instalar apps desconocidas" si lo pide). Con el addon instalado, en
Ajustes → Inspección de tráfico aparecen "Decodificación TLS" y "Certificado CA".
