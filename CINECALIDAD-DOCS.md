# CineCalidad — Documentación Técnica Completa
## Última actualización: v239.12 (21 sept 2026)

---

## 1. Resumen Ejecutivo

| Métrica | CineCalidad | Cuevana | PelisXD |
|---------|-------------|---------|---------|
| **URL** | cine-calidad.mx | cuevana.mov | pelisxd.com |
| **Total conocido** | 10,950 | 8,200 | 4,700 |
| **Películas** | ~8,500 | ~6,500 | 4,700 |
| **Series** | ~2,450 | ~1,682 | 0 |
| **Audio** | Latino ✅ | Latino ✅ | Latino ✅ |
| **Embeds** | goodstream/vimeos | goodstream/vimeos | Propio (Byse) |
| **Proxy** | ✅ Relay Mac Mini | ✅ Relay | ❌ Directo |
| **Sonda** | ✅ v239 | ✅ v235 | ✅ v234 |
| **Ocultas** | 65 | 180 | 2,174 |
| **Activas** | 10,885 | 8,020 | 2,526 |

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
- ~548 páginas de películas (~10,950 total)
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

### Decodificación
```javascript
function decodificarDataSrc(html) {
  const re = /data-src="([A-Za-z0-9+/=]{24,})"/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const url = Buffer.from(m[1], 'base64').toString('utf8');
      if (/^https?:\/\//i.test(url)) return url;
    } catch {}
  }
  return null;
}
```

### Hosts disponibles
| Host | Tipo | Proxy necesario |
|------|------|----------------|
| goodstream.one | HLS (m3u8) | ✅ Relay |
| vimeos.net | HLS packed JS | ✅ Relay |
| hlswish.com | HLS | ✅ Relay |
| videoapp.zip | HLS | ✅ Relay |
| voe | MP4 | ❌ |
| filemoon | MP4 | ❌ |

### Verificación de contenido vivo
- **Películas:** verificar presencia de `data-domain` en página
- **Series:** verificar episodios INDIVIDUALMENTE (no la serie completa)
- Si un episodio muere → se oculta ESE episodio, la serie sigue

---

## 5. Catálogo Completo

### Implementación (catCvFull)
```javascript
async function catCvFull(kind) {
  // kind = 'movies' | 'series'
  // Pre-fetch TODAS las páginas (max 600)
  // Cache 2h en cvFullCache
  // Background download 30s después del arranque
}
```

### Caché
- **cvFullCache.movies** — todas las películas
- **cvFullCache.series** — todas las series
- **TTL:** 2 horas
- **Descarga:** 30 segundos después del arranque

### Números
| Tipo | Cantidad |
|------|----------|
| Películas | ~8,500 |
| Series | ~2,450 |
| Total | ~10,950 |

---

## 6. Sonda CineCalidad (v239)

### Configuración
- **Frecuencia:** Cada 6 horas
- **Arranque:** 90 segundos después del deploy
- **Por ciclo:** 10 nuevas + 10 vivas + 10 muertas

### Tres frentes
1. **NUEVAS:** slugs del catálogo no verificados → verificar si tienen embed
2. **VIVAS:** muestra de activas → ¿siguen funcionando?
3. **MUERTAS:** muestra de ocultas → ¿revivieron?

### Datos en memoria
```javascript
const CC_VISTAS = new Set();   // slugs verificados alguna vez
const CC_OCULTAS = new Set();  // slugs muertos (verificados sin embed)
const CC_AUDIT_DEAD = new Set([...]); // 15 slugs de auditoría inicial
```

### Persistencia
```
~/huddle/cc-ocultas.txt  — slugs muertos (newline-separated)
~/huddle/cc-vistas.txt   — slugs verificados alguna vez
```

### Verificación
```javascript
async function verificarCC(slug, tipo) {
  // tipo = 'movies' | 'series'
  // Para películas: fetch /pelicula/{slug}/ → buscar data-domain
  // Para series: fetch /episode/{slug}-1x1/ → buscar data-domain
  // (verifica episodios individuales, NO la serie completa)
  return { ok: hasEmbed };
}
```

---

## 7. Dead Content Verificado

### CineCalidad (72 ocultas)
- 15 de auditoría manual inicial (CC_AUDIT_DEAD)
- 57 detectadas por sonda automática
- Confirmadas: HTTP 200 pero sin `data-domain` embeds

### PelisXD (2,174 ocultas)
- Filtro Byse: slugs sin `v_source` Byse → ocultadas
- Confirmadas: no tienen reproductor funcional

### Cuevana (180 ocultas)
- HTTP 404 en la API de cuevana.mov
- Confirmadas: páginas no existen

---

## 8. Panel de Estado (SPA)

### Acceso
```
URL: http://129.80.212.92:3000/api/intros
Auth: Cookie huddle_admin=ok (set via ?pass=Samuelito8)
Archivo: /public/panel.html
```

### Navegación SPA
- **Dashboard** — Encendido, Memoria, Salas, Usuarios (click → página usuarios)
- **Catálogo total** — siempre visible
- **Fuentes de video** — tarjetas con gráfica (click → detalle con sonda)
- **Rastreador de intros** — colapsable (mostrar/ocultar)
- **Usuarios** — con circulitos de estado

### Estado de usuarios
| Color | Significado |
|-------|-------------|
| 🟢 Verde | En sala O viendo en Solo (progreso <5min) |
| 🟡 Amarillo | Inactivo <2 semanas |
| 🔴 Rojo | Inactivo >3 semanas |

### Endpoints del panel
```
GET  /api/estado   — datos completos (JSON)
GET  /api/stats    — estadísticas por fuente
GET  /api/users    — lista de usuarios con online status
DELETE /api/users  — eliminar usuario
GET  /panel.html   — archivo del panel (requiere cookie)
```

### Reloj
- Arriba a la derecha en el navbar
- Se actualiza cada segundo
- Sensación de "en vivo"

---

## 9. Totales Conocidos (hardcoded en /api/stats)

```javascript
const CV_KNOWN_TOTAL = 8200;    // sitemap cuevana.mov
const PXD_KNOWN_TOTAL = 4700;   // sitemap pelisxd.com
const CC_KNOWN_TOTAL = 10950;   // catálogo completo cine-calidad.mx
```

### Fórmula
```
activas = total_conocido - ocultas
```

La sonda solo actualiza `ocultas` cuando detecta cambios.

---

## 10. Búsqueda

### Endpoint
```
GET /api/search?q=QUERY
```

### CineCalidad en búsqueda
```javascript
async function buscarCineCalidad(q) {
  // API search → slug + type → URL
  // Retorna: { title, url, img, site: 'CineCalidad', extra }
  // _apiFresh: true (bypass cvOcultaUrl)
}
```

---

## 11. Resolver CineCalidad

### Flujo Película
```
1. URL: https://cine-calidad.mx/pelicula/oppenheimer/
2. Fetch page HTML
3. Buscar data-src + data-domain
4. Decodificar base64 → embed URL
5. Fetch embed → extraer m3u8
6. Verificar m3u8 → retornar
```

### Flujo Serie
```
1. URL: https://cine-calidad.mx/serie/fundacion/
2. Buscar episodios: /episode/fundacion-1x1/
3. Fetch episodio → data-src + data-domain
4. Decodificar → embed → m3u8
```

### En sala (nativo)
```javascript
async function resolverNativo(url) {
  if (/cine-calidad\.mx/.test(url)) return resolverCineCalidad(url);
  // ...
}
```

---

## 12. CDN Relay (Mac Mini)

### Configuración
```
Mac Mini 2014 — IP residencial: 187.189.128.17
Relay server: ~/HUDDLE/macmini-relay.js
Persistencia: /tmp/huddle-relay.txt
```

### Uso
```
GET /api/set-relay?url=http://187.189.128.17:3456
```

### Hosts que usan relay
- goodstream.one / goodstream.uno
- vimeos.net / vimeos.zip
- hlswish.com
- videoapp.zip

---

## 13. Archivos de Persistencia

```
~/huddle/cc-ocultas.txt        — CineCalidad muertos
~/huddle/cc-vistas.txt         — CineCalidad verificados
~/huddle/cuevana-ocultas.txt   — Cuevana muertas
~/huddle/cuevana-vistas.txt    — Cuevana vistas
~/huddle/public/pxd-ocultas.txt — PelisXD muertas
~/huddle/public/pxd-vistas.txt  — PelisXD vistas
/tmp/huddle-relay.txt          — URL del relay Mac Mini
~/huddle/data/users.json       — usuarios registrados
~/huddle/data/continue.json    — continuar viendo
~/huddle/data/vistos.json      — episodios vistos
~/huddle/data/intro-crawl.json — estado del rastreador
~/huddle/data/cv-ocultas-rt.json — Cuevana ocultas en vivo
~/huddle/data/fallos-*.json    — contadores de fallos
```

---

## 14. Comandos de Verificación

```bash
# Health check
curl -s http://129.80.212.92:3000/api/health

# Stats por fuente
curl -s http://129.80.212.92:3000/api/stats

# Verificar CineCalidad funciona
curl -s "http://129.80.212.92:3000/api/solo?name=USER&tok=TOK&url=https://cine-calidad.mx/pelicula/oppenheimer/"

# Ver catálogo
curl -s "http://129.80.212.92:3000/api/catalogo/pelis?pag=1"
curl -s "http://129.80.212.92:3000/api/catalogo/series?pag=1"

# Deploy
cd ~/huddle && bash actualizar.sh
# O manual:
cd ~/huddle && git fetch origin main && git reset --hard origin/main && sudo systemctl restart huddle
```

---

## 15. Changelog

### v239.12 (21 sept 2026)
- Panel SPA con navegación
- Usuarios: detección real de actividad (sala + Solo)
- Reloj en vivo en navbar
- Totales conocidos hardcoded en /api/stats

### v239.9
- Stats con datos reales (no índices vacíos)

### v239.5
- Panel como archivo externo (/public/panel.html)
- Cookie auth en vez de Basic auth

### v239
- CineCalidad sonda activa
- catCvFull: ~10,950 títulos
- verificarCC: revisa episodios individualmente
- 15 dead slugs de auditoría inicial

### v237.1
- Búsqueda CineCalidad fix ("fundacion")

### v236.8
- CDN relay fallback
- Guardián de memoria (GC >300MB)

---

*Documento actualizado: v239.12 — 21 septiembre 2026*
