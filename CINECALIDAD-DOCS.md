# CineCalidad — Documentación Técnica Completa
## Auditoría y Estado Actual (v239)

---

## 1. Resumen Ejecutivo

| Métrica | CineCalidad | Cuevana | PelisXD |
|---------|-------------|---------|---------|
| **URL** | cine-calidad.mx | cuevana.mov | pelisxd.com |
| **Total API** | ~10,950 | ~8,182 | ~4,703 |
| **Películas** | ~8,500 | ~6,500 | ~4,703 |
| **Series** | ~2,450 | ~1,682 | 0 |
| **Audio** | Latino ✅ | Latino ✅ | Latino ✅ |
| **Embeds** | goodstream/vimeos | goodstream/vimeos | Propio (Byse) |
| **Proxy** | ✅ Relay | ✅ Relay | ❌ Directo |
| **Sonda** | ✅ v239 | ✅ v234 | ✅ v234 |
| **Catálogo full** | ✅ v239 | ✅ | ✅ |

---

## 2. API de CineCalidad

### Endpoints
```
Películas: GET https://cine-calidad.mx/wp-json/mycustom/v1/movies?page=N
Series:    GET https://cine-calidad.mx/wp-json/mycustom/v1/series?page=N
Búsqueda:  GET https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=QUERY&page=N
```

### Paginación
- 20 items por página
- ~548 páginas de películas (10,950 total)
- Respuesta: array directo de objetos

### Objeto de respuesta
```json
{
  "title": "Oppenheimer (2023)",
  "slug": "oppenheimer",
  "type": "movies",
  "featured_image": "https://image.tmdb.org/t/p/w780/...",
  "rating": "7.8",
  "year": "2023",
  "duration": "181 min"
}
```

---

## 3. URLs de Contenido

```
Películas:  https://cine-calidad.mx/pelicula/{slug}/
Series:     https://cine-calidad.mx/serie/{slug}/
Episodios:  https://cine-calidad.mx/episode/{slug-1x1}/
```

---

## 4. Embeds (data-src)

### Estructura HTML
```html
<a href="#" class="link onlinelink play" 
   data-src="BASE64_ENCODED_URL" 
   data-domain="goodstream">
   goodstream
</a>
```

### Hosts disponibles
| Host | Tipo | Proxy necesario |
|------|------|----------------|
| goodstream.one | HLS (m3u8) | ✅ Relay |
| vimeos.net | HLS packed JS | ✅ Relay |
| hlswish.com | HLS | ✅ Relay |
| voe | MP4 | ❌ |
| filemoon | MP4 | ❌ |

### Verificación (muestra 40 pelis + 30 series)
- **Películas:** 87% con embed (35/40)
- **Series:** 97% con embed en episodios (29/30)
- **Total estimado:** ~9,775 activos de ~10,950

---

## 5. Catálogo Completo (v239)

### Implementación
```javascript
async function catCvFull(kind) {
  // Pre-fetch TODAS las páginas (max 600)
  // Cache 2h
  // Background download 30s after startup
}
```

### Caché
- **cvFullCache.movies** — todas las películas
- **cvFullCache.series** — todas las series
- **TTL:** 2 horas
- **Descarga:** 30 segundos después del arranque

### Resultado esperado
| Tipo | Antes (v238) | Después (v239) |
|------|-------------|----------------|
| Películas | 749 | **~8,500** |
| Series | 995 | **~2,450** |
| Total | 1,744 | **~10,950** |

---

## 6. Sonda CineCalidad (v239)

### Configuración
- **Frecuencia:** Cada 6 horas
- **Arranque:** 90 segundos después del deploy
- **Por ciclo:** 10 nuevas + 10 vivas + 10 muertas

### Datos
```javascript
const CC_VISTAS = new Set();   // slugs verificados
const CC_OCULTAS = new Set();  // slugs muertos
```

### Persistencia
```
cc-ocultas.txt — slugs muertos (newline-separated)
cc-vistas.txt  — slugs verificados alguna vez
```

### Verificación
```javascript
async function verificarCC(slug, tipo) {
  // Fetch page → check for data-domain="goodstream|vimeos|..."
  return { ok: hasEmbed };
}
```

---

## 7. Panel de Estado (v239)

### Acceso
```
URL: http://129.80.212.92:3000/api/intros
Auth: Admin / Samuelito8
```

### Secciones
1. **Encendido + Memoria + Salas + Usuarios**
2. **Fuentes de video** — Cuevana, PelisXD, CineCalidad con barras
3. **Usuarios** — lista con botón eliminar
4. **Cosecha Movie** — progreso del catálogo 37k
5. **Rastreador de intros** — progreso
6. **Moderación** — ocultos por fuente
7. **Catálogos vivos** — conteos
8. **Intros aprendidas** — tabla

### Endpoints
```
GET /api/estado   — datos del panel (JSON)
GET /api/stats    — estadísticas por fuente
GET /api/users    — lista de usuarios
DELETE /api/users — eliminar usuario
```

---

## 8. Búsqueda (v237+)

### Endpoint
```
GET /api/search?q=QUERY
```

### Fuentes incluidas
1. Cartoons (Lacartoons)
2. Cuevana (cuevana.mov)
3. Cuevana Mov (v235)
4. PelisXD
5. Latanime
6. AnimeFLV
7. Caricaturas
8. **CineCalidad** (v237)
9. Novelasearch
10. Movie Cosecha (37k)

### CineCalidad en búsqueda
```javascript
async function buscarCineCalidad(q) {
  // API search → slug + type → URL
  // _apiFresh: true (bypass cvOcultaUrl)
}
```

---

## 9. Resolver CineCalidad

### Flujo
```
1. URL: https://cine-calidad.mx/pelicula/oppenheimer/
2. Fetch page → find data-src + data-domain
3. Decode base64 → embed URL
4. Fetch embed → extract m3u8
5. Verify m3u8 → return
```

### Series
```
1. URL: https://cine-calidad.mx/serie/fundacion/
2. Find episode links: /episode/fundacion-1x1/
3. Fetch episode → data-src + data-domain
4. Decode → embed → m3u8
```

---

## 10. Comparativa Huddle vs CineCalidad

### Antes de v239
| Métrica | Huddle | CineCalidad | % |
|---------|--------|-------------|---|
| Películas | 749 | ~8,500 | 8.8% |
| Series | 995 | ~2,450 | 40.6% |
| Total | 1,744 | ~10,950 | 15.9% |

### Después de v239
| Métrica | Huddle | CineCalidad | % |
|---------|--------|-------------|---|
| Películas | ~8,500 | ~8,500 | **100%** |
| Series | ~2,450 | ~2,450 | **100%** |
| Total | ~10,950 | ~10,950 | **100%** |

---

## 11. Archivos de Persistencia

```
cc-ocultas.txt     — slugs muertos
cc-vistas.txt      — slugs verificados
cuevana-ocultas.txt — Cuevana muertas
cuevana-vistas.txt  — Cuevana vistas
pxd-ocultas.txt    — PelisXD muertas
/tmp/huddle-relay.txt — URL relay
```

---

## 12. Comandos de Verificación

```bash
# Verificar CineCalidad funciona
curl -s "http://ORACLE:3000/api/solo?name=USER&tok=TOK&url=https://cine-calidad.mx/pelicula/oppenheimer/"

# Ver catálogo
curl -s "http://ORACLE:3000/api/catalogo/pelis?pag=1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['items']))"
curl -s "http://ORACLE:3000/api/catalogo/series?pag=1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['items']))"

# Ver estadísticas
curl -s "http://ORACLE:3000/api/stats" | python3 -c "import sys,json; print(json.load(sys.stdin)['fuentes']['cinecalidad'])"

# Ver sonda
grep "sonda.*cc" /var/log/syslog | tail -5
```

---

*Documento actualizado: v239 — Septiembre 2026*