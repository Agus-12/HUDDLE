# 🔍 AUDITORÍA DE FUENTES — Huddle (13 sep 2026, v155)

## Resumen ejecutivo

| Fuente | Mecanismo HOY | ¿Sin Chrome? | Velocidad medida |
|---|---|---|---|
| **Miscaricaturas** (Hora de aventura, etc.) | HTTP puro (v155) | ✅ SÍ | **~3s** (era 10-25s) |
| **Latanime** (animes) | HTTP (mp4upload directo) | ✅ SÍ | ~3-6s |
| **AnimeFLV** | HTTP (mp4upload) + navegador SOLO si el archivo fue borrado | ✅ casi siempre | ~4-8s |
| **Cuevana / cine-calidad** (series y pelis) | HTTP (goodstream, como Solo) | ✅ SÍ | ~3-6s |
| **Goodstream / Vimeos** (modo Solo) | HTTP | ✅ SÍ | ~3-6s |
| **Lacartoons con player ok.ru** | HTTP (mp4 directo) | ✅ SÍ | ~4s |
| **Lacartoons con player rpmvid** (iCarly, Ben 10 T3+, Billy y Mandy) | 🌐 NAVEGADOR | ❌ NO | 10-25s |
| **PelisXD** (películas) | 🌐 NAVEGADOR (los servidores los inyecta JS + challenge) | ❌ NO | ~20s |
| **Espejo** ("Otra página", YouTube) | 🌐 NAVEGADOR (ese es su propósito — no aplica) | — | — |

*Velocidades = resolver el stream (no incluye el arranque del video, que depende de tu internet).*

---

## Lo logrado en esta sesión

### Caricaturas → HTTP puro ✅ (v155)
Ingeniería inversa completa, validada de punta a punta en ~3.1s:
1. La página del capítulo tiene un `data-id` (contenedor `anchor-data-container`)
2. AJAX de WordPress (`action=get_system_data`) → devuelve el iframe del player **sin navegador**
3. El player (Byse) expone `/api/videos/<código>` con el playback **cifrado en AES-256-GCM**
4. La llave se arma con `key_parts` según la posición `[version, 31-version]` (validado con cifrados versión 19 y versión 3)
5. Node descifra con `crypto` nativo → adentro viene el `master.m3u8` de sprintcdn
6. El navegador quedó de **respaldo** si el sitio cambia

## Lo que quedó pendiente (requiere navegador HOY)

### 1. Lacartoons-rpmvid (iCarly, etc.) — DIFÍCULTAD MEDIA, ya tengo el mapa
Lo que encontré en la auditoría:
- El embed `cubeembed.rpmvid.com/#<hash>` es una app React
- Su API interna: `/api/v1/info?id=<hash>` y `/api/v1/video?id=<hash>` **responden por HTTP sin token** — pero devuelven un payload **hex cifrado con AES-CBC**
- El bundle del player trae el descifrado ofuscado (tabla de strings + AES-CBC)
- **Plan**: extraer la llave/algoritmo del bundle (como hice con Byse) → `resolverLacartoonsHttp`. Todas las muestras de iCarly que probé (5/5 capítulos) usan rpmvid, así que es EL premio pendiente.

### 2. PelisXD — DIFICULTAD MEDIA
- La página de la película **no trae servidores en el HTML** (los inyecta JS) y el embed de streamwish tiene una puerta (challenge) que hoy salta el navegador
- **Plan**: replicar el AJAX que carga los servidores + desempacar el JS del embed (el empaquetador `eval(function(p,a,c,k,e,d)` ya lo sabemos desempacar — así funciona Vimeos)

### 3. AnimeFLV-respaldo — ACEPTABLE dejarlo
El navegador solo entra cuando el mp4upload del episodio fue **borrado** de la fuente. No se puede resolver por HTTP lo que ya no existe; es el caso raro, no lo lento del día a día.

---

## Verificación de la cadena HTTP (Miscaricaturas, medido en vivo)

```
1) Página del capítulo      → HTTP 200  (~0.4s)
2) AJAX get_system_data     → HTTP 200, iframe del player (~0.5s)
3) /api/videos/<código>     → HTTP 200, playback cifrado (~0.4s)
4) Descifrado AES-256-GCM   → Node crypto (~0.05s)
5) master.m3u8              → HTTP 200, playlist válido (~0.4s)
6) Segmento .ts             → HTTP 200, 5MB de video ✓
TOTAL: ~3.1 segundos (sin abrir Chrome)
```

## Notas de operación
- El navegador persistente (v152) queda solo para: respaldo de caricaturas, Lacartoons-rpmvid, PelisXD, AnimeFLV-caídos y el espejo.
- Bitácoras para medir en tu Oracle: `[caricaturas] HTTP: … en Xs (sin navegador)`, `[caricaturas] resuelto en Xs` (vía navegador).
- Si en el log aparece seguido `sin navegador (…) — uso el navegador`, el sitio cambió algo → avisarme para ajustar el descifrado.
