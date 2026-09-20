# 🔑 LLAVE CDN — RESUELTO (20 sep 2026)

## RESULTADO: NO SE NECESITA wsSecret

El espejo `147.124.216.142` sirve TODO el contenido de video SIN firma.

## Fórmula completa (probada y funcionando):

1. **Token:** POST `https://surfclick.vd7au6.com/api/public/init`
   - Body: `device_id=CUALQUIERA&channel_code=movievn_sh_1000`
   - Header sign: `MD5("47Q8tBqO4YqrMHf4" + device_id + timestamp_ms).upper()`
   - Header: `content-type: application/x-www-form-urlencoded` (CLAVE)
   - Respuesta: AES-128-CBC (key=0123456789123456, iv=2015030120123456) → token

2. **Info video:** POST `https://surfclick.vd7au6.com/api/vod/info_new`
   - Body: `vod_id=ID&cur_time=MS&sign=MD5("Zox882LYjEn4Rqpa"+device_id+vod_id+ms).upper()&audio_type=0`
   - Respuesta cifrada → `result.vod_collection[].vod_url`

3. **Ver video:** Cambiar dominio:
   - Original: `http://movievn.j5t2n.com/vod/.../index5.m3u8` → 403
   - Espejo: `http://147.124.216.142/vod/.../index5.m3u8` → **200 OK SIN FIRMA**

## Pruebas realizadas:
- 4/4 videos probados en espejo → todos 200 OK
- Segmentos .ts → 200 OK (MPEG-TS válido, sync 0x47)
- Video 2026 nuevo → funciona
- Video 2023 viejo → funciona
- Original j5t2n sin wsSecret → 403 (confirmado que SÍ pide firma)

## Datos técnicos:
- API real: `surfclick.vd7au6.com` (NO j5t2n, ese es solo CDN)
- AES key: `0123456789123456` / IV: `2015030120123456`
- Device encrypt key: `Zox882LYjEn4Rqpa`
- Header sign key: `47Q8tBqO4YqrMHf4`
- app_id: `movievn`, version: `40000`, channel: `movievn_sh_1000`
- Espejo abierto: `147.124.216.142` (sin auth, sin wsSecret, sin m8)
