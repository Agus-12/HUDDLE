# Novelas — Ficha técnica

## Estado: EXTERNAS APAGADAS
`NOVELAS_EXTERNAS_ON = false` (v208, "mala calidad"). La fila muestra solo el catálogo Movie.
La auditoría sept 2026 lo confirma: 360 sin video extraíble, enpantalla ~50%.

## Fuentes externas (código vivo, oculto al usuario)
- **novelas360.com**: 73 series (`/series/`, 2 págs) → ficha `categories/<slug>/` → capítulos `/video/<slug>-capitulo-<N>/` → 1 iframe `novelas360.cyou` con anti-bot WASM (NO extraíble por HTTP).
- **enpantallatv.com**: ~120 prefs (home) → ficha por búsqueda `?s=` agrupando `-capitulo-` + fallback por hub (`nv2HijosDelHub`: prefs-basura, formatos `X-N`/`X-YYYY-N`, parentesco prefijo/sufijo) → capítulos con goodstream/ok.ru.

## Resolución
- `resolverNovela`: capítulo → iframes (.cyou primero) → hasta 3 saltos → m3u8/mp4 (desempaca `eval(p,a,c,k,e,d)`). Hoy: 0% efectivo.
- `resolverEnp`: capítulo → `<IFRAME SRC>` + `frames=[…]` → goodstream u ok.ru nativos.

## Sonda (`sondaNovelas`, v245)
- 3+3 vivas + 4 muertas por ciclo, arranque + cada 6h, pausas 1.5s.
- Probes = ficha trae ≥1 capítulo (`nv360Probe`, `enpProbe` con fallback hub).
- Podredumbre `FALLOS_NV` (3 fallos) + `NV_VISTAS` (`nv:`/`enp:` en `nv-vistas.txt`).
- Log `sonda-novelas.log`, consola `[sonda] nv`, notifica como `Novelas`.

## Archivos
- `public/nv-ocultas.txt` — muertas (slugs 360 + `enp:<pref>`; arranca vacío: 193/193 fichas vivas)
- `public/nv-vistas.txt` — verificadas por sonda
- `data/fallos-nv.json` — podredumbre

## Panel
- Tarjeta **Novelas** (rosa `#f97d8a`, logo TV) con detalle + log. No suma a Series (apagadas).
