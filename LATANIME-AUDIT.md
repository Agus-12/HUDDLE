# Latanime — Auditoría Completa
## Fecha: 21 septiembre 2026 | Huddle v239.13

---

## 1. Resumen Ejecutivo

| Métrica | Cantidad | % |
|---------|----------|---|
| **Total catálogo** | 3,453 | 100% |
| **Visibles en Huddle** | 1,527 | 44% |
| **Ocultas (cast/dup)** | 558 | 16% |
| **Muertas (video caído)** | 1,368 | 39% |
| **Total fuera** | 1,926 | 55% |

---

## 2. Fuente

| Campo | Valor |
|-------|-------|
| **URL** | latanime.org |
| **Tipo** | Series de anime |
| **Audio** | Latino (prioridad), Castellano, Subtitulado |
| **Player** | mp4upload (principal), otros |
| **Caché** | Archivos locales (latanime-slugs.txt) |
| **Sonda** | ❌ Sin sonda dedicada (usa podredumbre general) |

---

## 3. Regla de Audio (Prioridad)

```
1. LATINO     → Se muestra en Huddle ✅
2. CASTELLANO → Se muestra SOLO si no hay versión latina
3. SUBTITULADO → Se muestra si no hay ni latina ni castellana
4. DUPLICADO  → Si existe "slug" Y "slug-latino", se oculta "slug" y se muestra "slug-latino"
```

---

## 4. Desglose de Visibles (1,527)

| Categoría | Cantidad | Descripción |
|-----------|----------|-------------|
| **Versión latino** | 847 | Series con sufijo `-latino` (audio latino confirmado) |
| **Normales** | 680 | Series sin sufijo (latino por defecto de latanime) |
| **Total visible** | **1,527** | Se muestran en el buscador y catálogo de Huddle |

### Pares base + latino
- **158 pares** encontrados (existe `slug` y `slug-latino`)
- **119** tienen solo la versión latina visible
- **39** tienen ambas fuera (muertas)
- **0** tienen ambas visibles (correcto: ocultamos la base)

---

## 5. Desglose de Ocultas (558)

| Categoría | Cantidad | Descripción |
|-----------|----------|-------------|
| **Castellano explícito** | 400 | Slugs con `-castellano` en el nombre |
| **Duplicados** | 158 | Versión base que tiene contraparte `-latino` |
| **Total ocultas** | **558** | No se muestran en Huddle |

### Castellano con versión latina
- **326** de los400 castellanos tienen versión latina (se oculta castellano)
- **74** castellanos NO tienen versión latina (podrían mostrarse si no hay otra opción)

---

## 6. Desglose de Muertas (1,368)

| Categoría | Cantidad | Descripción |
|-----------|----------|-------------|
| **Normales** | 937 | Series sin sufijo especial, video caído |
| **Versión latino** | 316 | Series `-latino` con video caído |
| **Castellano** | 115 | Series `-castellano` con video caído |
| **Total muertas** | **1,368** | mp4upload eliminó el archivo |

### Sistema de autocuración (podredumbre)
- Las muertas se re-chequean cada 6 horas
- Si reviven (mp4upload vuelve a servir), se muestran otra vez
- 3 fallos espaciados ≥10 min → se oculta automáticamente

---

## 7. Flujo de Verificación

```javascript
async function laProbe(slug) {
  // 1. Fetch https://latanime.org/ver/{slug}-episodio-1/
  // 2. Buscar links con class="play-video" data-player="BASE64"
  // 3. Decodificar base64 → buscar URLs mp4upload
  // 4. Fetch embed mp4upload → buscar player.src()
  // 5. Verificar video responde (Range: bytes=0-1024)
  // 6. Si "file was deleted" → muerto
  // 7. Si sirve → vivo
}
```

---

## 8. Archivos de Persistencia

```
~/huddle/public/latanime-slugs.txt    — 3,452 slugs (catálogo completo)
~/huddle/public/latanime-ocultas.txt  — 558 slugs (castellano + duplicados)
~/huddle/public/latanime-muertas.txt  — 1,368 slugs (video caído)
~/huddle/data/la-fallos.json          — contadores de fallos por slug
```

---

## 9. Mapa de Reemplazos (Danimados)

Algunas series nuestras están rotas pero Danimados las tiene bien. El slug nuestro redirige a Danimados:

| Slug nuestro | Slug Danimados |
|-------------|----------------|
| dani-titanes | teen-titans-go |
| bob-esponja-capitulos-completos | bob-esponja |
| hora-de-aventura-capitulos-completos | hora-de-aventuras |
| los-simpsons | los-simpson |
| rick-y-morty-capitulos-completos | rick-y-morty |
| ... | (48 reemplazos en total) |

---

## 10. Series Ocultas Internas (Nuestras)

Estas series nuestras se ocultan porque Danimados las tiene mejor:

```
agallas-el-perro-cobarde, el-laboratorio-de-dexter, invasor-zim,
johnny-bravo, las-chicas-superpoderosas, los-padrinos-magicos,
mucha-lucha, oye-arnold, rocket-power, time-squad, vaca-y-pollo
```

---

## 11. Duplicados Internos (Lacartoons + MisCaricaturas)

```
johnny-bravo, chicas-superpoderosas, rocket-power, mucha-lucha,
invasor-zim, vaca-y-pollito, la-pantera-rosa, un-show-mas
```

---

## 12. Cobertura vs Total

| Métrica | Valor |
|---------|-------|
| Total Latanime | 3,453 |
| Visible en Huddle | 1,527 (44%) |
| Muertas (no disponible) | 1,368 (39%) |
| Ocultas (cast/dup) | 558 (16%) |
| Potencialmente recuperables | ~74 castellanos sin versión latina |

---

## 13. Comandos de Verificación

```bash
# Verificar un slug específico
curl -s "https://latanime.org/ver/{slug}-episodio-1/" | grep -c "play-video"

# Contar visibles
comm -23 <(sort /tmp/la-slugs.txt) <(sort /tmp/la-ocultas.txt /tmp/la-muertas.txt | sort -u) | wc -l

# Ver estado de podredumbre
curl -s "http://129.80.212.92:3000/api/estado" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Muertas:', d['moderacion']['animesMuertos'])"
```

---

## 14. Recomendaciones

1. **Sonda dedicada:** Latanime NO tiene sonda propia (usa podredumbre general). Considerar agregar una como CineCalidad/PelisXD.

2. **Castellanos sin latino:** Hay74 series castellanas sin versión latina. Si no hay otra opción, podrían mostrarse con aviso "Audio: Castellano".

3. **Muertas recuperables:** De las1,368 muertas, algunas pueden revivir si mp4upload restaura los archivos. El sistema de podredumbre las re-chequea cada6h.

4. **Pares sin resolver:**39 pares (base + latino) tienen ambas versiones fuera. Si alguna revive, mostrar la latina.

---

*Documento generado: v239.13 — 21 septiembre 2026*

---

## Nota v287 (22 sep 2026) — podredumbre de episodios
- El mp4upload NO es el único player: los eps traen 7-8 players (filemoon, ok.ru,
  mixdrop, doodstream, yourupload, wolfstream, mp4upload, mega…).
- **Regla de muerte de EPISODIO (v287, estricta):** un ep solo se declara muerto si
  su página da 404, o tiene 0 players, o TODOS los players son MEGA / mp4uploads con
  "file was deleted". Si queda CUALQUIER otro player, se deja vivo (el navegador del
  servidor puede sacarlo) y si el usuario falla al reproducirlo, el fallo se cuenta
  igual (v287: Juntos también cuenta).
- `epsPodredumbre()` muestrea 6 series (las más vistas) × 3 eps cada 6 h; los eps
  muertos salen del picker solos (3 fallos espaciados → `EPS_MUERTOS`), y los
  ocultos se re-prueban para revivirlos (hasta 10/ciclo).
- Los contadores (`fallos-eps.json`, `eps-muertos.json`) ahora sobreviven a deploys.
