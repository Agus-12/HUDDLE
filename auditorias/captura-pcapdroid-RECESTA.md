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

##  VÍA B (LA BUENA, 19-sep ~09:15): SOCKS5 hacia el mitmproxy del servidor

El usuario ejecutó por su cuenta el bloque viejo de `mitmdump --mode socks5` en el 8080
(y mató al recibidor de paso). Probado desde el sandbox: `socks5h://129.80.212.92:8080`
da 200 en http y https. **Esta vía es mejor que el addon:**

- El MITM lo hace el mitmproxy del SERVIDOR, donde ya corre `captura_sign.py`
  (el addon probado que descifra y guarda en `~/captura-sign.jsonl`).
- El teléfono ya confía en esa CA desde el 15-sep. No hay que instalar nada nuevo.
- PCAPdroid fuerza TODO el tráfico del app por el túnel (nivel VPN), así se acaba el
  problema de "el app ignora el proxy".
- No hacen falta ni el addon `PCAPdroid-mitm`, ni el recibidor, ni el exportador TCP.

Configuración en el teléfono:
1. PCAPdroid → Ajustes → **SOCKS5** → activar → host `129.80.212.92`, puerto `8080`.
2. En **Volcado PCAP** quitar el Exportador TCP (elegir archivo local o nada): el 8080 ya
   no es el recibidor, es el SOCKS5.
3. "Decodificación TLS" NO se activa (sin addon). El descifrado ocurre en el servidor.
4. INICIAR → usar Movie (2 fichas, 1 min de reproducción) → DETENER.

Resultado esperado: nuevas líneas con `info_new` en `~/captura-sign.jsonl` del servidor.

Comando de arranque (ya corriendo, pid 122606):

```bash
nohup bash -c 'ulimit -n 65536; exec ~/.local/bin/mitmdump --mode socks5 -s ~/captura_sign.py --listen-host 0.0.0.0 --listen-port 8080 --set block_global=false' > ~/captura-sesion.txt 2>&1 &
```

## Análisis del volcado descifrado (pendiente al reanudar)

```bash
echo "--- hosts descifrados ---"
grep -a -iE "authority|Host:" ~/volcado-http.txt | sort | uniq -c | sort -rn | head -15
echo "--- rutas ---"
grep -a -oE "(GET|POST) /[a-zA-Z0-9_/.?=-]{2,70}" ~/volcado-http.txt | sort | uniq -c | sort -rn | head -25
echo "--- algo de surfclick? ---"
grep -a -c "surfclick" ~/volcado-http.txt
head -40 ~/volcado-http.txt
```

Si `surfclick` da 0: el app Movie no pasó por el mitm del addon para su cliente de la
API ⇒ ir al plan del proxy de WiFi con fichas abiertas (ver CONTINUACION.md, bloque
"ESTADO PARA REANUDAR").

## Revivir el proxy de WiFi + buscar api_url2 (bloque único)

```bash
pkill -f recibidor-pcap; pkill -f mitmdump; sleep 2
nohup bash -c 'ulimit -n 65536; exec ~/.local/bin/mitmdump -s ~/captura_sign.py --listen-host 0.0.0.0 --listen-port 8080 --set block_global=false' > ~/captura-sesion.txt 2>&1 &
sleep 4
curl -s -m 20 -x http://127.0.0.1:8080 http://example.com -o /dev/null -w "proxy -> %{http_code}\n"
grep -o -E "http://[a-zA-Z0-9./_?=&-]+" ~/captura-sign.jsonl | sort | uniq -c | sort -rn | head -20
grep -o -E "api_url[0-9]?[^,}]{0,90}" ~/captura-sign.jsonl | sort -u | head -10
```


## ⚠️ 19 sep ~02:00 — PCAPNG ES DE PAGA en la versión Play Store del amigo

Captura del amigo: "Formato Pcapng" aparece en "Funciones de pago" ($75). **NO se compra.**
No hace falta: con "Descifrado TLS" del addon (ya instalado y ACTIVADO en su teléfono)
el descifrado es EN VIVO y el PCAP plano que exporta el Exportador TCP ya lleva el
payload descifrado. Vía final confirmada: addon + Reglas de descifrado (app Movie) +
Exportador TCP → recibidor 47823 (probado desde el sandbox: acepta y libera ✔) +
Bloquear QUIC=Siempre. Recibidor corriendo (pid 135097).


## 19 sep ~02:10 — el 47823 bloqueado en la red del amigo; recibidor movido al 443

El teléfono del amigo no pudo conectar a 47823 ("failed to connect"), aunque desde el
sandbox el puerto SÍ acepta (probado 2 veces). Bloqueo de salida en la red del amigo.
Recibidor reiniciado con PCAP_PORT=443 (salida casi nunca bloqueada). El amigo cambia
"Puerto del colector" a 443.


## 19 sep ~02:15 — 443 imposible (EACCES, puerto privilegiado) → recibidor en 8080

`listen EACCES 0.0.0.0:443`: ubuntu no puede ligar <1024. Vuelta a 8080: es >1024, está
libre (mitmdump muerto) y —dato clave— el teléfono del amigo YA conectó a 8080 en las
pruebas del proxy de WiFi, o sea que su red NO lo bloquea. El "Broken pipe" que vio el
amigo en Movie era PCAPdroid rompiendo conexiones por el exportador muerto; con puerto
vivo desaparece.


## 🎉 19 sep ~08:56 — CAPTURA DE 111 MB + KEYLOG TLS 1.3 EN MANO

- Exportador TCP a 8080 FUNCIONÓ: `~/captura-sign.pcap` = 111 MiB.
- PCAPdroid entregó al terminar `sslkeylogfile.txt` (473K, secretos TLS1.3:
  SERVER/CLIENT_HANDSHAKE_TRAFFIC_SECRET, EXPORTER_SECRET, SERVER_TRAFFIC_SECRET_0).
  El usuario lo adjuntó al chat como `uploads/llaves.txt`; se subió a Oracle vía
  `POST /api/subir-llaves` (483334 bytes en ~/sslkeylogfile.txt).
- Siguiente paso: `tshark -r captura-sign.pcap -o tls.keylog_file:~/sslkeylogfile.txt`
  en Oracle y grep de info_new. El PCAP salió SIN descifrar (grep info_new = 0 en crudo),
  o sea que el descifrado del addon no aplicó al app Movie — pero con el keylog da igual.


## 19 sep ~09:05 — keylog SÍ corresponde al PCAP; el fallo era `-Y http` (el app usa HTTP/2)

Randoms del PCAP (f444dffc…, e3763b29…) presentes en el keylog ✔. 8087 paquetes TLS a 443.
tshark sin quejas pero 0 `http`: porque OkHttp negocia **h2** → el filtro correcto es
`-Y http2`. (Nota: server.js corre como ROOT en Oracle: os.homedir()=/root; el POST de
subir-llaves escribe a /root/sslkeylogfile.txt — hubo que copiarlo a ~/.)


## 🎉🎉 19 sep ~09:10 — TLS DESCIFRADO: 3 POST info_new REALES EN MANO

Filtro correcto `-Y http2`. Cayeron 3 fichas abiertas por el amigo:
- vod_id=2106611381 cur_time=1789807525714
- vod_id=562930699  cur_time=1789807580826
- vod_id=1309804053 cur_time=1789807640588
Falta extraer el `Form item: "sign"` y el `Header: device_id` (bloque grep siguiente).
Con la terna → resolver_sign.py deriva fórmula+secreto → verificar en vivo con tls_client.
