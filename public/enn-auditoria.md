# Ficha técnica y auditoría HTTP de Ennovelas

## Auditoría de disponibilidad

- Catálogo descubierto: **360 series** en 9 páginas de Ennovelas.
- Series con al menos un reproductor HLS funcional: **47**.
- Series muertas, sin episodios reproducibles o con VIP/paywall: **313**, ocultas de Huddle.
- Episodios revisados dentro de las 47 series vivas: **4.566**.
- Episodios HLS funcionales: **4.405**; episodios ocultos: **161**.
- Gratis únicamente: se descartaron resultados VIP/paywall/Danfra.

## Implementación técnica

- Extracción **HTTP-only**: catálogo → ficha → capítulo → embed HTTP de Ennovelas → VK `video_ext.php` → endpoint `al_video.php` → master HLS → variante → primer segmento.
- No se usa navegador, Puppeteer, iframe montado ni reproductor remoto para Ennovelas.
- La reproducción pasa por el resolver existente y `/api/hls`.
- La sonda persistente revisa progresivamente series visibles, ocultas y novedades; una serie o episodio solo vuelve después de confirmar HLS de nuevo.
- VIP, paywall, Danfra y placeholders de YouTube no entran a la allowlist.

## Portadas y temporadas

- Las tarjetas del feed y las entradas de Continuar viendo usan portadas de **IMDb** descargadas a `public/covers/enn/imdb/`.
- `public/enn-series-grupos.json` conserva la ficha técnica de agrupación y la referencia IMDb de cada familia.
- Ennovelas publica temporadas como tarjetas independientes; Huddle las unifica en una sola tarjeta y devuelve los episodios con `temporada` para reutilizar la barra de temporadas del selector.
- Familias actualmente unificadas: **El capo**, **El Señor de los Cielos**, **Enfermeras**, **La Doña**, **La reina del flow**, **La Reina del Sur**, **Pasión de gavilanes** y **Señora Acero**.
- Las temporadas que no pasaron la auditoría permanecen fuera del selector hasta que la sonda las rehabilite.
- Betty conserva además `public/covers/enn/yo-soy-betty-la-fea.jpg` como fallback canónico si IMDb no responde.

## Archivos persistentes

- `enn-funcionan.json`: auditoría serie por serie.
- `enn-vistas.txt`: allowlist visible.
- `enn-ocultas.txt`: series fuera de Huddle hasta que una sonda confirme que revivieron.
- `enn-episodios.json`: auditoría capítulo por capítulo.
- `enn-episodios-vistas.txt` y `enn-episodios-ocultos.txt`: estado persistente de cada capítulo.
- `enn-series-grupos.json`: agrupación de temporadas y metadatos IMDb.
- `covers/enn/imdb/`: copias locales de las portadas de serie obtenidas de IMDb.
- `scripts/auditar-ennovelas-http.py`: auditoría de series.
- `scripts/auditar-ennovelas-episodios-http.py`: auditoría capítulo por capítulo.
- `scripts/generar-enn-series-imdb.py`: regeneración de grupos y portadas IMDb.

- Ejecutada: 2026-09-22 (UTC).
