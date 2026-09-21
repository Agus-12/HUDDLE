# Auditoría AnimeD23 — 21 sept 2026 (veredicto: VALE LA PENA re-agregar)

## El sitio
- **URL**: https://animed23.com — vivo, rápido, sin rate-limit ni Cloudflare.
- **Catálogo**: **229 animes** (directorio `/anime/`, 12 páginas × ~20).
- **Idioma**: Sub + **Latino** + Castellano (contenedores separados por idioma, verificado: `black-torch-ep-1` trae `sub` + `lat` + `cast`).
- **Traslape**: 19 en Latanime + 43 en AnimeFLV (60 en alguno) → **169 únicos (74%)**.

## Cadena de extracción (verificada a mano, HTTP puro)
```
/anime/<slug>/ → /capitulo/<slug-ep-N>/
  → iframe animed23.online/opciones/options.php (JWT: sub/lat/cast + firma)
  → player.php?data=<jwt> → contenedor.php?id=<container>
  → const videoTabs = [{tab_name, url} × 6]
```
Servidores por episodio (6): **Byse**, **archive.org** (mp4 directo), Mega, **ok.ru**, **rpmvid**, Abyss.

## Viabilidad HTTP
| Servidor | Estado |
|---|---|
| Byse (`bysesukior.com/api/videos/…`) | ✅ vivo (título + duración reales) |
| ok.ru (`/videoembed/…`) | ✅ 200 + refs de video (extractor existente aplica) |
| rpmvid (`ytplay.rpmvid.com`) | ✅ mismo proveedor que Lacartoons |
| archive.org (mp4 directo) | ⚠️ 403 desde datacenter — probar desde MX |
| Mega embed | ❌ extracción compleja |
| Abyss | ❓ sin analizar |

4 de 6 servidores pasan por extractores que Huddle **ya tiene**. Integración estimada: buscar + datos + resolver + sonda + panel (1 sesión).

## Historia en Huddle
Se quitó en v68/v70 ("fuera AnimeD23"). Solo quedan: filtro que la bloquea (`server.js`), logo (`sites/animed23.png`) y entrada en mapa de salas. Re-agregarla = código nuevo, no revert (el sitio cambió por completo desde entonces).
