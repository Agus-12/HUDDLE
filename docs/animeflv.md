# AnimeFLV — Ficha técnica

## Datos generales
- **URL**: https://vww.animeflv.one (espejo; el .net bloquea datacenters)
- **Tipo**: Anime subtitulado (mayoría) + algunos latinos
- **Catálogo**: 2,955 slugs en `public/animeflv-slugs.txt` → **2,920 vivos** (auditoría sept 2026)
- **Rol**: complemento de Latanime (81% NO está en Latanime), no respaldo
- **Protocolo**: HTTP para mp4upload (~27%), navegador del servidor para el resto

## Flujo de resolución (`resolverAnimeflv`)
1. GET `/ver/<slug>-<n>` → `data-encrypt` (hex) del primer `.opt`
2. POST `/flv` (`acc=opt&i=<hex>`, con Referer + X-Requested-With) → `<li encrypt="<hex>">`
3. Cada hex = URL de embed (mp4upload, hqq, ok.ru, mega, yourupload, voe, uqload, streamwish…)
4. Si hay mp4upload → `extraerMp4` (HTTP puro) → video directo
5. Si no → `resolverAnimePorNavegador` (headless, lee la URL que pide el player)
6. Si todo falla → `afOcultar` (podredumbre 3 fallos)

## Sonda (`sondaAnimeflv`, v243)
- 5 vivas + 3 muertas por ciclo, arranque + cada 6h, pausas 1.5s (sin rate-limit conocido)
- Probe `afProbe` = ep1 trae enc + `/flv` lista ≥1 servidor (criterio de la auditoría, NO exige mp4upload: esos juegan por navegador)
- Log `sonda-animeflv.log`, consola `[sonda] af`, notifica como `AnimeFLV`
- Lázaro en `revivirGeneral` con el mismo criterio (2 por vuelta)

## Archivos
- `public/animeflv-slugs.txt` — catálogo (2,955)
- `public/af-ocultas.txt` — muertas (35 iniciales de la auditoría)
- `public/af-vistas.txt` — verificadas por sonda
- `data/fallos-af.json` — podredumbre

## Panel
- Tarjeta **AnimeFLV** (melocotón `#feac5d`, logo AF) con detalle + log de sonda
- Catálogo **Series** = Latanime + AnimeFLV activas
