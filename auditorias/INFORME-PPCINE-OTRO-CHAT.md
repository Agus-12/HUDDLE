# Autopsia de la APK de películas (análisis del 2026-09-09)

**La pregunta:** ¿la app entrega video que Huddle pueda usar?
**La respuesta corta: SÍ — y ni siquiera necesitamos la app.** Es un raspador multi-sitio igual que Huddle, y uno de sus sitios (Pelisplus) entrega **mp4 directo** hoy.

## Qué es la app por dentro

- Paquete: `com.digitalproshare.filmapp` (Film App v4.4.7, 12.7 MB)
- **No tiene catálogo propio**: scrapea ~17 sitios de pelis/series (lista abajo)
- **Config remoto por Firebase Remote Config**: los regex y scripts de extracción se actualizan sin tocar el APK (campos `getterscripts`, `searchscripts`, `doodRegex`, `sbstreamHost`, `enlace`/`enlace2`…). Lo del código es el fallback.
- Motor JS **Rhino** dentro de la app para ejecutar scripts descargados + **solucionador del desafío de Cloudflare** propio (Clase `Cloudflare.java` con JWT/cookies)
- **Triple red de anuncios** (AppLovin Max + StartApp + Unity) → ese es "el anuncio primero"
- Reproductor: ExoPlayer; descargas: fetch2

## Sitios encontrados en el APK (estado al 2026-09-09)

| Sitio | Endpoint que usa la app | Estado |
|---|---|---|
| **pelisplus.video** → pelisplusto.art → **pelisplusapk.net** | `search.html?keyword=` | ✅ **VIVO — mp4 directo** (verificado) |
| allpeliculas.mx | `wp-json/get/players?id={id}` | ⚠️ vivo, muro anti-bot JWT (pasable con cookies), catálogo por JS |
| pelisxd.com | `?trembed={n}&trid={id}&trtype=1\|2` | ⚠️ vivo, migró a Next.js (player por API interna, requiere más trabajo) |
| stream.repelis.red (+repelis.red) | POST `edge-data/` con data-embed/issuer/signature | ✅ CDN vivo (repelis.red carga) |
| waaw.tv (fembed) | `watch_video.php?v={id}` | ✅ vivo (host de video fembed) |
| pelisplay.tv | — | ⚠️ estacionado (995b, sin contenido) |
| rexpelis.com | `player/embed/movie\|episode/{id}` | ❌ muerto |
| cinetux.to / .nu | `wp-admin/admin-ajax.php` | ❌ muerto/bloqueado |
| pelisplay.co | POST `entradas/procesar_player` (data + _token) | ❌ muerto |
| pelispedia.biz / .mobi | `admin-ajax.php` (doo_player_ajax) | ❌ muerto |
| repelisgt.net / pelisplusgt.com | `/graph` (GraphQL) | ❌ muerto |
| repelisplus.vip | `/buscar/{q}` | ❌ muerto |
| aquipelis.co, pelisgratis.live | `?s={q}` | ❌ muertos |
| pelishouse.com | `wp-json/dooplayer/v1/post/{id}` | ❌ estacionado (114b) |
| allcalidad.net, fanpelis.net | `?s={q}` | sin probar |

## ⭐ La cadena ganadora (100% verificada hoy, sin navegador)

**Pelisplus (pelisplusapk.net)** — pelis con mp4 directo:

```
1. GET  https://pelisplusapk.net/?s={búsqueda}
      → resultados: /peliculas/{slug}-A{id}Bx2/   (✓ probado: "avengers")

2. GET  https://pelisplusapk.net/peliculas/{slug}/ver/
      → <video> nativo con <source src="https://vidset.mp4movies.us/{id}/{hash}.mp4?{slug}"
         type="video/mp4" label="480p|720p|1080p">   (✓ probado 2 pelis)

3. El mp4:
      - HTTP 206 (range/seek OK) ✓
      - SIN Referer funciona ✓
      - rápido: 1 MB en 0.8 s ✓
```

- El "anuncio primero" de esa web está en `pausetime=10` (el player pausa a los 10s y mete el ad) — al tomar el mp4 directo **no existe**.
- Páginas de catálogo útiles: `/nuevas-peliculas/` (20 pelis), `/genre/accion/`, `/peliculas-populares/`, etc.

## Qué significaría integrarla a Huddle (v98 candidate)

- **Buscar**: parsear `/?s=` (mismo patrón que cine-calidad) → tarjetas con título/póster (usa TMDB vía i0.wp.com para imágenes).
- **Resolver**: parsear `/peliculas/{slug}/ver/` → regex de `<source src=...mp4>` → devolver mp4 nativo (¡como AnimeFLV en v97! Ni proxy ni iframe).
- **Riesgos**: los sitios de este mundo mueren seguido (la mitad de la lista del APK ya está muerta); el host `vidset.mp4movies.us` puede racionar; las series tienen estructura aparte (pendiente de mapear).

## Cómo se analizó (reproducible)

1. `curl` del APK oficial: `getapk.filmapp.io/Film App_4.4.7_filmapp.io.apk` (12.7 MB)
2. `unzip` + `strings classes*.dex | grep https` → lista de sitios
3. `jadx` 1.5.0 (Java 11) → decompilado en `src/sources/com/digitalproshare/filmapp/`
   - Extractores: `tools/C2421n.java` (pelis), `tools/C2428u.java` (series), `tools/C2422o.java` (búsquedas)
   - Config: `objetos/Version.java`, BD `tools/p123e0/C2411a.java`, carga en `SplashActivity` (Firebase)
4. Sondas curl en vivo por sitio + navegador headless (puppeteer) para el flujo con clics
5. Verificación final del mp4 con range request

*Nota: nunca se ejecutó la APK — solo análisis estático. El APK queda en `apk-analysis/filmapp.apk` y el decompilado en `apk-analysis/src/`.*

---

# Segunda autopsia: PPCine (el link que me pasaste — 2026-09-09)

**El link:** `o.z2v3m6.com` → loader de 559 bytes que baja `ppcinees.apk` (57 MB, 13 dex).
**Es la app del usuario.** Veredicto anticipado: **NO es aprovechable** — viene blindada.

## Qué es por dentro

- App **vietnamita** re-skinned: paquete real `com.movievn.cinevi`, disfrazado como `com.mgs.carparking` (nombre de juego para evadir escáneres — 2000+ clases bajo ese disfraz)
- Plantilla de app de media china (netbeans, RetrofitUrlManager, MVVM habit)
- **5+ redes de anuncios** (AppLovin, Moloco, Pangle/TikTok, Yandex, ironSource, InMobi, inneractive, Unity) → ese es "el anuncio primero", multiplicado
- Packer **jiagu** + strings cifradas: los endpoints del API NO se pueden leer en el código
- Dominios rotativos tipo `z2v3m6.com`, `e97z.com`, `simharif.com` (muerto); el API base se guarda en runtime (`KEY_PREF_BASE_URL40000`) tras pedirse a servidores bootstrap

## La arquitectura de video (por eso no sirve)

```
API (dominio rotativo, rutas cifradas, verificación por device_id + ts)
  → devuelve orginal_url de cada episodio
  → libpp_hls.so levanta PROXY LOCAL en 127.0.0.1:{port}
  → player reproduce: http://127.0.0.1:{port}/resource.m3u8?src={base64(orginal_url)}
  → el proxy nativo (2.9 MB, ofuscado, strings cifradas) baja el stream,
    lo descifra y lo sirve al reproductor
```

- `tc.f.a()` es solo Base64 (lo confirmé decompilando `tc/f.java`) — la URL no está escondida del proxy, pero el stream está protegido por la capa nativa + tokens por dispositivo
- `assets/pp_hlsProtected.dat` (27 KB) = config cifrada de la librería
- Sin versión web que la emule

## Conclusión

Para usar sus streams habría que revertir la librería nativa ofuscada Y mantenerse al día de sus dominios rotativos Y replicar su verificación por dispositivo. Semanas de trabajo con resultado frágil. **No vale la pena cuando Pelisplus (hallazgo de Film App) entrega mp4 directo sin proteger.**

---

## Tercera autopsia: PelisXD (pelisxd.com) — ✅ VIABLE, elegida para v98

**Veredicto: LA FUENTE.** Pelis en 1080p FULL (no teasers), sin registro, catálogo grande.

### Catálogo (sitemap.xml, 1.3MB)
- **4,678 películas** bajo /pelicula/ — **CERO series** (el título "y Series" es marketing; /serie/ → 404)
- 20 géneros, 37 años, posters de TMDB
- **~40% con enlaces vivos** (muestra 20: 8 vivas; test fiable = botón ">Opción 1</button>" renderizado en SSR HTML) ≈ **~1,870 pelis reproducibles**
- Buscador `?s=` server-side es DECORATIVO (misma lista siempre); búsqueda real client-side → para Huddle: índice propio desde sitemap

### Cadena de reproducción (verificada 4 veces con duración real)
1. GET /pelicula/{slug} → flight data Next.js trae v_source **BASE64** (p.ej. aHR0cHM6Ly9ieXNlcWVrYWhvLmNvbS9lL3B5YWo2aHB1bTR4ci8=) → Opción 1 = **Streamwish** (byseqekaho.com/e/{code}), Opción 2 = **DoodStream** (playmogo.com o myvidplay.com) — SIEMPRE esta estructura
2. byseqekaho API → embed_frame_url → espejo rotativo (f7hyg4q.org/kx9/{code})
3. Challenge anti-bot: POST /api/videos/access/challenge → /attest (confianza 0.82, JWT device) → /embed/captcha → /captcha/verify (token 30min) — **el navegador headless lo resuelve SOLO con solo autoplay+click**
4. POST /api/videos/{code}/embed/playback → payload **AES-256-GCM cifrado** (el player lo descifra en JS; irrelevante para nosotros)
5. Player pide master.m3u8 → **token SINGLE-USE** (curl posterior = 404 SprintCDN aunque sea fresco, con mismo referer) → variant index-v1-a1.m3u8 (1080p única calidad)
6. **SEGMENTOS .ts: token compartido, SÍ funcionan por curl** (UA + Referer https://f7hyg4q.org/) — verificadod 845KB MPEG-TS real

### Duraciones verificadas (lección de Pelisplus aplicada)
- el-efecto-mariposa: 682 segs = 113.6 min (real 113) ✓
- el-juego-de-ender: 683 segs = 113.8 min (real 114) ✓
- tortugas-ninja: 608 segs = 101.3 min (real 101) ✓
- Muertas honestas: trainspotting, yaksha → botón "Reportar enlace caído", el embed byseqekaho /e/noib7i9t26hu responde "error" 1.6KB

### Arquitectura v98 (patrón goodstream)
- Índice de catálogo: sitemap cacheado (24h) + título/poster de la página
- Stream: puppeteer una vez por peli (cache 2h, token vive 3h) → capturar BODY del variant playlist → reescribir segmentos como URLs relativas al server → /api/hls proxy (UA + Referer)
- Latencia primera reproducción: ~20-25s (challenge); siguientes: instantáneo
