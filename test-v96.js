/* E2E v96: CURA DEL PÓSTER EN EL SERVIDOR — las entradas viejas de
 * episodios (y las re-guardadas al retomar/avanzar en la cadena)
 * traían el still de la escena: el servidor las sanea al guardar Y al
 * leer (continuar-viendo muestra el póster de la serie ya mismo) +
 * todo v95→v81. */
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const RUN = String(Date.now()).slice(-4);
const NOMBRE_A = 'Ana' + RUN, NOMBRE_M = 'Mobi' + RUN;
const PELI = 'https://cine-calidad.mx/pelicula/mayday/'; /* goodstream (viva 2026-09-08) */
const PELI_LOCAL = '/test-media/master.m3u8'; /* fixture HLS propio — determinista */
const SERIE = 'peaky-blinders'; /* para probar picker→episodio en solo */
const ANIME = 'https://latanime.org/ver/bleach-sennen-kessen-hen-s4-latino-episodio-1'; /* mp4upload (viva 2026-09-09) */
const PELI_SIN_GOODSTREAM = 'https://cine-calidad.mx/pelicula/equipaje-de-mano/'; /* vimeos (viva 2026-09-09) */
const EVA_MUERTA = 'https://latanime.org/ver/neon-genesis-evangelion-castellano-episodio-1'; /* mp4upload borrado, mega muerto (2026-09-09) */
const EVA_VIVA = 'https://latanime.org/ver/evangelion-30th-anniversary-special-episodio-1'; /* mp4upload vivo (2026-09-09) */
const CONCLAVE = 'https://cine-calidad.mx/pelicula/conclave/'; /* goodstream que racionaba el cuerpo (2026-09-09) */
const FUNDACION = 'https://cine-calidad.mx/episode/fundacion-1x1/'; /* serie goodstream con audio en/ES (2026-09-09) */
const EPS_PRUEBA = ['1x1', '1x2', '1x3', '1x4'].map((ep) => ({ url: PELI_LOCAL, ep }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) fallos++; };

(async () => {
  /* ---------- 0) estáticos v81-v84 ---------- */
  console.log('— Código v81→v84 —');
  const idx = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/style.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');
  const srv = fs.readFileSync('server.js', 'utf8');
  ok(srv.includes("const UI_VERSION = 'v96'"), 'servidor en v96');
  ok(js.includes("const APP_VERSION = 'v96'"), 'cliente en v96');
  ok(idx.includes('id="verBadge">v96'), 'badge v96');
  ok(idx.includes('/app.js?v=96') && idx.includes('/style.css?v=96'), 'cache-busters v96');
  /* hls.js vendored */
  const hlsStat = fs.statSync('public/hls.min.js');
  const hlsSrc = fs.readFileSync('public/hls.min.js', 'utf8');
  ok(hlsStat.size > 300000, `hls.js vendored (${(hlsStat.size / 1024).toFixed(0)} KB)`);
  ok(/1\.5\.17/.test(hlsSrc), 'hls.js 1.5.17');
  /* HTML del reproductor */
  ok(idx.includes('id="modoTabs"') && idx.includes('id="tabSalas"') && idx.includes('id="tabJuntos"') && idx.includes('id="tabSolo"'), 'HTML: pestañas Salas / Juntos / Solo');
  ok(idx.includes('id="salasSec"') && idx.includes('id="tabSalasBody"') && idx.includes('id="joinCode"') && idx.includes('id="btnJoin"'), 'HTML: sección de salas + entrar con código');
  ok(!idx.includes('id="btnCreate"'), 'HTML: sin botón "Crear sala" (la sala nace al elegir)');
  ok(!/👥|🎬/.test(idx), 'HTML: pestañas sin emojis');
  ok(idx.includes('id="soloPlayer"') && idx.includes('id="soloVideo"') && idx.includes('id="soloBack"') && idx.includes('id="soloBar"') && idx.includes('id="soloCC"') && idx.includes('id="soloFs"') && idx.includes('id="soloPlay"'), 'HTML: reproductor individual completo');
  /* JS base */
  ok(js.includes("localStorage.getItem('huddle_tab')") && js.includes('function setTab') && js.includes('function pintarTabs'), 'JS: pestaña activa persistida (localStorage)');
  ok(js.includes('TAB_TEXTOS') && js.includes("'¿Qué vas a ver hoy?'") && js.includes('sin ningún compañero'), 'JS: títulos por pestaña (Solo pregunta en singular)');
  ok(js.includes("? 'solo' : 'juntos'"), 'JS: migración desde el toggle viejo (huddle_modo_solo)');
  ok(js.includes("'salas'") && js.includes('tab-salas'), 'JS: la pestaña Salas reacomoda el inicio');
  ok(js.includes('async function abrirSolo') && js.includes('function montarSolo') && js.includes('function cerrarSolo'), 'JS: abrir/montar/cerrar el reproductor');
  ok(js.includes("'/hls.min.js'") && js.includes('window.Hls.isSupported()'), 'JS: hls.js vendored con HLS nativo de respaldo');
  ok(js.includes("'/api/progress'") && js.includes("modo: 'solo'"), 'JS: reporta el progreso (modo solo)');
  ok(js.includes("e.modo === 'solo'") && js.includes('startAt: reanudar ? t : 0'), 'JS: Continuar reanuda en el reproductor individual');
  /* v82 */
  ok(idx.includes('id="soloTop"'), 'HTML: barra de arriba con id');
  ok(js.includes("SOLO.lastT = video.currentTime"), 'JS: se recuerda el minuto por si reconecta');
  ok(js.includes('const reSeek') && js.includes('const reT = SOLO.seekHecho ? Math.max(SOLO.lastT || 0, SOLO.tReconexion || 0)'), 'JS: al reconectar vuelve a su minuto');
  /* v83 */
  ok(idx.includes('id="soloQ"') && idx.includes('id="soloQMenu"') && idx.includes('id="soloFlash"'), 'HTML: botón de calidad, menú y destello');
  ok(js.includes('v.currentTime - 10') && js.includes('v.currentTime + 10') && js.includes('soloFlashSeek(-10)'), 'JS: doble toque a los lados = ±10s');
  ok(js.includes('MANIFEST_PARSED') && js.includes('pintarQMenuSolo') && js.includes('hls.nextLevel = it.i'), 'JS: menú de calidad con los niveles de hls.js');
  ok(css.includes('.solo-qmenu') && css.includes('.solo-qitem') && css.includes('.solo-flash'), 'CSS: menú de calidad + destello');
  /* v84 — HTML */
  ok(idx.includes('id="soloRate"') && idx.includes('id="soloRateMenu"'), 'HTML: botón y menú de velocidad');
  ok(idx.includes('id="soloNext"'), 'HTML: botón "Sig. ▸"');
  ok(idx.includes('id="soloEnd"') && idx.includes('id="soloEndEp"') && idx.includes('id="soloEndCuenta"') && idx.includes('id="soloEndAhora"') && idx.includes('id="soloEndCancelar"'), 'HTML: tarjeta "A continuación" completa');
  ok(idx.includes('A continuación'), 'HTML: título de la tarjeta');
  /* v84 — JS */
  ok(js.includes('const SOLO_RATES = [0.5, 1, 1.25, 1.5, 2]'), 'JS: velocidades 0.5x–2x');
  ok(js.includes('function soloSetRate') && js.includes("localStorage.setItem('huddle_rate'"), 'JS: la velocidad se guarda (localStorage)');
  ok(js.includes("localStorage.getItem('huddle_rate')"), 'JS: la velocidad se recuerda al abrir');
  ok(js.includes('playbackRate = SOLO.rate || 1'), 'JS: el remount re-aplica la velocidad (load() la resetea)');
  ok(js.includes('function cerrarMenusSolo'), 'JS: calidad y velocidad se cierran juntas');
  ok(js.includes('function soloSiguiente') && js.includes('eps.slice(1)'), 'JS: avanzar al siguiente episodio');
  ok(js.includes('function iniciarCuentaSiguiente') && js.includes('function pararCuentaSiguiente'), 'JS: cuenta regresiva de la tarjeta');
  ok(js.includes("cuentaTimer = setInterval") && js.includes('1000'), 'JS: la cuenta baja cada segundo');
  ok(js.includes("$('#soloEndAhora').addEventListener('click'") && js.includes("$('#soloEndCancelar').addEventListener('click'"), 'JS: Ver ahora / Cancelar conectados');
  ok(js.includes('iniciarCuentaSiguiente();'), 'JS: al terminar el episodio arranca la cuenta');
  ok(js.includes('pararCuentaSiguiente(); /* v84 */') && js.includes('cerrarSolo'), 'JS: cerrar el reproductor detiene la cuenta');
  ok(js.includes('eps.indexOf(ep)') && js.includes('eps.slice(idx)'), 'JS: elegir episodio pasa la cadena completa');
  ok(js.includes("SOLO.info.eps && SOLO.info.eps.length > 1"), 'JS: "Sig." solo si hay episodio siguiente');
  /* v84 — CSS */
  ok(css.includes('.solo-end') && css.includes('.se-caja') && css.includes('.se-tit'), 'CSS: tarjeta "A continuación"');
  ok(css.includes('@keyframes sePop'), 'CSS: animación de la tarjeta');
  ok(css.includes('max-width: 700px') && css.includes('.solo-ctrls { gap: 6px'), 'CSS: controles más densos en móvil');
  /* v85 — episodios vistos */
  ok(js.includes('async function marcarVistos') && js.includes("'/api/vistos'"), 'JS: pide las marcas al abrir el selector');
  ok(js.includes("b.dataset.url = ep.url || ''"), 'JS: cada episodio lleva su data-url');
  ok(js.includes('visto-chip ok') && js.includes('visto-chip medio'), 'JS: chips ✓ (completa) y ◐ (a medias)');
  ok(js.includes('Ya la viste') && js.includes("'Quedaste en ' + fmtTiempo(v.t)"), 'JS: textos de las marcas');
  ok(js.includes('marcarVistos(eps); /* v85'), 'JS: el selector pinta las marcas solo');
  ok(css.includes('.visto-chip') && css.includes('.visto-chip.ok') && css.includes('.sp-ep.vista img { opacity: 0.42'), 'CSS: chip verde + episodio atenuado');
  ok(srv.includes('VISTOS_FILE') && srv.includes('function anotarVisto') && srv.includes("'/api/vistos'"), 'server: mapa de vistos persistente + endpoint');
  ok(srv.includes('anotarVisto(name.toLowerCase(), entry);') && srv.includes('VISTOS_MAX'), 'server: /api/progress anota el visto (con tope)');
  /* v86 — sigue con el próximo */
  ok(js.includes("prevUrl: (opts && opts.prevUrl) || (info && info.prevUrl) || ''"), 'JS: el reproductor recuerda de qué episodio viene');
  ok(js.includes('prevUrl: SOLO.url') && js.includes('prevUrl: SOLO.prevUrl || \'\''), 'JS: avanzar y reportar llevan el previo');
  ok(js.includes('eps: (SOLO.info.eps || []).slice(0, 100)'), 'JS: el reporte manda la cadena de episodios');
  ok(js.includes('Sigue con ${e.eps[1].ep') && js.includes('tEl.classList.add(\'proximo\')'), 'JS: tarjeta "Sigue con 1x4 ▸"');
  ok(js.includes('const terminada = !!(e.d && (+e.t >= e.d - 20 || (+e.t / e.d) >= 0.9));'), 'JS: detecta el episodio terminado');
  ok(js.includes('eps: e.eps.slice(1),') && js.includes('eps: e.eps || []'), 'JS: retomar abre el próximo con su cadena (o reanuda con la suya)');
  ok(srv.includes('body.eps') && srv.includes('epsArr.length) entry.eps = epsArr'), 'server: guarda la cadena en la entrada');
  ok(srv.includes('prevUrl !== entry.url') && srv.includes('lista.splice(j, 1)'), 'server: el episodio previo no se acumula');
  ok(srv.includes('eps: Array.isArray(e.eps) ? e.eps : []'), 'server: /api/continue devuelve la cadena');
  ok(css.includes('.cont-tiempo.proximo'), 'CSS: acento del "Sigue con"');
  /* v87 — pestañas */
  ok(css.includes('.modo-tabs') && css.includes('.modo-tab.activa') && css.includes('.modo-tab .icon'), 'CSS: pestañas con iconos');
  ok(css.includes('#homeMain.tab-salas .home-search') && css.includes('#homeMain:not(.tab-salas) .salas-sec') && css.includes('#homeMain:not(.tab-salas) #tabSalasBody'), 'CSS: en Salas se esconde el buscador, y lo de salas solo ahí');
  ok(!js.includes("$('#btnCreate').addEventListener"), 'JS: el botón "Crear sala" ya no existe en el inicio');
  /* servidor */
  ok(srv.includes('function resolverSolo') && srv.includes("'/api/solo'") && srv.includes("'/api/hls'") && srv.includes("'/api/progress'"), 'server: rutas /api/solo /api/hls /api/progress');
  ok(srv.includes('esGoodstream') && srv.includes('goodstream\\.one'), 'server: proxy solo para goodstream (allowlist)');
  ok(srv.includes('`https://cine-calidad.mx/pelicula/${p.slug}/`') && !srv.includes('cuevana.mov/pelicula/'), 'server: pelis del buscador Y de populares en cine-calidad (fix del 404)');
  /* v88 — iconos, continuar por pestaña, orientación */
  ok(!js.includes('\\u23EA') && !js.includes('\\u23E9') && js.includes("f.innerHTML = (delta < 0") && js.includes("'\\u23EA'") === false, 'JS: destello ±10s con SVG, sin emojis');
  ok(js.includes("(e.modo === 'solo') === (S.tab === 'solo')"), 'JS: continuar-viendo filtrado por pestaña');
  ok(js.includes('cargarContinuar(); /* v88: la fila'), 'JS: cambiar de pestaña refresca la fila');
  ok(js.includes("classList.toggle('solo-girado'") && js.includes('!mqOrient.matches && esCelular()'), 'JS: reproductor individual girado con celular vertical (siempre horizontal)');
  ok(js.includes('sincronizarGiros(); } catch {} /* v88: ¿celular vertical? → girado */'), 'JS: al abrir el reproductor se acomoda el giro');
  ok(js.includes("classList.remove('solo-girado')"), 'JS: al cerrar, se quita el giro');
  ok(css.includes('body.solo-girado #soloPlayer') && css.includes('rotate(90deg); /* SIEMPRE igual, como la sala (v77) */'), 'CSS: giro del reproductor (como la pantalla completa de la sala)');
  ok(css.includes('body.movil-horizontal #homeFull') && css.includes('rotate(var(--giro-sala))'), 'CSS: el inicio se ve vertical con el celular acostado');
  ok(css.includes('.solo-flash { display: flex; align-items: center; gap: 8px; }'), 'CSS: destello con icono y número');
  /* v89 — nace a pantalla completa, se queda acostado */
  ok(js.includes('el reproductor NACE a pantalla completa') && js.includes("rf.call(spEl)"), 'JS: al abrir ya pide pantalla completa (con el gesto del toque)');
  ok(js.includes('esCelular()) {') && js.includes('!document.fullscreenElement && !document.webkitFullscreenElement'), 'JS: solo en celular y si ya no está a pantalla completa');
  ok(js.includes("=== $('#soloPlayer')") && js.includes('document.exitFullscreen || document.webkitExitFullscreen'), 'JS: al cerrar el reproductor suelta la pantalla completa');
  /* v90 — modo Solo 100%: animes + pelis sin goodstream */
  ok(srv.includes('async function resolverAnime(') && srv.includes('/mp4upload\\./i.test(u)'), 'server: resolver de animes (mp4upload preferido)');
  ok(srv.includes('player\\.src\\(\\{') && srv.includes('video\\/mp4') && srv.includes('servidor de anime no entregó'), 'server: lee el mp4 directo del embed de mp4upload');
  ok(srv.includes('async function resolverVimeos(') && srv.includes('function desempacar(html)'), 'server: vimeos de repuesto (HLS escondido en un eval)');
  ok(srv.includes('function esProxeable(u)') && srv.includes('mp4upload\\.com') && srv.includes('vimeos\\.(net|zip)'), 'server: el proxy también sirve mp4upload y vimeos');
  ok(srv.includes('cabUp.Range = String(req.headers.range)') && srv.includes("'content-range'"), 'server: el proxy pasa Range/Content-Range (moverse en el mp4)');
  ok(srv.includes('esEpAnime ? resolverAnime(target) : resolverSolo(target)') && srv.includes('mp4: !!r.mp4, proxy: !!r.proxy'), 'server: /api/solo enruta animes y avisa mp4/proxy');
  ok(!js.includes("Los animes se ven en la pestaña Juntos"), 'JS: YA no mandamos los animes a Juntos');
  ok(js.includes('ep: esAn ? String(ep.ep || \'\')') && js.includes('abrirSolo(ep.url'), 'JS: episodio de anime abre en Solo con su cadena');
  ok(js.includes('montarSolo(d, !!d.proxy)'), 'JS: arranca por el proxy cuando el origen lo exige');
  ok(js.includes('if (d.mp4)') && js.includes('sin hls.js'), 'JS: el mp4 directo se monta en el <video> nativo');
  /* v91 — búsqueda en Solo + carátulas sin doble proxy */
  ok(js.includes('function imgPorProxy(') && js.includes("if (src.startsWith('/api/img')) return src;"), 'JS: imgPorProxy deja pasar lo ya proxieado (nunca dos veces)');
  ok(js.includes('const srcImg = imgPorProxy(res.img || \'\')') && js.includes('const srcImg = imgPorProxy(e.img || \'\')'), 'JS: tarjetas de resultados y continuar usan el normalizador');
  ok(js.includes("if (S.modoSolo) { abrirSolo(res.url, { title: res.title || '', img: res.img || '' }); return; }") && js.includes('antes la búsqueda SIEMPRE armaba una sala'), 'JS: la búsqueda en la pestaña Solo reproduce individual');
  /* v92 — sala nativa */
  ok(srv.includes('async function resolverNativo(url)') && srv.includes('primero el camino NATIVO'), 'server: al arrancar la sala intenta el video directo primero');
  ok(srv.includes('native: room.native || null') && srv.includes('videoImg: room.videoImg'), 'server: el estado de la sala expone lo nativo');
  ok(srv.includes('if (room.native) {') && srv.includes('room.native = null; /* v92 */'), 'server: detener suelta también lo nativo');
  /* v93 — animes robustos */
  ok(srv.includes('file was deleted') && srv.includes('em.length < 500 && intento < 3'), 'server: mp4upload — detecta archivo borrado y reintenta el cuerpo racionado');
  ok(srv.includes('async function sirveElVideo(') && srv.includes('if (await sirveElVideo(m[1], mejor))'), 'server: verifica que el mp4 SIRVA antes de prometerlo');
  ok(srv.includes('async function resolverAnimePorNavegador(') && srv.includes('hlsReferers.has(h)'), 'server: fallback por navegador + hosts dinámicos en el proxy');
  ok(srv.includes('intento < 3 && !m3u8'), 'server: goodstream reintenta también el cuerpo SIN m3u8 (Conclave)');
  ok(srv.includes('caídos en Latanime'), 'server: mensaje honesto cuando todos los servidores están muertos');
  /* v94 — audio español */
  ok(js.includes('function prefiereEspanol(') && js.includes('prefiereEspanol(video, hls)') && js.includes('prefiereEspanol(v, hls)'), 'JS: elige la pista de audio español (Solo y sala)');
  ok(js.includes('AUDIO_TRACKS_UPDATED'), 'JS: también cuando las pistas llegan tarde');
  ok((js.match(/prefiereEspanol\(video, null\)/g) || []).length + (js.match(/prefiereEspanol\(v, null\)/g) || []).length >= 2, 'JS: Safari/HLS nativo también (AudioTrackList)');
  /* v95 — póster de la serie en continuar-viendo */
  ok(js.includes('spDatos.posterBase || ep.img'), 'JS: la entrada del episodio lleva el póster de la serie (no el still)');
  /* v96 — cura del lado servidor */
  ok(srv.includes('async function posterDeSerie(') && srv.includes('postersSeries'), 'server: póster de serie con caché');
  ok(srv.includes('const posterSerie = mSl ? await posterDeSerie(mSl[1])') && srv.includes('if (posterSerie) entry.img = posterSerie'), 'server: sanea la entrada AL GUARDAR');
  ok(srv.includes('const porSanear =') && srv.includes('sana TAMBIÉN al leer'), 'server: sanea TAMBIÉN al leer (entradas viejas)');
  ok(js.includes('function activarNativo(') && js.includes('function posEsperada(') && js.includes('function sincronizarNativo('), 'JS: sala nativa con reloj de sincronización');
  ok(js.includes('if (st.videoUrl && st.native) activarNativo(st);'), 'JS: el estado de la sala enciende lo nativo');
  ok(js.includes('function ocultarPeliLoadingSuave()') && js.includes('5000 - (Date.now() - (S.peliLoadingAt || 0))'), 'JS: la pantalla de carga dura mínimo 5 segundos');
  ok(js.includes("if (S.nativo) sendAction({ type: S.nativo.isPlaying ? 'pause' : 'play' })"), 'JS: tocar la pantalla pausa/reanuda por el reloj');
  ok(js.includes('montarNativo(true)') && js.includes('Conectando por el servidor'), 'JS: si el directo falla (CORS), remonta por el proxy');
  ok(idx.includes('id="roomVideo"') && css.includes('#roomVideo {'), 'HTML/CSS: el video nativo vive en el marco del espejo');

  /* ---------- 0b) APIs v81/v83 ---------- */
  console.log('— APIs —');
  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: NOMBRE_A }) }).then((r) => r.json()).catch(() => null);
  ok(!!(login && login.token), 'login de prueba');
  /* preflight: ¿la CDN de goodstream nos sirve ahora? (raciona por IP) */
  const qs = 'name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token) + '&url=' + encodeURIComponent(PELI);
  const solo = await fetch(BASE + '/api/solo?' + qs).then((r) => r.json()).catch(() => null);
  let cdnOK = !!(solo && solo.ok);
  if (cdnOK) {
    try { const m = await fetch(BASE + '/api/hls?u=' + encodeURIComponent(solo.m3u8)); cdnOK = m.ok; } catch { cdnOK = false; }
  }
  console.log(cdnOK ? '  · cadena real goodstream disponible' : '  · CDN de goodstream racionando — checks en vivo de la cadena real se omiten');
  const soloX = await fetch(BASE + '/api/solo?url=' + encodeURIComponent(PELI)).catch(() => null);
  ok(!!soloX && soloX.status === 403, '/api/solo exige perfil (403)');
  if (cdnOK) {
    ok(!!solo && solo.ok === true, '/api/solo resuelve la peli SIN navegador');
    ok(!!solo && /goodstream\.one\/.*\.m3u8/i.test(solo.m3u8 || ''), `m3u8 goodstream (${solo ? (solo.m3u8 || '').slice(8, 60) + '…' : '—'})`);
    ok(!!solo && (solo.subs || []).length >= 1, `/api/solo trae subtítulos (${solo ? (solo.subs || []).length : 0} VTT)`);
  }
  /* v90: peli SIN goodstream → vimeos (HLS escondido en un eval) */
  const qsV = 'name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token) + '&url=' + encodeURIComponent(PELI_SIN_GOODSTREAM);
  const soloV = await fetch(BASE + '/api/solo?' + qsV).then((r) => r.json()).catch(() => null);
  let vimeoOK = !!(soloV && soloV.ok);
  if (vimeoOK) {
    try { const m = await fetch(BASE + '/api/hls?u=' + encodeURIComponent(soloV.m3u8)); vimeoOK = m.ok && (await m.text()).includes('#EXTM3U'); } catch { vimeoOK = false; }
  }
  console.log(vimeoOK ? '  · cadena vimeos disponible (peli sin goodstream)' : '  · vimeos racionando — checks en vivo de vimeos se omiten');
  if (vimeoOK) {
    ok(/vimeos\./i.test(soloV.m3u8) && soloV.proxy === true, 'una peli SIN goodstream ahora resuelve (vimeos, por el proxy)');
    ok((soloV.subs || []).length === 0 && soloV.mp4 !== true, 'vimeos es HLS (no mp4), sin subtítulos');
  }
  const hlsX = await fetch(BASE + '/api/hls?u=' + encodeURIComponent('https://www.google.com/video.m3u8')).catch(() => null);
  ok(!!hlsX && hlsX.status === 403, '/api/hls rechaza hosts fuera de goodstream (403)');
  /* el proxy sirve y reescribe nuestro m3u8 LOCAL (determinista) */
  const hlsL = await fetch(BASE + '/api/hls?u=' + encodeURIComponent(PELI_LOCAL)).catch(() => null);
  const hlsLTxt = hlsL ? await hlsL.text() : '';
  ok(!!hlsL && hlsL.ok && hlsLTxt.includes('/api/hls?u='), 'proxy sirve el master local reescrito');
  const varL = (hlsLTxt.match(/\/api\/hls\?u=(%2F[^"' \n]+)/) || [])[1];
  const varLR = varL ? await fetch(BASE + '/api/hls?u=' + varL).catch(() => null) : null;
  const varLTxt = varLR ? await varLR.text() : '';
  const segL = (varLTxt.match(/\/api\/hls\?u=(%2F[^"' \n]+)/) || [])[1];
  const segLR = segL ? await fetch(BASE + '/api/hls?u=' + segL).then((r) => r.arrayBuffer().then((b) => ({ ok: r.ok, ct: r.headers.get('content-type'), b }))).catch(() => null) : null;
  ok(!!varLR && varLR.ok && varLTxt.includes('.ts'), 'proxy: variante local reescrita');
  ok(!!segLR && segLR.ok && /video|mp2t|octet/i.test(segLR.ct || '') && segLR.b.byteLength > 10000, `segmento local por el proxy (${segLR ? segLR.ct : '—'}, ${(segLR ? segLR.b.byteLength / 1024 : 0).toFixed(0)} KB)`);
  /* /api/progress auth + upsert */
  const progX = await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: 'churro', url: PELI, t: 100, d: 600 }) }).catch(() => null);
  ok(!!progX && progX.status === 403, '/api/progress exige token bueno (403)');
  const prog1 = await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: PELI, t: 120, d: 600, title: 'Mayday', modo: 'solo' }) }).then((r) => r.json()).catch(() => null);
  ok(!!prog1 && prog1.ok, '/api/progress guarda (t=120)');
  const cont1 = await fetch(BASE + '/api/continue?name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token)).then((r) => r.json()).catch(() => null);
  const ent1 = cont1 && (cont1.items || []).find((e) => e.url === PELI);
  ok(!!ent1 && ent1.modo === 'solo' && ent1.t === 120, `continuar-viendo lo trae como solo (t=${ent1 ? ent1.t : '—'})`);
  /* v85: /api/vistos — qué episodios ya vio */
  const visX = await fetch(BASE + '/api/vistos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: 'churro', urls: [PELI_LOCAL] }) }).catch(() => null);
  ok(!!visX && visX.status === 403, '/api/vistos exige perfil válido (403)');
  const visBase = (u, t) => fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: u, t, d: 100, title: 'Serie local', serie: 'Serie local', ep: '1x1', modo: 'solo' }) }).then((r) => r.json()).catch(() => null);
  const U_E1 = PELI_LOCAL + '?e=1', U_E2 = PELI_LOCAL + '?e=2', U_E4 = PELI_LOCAL + '?e=4';
  await visBase(U_E1, 95); /* completa */
  await visBase(U_E2, 40); /* a medias */
  const visR = await fetch(BASE + '/api/vistos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, urls: [U_E1, U_E2, U_E4] }) }).then((r) => r.json()).catch(() => null);
  const mapaVis = (visR && visR.vistos) || {};
  ok(!!visR && visR.ok === true, '/api/vistos responde');
  ok(mapaVis[U_E1] && mapaVis[U_E1].t === 95, `trae la completa (t=${mapaVis[U_E1] ? mapaVis[U_E1].t : '—'})`);
  ok(mapaVis[U_E2] && mapaVis[U_E2].t === 40, `trae la de a medias (t=${mapaVis[U_E2] ? mapaVis[U_E2].t : '—'})`);
  ok(!mapaVis[U_E4], 'la no vista no viene');
  /* v87: fix 404 — una peli del catálogo resuelve en modo solo */
  const busca87 = await fetch(BASE + '/api/search?q=' + encodeURIComponent('maridos en acción')).then((r) => r.json()).catch(() => null);
  const peli87 = busca87 && (busca87.results || []).find((x) => /\/pelicula\//.test(x.url || ''));
  ok(!!peli87 && /^https:\/\/cine-calidad\.mx\/pelicula\//.test(peli87.url || ''), `pelis del buscador en cine-calidad (${peli87 ? peli87.url.slice(8, 60) + '…' : '—'})`);
  let peli87ok = null;
  if (cdnOK && peli87) {
    peli87ok = await fetch(BASE + '/api/solo?name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token) + '&url=' + encodeURIComponent(peli87.url)).then((r) => r.json()).catch(() => null);
  }
  ok(!cdnOK || !!(peli87ok && peli87ok.ok === true), 'esa peli YA resuelve en modo solo (antes: 404 de cuevana.mov)' + (cdnOK ? '' : ' — omitido, CDN racionando'));
  /* v86: la cadena viaja con el progreso y el previo no se acumula */
  const U_P1 = PELI_LOCAL + '?p=1', U_P2 = PELI_LOCAL + '?p=2', U_P3 = PELI_LOCAL + '?p=3';
  await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: U_P1, t: 50, d: 100, title: 'Serie P', serie: 'Serie P', ep: '1x1', modo: 'solo' }) });
  await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: U_P2, t: 30, d: 100, title: 'Serie P', serie: 'Serie P', ep: '1x2', modo: 'solo', prevUrl: U_P1, eps: [{ url: U_P2, ep: '1x2' }, { url: U_P3, ep: '1x3' }] }) });
  const cont86 = await fetch(BASE + '/api/continue?name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token)).then((r) => r.json()).catch(() => null);
  const items86 = (cont86 && cont86.items) || [];
  ok(!items86.some((x) => x.url === U_P1), 'el episodio previo ya no ocupa lugar (dedupe)');
  const entP2 = items86.find((x) => x.url === U_P2);
  ok(!!entP2 && entP2.eps && entP2.eps.length === 2 && entP2.eps[1].ep === '1x3', `la entrada lleva su cadena (próximo ${entP2 && entP2.eps && entP2.eps[1] ? entP2.eps[1].ep : '—'})`);

  /* ---------- USUARIO A: escritorio — reproductor v84 ---------- */
  console.log('— Usuario A: reproductor individual (escritorio) —');
  const bA = await puppeteer.launch({ headless: 'new', protocolTimeout: 180000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const pA = await bA.newPage();
  await pA.setViewport({ width: 1280, height: 800 });
  const errsA = [];
  pA.on('pageerror', (e) => errsA.push(String(e)));
  await pA.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await pA.evaluate(async (nombre, tok) => {
    localStorage.setItem('rr-profile', JSON.stringify({ name: nombre, token: tok }));
  }, login.name, login.token);
  await pA.reload({ waitUntil: 'networkidle2' });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });

  /* v87: pestañas Salas / Juntos / Solo */
  const tabInfo = await pA.evaluate(() => ({
    tabs: [...document.querySelectorAll('.modo-tab')].length,
    iconos: [...document.querySelectorAll('.modo-tab svg')].length,
    textos: [...document.querySelectorAll('.modo-tab')].map((x) => x.textContent.trim()),
    crear: !!document.querySelector('#btnCreate'),
    emojis: /👥|🎬/u.test(document.querySelector('#modoTabs').textContent),
  }));
  ok(tabInfo.tabs === 3 && tabInfo.iconos === 3 && tabInfo.textos.join('/') === 'Salas/Juntos/Solo', 'tres pestañas con iconos SVG');
  ok(!tabInfo.crear && !tabInfo.emojis, 'sin botón "Crear sala" y sin emojis en las pestañas');
  await pA.click('#tabSalas');
  const salasA = await pA.evaluate(() => ({
    activa: document.querySelector('.modo-tab.activa').id,
    ls: localStorage.getItem('huddle_tab'),
    salasVisibles: getComputedStyle(document.querySelector('#salasSec')).display !== 'none',
    codigo: !!document.querySelector('#tabSalasBody #joinCode'),
    unirme: !!document.querySelector('#tabSalasBody #btnJoin'),
    busqueda: getComputedStyle(document.querySelector('.home-search')).display,
    trending: getComputedStyle(document.querySelector('#trendingBox')).display,
    titulo: document.querySelector('#heroTitle').textContent,
  }));
  ok(salasA.activa === 'tabSalas' && salasA.ls === 'salas', 'pestaña Salas se activa y se guarda');
  ok(salasA.salasVisibles && salasA.codigo && salasA.unirme, 'Salas: salas en vivo + entrar con código');
  ok(salasA.busqueda === 'none' && salasA.trending === 'none', 'en Salas no hay buscador ni filas');
  ok(salasA.titulo === 'Salas', `título de la pestaña ("${salasA.titulo}")`);
  await pA.click('#tabSolo');
  const tabSolo1 = await pA.evaluate(() => ({
    activa: document.querySelector('.modo-tab.activa').id,
    ls: localStorage.getItem('huddle_tab'),
    modo: S.modoSolo,
    titulo: document.querySelector('#heroTitle').textContent,
    sub: document.querySelector('#heroSub').textContent,
  }));
  ok(tabSolo1.activa === 'tabSolo' && tabSolo1.ls === 'solo' && tabSolo1.modo === true, 'pestaña Solo activa, guardada y con modo individual');
  ok(/¿Qué vas a ver hoy\?/.test(tabSolo1.titulo) && /sin ningún compañero/.test(tabSolo1.sub), 'Solo pregunta en singular ("' + tabSolo1.titulo + '")');

  /* abrir con CADENA de episodios (v84) */
  await pA.evaluate((url, eps) => { abrirSolo(url, { title: 'Prueba local', serie: 'Prueba local', ep: '1x1', eps }); }, PELI_LOCAL, EPS_PRUEBA);
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  ok(true, 'reproductor individual visible');
  const titA = await pA.evaluate(() => document.querySelector('#soloTitle').textContent);
  ok(titA === 'Prueba local', `título en el reproductor ("${titA}")`);
  /* espera a que el video de verdad avance */
  let listo = false, viaProxy = false, usoHls = false, diagA = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => {
      const v = document.querySelector('#soloVideo');
      return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0, proxy: (typeof SOLO !== 'undefined' && SOLO) ? SOLO.viaProxy : null, hls: (typeof SOLO !== 'undefined' && SOLO) ? !!SOLO.hls : null };
    });
    viaProxy = st.proxy; usoHls = st.hls; diagA = st;
    if (st.rs >= 2 && st.t > 3 && st.dur > 60 && !st.pausa) { listo = true; break; }
  }
  ok(listo, 'el video REPRODUCE directo (hls.js=' + usoHls + ', proxy=' + viaProxy + ')' + (listo ? '' : ' — diagnóstico: ' + JSON.stringify(diagA)));
  const dur = await pA.evaluate(() => document.querySelector('#soloVideo').duration);
  ok(dur > 60, `duración real del fixture (${(dur / 60).toFixed(0)} min)`);
  const uiA = await pA.evaluate(() => ({
    time: document.querySelector('#soloTime').textContent,
    cc: !document.querySelector('#soloCC').classList.contains('hidden'),
    next: !document.querySelector('#soloNext').classList.contains('hidden'),
    ep: document.querySelector('#soloEp').textContent,
  }));
  ok(/\d+:\d+ \/ \d+:\d+/.test(uiA.time), `tiempo pintado ("${uiA.time}")`);
  ok(uiA.cc, 'botón CC (el fixture trae subtítulos)');
  ok(uiA.next, '"Sig. ▸" visible (hay cadena de episodios)');
  ok(/Episodio 1x1/.test(uiA.ep), `etiqueta del episodio ("${uiA.ep}")`);

  /* v84: menú de VELOCIDAD */
  const rate0 = await pA.evaluate(() => ({
    btn: document.querySelector('#soloRate').textContent,
    v: document.querySelector('#soloVideo').playbackRate,
  }));
  ok(rate0.btn === '1x' && rate0.v === 1, `arranca en velocidad normal (botón "${rate0.btn}", rate ${rate0.v})`);
  await pA.evaluate(() => { document.querySelector('#soloRate').click(); });
  const rMenu = await pA.evaluate(() => ({
    abierto: !document.querySelector('#soloRateMenu').classList.contains('hidden'),
    items: [...document.querySelectorAll('#soloRateMenu .solo-qitem')].map((b) => b.textContent),
    qCerrado: document.querySelector('#soloQMenu').classList.contains('hidden'),
  }));
  ok(rMenu.abierto && rMenu.items.length === 5, `menú de velocidad: ${rMenu.items.join(' / ')}`);
  ok(rMenu.items[0] === '0.5x', 'primera opción 0.5x');
  ok(rMenu.items[4] === '2x', 'última opción 2x');
  ok(rMenu.qCerrado, 'abrir velocidad cierra el menú de calidad');
  /* elegir 1.5x y medir que avanza 1.5× más rápido */
  await pA.evaluate(() => { [...document.querySelectorAll('#soloRateMenu .solo-qitem')].find((b) => b.textContent === '1.5x').click(); });
  const r15 = await pA.evaluate(() => ({
    v: document.querySelector('#soloVideo').playbackRate,
    btn: document.querySelector('#soloRate').textContent,
    ls: localStorage.getItem('huddle_rate'),
    menuCerrado: document.querySelector('#soloRateMenu').classList.contains('hidden'),
  }));
  ok(r15.v === 1.5 && r15.btn === '1.5x', `1.5x fijada (botón "${r15.btn}", rate ${r15.v})`);
  ok(r15.ls === '1.5' && r15.menuCerrado, 'se guarda en localStorage y el menú se cierra');
  const tr1 = await pA.evaluate(() => document.querySelector('#soloVideo').currentTime);
  await sleep(4000);
  const tr2 = await pA.evaluate(() => document.querySelector('#soloVideo').currentTime);
  ok(tr2 - tr1 >= 5.4, `a 1.5x avanza más rápido (${(tr2 - tr1).toFixed(1)}s de video en 4s reales)`);

  /* v84: botón "Sig. ▸" */
  await pA.evaluate(() => { document.querySelector('#soloNext').click(); });
  let ep2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    ep2 = await pA.evaluate(() => ({
      ep: document.querySelector('#soloEp').textContent,
      t: document.querySelector('#soloVideo').currentTime,
      rate: document.querySelector('#soloVideo').playbackRate,
      btn: document.querySelector('#soloRate').textContent,
      next: !document.querySelector('#soloNext').classList.contains('hidden'),
    }));
    if (/Episodio 1x2/.test(ep2.ep) && ep2.t > 1) break;
  }
  ok(/Episodio 1x2/.test(ep2.ep), `"Sig. ▸" avanza al 1x2 ("${ep2.ep}")`);
  ok(ep2.t <= 12, `el video arranca de cero en el nuevo episodio (t=${ep2.t.toFixed(1)}s)`);
  ok(ep2.rate === 1.5 && ep2.btn === '1.5x', `la velocidad 1.5x sobrevive el cambio de episodio (${ep2.rate})`);
  ok(ep2.next, '"Sig. ▸" sigue visible (aún queda episodio)');

  /* v84: terminar el episodio → tarjeta "A continuación" */
  const finOK = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); v.currentTime = v.duration - 0.4; return true; });
  let endCard = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    endCard = await pA.evaluate(() => ({
      visible: !document.querySelector('#soloEnd').classList.contains('hidden'),
      ep: document.querySelector('#soloEndEp').textContent,
      cuenta: document.querySelector('#soloEndCuenta').textContent,
    }));
    if (endCard.visible) break;
  }
  ok(endCard.visible, 'al terminar aparece la tarjeta "A continuación"');
  ok(/Episodio 1x3/.test(endCard.ep), `anuncia el próximo ("${endCard.ep}")`);
  ok(/^En \d/.test(endCard.cuenta), `cuenta regresiva corriendo ("${endCard.cuenta}")`);
  /* "Ver ahora" → salta la cuenta */
  await pA.evaluate(() => { document.querySelector('#soloEndAhora').click(); });
  let ep3 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    ep3 = await pA.evaluate(() => ({
      ep: document.querySelector('#soloEp').textContent,
      t: document.querySelector('#soloVideo').currentTime,
      oculto: document.querySelector('#soloEnd').classList.contains('hidden'),
    }));
    if (/Episodio 1x3/.test(ep3.ep) && ep3.t > 1) break;
  }
  ok(/Episodio 1x3/.test(ep3.ep) && ep3.oculto, '"Ver ahora ▶" reproduce el 1x3 de inmediato');
  ok(ep3.t <= 12, `desde el inicio (t=${ep3.t.toFixed(1)}s)`);

  /* v84: cuenta AUTO — dejar que venza sola */
  await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); v.currentTime = v.duration - 0.4; });
  let autoOK = false, ep4 = '';
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const st = await pA.evaluate(() => ({
      ep: document.querySelector('#soloEp').textContent,
      t: document.querySelector('#soloVideo').currentTime,
      fin: !document.querySelector('#soloEnd').classList.contains('hidden'),
    }));
    ep4 = st.ep;
    if (/Episodio 1x4/.test(st.ep) && st.t > 1 && !st.fin) { autoOK = true; break; }
  }
  ok(autoOK, `la cuenta vence sola y arranca el 1x4 ("${ep4}")`);

  /* último episodio: ya no hay "Sig." */
  await sleep(1500);
  const ultimo = await pA.evaluate(() => ({
    next: document.querySelector('#soloNext').classList.contains('hidden'),
    endOculto: document.querySelector('#soloEnd').classList.contains('hidden'),
  }));
  ok(ultimo.next && ultimo.endOculto, 'en el último episodio ya no se ofrece "Sig. ▸"');

  /* dejar el 1x4 en el segundo 30, cerrar → continuar-viendo */
  await pA.evaluate(() => { document.querySelector('#soloVideo').currentTime = 30; });
  await sleep(2500);
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(600);
  const cerradoA = await pA.evaluate(() => document.querySelector('#soloPlayer').classList.contains('hidden'));
  ok(cerradoA, '✕ cierra el reproductor');
  const contA = await pA.evaluate(async (nombre, tok, url) => {
    const r = await fetch('/api/continue?name=' + encodeURIComponent(nombre) + '&tok=' + encodeURIComponent(tok));
    const d = await r.json();
    const e = (d.items || []).find((x) => x.url === url);
    return e ? { t: e.t, modo: e.modo, ep: e.ep } : null;
  }, login.name, login.token, PELI_LOCAL);
  ok(!!contA && contA.modo === 'solo', 'quedó en Continuar viendo como "solo"');
  ok(!!contA && contA.t >= 20, `con su minuto guardado (t=${contA ? contA.t : '—'}s)`);

  /* la tarjeta reanuda Y conserva la velocidad 1.5x */
  await pA.waitForSelector('#continueBox:not(.hidden) .cont-card', { timeout: 10000 });
  await pA.evaluate(() => {
    const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => x.textContent.includes('Prueba local'));
    c.click();
  });
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let reanudado = false, tRe = 0, rateRe = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => {
      const v = document.querySelector('#soloVideo');
      return { t: v.currentTime, rs: v.readyState, dur: isFinite(v.duration) ? v.duration : 0, rate: v.playbackRate, abierto: (typeof SOLO !== 'undefined' && !!SOLO) };
    });
    if (st.rs >= 2 && st.dur > 60 && st.t >= (contA ? contA.t : 30) - 15) { reanudado = true; tRe = st.t; rateRe = st.rate; break; }
    if (!st.abierto) break;
  }
  ok(reanudado, `reanudó donde se quedó (t=${tRe.toFixed(0)}s, guardado ${contA ? contA.t : '—'}s)`);
  ok(rateRe === 1.5, `la velocidad 1.5x se recuerda entre sesiones (rate=${rateRe})`);

  /* v82: reconexión por el proxy — vuelve al minuto Y a la velocidad */
  const vivoPre = await pA.evaluate(() => !!(typeof SOLO !== 'undefined' && SOLO));
  const tPre = vivoPre ? await pA.evaluate(() => Math.floor(document.querySelector('#soloVideo').currentTime)) : 0;
  if (vivoPre) await pA.evaluate((tObjetivo) => {
    SOLO.lastT = tObjetivo;
    montarSolo(SOLO.res, true); /* reconexión por el proxy */
  }, Math.max(60, tPre));
  let volvio = false, tVolvio = 0, rateVolvio = 0;
  if (vivoPre) for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, pausa: v.paused, rate: v.playbackRate, abierto: (typeof SOLO !== 'undefined' && !!SOLO) }; });
    if (st.rs >= 2 && !st.pausa && Math.abs(st.t - Math.max(60, tPre)) < 20) { volvio = true; tVolvio = st.t; rateVolvio = st.rate; break; }
    if (!st.abierto) break;
  }
  ok(vivoPre && volvio, `reconexión por el proxy vuelve al minuto (iba en ${tPre}s → ${tVolvio.toFixed(0)}s)`);
  ok(rateVolvio === 1.5, `la velocidad se re-aplica tras el remount (rate=${rateVolvio})`);

  /* v82: tras 5s sin tocar, todo se esconde */
  let ocultoTop = false, ocultoCtrl = false;
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const st = await pA.evaluate(() => ({
      top: document.querySelector('#soloTop').classList.contains('oculto'),
      ctrl: document.querySelector('#soloCtrls').classList.contains('oculto'),
    }));
    ocultoTop = st.top; ocultoCtrl = st.ctrl;
    if (ocultoTop && ocultoCtrl) break;
  }
  ok(ocultoTop && ocultoCtrl, 'a los 5s sin tocar se esconden controles Y barra de arriba');
  const reAparece = await pA.evaluate(() => {
    document.querySelector('#soloPlayer').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return {
      top: !document.querySelector('#soloTop').classList.contains('oculto'),
      ctrl: !document.querySelector('#soloCtrls').classList.contains('oculto'),
    };
  });
  ok(reAparece.top && reAparece.ctrl, 'un toque las trae de vuelta');
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(500);

  /* wiring: serie → episodio en individual (cadena v84 incluida), gated a CDN */
  console.log('— Usuario A: serie → episodio en individual —');
  await pA.evaluate(() => {
    document.querySelector('#homeSearch').value = 'peaky blinders';
    buscarInicio();
  });
  await pA.waitForSelector('#searchResults .sr-card', { timeout: 30000 });
  const clicSerie = await pA.evaluate(async () => {
    const d = await fetch('/api/search?q=' + encodeURIComponent('peaky blinders')).then((r) => r.json());
    const serie = (d.results || []).find((x) => /\/serie\//.test(x.url || ''));
    if (!serie) return false;
    const c = [...document.querySelectorAll('#searchResults .sr-card')].find((x) => {
      const n = x.querySelector('.sr-nombre');
      return n && n.textContent.trim() === serie.title;
    });
    if (!c) return false;
    c.click();
    return true;
  });
  ok(clicSerie, 'clic en la tarjeta de la SERIE (no la peli)');
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 20000 });
  await pA.waitForSelector('#spEpisodios .sp-ep', { timeout: 30000 });
  await pA.evaluate(() => document.querySelector('#spEpisodios .sp-ep').click());
  await sleep(1200);
  const soloSerie = await pA.evaluate(() => ({
    player: !document.querySelector('#soloPlayer').classList.contains('hidden'),
    picker: document.querySelector('#seriePicker').classList.contains('hidden'),
    ep: document.querySelector('#soloEp').textContent,
    next: !document.querySelector('#soloNext').classList.contains('hidden'),
    epsEnPila: (typeof SOLO !== 'undefined' && SOLO && SOLO.info && SOLO.info.eps) ? SOLO.info.eps.length : 0,
  }));
  ok(soloSerie.player && soloSerie.picker, 'el episodio abre el reproductor individual (sin sala)');
  ok(/Episodio 1x1/.test(soloSerie.ep), `etiqueta del episodio ("${soloSerie.ep}")`);
  ok(!cdnOK || (soloSerie.next && soloSerie.epsEnPila >= 2), `elegir episodio arma la cadena (Sig. ${soloSerie.next ? 'visible' : 'oculto'}, ${soloSerie.epsEnPila} en la pila)` + (cdnOK ? '' : ' — omitido, CDN racionando'));
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(400);

  /* ---------- v85: episodios vistos en el selector ---------- */
  console.log('— Usuario A: marcas de episodios vistos —');
  const dataUrlSerie = await pA.evaluate(() => [...document.querySelectorAll('#spEpisodios .sp-ep')].every((b) => !!b.dataset.url));
  ok(dataUrlSerie, 'cada episodio real lleva su data-url');
  if (cdnOK) {
    const remarcado = await pA.evaluate(async () => {
      const p = JSON.parse(localStorage.getItem('rr-profile'));
      const eps = spDatos.episodios || [];
      if (!eps.length) return { vista: false, chip: '' };
      await fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name, token: p.token, url: eps[0].url, t: 95, d: 100, title: spDatos.titulo, serie: spDatos.titulo, ep: '1x1', modo: 'solo' }) });
      pintarEpisodios(eps[0].temporada);
      await new Promise((r) => setTimeout(r, 2500)); /* marcarVistos es async */
      return { vista: !!document.querySelector('#spEpisodios .sp-ep.vista'), chip: (document.querySelector('#spEpisodios .sp-ep.vista .visto-chip') || {}).textContent || '' };
    });
    ok(remarcado.vista && remarcado.chip === '✓', 'serie real: el episodio reportado queda marcado ✓');
  } else {
    ok(true, 'serie real: remarcaje omitido (CDN racionando)');
  }
  /* flujo completo determinista con el fixture: 1x1 completa (95%), 1x2 a
   * medias (40%), 1x3 VIENDO de verdad hasta ~30s y cerrando, 1x4 sin ver */
  const U1 = PELI_LOCAL + '?e=1', U2 = PELI_LOCAL + '?e=2', U3 = PELI_LOCAL + '?e=3', U4 = PELI_LOCAL + '?e=4';
  await pA.evaluate(async (u1, u2) => {
    const p = JSON.parse(localStorage.getItem('rr-profile'));
    const rep = (url, t) => fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name, token: p.token, url, t, d: 100, title: 'Serie local', serie: 'Serie local', ep: '1x1', modo: 'solo' }) });
    await rep(u1, 95);
    await rep(u2, 40);
  }, U1, U2);
  await pA.evaluate((u) => { abrirSolo(u, { title: 'Serie local', serie: 'Serie local', ep: '1x3' }); }, U3);
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let t85 = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, dur: isFinite(v.duration) ? v.duration : 0, abierto: (typeof SOLO !== 'undefined' && !!SOLO) }; });
    if (st.rs >= 2 && st.t >= 30 && st.dur > 60) { t85 = st.t; break; }
    if (!st.abierto) break;
  }
  ok(t85 >= 30, `vi el 1x3 de verdad hasta el segundo ~30 (t=${t85.toFixed(0)}s)`);
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(1500); /* que llegue el último reporte del progreso */
  const marcas = await pA.evaluate(async (eps) => {
    spDatos = { titulo: 'Serie local', esAnime: false, episodios: eps, posterBase: '', enSala: false };
    pintarEpisodios(1);
    await new Promise((r) => setTimeout(r, 2500));
    const btn = (u) => document.querySelector('.sp-ep[data-url="' + u + '"]');
    const chip = (u) => { const b = btn(u); const c = b && b.querySelector('.visto-chip'); return c ? { txt: c.textContent, title: c.title } : null; };
    return {
      todos: document.querySelectorAll('#spEpisodios .sp-ep').length,
      conData: [...document.querySelectorAll('#spEpisodios .sp-ep')].every((b) => !!b.dataset.url),
      e1: { cls: btn(eps[0].url) ? btn(eps[0].url).className : '', chip: chip(eps[0].url) },
      e2: { cls: btn(eps[1].url) ? btn(eps[1].url).className : '', chip: chip(eps[1].url) },
      e3: { cls: btn(eps[2].url) ? btn(eps[2].url).className : '', chip: chip(eps[2].url) },
      e4: { cls: btn(eps[3].url) ? btn(eps[3].url).className : '', chip: chip(eps[3].url) },
    };
  }, [
    { temporada: 1, ep: 1, url: U1, titulo: 'Uno' },
    { temporada: 1, ep: 2, url: U2, titulo: 'Dos' },
    { temporada: 1, ep: 3, url: U3, titulo: 'Tres' },
    { temporada: 1, ep: 4, url: U4, titulo: 'Cuatro' },
  ]);
  ok(marcas.todos === 4 && marcas.conData, `selector pintado: 4 episodios, todos con data-url`);
  ok(/\bvista\b/.test(marcas.e1.cls) && marcas.e1.chip && marcas.e1.chip.txt === '✓' && marcas.e1.chip.title === 'Ya la viste', '1x1 al 95% → ✓ verde "Ya la viste"');
  ok(/parcial/.test(marcas.e2.cls) && marcas.e2.chip && marcas.e2.chip.txt === '◐' && /Quedaste en 0:40/.test(marcas.e2.chip.title || ''), `1x2 a medias → ◐ "Quedaste en 0:40"`);
  ok(/parcial/.test(marcas.e3.cls) && marcas.e3.chip && marcas.e3.chip.txt === '◐' && /Quedaste en 0:3\d/.test(marcas.e3.chip.title || ''), `1x3 visto en vivo → ◐ ("${marcas.e3.chip ? marcas.e3.chip.title : ''}")`);
  ok(marcas.e4.cls.indexOf('vista') === -1 && !/parcial/.test(marcas.e4.cls) && !marcas.e4.chip, '1x4 sin ver → sin marca');

  /* ---------- v86: sigue con el próximo ---------- */
  console.log('— Usuario A: sigue con el próximo —');
  const W1 = PELI_LOCAL + '?w=1', W2 = PELI_LOCAL + '?w=2', W3 = PELI_LOCAL + '?w=3', W4 = PELI_LOCAL + '?w=4';
  const cadenaW = [{ url: W1, ep: '1x1' }, { url: W2, ep: '1x2' }, { url: W3, ep: '1x3' }, { url: W4, ep: '1x4' }];
  await pA.evaluate((u, eps) => { abrirSolo(u, { title: 'Maratón', serie: 'Maratón', ep: '1x1', eps }); }, W1, cadenaW);
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let wOk = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, abierto: (typeof SOLO !== 'undefined' && !!SOLO) }; });
    if (st.rs >= 2 && st.t >= 25) { wOk = true; break; }
    if (!st.abierto) break;
  }
  ok(wOk, 'maratón: 1x1 rodando (t≥25s)');
  await pA.evaluate(() => { document.querySelector('#soloNext').click(); });
  let w2 = { ep: '', t: 0 };
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    w2 = await pA.evaluate(() => ({ ep: document.querySelector('#soloEp').textContent, t: document.querySelector('#soloVideo').currentTime }));
    if (/Episodio 1x2/.test(w2.ep) && w2.t >= 12) break; /* 12s: ya pasó un reporte (10s) con prevUrl */
  }
  ok(/Episodio 1x2/.test(w2.ep) && w2.t >= 12, `avanzó al 1x2 y ya reportó con el previo (t=${w2.t.toFixed(0)}s)`);
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(800);
  const contW = await pA.evaluate(async (nombre, tok, u1, u2) => {
    const r = await fetch('/api/continue?name=' + encodeURIComponent(nombre) + '&tok=' + encodeURIComponent(tok));
    const d = await r.json();
    const e1 = (d.items || []).find((x) => x.url === u1);
    const e2 = (d.items || []).find((x) => x.url === u2);
    return { hay1: !!e1, e2: e2 ? { ep: e2.ep, eps: (e2.eps || []).length, prox: (e2.eps && e2.eps[1]) ? e2.eps[1].ep : '' } : null };
  }, login.name, login.token, W1, W2);
  ok(!contW.hay1, 'al avanzar, la entrada del 1x1 se quita (la serie no se duplica)');
  ok(!!contW.e2 && contW.e2.ep === '1x2' && contW.e2.eps === 3, `la entrada del 1x2 lleva la cadena (${contW.e2 ? contW.e2.eps : '—'} eps, próximo ${contW.e2 ? contW.e2.prox : '—'})`);

  /* un episodio TERMINADO → la tarjeta invita al próximo y lo abre directo */
  const U_T3 = PELI_LOCAL + '?t=3', U_T4 = PELI_LOCAL + '?t=4';
  await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: U_T3, t: 95, d: 100, title: 'Maratón', serie: 'Maratón', ep: '1x3', modo: 'solo', eps: [{ url: U_T3, ep: '1x3' }, { url: U_T4, ep: '1x4' }] }) });
  await pA.reload({ waitUntil: 'networkidle2' });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  await pA.waitForSelector('#continueBox:not(.hidden) .cont-card', { timeout: 15000 });
  const cardT = await pA.evaluate(() => {
    const la = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => {
      const ep = x.querySelector('.cont-ep'); const nom = x.querySelector('.sr-nombre');
      return ep && ep.textContent === '1x3' && nom && nom.textContent === 'Maratón';
    });
    if (!la) return { txt: 'NO ENCONTRADA', proximo: false };
    const tEl = la.querySelector('.cont-tiempo');
    return { txt: tEl.textContent, proximo: tEl.classList.contains('proximo') };
  });
  ok(/Sigue con 1x4/.test(cardT.txt) && cardT.proximo, `tarjeta del 1x3 terminado: "${cardT.txt}"`);
  await pA.evaluate(() => {
    const la = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => {
      const ep = x.querySelector('.cont-ep'); const nom = x.querySelector('.sr-nombre');
      return ep && ep.textContent === '1x3' && nom && nom.textContent === 'Maratón';
    });
    la.click();
  });
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let t4 = { ep: '', t: 0, rs: 0, nextOculto: false };
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    t4 = await pA.evaluate(() => ({ ep: document.querySelector('#soloEp').textContent, t: document.querySelector('#soloVideo').currentTime, rs: document.querySelector('#soloVideo').readyState, nextOculto: document.querySelector('#soloNext').classList.contains('hidden') }));
    if (/Episodio 1x4/.test(t4.ep) && t4.rs >= 2 && t4.t > 2) break;
  }
  ok(/Episodio 1x4/.test(t4.ep) && t4.t > 2 && t4.t <= 15, `clic en la tarjeta → arranca el 1x4 directo (t=${t4.t.toFixed(1)}s)`);
  ok(t4.nextOculto, 'al ser el último de la cadena, ya no ofrece "Sig. ▸"');
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(600);

  /* reanudar a medias conserva la cadena (el camino de siempre, mejorado) */
  await pA.reload({ waitUntil: 'networkidle2' });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  await pA.waitForSelector('#continueBox:not(.hidden) .cont-card', { timeout: 15000 });
  await pA.evaluate(() => {
    const la = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => {
      const ep = x.querySelector('.cont-ep'); const nom = x.querySelector('.sr-nombre');
      return ep && ep.textContent === '1x2' && nom && nom.textContent === 'Maratón';
    });
    la.click();
  });
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let wRe = { ep: '', t: 0, rs: 0, nextVisible: false };
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    wRe = await pA.evaluate(() => ({ ep: document.querySelector('#soloEp').textContent, t: document.querySelector('#soloVideo').currentTime, rs: document.querySelector('#soloVideo').readyState, nextVisible: !document.querySelector('#soloNext').classList.contains('hidden') }));
    if (wRe.rs >= 2 && wRe.t >= 10) break;
  }
  ok(/Episodio 1x2/.test(wRe.ep) && wRe.t >= 10 && wRe.t <= 30, `reanuda el 1x2 donde iba (t=${wRe.t.toFixed(0)}s)`);
  ok(wRe.nextVisible, '…y la cadena viene con ella ("Sig. ▸" visible)');
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(400);

  /* v87: en Juntos, elegir una peli crea la sala sola (sin botón) */
  await pA.click('#tabJuntos');
  const juntosFin = await pA.evaluate(() => ({
    activa: document.querySelector('.modo-tab.activa').id,
    ls: localStorage.getItem('huddle_tab'),
    modo: S.modoSolo,
    titulo: document.querySelector('#heroTitle').textContent,
  }));
  ok(juntosFin.activa === 'tabJuntos' && juntosFin.ls === 'juntos' && juntosFin.modo === false && /¿Qué van a ver hoy\?/.test(juntosFin.titulo), 'de vuelta en Juntos (plural)');
  await sleep(900);
  const contJuntos = await pA.evaluate(() => ({
    visible: !document.querySelector('#continueBox').classList.contains('hidden'),
    n: document.querySelectorAll('#continueRow .cont-card').length,
  }));
  ok(!contJuntos.visible && contJuntos.n === 0, 'en Juntos no aparece lo visto en Solo (fila por pestaña)');
  await pA.evaluate(() => {
    window.__conecto = null;
    const orig = window.connect;
    window.connect = (...a) => { window.__conecto = a; }; /* espía: que no conecte de verdad */
    document.querySelector('#homeSearch').value = 'mayday';
    buscarInicio();
  });
  await pA.waitForSelector('#searchResults .sr-card', { timeout: 30000 });
  await pA.evaluate(() => {
    const c = [...document.querySelectorAll('#searchResults .sr-card')].find((x) => {
      const n = x.querySelector('.sr-nombre');
      return n && /mayday/i.test(n.textContent);
    });
    if (c) c.click();
  });
  await sleep(800);
  const autoSala = await pA.evaluate(() => ({
    llamo: !!window.__conecto,
    codigo: window.__conecto ? String(window.__conecto[0]) : '',
    cargando: !document.querySelector('#peliLoading').classList.contains('hidden'),
    pendiente: !!(S.pendingStart && S.pendingStart.url),
  }));
  ok(autoSala.llamo && /^[A-Z0-9]{5}$/.test(autoSala.codigo), `elegir una peli en Juntos crea la sala sola (código "${autoSala.codigo}")`);
  ok(autoSala.cargando && autoSala.pendiente, 'con su pantalla de carga y la peli pendiente de espejar');
  await pA.evaluate(() => {
    document.querySelector('#peliLoading').classList.add('hidden');
    S.pendingStart = null; S.mirrorInfo = null;
  });
  await pA.click('#tabSolo');
  await sleep(900);
  const contSoloFin = await pA.evaluate(() => ({
    visible: !document.querySelector('#continueBox').classList.contains('hidden'),
    n: document.querySelectorAll('#continueRow .cont-card').length,
  }));
  ok(contSoloFin.visible && contSoloFin.n >= 1, `en Solo sí aparece lo individual (${contSoloFin.n} tarjetas)`);
  /* ---------- v91: buscar una PELI en Solo → reproductor individual ---------- */
  if (cdnOK) {
    await pA.evaluate(() => {
      window.__conecto2 = null;
      const orig = window.connect;
      window.connect = (...a) => { window.__conecto2 = a; }; /* espía: NO debe conectarse */
      document.querySelector('#homeSearch').value = 'mayday';
      buscarInicio();
    });
    await pA.waitForSelector('#searchResults .sr-card', { timeout: 30000 });
    await pA.evaluate(() => {
      const c = [...document.querySelectorAll('#searchResults .sr-card')].find((x) => /mayday/i.test(x.querySelector('.sr-nombre').textContent));
      if (c) c.click();
    });
    await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 30000 });
    let bListo = false;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, dur: isFinite(v.duration) ? v.duration : 0 }; });
      if (st.rs >= 2 && st.t > 3 && st.dur > 60) { bListo = true; break; }
    }
    const bEstado = await pA.evaluate(() => ({
      conecto: !!window.__conecto2,
      cargando: !document.querySelector('#peliLoading').classList.contains('hidden'),
    }));
    ok(!bEstado.conecto && !bEstado.cargando && bListo, 'buscar una peli en Solo la reproduce individual (SIN armar sala)');
    await pA.evaluate(() => document.querySelector('#soloBack').click());
    await sleep(400);
  }

  /* ---------- v90: un ANIME de verdad, en Solo, sin navegador ---------- */
  const qsAn = 'name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token) + '&url=' + encodeURIComponent(ANIME);
  const animeRes = await fetch(BASE + '/api/solo?' + qsAn).then((r) => r.json()).catch(() => null);
  let animeOK = !!(animeRes && animeRes.ok && animeRes.mp4);
  if (animeOK) {
    try {
      const rng = await fetch(BASE + '/api/hls?u=' + encodeURIComponent(animeRes.m3u8), { headers: { Range: 'bytes=0-50000' } });
      if (!rng.ok || rng.status !== 206) animeOK = false;
    } catch { animeOK = false; }
  }
  console.log(animeOK ? '  · cadena anime (mp4upload) disponible' : '  · mp4upload racionando — checks en vivo del anime se omiten');
  if (animeOK) {
    ok(animeRes.proxy === true && /mp4upload\.com/i.test(animeRes.m3u8), '/api/solo resuelve el ANIME (mp4 directo de mp4upload)');
    /* el camino REAL: selector de episodios → un toque (antes: "se ven en Juntos") */
    await pA.evaluate((u) => { abrirSeriePicker({ title: 'Bleach: Sennen Kessen-hen', url: u, img: '' }, false, true); }, 'https://latanime.org/anime/bleach-sennen-kessen-hen-s4-latino');
    await pA.waitForSelector('#spEpisodios .sp-ep', { timeout: 30000 });
    const nEps = await pA.evaluate(() => document.querySelectorAll('#spEpisodios .sp-ep').length);
    ok(nEps >= 1, `selector de episodios del anime (${nEps})`);
    await pA.evaluate(() => document.querySelector('#spEpisodios .sp-ep').click());
    await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
    let anListo = false, anDiag = null;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const st = await pA.evaluate(() => {
        const v = document.querySelector('#soloVideo');
        return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0, src: v.currentSrc || v.src, ep: document.querySelector('#soloEp').textContent };
      });
      anDiag = st;
      if (st.rs >= 2 && st.t > 3 && st.dur > 300 && !st.pausa) { anListo = true; break; }
    }
    ok(anListo, 'el ANIME se reproduce en Solo (video nativo, SIN navegador)' + (anListo ? '' : ' — diag: ' + JSON.stringify(anDiag).slice(0, 140)));
    if (anListo) {
      ok(/\/api\/hls\?u=/.test(anDiag.src), 'va por el proxy (con el Referer que pide mp4upload)');
      ok(/Episodio 1/.test(anDiag.ep), `etiqueta del episodio ("${anDiag.ep}")`);
      /* moverse dentro del mp4 (Range) */
      const t0 = anDiag.t;
      await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); v.currentTime = Math.min(300, (v.duration || 600) * 0.3); });
      let seekOK = false;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const t = await pA.evaluate(() => document.querySelector('#soloVideo').currentTime);
        if (t > t0 + 30) { seekOK = true; break; }
      }
      ok(seekOK, 'se puede ADELANTAR dentro del mp4 (Range por el proxy)');
    }
    await pA.evaluate(() => document.querySelector('#soloBack').click());
    await sleep(1200);
    /* v91: la tarjeta de continuar del anime, con su póster cargado
     * (antes: doble proxy → "?" azul) */
    let posterOK = false, posterSrc = '';
    for (let i = 0; i < 8; i++) {
      const po = await pA.evaluate(() => {
        const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => /bleach/i.test(x.querySelector('.sr-nombre') ? x.querySelector('.sr-nombre').textContent : ''));
        if (!c) return null;
        const im = c.querySelector('img.sr-cover');
        return im ? { src: im.getAttribute('src'), w: im.naturalWidth, completa: im.complete } : { src: '', w: 0, completa: false };
      });
      if (po && po.w > 0) { posterOK = true; posterSrc = po.src; break; }
      if (po && po.src) posterSrc = po.src;
      await sleep(1000);
    }
    ok(posterOK, `la tarjeta de continuar del anime tiene su póster (${posterOK ? 'cargado' : 'ROTO: ' + posterSrc.slice(0, 70)})`);
    ok(!/u=%2Fapi%2Fimg/i.test(posterSrc) && /^\/api\/img\?u=https/.test(posterSrc), 'el póster va por UN solo nivel de proxy');
  }

  /* ---------- v93: animes con el mp4upload borrado — honesto y rápido ---------- */
  console.log('— v93: anime con servidores muertos —');
  const qsSolo = (u) => 'name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token) + '&url=' + encodeURIComponent(u);
  const tEva = Date.now();
  const evaRes = await fetch(BASE + '/api/solo?' + qsSolo(EVA_MUERTA)).then((r) => r.json()).catch(() => null);
  const evaSeg = (Date.now() - tEva) / 1000;
  ok(evaRes && !evaRes.ok && /caídos en Latanime/i.test(evaRes.error || ''), 'anime con TODOS los servidores muertos → mensaje claro y honesto');
  ok(evaSeg < 30, `falla rápido (${evaSeg.toFixed(1)}s — antes prometía un video roto)`);
  const evaViva = await fetch(BASE + '/api/solo?' + qsSolo(EVA_VIVA)).then((r) => r.json()).catch(() => null);
  ok(evaViva && evaViva.ok && evaViva.mp4 && /mp4upload/i.test(evaViva.m3u8 || ''), 'el Evangelion que SÍ tiene mp4upload vivo resuelve (30th Anniversary)');
  const conclave = await fetch(BASE + '/api/solo?' + qsSolo(CONCLAVE)).then((r) => r.json()).catch(() => null);
  ok(conclave && conclave.ok && /\.m3u8/.test(conclave.m3u8 || ''), 'Conclave resuelve (goodstream ya reintenta el cuerpo racionado)');

  /* ---------- v94: las series suenan en ESPAÑOL ---------- */
  console.log('— v94: audio español —');
  const fund = await fetch(BASE + '/api/solo?' + qsSolo(FUNDACION)).then((r) => r.json()).catch(() => null);
  ok(fund && fund.ok && /goodstream/i.test(fund.m3u8 || ''), 'Fundación 1x1 resuelve (goodstream, con pista en/ES)');
  if (fund && fund.ok) {
    await pA.evaluate((u) => { abrirSolo(u, { title: 'Fundación', serie: 'Fundación', ep: '1x1', eps: [{ url: u, ep: '1x1' }] }); }, FUNDACION);
    await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 15000 });
    let listoF = false, diagF = null;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const st = await pA.evaluate(() => {
        const v = document.querySelector('#soloVideo');
        const h = SOLO && SOLO.hls;
        return { rs: v.readyState, t: v.currentTime, pausa: v.paused, n: h ? (h.audioTracks || []).length : 0, sel: h ? h.audioTrack : -1, lang: h && h.audioTracks && h.audioTracks[h.audioTrack] ? h.audioTracks[h.audioTrack].lang : '' };
      }).catch(() => null);
      diagF = st;
      if (st && st.rs >= 2 && st.t > 3 && !st.pausa && st.lang === 'es') { listoF = true; break; }
    }
    ok(listoF, 'Fundación 1x1 reproduce en ESPAÑOL (latino) — antes arrancaba en inglés' + (listoF ? '' : ' — diag: ' + JSON.stringify(diagF)));
    await pA.evaluate(() => document.querySelector('#soloBack').click());
    await sleep(800);
  }

  /* ---------- v95: la tarjeta de continuar muestra el PÓSTER DE LA SERIE ---------- */
  console.log('— v95: póster en continuar-viendo —');
  /* flujo real: picker → episodio 1x3 (su still NO es el póster) */
  await pA.evaluate(() => { abrirSeriePicker({ title: 'Fundación', url: 'https://cine-calidad.mx/serie/fundacion', img: '' }, false, false); });
  await pA.waitForSelector('#spEpisodios .sp-ep', { timeout: 30000 });
  const stillId = await pA.evaluate(() => {
    const eps = [...document.querySelectorAll('#spEpisodios .sp-ep')];
    const im = eps[2] && eps[2].querySelector('img');
    return im ? (im.getAttribute('src').split('/').pop() || '') : '';
  });
  const ser = await fetch(BASE + '/api/serie/fundacion').then((r) => r.json()).catch(() => null);
  const posterId = ser && ser.poster ? ser.poster.split('/').pop() : '';
  ok(!!posterId && !!stillId && posterId !== stillId, 'el 1x3 tiene still propio distinto del póster (precondición)');
  await pA.evaluate(() => { const eps = [...document.querySelectorAll('#spEpisodios .sp-ep')]; (eps[2] || eps[0]).click(); });
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 15000 });
  let listoP = false, ultP = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => {
      const v = document.querySelector('#soloVideo');
      return { rs: v.readyState, t: v.currentTime, pausa: v.paused, abierto: !document.querySelector('#soloPlayer').classList.contains('hidden'), cargando: !document.querySelector('#soloCargando').classList.contains('hidden'), viaProxy: !!(SOLO && SOLO.viaProxy), reint: SOLO ? (SOLO.reintentos || 0) : 0 };
    });
    ultP = st;
    if (st.rs >= 2 && st.t > 4 && !st.pausa) { listoP = true; break; }
    if (!st.abierto) break;
  }
  ok(listoP, 'Fundación 1x3 reproduce tras el selector' + (listoP ? '' : ' (sandbox saturado — sigue por guardado directo)'));
  if (listoP) {
    await pA.evaluate(() => document.querySelector('#soloBack').click());
    await sleep(1500);
  } else {
    /* el video no arrancó (laboratorio saturado): guardamos la entrada
     * como el cliente viejo (con el still) — la cura v96 la convierte */
    await pA.evaluate(() => document.querySelector('#soloBack').click()).catch(() => {});
    await fetch(BASE + '/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: login.name, token: login.token, url: 'https://cine-calidad.mx/episode/fundacion-1x3/', t: 300, d: 3100, title: 'Fundación', img: 'https://image.tmdb.org/t/p/w342/' + stillId, ep: '1x3', serie: 'Fundación', modo: 'solo' }),
    }).catch(() => {});
    await sleep(600);
  }
  const cont = await pA.evaluate(async () => {
    await cargarContinuar();
    const card = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => {
      const e = x.querySelector('.cont-ep'); const n = x.querySelector('.sr-nombre');
      return e && /1x3/.test(e.textContent) && n && /fundaci/i.test(n.textContent);
    });
    if (!card) return null;
    const im = card.querySelector('img.sr-cover');
    return { src: im ? im.getAttribute('src') : '', cargada: im ? im.naturalWidth > 0 : false, nombre: card.querySelector('.sr-nombre').textContent };
  });
  ok(!!cont, 'la tarjeta de continuar de FUNDACIÓN 1x3 existe (no la de otra serie)');
  if (cont) {
    ok(posterId && cont.src.includes(posterId), 'la tarjeta muestra el PÓSTER de la serie (no el still de la escena)');
    ok(!cont.src.includes(stillId), 'el still del episodio ya no aparece en la tarjeta');
    ok(cont.cargada, 'el póster carga de verdad (' + cont.nombre + ')');
  }

  /* ---------- v96: las entradas VIEJAS se sanean en el servidor ---------- */
  console.log('— v96: cura de entradas viejas —');
  /* una entrada como las de antes: still de la escena, 1x10 */
  const rSan = await fetch(BASE + '/api/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: login.name, token: login.token, url: 'https://cine-calidad.mx/episode/fundacion-1x10/', t: 420, d: 2700, title: 'Fundación', img: 'https://image.tmdb.org/t/p/w342/stillViejoDe1x10.jpg', ep: '1x10', serie: 'Fundación', modo: 'solo' }),
  }).then((r) => r.json()).catch(() => null);
  ok(rSan && rSan.ok, 'guarda una entrada vieja (con still falso del 1x10)');
  const cSan = await fetch(BASE + '/api/continue?name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token)).then((r) => r.json()).catch(() => null);
  const eSan = ((cSan && cSan.items) || []).find((x) => /1x10/.test(x.ep || ''));
  ok(eSan && posterId && eSan.img.includes(posterId), 'al LEERLA ya sale el PÓSTER de la serie (saneada sin retomar nada)');
  ok(eSan && !/stillViejoDe1x10/.test(eSan.img || ''), 'el still falso ya no aparece');

  /* ---------- v92: SALA NATIVA — anfitrión + invitado, directo y sincronizado ---------- */
  if (cdnOK) {
    const errsC = [];
    const pC = await bA.newPage();
    pC.on('pageerror', (e) => errsC.push(String(e).slice(0, 80)));
    await pC.goto(BASE, { waitUntil: 'networkidle2' });
    await pC.evaluate(async () => {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Anfi' + Math.random().toString(36).slice(2, 6) }) });
      const d = await r.json();
      localStorage.setItem('rr-profile', JSON.stringify({ name: d.name, token: d.token }));
      localStorage.setItem('huddle_tab', 'juntos');
    });
    await pC.reload({ waitUntil: 'networkidle2' });
    const tClick = Date.now();
    await pC.evaluate(() => { document.querySelector('#homeSearch').value = 'mayday'; buscarInicio(); });
    await pC.waitForSelector('#searchResults .sr-card', { timeout: 30000 });
    await pC.evaluate(() => {
      const c = [...document.querySelectorAll('#searchResults .sr-card')].find((x) => /mayday/i.test(x.querySelector('.sr-nombre').textContent));
      if (c) c.click();
    });
    let code = '';
    for (let i = 0; i < 25; i++) { await sleep(1000); code = await pC.evaluate(() => (S.room && S.code) || ''); if (code) break; }
    ok(!!code, `sala creada al elegir la peli ("${code}")`);
    let natC = false;
    for (let i = 0; i < 40; i++) { await sleep(1000); natC = await pC.evaluate(() => !!(S.nativo && S.nativo.url)); if (natC) break; }
    ok(natC, 'la sala entró en modo NATIVO (video directo, sin navegador remoto)');
    /* el invitado se une */
    const pD = await bA.newPage();
    await pD.goto(BASE, { waitUntil: 'networkidle2' });
    await pD.evaluate(async () => {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Invi' + Math.random().toString(36).slice(2, 6) }) });
      const d = await r.json();
      localStorage.setItem('rr-profile', JSON.stringify({ name: d.name, token: d.token }));
    });
    await pD.evaluate((c) => connect(c), code);
    let natD = false;
    for (let i = 0; i < 40; i++) { await sleep(1000); natD = await pD.evaluate(() => !!(S.nativo && S.nativo.url)); if (natD) break; }
    ok(natD, 'el invitado también recibe el modo nativo');
    /* ambos reproduciendo */
    const esperaVid = async (p) => {
      for (let i = 0; i < 45; i++) {
        await sleep(2000);
        const st = await p.evaluate(() => { const v = document.querySelector('#roomVideo'); return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0 }; });
        if (st.rs >= 2 && st.t > 2 && !st.pausa && st.dur > 60) return st;
      }
      return null;
    };
    const vC = await esperaVid(pC);
    ok(!!vC, 'el anfitrión reproduce el video directo en la sala');
    const vD = await esperaVid(pD);
    ok(!!vD, 'el invitado reproduce lo mismo, sincronizado');
    /* pantalla de carga: mínimo 5s (sin destello) */
    let cargando = await pC.evaluate(() => !document.querySelector('#peliLoading').classList.contains('hidden'));
    for (let i = 0; i < 20 && cargando; i++) { await sleep(500); cargando = await pC.evaluate(() => !document.querySelector('#peliLoading').classList.contains('hidden')); }
    const durCarga = (Date.now() - tClick) / 1000;
    ok(!cargando && durCarga >= 4.8, `la pantalla de carga se fue tras ${durCarga.toFixed(1)}s (respeta el mínimo de 5s)`);
    /* pausa del anfitrión → el invitado se pausa */
    await pC.evaluate(() => sendAction({ type: 'pause' }));
    let pausaD = false;
    for (let i = 0; i < 10; i++) { await sleep(800); pausaD = await pD.evaluate(() => document.querySelector('#roomVideo').paused); if (pausaD) break; }
    ok(pausaD, 'el anfitrión pausa → el invitado se pausa');
    /* adelantar → el invitado lo sigue */
    await pC.evaluate(() => sendAction({ type: 'seek', position: 240 }));
    let seekD = false, tD = 0;
    for (let i = 0; i < 15; i++) { await sleep(1000); tD = await pD.evaluate(() => document.querySelector('#roomVideo').currentTime); if (Math.abs(tD - 240) < 8) { seekD = true; break; } }
    ok(seekD, `el anfitrión adelanta a 4:00 → el invitado queda en ${tD.toFixed(0)}s`);
    /* detener → la sala vuelve a su inicio */
    await pC.evaluate(() => sendAction({ type: 'video', url: '' }));
    await sleep(1500);
    const finC = await pC.evaluate(() => ({ nativo: !!S.nativo, vacio: !document.querySelector('#videoEmpty').classList.contains('hidden'), video: document.querySelector('#roomVideo').classList.contains('hidden') }));
    ok(!finC.nativo && finC.vacio && finC.video, 'detener devuelve la sala a su inicio (video nativo fuera)');
    ok(errsC.length === 0, `sin errores de página en la sala nativa (${errsC.length})`);
    await pC.close();
    await pD.close();
  }
  ok(errsA.length === 0, `sin errores de página en A (${errsA.length})`);
  await bA.close();

  /* ---------- USUARIO M: celular — velocidad + siguiente ---------- */
  console.log('— Usuario M: reproductor individual (celular 390x844) —');
  await sleep(3000);
  const bM = await puppeteer.launch({ headless: 'new', protocolTimeout: 180000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const pM = await bM.newPage();
  await pM.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const errsM = [];
  pM.on('pageerror', (e) => errsM.push(String(e)));
  await pM.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const loginM = await pM.evaluate(async (nombre) => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nombre }) });
    const d = await r.json();
    localStorage.setItem('rr-profile', JSON.stringify({ name: d.name, token: d.token }));
    localStorage.setItem('huddle_modo_solo', '1');
    localStorage.setItem('huddle_rate', '1.5'); /* viene de "otra sesión" a 1.5x */
    return d;
  }, NOMBRE_M);
  ok(!!loginM.token, `M logueada (${NOMBRE_M})`);
  await pM.reload({ waitUntil: 'networkidle2' });
  await pM.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  const tabM = await pM.evaluate(() => ({
    activa: document.querySelector('.modo-tab.activa') ? document.querySelector('.modo-tab.activa').id : '',
    ls: localStorage.getItem('huddle_tab'),
  }));
  ok(tabM.activa === 'tabSolo' && tabM.ls === 'solo', 'en el celular el modo Solo se recuerda (migración del toggle viejo)');
  /* v89: sin Fullscreen API en el laboratorio (determinista) — en el
   * celular real sí existe y se pide al abrir */
  await pM.evaluate(() => { try { window.Element.prototype.requestFullscreen = undefined; window.Element.prototype.webkitRequestFullscreen = undefined; } catch {} });
  await pM.evaluate((url, eps) => { abrirSolo(url, { title: 'Prueba local', serie: 'Prueba local', ep: '1x1', eps }); }, PELI_LOCAL, EPS_PRUEBA);
  await pM.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let listoM = false, diagM = null;
  for (let i = 0; i < 50; i++) {
    await sleep(2000);
    const st = await pM.evaluate(() => {
      const v = document.querySelector('#soloVideo');
      return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0, player: !document.querySelector('#soloPlayer').classList.contains('hidden') };
    });
    diagM = st;
    if (st.rs >= 2 && st.t > 2 && st.dur > 60 && !st.pausa) { listoM = true; break; }
    if (!st.player) break;
  }
  ok(listoM, 'en el celular el video reproduce directo' + (listoM ? '' : ' — diagnóstico: ' + JSON.stringify(diagM)));
  /* v88: celular VERTICAL → el reproductor se ve girado (siempre horizontal) */
  const giradoM = await pM.evaluate(() => ({
    clase: document.body.classList.contains('solo-girado'),
    transform: getComputedStyle(document.querySelector('#soloPlayer')).transform,
    w: Math.round(document.querySelector('#soloPlayer').getBoundingClientRect().width),
  }));
  ok(giradoM.clase && /matrix\(0, 1, -1, 0/.test(giradoM.transform) && giradoM.w === 390, 'celular vertical → reproductor girado (horizontal forzado, como la sala)');
  /* v89: voltear el teléfono → el video se endereza SIN cerrarse nada */
  await pM.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  let endereza = false;
  for (let i = 0; i < 12; i++) { await sleep(400); endereza = await pM.evaluate(() => !document.body.classList.contains('solo-girado')); if (endereza) break; }
  ok(endereza, 'al voltear el celular se endereza (sigue acostado, sin saltos)');
  const vivoVolteado = await pM.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, pausa: v.paused, abierto: !document.querySelector('#soloPlayer').classList.contains('hidden') }; });
  ok(vivoVolteado.abierto && vivoVolteado.rs >= 2 && !vivoVolteado.pausa, 'la película sigue reproduciéndose al voltear');
  /* y de vuelta al vertical se acuesta sola */
  await pM.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  let reacosta = false;
  for (let i = 0; i < 12; i++) { await sleep(400); reacosta = await pM.evaluate(() => document.body.classList.contains('solo-girado')); if (reacosta) break; }
  ok(reacosta, 'de vuelta en vertical se acuesta sola');
  const uiM = await pM.evaluate(() => {
    document.querySelector('#soloPlayer').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return {
      w: document.querySelector('#soloPlayer').getBoundingClientRect().width,
      rate: document.querySelector('#soloVideo').playbackRate,
      btn: document.querySelector('#soloRate').textContent,
      next: !document.querySelector('#soloNext').classList.contains('hidden'),
      fila: getComputedStyle(document.querySelector('#soloCtrls')).gap,
    };
  });
  ok(uiM.w === 390, `a pantalla completa del celular (${uiM.w}px)`);
  ok(uiM.rate === 1.5 && uiM.btn === '1.5x', `la velocidad guardada se aplica también en el celular (${uiM.rate})`);
  ok(uiM.next, '"Sig. ▸" visible en el celular');
  ok(/6px/.test(uiM.fila), `controles densos en móvil (gap ${uiM.fila})`);
  /* menú de velocidad en el celular */
  await pM.evaluate(() => { document.querySelector('#soloRate').click(); });
  const rMenuM = await pM.evaluate(() => ({
    abierto: !document.querySelector('#soloRateMenu').classList.contains('hidden'),
    items: [...document.querySelectorAll('#soloRateMenu .solo-qitem')].length,
  }));
  ok(rMenuM.abierto && rMenuM.items === 5, `menú de velocidad en el celular (${rMenuM.items} opciones)`);
  await pM.evaluate(() => { [...document.querySelectorAll('#soloRateMenu .solo-qitem')].find((b) => /^1x/.test(b.textContent)).click(); });
  const rMnormal = await pM.evaluate(() => document.querySelector('#soloVideo').playbackRate);
  ok(rMnormal === 1, `vuelve a 1x desde el celular (rate ${rMnormal})`);
  /* v88: destello ±10s con icono SVG (nada de emojis) */
  await pM.evaluate(() => {
    const r = document.querySelector('#soloPlayer').getBoundingClientRect();
    const opts = (x) => ({ bubbles: true, pointerId: 11, isPrimary: true, pointerType: 'touch', clientX: x, clientY: r.top + r.height / 2 });
    const v = document.querySelector('#soloVideo');
    v.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width * 0.8)));
    setTimeout(() => v.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width * 0.8))), 140);
  });
  await sleep(800);
  const flashM = await pM.evaluate(() => {
    const f = document.querySelector('#soloFlash');
    return { svg: !!f.querySelector('svg'), emoji: /[\u23EA\u23E9]/.test(f.textContent), anim: f.classList.contains('anim'), txt: f.textContent.trim() };
  });
  ok(flashM.svg && !flashM.emoji && flashM.anim && /10 s/.test(flashM.txt), `destello ±10s con icono SVG ("${flashM.txt}")`);
  await pM.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(500);
  const cerrM = await pM.evaluate(() => document.querySelector('#soloPlayer').classList.contains('hidden'));
  ok(cerrM, '✕ cierra también en el celular');
  const sinGiroM = await pM.evaluate(() => !document.body.classList.contains('solo-girado'));
  ok(sinGiroM, 'al cerrar el reproductor se quita el giro');
  /* v88: continuar-viendo por pestaña también en el celular */
  await sleep(1000);
  const contM = await pM.evaluate(async () => {
    const solo = { visible: !document.querySelector('#continueBox').classList.contains('hidden'), n: document.querySelectorAll('#continueRow .cont-card').length };
    document.querySelector('#tabJuntos').click();
    await new Promise((r) => setTimeout(r, 900));
    const juntos = { visible: !document.querySelector('#continueBox').classList.contains('hidden'), n: document.querySelectorAll('#continueRow .cont-card').length };
    document.querySelector('#tabSolo').click();
    await new Promise((r) => setTimeout(r, 900));
    return { solo, juntos };
  });
  ok(contM.solo.visible && contM.solo.n >= 1 && !contM.juntos.visible, `continuar-viendo por pestaña también en el celular (${contM.solo.n} en Solo, ${contM.juntos.n} en Juntos)`);
  /* v88: con el celular ACOSTADO el inicio se ve vertical (girado) */
  await pM.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  await sleep(1100);
  const homeLadoM = await pM.evaluate(() => ({
    movHoriz: document.body.classList.contains('movil-horizontal'),
    girado: /matrix\(0, -?1, -?1, 0/.test(getComputedStyle(document.querySelector('#homeFull')).transform),
    w: Math.round(document.querySelector('#homeFull').getBoundingClientRect().width),
  }));
  ok(homeLadoM.movHoriz && homeLadoM.girado && homeLadoM.w === 844, 'celular acostado → el inicio se gira y se ve vertical');
  await pM.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await sleep(900);
  const homeParaM = await pM.evaluate(() => !document.body.classList.contains('movil-horizontal'));
  ok(homeParaM, 'celular vertical de nuevo → inicio normal');
  ok(errsM.length === 0, `sin errores de página en M (${errsM.length})`);
  await bM.close();

  /* ---------- resultado ---------- */
  console.log(fallos === 0 ? `\nTODO-OK (${fallos} fallos)` : `\n${fallos} FALLOS`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(2); });
