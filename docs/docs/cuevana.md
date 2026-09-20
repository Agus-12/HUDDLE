# Cuevana / Cine-Calidad — Documentación Técnica

## Datos generales
- **URL**: https://cine-calidad.mx
- **Tipo**: Películas y series (latino y castellano)
- **Catálogo**: Miles de películas + series con temporadas
- **Idioma**: Principalmente latino (algunas castellano)
- **Calidad**: HD (720p-1080p)
- **Protocolo**: HTTP puro

## Fue la PRIMERA fuente integrada en Huddle

## Cómo funciona el catálogo
1. **Películas**: sitemap `tvshow-sitemap.xml` y `tvshow-sitemap2.xml`
2. **Series**: `/serie/<slug>/` → lista de episodios con temporadas
3. **Búsqueda**: WP API `/wp-json/mycustom/v1/search/?s=...`
4. **Pósters**: WP API devuelve `featured_image` del post tipo "series"

## Reproductores embed

### Goodstream (`goodstream.one`)
- Embed con HLS + subtítulos VTT
- Token del m3u8 puede estar amarrado a la IP del servidor
- Siempre se sirve por proxy (`/api/hls`)
- Requiere Referer del embed para que los segmentos sirvan

### Vimeos (`vimeos.net`, `vimeos.zip`)
- HLS 720p dentro de un `eval(function(p,a,c,k,e,d){...})` (Dean Edwards packer)
- Se desempaqueta ejecutando el eval
- También se sirve por proxy

## Flujo de resolución

### Modo Individual (`resolverSolo`)
```
1. Descargar la página de la peli/episodio
2. Buscar botones play con data-src cifrado (base64 → charCode - 2)
3. Decodificar: prioridad goodstream > vimeos
4. Si no hay botones, buscar embed goodstream inline
5. Llamar a resolverGoodstream o resolverVimeos
```

### resolverGoodstream
```
1. Fetch del embed (3 intentos en paralelo desfasados 700ms)
2. Extraer m3u8 y subtítulos VTT de file: '...'
3. Verificar que el m3u8 responda con rangito
4. Guardar Referer en hlsReferers
5. Devolver {m3u8, subs, proxy: true}
```

### resolverVimeos
```
1. Fetch del embed
2. Desempacar: eval(function(p,a,c,k,e,d){...}) → ejecutar → string
3. Buscar URL .m3u8 en el resultado
4. Guardar Referer
5. Devolver {m3u8, proxy: true, subs: []}
```

### Modo Sala (mirror/navegador)
- El navegador del servidor abre la página
- Hace clic en el botón play
- El video carga en el reproductor del sitio
- Se transmite por SSE como frames JPEG

## Series y episodios
- `datosSerieCuevana(slug)` → temporadas y episodios
- Cache: 30 min en memoria + disco (`data/cache/serieCache.json`)
- Póster real via WP API (no el still del episodio 1)
- Selector de episodios con marcas de "visto"

## Sistema de podredumbre
- `CV_OCULTAS_RT`: set de slugs ocultados en runtime
- `FALLOS_CV`: mapa de slug → {f, last, h}
- 3 fallos → se oculta
- Re-chequeo cada 6h (3 por vuelta)
- `cv-ocultas-rt.json`: persistencia en disco

## Endpoints
- `GET /api/serie/<slug>` → ficha de serie
- `GET /api/search?q=...` → búsqueda (incluye Cuevana)
- `GET /api/solo?url=...` → resolver para individual
- `GET /api/trending` → populares del día

## Archivos en disco
- `data/cv-ocultas-rt.json` — series/pelis ocultas
- `data/fallos-cv.json` — registro de fallos
- `data/cache/serieCache.json` — caché de series
- `public/cine-pelis-titulos.txt` — inventario de películas (anti-duplicados con GoPelis)