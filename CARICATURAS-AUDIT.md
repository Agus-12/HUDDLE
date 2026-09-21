# Caricaturas — Auditoría Completa
## Fecha: 21 septiembre 2026 | Huddle v241

Fuentes: **Danimados** (danimados.cc) + **Lacartoons** (lacartoons.com) + **MisCaricaturas** (miscaricaturas.com).
Método: mismo parse que `server.js` (`daniLista`, `lctEpsDeHtml`, `cariEpsDeHtml` + posts de temporada).

---

## 1. Resumen Ejecutivo

| Fuente | Total | OK | Vacías | Muertas |
|--------|-------|----|--------|---------|
| **Danimados** | 823 | 820 | 1 | 2 |
| **Lacartoons** | 241 | 241 | 0 | 0 |
| **MisCaricaturas** | 36 | 36 | 0 | 0 |
| **TOTAL** | **1,100** | **1,097** | **1** | **2** |

99.7% del catálogo de caricaturas está vivo.

---

## 2. Danimados (823 series)

| Estado | Cantidad | Detalle |
|--------|----------|---------|
| OK (página con episodios) | 820 | |
| Vacía (200 pero 0 eps) | 1 | `george-de-la-jungla` → agregada a `DANI_OCULTAS` |
| Basura (slug mojibake, 403) | 2 | `%e5%a5%b3...` (Girls Dorm), `%e5%8f%82...go` (Transformers Go) → eliminadas del catálogo |
| Funcional con slug raro | 1 | `ranma-%c2%bd` (Ranma ½): 200 con 161 eps → se conserva |

Catálogo: 823 → **821 series** tras limpieza.

### Rate-limit importante
- danimados.cc responde **429** tras ~400 peticiones rápidas.
- La primera pasada marcó 222 como "muertas" siendo rate-limit; reintentadas lento: 221 vivas.
- **La sonda DEBE ir despacio** (muestras chicas + pausas ≥1.5s). Igual para Lacartoons (también da 429).

### Players (muestra 10/10 OK)
`daniEpToStream`: página ep → `data-post` → POST `doo_player_ajax` (nume 1-4) → `embed_url`.
Embeds vistos: ok.ru, minochinos.com, voe.sx, waaw.to, hglink.to, bysedikamoum.com.
10/10 series de muestra entregaron embed en nume 1-2.

---

## 3. Lacartoons (241 series)

| Estado | Cantidad |
|--------|----------|
| OK | 241 (12 pasaron por retry lento tras 429 inicial) |
| Muertas | 0 |

### Players (muestra 10/10 OK)
Capítulo trae `cubeembed.rpmvid.com/#hash` (AES del bundle, HTTP puro) u `ok.ru/videoembed` (mp4 directo).
Mezcla vista: 3 rpmvid + 7 ok.ru.

### Notas
- `LCT_SERIES`: mapa fijo id → slug (241 entradas).
- Series live-action (iCarly, Drake & Josh, Power Rangers, sitcoms nick...) van al apartado Live Action, no a Cartoons.
- Johnny Test y Xiaolin Chronicles ya estaban fuera (embeds retirados, nota v114).

---

## 4. MisCaricaturas (36 curadas)

| Estado | Cantidad |
|--------|----------|
| OK directo | 26 |
| OK vía posts de temporada | 9 (south-park 237 eps, simpsons 269, arnold 186, sabrina 163, futurama 158, coraje 102, comadreja 79, kenan 64, monstruos 52) |
| OK tras fix regex | 1 (31-minutos) |
| Muertas | 0 |

### Series por temporadas
10 series listan `slug-temporada-N/` en vez de capítulos directos. Huddle ya las sigue (máx 16 posts, código v103). La auditoría replicó esa lógica.

### BUG ENCONTRADO Y ARREGLADO (v241)
- `31-minutos` usa formato **1xNN** (`31-minutos-1x01-...`) de un dígito.
- El regex `(\d{2})x(\d{2})` no lo capturaba → la serie salía con **0 episodios** en Huddle.
- Fix: `(\d{1,2})x(\d{2})` en 5 puntos: `cariEpsDeHtml`, `epNumDeUrl`, detección de serie (2740), `cariEsSerie`, chequeo EPS_INGLESES.
- Verificado: `31-minutos T=1 E=01` ✓, sin regresiones (`ben-10 T=10 E=12` ✓).

### Players (muestra 12/12 OK)
Capítulo → `anchor-data-container data-id` → POST `get_system_data` (`target_id=`) → JSON con iframe Byse (`byseqekaho.com/e/...`) → `/api/videos/<cod>` → playback AES-256-GCM → master m3u8.
12/12 entregaron iframe (1 transient SIN-DATAID re-verificado OK a mano).

---

## 5. Fase 2 — Players (resumen)

| Fuente | Muestra | Player OK |
|--------|---------|-----------|
| Danimados | 10 | 10 (ok.ru, minochinos, voe, waaw, hglink, byse) |
| Lacartoons | 10 | 10 (rpmvid, ok.ru) |
| MisCaricaturas | 12 | 12 (byse) |

---

## 6. Archivos de auditoría
- `auditoria-caricaturas.js` — fase 1 (listas de episodios)
- `auditoria-caricaturas-fase2.js` — fase 2 (players en muestra)
- Resultados crudos: `/tmp/cari-audit-{dani,lct,cari}.jsonl` (no commiteados)
