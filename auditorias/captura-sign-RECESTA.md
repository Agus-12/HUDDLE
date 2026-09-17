# 🔑 CAPTURA DEL SIGN — receta paso a paso (18 sep 2026)

**Para qué sirve:** el último candado para sacar las URLs de video reales del catálogo
completo (las 26 000+ fichas ya rastreadas) es el `sign`. Ya sabemos cómo se calcula
(leído del código de la app), pero no podemos comprobarlo porque **el servidor de la app
está caído hoy** (responde "系统出问题啦~请稍后再试" hasta con una firma correcta).

En vez de seguir adivinando, capturamos **una firma real** del teléfono de tu amigo.
Con eso resuelvo el candado en minutos.

**Qué cambia respecto a la captura anterior:** el capturador viejo imprimía las cabeceras
y las respuestas, pero **no el cuerpo del POST** — y la firma viaja justo ahí. Por eso
hace falta el addon nuevo `captura_sign.py` (ya está en el repo).

---

## PASO 1 — Tú, en Oracle (entra a `ubuntu@huddle` como siempre)

Copia y pega TODO este bloque:

```bash
cd ~/huddle || exit 1
bash actualizar.sh
cp ~/huddle/auditorias/captura_sign.py ~/captura_sign.py
ls -l ~/captura_sign.py ~/.mitmproxy/mitmproxy-ca-cert.pem
cp ~/.mitmproxy/mitmproxy-ca-cert.pem ~/huddle/public/mitm.crt
pkill -f mitmdump; sleep 1
nohup ~/.local/bin/mitmdump -s ~/captura_sign.py --listen-host 0.0.0.0 --listen-port 8080 --set block_global=false > ~/captura-sesion.txt 2>&1 &
sleep 4
pgrep -af mitmdump
tail -3 ~/captura-sesion.txt
curl -s -o /dev/null -w "cert en la web: %{http_code}\n" http://127.0.0.1:3000/mitm.crt
```

**Qué tiene que salir, en orden:**
1. `APP ACTUALIZADA Y CORRIENDO: http://129.80.212.92:3000` (lo de siempre)
2. una línea tipo `-rw-r--r-- ... /home/ubuntu/captura_sign.py` (el capturador nuevo copiado)
3. una línea con `mitmdump` (el proceso vivo)
4. `Listening on http://*:8080` o parecido
5. `cert en la web: 200`

Si sale otra cosa, pégame la salida TAL CUAL, completa.

⚠️ Si `ls -l ~/captura_sign.py` dice "No such file", el repo no se actualizó:
pégame lo que dijo `actualizar.sh`.

---

## PASO 2 — Mensaje para tu amigo (copia y pega en WhatsApp)

> Oye, me haces un favor de 10 minutos? 🙏 Es una prueba en tu teléfono,
> no le pasa nada y al final lo dejamos igual.
>
> 1. En Chrome entra a: `129.80.212.92:3000/mitm.crt`
>    (se baja un archivo chiquito que se llama mitm)
> 2. Ajustes → busca "credenciales" → **Instalar desde el almacenamiento** →
>    elige **mitm** → ponle nombre o dale OK.
>    *(Si ya lo instalaste la vez pasada, sáltate el 1 y el 2.)*
> 3. Ahora el proxy: Ajustes → WiFi → tu red → el engranaje →
>    **Configuración de proxy** → **Manual**
>    Servidor: `129.80.212.92`   Puerto: `8080`   → Guardar
> 4. Abre el app **Movie** → entra a cualquier película o novela →
>    **dale PLAY y déjalo correr 1 minuto** (que cargue y se vea el video).
> 5. Cierra el app.
> 6. Y lo más importante: quita el proxy. Mismo lugar del paso 3 →
>    Proxy: **Ninguno** → Guardar. 🙌
>
> Avísame cuando termines.

---

## PASO 3 — Tú, otra vez en Oracle: recolectar

```bash
grep -c '>>>' ~/captura-sesion.txt
tail -c 200000 ~/captura-sign.jsonl | tail -40
```

Pégame **toda** la salida del segundo comando (aunque salga feo). Ahí viene la firma
real y con eso termino el candado.

Si el primer comando dice `0`, el amigo no llegó a reproducir: que repita el paso 4.

---

## PASO 4 — Apagar todo (cuando terminemos)

```bash
pkill -f mitmdump
rm -f ~/huddle/public/mitm.crt && cd ~/huddle && bash actualizar.sh
```

⚠️ **No dejes el proxy corriendo días.** Con `block_global=false` acepta a cualquier
desconocido mientras el proceso viva. Se enciende para la prueba y se apaga después.

---

## Notas técnicas (para el chat que continúe)

- **Qué buscamos en el JSONL:** un registro con `"url"` que contenga `/api/vod/info_new`
  y un `"cuerpo_req"` tipo `vod_id=711142488&cur_time=1789...&sign=xxxxxxxx&audio_type=es`.
  Ese `sign` + ese `cur_time` + el `device_id` de las cabeceras = una terna verificable.
- **Qué hago con eso:** fuerzo el `ck` en local sobre
  `md5(device_id ‖ ts ‖ ck)` (y sus variantes de orden, mayúsculas, sha1/sha256 truncado).
  Candidatos ya listados: `92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7`
  (el `ck` real leído de `p2p_config`), `87c2cb7ff568d602d5f806c473345600`,
  `47Q8tBqO4YqrMHf4`, `de304f03fe653f329edfea08ea2046c4`, `1be0ac56`,
  `6A21635498FB7F1E13648270050E1346E`, `6BE2FB29B23E42031B1900D85E0756B75`.
  Si ninguno cuaja, la terna igual sirve para deducir la fórmula exacta.
- **Bonus de la misma captura:** si el amigo reproduce, también caen las respuestas de
  `info_new` (con la URL de video real) y los `.m3u8`/`.ts` del CDN → rutas reproducibles
  nuevas sin depender del candado.
- **El `~/captura-sign.jsonl` NO se sube al repo** (lleva tokens y device ids).
- El certificado ya estaba instalado en el teléfono del amigo y el okhttp del app acepta
  CAs de usuario (comprobado antes: los POST upgrade sí se descifraron). Lo que **no** se
  puede capturar es el `/control?msg=verify` local (va a 127.0.0.1 y no pasa por la VPN):
  por eso se ataca por el lado de la API, no por el del SDK.
