# 🎬 Auditoría Cuevana.mov — 2026-09-20

## Resumen Ejecutivo

| Concepto | Cantidad |
|---|---|
| **Total en sitemap** | **8,182** |
| **Con audio latino + embeds** | **8,002 (97.8%)** |
| **Sin embeds (fantasma)** | **180 (2.2%)** |
| **Errores API** | **0** |
| **Tiempo de escaneo** | 5.0 min |

## Hosts de video (solo audio latino)

| Host | Embeds | ¿HTTP puro? | Método m3u8 |
|---|---|---|---|
| **vimeos.net** | 7,923 | ✅ | JS packed → m3u8 |
| **hlswish.com** | 7,225 | ✅ | JS packed → m3u8 |
| **goodstream.one** | 7,004 | ✅ | m3u8 directo en HTML |
| voe.sx | 7,815 | ❌ | DDoS-Guard |
| filemoon.sx | 6,179 | ❌ | Protegido |
| videoapp.zip | 7,899 | ⚠️ | Redirige a vimeos.net |
| doodstream.com | 379 | ❌ | Videos eliminados |

## Filtros aplicados

- ✅ Solo audio **LATINO** o **ESPAÑOL**
- ❌ Películas sin ningún embed → descartadas (180)
- ❌ Hosts con DDoS-Guard (voe.sx) → no verifican m3u8
- ❌ Hosts protegidos (filemoon.sx) → no verifican m3u8
- ❌ DoodStream → videos eliminados

## Cobertura de hosts funcionales

Con los 3 hosts que funcionan via HTTP puro:
- **vimeos.net**: cubre 7,923/8,002 = 99.0%
- **hlswish.com**: cubre 7,225/8,002 = 90.3%
- **goodstream.one**: cubre 7,004/8,002 = 87.5%
- **Cualquiera de los 3**: ~99.5%+

## API de Cuevana

```
# Listar películas (paginado)
GET https://cuevana.mov/wp-json/wpreact/v1/postsapi?per_page=20&page=1
→ {total_posts, total_pages, posts: [{title, slug, type:"pelicula", ...}]}

# Detalle de película (embeds incluidos)
GET https://cuevana.mov/wp-json/wpreact/v1/movie/{slug}
→ {TMDbId, titles, images, videos: {latino: [{url, lang, quality}], ...}}

# Sitemaps (9 archivos)
GET https://cuevana.mov/pelicula-sitemap{1-9}.xml
```

## Muestras de películas vivas

| Película | Hosts funcionales |
|---|---|
| Un tiempo para recordar | goodstream, hlswish, vimeos, videoapp |
| Dietro la notte | goodstream, hlswish, vimeos, videoapp |
| La Magia del Chocolate | goodstream, hlswish, vimeos, videoapp |
| Lados Opuestos | goodstream, hlswish, vimeos, videoapp |
| Ecos del Pasado | goodstream, hlswish, vimeos, videoapp |

## Muestras de películas muertas (sin embeds)

| Película | Razón |
|---|---|
| Alien³ | Sin embeds |
| El diario de Greg en Navidad | Sin embeds |
| Dejar el mundo atrás | Sin embeds |
| Suzume | Sin embeds |

## Diferencia con cine-calidad.mx

| Aspecto | Cuevana.mov | cine-calidad.mx |
|---|---|---|
| Total películas | 8,182 | ~1,200 (WP API) |
| API | wpreact/v1 (propia) | mycustom/v1 (WP) |
| Audio | Latino | Latino |
| Hosts | goodstream, vimeos, hlswish | Streamwish (bloqueado) |
| HTTP puro | ✅ | ❌ (CDN 502) |
| URL | cuevana.mov/pelicula/{id}/{slug} | cine-calidad.mx/pelicula/{slug}/ |

## Archivos generados

- `auditoria-cuevana-rapida.json` — datos completos
- `docs/AUDITORIA-CUEVANA-2026-09-20.md` — este reporte

---

*Auditoría generada el 20 Sep 2026 — 8,182 películas escaneadas en 5.0 min*