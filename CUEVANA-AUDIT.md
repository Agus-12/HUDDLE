# Cuevana.mov — Documentación Técnica Completa
## Auditoría y Resumen (v238)

---

## 1. Visión General

**URL:** `https://cuevana.mov`
**Tipo:** Catálogo de películas y series con audio latino
**Motor:** WordPress personalizado con API REST propia
**Total estimado:** ~8,182 títulos (sitemap)

---

## 2. Arquitectura del Sitemap

### Endpoint del Sitemap
```
https://cuevana.mov/sitemap.xml
```
El sitemap contiene URLs en este formato:
```xml
<loc>https://cuevana.mov/pelicula/83857/enfrentados-marfil</loc>
```

### Extracción de Slugs
```javascript
// Patrón regex para extraer slugs del sitemap
/<loc>https?:\/\/cuevana\.[a-z.]+\/pelicula\/\d+\/([^<]+)<\/loc>/g
```

### Caché del Índice
- **TTL:** 30 minutos (`CUEVANA_IDX_TTL`)
- **Almacenamiento:** En memoria (`cuevanaIdx.slugs`)
- **Total actual:** 8,182 slugs únicos

---

## 3. Flujo de Resolución de Películas

### Paso 1: Obtener Embed URLs
```
GET https://cuevana.mov/pelicula/83857/enfrentados-marfil
```
La página HTML contiene:
```html
<a class="play" data-src="BASE64_ENCODED">Play</a>
```

### Paso 2: Decodificar Data-Source (Base64)
```javascript
function decodificarDataSrc(enc) {
  const nums = Buffer.from(enc, 'base64').toString('binary')
    .trim().split(/\s+/).map(x => parseInt(x, 10));
  const crudo = nums.map(n => String.fromCharCode(n)).join('');
  return [...crudo].map(ch => 
    String.fromCharCode(ch.charCodeAt(0) - 2)
  ).join('');
}
```
**Resultado:** URL del embed (ej: `https://goodstream.one/embed-xxxxx.html`)

### Paso 3: Obtener m3u8 del Embed
```javascript
// Fetch del embed page → extraer m3u8
const html = await fetch(embedUrl).text();
const m3u8 = /file\s*[:=]\s*["'](https?:\/\/[^"']+master\.m3u8[^"']*?)["']/i.exec(html);
```

### Paso 4: Verificar m3u8
```javascript
const r = await fetch(m3u8Url);
if (r.ok && text.includes('#EXTM3U')) {
  return { m3u8, subs: [], proxy: true };
}
```

---

## 4. Hosts de Video Soportados

| Host | Tipo | Proxy | Referer |
|------|------|-------|---------|
| `goodstream.one` | HLS (m3u8) | ✅ Relay | `https://goodstream.one/` |
| `vimeos.net` | HLS (packed JS) | ✅ | `https://vimeos.net/` |
| `hlswish.com` | HLS | ✅ | `https://hlswish.com/` |
| `videoapp.zip` | HLS (redirect) | ✅ | `https://videoapp.zip/` |

---

## 5. CDN y Bloqueo de IP

### Problema Identificado
Los CDNs de video (`goodstream.one`, etc.) **bloquean IPs de datacenter**. Solo IPs residenciales pueden:
1. Obtener el embed page (genera token ligado a IP)
2. Descargar el m3u8 con token válido
3. Descargar segmentos TS

### Solución: CDN Relay via Mac Mini

**Arquitectura:**
```
[Usuario] → [Oracle Server] → [ngrok tunnel] → [Mac Mini Relay] → [CDN Video]
                                    ↑
                              IP residencial
                              (187.189.128.17)
```

**Componentes:**
1. **Mac Mini** (2014, macOS Monterey)
   - `~/relay.js` — servidor HTTP en puerto 3128
   - `ngrok http 3128` — túnel público
   
2. **Oracle Server** (129.80.212.92)
   - `CDN_RELAY` variable en server.js
   - Persiste en `/tmp/huddle-relay.txt`
   - Endpoint: `POST /api/set-relay?url=https://xxx.ngrok-free.app`

**Flujo del Relay:**
```
1. Oracle pide embed al relay: GET relay/?u=embed_url
2. Relay (Mac Mini) fetch con IP residencial
3. CDN genera token ligado a IP del Mac Mini
4. Relay devuelve m3u8 con token
5. Oracle sirve m3u8 al usuario
6. Usuario pide segmentos → Oracle pide al relay → CDN sirve
```

**Configuración actual:**
```
Relay URL: https://1382-2806-2f0-4821-fdd9-b945-83cb-1c77-b916.ngrok-free.app
Mac Mini IP: 187.189.128.17 (residencial)
ngrok: Plan Free (URL puede cambiar al reiniciar)
```

---

## 6. Proxy HLS (/api/hls)

### Flujo
```
GET /api/hls?u=ENCODED_M3U8_URL
```

### Optimización v236.6
Para CDNs bloqueados (goodstream, vimeos, etc.), el proxy va **directo por relay** sin intentar directo primero:
```javascript
if (CDN_RELAY && /goodstream|vimeos|hlswish|videoapp/i.test(hostname)) {
  useRelayDirect = true;
}
```
**Reducción de latencia:** ~10s → ~1s

### Reescritura de URLs
El proxy reescribe las URLs dentro del m3u8:
```
https://hls1.goodstream.one/hls2/.../seg-1.ts?t=TOKEN
→ /api/hls?u=https%3A%2F%2Fhls1.goodstream.one%2Fhls2%2F...%2Fseg-1.ts%3Ft%3DTOKEN
```

---

## 7. Sonda de Cuevana

### Configuración
- **Frecuencia:** Cada 6 horas
- **Arranque:** 90 segundos después del deploy
- **Por ciclo:** 15 nuevas + 15 vivas + 15 muertas

### Lógica
```javascript
async function sondaCuevana() {
  // 1. NUEVAS: sitemap no vistas → verificar embed
  // 2. VIVAS: muestra de activas → ¿siguen sirviendo?
  // 3. MUERTAS: muestra de ocultas → ¿revivieron?
  
  // Persistir en:
  // - cuevana-ocultas.txt (slugs muertos)
  // - cuevana-vistas.txt (slugs ya verificados)
}
```

### Verificación
```javascript
async function verificarCuevana(slug) {
  const r = await fetchSeguro('https://cuevana.mov/pelicula/xxx/' + slug);
  const html = await r.text();
  // Buscar data-src (embed) o links de video
  // Si no hay embed → marcar como muerto
}
```

### Estadísticas Actuales
| Métrica | Valor |
|---------|-------|
| Total en sitemap | 8,182 |
| **Ocultas (muertas)** | **181** |
| **Activas** | **8,001** |
| Vistas por sonda | 274 |

---

## 8. Filtros de Moderación

### CV_OCULTAS (Set estática)
Series muertas conocidas desde auditoría manual. Incluye:
- Series sin embeds (solo trailers de YouTube)
- Series con URLs rotas permanentemente
- ~180 series hardcodeadas

### CV_OCULTAS_RT (Runtime)
Muertas detectadas en vivo por la sonda. Se persiste en `cv-ocultas-rt.json`.

### CV_PROTEGIDAS
Series que NO se pueden ocultar automáticamente (ej: series populares que pueden estar temporalmente caídas).

### EPS_MUERTOS
Episodios individuales marcados como muertos (no series completas).

---

## 9. Búsqueda de Cuevana

### Endpoint
```javascript
async function buscarCuevanaMov(q) {
  const slugs = await cuevanaIndice(); // 8,182 slugs
  // Filtrar por tokens de query
  // Score: posición del match en el slug
  return matches.slice(0, 20);
}
```

### Búsqueda Cuevana.mov (v235)
```javascript
async function buscarCuevanaMov(q) {
  // API de búsqueda de cuevana.mov
  const r = await fetch('https://cuevana.mov/api/search?q=' + q);
  // Retorna películas con URLs de cuevana.mov
}
```

---

## 10. Géneros y Feed

### Géneros Disponibles
Cuevana tiene páginas de género accesibles via:
```
https://cuevana.mov/genero/accion
https://cuevana.mov/genero/comedia
// etc.
```

### Feed (Home)
El feed de Cuevana se cachea y se muestra en la home de Huddle. Incluye:
- Películas populares
- Estrenos recientes
- Series del momento

---

## 11. Subtítulos

Cuevana a veces incluye subtítulos embebidos en el m3u8:
```m3u8
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Spanish",
URI="/api/hls?u=https://.../subs/es.vtt"
```

El proxy reescribe las URIs de subtítulos igual que los segmentos de video.

---

## 12. Errores Conocidos y Soluciones

| Error | Causa | Solución |
|-------|-------|----------|
| 403 en m3u8 | Token ligado a IP de datacenter | Usar relay (Mac Mini) |
| `fetchRelay` falla | ngrok caído o URL cambió | Verificar ngrok en Mac Mini |
| Sonda no avanza | Memoria > 350MB | Guardián GC reinicia |
| Series sin embed | Contenido removido del CDN | Sonda las oculta automáticamente |
| `enc7` 403 | Nodo CDN bloquea | Proxy reintenta con `hls1` |

---

## 13. Comandos de Verificación

```bash
# Verificar Cuevana funciona
curl -s "http://ORACLE:3000/api/solo?name=USER&tok=TOKEN&url=https://cuevana.mov/pelicula/83857/enfrentados-marfil"

# Verificar proxy HLS
curl -s "http://ORACLE:3000/api/hls?u=ENCODED_M3U8" | head -5

# Verificar relay
curl -s "https://NGROK_URL/health"

# Verificar estado de Cuevana
curl -s "http://ORACLE:3000/api/stats" | python3 -c "import sys,json; print(json.load(sys.stdin)['fuentes']['cuevana'])"

# Ver sonda Cuevana
grep "sonda.*cv" /var/log/syslog | tail -5
```

---

## 14. Datos Técnicos

### Variables de Entorno Relevantes
```
CDN_RELAY = "https://xxx.ngrok-free.app"
CUEVANA_IDX_TTL = 1800000 (30 min)
CUEVANA_API = "https://cuevana.mov/api/"
```

### Archivos de Persistencia
```
cuevana-ocultas.txt    — slugs muertos (Set → newline-separated)
cuevana-vistas.txt     — slugs verificados alguna vez
cv-ocultas-rt.json     — muertas en runtime (JSON array)
/tmp/huddle-relay.txt  — URL del relay (persiste reinicios)
```

### Memoria Estimada
- Índice Cuevana: ~2MB (8,182 slugs en memoria)
- Cache de embeds: Variable (se limpia con GC)
- Proxy: Streaming (no acumula en memoria)

---

*Documento generado: v238 — Septiembre 2026*