# 🏆 HALLAZGOS CDN — 16 sep 2026 — EL VÍDEO ESTÁ ABIERTO

## EL DESCUBRIMIENTO (de las capturas PCAPdroid del amigo + análisis)

**El servidor de respaldo sirve TODO sin token:**
```
http://147.124.216.142/vod/1/2026/09/11/9db1ede34113/index5.m3u8   → 200 SIN TOKEN
http://147.124.216.142/vod/1/2026/09/11/9db1ede34113/0000.ts      → 200 SIN TOKEN (3.2MB MPEG-TS real, sync 0x47 ✓)
```
- 147.124.216.142 = backup_domain del p2p_config = agent.maqbc.com por detrás de CloudFront
- La nube principal (movievn.j5t2n.com) SÍ exige wsSecret/wsTime; el origen por IP NO
- Los .ts son **MPEG-TS plano SIN cifrar** (nada de AES ni la librería nativa)

## Estructura de carpetas del CDN
`/vod/1/{YYYY}/{MM}/{DD}/{id-12-hex}/{NNNN}.ts` + `index5.m3u8`
- El "1" es fijo (0,2,3,5 = 403). Solo existe index5.m3u8 (index0-10 = 403 salvo el 5)
- index5.m3u8 lista segmentos RELATIVOS `0000.ts?sz={bytes}&m8={primeros16delETag}` (sz = tamaño exacto, m8 = checksum ETag de S3)
- Una carpeta ≈ 2 episodios: la nuestra tiene 183 .ts (0091 = fin del ep1, 0182 = fin del ep2)
- El id-12-hex (ej 9db1ede34113) es ALEATORIO del CMS (no es md5/sha1 de ningún id público — probado contra web-ep-id, web-vod-id, app-vod-id, combinaciones)
- S3 NO lista (403 con ?list-type=2, ?prefix=, ?delimiter=)

## El m3u8 capturado (episodio de prueba)
- ~/auditorias/m3u8-capturado-señor-cielos.m3u8 — 100 entradas, 2387.135s = 39:47, 92 segmentos (0000-0091)
- ~/auditorias/seg0.ts — segmento verificado (3,248,640 bytes, TS válido)
- Candidatos por duración (39:47): T2-ep46 (id 1445955, 2389s), T5-ep46 (1446989, 2381s), T8-ep49 (3795755, 2393s), T8-ep53 (3795765, 2386s)

## Tokens wsSecret/wsTime (de las fotos OCR de PCAPdroid)
- URL con token: `...index5.m3u8?wsSecret=101d6a4246d4fe7f260245d75de9d1d5&wsTime=6aaa532c`
- wsTime = unix-tiempo HEX de la petición (6aaa532c = 2026-09-16 08:28:28 UTC, la hora exacta del fetch)
- El token FUNCIONA desde otra IP (probado desde el sandbox, 79+ min después de emitido) — no amarrado al device
- Fórmula: PROBÉ 13 plantillas MD5 × 14 llaves conocidas (hls key, ck, SECRET, AES, 3DES, device...) contra 3 muestras → NINGUNA. La llave es del lado servidor (o escondida en libpp_hls.so ofuscada)
- Los .ts en la nube principal llevan token POR SEGMENTO (mintea la lib nativa); en el origen pelado no hace falta nada

## Lo que sigue faltando (ÚNICO bloqueo)
**El id-12-hex de carpeta por episodio/título.** Solo sale del POST /api/vod/info_new (sign nativo de libpp_hls.so imposible de falsificar hasta ahora). Ni el API web (info_web_get da vod_url="https://www.freecine.cn/" placeholder) ni endpoints viejos (todos "error1") lo dan.

## Plan A — Cosecha con PCAPdroid (SIN MITM ya sirve parcial)
Cuando el app reproduce, pide el m3u8 al CDN **por HTTP plano (puerto 80)** → la URL completa con carpeta sale en PCAPdroid (Conexión → detalle → URL). El amigo reproduce y captura pantallas/PCAP. 1 carpeta ≈ 2 episodios.
Mejor aún con el addon MITM de PCAPdroid (F-Droid): descifra la respuesta de info_new → TODOS los vod_url del título de una vez.

## Plan B — Revertir libpp_hls.so (automatización total)
La lib tiene TODOS los strings cifrados (ni "m3u8" aparece en claro). OLLVM o similar. Días en Ghidra. Extra: el header "Badci: c433b213c8398954d54f59210283c0" (32hex) que manda la lib al CDN — no necesario para el origen pelado.

## Verificaciones cruzadas
- movievn.j5t2n.com (CloudFront 13.226.x/13.249.x) = API imágenes + m3u8/segmentos (con token)
- j5t2n SIN token → 403; 147.124.216.142 SIN token → 200 (¡el bypass!)
- El P2P (UDP 7100/7102 + tracker 47.253.51.203:7202) es solo aceleración — innecesario
- Duraciones info_web_get (vod_duration) sirven para identificar episodios de una carpeta
