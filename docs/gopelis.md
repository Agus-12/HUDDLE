# GoPelis — Documentación Técnica

## Datos generales
- **URL**: https://gopelis.com
- **Tipo**: Series y películas (latino)
- **Catálogo**: ~3 páginas de series + ~508 películas (15 páginas)
- **Idioma**: Siempre latino
- **Calidad**: HD
- **Protocolo**: HTTP puro

## Cómo funciona el catálogo
1. **Series**: `/series?page=N` (3 págs) → ficha `/series/<slug>` → episodios via `/ver/tv/<tmdbId>?season=N`
2. **Películas**: `/peliculas?page=N` (15 págs) → ficha `/peliculas/<slug>` → `/ver/movie/<tmdbId>`
3. Caché: 6 horas para el catálogo

## Flujo de resolución (`resolverGopelis`)
```
1. Obtener player: /api/stream-player?source=peliapi-player&type=tv|movie&id=...
2. Extraer API_URL y PAGE_TOKEN del HTML del player
3. Pedir servidores: API_URL?pt=PAGE_TOKEN
4. Para cada servidor: RESOLVE_URL?token=... → directUrl (m3u8)
5. Verificar que el m3u8 responda (#EXTM3U)
6. Confirmar con proxy local /api/hls
7. Guardar UA y Accept-Language del host para el proxy
```

## Problema conocido
- Los tokens de CDN expiran rápido
- Cada /resolve rota el nodo — solo algunos sirven
- Se re-resuelve hasta 3 veces por servidor

## Sistema de podredumbre
- `GP_OCULTAS_SET`: claves ocultas (slug o p:slug para pelis)
- `FALLOS_GP`: clave → {f, last, h}
- Mapa reverso `GP_ID_REV`: tmdbId → clave (para el lázaro)
- `gp-ids.json`: persistencia del mapa de IDs

## Archivos en disco
- `public/gopelis-ocultas.txt` — títulos ocultos
- `data/fallos-gp.json` — registro de fallos
- `data/gp-ids.json` — mapa tmdbId → clave oculta