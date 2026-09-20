# 📋 Documentación Técnica — PelisXD en Huddle

**Última actualización:** 20 Sep 2026  
**Versión:** v234  
**Autor:** Agente Arena.ai

---

## 1. Resumen Ejecutivo

PelisXD (pelisxd.com) es la fuente de películas más grande en Huddle con **4,703 películas** en su sitemap. De estas, **2,490 (52.9%)** tienen embeds de Byse que funcionan con HTTP puro. Las **2,213 restantes** están ocultas porque solo tienen DoodStream (videos eliminados) o Streamwish (CDN bloqueado).

### Números clave
| Concepto | Cantidad |
|---|---|
| Total en sitemap | 4,703 |
| Con Byse (visibles) | 2,490 |
| Ocultas (sin Byse) | 2,174 |
| Slugs verificados (pxd-vistas.txt) | ~15-60 (crece cada ciclo) |
| Géneros disponibles | 20 |

---

## 2. Arquitectura del Resolver

### 2.1 Flujo de resolución (HTTP puro, sin navegador)

```
Usuario toca película de PelisXD
  → resolverPelisxd(url)
    → extraerStreamwishPeli(pageUrl)
      → Descarga HTML de pelisxd.com/pelicula/{slug}
      → Extrae v_source (embeds en base64)
      → Intenta cada embed en orden:
        1. Byse (byseqekaho.com) → API + AES-256-GCM → m3u8
        2. DoodStream → pass_md5 (bloqueado por Cloudflare)
        3. Streamwish → JS packed unpacker (CDN bloqueado)
        4. Si ninguno funciona → "peli caída"
```

### 2.2 Byse — El resolver que funciona

**Host:** `byseqekaho.com` y similares

**Flujo:**
1. Extraer código de la URL: `embedUrl.replace(/\/+$/, '').replace(/.*\//, '')`
2. API call: `GET https://byseqekaho.com/api/videos/{code}`
3. Respuesta: `{title, playback: {version, key_parts[], iv, payload}}`
4. Clave AES-256-GCM:
   - `n = parseInt(version)`
   - `indices = [n, 31 - n]`
   - `key = concat(b64url_decode(key_parts[n-1]), b64url_decode(key_parts[31-n-1]))` → 32 bytes
   - `iv = b64url_decode(playback.iv)`
   - `payload = b64url_decode(playback.payload)`
   - `ciphertext = payload.slice(0, -16)`
   - `authTag = payload.slice(-16)`
5. `AES-256-GCM-Decrypt(ciphertext, key, iv, tag)` → JSON con `{sources: [{url: "https://cdn...master.m3u8"}]}`
6. Verificar que el m3u8 sirve (contiene `#EXTM3U`)
7. Registrar CDN host en `hlsReferers` para proxy

**Código:** `server.js` líneas ~4940-4980

### 2.3 DoodStream — Bloqueado

**Hosts:** doodstream.com, dood.li, d000d.com, dood.wf, dood.re, playmogo.com, myvidplay.com, ds2play.com

**Problema:** Todos los mirrors redirigen a `playmogo.com` que tiene protección DDoS-Guard/Cloudflare. Además, los videos fueron eliminados de DoodStream ("Video not found").

**Código:** `server.js` líneas ~4985-5020

### 2.4 Streamwish — CDN bloqueado

**Hosts:** vidhidepro.com, vidhidefast.com, callistanise.com, listeamed.net, vidhidepre.com, vidhidevip.com, movearnpre.com

**Problema:** El m3u8 está dentro de JavaScript packed (`eval(function(p,a,c,k,e,d){...})`), pero el CDN (`dramiyos-cdn.com`) devuelve 502/timeout al verificar el m3u8.

**Unpacker implementado:** Desempaca el JS usando el algoritmo p,a,c,k,e,d para extraer la URL m3u8. Funciona técnicamente pero el CDN no sirve el video.

**Código:** `server.js` líneas ~5040-5080

---

## 3. Sistema de Índice (Sitemap)

### 3.1 Cómo se cargan las películas

```javascript
// pelisxdIndice() — server.js línea ~4977
// Descarga el sitemap cada 24 horas
const r = await fetchSeguro('https://www.pelisxd.com/sitemap.xml', 20000);
slugs = [...t.matchAll(/<loc>https:\/\/pelisxd\.com\/pelicula\/([a-z0-9-]+)<\/loc>/gi)].map(m => m[1]);
```

**Resultado:** ~4,678 slugs almacenados en `pelisxdIdx.slugs`
**TTL:** 24 horas (`PELISXD_IDX_TTL`)

### 3.2 Cómo se buscan películas

```javascript
// buscarPelisxd(q) — server.js línea ~4990
// Busca por coincidencia de tokens en los slugs
for (const s of slugs) {
  let ok = true, score = 0;
  for (const t of tokens) {
    const i = s.indexOf(t);
    if (i < 0) { ok = false; break; }
    score += i === 0 ? 2 : 1;
  }
  if (ok) cand.push({ s, score: score - s.length / 100 });
}
// Toma los top 14 candidatos, verifica metas, devuelve los 6 mejores vivos
```

### 3.3 Cómo se verifican las películas (pelisxdMeta)

```javascript
// pelisxdMeta(slug) — server.js línea ~5010
// Descarga la página de la peli y extrae:
// - Título (del <title>)
// - Poster (de og:image)
// - Año
// - alive: true si tiene al menos un v_source con Byse
```

---

## 4. Sistema de Sonda (Auto-monitoreo)

### 4.1 Arquitectura

La sonda corre **cada 6 horas** (integrada en el ciclo de podredumbre) y hace 3 cosas:

```
┌─────────────────────────────────────────────────┐
│  SONDA PELISXD (cada ~6h, 15 por frente)        │
├─────────────────────────────────────────────────┤
│  1. NUEVAS: slugs del sitemap no vistos          │
│     → verificarByse() → ¿tiene Byse?             │
│     ✅ Sí → queda visible (pxdVistas.add)        │
│     ❌ No → PXD_OCULTAS.add (oculta)            │
│                                                  │
│  2. VIVAS: muestra de películas activas           │
│     → verificarByse() → ¿sigue teniendo Byse?    │
│     ❌ No → PXD_OCULTAS.add (oculta)            │
│                                                  │
│  3. MUERTAS: muestra de películas ocultas         │
│     → verificarByse() → ¿volvió a tener Byse?    │
│     ✅ Sí → PXD_OCULTAS.delete (revive)         │
└─────────────────────────────────────────────────┘
```

### 4.2 Función verificarByse(slug)

```javascript
async function verificarByse(slug) {
  const r = await fetchSeguro('https://www.pelisxd.com/pelicula/' + slug, 12000);
  if (!r.ok) return { ok: false, reason: 'page_' + r.status };
  const html = await r.text();
  const re = /v_source[^A-Za-z0-9]{0,12}([A-Za-z0-9+/=]{24,})/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const url = Buffer.from(m[1], 'base64').toString('utf8');
      if (/byse|byseqekaho/i.test(url)) return { ok: true };
    } catch {}
  }
  return { ok: false, reason: 'no_byse' };
}
```

### 4.3 Guard de memoria

```javascript
const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
if (memMB > 500) { 
  console.warn('[sonda] pxd saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); 
  return; 
}
```

### 4.4 Archivos de estado

| Archivo | Propósito | Se actualiza |
|---|---|---|
| `public/pxd-ocultas.txt` | Slugs de películas ocultas (muertas) | Sonda agrega/quita |
| `public/pxd-vistas.txt` | Slugs ya verificados alguna vez | Sonda registra |
| `sonda-pelisxd.log` | Log de actividad de la sonda | Cada ciclo |

### 4.5 Integración con el ciclo de podredumbre

```javascript
// server.js línea ~451
setTimeout(() => { 
  laRevizar().catch(...); 
  revivirGeneral().catch(...); 
  sondaPelisxd().catch(() => {}); // ← arranca 90s después del server
}, 90 * 1000);

// server.js línea ~452
setInterval(() => { 
  laRevizar().catch(() => {}); 
  revivirGeneral().catch(() => {}); 
  sondaPelisxd().catch(() => {}); // ← cada 6 horas
}, 6 * 3600 * 1000);
```

---

## 5. Feed y Géneros

### 5.1 Cómo PelisXD aparece en el feed

**Sección propia:** "PelisXD — Estrenos" (16 películas recientes del catálogo)

```javascript
// pelisxdLatest() — server.js
// Fetch de https://www.pelisxd.com/peliculas (página principal)
// Extrae: href, img, title, year de cada tarjeta
// Caché: 3 horas
```

**En cada género:** PelisXD se mezcla con Cuevana (cine-calidad.mx)

```javascript
// peliculasPorGenero(slug) — server.js
const [cv, pxd] = await Promise.all([
  generoPagina(slug, 1),      // Cuevana (cine-calidad.mx)
  pelisxdPorGenero(slug),      // PelisXD
]);
// Mezcla alternada: Cuevana, PelisXD, Cuevana, PelisXD...
```

### 5.2 Géneros de PelisXD

| Slug PelisXD | Slug Huddle | Nombre |
|---|---|---|
| accion | accion | Acción |
| animacion-e-infantil | animacion | Animación |
| aventura | aventura | Aventura |
| belico | belica | Bélica |
| ciencia-ficcion | ciencia-ficcion | Ciencia ficción |
| comedia | comedia | Comedia |
| crimen | crimen | Crimen |
| documentales | documental | Documental |
| drama | drama | Drama |
| fantasia | fantasia | Fantasía |
| intriga | misterio | Misterio |
| musical | musica | Música |
| romance | romance | Romance |
| suspenso | suspense | Suspense |
| terror | terror | Terror |
| anime | — | Anime (no mapeado) |
| artes-marciales | — | Artes marciales (no mapeado) |
| deporte | — | Deporte (no mapeado) |
| eroticas | — | Eróticas (no mapeado) |
| religiosas | — | Religiosas (no mapeado) |

### 5.3 Rotación de géneros en el feed

```javascript
// generosDelDia() — server.js
// Fisher-Yates determinista: baraja los 17 géneros distinto cada día
const dia = Math.floor(Date.now() / 864e5);
const arr = [...GENEROS_ES];
let seed = dia * 2654435761;
for (let i = arr.length - 1; i > 0; i--) {
  seed = ((seed * 48271 + 12345) >>> 0) % (i + 1);
  [arr[i], arr[seed]] = [arr[seed], arr[i]];
}
return arr; // TODOS los géneros, no solo 6
```

---

## 6. Búsqueda

### 6.1 Cómo busca PelisXD

```javascript
// buscarPelisxd(q) — server.js
// 1. Descarga sitemap (cached 24h)
// 2. Busca slugs que contengan todos los tokens de la query
// 3. Toma top 14 candidatos
// 4. Verifica metas (alive) de cada uno
// 5. Devuelve los 6 mejores vivos
```

### 6.2 Caché de búsqueda

```javascript
// globalThis._searchCache — singleton en el servidor
// Máximo: 50 queries
// TTL: 5 minutos
// Eviction: automática cuando se llena
```

### 6.3 Debounce en frontend

```javascript
// public/app.js — debounceBuscar()
let _debounceBuscarTimer = null;
function debounceBuscar() {
  clearTimeout(_debounceBuscarTimer);
  const q = ($('#spInput').value || '').trim();
  if (q.length < 2) return;
  _debounceBuscarTimer = setTimeout(() => abrirBuscador(q), 350);
}
```

---

## 7. Cachés y Límites de Memoria

| Caché | TTL | Máximo | Limpieza |
|---|---|---|---|
| `pelisxdIdx` (sitemap) | 24h | 1 archivo | Al expirar |
| `pelisxdMetaCache` | 15 min | 500 entradas | Cada 5 min |
| `pxdGeneroCache` | 3h | 17 entradas | Cada 10 min |
| `generosCache` | 1h | 17 entradas | Cada 10 min |
| `pxdLatestCache` | 3h | 18 items | Al expirar |
| `globalThis._searchCache` | 5 min | 50 queries | Al buscar |
| `pelisxdStreams` | 2h | Sin límite | Al expirar |

---

## 8. Archivos del Proyecto

| Archivo | Descripción |
|---|---|
| `server.js` | Servidor principal — resolver, sonda, feed, búsqueda |
| `public/app.js` | Frontend — UI del feed, búsqueda, reproductor |
| `public/style.css` | Estilos — separación visual entre géneros |
| `public/pxd-ocultas.txt` | 2,174 slugs de películas ocultas |
| `public/pxd-vistas.txt` | Slugs verificados por la sonda |
| `sonda-pelisxd.js` | Script standalone de sonda (alternativo) |
| `sonda-pelisxd.log` | Log de actividad de la sonda |
| `docs/pelisxd.md` | Documentación original de PelisXD |
| `docs/AUDITORIA-PELISXD-2026-09-20.md` | Auditoría completa |

---

## 9. Historial de Cambios

### v232 (20 Sep 2026)
- Implementación inicial del resolver Byse (AES-256-GCM)
- DoodStream pass_md5 y streamwish fallback

### v233 (20 Sep 2026)
- **Fix:** Trailing slash en URLs de Byse (`embedUrl.replace(/\/+$/, '').replace(/.*\//, '')`)
- Causa: URLs como `byseqekaho.com/e/code/` extraían código vacío

### v234 (20 Sep 2026)
- **Auditoría completa:** 4,703 películas verificadas
- **Ocultamiento:** 2,174 películas sin Byse ocultadas
- **Sonda automática:** 3 frentes (nuevas + vivas + muertas)
- **Feed:** PelisXD en todos los géneros + sección propia
- **Búsqueda:** Debounce 350ms + caché 5 min + error handling
- **Memoria:** Límites en todas las cachés + batch de géneros
- **Streamwish unpacker:** JS packed desempacado (CDN bloqueado)
- **Docs:** Auditoría, documentación técnica, CONTINUACION actualizada

---

## 10. Pendientes

- [ ] Resolver Streamwish (CDN dramiyos-cdn.com devuelve 502)
- [ ] Explorar si DoodStream vuelve a tener videos
- [ ] Mapear géneros faltantes (anime, artes marciales, deporte, eróticas, religiosas)
- [ ] Sonda para Cuevana (cine-calidad.mx)
- [ ] Optimizar velocidad de búsqueda (< 500ms)

---

*Documentación generada el 20 Sep 2026 por el agente de Arena.ai*