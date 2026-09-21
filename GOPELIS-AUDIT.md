# Auditoría GoPelis — 21 sept 2026 (veredicto: ELIMINAR)

## Catálogo (Fase 1 — `auditoria-gopelis.js fase1`)
| Métrica | Valor |
|---|---|
| Series (`/series`, 3 págs) | 105 |
| Películas (`/peliculas`, 16 págs) | 518 |
| **Total** | **623** |
| Fichas con link `/ver/` | 623/623 (100%) |
| Ocultas acumuladas | 163 (54 series + 109 pelis) |
| **Visibles** | **~460 (~51 series + ~409 pelis)** |

Sin rate-limit: 623 fichas en 64s, 0 muertas a nivel página.

## Resolución (Fase 2 — `auditoria-gopelis.js fase2`)
**20/20 muestras MUERTAS en `player-0`**: `GET /api/stream-player?source=peliapi-player…` cuelga 25-35s y devuelve 0 bytes (ni 404 ni 403: timeout total).

### Diagnóstico
- `gopelis.com/peliculas` → 200 en 1.5s (el sitio vive).
- `source=vidsrc` → 302 en 0.8s; `source=vidlink` → 302 en 0.2s (la infra `/api` vive).
- `source=peliapi-player` → 000/timeout incluso con id real (146198), cookies y Referer.
- Conclusión: **el backend peliapi-player está caído** (falla específica del backend, no bloqueo de IP: el mismo host responde en las demás rutas).

## Fallbacks analizados
La página `/ver/` ofrece Opción 1 (peliapi, muerta), Opción 4 (vidlink → `vidlink.pro`), Opción 5 (vidsrc → `vidsrc.me` → `vidsrc.sh`).
- Ambos son players JS puros (vidsrc carga `disable-devtool.js`), sin video extraíble por HTTP.
- Ecosistema inglés primero: latino improbable.
- Revertirlos = proyecto largo, contra la regla 0 navegador y la prioridad latino.

## Traslape (¿vale la pena?)
- **244/518 pelis (47%) ya están en CineCalidad**; con PelisXD + Cuevana el duplicado real es 60-70%+.
- Aporte único estimado: ~150-200 pelis + ~51 series live-action.

## Decisión
**Eliminar GoPelis de Huddle (v242).** Catálogo chico, mayormente duplicado, backend muerto, fallbacks inviables. Extirpación completa documentada en `docs/gopelis.md`.
