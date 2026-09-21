# Latanime — Ficha Técnica

## Datos generales
- **URL**: https://latanime.org
- **Tipo**: Series de anime (audio latino prioridad)
- **Catálogo**: 3,453 series
- **Idioma**: Latino > Castellano > Subtitulado
- **Protocolo**: HTTP puro (el sitio carga directo, sin anti-bot)
- **Actualizado**: 21 sept 2026 (Huddle v240.6)

## Conteos del catálogo

| Métrica | Cantidad | % |
|---------|----------|---|
| **Total** | 3,453 | 100% |
| **Visibles** | 1,527 | 44% |
| **Ocultas (cast/dup)** | 558 | 16% |
| **Muertas (video caído)** | 1,368 | 39% |

Desglose de visibles: 847 con sufijo `-latino` (latino confirmado) + 680 normales (latino por defecto).

## Regla de audio (prioridad)
```
1. LATINO     → Se muestra ✅
2. CASTELLANO → Solo si NO hay versión latina
3. SUBTITULADO → Solo si no hay ni latina ni castellana
4. DUPLICADO  → Si existen "slug" Y "slug-latino", se oculta "slug"
```
Las 558 ocultas son castellanas o duplicados base/latino.

## Estructura del sitio
1. Slugs en `public/latanime-slugs.txt` (3,453, persistencia local)
2. Ficha de serie: `/anime/<slug>` → título, portada, lista de episodios
3. Episodio: `/ver/<slug>-episodio-<N>/` → reproductores embed
4. Los embeds vienen en atributos `data-player` (URLs en base64):
   `data-player="aHR0cHM6Ly..."` → decode → URL del embed (mp4upload, uqload, filemoon...)

## Reproductores embed (auditoría sept 2026, vía relay Mac Mini)

| Player | Series | ¿HTTP puro? | Estado |
|--------|--------|-------------|--------|
| UQLOAD | 418 | ❌ | CDN 403 (token+IP locked, anti-scraping) |
| LOCAL_FILE | 257 | ❌ | MUERTO — fisier.ro 404, archivos borrados |
| FILEMOON | 252 | ❌ | SPA/JS (Byse player), necesita navegador |
| FEMBED | 80 | ❌ | MUERTO — dominio parqueado (parklogic) |
| DOODSTREAM | 68 | ❌ | Cloudflare "Just a moment", necesita navegador |
| OTHER_URL | 63 | ± | Mixto, casos individuales |
| PAGE404 | 59 | N/A | Páginas 404, no existen |
| SOLIDFILES | 54 | ❌ | MUERTO — falla DNS |
| SENDVID | 32 | ❌ | MUERTO — "Technical Difficulties" |
| DSVPLAY | 29 | ❌ | SPA como filemoon |
| GDRIVE | 28 | ❌ | Requiere auth Google/CAPTCHA |
| VOE | 19 | ❌ | Ofuscación WASM, necesita ejecutar código |
| MP4UPLOAD | 5 | ✅ | Extracción estándar, HTTP puro |
| CLIPWATCHING | 3 | ❌ | MUERTO — dominio caído |

**Conclusión**: solo mp4upload es extraíble por HTTP. De las 1,368 muertas: ~779 funcionarían con navegador real (uqload, filemoon, doodstream, voe), ~426 están genuinamente muertas (archivos/dominios borrados), ~163 desconocidas.

Detalle completo en `LATANIME-RESOLVER-ANALYSIS.md` y `LATANIME-AUDIT.md`.

## Por qué no hay resolver HTTP general
Cada familia de players tiene un bloqueo distinto que HTTP puro no puede pasar:
- **UQLOAD**: el m3u8 se arma con JS ofuscado (split-array) y el CDN (`strm9.uqload.vc`) valida sesión/IP → 403 aunque la URL sea correcta.
- **FILEMOON/DSVPLAY**: SPA Next.js, el video se carga por llamadas API desde JS.
- **DOODSTREAM**: reto Cloudflare Turnstile antes de servir nada.
- **VOE**: URL ofuscada con WebAssembly, hay que ejecutar el WASM.
- **LOCAL_FILE/FEMBED/SOLIDFILES/SENDVID/CLIPWATCHING**: archivos o dominios borrados, nada que resolver.
- **GDRIVE**: auth de Google + CAPTCHA.

Regla del proyecto: **0 navegador** — se acepta que esas series queden fuera hasta que el sitio las resuba.

## MP4UPLOAD (único viable por HTTP)
- El embed trae el mp4 DIRECTO en el HTML.
- Patrón: `player.src({type:'video/mp4', src:'https://...mp4upload...mp4'})`
- A veces responde 200 con cuerpo vacío (ráfagas) → 4 reintentos con pausa.

## Flujo de resolución (`resolverAnime`)
```
1. Descargar página del episodio (HTTP puro)
2. Extraer data-player (base64) → URLs de embeds
3. Filtrar mp4upload
4. extraerMp4: regex player.src + verificar que el mp4 sirve (4 intentos)
5. Si falla → registrar fallo (podredumbre); 3 fallos → serie muerta/oculta
```

## Sonda Latanime (`sondaLatanime`, v240)
Corre al arranque (90s) y cada 6h, 2 frentes:
1. **VIVAS**: muestra aleatoria de 15 series visibles → `laProbe()` (abre episodio-1, busca mp4upload, verifica mp4). Si falla → registra fallo; al 3er fallo se oculta + notifica "murió".
2. **MUERTAS**: muestra de 15 series muertas → si `laProbe()` pasa → se quita de muertas + notifica "revivió".
- Pausa de 3s entre series (no saturar).
- Log en `sonda-latanime.log`, eventos en campanita + log del panel.
- `LA_VISTAS` (`public/latanime-vistas.txt`): series ya verificadas alguna vez.

## Podredumbre + apelaciones
- `LA_FALLOS` (`data/la-fallos.json`): slug → {f, last, h}
- 3 fallos espaciados ≥10 min → `LA_MUERTAS_SET` (`public/latanime-muertas.txt`)
- `laRevizar()`: apelaciones — ocultadas hace <7 días se re-prueban una por una (12s entre cada una); si reviven → visibles + notificación.
- `revivirGeneral()` también notifica revividas de GoPelis/PelisXD/AnimeFLV/Cuevana.

## Duplicados con AnimeFLV
- Latanime tiene prioridad (audio latino).
- AnimeFLV cede cuando Latanime tiene la misma serie (comparación por tokens normalizados del título base).

## Panel de estado
- Tarjeta **Latanime** (naranja `#ffb020`) en Fuentes de video, con logo.
- Contador de Series = activas (total − ocultas − muertas).
- Clic en la tarjeta → detalle con barra, chips (activas/ocultas/verificadas) y log de sonda.
- Campanita: muertes y revividas en tiempo real (log persistente en `data/sonda-log.json`, sobrevive reinicios).

## Archivos en disco
- `public/latanime-slugs.txt` — 3,453 slugs del catálogo
- `public/latanime-ocultas.txt` — 558 castellano/duplicados
- `public/latanime-muertas.txt` — 1,368 series con video caído
- `public/latanime-vistas.txt` — series verificadas por la sonda
- `data/la-fallos.json` — registro de fallos en curso
- `data/sonda-log.json` — log persistente de eventos (todas las sondas)
- `sonda-latanime.log` — resumen por ciclo de la sonda
- `public/sites/latanime.png` — icono del panel (fondo transparente)
- `LATANIME-AUDIT.md` — auditoría completa del catálogo
- `LATANIME-RESOLVER-ANALYSIS.md` — análisis player por player
