/* E2E v83: doble toque a los lados = ±10s (como YouTube, con su
 * destello), doble clic = pantalla completa en escritorio, y selector
 * de calidad Auto/480p/360p (niveles de hls.js) para cuidar los datos
 * + todo v82/v81. */
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const RUN = String(Date.now()).slice(-4);
const NOMBRE_A = 'Ana' + RUN, NOMBRE_M = 'Mobi' + RUN;
const PELI = 'https://cine-calidad.mx/pelicula/mayday/'; /* goodstream (viva 2026-09-08) */
const PELI_LOCAL = '/test-media/master.m3u8'; /* v83: fixture HLS propio — determinista */
const SERIE = 'peaky-blinders'; /* para probar picker→episodio en solo */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) fallos++; };

(async () => {
  /* ---------- 0) estáticos v81 ---------- */
  console.log('— Código v81 —');
  const idx = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/style.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');
  const srv = fs.readFileSync('server.js', 'utf8');
  ok(srv.includes("const UI_VERSION = 'v83'"), 'servidor en v83');
  ok(js.includes("const APP_VERSION = 'v83'"), 'cliente en v83');
  ok(idx.includes('id="verBadge">v83'), 'badge v83');
  ok(idx.includes('/app.js?v=83') && idx.includes('/style.css?v=83'), 'cache-busters v83');
  /* hls.js vendored */
  const hlsStat = fs.statSync('public/hls.min.js');
  const hlsSrc = fs.readFileSync('public/hls.min.js', 'utf8');
  ok(hlsStat.size > 300000, `hls.js vendored (${(hlsStat.size / 1024).toFixed(0)} KB)`);
  ok(/1\.5\.17/.test(hlsSrc), 'hls.js 1.5.17');
  /* HTML del reproductor */
  ok(idx.includes('id="modoPills"') && idx.includes('id="pillJuntos"') && idx.includes('id="pillSolo"'), 'HTML: toggle 👥 Juntos / 🎬 Solo');
  ok(idx.includes('👥 Juntos') && idx.includes('🎬 Solo'), 'labels del toggle');
  ok(idx.includes('id="soloPlayer"') && idx.includes('id="soloVideo"') && idx.includes('id="soloBack"') && idx.includes('id="soloBar"') && idx.includes('id="soloCC"') && idx.includes('id="soloFs"') && idx.includes('id="soloPlay"'), 'HTML: reproductor individual completo');
  ok(idx.includes('Modo individual'), 'badge "Modo individual" en el reproductor');
  /* JS del reproductor */
  ok(js.includes('huddle_modo_solo') && js.includes('function setModoSolo') && js.includes('function pintarModoPills'), 'JS: toggle persistido (localStorage)');
  ok(js.includes('async function abrirSolo') && js.includes('function montarSolo') && js.includes('function cerrarSolo'), 'JS: abrir/montar/cerrar el reproductor');
  ok(js.includes("'/hls.min.js'") && js.includes('window.Hls.isSupported()'), 'JS: hls.js vendored con HLS nativo de respaldo');
  ok(js.includes('montarSolo(SOLO.res, true)') && js.includes("ErrorTypes.NETWORK_ERROR"), 'JS: fallback automático al proxy /api/hls');
  ok(js.includes("'/api/progress'") && js.includes("modo: 'solo'"), 'JS: reporta el progreso cada 10s (modo solo)');
  ok(js.includes("e.modo === 'solo'") && js.includes('startAt: reanudar ? t : 0'), 'JS: Continuar reanuda en el reproductor individual');
  ok(js.includes('S.modoSolo') && js.includes('abrirSolo(res.url'), 'JS: tarjetas y búsqueda abren en modo individual');
  ok(js.includes('Los animes se ven en modo 👥 Juntos'), 'JS: animes avisados que van en sala');
  ok(js.includes('ponerSubsSolo') && js.includes("kind = 'subtitles'"), 'JS: subtítulos VTT');
  /* CSS */
  ok(css.includes('.modo-pills') && css.includes('.modo-pill.activa'), 'CSS: pastillas del modo');
  /* v82 */
  ok(idx.includes('id="soloTop"'), 'HTML: barra de arriba con id');
  ok(css.includes('.solo-top.oculto'), 'CSS: la barra de arriba también se esconde');
  ok(js.includes("SOLO.lastT = video.currentTime"), 'JS: se recuerda el minuto por si reconecta');
  ok(js.includes('const reSeek') && js.includes('const reT = SOLO.seekHecho ? Math.max(SOLO.lastT || 0, SOLO.tReconexion || 0)') && js.includes('reT < video.duration - 10'), 'JS: al reconectar vuelve a su minuto (congelado y a prueba de reintentos)');
  ok(js.includes("'Reanudando en ' + fmtTiempo(SOLO.startAt)"), 'JS: aviso "Reanudando en mm:ss"');
  ok(js.includes('modo individual — el celular acostado se amplía solo'), 'JS: celular acostado → pantalla completa (como v76)');
  ok(js.includes('mientras arrastras, los controles no se esconden'), 'JS: arrastrar la barra no esconde controles');
  ok(js.includes("const t = $('#soloTop'); /* v82: la barra de arriba también se va con los controles */"), 'JS: top y controles se esconden juntos');
  /* v83 */
  ok(idx.includes('id="soloQ"') && idx.includes('id="soloQMenu"') && idx.includes('id="soloFlash"'), 'HTML: botón de calidad, menú y destello de doble toque');
  ok(js.includes("soloVideo').addEventListener('pointerdown'") && !js.includes("soloVideo').addEventListener('click'"), 'JS: toques por pointerdown (soporta doble toque)');
  ok(js.includes('v.currentTime - 10') && js.includes('v.currentTime + 10') && js.includes('soloFlashSeek(-10)'), 'JS: doble toque a los lados = \u00b110s');
  ok(js.includes('tipo === \'mouse\') soloToggleFs()') || js.includes("tipo === 'mouse') soloToggleFs()"), 'JS: doble clic en escritorio = pantalla completa');
  ok(js.includes('function soloToggleFs') && js.includes("$('#soloFs').addEventListener('click', soloToggleFs)"), 'JS: pantalla completa reutilizable');
  ok(js.includes('MANIFEST_PARSED') && js.includes('pintarQMenuSolo') && js.includes('hls.nextLevel = it.i'), 'JS: menú de calidad con los niveles de hls.js');
  ok(js.includes('Calidad: ') && js.includes('Auto'), 'JS: toasts de calidad');
  ok(css.includes('.solo-qmenu') && css.includes('.solo-qitem') && css.includes('.solo-flash'), 'CSS: menú de calidad + destello');
  ok(js.includes('cerrarQMenuSolo(); /* v83: el menú no se queda flotando solo */'), 'JS: el menú se cierra con los controles');
  ok(css.includes('.solo-player') && css.includes('.solo-ctrls.oculto') && css.includes('.cont-modo'), 'CSS: reproductor + auto-ocultar + chip "solo"');
  /* servidor */
  ok(srv.includes('function resolverSolo') && srv.includes('function decodificarDataSrc'), 'server: resolvedor directo (data-src de cuevana)');
  ok(srv.includes("'/api/solo'") && srv.includes("'/api/hls'") && srv.includes("'/api/progress'"), 'server: rutas /api/solo /api/hls /api/progress');
  ok(srv.includes('esGoodstream') && srv.includes('goodstream\\.one'), 'server: proxy solo para goodstream (allowlist)');
  ok(srv.includes('URI="([^"]+)"') && srv.includes('prox(s)'), 'server: proxy reescribe los m3u8 (URIs y líneas)');
  ok(srv.includes("modo: body.modo === 'solo' ? 'solo' : ''"), 'server: guarda el modo en continuar-viendo');
  ok(srv.includes('modo: e.modo || \'\''), 'server: /api/continue devuelve el modo');

  /* ---------- 0b) APIs v81 ---------- */
  console.log('— APIs v81 —');
  /* login de prueba para los tokens */
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
  /* /api/solo sin auth → 403 */
  const soloX = await fetch(BASE + '/api/solo?url=' + encodeURIComponent(PELI)).catch(() => null);
  ok(!!soloX && soloX.status === 403, '/api/solo exige perfil (403)');
  if (cdnOK) {
    ok(!!solo && solo.ok === true, '/api/solo resuelve la peli SIN navegador');
    ok(!!solo && /goodstream\.one\/.*\.m3u8/i.test(solo.m3u8 || ''), `m3u8 goodstream (${solo ? (solo.m3u8 || '').slice(8, 60) + '…' : '—'})`);
    ok(!!solo && (solo.subs || []).length >= 1, `/api/solo trae subtítulos (${solo ? (solo.subs || []).length : 0} VTT)`);
    ok(!!solo && (solo.subs || []).some((s) => s.lang === 'es' || s.lang === 'es-419'), 'un VTT en español entre los subtítulos');
  }
  /* /api/hls allowlist */
  const hlsX = await fetch(BASE + '/api/hls?u=' + encodeURIComponent('https://www.google.com/video.m3u8')).catch(() => null);
  ok(!!hlsX && hlsX.status === 403, '/api/hls rechaza hosts fuera de goodstream (403)');
  /* v83: el proxy también sirve y reescribe nuestro m3u8 LOCAL (determinista) */
  const hlsL = await fetch(BASE + '/api/hls?u=' + encodeURIComponent(PELI_LOCAL)).catch(() => null);
  const hlsLTxt = hlsL ? await hlsL.text() : '';
  ok(!!hlsL && hlsL.ok && hlsLTxt.includes('/api/hls?u='), 'proxy sirve el master local reescrito');
  const varL = (hlsLTxt.match(/\/api\/hls\?u=(%2F[^"'" \n]+)/) || [])[1];
  const varLR = varL ? await fetch(BASE + '/api/hls?u=' + varL).catch(() => null) : null;
  const varLTxt = varLR ? await varLR.text() : '';
  const segL = (varLTxt.match(/\/api\/hls\?u=(%2F[^"'" \n]+)/) || [])[1];
  const segLR = segL ? await fetch(BASE + '/api/hls?u=' + segL).then((r) => r.arrayBuffer().then((b) => ({ ok: r.ok, ct: r.headers.get('content-type'), b }))).catch(() => null) : null;
  ok(!!varLR && varLR.ok && varLTxt.includes('.ts'), 'proxy: variante local reescrita');
  ok(!!segLR && segLR.ok && /video|mp2t|octet/i.test(segLR.ct || '') && segLR.b.byteLength > 10000, `segmento local por el proxy (${segLR ? segLR.ct : '—'}, ${(segLR ? segLR.b.byteLength / 1024 : 0).toFixed(0)} KB)`);
  /* /api/hls sirve el master reescrito (goodstream, si la CDN nos sirve) */
  const m3u8 = cdnOK && solo ? solo.m3u8 : '';
  const hlsR = m3u8 ? await fetch(BASE + '/api/hls?u=' + encodeURIComponent(m3u8)).catch(() => null) : null;
  const hlsTxt = hlsR ? await hlsR.text() : '';
  ok(!!hlsR && hlsR.ok, `/api/hls sirve el master (${hlsR ? hlsR.status : '—'})` + (cdnOK ? '' : ' — omitido, CDN racionando'));
  ok(!cdnOK || /mpegurl/i.test(hlsR ? (hlsR.headers.get('content-type') || '') : ''), 'content-type del master: application/vnd.apple.mpegurl');
  ok(!cdnOK || hlsTxt.includes('/api/hls?u='), 'master reescrito hacia el proxy');
  /* una variante reescrita también */
  const variante = (hlsTxt.match(/\/api\/hls\?u=(https[^'" \n]+)/) || [])[1];
  const varR = variante ? await fetch(BASE + '/api/hls?u=' + variante).catch(() => null) : null;
  const varTxt = varR ? await varR.text() : '';
  ok(!cdnOK || (!!varR && varR.ok && varTxt.includes('/api/hls?u=')), 'variante (480p/360p) también reescrita' + (cdnOK ? '' : ' — omitida'));
  /* un segmento por el proxy — con reintentos: goodstream a veces
   * suelta 403 por ráfagas (lo vimos en las corridas) */
  let segBuf = null;
  for (let intento = 0; intento < 3 && !(segBuf && segBuf.ok && segBuf.b.byteLength > 10000); intento++) {
    if (intento > 0) await sleep(8000);
    const segs = [...varTxt.matchAll(/\/api\/hls\?u=(https[^'" \n]+)/g)].map((m) => decodeURIComponent(m[1])).filter((u) => !/\.m3u8(\?|$)/i.test(u));
    const seg = segs[0];
    segBuf = seg ? await fetch(BASE + '/api/hls?u=' + encodeURIComponent(seg)).then((r) => r.arrayBuffer().then((b) => ({ ok: r.ok, ct: r.headers.get('content-type'), b }))).catch(() => null) : null;
  }
  ok(!cdnOK || (!!segBuf && segBuf.ok && /video|mp2t|octet/i.test(segBuf.ct || '') && segBuf.b.byteLength > 10000), `segmento por el proxy (${segBuf ? segBuf.ct : '—'}, ${(segBuf ? segBuf.b.byteLength / 1024 : 0).toFixed(0)} KB)` + (cdnOK ? '' : ' — omitido'));
  /* /api/progress auth + upsert */
  const progX = await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: 'churro', url: PELI, t: 100, d: 600 }) }).catch(() => null);
  ok(!!progX && progX.status === 403, '/api/progress exige token bueno (403)');
  const prog1 = await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: PELI, t: 120, d: 600, title: 'Mayday', modo: 'solo' }) }).then((r) => r.json()).catch(() => null);
  ok(!!prog1 && prog1.ok, '/api/progress guarda (t=120)');
  const cont1 = await fetch(BASE + '/api/continue?name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token)).then((r) => r.json()).catch(() => null);
  const ent1 = cont1 && (cont1.items || []).find((e) => e.url === PELI);
  ok(!!ent1 && ent1.modo === 'solo' && ent1.t === 120, `continuar-viendo lo trae como solo (t=${ent1 ? ent1.t : '—'})`);
  const prog2 = await fetch(BASE + '/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: login.name, token: login.token, url: PELI, t: 200, d: 600, title: 'Mayday', modo: 'solo' }) }).then((r) => r.json()).catch(() => null);
  const cont2 = await fetch(BASE + '/api/continue?name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token)).then((r) => r.json()).catch(() => null);
  const ent2 = cont2 && (cont2.items || []).find((e) => e.url === PELI);
  ok(!!ent2 && ent2.t === 200 && (cont2.items || []).filter((e) => e.url === PELI).length === 1, `upsert: t pasa de 120 → ${ent2 ? ent2.t : '—'} sin duplicados`);

  /* ---------- USUARIO A: escritorio — el reproductor completo ---------- */
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

  /* toggle Juntos/Solo */
  const pills0 = await pA.evaluate(() => ({
    visible: !!document.querySelector('#modoPills'),
    juntos: document.querySelector('#pillJuntos').classList.contains('activa'),
    solo: document.querySelector('#pillSolo').classList.contains('activa'),
  }));
  ok(pills0.visible && pills0.juntos && !pills0.solo, 'toggle visible, Juntos activo por default');
  await pA.click('#pillSolo');
  const pills1 = await pA.evaluate(() => ({
    solo: document.querySelector('#pillSolo').classList.contains('activa'),
    juntos: !document.querySelector('#pillJuntos').classList.contains('activa'),
    ls: localStorage.getItem('huddle_modo_solo'),
    sub: document.querySelector('.home-sub').textContent,
  }));
  ok(pills1.solo && pills1.juntos && pills1.ls === '1', 'Solo se activa y se guarda (localStorage)');
  ok(/Modo individual/.test(pills1.sub), 'texto del inicio anuncia el modo individual');

  /* abrir la peli en modo individual — con el fixture local (determinista;
   * la cadena real goodstream ya se probó arriba / en corridas previas) */
  await pA.evaluate((url) => { abrirSolo(url, { title: 'Prueba local' }); }, PELI_LOCAL);
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
      return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0, proxy: (typeof SOLO !== 'undefined' && SOLO) ? SOLO.viaProxy : null, hls: (typeof SOLO !== 'undefined' && SOLO) ? !!SOLO.hls : null, cargando: !document.querySelector('#soloCargando').classList.contains('hidden'), reintentos: (typeof SOLO !== 'undefined' && SOLO) ? SOLO.reintentos : null };
    });
    viaProxy = st.proxy; usoHls = st.hls; diagA = st;
    if (st.rs >= 2 && st.t > 3 && st.dur > 60 && !st.pausa) { listo = true; break; }
  }
  ok(listo, 'el video REPRODUCE directo en el navegador (hls.js=' + usoHls + ', proxy=' + viaProxy + ')' + (listo ? '' : ' — diagnóstico: ' + JSON.stringify(diagA)));
  const t1 = await pA.evaluate(() => document.querySelector('#soloVideo').currentTime);
  await sleep(4000);
  const t2 = await pA.evaluate(() => document.querySelector('#soloVideo').currentTime);
  ok(t2 - t1 >= 2.5, `avanza en tiempo real (${t1.toFixed(1)}s → ${t2.toFixed(1)}s)`);
  const dur = await pA.evaluate(() => document.querySelector('#soloVideo').duration);
  ok(dur > 60, `duración real de la peli (${(dur / 60).toFixed(0)} min)`);
  /* barra de tiempo */
  const uiA = await pA.evaluate(() => ({
    cargando: document.querySelector('#soloCargando').classList.contains('hidden'),
    time: document.querySelector('#soloTime').textContent,
    bar: +document.querySelector('#soloBar').value,
    cc: !document.querySelector('#soloCC').classList.contains('hidden'),
  }));
  ok(uiA.cargando, 'spinner se fue cuando arrancó');
  ok(/\d+:\d+ \/ \d+:\d+/.test(uiA.time), `tiempo pintado ("${uiA.time}")`);
  ok(uiA.bar > 0, `barra en posición (${uiA.bar}/1000)`);
  ok(uiA.cc, 'botón CC (la peli trae subtítulos)');

  /* v83: selector de calidad */
  await sleep(1500); /* que llegue el MANIFEST_PARSED */
  const qA = await pA.evaluate(() => ({
    visible: !document.querySelector('#soloQ').classList.contains('hidden'),
    niveles: (SOLO && SOLO.hls && SOLO.hls.levels ? SOLO.hls.levels.length : 0),
    auto: SOLO && SOLO.hls ? SOLO.hls.autoLevelEnabled : null,
  }));
  ok(qA.visible && qA.niveles >= 2, `botón de calidad con ${qA.niveles} niveles (${qA.auto ? 'auto' : 'fijo'})`);
  await pA.evaluate(() => { document.querySelector('#soloQ').click(); });
  const qMenu = await pA.evaluate(() => ({
    abierto: !document.querySelector('#soloQMenu').classList.contains('hidden'),
    items: [...document.querySelectorAll('#soloQMenu .solo-qitem')].map((b) => b.textContent),
  }));
  ok(qMenu.abierto && qMenu.items.length >= 3, `menú de calidad: ${qMenu.items.join(' / ')}`);
  ok(qMenu.items[0] === 'Auto', 'primera opción: Auto');
  if (qMenu.items.length < 2) { /* sin niveles (¿tormenta?): no truene el resto */ 
    ok(false, 'sin niveles de calidad disponibles — salto los clicks');
  }
  const hayItems = await pA.evaluate(() => document.querySelectorAll('#soloQMenu .solo-qitem').length);
  if (hayItems >= 2) await pA.evaluate(() => {
    const b = [...document.querySelectorAll('#soloQMenu .solo-qitem')].find((x) => x.textContent !== 'Auto');
    if (b) b.click(); /* la más baja (orden descendente): cuida datos */
  });
  let qFija = await pA.evaluate(() => ({
    auto: SOLO.hls.autoLevelEnabled,
    nivel: SOLO.hls.currentLevel,
    btn: document.querySelector('#soloQ').textContent,
    cerrado: document.querySelector('#soloQMenu').classList.contains('hidden'),
  }));
  if (qFija.auto) { /* ¿un remount nos regresó a Auto? reintentamos una vez */
    await sleep(2000);
    await pA.evaluate(() => { document.querySelector('#soloQ').click(); const b = [...document.querySelectorAll('#soloQMenu .solo-qitem')].find((x) => x.textContent !== 'Auto'); if (b) b.click(); });
    qFija = await pA.evaluate(() => ({ auto: SOLO.hls.autoLevelEnabled, nivel: SOLO.hls.currentLevel, btn: document.querySelector('#soloQ').textContent, cerrado: document.querySelector('#soloQMenu').classList.contains('hidden') }));
  }
  ok(!qFija.auto && qFija.nivel >= 0 && qFija.cerrado, `calidad fijada en "${qFija.btn}" (nivel ${qFija.nivel}, ya no auto)`);
  if (hayItems >= 2) {
    await pA.evaluate(() => { document.querySelector('#soloQ').click(); const a = [...document.querySelectorAll('#soloQMenu .solo-qitem')].find((x) => x.textContent === 'Auto'); if (a) a.click(); });
    const qAuto = await pA.evaluate(() => ({ auto: SOLO.hls.autoLevelEnabled, btn: document.querySelector('#soloQ').textContent }));
    ok(qAuto.auto && qAuto.btn === 'Auto', 'de vuelta en Auto');
  }

  /* v83: doble toque = \u00b110s (toques touch sintéticos a los lados) */
  const tAntes = await pA.evaluate(() => Math.floor(document.querySelector('#soloVideo').currentTime));
  await pA.evaluate(() => {
    const r = document.querySelector('#soloPlayer').getBoundingClientRect();
    const opts = (x) => ({ bubbles: true, pointerId: 7, isPrimary: true, pointerType: 'touch', clientX: x, clientY: r.top + r.height / 2 });
    const v = document.querySelector('#soloVideo');
    v.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width * 0.8)));
    setTimeout(() => v.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width * 0.8))), 140);
  });
  await sleep(600);
  const tMas = await pA.evaluate(() => ({ t: Math.floor(document.querySelector('#soloVideo').currentTime), flash: document.querySelector('#soloFlash').classList.contains('anim') }));
  ok(tMas.t - tAntes >= 8 && tMas.t - tAntes <= 13 && tMas.flash, `doble toque a la derecha: +10s con destello (${tAntes}s → ${tMas.t}s)`);
  await pA.evaluate(() => {
    const r = document.querySelector('#soloPlayer').getBoundingClientRect();
    const opts = (x) => ({ bubbles: true, pointerId: 8, isPrimary: true, pointerType: 'touch', clientX: x, clientY: r.top + r.height / 2 });
    const v = document.querySelector('#soloVideo');
    v.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width * 0.2)));
    setTimeout(() => v.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width * 0.2))), 140);
  });
  await sleep(600);
  const tMenos = await pA.evaluate(() => Math.floor(document.querySelector('#soloVideo').currentTime));
  ok(tMas.t - tMenos >= 8 && tMas.t - tMenos <= 13, `doble toque a la izquierda: -10s (${tMas.t}s → ${tMenos}s)`);

  /* seek con la barra */
  const tSeek = await pA.evaluate(() => {
    const bar = document.querySelector('#soloBar');
    bar.value = 300; /* 30% */
    bar.dispatchEvent(new Event('change', { bubbles: true }));
    return new Promise((res) => setTimeout(() => res(document.querySelector('#soloVideo').currentTime), 1500));
  });
  ok(Math.abs(tSeek - dur * 0.3) < 12, `seek con la barra al 30% (quedó en ${tSeek.toFixed(0)}s de ${(dur * 0.3).toFixed(0)}s esperados)`);
  /* CC apagado/encendido */
  const ccA = await pA.evaluate(() => {
    document.querySelector('#soloCC').click();
    const tt = document.querySelector('#soloVideo').textTracks[0];
    const on1 = tt ? tt.mode : null;
    document.querySelector('#soloCC').click();
    const on0 = tt ? tt.mode : null;
    return { on1, on0, act: document.querySelector('#soloCC').classList.contains('activa') };
  });
  ok(ccA.on1 === 'showing' && ccA.on0 === 'hidden', `CC enciende y apaga (${ccA.on1} → ${ccA.on0})`);
  /* deja de ver en el minuto ~30% y cierra → debe quedar en continuar-viendo */
  await sleep(2500);
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(600);
  const cerradoA = await pA.evaluate(() => document.querySelector('#soloPlayer').classList.contains('hidden'));
  ok(cerradoA, '✕ cierra el reproductor');
  const contA = await pA.evaluate(async (nombre, tok, url) => {
    const r = await fetch('/api/continue?name=' + encodeURIComponent(nombre) + '&tok=' + encodeURIComponent(tok));
    const d = await r.json();
    const e = (d.items || []).find((x) => x.url === url);
    return e ? { t: e.t, modo: e.modo } : null;
  }, login.name, login.token, PELI_LOCAL);
  ok(!!contA && contA.modo === 'solo', 'quedó en Continuar viendo como "solo"');
  ok(!!contA && contA.t >= 20, `con su minuto guardado (t=${contA ? contA.t : '—'}s)`);

  /* la tarjeta de continuar muestra el chip "solo" y reanuda donde iba */
  const cardA = await pA.waitForSelector('#continueBox:not(.hidden) .cont-card', { timeout: 10000 });
  ok(!!cardA, 'tarjeta de Continuar viendo visible');
  const chipA = await pA.evaluate(() => {
    const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => x.textContent.includes('Prueba local'));
    return { chip: !!(c && c.querySelector('.cont-modo')), texto: c ? c.querySelector('.cont-tiempo').textContent : '' };
  });
  ok(chipA.chip, 'tarjeta con el chip "solo"');
  ok(/Quedaste en/.test(chipA.texto), `"${chipA.texto}"`);
  await pA.evaluate(() => {
    const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => x.textContent.includes('Prueba local'));
    c.click();
  });
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  await sleep(700); /* el toast vive unos segundos */
  const toastRe = await pA.evaluate(() => document.querySelector('#toasts').textContent);
  ok(/Reanudando en \d/.test(toastRe), `aviso "Reanudando en…" al reanudar ("${toastRe.trim().slice(0, 30)}")`);
  let reanudado = false, tRe = 0;
  for (let ronda = 0; ronda < 2 && !reanudado; ronda++) {
    if (ronda > 0) { /* se cerró por una ráfaga de goodstream: reabrimos */
      await sleep(12000);
      await pA.evaluate(() => {
        const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => x.textContent.includes('Prueba local'));
        if (c) c.click();
      });
      await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 15000 }).catch(() => {});
    }
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const st = await pA.evaluate(() => {
        const v = document.querySelector('#soloVideo');
        return { t: v.currentTime, rs: v.readyState, dur: isFinite(v.duration) ? v.duration : 0, abierto: (typeof SOLO !== 'undefined' && !!SOLO) };
      });
      if (st.rs >= 2 && st.dur > 60 && st.t >= contA.t - 15) { reanudado = true; tRe = st.t; break; }
      if (!st.abierto) break; /* se cerró: reintento en la próxima ronda */
    }
  }
  ok(reanudado, `reanudó donde se quedó (t=${tRe.toFixed(0)}s, guardado ${contA.t}s)`);

  /* v82: si la conexión cae a media peli y se reconecta por el proxy,
   * debe volver al minuto donde iba (no desde el inicio) */
  const vivoPre = await pA.evaluate(() => !!(typeof SOLO !== 'undefined' && SOLO));
  if (!vivoPre) {
    ok(false, 'el reproductor se cerró antes de la reconexión (goodstream racionando — reintenta la corrida)');
  }
  const tPre = vivoPre ? await pA.evaluate(() => Math.floor(document.querySelector('#soloVideo').currentTime)) : 0;
  const recon = vivoPre ? await pA.evaluate((tObjetivo) => {
    SOLO.lastT = tObjetivo;
    montarSolo(SOLO.res, true); /* reconexión por el proxy */
    return true;
  }, Math.max(60, tPre)) : false;
  let volvio = false, tVolvio = 0;
  if (vivoPre) for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, pausa: v.paused, abierto: (typeof SOLO !== 'undefined' && !!SOLO) }; });
    if (st.rs >= 2 && !st.pausa && Math.abs(st.t - Math.max(60, tPre)) < 20) { volvio = true; tVolvio = st.t; break; }
    if (!st.abierto) break;
  }
  ok(vivoPre && volvio, `reconexión por el proxy vuelve al minuto (iba en ${tPre}s → ${tVolvio.toFixed(0)}s)`);

  /* v82: tras 5s sin tocar, TODO se esconde (barra de abajo y la de arriba) */
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
  ok(ocultoTop && ocultoCtrl, 'a los 5s sin tocar se esconden controles Y barra de arriba (pelis sin barras)');
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

  /* wiring: con Solo activado, una SERIE abre el picker y el episodio
   * cae en el reproductor individual (no crea sala) */
  console.log('— Usuario A: serie → episodio en individual —');
  await pA.evaluate(() => {
    document.querySelector('#homeSearch').value = 'peaky blinders';
    buscarInicio();
  });
  await pA.waitForSelector('#searchResults .sr-card', { timeout: 30000 });
  /* ojo: el primer resultado es la PELI "El hombre inmortal" — la serie es otra tarjeta */
  const clicSerie = await pA.evaluate(async () => {
    const d = await fetch('/api/search?q=' + encodeURIComponent('peaky blinders')).then((r) => r.json());
    const serie = (d.results || []).find((x) => /\/serie\//.test(x.url || ''));
    if (!serie) return false;
    const c = [...document.querySelectorAll('#searchResults .sr-card')].find((x) => {
      const n = x.querySelector('.sr-nombre');
      return n && n.textContent.trim() === serie.title; /* exacto: "Peaky Blinders" ≠ la peli "…El hombre inmortal" */
    });
    if (!c) return false;
    c.click();
    return true;
  });
  ok(clicSerie, 'clic en la tarjeta de la SERIE (no la peli)');
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 20000 });
  ok(true, 'la serie abre el selector de episodios (aunque esté Solo)');
  await pA.waitForSelector('#spEpisodios .sp-ep', { timeout: 30000 });
  await pA.evaluate(() => document.querySelector('#spEpisodios .sp-ep').click());
  const soloSerie = await pA.evaluate(() => ({
    player: !document.querySelector('#soloPlayer').classList.contains('hidden'),
    picker: document.querySelector('#seriePicker').classList.contains('hidden'),
    ep: document.querySelector('#soloEp').textContent,
  }));
  ok(soloSerie.player && soloSerie.picker, 'el episodio abre el reproductor individual (sin sala)');
  ok(/Episodio 1x1/.test(soloSerie.ep), `etiqueta del episodio ("${soloSerie.ep}")`);
  await sleep(1500); /* que llegue el m3u8 de la serie también */
  let serieOk = false;
  if (cdnOK) for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, abierto: (typeof SOLO !== 'undefined' && !!SOLO) }; });
    if (st.rs >= 2 && st.t > 2) { serieOk = true; break; }
    if (!st.abierto) break;
  }
  ok(!cdnOK || serieOk, 'el episodio de la serie también reproduce en individual' + (cdnOK ? '' : ' — omitido: CDN racionando'));
  await pA.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(400);
  /* volver a Juntos */
  await pA.click('#pillJuntos');
  const pills2 = await pA.evaluate(() => ({ ls: localStorage.getItem('huddle_modo_solo'), act: document.querySelector('#pillJuntos').classList.contains('activa') }));
  ok(pills2.ls === '0' && pills2.act, 'volver a 👥 Juntos');
  ok(errsA.length === 0, `sin errores de página en A (${errsA.length})`);
  await bA.close();

  /* ---------- USUARIO M: celular — también directo ---------- */
  console.log('— Usuario M: reproductor individual (celular 390x844) —');
  await sleep(4000); /* respiro: que goodstream no nos tenga en ración */
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
    return d;
  }, NOMBRE_M);
  ok(!!loginM.token, `M logueada (${NOMBRE_M})`);
  await pM.reload({ waitUntil: 'networkidle2' });
  await pM.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  const pillM = await pM.evaluate(() => document.querySelector('#pillSolo').classList.contains('activa'));
  ok(pillM, 'en el celular el modo Solo se recuerda');
  /* espiamos los toasts: si el player se cierra solo, sabremos por qué */
  await pM.evaluate(() => {
    window.__toastsVistos = [];
    const espiar = () => {
      const t = document.querySelector('#toasts');
      if (t && t.textContent.trim() && !window.__toastsVistos.includes(t.textContent.trim())) {
        window.__toastsVistos.push(t.textContent.trim());
      }
      setTimeout(espiar, 300);
    };
    espiar();
  });
  let listoM = false, diagM = null, toastsM = [];
  for (let ronda = 0; ronda < 2 && !listoM; ronda++) {
    if (ronda > 0) {
      await sleep(10000); /* dejar pasar la ráfaga */
      await pM.evaluate((url) => { abrirSolo(url, { title: 'Prueba local' }); }, PELI_LOCAL);
      await pM.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 }).catch(() => {});
    } else {
      await pM.evaluate((url) => { abrirSolo(url, { title: 'Prueba local' }); }, PELI_LOCAL);
      await pM.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
    }
    for (let i = 0; i < 50; i++) {
      await sleep(2000);
      const st = await pM.evaluate(() => {
        const v = document.querySelector('#soloVideo');
        return {
          rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0,
          player: !document.querySelector('#soloPlayer').classList.contains('hidden'),
          cargando: !document.querySelector('#soloCargando').classList.contains('hidden'),
          viaProxy: (typeof SOLO !== 'undefined' && SOLO) ? SOLO.viaProxy : null,
          reintentos: (typeof SOLO !== 'undefined' && SOLO) ? SOLO.reintentos : null,
          hls: (typeof SOLO !== 'undefined' && SOLO && SOLO.hls) ? 'vivo' : 'no',
          toasts: (window.__toastsVistos || []).slice(-3),
        };
      });
      diagM = st; toastsM = st.toasts || [];
      if (st.rs >= 2 && st.t > 2 && st.dur > 60 && !st.pausa) { listoM = true; break; }
      if (!st.player) break; /* se cerró solo */
    }
  }
  ok(listoM, 'en el celular el video también reproduce directo' + (listoM ? '' : ' — diagnóstico: ' + JSON.stringify(diagM)));
  const abiertoM = await pM.evaluate(() => !document.querySelector('#soloPlayer').classList.contains('hidden'));
  const ctrlsM = await pM.evaluate(() => {
    document.querySelector('#soloPlayer').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return {
      ctrls: getComputedStyle(document.querySelector('#soloCtrls')).opacity,
      time: document.querySelector('#soloTime').textContent,
      w: document.querySelector('#soloPlayer').getBoundingClientRect().width,
    };
  });
  ok(abiertoM && ctrlsM.w === 390, `a pantalla completa del celular (${ctrlsM.w}px)` + (abiertoM ? '' : ' — player cerrado, toasts: ' + JSON.stringify(toastsM)));
  ok(ctrlsM.ctrls === '1', `controles aparecen al tocar (${ctrlsM.ctrls})`);
  ok(/\d+:\d+ \/ \d+:\d+/.test(ctrlsM.time), `tiempo visible ("${ctrlsM.time}")`);
  await pM.evaluate(() => document.querySelector('#soloBack').click());
  await sleep(500);
  const cerrM = await pM.evaluate(() => document.querySelector('#soloPlayer').classList.contains('hidden'));
  ok(cerrM, '✕ cierra también en el celular');
  ok(errsM.length === 0, `sin errores de página en M (${errsM.length})`);
  await bM.close();

  /* ---------- resultado ---------- */
  console.log(fallos === 0 ? `\nTODO-OK (${fallos} fallos)` : `\n${fallos} FALLOS`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(2); });
