# Caricaturas — Ficha Técnica

## Datos generales
Familia de 3 fuentes de animación clásica (todo latino):
- **Danimados**: https://danimados.cc — 821 series (reemplaza las rotas de las otras dos)
- **Lacartoons**: https://www.lacartoons.com — 241 series (Cartoons + Live Action)
- **MisCaricaturas**: https://miscaricaturas.com — 36 curadas (+ home)
- **Total**: ~1,098 series | **Protocolo**: HTTP puro las 3
- **Actualizado**: 21 sept 2026 (Huddle v241)

## Conteos (auditoría sept 2026)

| Fuente | Total | Vivas | Ocultas | Muertas |
|--------|-------|-------|----------|---------|
| Danimados | 821 | 820 | 12 (11 reemplazo + 1 vacía) | 0 (2 slugs basura eliminados) |
| Lacartoons | 241 | 241 | 8 (dup. internos, gana MisCaricaturas) | 0 |
| MisCaricaturas | 36 | 36 | 0 | 0 |

Detalle en `CARICATURAS-AUDIT.md`.

## Cómo se relacionan
```
Danimados manda (más capítulos y mejor calidad)
  ├─ DANI_REEMPLAZAS: slug nuestro → slug dani (Titanes, Bob Esponja...)
  ├─ DANI_OCULTAS: 11 donde la nuestra tiene MÁS capítulos (gana la nuestra)
  └─ +1 vacía verificada (george-de-la-jungla)
MisCaricaturas vs Lacartoons:
  └─ LCT_OCULTAS: 8 duplicados internos (gana MisCaricaturas, trae más)
Live Action (apartado propio, no caricaturas):
  └─ CARI_LIVE (2) + LCT_LIVE (14 + todo power-rangers-*)
```

## Danimados
- Catálogo: `public/dani-catalogo.json` (slug → {título, póster}), portadas IMDb en `dani-imdb.json`.
- Serie: `/series/<slug>/` → bloques `<div class='se-c'>` por temporada → links `/episodios/<slug>-<T>x<E>/`.
- Resolución (`daniEpToStream`): ep → `data-post` → POST `doo_player_ajax` (nume 1-4, se prueban TODAS) → `embed_url` (a veces viene la etiqueta iframe completa) → embed → m3u8 o packer Dean Edwards → `resolverVimeos` si toca.
- Embeds vistos: ok.ru, minochinos, voe.sx, waaw.to, hglink.to, byse.
- **Rate-limit**: 429 tras ~400 reqs rápidas. Sonda y barridos con pausas.

## Lacartoons
- Catálogo: `LCT_SERIES` (mapa fijo id → {slug, título}, 241).
- Serie: `/serie/<id>` → capítulos `/serie/capitulo/<capId>?t=<temp>`.
- Capítulo vivo = trae `cubeembed.rpmvid.com/#hash` u `ok.ru/videoembed/<id>`.
- rpmvid: API `/api/v1/video?id=` (AES-128-CBC, llave del bundle) → master `/hlsmod/`. ok.ru: mp4 directo.
- Barrido de vivos por cola (lotes de 4, 200ms): los muertos salen de la lista y se recuerdan (`muertos`).
- **Rate-limit**: también da 429 en ráfaga.

## MisCaricaturas
- Catálogo: `CARI_ORDEN` (36 curadas) + series de la home.
- Serie: `/<slug>/` → capítulos `/<slug>-<TT>x<EE>-.../` (v241: temporada de 1-2 dígitos, por 31-minutos `1xNN`).
- 10 series grandes usan posts de temporada (`slug-temporada-N/`, máx 16, en paralelo).
- Resolución (`resolverCaricaturaHttp`, ~3s): cap → `anchor-data-container data-id` → POST `get_system_data` (`target_id=`) → JSON con iframe Byse → `/api/videos/<cod>` → playback AES-256-GCM (llave en `key_parts[version, 31-version]`) → master m3u8.
- Merge latino: capítulos en inglés se reemplazan con Lacartoons (`LCT_MERGE`: Billy T1-T5, Ben 10 T3/T4+2x12).

## Sondas (v242: una por fuente)
- `sondaDanimados`, `sondaLacartoons`, `sondaMisc` — cada una: 5 vivas + 3 muertas por ciclo, pausas 2s (rate-limit 429), log propio (`sonda-danimados.log`, etc.), notifica con su nombre.
- `sondaCaricaturas()` = wrapper que corre las 3 en arranque + cada 6h y persiste `cari-vistas.txt` (claves `dani:`/`lct:`/`cari:`).

## Sonda (diseño original v241) Caricaturas (`sondaCaricaturas`, v241)
Corre al arranque (90s) y cada 6h. Muestras CHICAS y despacio (rate-limit):
1. **DANI vivas**: 5 series visibles → página con episodios. Si falla → fallo; 3 fallos → `dani-ocultas.txt` + notifica.
2. **LCT vivas**: 5 series → página con capítulos. Igual → `lct-ocultas.txt`.
3. **CARI vivas**: 5 curadas (+temporadas si directo da 0). Igual → `cari-ocultas.txt`.
4. **MUERTAS**: 5 de las ocultas por sonda → si reviven → visibles + notificación.
- Pausa 2s entre peticiones. Log en `sonda-caricaturas.log`, eventos en campanita + panel.
- `CARI_VISTAS` (`public/cari-vistas.txt`): claves `dani:|lct:|cari:` ya verificadas.

## Podredumbre
- `FALLOS_DANI/LCT/CARI` (`data/fallos-{dani,lct,cari}.json`): 3 fallos espaciados → oculta.
- Las ocultas precargadas (DANI_OCULTAS, LCT_OCULTAS) son curaduría, no muerte: la sonda NO las revive ni las toca.
- Éxito perdona (`...Perdonar`).

## Panel de estado (v242: 3 tarjetas separadas)
- **Danimados** (rosa `#fb7185`, logo pingüino original `/sites/danimados.png`), **Lacartoons** (teal `#2dd4bf`, monograma `/sites/lacartoons.png`), **MisCaricaturas** (amarillo `#ffd93b`, Bob `/sites/caricaturas.png`).
- Cada tarjeta con su detalle + su log de sonda (`Danimados`/`Lacartoons`/`MisCaricaturas` notifican por separado).
- Total = dani + lct + cari curadas; ocultas = sonda + curaduría; vistas = verificadas.
- Catálogo "Caricaturas" (arriba) = suma de las 3 activas (1,078), NO filas del feed (~254).
- Catálogo "Series" = solo animes: Danimados es familia Caricaturas (la app lo archiva con `site: 'Caricaturas'`), así no se cuenta doble en el Total.

## Archivos en disco
- `public/dani-catalogo.json` — 821 series danimados
- `public/dani-imdb.json` — portadas IMDb
- `public/cari-vistas.txt` — claves verificadas (`dani:|lct:|cari:`)
- `public/dani-ocultas.txt`, `public/lct-ocultas.txt`, `public/cari-ocultas.txt` — muertas por sonda
- `data/fallos-{dani,lct,cari}.json` — fallos en curso
- `sonda-caricaturas.log` — resumen por ciclo
- `public/covers/*.jpg` — 273 portadas curadas locales
- `CARICATURAS-AUDIT.md` — auditoría completa
