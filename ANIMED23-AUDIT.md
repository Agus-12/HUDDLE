# AnimeD23 — Auditoría Completa
## 21 septiembre 2026 · Huddle v248 (sonda + panel + catálogo)

---

## 1. Resumen ejecutivo

| Métrica | AnimeD23 | Latanime | AnimeFLV |
|---------|----------|----------|----------|
| **URL** | animed23.com | latanime.org | vww.animeflv.one |
| **Catálogo** | **229** | 3.453 | 2.955 |
| **Idioma** | Sub + Latino + Castellano | Latino (prioridad) | Sub |
| **Tipo** | WordPress + player propio | WP Dooplay | WP custom |
| **Protección** | Ninguna (HTTP puro) | mp4upload referer | Hex encrypt |
| **Embeds** | animed23.online (Byse/ok.ru/rpmvid) | mp4upload | mp4upload / voe / ok.ru … |
| **Traslape con Latanime** | 19 | — | 541 |
| **Traslape con AnimeFLV** | 43 | 541 | — |
| **Únicos** | **169 (74 %)** | — | 81 % |
| **Sonda** | ✅ v248 (5+3) | podredumbre | ✅ v243 (5+3) |
| **Panel** | ✅ v248 | ✅ | ✅ |
| **Resolver nativo** | ⏳ Probe listo, resolver pendiente | ✅ | ✅ (mp4upload) |

**Veredicto: VALE LA PENA re-agregar.** 169 títulos únicos (74 %), sin Cloudflare ni rate-limit, 229 fichas en <2 min, 6 hosts por episodio de los cuales 4 ya los sabemos romper (Byse, ok.ru, rpmvid, archive.org). La sonda v248 ya lo vigila en producción; el resolver nativo es el siguiente paso (1 sesión).

---

## 2. Arquitectura del sitio

| Campo | Valor |
|-------|-------|
| **Dominio** | https://animed23.com |
| **CMS** | WordPress + Yoast SEO |
| **Plantilla** | `data-modo-color` (claro/oscuro, localStorage) |
| **CDN de video** | https://animed23.online (origen separado del WP) |
| **Listado** | `/anime/` paginado `/anime/page/N/` (12 páginas) |
| **Ficha** | `/anime/<slug>/` (og:image 680×1007, 12–25 eps por serie) |
| **Episodio** | `/capitulo/<slug>-ep-N/` o `/capitulo/<slug>-capitulo-N/` |
| **Player externo** | `animed23.online/opciones/options.php?server=multi&value=JWT` |

No hay Cloudflare, no hay `cf-challenge`, no hay rate-limit. Un `fetch` directo con `User-Agent: Mozilla/5.0` trae 158 kB en 300 ms.

---

## 3. Catálogo — construcción

### Método (Node fetch directo, no `fetch_page`)
```js
const re = /href="https:\/\/animed23\.com\/anime\/([a-z0-9-]+)\/"/g;
let slugs = new Set();
for (let p=1; p<=12; p++) {
  const url = p===1 ? 'https://animed23.com/anime/' : `https://animed23.com/anime/page/${p}/`;
  const html = await (await fetch(url, {headers:{'User-Agent':'Mozilla/5.0'}})).text();
  for (const m of html.matchAll(re)) slugs.add(m[1]);
}
// → 229 únicos, ordenados
```

| Página | Nuevos | Acumulado |
|--------|--------|-----------|
| 1 | 27 | 27 |
| 2 | 19 | 46 |
| 3 | 18 | 64 |
| 4 | 18 | 82 |
| 5 | 20 | 102 |
| 6 | 20 | 122 |
| 7 | 19 | 141 |
| 8 | 20 | 161 |
| 9 | 20 | 181 |
| 10 | 20 | 201 |
| 11 | 20 | 221 |
| 12 | 8 | **229** |

**Persistencia**

```
public/d23-slugs.txt         — 229 slugs (canónico, ordenado)
public/animed23-slugs.txt    — alias (compatibilidad con animeflv-slugs.txt)
public/d23-ocultas.txt       — muertos verificados por sonda (vacío al inicio)
public/d23-vistas.txt        — probados alguna vez (crece 5+3 por ciclo)
data/fallos-d23.json         — contadores {f,last,h} para podredumbre 3/10 min
sonda-animed23.log           — log rotativo 6h
```

Muestras: `29-sai-dokushin-chuuken-boukensha-no-nichijou`, `black-torch`, `ghost-meets-gal-2026`, `aishiteru-game-wo-owarasetai`, `mato-seihei-no-slave`.

---

## 4. Estructura de URLs

```
AnimeD23
├── /anime/<slug>/                      → ficha + grid de episodios
│     ├── /capitulo/<slug>-ep-1/        → episodio 1 (iframe opciones/options.php)
│     ├── /capitulo/<slug>-ep-2/
│     ├── /capitulo/<slug>-ep-12/
│     └── /capitulo/<slug>-capitulo-11/  (variante vieja, misma lógica)
├── https://animed23.online/opciones/options.php?server=multi&value=JWT
│     └── → player.php?data=JWT         → selector / contenedor
│           └── → multiplayer/contenedor.php?id=<b64>
│                 └── const videoTabs = [{tab_name, url} ×6]
└── https://animed23.online/container.php?id=D23-XXXXXXXX&open=1
      └── data-player-url="https://bysesukior.com/e/..." (6 tabs)
```

**Variantes detectadas:**

- **JWT multi:** `options.php` (JWT: `{"sub":"b5N9...","lat":"...","cast":"...","bg":"https://..."}` + `hmac`) → `player.php?data=...` (portada `d23-portada`) → selector (`d23-selector` con botones Sub/Lat/Cast) → `contenedor.php?id=b5N9thy0Gx` (videoTabs JSON).
- **Directo D23:** `container.php?id=D23-4BF9E96C1C19&open=1` (embed `data-player-url`, 6 botones). Sin JWT, más rápido.

Ambas llegan a los mismos 6 hosts.

---

## 5. Idioma

Cada episodio trae 3 contenedores:

```json
{"sub":"b5N9...","lat":"Hgve...","cast":""}
```

- `sub` — siempre presente
- `lat` — latino (cuando existe)
- `cast` — castellano (minoría)

El selector `d23-selector` muestra botones SUB / LAT / CAST. La sonda prueba el primer episodio (normalmente SUB) — si SUB vive, la serie está viva; LAT/CAST son variantes del mismo `value`.

---

## 6. Hosts de video (6 por episodio)

| # | Tab | URL | Tipo | Estado Huddle |
|---|-----|-----|------|---------------|
| 1 | **Byse** | `bysesukior.com/e/<id>` | iframe HLS | ✅ ya lo rompemos (CineCalidad, PelisXD) |
| 2 | **Omega** | `archive.org/download/...mp4` | mp4 directo | ⚠️ 403 desde datacenter, OK desde MX |
| 3 | **MEGA** | `mega.nz/embed/<id>` | iframe | ❌ extracción compleja |
| 4 | **OK** | `ok.ru/videoembed/<id>` | iframe | ✅ resolverOkRu existe |
| 5 | **Epsilon** | `ytplay.rpmvid.com/#<id>` | iframe | ✅ misma familia Lacartoons (rpmvid) |
| 6 | **Abyss** | `abyssplayer.com/<id>` | iframe | ❓ sin analizar (mp4 secundario) |

**Descargas** por calidad (720p / 1080p): Terabox, MEGA, Byse, MediaFire, FireLoad, GoFile.

**Lectura:** 4 de 6 pasan por extractores que Huddle ya tiene. El resolver nativo puede elegir Byse/OK/rpmvid en orden de confiabilidad — misma estrategia que CineCalidad (goodstream) y Latanime (mp4upload).

Ejemplo vivo (Black Torch EP12, `D23-4BF9E96C1C19&open=1`):

```html
<button data-player-url="https://bysesukior.com/e/vv5qgw9o2jah" data-player-label="Byse">Byse</button>
<button data-player-url="https://archive.org/download/je7qy8dmkq-z4t3h97f/...mp4" data-player-label="Omega">Omega</button>
<button data-player-url="https://ok.ru/videoembed/16206021397164" data-player-label="OK">OK</button>
<button data-player-url="https://ytplay.rpmvid.com/#6wlnpz" data-player-label="Epsilon">Epsilon</button>
```

contenedor `b5N9thy0Gx` (29-sai EP12):

```js
const videoTabs = [
  {"tab_name":"Moon","url":"https://bysesukior.com/e/z29ty30qo8au/29sai-12"},
  {"tab_name":"Mytsumi","url":"https://mytsumi.com/multiplayer/..."},
  {"tab_name":"Mega","url":"https://mega.nz/embed/..."},
  {"tab_name":"OK","url":"https://ok.ru/videoembed/13021529180844"},
  {"tab_name":"Epsilon","url":"https://ytplay.rpmvid.com/#zbrbgg"},
  {"tab_name":"Abyss","url":"https://abyssplayer.com/rch-Sth88"}
];
```

---

## 7. Traslape

| Contra | Mismo slug | % de 229 |
|--------|------------|----------|
| Latanime (3.453) | 19 | 8 % |
| AnimeFLV (2.955) | 43 | 19 % |
| En alguno | 60 | 26 % |
| **En ninguno → únicos** | **169** | **74 %** |

> 74 % del catálogo NO está en las otras fuentes de anime de Huddle. Complementa, no duplica.

---

## 8. Verificación (probe) — v248

```js
async function d23Probe(slug){
  const r = await fetchSeguro('https://animed23.com/anime/'+slug+'/', 12000);
  const eps = [...new Set([...html.matchAll(/\/capitulo\/([a-z0-9-]+)\//g)].map(m=>m[1]))].slice(0,2);
  for(const epSlug of eps){
    const r2 = await fetchSeguro('https://animed23.com/capitulo/'+epSlug+'/', 12000);
    // 1) directo D23
    const direct = /container\.php\?id=([A-Za-z0-9_-]+)/.exec(html2);
    if(direct){
      const h5 = await (await fetchSeguro('https://animed23.online/container.php?id='+direct[1]+'&open=1')).text();
      if(/bysesukior|ok\.ru|rpmvid|data-player-url/i.test(h5)) return true;
    }
    // 2) JWT multi
    let opt = /<iframe[^>]+src="([^"]*opciones\/options\.php[^"]*)"/i.exec(html2);
    optUrl = opt[1].replace(/&#038;/g,'&');
    const h3 = await (await fetchSeguro(optUrl)).text();
    if(/d23-portada|d23-selector/i.test(h3)){
      // sigue a player.php y luego verifica contenedor o selector con hosts
      return true;
    }
  }
  return false;
}
```

- Prueba 2 episodios (evita falso negativo por un cap roto).
- Normaliza `&#038;` → `&` (WP escapado).
- Considera vivo si: `container.php&open=1` trae `data-player-url`/Byse, o `options.php`/`player.php` responden con `d23-portada`/`d23-selector` (cadena válida aunque el contenedor final aún no se haya seguido).
- `all-you-need-is-kill` (0 eps) → correctamente muerto.
- Muestra 6 Jul 2026: 7/8 aleatorios vivos (1 falso por slug raro).

---

## 9. Sonda AnimeD23 — v248

```js
/* 5 vivas + 3 muertas por ciclo (arranque 90s + cada 6h), pausa 1.8s, log sonda-animed23.log */
async function sondaD23(){
  // 5 vivas: D23_TODOS - D23_OCULTAS → d23Probe → si muere 3× → D23_OCULTAS + notify 'AnimeD23' muerto
  // 3 muertas: D23_OCULTAS → d23Probe → si revive → fuera de ocultas + notify revivio
  // persiste d23-ocultas.txt / d23-vistas.txt (y alias animed23-*.txt)
}
```

- Memoria guard: salta si heap >350 MB.
- Podredumbre `FALLOS_D23` (3 fallos espaciados ≥10 min → ocultar, éxito → perdonar, h=timestamp).
- Notifica como `AnimeD23` (`sondaNotify('AnimeD23','muerto'|'revivio',slug,msg)`) → llega a campana 🔔, a `SONDALOG` (500), y a `/api/sonda-log?fuente=AnimeD23`.
- Schedule: `setTimeout 90s` + `setInterval 6h` junto a `sondaPelisxd / sondaCuevana / sondaCineCalidad / sondaLatanime / sondaCaricaturas / sondaAnimeflv / sondaNovelas`.

---

## 10. Panel — v248

**Tarjeta AnimeD23**

- Color: `#22c55e` (verde D23, neón sutil)
- Logo: `/sites/animed23.png` (`?v=248`, drop-shadow `66`)
- `renderFuentes` → `colors.animed23`, `logos.animed23`
- Stats: `D23_TODOS.size` total, `D23_OCULTAS.size` ocultas, `D23_VISTAS.size` vistas, `activas = total - ocultas`
- Barra `act/total %`

**Detalle al tocar la tarjeta (showFuente)**

- Barra + chips: Activas / Ocultas / Verificadas
- Log: `GET /api/sonda-log?fuente=AnimeD23&limit=30` (muerto ✕ rojo `#ff5c7a`, revivió ✓ verde `#38e08a`, `timeAgo(ts)`)

**Dashboard catálogo**

- `tp` (películas) excluye `animed23` (es anime, no peli)
- `ts` (series) ahora suma `ca.animes + ca.animeflv + ca.animed23`
- Detalle: `Animes: <b>ca.animes</b> · AnimeFLV: <b>ca.animeflv</b> · AnimeD23: <b>ca.animed23</b>`

**Notificaciones**

- Bell 🔔 cuenta no leídas (`_notifs.length - _seenNotifs`)
- Filtro `fuente=Caricaturas` agrupa Danimados/Lacartoons/MisCaricaturas; `fuente=AnimeD23` va directo.

---

## 11. Archivos de persistencia

```
public/d23-slugs.txt            229 slugs
public/animed23-slugs.txt       alias idem (compat)
public/d23-ocultas.txt          ocultas por sonda (sort, rewrite 3s debounce)
public/d23-vistas.txt           vistas (append por ciclo)
public/animed23-ocultas.txt     alias ocultas
public/animed23-vistas.txt      alias vistas
data/fallos-d23.json            Map → {f,last,h}
data/sonda-log.json             SONDALOG (500, 3s debounce)
sonda-animed23.log              [ISO] Xs vivas→muertas=M muertas→vivas=N muertas=X vistas=Y
```

**Formato ocultas/vistas:** un slug por línea, newline final.

---

## 12. Comparativa sondas

| Fuente | Total | Ocultas | Vistas | Activas | Sonda | Pausa | Log |
|--------|-------|---------|--------|---------|-------|-------|-----|
| **AnimeD23** | 229 | 0 | 0 | 229 | v248 | 1.8s | sonda-animed23.log |
| Latanime | 3.453 | 558+1.368 | 0 | 1.527 | podredumbre | — | — |
| AnimeFLV | 2.955 | 0 | 0 | 2.955 | v243 | 1.5s | sonda-animeflv.log |
| Danimados | 823 | 11+… | dani: | 812 | v241 | 1.5s | sonda-caricaturas.log |
| CineCalidad | ~10.950 | … | … | … | v238 | 1.2s | sonda-cinecalidad.log |

---

## 13. Historia en Huddle

- **v68 / v70 (2025):** se quitó AnimeD23 (`git log --grep=animed23`: commit "fuera AnimeD23"). Solo quedó filtro `server.js` que bloqueaba `animed23.online`, logo `sites/animed23.png` y entrada en mapa de salas. El sitio desde entonces cambió por completo (nuevo dominio `animed23.online`, JWT multi, 6 hosts) — re-agregarlo es código nuevo, no revert.
- **v244 (21 sep 2026):** re-auditoría corta (ANIMED23-AUDIT.md 31 líneas, 229 animes, cadena JWT, 4/6 hosts viables).
- **v248 (21 sep 2026):** sonda completa + panel + catálogo persistido (`d23-slugs.txt` 229), ficha técnica expandida a nivel `CINECALIDAD-AUDIT.md`.

---

## 14. Estado y próximos pasos

### Hecho (v248)

- [x] Catálogo 229 slugs (12 páginas, regex `href="https://animed23.com/anime/([a-z0-9-]+)/"`, Node fetch directo)
- [x] Cadena verificada a mano (4 muestras, /tmp/options.html 1754b + /tmp/player.html 1106b + contenedor 18k videoTabs + container&open=1 9k data-player-url)
- [x] Probe `d23Probe` (2 eps, decodifica `&#038;`, maneja directo + JWT, hosts check)
- [x] Sonda `sondaD23` (5+3, 1.8s, notify AnimeD23, logs)
- [x] Stats `/api/stats` → `fuentes.animed23`
- [x] Panel tarjeta verde + detalle + log filtrado
- [x] Persistencia (ocultas/vistas/fallos)
- [x] Ficha técnica (este documento)

### Pendiente (próxima sesión) — ✅ RESUELTO EN v286 (22 SEP)

- [x] **Resolver nativo** `resolverD23(epUrl)` → elige Byse/OK/rpmvid, `hlsReferers` + `servirPlaylist` (vía caché `/api/xd/`, como PelisXD)
- [x] Hilo `serieCtxFromUrl` para "Sig. ▸" en sala (rama animed23, regex no-aviesa)
- [x] Búsqueda `buscarAnimeD23(q)` → `https://animed23.com/?s=` (parser de cards + portadas IMDb locales)
- [x] Feed home: `animesMezclados()` ya sumaba `d23Latest()` (existente desde v248)
- [x] `buscarEnSitios` filtra `D23_OCULTAS` (dentro de `buscarAnimeD23`)

Detalle completo en §16.

---

## 15. Comandos de verificación

```bash
# Contar slugs
wc -l public/d23-slugs.txt  # 229

# Probar probe manual
node -e "import('./server.js')" # o curl directo
curl -s https://animed23.com/anime/black-torch/ | grep -c "/capitulo/"
curl -s https://animed23.com/capitulo/black-torch-ep-12/ | grep -o "container.php?id=[^\"]*"

# Stats en vivo
curl -s http://localhost:3000/api/stats | python3 -m json.tool | grep -A5 animed23
curl -s http://localhost:3000/api/sonda-log?fuente=AnimeD23 | python3 -m json.tool | head -30

# Logs
tail -20 sonda-animed23.log
cat data/fallos-d23.json | python3 -m json.tool

# Panel
open https://129.80.212.92:3000/panel.html   # tarjeta verde AnimeD23
```

---

*Documento generado: v248 — 21 septiembre 2026 · Probe validado con 5 slugs (3 directos + 2 JWT) y 8 aleatorios (7/8 vivos) · Sonda 90s+6h activa*

---

## 16. Resolución nativa — v286 (22 SEP 2026)

### Cadena implementada (HTTP puro)
```
api/solo | resolverNativoInterno (sala)
   └─ resolverD23(epUrl)                     animed23.com/capitulo/… (fetch simple, 15 s)
        ├─ detección de challenge Cloudflare → error amable ("intenta luego")
        ├─ d23TabsDeHtml(html, referer)      → tabs (6 hosts)
        │    ├─ cadena DIRECTA: container.php?id=D23-…&open=1 → data-player-url
        │    └─ cadena JWT: opciones/options.php → player.php?data= → multiplayer/contenedor.php → videoTabs
        └─ resolverD23ConTabs(tabs, ep, serie, contabilidad)
             prioridad 0  Byse   extraerByse          AES-256-GCM (version n: parts[n-1]+parts[31-n-1])
             prioridad 1  OK     resolverOkRu(id)     ok.ru/videoembed → mp4 okcdn (existente)
             prioridad 2  rpmvid resolverRpmvidD23    ytplay /api/v1/video hex → AES-128-CBC
                                                             (Lacartoons keys) → TikTok hls (params.v) / cf
             Byse y rpmvid → caché pelisxdStreams → /api/xd/<tok>/index.m3u8 (servirPlaylist)
             éxito → d23Perdonar(serie) · fallo total → d23Ocultar(serie) + mensaje con los fallos
```

### Complementos
- `datosAnimeD23(slug)`: ficha `/api/anime/<slug>?site=animed23` — capítulos
  (`/capitulo/<slug>-ep-<n>/`), poster local IMDb primero, cache 30 min, respeta `D23_OCULTAS`.
- `buscarAnimeD23(q)`: búsqueda WP `?s=` → cards → `site:'AnimeD23'` → `buscarEnSitios`.
- `serieCtxFromUrl` rama animed23 → "Sig. ▸" en sala (regex `…/capitulo/(.*?)-(ep|capitulo)-<n>`).
- `/api/d23/probar?u=<capitulo|container>`: diagnóstico sin contabilidad (útil desde el panel).
- Frontend: 1 línea en `abrirSeriePicker` (`?site=animed23` para tarjetas `animed23.com/anime/`).

### Verificado en vivo (sandbox, 22 SEP)
- Byse completo: container D23-4BF9E96C1C19 → decrypt → master → variant → **.ts 3.2 MB, sync 0x47** ✓
- Byse con sufijo (`/e/<code>/<x>`) ✓ (el code es el segmento DESPUÉS de `/e/`, no el último).
- OK: mp4 okcdn por proxy (206) ✓ · rpmvid: master TikTok 720p/1080p ✓.
- ⚠️ `animed23.com` da challenge a la IP del sandbox (NO a la de Oracle; auditado 21 SEP
  con fetch simple OK). El primer salto solo se valida en producción tras el despliegue.

### Bugs corregidos en el camino (no repetir)
1. `datosAnimeD23`/`buscarAnimeD23` declaradas DENTRO del bloque `if (/api/trending)` —
   con `'use strict'` eran invisibles desde otros handlers (`ReferenceError` en
   /api/anime y /api/search). **Sondear siempre el alcance: las funciones de feed viven
   adentro de ese if histórico; las que usan otros handlers van a nivel módulo.**
2. El chequeo de éxito de `resolverD23ConTabs` exigía `out.m3u8`, pero Byse devuelve
   `{body,url}` (se cachea después) → Byse fallaba en silencio y siempre ganaba OK.
3. El endpoint /probar con `u=` no codificada perdía la query interna del container
   (se re-une `id` desde el query externo como respaldo).

## §17 (v290, 22 SEP 2026) — Flujo NUEVO "multi" (token rotativo)
Convive con los dos flujos anteriores. Detectado en BAKI-DOU: The Invincible Samurai (2026):
1. El `/capitulo/<slug>-ep-N/` trae `<iframe class="d23-player-frame" src="https://play.animed23.com/multiplayer/options.php?server=multi&value=TOKEN">`.
2. Esa página es un splash ("Jugar") cuyo JS hace `iframe.src='https://<host>/multiplayer/contenedor.php?id=TOKEN'` (host visto: mytsumi.com; el mismo token sirve de id).
3. El contenedor devuelve los `videoTabs` de siempre (Byse/Moon, Mytsumi, Mega, OK, Epsilon, Abyss, rpmvid).
- **El TOKEN rota** (minutos/horas): un token viejo responde "Contenedor no encontrado". Extraerlo SIEMPRE fresco del HTML del episodio; nunca cachear tokens ni URLs del splash.
- `d23TabsDeHtml` y `d23Probe` ya lo siguen (v290). Verificado ep-1/ep-2 de punta a punta (Byse → master 1080p → .ts real).

## §18 (v290.2, 22 SEP 2026) — AUDITORÍA CATÁLOGO COMPLETO (228 series)
Script: `auditoria-animed23.js` · Resultados: `auditorias/animed23-audit-v290.json`

**Resultado tras los fixes: 219/228 traen reproductores y resuelven.**
| flujo | series | notas |
|---|---|---|
| direct (`container.php?id=D23-…`) | 71 | flujo original v286, intacto |
| jwt (`opciones/options.php`) | 117 | de estas, **26 cambiaron de formato**: player.php ahora devuelve un SELECTOR y hay que seguir `&fuente=latino\|sub\|cast` hasta el iframe del contenedor (fix v290.2 en `d23TabsDeHtml`; preferencia latino→sub→cast) |
| multi (token rotativo, v290) | 31 | BAKI-DOU y cía. |

**Casos restantes (NO son bug de Huddle):**
- 8 fichas sin capítulos en el propio sitio (placeholders: pelis/temporadas anunciadas sin subir aún): all-you-need-is-kill, beastars-temporada-final, black-clover-temporada-2, enen-no-shouboutai-san-no-shou, fullmetal-alchemist-brotherhood, medalist-temporada-2, rezero-kara-hajimeru-isekai-seikatsu, watari-kun-no-xx-ga-houkai-sunzen. v288 las oculta al primer clic con mensaje.
- `gachiakuta`: el último cap (ep-24) trae `value=` VACÍO (el sitio aún no le pone player); ep-1 y el resto sí resuelven.
- Slug basura `feed` (era el catálogo, no una serie): eliminado de d23-slugs.txt/animed23-slugs.txt.

**Verificado en vivo:** aishiteru ep-12 (jwt+selector → Byse → m3u8 ✓), baki-dou ep-3 ✓, black-torch ep-12 ✓.
