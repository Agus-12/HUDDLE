# Auditoría Cuevana — Huddle v266

**Fecha:** 2026-09-21T19:29:58.611Z
**Método:** directo primero sin relay, single-use no-verify, prioriza vimeos>goodstream, FETCH_UA + Referer embed
**Total sitemap:** 8183
**Auditadas:** 8183
**Resuelven en Huddle:** 7895 (96.48%)
**No resuelven:** 288 (sin latino 116, api 64, sin m3u8 108)
**Tiempo:** 336.5s con 20 concurrentes

## Por host que resolvió
- vimeos: 7864 (99.6%)
- goodstream: 19 (0.2%)
- hlswish: 12 (0.2%)

## Samples OK
- dietro-la-notte → vimeos
- muerte-y-vida-de-un-activista-politico → vimeos
- radical → vimeos
- ecos-del-pasado → vimeos
- cunados → vimeos
- cazadores-en-tierra-inhospita → vimeos
- lados-opuestos → vimeos
- a-royal-recipe-for-love → vimeos
- los-viajeros → vimeos
- el-gran-fraude → vimeos
- jedine-tereza → vimeos
- los-segundones → vimeos
- un-tiempo-para-recordar → vimeos
- la-piscina → vimeos
- la-magia-del-chocolate → vimeos
- una-flor-en-el-barro → vimeos
- los-secretos-no-se-pueden-enterrar → vimeos
- senora-influencer → vimeos
- remando-como-un-solo-hombre → vimeos
- la-unica-salida → vimeos

## Fails sample
- la-version-persa: sin_m3u8
- fuera-de-la-ley: sin_m3u8
- vive-dentro: sin_m3u8
- gracias-lo-siento: sin_m3u8
- alien%c2%b3: api_404
- el-diario-de-greg-en-navidad-atrapados-en-la-nieve: sin_latino
- dejar-el-mundo-atras: sin_latino
- mi-querido-monstruo: sin_latino
- silber-y-el-libro-de-los-suenos: sin_latino
- la-tipica-navidad: sin_latino
- %d0%bc%d1%80%d0%b0%d0%ba: api_404
- suzume: sin_latino
- de-grote-slijmfilm: sin_m3u8
- el-conejo-de-terciopelo: sin_m3u8
- %e7%99%92%e3%81%97%e3%81%ae%e3%81%93%e3%81%93%e3%82%8d%e3%81%bf%ef%bd%9e%e8%87%aa%e5%88%86%e3%82%92%e5%a5%bd%e3%81%8d%e3%81%ab%e3%81%aa%e3%82%8b%e6%96%b9%e6%b3%95%ef%bd%9e: api_404
- you-hurt-my-feelings: sin_m3u8
- wwe-fastlane-2023: sin_m3u8
- la-clave-del-corazon: sin_m3u8
- el-curandero: sin_m3u8
- %e5%86%99%e7%9c%9f%e3%81%ae%e5%a5%b3: api_404
- cincuenta-tartas-para-jane: sin_m3u8
- starship-troopers-invasion: sin_latino
- no-tengas-miedo: sin_m3u8
- el-grito-silencioso-el-caso-roe-v-wade: sin_m3u8
- un-extrano-entre-nosotras: sin_m3u8
- extincion: sin_m3u8
- el-hotel-de-los-lios-garcia-y-garcia-2: sin_m3u8
- %d0%b2%d0%bd%d0%b5-%d0%b7%d0%be%d0%bd%d1%8b-%d0%b4%d0%be%d1%81%d1%82%d1%83%d0%bf%d0%b0: api_404
- secretos-de-espias: sin_m3u8
- una-buena-persona: sin_latino

## Notas
- Antes v264-v265 goodstream se consumía al verificar master (single-use) → 410. Ahora no se verifica, el HLS proxy lo sirve.
- Relay lhr.life ignorado para embeds (lento >0.8s). Directo primero.
- Prioriza vimeos/hlswish (estable) sobre goodstream (colgado/timeout) → gorilas documentales ya resuelven.
