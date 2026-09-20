# AnimeFLV — Documentación Técnica

## Datos generales
- **URL**: https://vww.animeflv.one
- **Tipo**: Anime (respaldo de Latanime)
- **Catálogo**: Slugs en `public/animeflv-slugs.txt` (exclusivos)
- **Idioma**: Latino y subtitulado
- **Protocolo**: HTTP puro

## Rol en Huddle
Es el **respaldo de Latanime**. Solo aparece en la búsqueda cuando Latanime NO tiene la serie (evita duplicados).

## Flujo de resolución (`resolverAnimeflv`)
```
1. Descargar página del episodio
2. Extraer data-encrypt (hex) del primer opt
3. POST a /flv con body 'acc=opt&i=' + enc
4. La respuesta trae <li encrypt="hex"> → cada hex es URL de embed
5. Filtrar mp4upload → extraerMp4 (HTTP puro)
6. Si no hay mp4upload → resolverAnimePorNavegador (headless)
7. Si todo falla → afOcultar (podredumbre)
```

## Sistema de podredumbre
- `AF_OCULTAS_SET`: slugs ocultos
- `FALLOS_AF`: slug → {f, last, h}
- 3 fallos → se oculta
- Re-chequeo cada 6h (2 por vuelta)

## Archivos en disco
- `public/animeflv-slugs.txt` — slugs exclusivos
- `public/af-ocultas.txt` — series ocultas
- `data/fallos-af.json` — registro de fallos