# GoPelis — ELIMINADA de Huddle (v242)

> **Decisión (21 sept 2026):** GoPelis se extirpó por completo del código.
> Veredicto de auditoría en `GOPELIS-AUDIT.md`.

## Por qué se eliminó
- Backend `peliapi-player` (única ruta de resolución) **caído**: cuelga 30s+ con 0 bytes.
- Catálogo chico: **623 títulos** (105 series + 518 pelis), ~460 visibles.
- **47%+ duplicado** con CineCalidad/PelisXD/Cuevana → aporte único ~150-200 títulos.
- Fallbacks (vidlink, vidsrc) = players JS ofuscados, inglés primero, sin latino garantizado.

## Lo que se quitó (v242)
- `resolverGopelis`, `datosGopelis`, `datosGopelisPeli`, `gpCatalogo`, `gpCatalogoPelis`
- Lázaro GP (`GP_ID_REV`, `gpMapaIds`, `gpOcultaQuitar`) + bloque en `revivirGeneral`
- Podredumbre GP (`FALLOS_GP`, `gpOcultarPorId`) + `CV_PELIS_TOKENS` (huérfano)
- Endpoints `/api/gopelis/`, `/api/gopelispeli/`, inyección en búsqueda, rama `esGp`
- Cliente: `abrirGopelisPeli`, ramas gp en `abrirSeriePicker`, logo `gopelis.png`
- Archivos: `public/gopelis-ocultas.txt`, `public/sites/gopelis.png`, `data/gp-ids.json`
