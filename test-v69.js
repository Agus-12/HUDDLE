/* E2E v69: "Animes del momento" HASTA ARRIBA del inicio + carga
 * independiente de secciones — más lo esencial de v68/v67/v65 */
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
/* bottom en px desde un computed style (por si devuelve calc(...)) */
const botPx = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : (String(s).includes('122') ? 122 : 0); };

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
  /* ---------- 0) código servido: v65 + regresión v62/v64 ---------- */
  console.log('— Código v65 —');
  const idx = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/style.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');
  const srv = fs.readFileSync('server.js', 'utf8');
  ok(!idx.includes('btnMBack') && !idx.includes('btnMFwd'), 'HTML sin flechas atrás/adelante');
  ok(idx.includes('id="ctrlLayer"') && idx.includes('id="seekWrap"') && idx.includes('id="mirrorNav"'), 'capa de controles con barrita y botones');
  ok(css.includes('body.mirroring.cine-listo .ctrl-layer') && css.includes('.ctrl-layer .mirror-nav'), 'CSS: capa + auto-ocultar en modo cine (v62)');
  ok(js.includes('function tocarPantallaCine') && js.includes('mostrarCtrls5s') && js.includes("op: S.mirror.playing ? 'pause' : 'play'"), 'JS: tap muestra controles / segundo tap pausa');
  ok(srv.includes('.mdl-help,.button-close-help{display:none!important}'), 'CSS anti cartel de ayuda de Cuevana');
  ok(srv.includes('::-webkit-scrollbar{width:0!important'), 'CSS: scrollbars escondidos (adiós barrita azul)');
  ok(srv.includes("querySelectorAll('.mdl-help').forEach"), 'limpiador activo del cartel de ayuda');
  ok(srv.includes('buscarLatanime') && srv.includes('latanime.org/buscar'), 'buscador de Latanime conectado');
  ok(srv.includes('iframe.rr-player') && srv.includes('a.play-video'), 'reproductor propio para episodios de Latanime');
  ok(srv.includes("/api/anime/") && srv.includes('var\\s+eps'), 'API de animes (var eps)');
  ok(srv.includes('String.fromCharCode(ch.charCodeAt(0) - 2)'), 'bypass del protector de enlaces (v64)');
  /* v65 */
  ok(srv.includes("const UI_VERSION = 'v69'"), 'servidor en v69');
  ok(js.includes("const APP_VERSION = 'v69'"), 'cliente en v69');
  ok(fs.existsSync('public/sites/latanime.png') && fs.existsSync('public/sites/animeflv.png'), 'logos locales de Latanime y AnimeFLV en /sites/');
  const iS = js.indexOf('let SITES');
  ok(iS >= 0 && iS < js.indexOf("name: 'Latanime'") && js.indexOf("name: 'Latanime'") < js.indexOf("name: 'Cuevana'"), 'SITES del cliente: Latanime primero (predeterminado)');
  const bloqueSites = js.slice(iS, js.indexOf('];', iS));
  const iSeed = srv.indexOf('SITES_SEED');
  const bloqueSeed = srv.slice(iSeed, srv.indexOf('];', iSeed));
  ok(!bloqueSites.includes('google.com/s2') && !bloqueSeed.includes('google.com/s2'), 'directorio sin favicons de Google (adiós recuadro azul con ?)');
  ok(!bloqueSites.includes("name: 'AnimeFLV'") && !bloqueSites.includes("name: 'GoPelis'") && !bloqueSeed.includes("name: 'AnimeFLV'") && !bloqueSeed.includes("name: 'GoPelis'"), 'v68: sin AnimeFLV ni GoPelis en el directorio');
  ok(idx.includes('id="liveSite"') && idx.includes('id="liveSiteImg"'), 'HTML: chip del sitio junto a "En vivo"');
  ok(idx.includes('Buscar películas') && !idx.includes('pagePickName'), 'HTML: botón "Buscar películas" en la sala');
  ok(srv.includes('en Cuevana+Latanime') && srv.includes('- AnimeFLV y GoPelis (v68)'), 'servidor: buscador Cuevana+Latanime y migración que los quita');
  ok(css.includes('flex-direction: row') && css.includes('@media (max-width: 980px)'), 'CSS v68: play en fila abajo en celular');
  ok(idx.indexOf('id="animesBox"') < idx.indexOf('id="trendingBox"'), 'v69: sección de animes PRIMERA en el HTML');
  ok(js.includes('hayAlgo') && js.includes('no dependen de que las películas'), 'v69: las secciones cargan independientes');
  ok(css.includes('.video-shell:not(:fullscreen):not(:-webkit-full-screen):not(.pseudo-fs) .ctrl-layer .mirror-nav') && css.includes('order: -1'), 'CSS v66: botones 10/30/lupa ARRIBA de la barrita en vista normal');
  ok(!css.includes('.pseudo-fs) #msBar'), 'CSS v66: la barra de búsqueda sale ABAJO en vista normal (sin regla de arriba)');
  ok(css.includes('#msBar { z-index: 32; }') && css.includes('.ms-results { z-index: 32; }'), 'CSS v66: búsqueda nunca detrás de los controles (z-index)');
  ok(css.includes('body.ctrls-vis .msg-ticker'), 'CSS v65: tira de mensajes se sube con controles visibles');
  ok(js.includes("classList.add('ctrls-vis')"), 'JS: clase ctrls-vis al mostrar controles');
  ok(srv.includes("s.logo = '/sites/latanime.png'") && srv.includes('l.unshift'), 'servidor: migración de directorio (Latanime primero + logo propio)');
  ok(idx.includes('id="animesBox"') && idx.includes('Animes del momento'), 'HTML: sección "Animes del momento" en el inicio');
  ok(js.includes("d.animes") && js.includes('#animesRow'), 'JS: fila de animes del momento conectada al /api/trending');
  ok(srv.includes('animesDelMomento') && srv.includes('latanime.org/emision'), 'servidor: estrenos de Latanime conectados');
  ok(srv.includes("'/api/img'") && srv.includes('imgProxyCache'), 'servidor: proxy propio de imágenes (/api/img)');
  ok(js.includes("'/api/img?u=' + encodeURIComponent") && !js.includes("wsrv.nl/?url=' + srcImg"), 'JS: carátulas de animes por el proxy propio (no wsrv)');

  /* ---------- 0b) APIs ---------- */
  console.log('— APIs —');
  const aniL = await fetch(BASE + '/api/anime/dragon-ball-daima-latino?site=latanime').then((r) => r.json()).catch(() => null);
  ok(aniL && aniL.ok === true, '/api/anime Latanime responde ok');
  ok(aniL && aniL.episodios && aniL.episodios.length >= 15, `daima-latino: ${aniL ? aniL.episodios.length : 0} episodios`);
  ok(aniL && aniL.episodios && /latanime\.org\/ver\/dragon-ball-daima-latino-episodio-1$/.test(aniL.episodios[0].url), `episodio 1 → ${aniL ? aniL.episodios[0].url.slice(0, 62) : ''}`);
  ok(aniL && /Daima/i.test(aniL.titulo || ''), `título Latanime: "${aniL ? aniL.titulo : ''}"`);
  const ser = await fetch(BASE + '/api/serie/the-walking-dead').then((r) => r.json()).catch(() => null);
  const tempsTWD = ser ? [...new Set(ser.episodios.map((x) => x.temporada))] : [];
  ok(ser && ser.ok && ser.episodios.length > 50, `/api/serie sigue ok (${ser ? ser.episodios.length : 0} eps TWD)`);
  ok(tempsTWD.length === 11, `TWD con sus 11 temporadas reales (${tempsTWD.length})`);
  const sitesT = await fetch(BASE + '/api/trending').then((r) => r.json()).catch(() => null);
  ok(!!sitesT && sitesT.ok === true, '/api/trending responde ok');
  const bus = await fetch(BASE + '/api/search?q=dragon').then((r) => r.json()).catch(() => null);
  const latR = ((bus && bus.results) || []).filter((x) => x.site === 'Latanime');
  ok(latR.length >= 3, `buscador incluye Latanime (${latR.length} resultados)`);
  const fueraR = ((bus && bus.results) || []).filter((x) => /animeflv|gopelis/i.test(x.site || ''));
  ok(fueraR.length === 0, `buscador sin AnimeFLV ni GoPelis (${fueraR.length} resultados de esos)`);
  /* v65: directorio */
  const sitesR = await fetch(BASE + '/api/sites').then((r) => r.json()).catch(() => null);
  const sl = (sitesR && sitesR.sites) || [];
  ok(sl.length >= 4 && /latanime\./i.test(sl[0].url || '') && sl[0].logo === '/sites/latanime.png', `directorio: Latanime primero (${sl[0] ? sl[0].name + ' / ' + sl[0].logo : '—'})`);
  /* v67: animes del momento */
  const anm = (sitesT && sitesT.animes) || [];
  ok(anm.length >= 10, `animes del momento: ${anm.length} con carátula`);
  ok(anm.every((x) => /latanime\.org\/anime\//.test(x.url) && x.img && x.title), 'animes con URL de Latanime, título y carátula');
  ok(anm.some((x) => /latino|castellano|censura/i.test(x.extra || '')), `idioma como extra (${(anm[0] || {}).extra})`);
  ok(!/\s(latino|castellano)$/i.test((anm[0] || {}).title || ''), `título limpio sin "Latino" pegado: "${(anm[0] || {}).title}"`);
  /* v67: proxy propio de imágenes (wsrv ya no puede con Latanime) */
  const imgU = anm[0] ? anm[0].img : '';
  const imgR = await fetch(BASE + '/api/img?u=' + encodeURIComponent(imgU)).catch(() => null);
  ok(!!imgR && imgR.ok && /image\//.test(imgR.headers.get('content-type') || ''), `proxy propio sirve la carátula (${imgR ? imgR.status + ' ' + (imgR.headers.get('content-type') || '') : 'sin respuesta'})`);
  const imgX = await fetch(BASE + '/api/img?u=' + encodeURIComponent('https://www.google.com/logo.png')).catch(() => null);
  ok(!!imgX && imgX.status === 403, 'proxy propio rechaza hosts que no son de animes');

  /* ---------- USUARIO A (anfitrión) ---------- */
  console.log('— Usuario A (anfitrión) —');
  const bA = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const pA = await bA.newPage();
  /* ojo: el sandbox tiene poca RAM — el viewport ancho solo se usa cuando
     toca medir posiciones de escritorio (más abajo), no durante el video */
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

  /* ---------- v65: directorio — Latanime predeterminado con logo propio ---------- */
  console.log('— Directorio: Latanime predeterminado —');
  await pA.evaluate(() => abrirSetup());
  await pA.waitForSelector('#setupBox:not(.hidden)', { timeout: 10000 });
  await sleep(700); /* cargarSitios() ya reemplazó SITES con el directorio del servidor */
  const grid = await pA.evaluate(() => {
    const cards = [...document.querySelectorAll('#setupGrid .setup-card')];
    const p = cards[0];
    const logo = p ? p.querySelector('.sc-logo') : null;
    return {
      n: cards.length,
      nombre: p ? p.querySelector('.sc-name').textContent : '',
      src: logo && logo.tagName === 'IMG' ? logo.getAttribute('src') : '',
      cargado: logo && logo.tagName === 'IMG' ? logo.naturalWidth > 0 : false,
      logos: cards.map((c) => { const i = c.querySelector('.sc-logo'); return !i || i.tagName !== 'IMG' || i.naturalWidth > 0; }),
    };
  });
  ok(grid.nombre === 'Latanime', `primera card del setup: "${grid.nombre}" (predeterminada)`);
  ok(grid.src === '/sites/latanime.png' && grid.cargado, 'logo de Latanime carga desde /sites/');
  ok(grid.logos.every(Boolean), `los ${grid.n} logos del directorio cargan (sin recuadros con ?)`);
  const nombresGrid = await pA.evaluate(() => [...document.querySelectorAll('#setupGrid .sc-name')].map((x) => x.textContent));
  ok(!nombresGrid.includes('AnimeFLV') && !nombresGrid.includes('GoPelis'), `directorio sin AnimeFLV ni GoPelis: ${nombresGrid.join(', ')}`);
  await pA.evaluate(() => cerrarSetup());
  await sleep(400);

  /* ---------- v67: fila "Animes del momento" en el inicio ---------- */
  console.log('— Animes del momento (v67) —');
  await pA.waitForSelector('#animesBox:not(.hidden)', { timeout: 30000 });
  const filaAnm = await pA.evaluate(() => {
    const cards = [...document.querySelectorAll('#animesRow .sr-card')];
    const c = cards[0];
    const im = c ? c.querySelector('img.sr-cover') : null;
    return {
      n: cards.length,
      nombre: c ? c.querySelector('.sr-nombre').textContent : '',
      extra: c ? (c.querySelector('.sr-extra') || {}).textContent : '',
      cargada: im ? im.complete && im.naturalWidth > 0 : false,
      viaProxy: im ? /\/api\/img\?u=/.test(im.src) : false,
    };
  });
  ok(filaAnm.n >= 8, `fila de animes con ${filaAnm.n} carátulas`);
  ok(filaAnm.cargada && filaAnm.viaProxy, `primera carátula carga: "${filaAnm.nombre}" (${filaAnm.extra})`);
  /* un toque abre el selector de episodios como cualquier anime */
  await pA.click('#animesRow .sr-card');
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 15000 });
  let epsAnm = 0;
  await pA.waitForFunction(() => document.querySelectorAll('#spEpisodios .sp-ep').length > 0, { timeout: 90000 }).then(() => { epsAnm = 1; }).catch(() => { epsAnm = 0; });
  ok(epsAnm === 1, 'tocar un anime del momento abre su selector de episodios');
  if (epsAnm) {
    const pkAnm = await pA.evaluate(() => ({
      titulo: document.querySelector('#spTitle').textContent,
      eps: document.querySelectorAll('#spEpisodios .sp-ep').length,
    }));
    ok(pkAnm.eps >= 1, `"${pkAnm.titulo}" con ${pkAnm.eps} episodio(s)`);
  }
  await pA.evaluate(() => cerrarSeriePicker());
  await sleep(400);

  /* v69: el orden en pantalla — animes PRIMERO */
  const orden = await pA.evaluate(() => {
    const a = document.querySelector('#animesBox').getBoundingClientRect();
    const t = document.querySelector('#trendingBox').getBoundingClientRect();
    return { aTop: a.top, tTop: t.top, aVis: !document.querySelector('#animesBox').classList.contains('hidden'), tVis: !document.querySelector('#trendingBox').classList.contains('hidden') };
  });
  ok(orden.aVis && orden.tVis && orden.aTop <= orden.tTop, `secciones en orden: Animes del momento ARRIBA (${Math.round(orden.aTop)} ≤ ${Math.round(orden.tTop)})`);

  ok(errsA.length === 0, `A sin errores JS${errsA.length ? ' → ' + errsA[0] : ''}`);
  await bA.close();
  ok(errsA.length === 0, `A sin errores JS${errsA.length ? ' → ' + errsA[0] : ''}`);

  await bA.close();
  console.log(fallos === 0 ? '\nTODO-OK' : `\nFALLOS: ${fallos}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR E2E:', e.message); process.exit(1); });
