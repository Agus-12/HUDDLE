# 🔍 Auditoría PelisXD — 20 Sep 2026

**Servidor:** v233 en Oracle (129.80.212.92:3000)  
**Sitio:** https://www.pelisxd.com  
**Método:** HTTP puro (sin navegador)

---

## 📊 RESUMEN EJECUTIVO

| Concepto | PelisXD | Huddle (v233) | Cobertura |
|---|---|---|---|
| **Películas en catálogo** | **4,703** (sitemap) | **~4,678** (sitemap fetch) | ✅ 99.5% |
| **Series** | ❌ Eliminadas (404) | N/A | N/A |
| **Categorías** | 21 géneros | Solo por slug (sin filtro) | ⚠️ Parcial |
| **Pelis ocultas (caídas)** | — | 0 (pxdOcultas=0) | ✅ |
| **Estrenos recientes** | 10+ nuevos (no en sitemap) | ❌ No detectados | ⚠️ Gap |

---

## 🎬 CATÁLOGO DE PELÍCULAS

### Estructura de PelisXD
- **URL base:** `https://www.pelisxd.com/pelicula/{slug}`
- **Sitemap:** `https://www.pelisxd.com/sitemap.xml` → **4,703 URLs** de películas
- **Paginación:** 99 páginas × ~48 películas/página = ~4,752 (hay solapamiento)
- **Upload IDs:** van de ~1 a ~4827 (última: `/uploads/4827.webp`)

### Cómo indexa Huddle
Huddle descarga el sitemap completo una vez al día (`PELISXD_IDX_TTL = 24h`):
```javascript
// server.js línea 4823
const r = await fetchSeguro('https://www.pelisxd.com/sitemap.xml', 20000);
slugs = [...t.matchAll(/<loc>https:\/\/pelisxd\.com\/pelicula\/([a-z0-9-]+)<\/loc>/gi)].map(m => m[1]);
```
→ Extrae **~4,678 slugs** del sitemap.

### ⚠️ Gap: Estrenos recientes NO están en el sitemap
PelisXD publica películas nuevas en la homepage **antes** de añadirlas al sitemap:

| Película | En homepage | En sitemap | En Huddle |
|---|---|---|---|
| El pacificador (1997) | ✅ | ❌ | ❌ |
| Soy leyenda (2007) | ✅ | ❌ | ❌ |
| Freddy contra Jason (2023) | ✅ | ❌ | ❌ |
| Una Llamada Perdida (2008) | ✅ | ❌ | ❌ |
| Ratatouille (2007) | ✅ | ✅ | ✅ |
| Siniestro (2012) | ✅ | ✅ | ✅ |
| Viernes 13 (1980) | ✅ | ✅ | ✅ |

**Impacto:** Los estrenos más recientes de PelisXD (~10-20 pelis) no aparecen en la búsqueda de Huddle hasta que PelisXD los añade al sitemap (puede tardar días/semanas).

---

## 🏷️ CATEGORÍAS (GÉNEROS)

### 21 géneros en PelisXD
| Género | Pelis (pág 1) | URL | ¿Huddle lo cubre? |
|---|---|---|---|
| Acción | 48 | `/genero/accion` | ⚠️ Solo por slug |
| Animación e Infantil | 48 | `/genero/animacion-e-infantil` | ⚠️ Solo por slug |
| Aventura | 48 | `/genero/aventura` | ⚠️ Solo por slug |
| Bélica | 48 | `/genero/belico` | ⚠️ Solo por slug |
| Ciencia Ficción | 48 | `/genero/ciencia-ficcion` | ⚠️ Solo por slug |
| Comedia | 47 | `/genero/comedia` | ⚠️ Solo por slug |
| Crimen | 48 | `/genero/crimen` | ⚠️ Solo por slug |
| **Deporte** | **28** | `/genero/deporte` | ⚠️ Solo por slug |
| Documentales | 48 | `/genero/documentales` | ⚠️ Solo por slug |
| Drama | 48 | `/genero/drama` | ⚠️ Solo por slug |
| **Eroticas +18** | **48** | `/genero/eroticas` | ⚠️ Solo por slug |
| Fantasía | 48 | `/genero/fantasia` | ⚠️ Solo por slug |
| **Intriga** | **48** | `/genero/intriga` | ⚠️ Solo por slug |
| **Musical** | **48** | `/genero/musical` | ⚠️ Solo por slug |
| **Religiosas** | **18** | `/genero/religiosas` | ⚠️ Solo por slug |
| Romance | 48 | `/genero/romance` | ⚠️ Solo por slug |
| Suspenso | 48 | `/genero/suspenso` | ⚠️ Solo por slug |
| Terror | 48 | `/genero/terror` | ⚠️ Solo por slug |
| Western | 48 | `/genero/western` | ⚠️ Solo por slug |
| **Anime** | **15** | `/genero/anime` | ⚠️ Solo por slug |
| **Artes Marciales** | **18** | `/genero/artes-marciales` | ⚠️ Solo por slug |

> **Nota:** "Solo por slug" = Huddle no filtra por género, pero los slugs están en el índice y se pueden buscar.

### Años disponibles
PelisXD cubre desde ~1970 hasta 2026. Los años más recientes:
- **2026:** ~15+ películas (La captura, Carrera de bestias, Sangre asesina, etc.)
- **2025:** ~10 películas (En la Ruta del Crimen, etc.)
- **2024:** ~20 películas
- **2023:** ~30 películas

---

## 📺 SERIES — ❌ ELIMINADAS

### Estado actual
Las series de PelisXD **ya no existen**. Todas las URLs devuelven 404:
- `https://www.pelisxd.com/series-y-novelas` → **404**
- `https://www.pelisxd.com/serie/dr-house` → **404**
- `https://www.pelisxd.com/serie/la-casa-de-papel` → **404**
- `https://www.pelisxd.com/capitulo/loki-1x5` → **404**

### Historial
- En 2020-2021, PelisXD tenía series con URLs como `/serie/{slug}/` y capítulos como `/capitulo/{serie}x{num}/`
- Tenía títulos populares: Dr. House, La casa de papel, Loki, Lucifer, Dark, etc.
- **El sitemap actual NO incluye ninguna URL de serie**
- PelisXD se enfoca 100% en películas ahora

### Impacto en Huddle
- Huddle **nunca tuvo soporte para series de PelisXD** (el resolver solo cubre `/pelicula/`)
- No hay acción necesaria aquí

---

## 🔧 REPRODUCTORES (Embeds)

### Flujo de resolución (v233)
```
PelisXD page → v_source (base64) → Embed URL → Resolver por host:
  1. Byse (byseqekaho.com) → API → AES-256-GCM → m3u8 ✅
  2. DoodStream (myvidplay/playmogo) → pass_md5 → mp4 ✅  
  3. Streamwish genérico → regex m3u8/mp4 ⚠️ (fallback)
```

### Test end-to-end (v233)
| Película | Embed 1 | Resultado | Calidad |
|---|---|---|---|
| Siniestro (2012) | Byse f8xacb29vg08/ | ✅ m3u8 720p | 1.8 Mbps |
| Ratatouille (2007) | Byse | ✅ | HD |
| Viernes 13 (1980) | Byse | ✅ | HD |

### Bug fixeado en v233
- **Problema:** URLs con trailing slash (`/e/code/`) causaban código vacío → 404
- **Fix:** `embedUrl.replace(/\/+$/, '').replace(/.*\//, '')`
- **Commit:** `bf0f1c5`

---

## 🔍 BÚSQUEDA — RENDIMIENTO

### Estado actual
- **Latencia:** ~1.2s por búsqueda (promedio de 5 tests)
- **Fuentes consultadas en paralelo:** 7 (Cuevana, Latanime, AnimeFLV, PelisXD, Caricaturas, Catálogo local, MovieCosecha)
- **Resultados típicos:** 25-30 (máximo 30)

### Desglose por fuente (ejemplo: "batman")
| Fuente | Resultados |
|---|---|
| Cuevana | 11 |
| Caricaturas | 6 |
| PelisXD | 5 |
| Cartoons | 3 |

### ¿Por qué es "lenta"?
1. **pelisxdMeta()** hace HTTP a cada slug para verificar que esté vivo → ~200-500ms por slug
2. Se prueban **14 candidatos** del índice, se verifican los top 14 metas en paralelo
3. Las otras fuentes (Cuevana, Latanime, etc.) también hacen HTTP a sus sitios
4. La búsqueda en sí es rápida (~50ms), el cuello de botella son las verificaciones HTTP

### Optimizaciones posibles
- [ ] **Caché de metas más agresivo:** pelisxdMetaCache ya tiene TTL de 24h, se podría extender
- [ ] **Reducir candidatos de 14 a 8:** la mayoría de queries no necesitan tantos
- [ ] **Lazy meta:** devolver resultados sin verificar alive, marcar "posiblemente caída" después
- [ ] **Pre-indexar títulos:** en vez de slugs, indexar `{slug, title, year, poster}` del sitemap+meta

---

## 📈 COMPARATIVA: HUDDLE vs PELISXD

### ✅ Lo que Huddle YA tiene correctamente
1. **99.5% del catálogo indexado** (4,678 de 4,703 slugs del sitemap)
2. **Búsqueda funcional** que encuentra PelisXD results
3. **Resolución HTTP puro** con Byse AES-256-GCM decrypt
4. **Sistema de ocultas** (pxdOcultas) para pelis caídas
5. **Auto-revive** que reintenta pelis ocultadas periódicamente
6. **0 pelis ocultas** actualmente (post-fix v233)

### ⚠️ Gaps identificados
1. **Estrenos recientes no detectados** — PelisXD publica en homepage antes que en sitemap
2. **Sin categorías/géneros** — no se puede filtrar por género desde Huddle
3. **Sin soporte de series** — aunque PelisXD ya no las tiene
4. **Search latency ~1.2s** — mejorable con caché más agresivo

### ❌ Lo que NO necesita Huddle
1. Series de PelisXD (eliminadas del sitio)
2. Página de "series-y-novelas" (404)
3. API de búsqueda de PelisXD (no existe, es SPA client-side)

---

## 🎯 RECOMENDACIONES

### Prioridad ALTA
1. **Scrapear homepage de PelisXD** para detectar estrenos antes del sitemap
   - Añadir un crawler que revise `pelisxd.com` y `pelisxd.com/peliculas` cada 6h
   - Extraer slugs nuevos del HTML (patrón: `/pelicula/{slug}`)
   - Añadirlos al índice `pelisxdIdx.slugs`

### Prioridad MEDIA
2. **Optimizar velocidad de búsqueda**
   - Caché de metas: usar datos del sitemap (title, poster) sin HTTP extra
   - Reducir candidatos de 14 a 8
   - TTL de búsqueda más largo para queries repetidas

3. **Mapear categorías** (opcional)
   - Descargar las páginas de cada `/genero/{cat}` y asociar slugs a categorías
   - Permitir filtrar resultados por género

### Prioridad BAJA
4. **Documentación actualizada** — actualizar `docs/pelisxd.md` con:
   - Fix v233 (trailing slash)
   - Total de películas: 4,703
   - Géneros: 21
   - Series: eliminadas

---

*Auditoría generada el 20 Sep 2026 por el agente de Arena.ai*