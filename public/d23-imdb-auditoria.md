# AnimeD23 — auditoría de portadas IMDb

- Slugs AnimeD23 revisados: **229**.
- Portadas encontradas y descargadas desde IMDb: **204**.
- Portadas sin coincidencia IMDb: **25**; permanecen con la portada válida de AnimeD23 o el fallback existente de AniList cuando la página no entregó imagen.
- Las portadas IMDb quedaron en `public/covers/d23/imdb/`.
- El mapa técnico completo está en `public/d23-imdb-covers.json`.
- El feed `d23Latest()` prefiere la copia local de IMDb cuando existe; no depende de un CDN externo para esas tarjetas.
- No se modificaron las URLs, episodios, resolutores ni la auditoría de reproducción de AnimeD23.
- Script reproducible: `scripts/generar-d23-imdb.py`.
- Fuente: páginas HTTP de AnimeD23 y API pública de sugerencias/medios de IMDb.
- Ejecutada: 2026-09-22 (UTC).
