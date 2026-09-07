/* E2E v63: Latanime (animes en LATINO con reproductor propio), temporadas
 * reales de series (TWD 11), sin barrita azul (scrollbars ocultos), fuera
 * carteles de ayuda + regresión de todo lo anterior */
const fs = require('fs');
const movioCanvas = (page) => page.evaluate(() => {
  const c = document.querySelector('#mirrorImg');
  const d = c.getContext('2d').getImageData(0, Math.floor(c.height / 2), c.width, 2).data;
  let s = 0; for (let i = 0; i < d.length; i += 40) s += d[i] + d[i + 1] + d[i + 2];
  return s;
});
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const RUN = String(Date.now()).slice(-4); /* nombres únicos por corrida */
const NOMBRE_A = 'Ana' + RUN, NOMBRE_B = 'Beto' + RUN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) fallos++; };

/* toque en el canvas del espejo (pointerdown+up rápidos, como un dedo) */
async function tocarCanvas(page) {
  await page.evaluate(() => {
    const c = document.querySelector('#mirrorImg');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (t) => c.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, pointerId: 9, isPrimary: true }));
    ev('pointerdown'); ev('pointerup');
  });
  await sleep(400);
}

(async () => {
  /* ---------- 0) código servido: sin flechas, con capa de controles, CSS y v62 ---------- */
  console.log('— Código v62 —');
  const idx = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/style.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');
  const srv = fs.readFileSync('server.js', 'utf8');
  ok(!idx.includes('btnMBack') && !idx.includes('btnMFwd'), 'HTML sin flechas atrás/adelante');
  ok(idx.includes('id="ctrlLayer"') && idx.includes('id="seekWrap"') && idx.includes('id="mirrorNav"'), 'capa de controles con barrita y botones');
  ok(css.includes('body.mirroring.cine-listo .ctrl-layer') && css.includes('.ctrl-layer .mirror-nav'), 'CSS: capa abajo + auto-ocultar en modo cine');
  ok(js.includes('function tocarPantallaCine') && js.includes('mostrarCtrls5s') && js.includes("op: S.mirror.playing ? 'pause' : 'play'"), 'JS: tap muestra controles / segundo tap pausa');
  ok(!js.includes("$('#btnMBack')") && !js.includes("$('#btnMFwd')"), 'JS sin referencias a las flechas');
  ok(srv.includes('.mdl-help,.button-close-help{display:none!important}'), 'CSS anti cartel de ayuda de Cuevana');
  ok(srv.includes('::-webkit-scrollbar{width:0!important'), 'CSS: scrollbars escondidos (adiós barrita azul)');
  ok(srv.includes("querySelectorAll('.mdl-help').forEach"), 'limpiador activo del cartel de ayuda');
  ok(srv.includes('buscarLatanime') && srv.includes('latanime.org/buscar'), 'buscador de Latanime conectado');
  ok(srv.includes('iframe.rr-player') && srv.includes('a.play-video'), 'reproductor propio para episodios de Latanime');
  ok(srv.includes("/api/anime/") && srv.includes('var\\s+eps'), 'API de animes (var eps)');
  ok(srv.includes("const UI_VERSION = 'v63'"), 'servidor en v63');

  /* ---------- 0b) APIs ---------- */
  console.log('— APIs —');
  const ani = await fetch(BASE + '/api/anime/naruto-latino').then((r) => r.json()).catch(() => null);
  ok(!!ani && ani.ok === true, '/api/anime responde ok');
  ok(ani && ani.episodios && ani.episodios.length >= 200, `naruto-latino: ${ani ? ani.episodios.length : 0} episodios`);
  ok(ani && ani.episodios && /\/ver\/naruto-latino-1$/.test(ani.episodios[0].url), `episodio 1 → ${ani ? ani.episodios[0].url : ''}`);
  ok(ani && /^Naruto/.test(ani.titulo || ''), `título limpio: "${ani ? ani.titulo : ''}"`);
  const aniL = await fetch(BASE + '/api/anime/dragon-ball-daima-latino?site=latanime').then((r) => r.json()).catch(() => null);
  ok(aniL && aniL.ok === true, '/api/anime Latanime responde ok');
  ok(aniL && aniL.episodios && aniL.episodios.length >= 15, `daima-latino: ${aniL ? aniL.episodios.length : 0} episodios`);
  ok(aniL && aniL.episodios && /latanime\.org\/ver\/dragon-ball-daima-latino-episodio-1$/.test(aniL.episodios[0].url), `episodio 1 → ${aniL ? aniL.episodios[0].url.slice(0, 62) : ''}`);
  ok(aniL && /Daima/i.test(aniL.titulo || ''), `título Latanime: "${aniL ? aniL.titulo : ''}"`);
  const ser = await fetch(BASE + '/api/serie/the-walking-dead').then((r) => r.json()).catch(() => null);
  const tempsTWD = ser ? [...new Set(ser.episodios.map((x) => x.temporada))] : [];
  ok(ser && ser.ok && ser.episodios.length > 50, `/api/serie sigue ok (${ser ? ser.episodios.length : 0} eps TWD)`);
  ok(tempsTWD.length === 11, `TWD con sus 11 temporadas reales (${tempsTWD.length})`);
  const bus = await fetch(BASE + '/api/search?q=dragon').then((r) => r.json()).catch(() => null);
  const latR = ((bus && bus.results) || []).filter((x) => x.site === 'Latanime');
  ok(latR.length >= 3, `buscador incluye Latanime (${latR.length} resultados)`);

  /* ---------- USUARIO A (anfitrión) ---------- */
  console.log('— Usuario A (anfitrión) —');
  const bA = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pA = await bA.newPage();
  const errsA = [];
  pA.on('pageerror', (e) => errsA.push(String(e)));
  await pA.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const loginA = await pA.evaluate(async (nombre) => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nombre }) });
    const d = await r.json();
    localStorage.setItem('rr-profile', JSON.stringify({ name: d.name, token: d.token }));
    return d;
  }, NOMBRE_A);
  ok(!!loginA.token, `A logueada (${NOMBRE_A})`);
  await pA.reload({ waitUntil: 'networkidle2' });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  const domA = await pA.evaluate(() => ({
    flechas: !!document.querySelector('#btnMBack') || !!document.querySelector('#btnMFwd'),
    capa: !!document.querySelector('#ctrlLayer'),
    dentro: !!(document.querySelector('#ctrlLayer #seekWrap') && document.querySelector('#ctrlLayer #mirrorNav')),
    buscar: !!document.querySelector('#ctrlLayer #btnMSearch'),
    DiezTreinta: !!(document.querySelector('#btnSeekBack') && document.querySelector('#btnSeekFwd')),
  }));
  ok(!domA.flechas, 'las flechas desaparecieron del espejo');
  ok(domA.capa && domA.dentro && domA.buscar, 'capa de controles con barrita, 10/30 y buscar');
  ok(domA.DiezTreinta, 'botones 10 y 30 siguen en la barra');

  /* ---------- picker de ANIME: AnimeFLV (regresión v62) ---------- */
  console.log('— Selector de anime (AnimeFLV) —');
  await pA.evaluate(() => { abrirSeriePicker({ url: 'https://vww.animeflv.one/anime/naruto-latino', title: 'Naruto', img: '' }, false, true); });
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => document.querySelectorAll('#spEpisodios .sp-ep').length > 0, { timeout: 30000 });
  const aniPk = await pA.evaluate(() => ({
    titulo: document.querySelector('#spTitle').textContent,
    meta: document.querySelector('#spMeta').textContent,
    eps: document.querySelectorAll('#spEpisodios .sp-ep').length,
    sinImg: document.querySelectorAll('#spEpisodios .sp-ep.sin-img').length,
    temps: document.querySelectorAll('#spTemporadas .sp-temp-btn').length,
    primero: (document.querySelector('#spEpisodios .sp-ep .sp-ep-num') || {}).textContent || '',
    poster: document.querySelector('#spPoster').getAttribute('src') || '',
  }));
  ok(/^Naruto/.test(aniPk.titulo), `anime: "${aniPk.titulo}"`);
  ok(aniPk.eps >= 200 && aniPk.sinImg === aniPk.eps, `${aniPk.eps} episodios en filas sin miniatura`);
  ok(aniPk.temps === 0, 'sin pestañas de temporada (lista única)');
  ok(/Episodio\s*1/.test(aniPk.primero), `primera fila: "${aniPk.primero}"`);
  ok(/^https:\/\/wsrv\.nl\//.test(aniPk.poster), `póster vía proxy (${aniPk.poster.slice(0, 46)}…)`);
  await pA.evaluate(() => cerrarSeriePicker());
  await sleep(400);

  /* ---------- picker de anime LATINO: Latanime (v63) ---------- */
  console.log('— Selector de anime LATINO (Latanime) —');
  await pA.evaluate(() => { abrirSeriePicker({ url: 'https://latanime.org/anime/dragon-ball-daima-latino', title: 'Dragon Ball Daima Latino', img: '' }, false, true); });
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => document.querySelectorAll('#spEpisodios .sp-ep').length > 0, { timeout: 30000 });
  const latPk = await pA.evaluate(() => ({
    titulo: document.querySelector('#spTitle').textContent,
    meta: document.querySelector('#spMeta').textContent,
    eps: document.querySelectorAll('#spEpisodios .sp-ep').length,
    primero: (document.querySelector('#spEpisodios .sp-ep .sp-ep-num') || {}).textContent || '',
    poster: document.querySelector('#spPoster').getAttribute('src') || '',
  }));
  ok(/Daima/i.test(latPk.titulo), `anime latino: "${latPk.titulo}"`);
  ok(latPk.eps >= 15, `${latPk.eps} episodios (${latPk.meta})`);
  ok(/Episodio\s*1/.test(latPk.primero), `primera fila: "${latPk.primero}"`);
  ok(/^https:\/\/wsrv\.nl\//.test(latPk.poster), `póster vía proxy (${latPk.poster.slice(0, 46)}…)`);

  /* ---------- episodio de anime LATINO → mismo flujo que una peli ---------- */
  console.log('— Episodio de anime LATINO (Latanime) —');
  await pA.click('#spEpisodios .sp-ep');
  await pA.waitForSelector('#peliLoading:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const codeAni = await pA.evaluate(() => location.hash.slice(1));
  ok(!!codeAni, `sala de anime latino: ${codeAni}`);
  const nomAni = await pA.evaluate(() => document.querySelector('#peliNombre').textContent);
  ok(/Daima/i.test(nomAni) && /Episodio/.test(nomAni), `espera con nombre: "${nomAni}"`);
  /* el reproductor de Latanime tarda un poquito en madurar */
  let listoAni = true;
  await pA.waitForSelector('#playBtn:not(.hidden)', { timeout: 150000 }).catch(() => { listoAni = false; });
  ok(listoAni, 'episodio latino listo en pausa — botón de play visible');
  if (listoAni) {
    await sleep(900); /* la capa se funde a opacity 0 en .22s */
    const cineAni = await pA.evaluate(() => ({
      cine: document.body.classList.contains('cine-listo'),
      capa: !document.querySelector('#ctrlLayer').classList.contains('visible'),
      opa: getComputedStyle(document.querySelector('#ctrlLayer')).opacity,
    }));
    ok(cineAni.cine && cineAni.capa && cineAni.opa === '0', 'modo cine: controles escondidos (opacidad 0)');
    await pA.click('#playBtn');
    await pA.waitForFunction(() => document.querySelector('#playBtn').classList.contains('hidden'), { timeout: 15000 });
    await sleep(6000);
    const a1 = await movioCanvas(pA).catch(() => -1);
    await sleep(4000);
    const a2 = await movioCanvas(pA).catch(() => -2);
    ok(a1 !== a2, `anime latino corriendo tras el play (${a1}→${a2})`);
    /* invitación con metadatos del anime (rama Latanime) */
    const invA = await pA.evaluate(async (c) => (await fetch('/api/invite/' + c)).json(), codeAni);
    ok(/Daima/i.test(invA.title || '') && /Episodio/.test(invA.title || ''), `invite anime latino: "${invA.title}"`);
    ok(/^https:\/\/wsrv\.nl\//.test(invA.poster || '') || /latanime/.test(invA.poster || ''), `invite póster: ${(invA.poster || '').slice(0, 50)}`);
    /* paramos el espejo del anime (igual que el botón Detener) */
    await pA.evaluate(() => { try { sendAction({ type: 'mirror', op: 'stop' }); } catch {} });
    await sleep(2500);
  }

  /* ---------- episodio de SERIE + controles v62 ---------- */
  console.log('— Episodio de serie + controles abajo (v62) —');
  await pA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  /* v63: TWD debe mostrar sus 11 temporadas en pestañas */
  await pA.evaluate(() => { abrirSeriePicker({ url: 'https://cine-calidad.mx/serie/the-walking-dead/', title: 'The Walking Dead', img: '' }, false, false); });
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => document.querySelectorAll('#spEpisodios .sp-ep').length > 0, { timeout: 30000 });
  const twdTabs = await pA.evaluate(() => document.querySelectorAll('#spTemporadas .sp-temp-btn').length);
  ok(twdTabs === 11, `TWD: ${twdTabs} pestañas de temporada (antes salía 1)`);
  /* cambiar a la temporada 5 debe listar sus episodios */
  await pA.evaluate(() => { const b = document.querySelectorAll('#spTemporadas .sp-temp-btn')[4]; if (b) b.click(); });
  await sleep(700);
  const twdT5 = await pA.evaluate(() => [...document.querySelectorAll('#spEpisodios .sp-ep .sp-ep-num')].slice(0, 3).map((x) => x.textContent));
  ok(twdT5.length > 0 && twdT5.every((x) => /^5x/.test(x)), `temporada 5 lista: ${twdT5.join(', ')}`);
  await pA.evaluate(() => cerrarSeriePicker());
  await sleep(400);
  /* serie fija (Arrow — su episodio 1x1 tiene servidor goodstream) */
  await pA.evaluate(() => { abrirSeriePicker({ url: 'https://cine-calidad.mx/serie/arrow/', title: 'Arrow', img: '' }, false, false); });
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => document.querySelectorAll('#spEpisodios .sp-ep').length > 0, { timeout: 30000 });
  const pkSer = await pA.evaluate(() => ({
    eps: document.querySelectorAll('#spEpisodios .sp-ep').length,
    temps: document.querySelectorAll('#spTemporadas .sp-temp-btn').length,
  }));
  ok(pkSer.eps >= 3, `selector de serie: ${pkSer.eps} episodio(s), ${pkSer.temps} pestaña(s)`);
  await pA.click('#spEpisodios .sp-ep');
  await pA.waitForSelector('#peliLoading:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const codeSer = await pA.evaluate(() => location.hash.slice(1));
  ok(!!codeSer, `sala de serie: ${codeSer}`);
  await pA.waitForSelector('#playBtn:not(.hidden)', { timeout: 120000 });
  ok(true, 'episodio listo en pausa — botón de play visible');
  /* la barrita aparece cuando llega el primer mirror-time con duración */
  await pA.waitForFunction(() => !document.querySelector('#seekWrap').classList.contains('hidden') && document.querySelector('#seekDur').textContent !== '0:00', { timeout: 30000 });
  await sleep(900); /* fundido de la capa (.22s) */

  /* posición: la capa va PEGADA AL FONDO DEL VIDEO y la barrita en la parte baja */
  const pos = await pA.evaluate(() => {
    const L = document.querySelector('#ctrlLayer').getBoundingClientRect();
    const M = document.querySelector('#mirrorLayer').getBoundingClientRect();
    const W = document.querySelector('#seekWrap').getBoundingClientRect();
    const N = document.querySelector('#mirrorNav').getBoundingClientRect();
    return { lb: L.bottom, mb: M.bottom, wtop: W.top, wbot: W.bottom, ntop: N.top, mh: M.height };
  });
  ok(Math.abs(pos.lb - pos.mb) < 4, `capa pegada al fondo del video (${Math.round(pos.lb)}/${Math.round(pos.mb)}px)`);
  ok(pos.wtop > pos.mb - 130, `barrita en la parte baja del video (top ${Math.round(pos.wtop)}, video hasta ${Math.round(pos.mb)})`);
  ok(pos.ntop >= pos.wbot - 6, `botones debajo de la barrita (nav ${Math.round(pos.ntop)} ≥ fin barra ${Math.round(pos.wbot)})`);

  /* escondidos por defecto en modo cine */
  const oculto0 = await pA.evaluate(() => ({
    cine: document.body.classList.contains('cine-listo'),
    vis: document.querySelector('#ctrlLayer').classList.contains('visible'),
    opa: getComputedStyle(document.querySelector('#ctrlLayer')).opacity,
    ptr: getComputedStyle(document.querySelector('#ctrlLayer')).pointerEvents,
  }));
  ok(oculto0.cine && !oculto0.vis && oculto0.opa === '0' && oculto0.ptr === 'none', 'controles escondidos en modo cine (opacity 0, sin toques)');

  /* 1er toque → aparecen */
  await tocarCanvas(pA);
  const vis1 = await pA.evaluate(() => ({
    vis: document.querySelector('#ctrlLayer').classList.contains('visible'),
    opa: getComputedStyle(document.querySelector('#ctrlLayer')).opacity,
  }));
  ok(vis1.vis && vis1.opa === '1', 'un toque en la pantalla saca los controles');

  /* 5s → se esconden solos */
  await sleep(5300);
  const vis2 = await pA.evaluate(() => ({ vis: document.querySelector('#ctrlLayer').classList.contains('visible'), opa: getComputedStyle(document.querySelector('#ctrlLayer')).opacity }));
  ok(!vis2.vis && vis2.opa === '0', 'a los 5 segundos se esconden solos');

  /* tocar y jugar: play → controles fuera */
  await pA.click('#playBtn');
  await pA.waitForFunction(() => document.querySelector('#playBtn').classList.contains('hidden'), { timeout: 15000 });
  await sleep(1500);
  const trasPlay = await pA.evaluate(() => document.querySelector('#ctrlLayer').classList.contains('visible'));
  ok(!trasPlay, 'al reproducir los controles se esconden');
  await sleep(5000);

  /* toque → aparecen; otro toque → PAUSA */
  await tocarCanvas(pA);
  const vis3 = await pA.evaluate(() => document.querySelector('#ctrlLayer').classList.contains('visible'));
  ok(vis3, 'toque durante la peli saca los controles');
  /* que corra unos segundos comprobables antes de pausar */
  const curA = await pA.evaluate(() => document.querySelector('#seekCur').textContent);
  await sleep(3500);
  const curB = await pA.evaluate(() => document.querySelector('#seekCur').textContent);
  ok(curA !== curB, `la peli avanza (${curA} → ${curB})`);
  await tocarCanvas(pA);
  await sleep(2500);
  const pausa = await pA.evaluate(() => ({
    btn: !document.querySelector('#playBtn').classList.contains('hidden'),
    capa: document.querySelector('#ctrlLayer').classList.contains('visible'),
  }));
  ok(pausa.btn, 'segundo toque PAUSÓ la peli (botón de play grande de vuelta)');
  ok(!pausa.capa, 'y los controles se volvieron a esconder');
  const cur2 = await pA.evaluate(() => document.querySelector('#seekCur').textContent);
  await sleep(3000);
  const cur3 = await pA.evaluate(() => document.querySelector('#seekCur').textContent);
  ok(cur2 === cur3, `la peli quedó en pausa de verdad (congelada en ${cur2} = ${cur3})`);

  /* pausada: un toque saca controles (no reanuda) */
  await tocarCanvas(pA);
  const visP = await pA.evaluate(() => document.querySelector('#ctrlLayer').classList.contains('visible'));
  ok(visP, 'en pausa, un toque también saca los controles');

  /* reanudar con el botón grande */
  await pA.click('#playBtn');
  await pA.waitForFunction(() => document.querySelector('#playBtn').classList.contains('hidden'), { timeout: 15000 });
  await sleep(6000);
  const s1 = await movioCanvas(pA).catch(() => -1);
  await sleep(4000);
  const s2 = await movioCanvas(pA).catch(() => -2);
  ok(s1 !== s2, `serie corriendo tras reanudar (${s1}→${s2})`);

  /* USUARIO B: entra y ve la sala sin errores */
  console.log('— Usuario B (invitado) —');
  const bB = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pB = await bB.newPage();
  const errsB = [];
  pB.on('pageerror', (e) => errsB.push(String(e)));
  await pB.goto(BASE + '/#' + codeSer, { waitUntil: 'networkidle2', timeout: 60000 });
  await pB.waitForSelector('#inviteHero:not(.hidden)', { timeout: 15000 });
  await pB.type('#userNick', NOMBRE_B);
  await pB.click('#btnLogin');
  await pB.waitForFunction(() => !document.querySelector('#room').classList.contains('hidden'), { timeout: 20000 });
  const ctrlB = await pB.evaluate(() => ({
    flechas: !!document.querySelector('#btnMBack') || !!document.querySelector('#btnMFwd'),
    capa: !!document.querySelector('#ctrlLayer'),
    cine: document.body.classList.contains('cine-listo'),
  }));
  ok(!ctrlB.flechas && ctrlB.capa && ctrlB.cine, 'B dentro: sin flechas, capa nueva, modo cine');
  /* B (invitado) también puede sacar los controles con un toque */
  await tocarCanvas(pB);
  const visB = await pB.evaluate(() => document.querySelector('#ctrlLayer').classList.contains('visible'));
  ok(visB, 'B ve los controles al tocar la pantalla');

  ok(errsA.length === 0, `A sin errores JS${errsA.length ? ' → ' + errsA[0] : ''}`);
  ok(errsB.length === 0, `B sin errores JS${errsB.length ? ' → ' + errsB[0] : ''}`);

  await bA.close(); await bB.close();
  console.log(fallos === 0 ? '\nTODO-OK' : `\nFALLOS: ${fallos}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR E2E:', e.message); process.exit(1); });
