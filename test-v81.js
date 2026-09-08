/* E2E v81: modo individual — pelis y series se reproducen DIRECTO en el
 * navegador del usuario, sin sala ni navegador-espejo: /api/solo resuelve
 * el m3u8 (goodstream) con puros fetch, hls.js (vendored) lo reproduce,
 * /api/hls hace de proxy si directo no sirve, y /api/progress guarda el
 * minuto para "Continuar viendo" con modo:'solo'. Los animes se quedan
 * en modo sala (filemoon no tiene extracción directa). */
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const RUN = String(Date.now()).slice(-4);
const NOMBRE_A = 'Ana' + RUN, NOMBRE_M = 'Mobi' + RUN;
const PELI = 'https://cine-calidad.mx/pelicula/mayday/'; /* goodstream (viva 2026-09-08) */
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
  ok(srv.includes("const UI_VERSION = 'v81'"), 'servidor en v81');
  ok(js.includes("const APP_VERSION = 'v81'"), 'cliente en v81');
  ok(idx.includes('id="verBadge">v81'), 'badge v81');
  ok(idx.includes('/app.js?v=81') && idx.includes('/style.css?v=81'), 'cache-busters v81');
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
  /* /api/solo sin auth → 403 */
  const soloX = await fetch(BASE + '/api/solo?url=' + encodeURIComponent(PELI)).catch(() => null);
  ok(!!soloX && soloX.status === 403, '/api/solo exige perfil (403)');
  /* /api/solo con auth → resuelve mayday */
  const qs = 'name=' + encodeURIComponent(login.name) + '&tok=' + encodeURIComponent(login.token) + '&url=' + encodeURIComponent(PELI);
  const solo = await fetch(BASE + '/api/solo?' + qs).then((r) => r.json()).catch(() => null);
  ok(!!solo && solo.ok === true, '/api/solo resuelve la peli SIN navegador');
  ok(!!solo && /goodstream\.one\/.*\.m3u8/i.test(solo.m3u8 || ''), `m3u8 goodstream (${solo ? (solo.m3u8 || '').slice(8, 60) + '…' : '—'})`);
  ok(!!solo && (solo.subs || []).length >= 1, `/api/solo trae subtítulos (${solo ? (solo.subs || []).length : 0} VTT)`);
  ok(!!solo && (solo.subs || []).some((s) => s.lang === 'es' || s.lang === 'es-419'), 'un VTT en español entre los subtítulos');
  /* /api/hls allowlist */
  const hlsX = await fetch(BASE + '/api/hls?u=' + encodeURIComponent('https://www.google.com/video.m3u8')).catch(() => null);
  ok(!!hlsX && hlsX.status === 403, '/api/hls rechaza hosts fuera de goodstream (403)');
  /* /api/hls sirve el master reescrito */
  const m3u8 = solo ? solo.m3u8 : '';
  const hlsR = await fetch(BASE + '/api/hls?u=' + encodeURIComponent(m3u8)).catch(() => null);
  const hlsTxt = hlsR ? await hlsR.text() : '';
  ok(!!hlsR && hlsR.ok, `/api/hls sirve el master (${hlsR ? hlsR.status : '—'})`);
  ok(/mpegurl/i.test(hlsR ? (hlsR.headers.get('content-type') || '') : ''), 'content-type del master: application/vnd.apple.mpegurl');
  ok(hlsTxt.includes('/api/hls?u='), 'master reescrito hacia el proxy');
  /* una variante reescrita también */
  const variante = (hlsTxt.match(/\/api\/hls\?u=(https[^'" \n]+)/) || [])[1];
  const varR = variante ? await fetch(BASE + '/api/hls?u=' + variante).catch(() => null) : null;
  const varTxt = varR ? await varR.text() : '';
  ok(!!varR && varR.ok && varTxt.includes('/api/hls?u='), 'variante (480p/360p) también reescrita');
  /* un segmento por el proxy */
  const segs = [...varTxt.matchAll(/\/api\/hls\?u=(https[^'" \n]+)/g)].map((m) => decodeURIComponent(m[1])).filter((u) => !/\.m3u8(\?|$)/i.test(u));
  const seg = segs[0];
  const segBuf = seg ? await fetch(BASE + '/api/hls?u=' + encodeURIComponent(seg)).then((r) => r.arrayBuffer().then((b) => ({ ok: r.ok, ct: r.headers.get('content-type'), b }))).catch(() => null) : null;
  ok(!!segBuf && segBuf.ok && /video|mp2t|octet/i.test(segBuf.ct || '') && segBuf.b.byteLength > 10000, `segmento por el proxy (${segBuf ? segBuf.ct : '—'}, ${(segBuf ? segBuf.b.byteLength / 1024 : 0).toFixed(0)} KB)`);
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

  /* abrir la peli en modo individual */
  await pA.evaluate((url) => { abrirSolo(url, { title: 'Mayday' }); }, PELI);
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  ok(true, 'reproductor individual visible');
  const titA = await pA.evaluate(() => document.querySelector('#soloTitle').textContent);
  ok(titA === 'Mayday', `título en el reproductor ("${titA}")`);
  /* espera a que el video de verdad avance */
  let listo = false, viaProxy = false, usoHls = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => {
      const v = document.querySelector('#soloVideo');
      return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0, proxy: (typeof SOLO !== 'undefined' && SOLO) ? SOLO.viaProxy : null, hls: (typeof SOLO !== 'undefined' && SOLO) ? !!SOLO.hls : null, cargando: !document.querySelector('#soloCargando').classList.contains('hidden') };
    });
    viaProxy = st.proxy; usoHls = st.hls;
    if (st.rs >= 2 && st.t > 3 && st.dur > 60 && !st.pausa) { listo = true; break; }
  }
  ok(listo, `el video REPRODUCE directo en el navegador (hls.js=${usoHls}, proxy=${viaProxy})`);
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
  }, login.name, login.token, PELI);
  ok(!!contA && contA.modo === 'solo', 'quedó en Continuar viendo como "solo"');
  ok(!!contA && contA.t >= 60, `con su minuto guardado (t=${contA ? contA.t : '—'}s)`);

  /* la tarjeta de continuar muestra el chip "solo" y reanuda donde iba */
  const cardA = await pA.waitForSelector('#continueBox:not(.hidden) .cont-card', { timeout: 10000 });
  ok(!!cardA, 'tarjeta de Continuar viendo visible');
  const chipA = await pA.evaluate(() => {
    const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => x.textContent.includes('Mayday'));
    return { chip: !!(c && c.querySelector('.cont-modo')), texto: c ? c.querySelector('.cont-tiempo').textContent : '' };
  });
  ok(chipA.chip, 'tarjeta con el chip "solo"');
  ok(/Quedaste en/.test(chipA.texto), `"${chipA.texto}"`);
  await pA.evaluate(() => {
    const c = [...document.querySelectorAll('#continueRow .cont-card')].find((x) => x.textContent.includes('Mayday'));
    c.click();
  });
  await pA.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let reanudado = false, tRe = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => {
      const v = document.querySelector('#soloVideo');
      return { t: v.currentTime, rs: v.readyState, dur: isFinite(v.duration) ? v.duration : 0 };
    });
    if (st.rs >= 2 && st.dur > 60 && st.t >= contA.t - 15) { reanudado = true; tRe = st.t; break; }
    if (st.rs >= 2 && st.dur > 60 && st.t > st.dur * 0.5) break; /* algo raro: saltó muy lejos */
  }
  ok(reanudado, `reanudó donde se quedó (t=${tRe.toFixed(0)}s, guardado ${contA.t}s)`);
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
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const st = await pA.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime }; });
    if (st.rs >= 2 && st.t > 2) { serieOk = true; break; }
  }
  ok(serieOk, 'el episodio de la serie también reproduce en individual');
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
  await pM.evaluate((url) => { abrirSolo(url, { title: 'Mayday' }); }, PELI);
  await pM.waitForSelector('#soloPlayer:not(.hidden)', { timeout: 10000 });
  let listoM = false;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await pM.evaluate(() => { const v = document.querySelector('#soloVideo'); return { rs: v.readyState, t: v.currentTime, pausa: v.paused, dur: isFinite(v.duration) ? v.duration : 0 }; });
    if (st.rs >= 2 && st.t > 2 && st.dur > 60 && !st.pausa) { listoM = true; break; }
  }
  ok(listoM, 'en el celular el video también reproduce directo');
  const ctrlsM = await pM.evaluate(() => {
    document.querySelector('#soloPlayer').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return {
      ctrls: getComputedStyle(document.querySelector('#soloCtrls')).opacity,
      time: document.querySelector('#soloTime').textContent,
      w: document.querySelector('#soloPlayer').getBoundingClientRect().width,
    };
  });
  ok(ctrlsM.w === 390, `a pantalla completa del celular (${ctrlsM.w}px)`);
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
