/* E2E v70: búsqueda solo Cuevana+Latanime (sin secciones viejas),
 * sin AnimeD23 en el directorio, reproductor más alto en celular con
 * el play CENTRADO abajo y la barrita abajo del todo + todo v69/v68 */
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
  ok(srv.includes("const UI_VERSION = 'v70'"), 'servidor en v70');
  ok(js.includes("const APP_VERSION = 'v70'"), 'cliente en v70');
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
  ok(srv.includes('en Cuevana+Latanime') && srv.includes('- AnimeFLV, GoPelis y AnimeD23'), 'servidor: buscador Cuevana+Latanime y migración que los quita');
  ok(idx.indexOf('id="animesBox"') < idx.indexOf('id="trendingBox"'), 'v69: sección de animes PRIMERA en el HTML');
  ok(js.includes("const ordenFijo = ['Cuevana', 'Latanime'];"), 'v70: resultados de búsqueda solo Cuevana y Latanime');
  ok(!/ordenFijo[^\n]*GoPelis/.test(js) && !/ordenFijo[^\n]*AnimeFLV/.test(js), 'v70: sin secciones de GoPelis ni AnimeFLV en los resultados');
  ok(!srv.includes('buscarGopelis') && !srv.includes('buscarAnimeJina'), 'v70: código de búsqueda de GoPelis/AnimeFLV retirado del servidor');
  ok(!js.includes("name: 'AnimeD23'") && !srv.includes("name: 'AnimeD23'"), 'v70: sin AnimeD23 en el directorio');
  ok(srv.includes('gopelis\\.|animed23\\.'), 'v70: migración quita AnimeD23 guardado en el servidor');
  ok(css.includes('flex-direction: column') && css.includes('height: calc(100dvh - 390px)'), 'v70: reproductor alto en celular + play centrado');
  ok(js.includes("$('#pdSearch').focus()"), 'v70: el desplegable abre con la caja lista para escribir');
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
  ok(sl.length === 3 && /latanime\./i.test(sl[0].url || '') && sl[0].logo === '/sites/latanime.png', `v70: directorio de 3 páginas, Latanime primero (${sl[0] ? sl[0].name + ' / ' + sl[0].logo : '—'})`);
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
  const bA = await puppeteer.launch({ headless: 'new', protocolTimeout: 180000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
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
  ok(!nombresGrid.includes('AnimeFLV') && !nombresGrid.includes('GoPelis') && !nombresGrid.includes('AnimeD23'), `v70: directorio limpio sin AnimeFLV/GoPelis/AnimeD23: ${nombresGrid.join(', ')}`);
  await pA.evaluate(() => cerrarSetup());
  await sleep(400);

  /* ---------- v70: buscar en el inicio → solo Cuevana y Latanime ---------- */
  console.log('— Búsqueda del inicio (v70) —');
  await pA.type('#homeSearch', 'dragon ball');
  await pA.click('#btnHomeSearch');
  await pA.waitForFunction(() => document.querySelectorAll('#searchResults .sr-sec').length > 0, { timeout: 30000 });
  await sleep(800);
  const secs70 = await pA.evaluate(() => [...document.querySelectorAll('#searchResults .sr-sec-titulo span')].map((s) => s.textContent));
  ok(secs70.length >= 1 && secs70[0] === 'Cuevana', `primera sección de resultados: Cuevana (${secs70.join(', ')})`);
  ok(!secs70.includes('GoPelis') && !secs70.includes('AnimeFLV') && !secs70.includes('AnimeD23'), 'sin secciones de GoPelis/AnimeFLV/AnimeD23');
  ok(secs70.includes('Latanime'), 'Latanime entre los resultados (no al final escondido)');
  await pA.evaluate(() => { const b = document.querySelector('#btnHomeSearch'); const i = document.querySelector('#homeSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#searchResults').classList.add('hidden'); });

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
  const orden69 = await pA.evaluate(() => {
    const a = document.querySelector('#animesBox').getBoundingClientRect();
    const t = document.querySelector('#trendingBox').getBoundingClientRect();
    return { aTop: a.top, tTop: t.top };
  });
  ok(orden69.aTop <= orden69.tTop, `v69: Animes del momento ARRIBA en el inicio (${Math.round(orden69.aTop)} ≤ ${Math.round(orden69.tTop)})`);
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
  ok(/\/api\/img\?u=/.test(latPk.poster), `póster vía proxy propio (${latPk.poster.slice(0, 46)}…)`);

  /* ---------- episodio de anime LATINO → mismo flujo que una peli ---------- */
  console.log('— Episodio de anime LATINO (Latanime) —');
  await pA.click('#spEpisodios .sp-ep');
  await pA.waitForSelector('#peliLoading:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const codeAni = await pA.evaluate(() => location.hash.slice(1));
  ok(!!codeAni, `sala de anime latino: ${codeAni}`);
  /* v68: el sitio que se ve, junto a "En vivo" + botón "Buscar películas" */
  await pA.waitForFunction(() => !document.querySelector('#liveSite').hidden, { timeout: 15000 }).catch(() => {});
  const chipV68 = await pA.evaluate(() => ({
    visible: !document.querySelector('#liveSite').hidden,
    nombre: document.querySelector('#liveSiteName').textContent,
    logo: document.querySelector('#liveSiteImg').getAttribute('src') || '',
    buscar: document.querySelector('#pagePickBtn').textContent.trim(),
  }));
  ok(chipV68.visible && chipV68.nombre === 'Latanime' && chipV68.logo === '/sites/latanime.png', `chip junto a "En vivo": ${chipV68.nombre} con logo`);
  ok(/Buscar películas/.test(chipV68.buscar), `botón de la sala: "${chipV68.buscar}"`);
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
    ok(/\/api\/img\?u=/.test(invA.poster || '') || /latanime/.test(invA.poster || ''), `invite póster (proxy propio): ${(invA.poster || '').slice(0, 50)}`);
    /* paramos el espejo del anime (igual que el botón Detener) */
    await pA.evaluate(() => { try { sendAction({ type: 'mirror', op: 'stop' }); } catch {} });
    await sleep(2500);
  }

  /* ---------- PELI de cine-calidad con protector de enlaces (v64) ---------- */
  console.log('— Película: bypass del protector —');
  await pA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  await pA.evaluate(() => {
    S.pendingStart = { url: 'https://cine-calidad.mx/pelicula/mayday/', name: 'Mayday', img: '' };
    S.mirrorInfo = { title: 'Mayday', img: '', url: 'https://cine-calidad.mx/pelicula/mayday/', sub: 'Abriendo…' };
    const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    connect(code);
  });
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const codePeli = await pA.evaluate(() => location.hash.slice(1));
  ok(!!codePeli, `sala de película: ${codePeli}`);
  let listoPeli = true;
  await pA.waitForSelector('#playBtn:not(.hidden)', { timeout: 150000 }).catch(() => { listoPeli = false; });
  ok(listoPeli, 'película lista en pausa (bypass del protector) — botón de play visible');
  if (listoPeli) {
    await pA.click('#playBtn');
    await sleep(7000);
    /* el tiempo de la peli avanza (más confiable que el brillo del canvas) */
    const tiempos = [];
    for (let i = 0; i < 4; i++) {
      tiempos.push(await pA.evaluate(() => document.querySelector('#seekCur').textContent));
      await sleep(2500);
    }
    ok(tiempos[0] !== tiempos[3], `película corriendo (${tiempos.join(' → ')})`);
    const barra = await pA.evaluate(() => ({ dur: document.querySelector('#seekDur').textContent }));
    ok(barra.dur !== '0:00', `duración en la barrita (${barra.dur})`);
    await pA.evaluate(() => { try { sendAction({ type: 'mirror', op: 'stop' }); } catch {} });
    await sleep(2000);
  }

  /* ---------- episodio de SERIE + posiciones v65 ---------- */
  console.log('— Episodio de serie: botones sobre la barrita, play al centro (v66) —');
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
  await pA.evaluate(() => { abrirSeriePicker({ url: 'https://cine-calidad.mx/serie/peaky-blinders/', title: 'Peaky Blinders', img: '' }, false, false); });
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
  /* viewport de escritorio para las medidas (más de 980px de ancho) */
  await pA.setViewport({ width: 1280, height: 800 });
  await sleep(600);

  /* v66 (vista normal): capa pegada ABAJO, botones ARRIBA de la barrita,
   * y el botón de "Toca para empezar" al CENTRO del video */
  const pos = await pA.evaluate(() => {
    const L = document.querySelector('#ctrlLayer').getBoundingClientRect();
    const M = document.querySelector('#mirrorLayer').getBoundingClientRect();
    const W = document.querySelector('#seekWrap').getBoundingClientRect();
    const N = document.querySelector('#mirrorNav').getBoundingClientRect();
    const C = document.querySelector('.play-circulo') ? document.querySelector('.play-circulo').getBoundingClientRect() : null;
    return {
      lb: L.bottom, mb: M.bottom, mt: M.top,
      wtop: W.top, ntop: N.top,
      ctop: C ? C.top : 0, cbot: C ? C.bottom : 0,
    };
  });
  ok(Math.abs(pos.lb - pos.mb) < 6, `capa de controles pegada al FONDO del video (${Math.round(pos.lb)}/${Math.round(pos.mb)}px)`);
  ok(pos.ntop < pos.wtop, `botones 10/30/lupa ARRIBA de la barrita (nav ${Math.round(pos.ntop)} < barra ${Math.round(pos.wtop)})`);
  const centroCirc = (pos.ctop + pos.cbot) / 2, centroVideo = (pos.mt + pos.mb) / 2;
  ok(Math.abs(centroCirc - centroVideo) < 60, `"Toca para empezar" al CENTRO del video (círculo ${Math.round(centroCirc)} vs centro ${Math.round(centroVideo)})`);
  /* v66: la barra de búsqueda sale ABAJO (como la lupa, que está abajo) */
  const msPos = await pA.evaluate(() => {
    const bar = document.querySelector('#msBar');
    bar.classList.remove('hidden');
    const B = bar.getBoundingClientRect();
    const M = document.querySelector('#mirrorLayer').getBoundingClientRect();
    bar.classList.add('hidden');
    return { top: B.top - M.top, bot: M.bottom - B.bottom };
  });
  ok(msPos.bot < 30 && msPos.bot >= -2, `barra de búsqueda ABAJO en vista normal (a ${Math.round(msPos.bot)}px del fondo)`);

  /* v65: en pantalla completa (simulada) todo se queda como en v62 */
  await pA.evaluate(() => enterPseudoFs());
  await sleep(400);
  const posFs = await pA.evaluate(() => {
    const L = document.querySelector('#ctrlLayer').getBoundingClientRect();
    const M = document.querySelector('#mirrorLayer').getBoundingClientRect();
    const W = document.querySelector('#seekWrap').getBoundingClientRect();
    const N = document.querySelector('#mirrorNav').getBoundingClientRect();
    const just = getComputedStyle(document.querySelector('#playBtn')).justifyContent;
    const bar = document.querySelector('#msBar');
    bar.classList.remove('hidden');
    const B = bar.getBoundingClientRect();
    bar.classList.add('hidden');
    return { lb: L.bottom, mb: M.bottom, just, bBot: M.bottom - B.bottom, wbot: W.bottom, ntop: N.top };
  });
  ok(Math.abs(posFs.lb - posFs.mb) < 6, 'en pantalla completa la capa se queda ABAJO (sin cambios)');
  ok(posFs.just === 'center', 'en pantalla completa el botón de play queda al CENTRO (sin cambios)');
  ok(posFs.ntop >= posFs.wbot - 6, `en pantalla completa los botones van DEBAJO de la barrita (como en v62)`);
  ok(posFs.bBot < 40 && posFs.bBot >= -2, `en pantalla completa la búsqueda sale ABAJO (${Math.round(posFs.bBot)}px del fondo)`);
  await pA.evaluate(() => exitFullscreen());
  await sleep(300);
  await pA.setViewport({ width: 800, height: 600 }); /* de vuelta al liviano */
  await sleep(600);

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
  await sleep(2000); /* rápido: el segundo toque debe caer dentro de los 5s de controles visibles */
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
  const rA1 = await pA.evaluate(() => document.querySelector('#seekCur').textContent);
  await sleep(4000);
  const s2 = await movioCanvas(pA).catch(() => -2);
  const rA2 = await pA.evaluate(() => document.querySelector('#seekCur').textContent);
  ok(s1 !== s2 || rA1 !== rA2, `serie corriendo tras reanudar (${rA1}→${rA2})`); /* v67: canvas negro ≠ parada */

  /* USUARIO B: entra y ve la sala sin errores */
  console.log('— Usuario B (invitado) —');
  const bB = await puppeteer.launch({ headless: 'new', protocolTimeout: 180000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const pB = await bB.newPage();
  const errsB = [];
  pB.on('pageerror', (e) => errsB.push(String(e)));
  await pB.goto(BASE + '/#' + codeSer, { waitUntil: 'networkidle2', timeout: 60000 });
  await pB.waitForSelector('#inviteHero:not(.hidden)', { timeout: 15000 });
  await pB.type('#userNick', NOMBRE_B);
  await pB.click('#btnLogin');
  await pB.waitForFunction(() => !document.querySelector('#room').classList.contains('hidden'), { timeout: 30000 });
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

  /* ---------- v65: mensajes del chat con el nuevo acomodo ---------- */
  console.log('— Mensajes del chat (v65) —');
  /* A en pantalla completa + controles visibles → la tira se sube sobre ellos */
  await pA.evaluate(() => enterPseudoFs());
  await sleep(400);
  await tocarCanvas(pA);
  const lift = await pA.evaluate(() => ({
    vis: document.querySelector('#ctrlLayer').classList.contains('visible'),
    cls: document.body.classList.contains('ctrls-vis'),
    bot: getComputedStyle(document.querySelector('#msgTicker')).bottom,
  }));
  ok(lift.vis && lift.cls && botPx(lift.bot) > 100, `con controles visibles, la tira de mensajes se sube (bottom ${lift.bot})`);
  /* B manda un mensaje → A lo ve deslizarse en la tira */
  await pB.type('#chatInput', 'hola desde B ' + RUN);
  await pB.keyboard.press('Enter');
  await pA.waitForFunction(() => document.querySelector('#msgTicker').classList.contains('run'), { timeout: 8000 });
  const tickTxt = await pA.evaluate(() => document.querySelector('#msgTickerInner').textContent);
  ok(/hola desde B/.test(tickTxt), `mensaje de B en la tira deslizante: "${tickTxt.trim().slice(0, 40)}…"`);
  /* a los 5s los controles se esconden → la tira baja al margen */
  await sleep(5300);
  const unlift = await pA.evaluate(() => ({
    cls: document.body.classList.contains('ctrls-vis'),
    bot: getComputedStyle(document.querySelector('#msgTicker')).bottom,
  }));
  ok(!unlift.cls && botPx(unlift.bot) < 100, `controles fuera → la tira baja de vuelta (bottom ${unlift.bot})`);
  /* otro mensaje con controles escondidos → tira al margen, sin tapar nada */
  await pB.type('#chatInput', 'segundo mensaje');
  await pB.keyboard.press('Enter');
  await sleep(900);
  const tick2 = await pA.evaluate(() => getComputedStyle(document.querySelector('#msgTicker')).bottom);
  ok(botPx(tick2) < 100, `segundo mensaje con la tira al margen (bottom ${tick2})`);
  await pA.evaluate(() => exitFullscreen());
  await sleep(300);
  /* en vista normal el mensaje llega al chat de siempre (columna del chat) */
  const chatA = await pA.evaluate(() => [...document.querySelectorAll('#chatLog .msg')].map((m) => m.textContent).join(' | '));
  ok(/hola desde B/.test(chatA) && /segundo mensaje/.test(chatA), 'vista normal: los mensajes llegan al chat de siempre');

  /* B ya no se necesita: cerramos su navegador antes del celular
     (el entorno de pruebas tiene poca memoria) */
  ok(errsB.length === 0, `B sin errores JS${errsB.length ? ' → ' + errsB[0] : ''}`);
  await bB.close();
  await sleep(500);

  /* ---------- v68: en CELULAR el botón de play va ABAJO del video ---------- */
  console.log('— Celular (v70) —');
  const bM = await puppeteer.launch({ headless: 'new', protocolTimeout: 180000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const pM = await bM.newPage();
  const errsM = [];
  pM.on('pageerror', (e) => errsM.push(String(e)));
  await pM.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await pM.goto(BASE + '/#' + codeSer, { waitUntil: 'networkidle2', timeout: 60000 });
  await pM.waitForSelector('#inviteHero:not(.hidden)', { timeout: 15000 });
  await pM.type('#userNick', 'Mvl' + RUN);
  await pM.click('#btnLogin');
  await pM.waitForFunction(() => !document.querySelector('#room').classList.contains('hidden'), { timeout: 20000 });
  /* A pausa la peli → el botón grande aparece también para el celular */
  await pA.evaluate(() => { try { sendAction({ type: 'mirror', op: 'pause' }); } catch {} });
  await pM.waitForSelector('#playBtn:not(.hidden)', { timeout: 20000 });
  await pM.waitForFunction(() => !document.querySelector('#seekWrap').classList.contains('hidden') && document.querySelector('#seekDur').textContent !== '0:00', { timeout: 30000 });
  await sleep(800);
  const posM = await pM.evaluate(() => {
    const S = document.querySelector('.video-shell').getBoundingClientRect();
    const C = document.querySelector('.play-circulo').getBoundingClientRect();
    const T = document.querySelector('.play-txt').getBoundingClientRect();
    const N = document.querySelector('#mirrorNav').getBoundingClientRect();
    const W = document.querySelector('#seekWrap').getBoundingClientRect();
    return {
      circX: (C.left + C.right) / 2, circY: (C.top + C.bottom) / 2,
      shellH: S.height, shellB: S.bottom, barB: W.bottom,
      textoDebajo: T.top >= C.bottom, navTop: N.top, barTop: W.top,
    };
  });
  ok(posM.shellH > 350, `v70: reproductor más alto en celular (${Math.round(posM.shellH)}px)`);
  ok(Math.abs(posM.circX - 195) <= 20, `v70: círculo de play CENTRADO (${Math.round(posM.circX)} de 195)`);
  ok(posM.textoDebajo, 'v70: "Toca para empezar" DEBAJO del círculo');
  ok(posM.circY > 350, `v70: el play queda ABAJO en la pantalla (${Math.round(posM.circY)})`);
  ok(posM.shellB - posM.barB < 40, `v70: barrita pegada al fondo del reproductor (${Math.round(posM.shellB - posM.barB)}px)`);
  ok(posM.navTop < posM.barTop, 'celular: botones 10/30/lupa arriba de la barrita');
  ok(errsM.length === 0, `celular sin errores JS${errsM.length ? ' → ' + errsM[0] : ''}`);
  await bM.close();
  /* paramos el espejo para no dejar la sala consumiendo memoria del servidor */
  await pA.evaluate(() => { try { sendAction({ type: 'mirror', op: 'stop' }); } catch {} });
  await sleep(1500);

  ok(errsA.length === 0, `A sin errores JS${errsA.length ? ' → ' + errsA[0] : ''}`);

  await bA.close();
  console.log(fallos === 0 ? '\nTODO-OK' : `\nFALLOS: ${fallos}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR E2E:', e.message); process.exit(1); });
