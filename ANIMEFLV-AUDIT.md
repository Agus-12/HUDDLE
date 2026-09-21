# Auditoría AnimeFLV — 21 sept 2026

## Catálogo (Fase 1 — `auditoria-animeflv.js fase1`)
| Métrica | Valor |
|---|---|
| Slugs (`public/animeflv-slugs.txt`) | 2,955 |
| `/ver/<slug>-1` con `data-encrypt` | **2,920 (98.8%)** |
| Muertas | 35 (16×404 duro + 19×soft-404/sin players) |
| Rate-limit | Ninguno (2,955 fichas en ~3 min) |

Muertas sembradas en `public/af-ocultas.txt` (antes el archivo ni existía).

## Video (Fase 2 — 52 muestras, cadena HTTP completa)
| Resultado | Muestras | % |
|---|---|---|
| MP4-OK (mp4upload vivo) | 14 | **27%** |
| Con servidores pero sin mp4upload (→ navegador) | 36 | 69% |
| mp4upload listado pero muerto | 5 | — |
| Sin embeds pese a tener enc | 2 | 4% |

Hosts vistos: mp4upload, hqq, ok.ru, mega, yourupload, voe, uqload, streamwish, filelions, mixdrop, byse, veev, rpmplayer, doodstream.

**Lectura:** 27% verificable por HTTP; el resto juega por el navegador del servidor (`resolverAnimePorNavegador`). Coincide con el aviso v205 (mp4upload se acaba).

## Traslape con Latanime
- Mismo slug: 541/2,955 (18%) → **81% de AnimeFLV NO está en Latanime**.
- AnimeFLV es **complemento** (amplitud + subtitulados), no respaldo.

## Bugs encontrados y arreglados (v243)
1. **Filtro de búsqueda muerto**: `buscarAnimeflv` extraía el slug con regex `/ver/<slug>-<n>` pero el href es `/anime/<slug>` → `afSl` siempre vacío → las ocultas NUNCA se filtraban. Fix: regex `/anime/<slug>`.
2. **Lázaro demasiado estricto**: `revivirGeneral` exigía video mp4upload reproducible → los títulos de navegador jamás revivían. Fix: criterio enc + ≥1 servidor (el mismo de la sonda).

## Sonda + panel (v243)
- `sondaAnimeflv`: 5 vivas + 3 muertas por ciclo (arranque + 6h), pausas 1.5s, log `sonda-animeflv.log`, notifica como `AnimeFLV`.
- Podredumbre `FALLOS_AF` (3 fallos) + `AF_VISTAS` (`public/af-vistas.txt`).
- Tarjeta AnimeFLV (melocotón `#feac5d`, logo AF) con detalle y log; Catálogo Series suma Latanime + AnimeFLV.
