# AVANCES — HUDDLE + MOVIE (19 SEP 2026 NOCHE)

## 19 sep noche — Catálogo real y llave (v227+)

### Catálogo — de 485 a 4,300 y subiendo
- **Método nuevo que sí rinde:** `POST /api/vod/info_new` secuencial `vod_id 1000→70000` con `sign = MD5("Zox882LYjEn4Rqpa"+device_id+vod_id+cur_time).upper()` + cabecera `sign = MD5("47Q8tBqO4YqrMHf4"+device_id+cur_time).upper()` y `content-type`. Reanudable (checkpoint cada 100), ~3.7 títulos/s.
- **4,300 títulos** cosechados en la tarde (2,637 → 4,300 en 7 min con 1,600 nuevos). Visible en `http://129.80.212.92:3000/api/intros` y en `129.80.212.92:3000/api/movie/espejos` (espejo 147.124.216.142 con 3/4 rutas 200).
- Histórico: 441 por `channel/get_info`, 485 por `search/screen` (género×área con `psize=20`, `is_random=1`) — ambos techos superados. Script viejo `cosechar-generos.py` queda como referencia; el vivo es secuencial.
- Server v227 expone `llaveCdn` y `espejoPreferido` en `/api/estado` y chip Llave CDN + Espejo en `/api/intros`.

### Reproducción — por qué se ve a pedacitos
- **Hallazgo del usuario (ad-gating):** al abrir cada episodio nuevo la app pide **ver un anuncio**; ese anuncio genera el `wsSecret/wsTime` para ese episodio. Sin anuncio, `vod_url` solo da lo en caché del espejo → `Hit from cloudfront` vs `FunctionGeneratedResponse` (147.124.216.142 devuelve 206 parcial o 403). Medición: `65328ba10998` completo si firmado, parcial si no; `4acbae6998e7` 24.7% sin firma. No es hueco de anuncio, es falta de firma.
- Espejo rota con el tiempo (21/30 ayer → 403 hoy en algunas carpetas).

### Llave CDN Wangsu — 162M pruebas y Vía A
- **Barrido exhaustivo en `pphls_inflado.bin` (3,391,425 B):** `barrido_llave.c` probó **162,787,488** ventanas (largos 16/8/24/32 ×12 formas) contra muestra real `9db1ede34113` (6aaa532c/101d6a42…) → **0 match**. Prueba `ck=92b991df...` en binario/hex/mitades/MD5 contra 8 muestras ×3 formas → 0. Textos del SDK (45k) ×6 muestras ×3 rutas ×13 formas → 0. Conclusión: llave no está en claro como substring.
- **SHOK ya descartado:** `AES-128-CBC 0123456789...`, `iv=header[-16:]`, H=45/29 → `p2p_config` con `ck` y `backup_domain`; no trae llave CDN.
- **Emulador Vía A:** `emu_hls.py` + `instrumentar-interprete.py --vivo` ejecutan `JNI_OnLoad 0xe7c34` (862 opcodes, intérprete `0xeff80–0xf2300` con 2,272 instr, plantillas `0x27f311/0x27f319: wsSecret=%s&wsTime=%x`) y `ffi_call 0xf5088/0xf4764`. `GetEnv 0x10004 → 0x0` (espera 0x10006) → no `RegisterNatives`. Queda: patch Host VFILE para `base.apk` 55M + hook heap escritura `/vod/` para volcar `llave+ruta+wsTime` y validar con oráculo frío `4acbae6998e7/0010.ts` (200=buena).

### Qué sigue
1. Seguir cosecha hasta 70k (no bloquea).
2. Vía A: capturar buffer firmado en intérprete → MD5 → oráculo.
3. Con llave, firmar en Huddle `wsSecret=MD5(llave+ruta+wsTimeHex)&wsTime=hex(now)` y verificar 3 puntos por título.

*PID cosecha vivo: 150964, log `/tmp/cosecha.log`, oráculo 129.80.212.92 v227.*
