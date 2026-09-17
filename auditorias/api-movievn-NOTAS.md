# API del app "Movie" (movievn/ppcinees) — NOTAS 2026-09-15

## Qué quedó ABIERTO (verificado desde el sandbox)

### 1. API del APP (guest) — https://surfclick.vd7au6.com/api
Auth (confirmada con datos reales de la captura del amigo):
- headers: app_id: movievn, version: 40000, sys_platform: 2, device_id: 3736e27f0823b1ba (el del teléfono amigo), channel_code: **movievn_sh_1000** (¡nuevo! antes se usaba netcine), cur_time: ms, token: <de public/init>, user-agent: okhttp/4.12.0
- sign = MD5('47Q8tBqO4YqrMHf4' + device_id + cur_time).toUpperCase()
- Respuestas: base64 sin padding → AES-128-CBC key '0123456789123456' IV '2015030120123456' → JSON
- FUNCIONAN: public/init (token guest), type/get_list (Películas=1, Novela=2, …), search/screen?type_id=N (GET o POST; devuelve una primera lista de 20). La paginación no quedó resuelta: los parámetros de página probados repiten esa lista.
- BLINDADO: vod/info_new (HTTP 200 pero error chino "系统出问题啦~请稍后再试" en plano) — probado con app-id, web-id, con/without audio_type, incluso en albd.h4c5.com con app-auth. NO insistir ciegamente.

### 2. API WEB (la vitrina escc.k5ca.com) — https://albd.h4c5.com/api  ← NUEVO DESCUBRIMIENTO
Auth 100% reproducible (extraída del JS de la vitrina):
- device_id = MD5('1111111') = 7fa8282ad93047a4d6fe6111c93b308a (FIJO)
- sign = MD5('ppcineweb123' + device_id + cur_time).toUpperCase()
- headers: app_id: ppcinewebes (para escc.k5ca.com; ver mapa), channel_code: ppcinewebb_1000, version: 30006, sys_platform: 3, token: '' (vacío), app_language: es, domain: escc.k5ca.com, en_al: 1, mobmodel/sysrelease/mob_mfr: ''
- Mismo AES de respuestas.
- app_id por host: escc.k5ca.com→ppcinewebes, mecc.k5ca.com→ppcinewebes, ptbbu/ptzzu→ppcinewebpt, phbbu/phn18/phzzb→ppcinewebph, esbbu→ppcinewebes, frbbu→ppcinewebfr, idbbu/idppc/idoop/idvvu→ppcinewebid; default ppcineweb
- FUNCIONAN:
  - POST type/get_list (body vacío ok)
  - POST search/screen (body: `type_id=2`) — primera lista de 20 novelas. **Corrección 2026-09-16:** los intentos de paginar con `page`, `page_num`, `pageNo`, `page_no`, `current_page`, `offset` y `limit` repiten esos mismos 20 IDs; no equivale a un catálogo completo.
  - GET vod/info_web_get?vod_id=<WEB-ID>&audio_type=1&date=AAAAMMDDHHd → FICHA COMPLETA con vod_collection (capítulos con id, duración, is_p2p) + audio_type_option + series_info (temporadas)
  - `https://escc.k5ca.com/?channel_id=230` devuelve HTML SSR con 83 fichas actuales de Telenovela (a 2026-09-16), útil para ampliar candidatos de duración. Es una vitrina cambiante, **no** el catálogo completo.
  - date = YYYYMMDD + HH + floor(MM/10) (UTC funcionó)
- IDs: la web usa SUS PROPIOS ids (Ej: Señor de los cielos T10 web=579658, app=1898251857). El campo **pianwei** del resultado web = app-id. OJO: info_web_get con app-id da {} vacío.

### 3. Lo que sigue faltando: la URL del VIDEO
- info_web_get da vod_url = "https://www.freecine.cn/" (placeholder) en TODO. El stream real solo lo tiene vod/info_new (blindada).
- La vitrina NO tiene player: el botón play llama al nativo: window.flutter_inappwebview.callHandler("startPlaying", {is_ad, collection_id, vod_name}) → el app abre su proxy local com.pp.hls (127.0.0.1:7000) con /resource.m3u8?src=<tc.f.a(url)> + /control?msg=verify&device_id=<dev><vod_id>&ts=<ms>.
- P2P config (de public/init): backup_domain=http://147.124.216.142, tracker=47.253.51.203:7202, error_m3u8=http://3g32mtioo2qs.4j4damaqa.com/vod/fwd/index5.m3u8

### 4. LA CAPTURA DEL AMIGO (2026-09-14) — qué nos dio
- Cert MITM instalado y funcionando (se descifró el POST upgrade de surfclick.vd7au6.com).
- App arrancó, POST /api/public/upgrade OK (code 10000), player lanzó vod_id 711142488 → GET http://127.0.0.1:7000/control?msg=verify&device_id=3736e27f0823b1ba711142488&ts=… — ESA petición pasó por el proxy y se ROMPIÓ (mitmproxy no puede alcanzar el 127.0.0.1 del teléfono) → el player nunca reprodujo → no hay stream capturado.
- FIX RONDA 2: en el proxy WiFi del teléfono, campo "No usar proxy para" (bypass): 127.0.0.1,localhost → el app reproduce normal y su tráfico de API/CDN sí pasa por mitmproxy.

## Archivos
- ~/auditorias/novelas-app-catalogo.json — 240 filas históricas pero solo 20 novelas/IDs únicos repetidos (web ids + pianwei + portadas k0j5n7.com + totales de caps); no es el catálogo completo.
- ~/auditorias/movievn-web.js — script funcional de la API web (auth + search + info_web_get)
- Kit v3 del otro chat: uploads/kit-android-prestado.md (mensajes WhatsApp, FASES)

## Postes/estado en el server Oracle (129.80.212.92)
- Oyente mitmdump en 8080 con --set block_global=false (probablemente SIGUE CORRIENDO — verificar con `pgrep -af mitmdump`; apagar con `pkill -f mitmdump` cuando no se use: está abierto a extraños).
- Cert servido en http://129.80.212.92:3000/mitm.crt (quitar al cerrar: rm ~/huddle/public/mitm.crt && bash actualizar.sh)

---
# DECODE POR DECOMPILACIÓN — 2026-09-15 (tarde) — ¡GIGANTE!

## Cómo se reproduce el app (flujo COMPLETO, de jadx)
1. getSignInfo() (VideoPlayDetailActivity, classes7): arma
   `http://127.0.0.1:{AppApplication.port}/control?msg=verify&device_id={DEV}{VOD_ID}&ts={ms}`
   (DEV = device_id real, VOD_ID pegado sin separador) → la respuesta del PROXY NATIVO = **el sign**
2. VIDEOPLAYDETAILVIEWMODEL.S0(vod_id, cur_time=ts, sign=esa respuesta, audio_type) →
   **POST /api/vod/info_new** (FormUrlEncoded) con campos: vod_id, cur_time, sign, audio_type (+vi si idioma vi)
   → la RESPUESTA trae vod_collection con **vod_url REALES**
3. El player envuelve: `http://127.0.0.1:{port}/resource.m3u8?src={base64(vod_url)}` (tc.e.B, mp4 usa /resource.mp4)
   → el proxy nativo baja/descifra/sirve el stream
- OJO: si AppApplication.port <= 0 (proxy nativo muerto) NUNCA pide info_new

## Rutas completas del API (strings classes3.dex, todas POST FormUrlEncoded salvo indica)
/api/public/{init,login,register,get_sys_conf,upload_file,feedback} · /api/vod/info_new (¡la clave!) ·
/api/search/{screen,hot_search,result,suggest,recommend} · /api/type/get_list · /api/channel/{get_info,get_list} ·
/api/topic/{list,change,vod_list} · /api/user_vod/{add,get_list,remove} · /api/user/{info,update,down,my_invited,feedback_list} ·
/api/user_history/add · /api/barrage/{add,get_list} · /api/discuss/{get_list_new,remove} · /api/short_play/list ·
/api/ad/get_list · /api/log/ad · /api/order/get_list · /api/invited/{my_spread,vod_share} · /api/data/action
+ /sunshine/user/insertSuggest · /sunshine/video/showHomePageVideosForPage · /sunshine/video/getSlideVideos
Interfaz Retrofit completa: jd3/sources/qb/a.java (métodos A..l con tipos de retorno)

## Cifras halladas en el código
- fp.a = AES-128-CBC del API (key 0123456789123456, IV 2015030120123456) — ya lo usábamos
- fp.f = 3DES "desede/CBC/PKCS5Padding" key "dsawdf634eebGFHITR5UT9kS0" IV "32456738" (descifra la llave de soporte tc.e.A()="MxASAkl/yHTGg+/Tw1R7u96nGqkWsOZ2")
- getip() = IP local del WiFi (para DLNA/cast, reemplaza 127.0.0.1 en URLs al castear)

## Sign de info_new — intentos FALLIDOS (no repetir)
POST correcto: vod_id+cur_time+sign+audio_type en el body + headers normales. Prové 10 fórmulas MD5
(SECRET 47Q8tBqO4YqrMHf4, ck 92b991...291c7, hlskey 87c2...5600, con/sin vod_id, mayús/minús) → TODAS "系统出问题啦".
El sign LO CALCULA LA LIBRERÍA NATIVA (libpp_hls.so, ofuscada; config assets/pp_hlsProtected.dat cifrada, magic "qh", entropía 7.99).

## Herramientas
- jadx 1.4.7 en /tmp/jadx147 (fallback mode, -Xmx1500m; el 1.5.0 truena en fallback)
- Decompilado completo: ~/auditorias/jd{1,2,3,5,6,9,10,11,12} + jadx7 + jadx8 (classes7=UI del play, classes3=API+decryptores, classes8=viewmodels)
- APK completa re-descargable: https://o.z2v3m6.com/2a061172ea402dfd/ppcinees.apk

## Siguiente paso decidido
Ronda 3 de captura con WiFi proxy + bypass BIEN puesto (el cert YA está instalado y el okhttp del app YA se dejó descifrar en rondas 1-2 — vimos el POST upgrade). captura_ss_v3.py (commit 625104b) graba el BODY de info_new (el sign) y su RESPUESTA (las URLs). Si el cliente de contenido del app ignora el proxy → plan PCAPdroid+MITM (VPN local, atrapa todo).
