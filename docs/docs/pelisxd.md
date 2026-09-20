# PelisXD — Documentación Técnica

## Datos generales
- **URL**: https://www.pelisxd.com
- **Tipo**: Películas (latino, sin series)
- **Catálogo**: ~4,678 películas (del sitemap)
- **Idioma**: Latino (siempre)
- **Calidad**: HD (720p-1080p)
- **Protocolo**: HTTP puro (el sitio carga directo)

## Cómo funciona el catálogo
1. El sitemap (`/sitemap.xml`) lista todas las películas con slugs
2. Se cachea 24 horas (`PELISXD_IDX_TTL`)
3. La búsqueda (`buscarPelisxd`) compara tokens del título contra los slugs
4. Para cada resultado, `pelisxdMeta` descarga la página y revisa:
   - Título, póster, año (de `og:title`, `og:image`)
   - Si tiene enlaces vivos: busca `>Opción 1</button>` o `v_source` en base64
   - El dominio del embed (para detectar si es listeamed, byse, doodstream, etc.)

## Reproductores embed (sept 2026)

### Opción 1: Byse Frontend (`byseqekaho.com`)
- React SPA que carga el video via JavaScript
- El embed URL viene como `v_source` en base64 dentro del HTML
- Patrón: `v_source\":\"aHR0cHM6Ly9ieXNlcWVrYWhvLmNvbS9lLy4uLg==`
- Necesita navegador real (headless Chrome) para resolver

### Opción 2: DoodStream (`myvidplay.com`, `playmogo.com`)
- Usa Cloudflare Turnstile captcha
- Sirve `.mp4` directo (NO m3u8)
- El Turnstile se auto-resuelve en headless Chrome
- Después del captcha, recarga la página y reproduce

### Legacy: Streamwish / listeamed
- Algunas películas viejas usan `listeamed.net`
- Streamwish usaba un challenge anti-bot que el navegador resolvía solo
- Ya no se bloquea (v231)

## Flujo de resolución (`resolverPelisxd`)

```
1. Revisar caché de streams (2h TTL)
2. pelisxdMeta(slug) → verificar enlaces vivos
3. extraerStreamwishPeli(pageUrl):
   a. Abrir la página en headless Chrome
   b. Extraer v_source URLs (embeds) del HTML
   c. ESTRATEGIA 1: Clic en "Opción 1" / "Haz clic para reproducir"
      - Esperar 4s → clic → esperar 8s → clic en iframe → esperar 20s
      - Si no hay video, reintentar clics 16 veces más (48s)
   d. ESTRATEGIA 2: Si no funcionó, abrir cada embed directo
      - Navegar a cada URL de embed
      - Clicar play, esperar Turnstile, etc.
4. Si capturó .m3u8 → cachear en pelisxdStreams, servir por /api/xd/
5. Si capturó .mp4 → servir directo con proxy
```

## Caché y TTL
- `pelisxdIdx`: lista de slugs del sitemap, 24h
- `pelisxdMetaCache`: metadata por slug, 15 min
- `pelisxdStreams`: playlists capturadas, 2h (`PELISXD_STREAM_TTL`)
- Streams vencidos se limpian al inicio de cada resolución

## Sistema de podredumbre
- `FALLOS_PXD`: mapa de slug → {f, last, h}
- 3 fallos espaciados ≥10 min → se oculta (`pxdOcultar`)
- Revivir: 1 peli ocultada cada 6h se prueba de nuevo
- `pxd-ocultas.txt`: lista de películas ocultas en disco

## Proxy HLS
- `/api/xd/:token/index.m3u8` sirve el playlist cacheado
- Segmentos se reescriben al proxy `/api/hls?u=...`
- El Referer del embed se guarda en `hlsReferers` para los segmentos

## Endpoints relacionados
- `GET /api/search?q=...` → busca en PelisXD + otros sitios
- `GET /api/solo?url=https://www.pelisxd.com/pelicula/...` → resuelve para modo individual
- `GET /api/xd/:token/index.m3u8` → sirve playlist cacheado
- `GET /api/hls?u=...` → proxy de segmentos HLS

## Archivos en disco
- `public/pxd-ocultas.txt` — películas ocultas
- `data/fallos-pxd.json` — registro de fallos

## Problemas conocidos (pre-v231)
- El bloque de `listeamed` impedía que ~30% del catálogo intentara reproducir
- DoodStream no funcionaba (servía mp4, el código solo capturaba m3u8)
- Byse Frontend a veces no respondía al clic sintético (necesita mouse real)

## Cambios en v231
1. Removido el bloque de listeamed
2. Captura de .mp4 además de .m3u8
3. Estrategia 2: abrir embeds directo si la página no funciona
4. Mejorado el selector de iframes (byse, playmogo, myvidplay)