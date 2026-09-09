/* E2E v86: "Sigue con el próximo" — la cadena de episodios viaja con el
 * progreso; la tarjeta de un episodio terminado invita al siguiente y la
 * entrada anterior no se acumula + todo v85/v84/v83/v82/v81. */
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const RUN = String(Date.now()).slice(-4);
const NOMBRE_A = 'Ana' + RUN, NOMBRE_M = 'Mobi' + RUN;
const PELI = 'https://cine-calidad.mx/pelicula/mayday/'; /* goodstream (viva 2026-09-08) */
const PELI_LOCAL = '/test-media/master.m3u8'; /* fixture HLS propio — determinista */
const SERIE = 'peaky-blinders'; /* para probar picker→episodio en solo */
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
  ok(srv.includes("const UI_VERSION = 'v86'"), 'servidor en v86');
  ok(js.includes("const APP_VERSION = 'v86'"), 'cliente en v86');
  ok(idx.includes('id="verBadge">v86'), 'badge v86');
  ok(idx.includes('/app.js?v=86') && idx.includes('/style.css?v=86'), 'cache-busters v86');
  /* hls.js vendored */
  const hlsStat = fs.statSync('public/hls.min.js');
  const hlsSrc = fs.readFileSync('public/hls.min.js', 'utf8');
  ok(hlsStat.size > 300000, `hls.js vendored (${(hlsStat.size / 1024).toFixed(0)} KB)`);
  ok(/1\.5\.17/.test(hlsSrc), 'hls.js 1.5.17');
  /* HTML del reproductor */
  ok(idx.includes('id="modoPills"') && idx.includes('id="pillJuntos"') && idx.includes('id="pillSolo"'), 'HTML: toggle 👥 Juntos / 🎬 Solo');
  ok(idx.includes('id="soloPlayer"') && idx.includes('id="soloVideo"') && idx.includes('id="soloBack"') && idx.includes('id="soloBar"') && idx.includes('id="soloCC"') && idx.includes('id="soloFs"') && idx.includes('id="soloPlay"'), 'HTML: reproductor individual completo');
  /* JS base */
  ok(js.includes('huddle_modo_solo') && js.includes('function setModoSolo') && js.includes('function pintarModoPills'), 'JS: toggle persistido (localStorage)');
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
  /* servidor */
  ok(srv.includes('function resolverSolo') && srv.includes("'/api/solo'") && srv.includes("'/api/hls'") && srv.includes("'/api/progress'"), 'server: rutas /api/solo /api/hls /api/progress');
  ok(srv.includes('esGoodstream') && srv.includes('goodstream\\.one'), 'server: proxy solo para goodstream (allowlist)');

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

  /* toggle Juntos/Solo */
  await pA.click('#pillSolo');
  const pills1 = await pA.evaluate(() => ({
    solo: document.querySelector('#pillSolo').classList.contains('activa'),
    ls: localStorage.getItem('huddle_modo_solo'),
  }));
  ok(pills1.solo && pills1.ls === '1', 'Solo se activa y se guarda (localStorage)');

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

  await pA.click('#pillJuntos');
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
  const pillM = await pM.evaluate(() => document.querySelector('#pillSolo').classList.contains('activa'));
  ok(pillM, 'en el celular el modo Solo se recuerda');
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
