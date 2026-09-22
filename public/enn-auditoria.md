# Auditoría HTTP de Ennovelas

- Catálogo descubierto: **360 series** en 9 páginas de Ennovelas.
- Series con al menos un reproductor HLS funcional: **47**.
- Series muertas, sin episodios reproducibles o con VIP/paywall: **313**, ocultas de Huddle.
- Episodios revisados dentro de las 47 series vivas: **4.566**.
- Episodios HLS funcionales: **4.405**; episodios ocultos: **161**.
- Método: HTTP-only, sin navegador, iframe, Puppeteer ni reproductor remoto: ficha → capítulo → embed → VK → master HLS → variante → primer segmento.
- Gratis únicamente: se descartaron resultados VIP/paywall/Danfra.
- Ejecutada: 2026-09-22 (UTC).

Archivos persistentes:

- `enn-funcionan.json`: auditoría serie por serie.
- `enn-vistas.txt`: allowlist visible.
- `enn-ocultas.txt`: series fuera de Huddle hasta que una sonda confirme que revivieron.
- `enn-episodios.json`: auditoría capítulo por capítulo de las series vivas.
- `enn-episodios-vistas.txt` y `enn-episodios-ocultos.txt`: estado persistente de cada capítulo.

La sonda del servidor repite comprobaciones HTTP/HLS, oculta una serie tras fallos consecutivos y puede rehabilitar series o episodios únicamente después de confirmar de nuevo su HLS.
