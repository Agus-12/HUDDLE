# CineCalidad — Auditoría Completa
## Septiembre 2026 (v238)

---

## 1. Resumen Ejecutivo

| Métrica | CineCalidad | Cuevana | PelisXD |
|---------|-------------|---------|---------|
| **URL** | cine-calidad.mx | cuevana.mov | pelisxd.com |
| **Tipo** | WordPress + API | WordPress custom | WordPress |
| **Total títulos** | ~10,950 | ~8,182 | ~4,703 |
| **Películas** | ~8,500 | ~6,500 | ~4,703 |
| **Series** | ~2,450 | ~1,682 | 0 |
| **Audio** | Latino | Latino | Latino |
| **Embeds** | goodstream/vimeos | goodstream/vimeos | Propio (Byse) |
| **Proxy necesario** | ✅ Sí (relay) | ✅ Sí (relay) | ❌ No (local) |
| **Sonda** | ✅ v238 | ✅ v234 | ✅ v234 |
| **Búsqueda** | ✅ v237 | ✅ v235 | ✅ v234 |
| **Feed/Géneros** | ⏳ Pendiente | ✅ | ✅ |

---

## 2. Arquitectura de CineCalidad

### API de Búsqueda
```
GET https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=QUERY&page=N
```

**Respuesta:**
```json
{
  "total_posts": 10950,
  "total_pages": 274,
  "posts": [
    {
      "title": "Oppenheimer (2023)",
      "slug": "oppenheimer",
      "type": "movies",
      "featured_image": "https://image.tmdb.org/t/p/w780/...",
      "rating": "7.8",
      "year": "2023"
    }
  ]
}
```

**Paginación:** 40 posts por página, 274 páginas máximo

### URLs de Contenido
```
Películas: https://cine-calidad.mx/pelicula/{slug}/
Series:    https://cine-calidad.mx/serie/{slug}/
```

### Embeds en las Páginas
Las páginas de CineCalidad contienen iframes con embeds de:
- `goodstream.one` — HLS (m3u8 con token)
- `vimeos.net` — HLS (JavaScript packed)
- `hlswish.com` — HLS
- `videoapp.zip` — HLS (redirect a vimeos)

**Ejemplo de embed encontrado:**
```html
<iframe src="https://goodstream.one/embed-xxxxx.html" ...></iframe>
```

---

## 3. Sitemap y Índice

### Método de Construcción
CineCalidad NO tiene un sitemap.xml accesible. El índice se construye **lazy** via la API de búsqueda:

```javascript
async function cinecalidadIndice() {
  const slugs = new Set();
  const letras = ['a','e','i','o','s','d','l','c','p','m','t','r'];
  
  for (const q of letras) {
    for (let page = 1; page <= 8; page++) {
      const r = await fetchSeguro(
        'https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=' + q + '&page=' + page
      );
      const posts = (await r.json()).posts || [];
      if (!posts.length) break;
      for (const p of posts) {
        slugs.add(p.slug + '|' + p.type + '|' + p.title);
      }
    }
  }
  return [...slugs];
}
```

### Índice Parcial (9 letras × 5 páginas)
| Consulta | Posts encontrados |
|----------|------------------|
| a | 80 |
| e | 200 |
| i | 200 |
| o | 200 |
| s | 200 |
| d | 200 |
| l | 200 |
| c | 200 |
| p | 200 |
| **Total único** | **518** |
| **Películas** | **329** |
| **Series** | **189** |

**Nota:** El índice completo (~10,950) se construye gradualmente por la sonda (12h TTL, 12 letras × 8 páginas = 96 requests).

---

## 4. Verificación de Contenido

### Función de Verificación
```javascript
async function verificarCC(slug, tipo) {
  const esSerie = tipo.includes('series');
  const url = 'https://cine-calidad.mx/' + 
    (esSerie ? 'serie/' : 'pelicula/') + slug + '/';
  
  const r = await fetchSeguro(url, 12000);
  if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
  
  const html = await r.text();
  const hasEmbed = /goodstream\.one|vimeos\.(net|zip)|hlswish\.com|videoapp\.zip/i.test(html);
  
  return { ok: hasEmbed, reason: hasEmbed ? 'embed' : 'no-embed' };
}
```

### Sonda CineCalidad (v238)
```javascript
async function sondaCineCalidad() {
  const sitemap = await cinecalidadIndice();
  
  // 1. NUEVAS (10 por ciclo)
  const desconocidas = shuffle(
    sitemap.filter(s => !CC_VISTAS.has(s.split('|')[0]) && !CC_OCULTAS.has(s.split('|')[0]))
  ).slice(0, 10);
  
  // 2. VIVAS (10 por ciclo)
  const vivas = shuffle(
    sitemap.filter(s => !CC_OCULTAS.has(s.split('|')[0]))
  ).slice(0, 10);
  
  // 3. MUERTAS (10 por ciclo)
  const muertas = shuffle([...CC_OCULTAS]).slice(0, 10);
  
  // Persistir en:
  // - cc-ocultas.txt
  // - cc-vistas.txt
}
```

---

## 5. Películas de CineCalidad (Muestra)

### Top Películas por Rating
| Título | Año | Rating | URL |
|--------|-----|--------|-----|
| Oppenheimer | 2023 | 7.8 | /pelicula/oppenheimer/ |
| Fundación | 2021 | 7.4 | /serie/fundacion/ |
| Dune: Part Two | 2024 | 8.5 | /pelicula/dune-part-two/ |
| Poor Things | 2023 | 8.0 | /pelicula/poor-things/ |
| The Holdovers | 2023 | 7.9 | /pelicula/the-holdovers/ |

### Series Populares
| Título | Tipo | URL |
|--------|------|-----|
| Fundación | Ciencia Ficción | /serie/fundacion/ |
| The Bear | Drama | /serie/the-bear/ |
| Shōgun | Histórica | /serie/shogun/ |
| Fallout | Ciencia Ficción | /serie/fallout/ |
| 3 Body Problem | Ciencia Ficción | /serie/3-body-problem/ |

---

## 6. Comparativa con Huddle

### Estado Actual de Integración

| Característica | CineCalidad | Cuevana | PelisXD |
|----------------|-------------|---------|---------|
| **Resolver** | ✅ v237 | ✅ v233 | ✅ v234 |
| **Proxy HLS** | ✅ via relay | ✅ via relay | ✅ directo |
| **Búsqueda** | ✅ v237 | ✅ v235 | ✅ v234 |
| **Feed/Géneros** | ❌ Pendiente | ✅ | ✅ |
| **Sonda** | ✅ v238 | ✅ v234 | ✅ v234 |
| **Estadísticas** | ✅ v238 | ✅ v238 | ✅ v238 |
| **Panel Admin** | ✅ v238 | ✅ v238 | ✅ v238 |

### Lo que CineCalidad NECESITA para estar al 100%

1. **Feed/Géneros** (prioridad alta)
   - Crear endpoints `/api/cccine/genres` y `/api/cccine/feed`
   - Scrapear las páginas de género de CineCalidad
   - Cachear resultados (1h TTL)

2. **Índice completo** (prioridad media)
   - La sonda construye el índice gradualmente
   - Completar con más letras/páginas
   - ~10,950 títulos total

3. **Auditoría de embeds** (prioridad alta)
   - Verificar qué % de títulos tienen embeds funcionales
   - Identificar patrones de URLs muertas
   - Crear lista de exclusión para títulos sin embeds

4. **Subtítulos** (prioridad baja)
   - CineCalidad a veces incluye subtítulos
   - Extraer y servir via proxy

---

## 7. Endpoints de CineCalidad en Huddle

### Endpoints Existentes
```bash
# Resolver película/serie
GET /api/solo?name=USER&tok=TOKEN&url=https://cine-calidad.mx/pelicula/oppenheimer/

# Proxy HLS
GET /api/hls?u=ENCODED_M3U8_URL

# Buscar
GET /api/search?q=oppenheimer
# Incluye resultados de CineCalidad vía buscarCineCalidad()

# Estadísticas
GET /api/stats
# → fuentes.cinecalidad: {total, ocultas, vistas, activas}

# Health
GET /api/health
# → ccOcultas, ccTotal
```

### Endpoints Pendientes
```bash
# Géneros (NO implementado aún)
GET /api/cccine/genres
GET /api/cccine/genre/accion

# Feed (NO implementado aún)
GET /api/cccine/feed
```

---

## 8. Archivos de Persistencia

```
cc-ocultas.txt     — slugs de títulos muertos (newline-separated)
cc-vistas.txt      — slugs verificados alguna vez
```

**Formato:**
```
oppenheimer
fundacion
dune-part-two
...
```

---

## 9. Rendimiento y Memoria

| Operación | Tiempo | Memoria |
|-----------|--------|---------|
| Índice lazy (12h) | ~3-5 min | ~2MB |
| Verificar título | ~2-5s | <1MB |
| Sonda ciclo (30) | ~2-5 min | <5MB |
| Búsqueda API | ~1-3s | <1MB |
| Proxy HLS | ~1s | Streaming |

---

## 10. Próximos Pasos

1. **Deploy v238** → CineCalidad sonda activa
2. **Esperar 24h** → Sonda construye índice + verifica títulos
3. **Revisar stats** → `/api/stats` muestra CineCalidad
4. **Implementar feed** → Géneros y populares de CineCalidad
5. **Auditoría completa** → Verificar todos los embeds

---

*Documento generado: v238 — Septiembre 2026*