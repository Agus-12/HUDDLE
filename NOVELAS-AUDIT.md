# Auditoría Novelas — 21 sept 2026

> Las externas están **APAGADAS** desde v208 (`NOVELAS_EXTERNAS_ON = false`, "mala calidad"):
> la fila de novelas muestra solo el catálogo Movie. La auditoría confirma que fue lo correcto.

## Catálogo (Fase 1 — `auditoria-novelas.js fase1`)
| Fuente | Títulos | Con capítulos |
|---|---|---|
| novelas360 (`/series/`, 2 págs) | 73 | **73/73 (100%)** |
| enpantallatv (home ~145 tarjetas) | 120 prefs | 104 directo + 16 vía hub = **120/120** |
| Muertas reales | 0 | Las 16 'sin capítulos' viven: 13 formatos nuevos/prefs-basura + 3 hubs con episodios bajo slug extendido (`polen-*`, `garra-vs-veneno-*`, `lobo-morir-matando-*`, rescatados por parentesco incl. sufijo; `polen-2026` revivida por la propia sonda) |

## Video (Fase 2 — 8+8 muestras)
| Fuente | Resultado |
|---|---|
| novelas360 | **0/8**: 6× player propio `novelas360.cyou` (anti-bot WASM + click, `POST /player/get_md5.php` rechaza todo lo no-navegador: `{"try_again":"1"}`), 2× capítulos sin reproductor |
| enpantalla | 3/8 ok.ru vivo, 2/8 prefs-basura (vivas, invisibles), 2/8 `frames=["","",""]` vacíos, 1/8 ok.ru muerto |

**Lectura:** 360 = catálogo vivo pero video 0% extraíble por HTTP. Enpantalla = mixto (~50%).

## Bugs de Huddle encontrados y arreglados (v245)
1. **Episodios invisibles (13 títulos)**: enpantalla usa formatos sin `-capitulo-` (`X-N-junk`, `X-YYYY-N-junk`) → `epPrefijo`/`nv2Ficha` los ignoraban (ej. `la-nena-2026-1-…`, `el-jardin-de-olivia-25-sr`, todos con player ok.ru).
2. **Prefs-basura**: hubs `X-hd-online`, `X-gg-vv`, `X-en-enpantallatv-online` cuyos capítulos viven bajo el pref limpio → la ficha por búsqueda daba 0.
3. **Fix**: `nv2HijosDelHub(pref)` — lee los hijos del hub, agrupa por pref (capitulo + numéricos `X-N`/`X-YYYY-N`), exige parentesco con el pedido (igual, prefijo O sufijo), devuelve episodios + pref derivado (título limpio). Integrado como fallback en `nv2Ficha`.
4. **Sin filtros**: enpantalla NO filtraba `NV_OCULTAS` en ningún lado (ni recientes, ni búsqueda, ni `/api/enp/`); `buscarNovelas` tampoco. Agregados (claves `enp:<pref>` para enp, slug plano para 360).

## Sonda + panel (v245)
- `sondaNovelas`: 3+3 vivas + 4 muertas por ciclo (arranque + 6h), pausas 1.5s, `NV_VISTAS` (`nv:`/`enp:`), log `sonda-novelas.log`, notifica como `Novelas`. Vigila aunque las externas estén apagadas.
- Tarjeta **Novelas** (rosa `#f97d8a`, logo TV) con detalle + log. NO suma a Series (externas apagadas = no navegables).
- Para reactivar: `NOVELAS_EXTERNAS_ON = true` (se recomienda NO hacerlo con 360; enp solo si se acepta ~50%).
