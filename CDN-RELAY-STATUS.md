# CDN Relay — Estado y siguientes pasos (v236)

## Problema
Los CDNs de video (goodstream.one, vimeos.net, hlswish.com) **bloquean TODAS las IPs de datacenter** (Oracle Cloud, Google Cloud, AWS, etc.). Solo IPs residenciales funcionan.

Esto afecta a **todas las fuentes** que usan estos CDNs:
- Cuevana.mov (usa goodstream/vimeos)
- CineCalidad (usa vimeos)
- PelisXD (usa goodstream)

## Lo que funciona
- El **resolver** extrae el m3u8 correctamente (2-3s)
- El **relay** en Mac Mini sirve el m3u8 y segmentos perfecto (probado y confirmado)
- El código del relay está listo en server.js (v236)

## Lo que falta
- **Conexión estable** entre Oracle y Mac Mini (localhost.run se cae)
- Necesita **Tailscale** o abrir puerto en router

## Código implementado (v236)
- `CDN_RELAY` variable global (set via `/api/set-relay?url=...`)
- `fetchRelay()` helper: fetch a través del relay, NUNCA cae al directo (token IP-bound)
- `resolverGoodstream`: usa fetchRelay para embed + verificación m3u8
- HLS proxy: relay fallback cuando direct fetch falla (403/5xx)
- `/api/health` muestra cdnRelay status
- `/api/set-relay` endpoint para actualizar URL del relay

## Siguiente paso: Tailscale (5 minutos)
Ver archivo `SETUP-TAILSCALE.md` para instrucciones completas.

Una vez Tailscale configurado:
1. Mac Mini: `node ~/relay.js`
2. Server: `curl 'http://localhost:3000/api/set-relay?url=http://100.x.x.x:3128'` (IP Tailscale del Mac)
3. ¡Listo! Conexión permanente y estable.

## Archivos en Mac Mini
- `~/relay.js` — servidor HTTP relay que hace fetch de CDNs
- `~/start-relay.sh` — script para iniciar relay + túnel (tiene bug con grep -P en macOS)