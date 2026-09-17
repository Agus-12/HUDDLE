# Resumen para el chat principal — Huddle / Movie / PCAP

**Fecha de cierre de esta tanda:** 16 de septiembre de 2026  
**Commit publicado:** `09bd6b5 Movie: map confirmed PCAP sequences`  
**Branch:** `main`  
**Repositorio:** `https://github.com/Agus-12/HUDDLE`

> Este resumen omite deliberadamente PAT, tokens, credenciales, device IDs, secretos y URLs tokenizadas.

---

## 1. Estado de GitHub y seguridad

- El commit `09bd6b5` fue probado y enviado correctamente a `main`.
- El repositorio aparece actualmente como **público** en GitHub (`private: false`), aunque se creía privado.
- Por esa razón no se subieron el PCAP, reportes crudos, cachés temporales, mapas con rutas reales, cuerpos M3U8, segmentos, tokens ni credenciales.
- Aunque el repositorio llegue a ser privado, **nunca** se deben subir PAT, tokens, contraseñas ni secretos.
- El PCAP pesa aproximadamente 636.6 MiB y GitHub normal rechaza archivos mayores de 100 MiB. Si algún día se respalda, usar almacenamiento privado/cifrado o Git LFS, nunca Git normal público.

Sí quedaron publicados los hallazgos, las conclusiones, la herramienta reproducible, las huellas de evidencia y `CONTINUACION.md` actualizado.

---

## 2. Objetivo y resultado final

Se usó el **PCAP histórico existente**, el orden temporal de las rutas y las duraciones `EXTINF` de los M3U8 para identificar rutas Movie **sin nueva captura y sin nuevas descargas de CDN**.

```text
39 rutas Movie totales
38 manifests M3U8 históricos recuperados del PCAP
38 rutas identificadas individualmente con evidencia fuerte
1 ruta sin asignación individual por falta de manifest recuperable
5 rutas latinas disponibles en la comprobación actual
1 ruta disponible pero excluida por audio tailandés
```

No pedir otra captura para resolver esta tanda.

---

## 3. Método de evidencia aprobado

1. `ordenar-pcap-movie.js` recuperó las 39 rutas Movie y su orden cronológico.
2. `cosechar-pcap-movie.js` reconstruyó las respuestas HTTP/M3U8 ya presentes en el PCAP:
   - no volvió a descargar video;
   - no guardó tokens;
   - obtuvo estado histórico, duración y número de segmentos.
3. Se comparó cada grupo por fecha y orden contra secuencias completas de duraciones obtenidas de fichas públicas Movie.
4. Una asignación se acepta solo si:
   - la ruta tiene su propio manifest histórico;
   - la duración coincide con su posición de la secuencia;
   - todas las rutas con manifest del grupo coinciden;
   - la diferencia individual es menor o igual a 1 segundo;
   - hay al menos cuatro coincidencias.

No se acepta una asignación solo por una duración parecida, por fecha de carpeta o por fecha de portada.

---

# 4. Mapa confirmado de rutas

## A. *Lo que la vida me robó* — Temporada 1

- Movie web ID: `296157`
- Movie app ID: `550018978`
- Grupo de carpeta: `2024/07/25`
- Evidencia: **10/10 coincidencias**
- Error absoluto total: **0.930 s**
- Audio: **latino inequívoco**; telenovela mexicana originalmente en español.
- Actualmente disponibles: E9, E13, E17 y E19.

| Carpeta | Episodio |
|---|---:|
| `eb69103239f8` | T1E1 |
| `699c80acd8d3` | T1E3 |
| `8053bf51bcbf` | T1E5 |
| `b9efa011cf4b` | T1E7 |
| `9b381610790b` | T1E9 — activa |
| `e5155bb16f3f` | T1E11 |
| `ef3e876fda94` | T1E13 — activa |
| `7b599aebf15a` | T1E15 |
| `20ea83bef4b6` | T1E17 — activa |
| `ef5235ef6b86` | T1E19 — activa |

## B. *Soy tu dueña* — Temporada 1

- Movie web ID: `194467`
- Movie app ID: `1262348233`
- Grupo de carpeta: `2024/02/28`
- Evidencia: **10/10 coincidencias**
- Error absoluto total: **0.920 s**
- Audio: **latino inequívoco**; telenovela mexicana originalmente en español.
- Actualmente disponible: E5.

| Carpeta | Episodio |
|---|---:|
| `710ba1b664e9` | T1E1 |
| `3d53a1b4c03c` | T1E3 |
| `6cc422af11b8` | T1E5 — activa |
| `f58e70fda7c3` | T1E7 |
| `fbccf219c0ec` | T1E9 |
| `7553c1eb3e28` | T1E11 |
| `4ed8465524d1` | T1E13 |
| `0ae0768af1cf` | T1E15 |
| `a2d633cf86f4` | T1E17 |
| `2a3023ef70d0` | T1E19 |

## C. *La usurpadora* — Temporada 1

- Movie web ID: `455144`
- Movie app ID: `1377486448`
- Grupo de carpeta: `2025/06/12`
- Evidencia: **9 coincidencias con manifest propio**
- Error absoluto total: **2.895 s**
- Audio: **latino inequívoco**; telenovela mexicana originalmente en español.
- Actualmente ninguna de estas rutas respondió en la comprobación actual.

| Carpeta | Episodio |
|---|---:|
| `829b1064e7d5` | T1E1 |
| `f921208fa147` | T1E3 |
| `d4a5371a3636` | T1E7 |
| `2391f53ffc00` | T1E9 |
| `c60bf582f579` | T1E11 |
| `e8bdd6e5ebac` | T1E13 |
| `ec054425f9c7` | T1E15 |
| `2b59c01c5fee` | T1E17 |
| `9d46ae8dfa6b` | T1E19 |

### Única ruta sin asignación individual

```text
feec4d1e85fe
```

- Está en el grupo temporal de *La usurpadora*.
- No tuvo respuesta HTTP/M3U8 recuperable en el PCAP.
- **No se le asignó título individual, episodio, duración ni estado histórico.**
- No debe llamarse E5 aunque esté situada entre E3 y E7.

## D. *Marimar* — Temporada 1

- Movie web ID: `214998`
- Movie app ID: `1665377628`
- Grupo de carpeta: `2024/03/27`
- Evidencia: **4/4 coincidencias**
- Error absoluto total: **1.173 s**
- Audio: **latino inequívoco**; telenovela mexicana originalmente en español.
- Actualmente todas responden 403, pero eso no invalida la identificación histórica.

| Carpeta | Episodio |
|---|---:|
| `079225bb63c9` | T1E1 |
| `7309d77f41e6` | T1E3 |
| `c7b2623fb373` | T1E5 |
| `347ceef5a2a6` | T1E7 |

## E. *Amar y Cuidar* — Temporada 1

- Movie web ID: `594285`
- Movie app ID: `2049688168`
- Grupo de carpeta: `2026/09/16`
- Evidencia: **5/5 coincidencias**
- Error absoluto total: **1.400 s**
- Identificación: alta confianza.
- **NO INTEGRAR.**

| Carpeta | Episodio |
|---|---:|
| `fb5b1ca540a1` | T1E1 — activa, pero excluida |
| `6bc6858930e5` | T1E3 |
| `cc5f84c1564b` | T1E5 |
| `d888735dd54e` | T1E7 |
| `3ef6df82f48f` | T1E9 |

### Motivo de exclusión

Se inspeccionó el primer TS accesible de esta secuencia:

- la pista de audio estaba marcada como `tha`;
- la apertura y tarjetas eran tailandesas;
- subtítulos españoles no equivalen a audio latino.

Aunque T1E1 responde actualmente, no se integra porque el requisito permanente es audio latino.

---

## 5. Rutas que sí pueden integrarse ahora

Solo estas cinco rutas quedaron latinas y activas en la comprobación actual:

```text
Soy tu dueña — T1E5
Lo que la vida me robó — T1E9
Lo que la vida me robó — T1E13
Lo que la vida me robó — T1E17
Lo que la vida me robó — T1E19
```

Las demás rutas pueden conservarse en el mapa histórico, pero un `403` actual debe mostrarse como no disponible. No se borra la identificación histórica ni se inventa otra URL.

---

## 6. Archivos nuevos ya publicados

### `mapear-secuencias-movie.js`

Genera el mapa local únicamente desde el reporte local del PCAP:

```bash
cd ~/huddle || exit 1
node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json
cat ~/movie-mapa-secuencias.txt
```

Características:

- no consulta CDN;
- no descarga video;
- conserva el orden de las rutas;
- contrasta contra huellas aprobadas;
- no infiere episodio si una ruta no tiene manifest propio;
- genera:

```text
~/movie-mapa-secuencias.json
~/movie-mapa-secuencias.txt
```

### `auditorias/huellas-secuencias-movie.json`

Contiene:

- títulos y temporadas;
- IDs Movie web y app;
- portadas alojadas por Movie;
- secuencias de duración;
- error de evidencia;
- decisión de audio;
- excepción de *La usurpadora* sin episodio inferido.

No contiene rutas, tokens ni secretos.

### `.gitignore`

Protege estos resultados locales:

```text
movie-mapa-secuencias.json
movie-mapa-secuencias.txt
movie-mapa-local.json
movie-cosecha-pcap.json
movie-cosecha-pcap.txt
```

### `CONTINUACION.md`

Ya fue actualizado con los resultados, el método, restricciones, límites y siguientes pasos.

---

## 7. Hallazgos y dead ends: no repetir

- No pedir otra captura para estas 39 rutas.
- No consultar repetidamente rutas 403 para intentar identificarlas; la disponibilidad actual no elimina la evidencia histórica.
- No asignar `feec4d1e85fe` como E5 ni como ningún episodio.
- No integrar *Amar y Cuidar*.
- No identificar una ruta solo por fecha de carpeta HLS ni fecha de portada.
- No aceptar coincidencias parciales de *Guardián de mi vida*, *Tres Caínes*, *Café con aroma de mujer* o *Que así sea*.
- El catálogo actual de la vitrina Movie no contiene todos los títulos históricos:
  - *Marimar* se recuperó mediante el rango histórico de IDs `210000..220000`;
  - *La usurpadora* se recuperó mediante el rango histórico `450000..460000`.
- Las respuestas de la vitrina Movie no paginan bien con los parámetros probados; no tratar los catálogos de filas repetidas como un catálogo completo.
- `Amar y Cuidar` queda excluida por evidencia directa de audio tailandés, no por falta de coincidencia.

---

## 8. Restricciones permanentes del proyecto

1. Integrar contenido únicamente con audio latino; hacer ASR si hay duda.
2. No usar navegador remoto para reproducir.
3. Huddle debe mantener HTTP puro; nada de HTTPS/certificados locales.
4. Mantener tres pestañas, sala automática y continuar-viendo separado por pestaña.
5. Continuar-viendo debe incluir póster y fallback `/carita.png`.
6. Usar solo portadas alojadas por la fuente Movie.
7. No subir PAT, tokens, contraseñas ni secretos, incluso si el repo se vuelve privado.
8. Tras cada avance real: actualizar `CONTINUACION.md`, hacer commit y push a `main`.
9. No volver a capturar ni descargar CDN para resolver la presente tanda.

---

## 9. Siguiente paso recomendado

Después de actualizar Oracle:

```bash
cd ~/huddle || exit 1
bash actualizar.sh
node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json
cat ~/movie-mapa-secuencias.txt
```

Después, si se implementa Movie dentro de Huddle:

- integrar únicamente las cinco rutas latinas activas indicadas arriba;
- leer siempre el mapa local generado;
- usar reproductor HLS nativo y allowlist estricta del origen;
- no exponer un proxy abierto;
- conservar portadas Movie y fallback `/carita.png`;
- no integrar *Amar y Cuidar* ni la ruta sin manifest.

---

## 10. Pruebas hechas antes del commit

Se probó `mapear-secuencias-movie.js` con un fixture local equivalente a la captura:

```text
39 rutas de entrada
38 manifests históricos
5 grupos confirmados
38 rutas asignadas
1 ruta sin asignar
5 rutas latino reproducibles ahora
5 rutas excluidas por audio
```

También se comprobó:

- sintaxis de Node correcta;
- JSON de huellas válido;
- E5 no aparece asignado en *La usurpadora*;
- *Amar y Cuidar* no queda marcada como integrable;
- resultados locales ignorados por Git;
- árbol Git limpio después del push.
