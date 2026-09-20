# Latanime — Documentación Técnica

## Datos generales
- **URL**: https://latanime.org
- **Tipo**: Anime (latino y castellano)
- **Catálogo**: ~3,453 series
- **Idioma**: Latino preferido (castellano se oculta)
- **Calidad**: HD
- **Protocolo**: HTTP puro

## Cómo funciona el catálogo
1. Slugs guardados en `public/latanime-slugs.txt` (persistencia)
2. Página de serie: `/anime/<slug>` → lista de episodios
3. Episodio: `/ver/<slug>-episodio-<N>/`
4. Filtros: se ocultan versiones castellanas y duplicados

## Reproductores embed

### mp4upload (`mp4upload.com`)
- El embed tiene el mp4 DIRECTO en el HTML
- Patrón: `player.src({type:'video/mp4', src:'https://...'})`
- NO necesita navegador (HTTP puro)
- A veces responde 200 con cuerpo vacío (ráfagas) → reintentos

### Otros servidores (vía navegador)
- ok.ru, yourupload, mail.ru
- Se resuelven con headless Chrome (resolverAnimePorNavegador)
- El navegador abre el embed, lee el <video> src

## Flujo de resolución (`resolverAnime`)
```
1. Descargar página del episodio
2. Extraer links: data-player (base64) → URLs de embeds
3. Filtrar mp4upload
4. Intentar extraerMp4 (HTTP puro, 4 reintentos)
5. Si falla → resolverAnimePorNavegador (headless Chrome)
6. Si todo falla → registrar fallo, ocultar si 3 fallos
```

## Sistema de podredumbre
- `LA_FALLOS`: slug → {f, last, h}
- 3 fallos espaciados ≥10 min → `LA_MUERTAS_SET`
- `latanime-muertas.txt`: persistencia
- Re-chequeo cada 6h con `laProbe()`
- Si revive → se quita de muertas y se perdona

## Duplicados con AnimeFLV
- Latanime tiene prioridad (audio latino)
- AnimeFLV cede cuando latanime tiene la serie misma
- Comparación por tokens normalizados del título base

## Archivos en disco
- `public/latanime-slugs.txt` — slugs de todas las series
- `public/latanime-ocultas.txt` — castellano/duplicados ocultas
- `public/latanime-muertas.txt` — series con video caído
- `data/la-fallos.json` — registro de fallos