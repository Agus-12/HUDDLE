# 📋 Documentación Técnica — Cuevana en Huddle

**Última actualización:** 20 Sep 2026  
**Versión:** v234+ (pendiente integración)  
**Fuente:** https://cuevana.mov/  
**Tipo:** WordPress con API REST personalizada (wpreact/v1)

---

## 1. Resumen Ejecutivo

Cuevana.mov es una fuente de películas y series con **8,182 películas** en su sitemap. De estas, **8,002 (97.8%)** tienen embeds con audio latino. Tres hosts funcionan via HTTP puro: **goodstream.one**, **vimeos.net**, y **hlswish.com**.

### Números clave
| Concepto | Cantidad |
|---|---|
| Total en sitemap | 8,182 |
| Con audio latino | 8,002 (97.8%) |
| Sin embeds | 180 (2.2%) |
| Hosts HTTP funcionales | 3 (goodstream, vimeos, hlswish) |
| Cobertura mínima | 99.5%+ |

---

## 2. API de Cuevana

### 2.1 Endpoints principales

```
# Listar películas (paginado, 20 por página)
GET /wp-json/wpreact/v1/postsapi?per_page=20&page=1
→ {total_posts: 9321, total_pages: 466, posts: [{title, slug, type:"pelicula"}]}

# Detalle de película
GET /wp-json/wpreact/v1/movie/{slug}
→ {TMDbId, titles: {name, original}, images: {poster, backdrop}, videos: {latino, spanish, english, subtitled}}

# Series
GET /wp-json/wpreact/v1/series
GET /wp-json/wpreact/v1/serie/{slug}

# Búsqueda
GET /wp-json/wpreact/v1/search?query={q}

# Sitemaps (9 archivos de películas)
GET /pelicula-sitemap.xml    → 1000 películas
GET /pelicula-sitemap2.xml   → 1000 películas
...
GET /pelicula-sitemap9.xml   → 182 películas
```

### 2.2 Estructura de la respuesta de película

```json
{
  "TMDbId": 19995,
  "titles": {
    "name": "Avatar",
    "original": {"name": "Avatar"}
  },
  "images": {
    "poster": "https://image.tmdb.org/t/p/w300/...",
    "backdrop": "https://image.tmdb.org/t/p/original/..."
  },
  "overview": "Año 2154...",
  "runtime": "161",
  "genres": [{"name": "Acción", "slug": "accion"}],
  "videos": {
    "latino": [
      {"url": "https://goodstream.one/embed-xxx.html", "lang": "latino", "quality": "Full HD"},
      {"url": "https://vimeos.net/embed-xxx.html", "lang": "latino", "quality": "Full HD"},
      {"url": "https://hlswish.com/e/xxx", "lang": "latino", "quality": "Full HD"},
      {"url": "https://voe.sx/e/xxx", "lang": "latino", "quality": "Full HD"},
      {"url": "https://filemoon.sx/e/xxx", "lang": "latino", "quality": "Full HD"}
    ],
    "spanish": [],
    "english": [],
    "subtitled": []
  }
}
```

---

## 3. Resolución de Video (HTTP puro)

### 3.1 Prioridad de hosts

```
1. goodstream.one  → m3u8 directo en HTML (más rápido)
2. vimeos.net      → JS packed desempacable (1080p)
3. hlswish.com     → JS packed desempacable (1080p)
```

### 3.2 goodstream.one — m3u8 directo

```javascript
// El HTML del embed contiene directamente:
// file: "https://enc8.goodstream.one/hls2/.../master.m3u8?t=..."
const m = /file\s*[:=]\s*["'](https?:\/\/[^"']+master\.m3u8[^"']*?)["']/i.exec(html);
// → m[1] es la URL del m3u8 listo para usar
```

### 3.3 vimeos.net / hlswish.com — JS packed

```javascript
// El HTML contiene eval(function(p,a,c,k,e,d){...}('ENCODED',base,count,'KEYS'.split('|')))
// Desempacar con el algoritmo estándar p,a,c,k,e,d
// El resultado contiene: sources:[{file:"https://s14.vimeos.net/hls2/.../master.m3u8?..."}]

const packed = /eval\(function\(p,a,c,k,e,d\)\{.+?\}\('(.+?)',(\d+),(\d+),'([^']*)'\.split/.exec(html);
// p = packed string, a = base, c = count, k = keywords array
// Desempacar: para i de c-1 a 0, reemplazar toString(i, a) por k[i]
```

### 3.4 Verificación del m3u8

```javascript
// Después de extraer la URL, verificar que sirve:
const r = await fetch(m3u8Url, {headers: {'Referer': embedUrl}});
const text = await r.text();
// Debe contener: #EXTM3U
// Opcionalmente contiene múltiples calidades: 480p, 720p, 1080p
```

---

## 4. Estructura URL

| Tipo | Patrón | Ejemplo |
|---|---|---|
| Película | `/pelicula/{tmdb_id}/{slug}` | `/pelicula/19995/avatar` |
| Serie | `/serie/{tmdb_id}/{slug}` | `/serie/1835/kenan-kel` |
| Género | `/genero/{slug}` | `/genero/accion` |
| API movie | `/wp-json/wpreact/v1/movie/{slug}` | `/wp-json/wpreact/v1/movie/avatar` |

---

## 5. Sitemaps

9 archivos XML con 1,000 URLs cada uno (último: 182):

| Sitemap | URLs |
|---|---|
| pelicula-sitemap.xml | 1,000 |
| pelicula-sitemap2.xml | 1,000 |
| ... | ... |
| pelicula-sitemap9.xml | 182 |
| **Total** | **8,182** |

Formato de cada URL:
```xml
<loc>https://cuevana.re/pelicula/{id}/{slug}/</loc>
<lastmod>2026-09-19T19:26:22+00:00</lastmod>
```

---

## 6. Historial de Cambios

### 20 Sep 2026 — Auditoría inicial
- Escaneo completo de 8,182 películas
- 97.8% con audio latino verificado
- 3 hosts funcionando via HTTP puro
- Separación de cuevana.mov vs cine-calidad.mx

---

*Documentación generada el 20 Sep 2026*