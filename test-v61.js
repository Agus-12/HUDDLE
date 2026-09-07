/* E2E v61: peli/episodio empiezan EN PAUSA + botón grande de play + barrita
 * con tiempo + selector de temporadas/episodios + fix destello + todo lo anterior */
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

(async () => {
  /* ---------- USUARIO A (anfitrión): crea sala desde Populares ---------- */
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
  const cardsA = await pA.$$eval('#trendingRow .sr-card', (n) => n.length);
  ok(cardsA >= 10, `fila Populares hoy: ${cardsA} cards`);
  const seriesVisible = await pA.$eval('#seriesBox', (n) => !n.classList.contains('hidden'));
  if (seriesVisible) {
    const info = await pA.evaluate(() => ({
      n: document.querySelectorAll('#seriesRow .sr-card').length,
      tit: [...document.querySelectorAll('#seriesRow .sr-nombre, #seriesRow .sr-card')].slice(0, 3).map((x) => (x.querySelector('.sr-nombre') || x).textContent.trim().slice(0, 22)),
    }));
    ok(info.n >= 10, `fila Series recién agregadas: ${info.n} cards`);
    const diaTit = await pA.$$eval('#trendingRow .sr-card', (n) => n.map((x) => (x.querySelector('.sr-nombre') || x).textContent.trim()));
    const serTit = await pA.$$eval('#seriesRow .sr-card', (n) => n.map((x) => (x.querySelector('.sr-nombre') || x).textContent.trim()));
    const comun = diaTit.filter((x) => serTit.includes(x));
    ok(comun.length === 0, `filas sin repetirse (${comun.length} iguales)`);
  } else { ok(false, 'fila Series recién agregadas visible'); }

  /* A toca una SERIES → selector de temporadas y episodios (v61) */
  await pA.click('#seriesRow .sr-card');
  await pA.waitForSelector('#seriePicker:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => document.querySelectorAll('#spEpisodios .sp-ep').length > 0, { timeout: 20000 });
  const picker = await pA.evaluate(() => ({
    titulo: document.querySelector('#spTitle').textContent,
    meta: document.querySelector('#spMeta').textContent,
    eps: document.querySelectorAll('#spEpisodios .sp-ep').length,
    temps: document.querySelectorAll('#spTemporadas .sp-temp-btn').length,
    poster: (document.querySelector('#spPoster').getAttribute('src') || '').slice(0, 50),
  }));
  ok(!!picker.titulo, `selector de serie: "${picker.titulo}" (${picker.meta})`);
  ok(picker.eps >= 1 && picker.temps >= 1, `${picker.temps} temporada(s), ${picker.eps} episodio(s)`);
  ok(!!picker.poster, `póster del selector: ${picker.poster}`);
  /* tocar el primer episodio → igual que una peli (v61) */
  await pA.click('#spEpisodios .sp-ep');
  await pA.waitForSelector('#peliLoading:not(.hidden)', { timeout: 15000 });
  const peli = await pA.evaluate(() => ({
    nombre: document.querySelector('#peliNombre').textContent,
    poster: (document.querySelector('#peliPoster').src || '').slice(0, 50),
    estado: document.querySelector('#peliEstado').textContent,
    sub: document.querySelector('#peliSub').textContent,
    fijada: getComputedStyle(document.querySelector('#peliLoading')).position  }));
  ok(/1x\d/.test(peli.nombre), `espera con nombre de episodio: "${peli.nombre}"`);
  ok(peli.fijada === 'fixed', 'espera a pantalla completa (fixed)');
  ok(/w342|image\.tmdb/.test(peli.poster), `carátula: ${peli.poster}`);
  await pA.waitForFunction(() => {
    const po = document.querySelector('#peliPoster');
    return po.complete && po.getBoundingClientRect().width > 50;
  }, { timeout: 15000 }).catch(() => {});
  const ratio = await pA.evaluate(() => {
    const r = document.querySelector('#peliPoster').getBoundingClientRect();
    return r.height ? (r.width / r.height).toFixed(3) : 'NaN';
  });
  ok(Math.abs(parseFloat(ratio) - 0.667) < 0.05, `carátula SIN recortes (ratio ${ratio} ≈ 2:3)`);
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const code = await pA.evaluate(() => location.hash.slice(1));
  ok(!!code, `sala creada: ${code}`);
  /* el episodio queda LISTO EN PAUSA → botón de play → arranca */
  await pA.waitForSelector('#playBtn:not(.hidden)', { timeout: 120000 });
  ok(true, 'episodio listo en pausa — botón de play visible');
  const esperaEp = await pA.$eval('#peliLoading', (n) => n.classList.contains('hidden'));
  ok(esperaEp, 'la espera se quitó al quedar listo el episodio');
  await pA.click('#playBtn');
  await pA.waitForFunction(() => document.querySelector('#playBtn').classList.contains('hidden'), { timeout: 15000 });
  await sleep(6000);
  const em1 = await movioCanvas(pA).catch(() => -1);
  await sleep(4000);
  const em2 = await movioCanvas(pA).catch(() => -2);
  ok(em1 !== em2, `episodio corriendo tras el play (${em1}→${em2})`);
  /* el espejo es un canvas con frames JPEG — esperamos a que dibuje algo */
  await pA.waitForFunction(() => {
    const c = document.querySelector('#mirrorImg');
    if (!c || !c.width) return false;
    try {
      const d = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 40), Math.min(c.height, 40)).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && (d[i - 3] || d[i - 2] || d[i - 1])) return true;
    } catch {}
    return false;
  }, { timeout: 90000 }).catch(() => {});
  const espejo = await pA.evaluate(() => {
    const c = document.querySelector('#mirrorImg');
    const layer = document.querySelector('#mirrorLayer');
    return { capas: !!c, visible: layer && !layer.classList.contains('hidden'), w: c ? c.width : 0 };
  });
  ok(espejo.visible && espejo.w > 10, `espejo dibujando en canvas (${espejo.w}px)`);
  /* v59: la página de la serie DEBE renderizar (no la pantalla azul de cuevana) */
  const brillo = await pA.evaluate(() => {
    const c = document.querySelector('#mirrorImg');
    const d = c.getContext('2d').getImageData(Math.floor(c.width/2) - 50, Math.floor(c.height/2) - 20, 100, 40).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i+1] + d[i+2];
    return s / (d.length / 4);
  });
  ok(brillo > 120, `serie renderizada (brillo promedio ${Math.round(brillo)} — azul cuevana sería ~63)`);
  await sleep(3000);

  /* ---------- endpoint de invitación ---------- */
  console.log('— /api/invite —');
  const inv = await pA.evaluate(async (c) => {
    const r = await fetch('/api/invite/' + c);
    return { status: r.status, d: await r.json() };
  }, code);
  ok(inv.status === 200 && inv.d.ok, `invite ok (host="${inv.d.host}")`);
  ok(inv.d.host === NOMBRE_A, `host = ${inv.d.host}`);
  ok(!!inv.d.title, `título = "${inv.d.title}"`);
  ok(/w342|image\.tmdb/.test(inv.d.poster || ''), `póster = ${(inv.d.poster || '').slice(0, 70)}`);

  /* ---------- USUARIO B (invitado): abre link SIN sesión ---------- */
  console.log('— Usuario B (invitado, sin sesión) —');
  const bB = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pB = await bB.newPage();
  const errsB = [];
  pB.on('pageerror', (e) => errsB.push(String(e)));
  await pB.goto(BASE + '/#' + code, { waitUntil: 'networkidle2', timeout: 60000 });
  await pB.waitForSelector('#inviteHero:not(.hidden)', { timeout: 15000 });
  const inv1 = await pB.evaluate(() => ({
    host: document.querySelector('#inviteHost').textContent,
    peli: document.querySelector('#inviteTitle').textContent,
    poster: document.querySelector('#invitePoster').src,
    bg: document.querySelector('#inviteBg').getAttribute('src') || '',
    join: document.querySelector('#joinCode').value,
    docTitle: document.title,
  }));
  ok(inv1.host === NOMBRE_A, `tarjeta: "${NOMBRE_A} te invita" → "${inv1.host}"`);
  ok(!!inv1.peli, `película: "${inv1.peli}"`);
  ok(/w342|image\.tmdb/.test(inv1.poster), `póster en tarjeta: ${inv1.poster.slice(0, 60)}`);
  ok(!!inv1.bg, 'póster de fondo cargado');
  ok(inv1.join.toUpperCase() === code, `código precargado: ${inv1.join}`);

  /* B pone su nombre → debe entrar DIRECTO a la sala */
  await pB.type('#userNick', NOMBRE_B);
  await pB.click('#btnLogin');
  await pB.waitForFunction(() => !document.querySelector('#room').classList.contains('hidden'), { timeout: 20000 });
  const usersB = await pB.evaluate(() => document.querySelectorAll('#usersList .u, #userList .u, .user-chip').length);
  ok(true, 'Beto entró directo a la sala tras el login');
  const lastRoom = await pB.evaluate(() => JSON.parse(localStorage.getItem('huddle_lastRoom') || 'null'));
  ok(lastRoom && lastRoom.code === code, `lastRoom guardado: ${JSON.stringify(lastRoom)}`);

  /* ---------- volver a tu sala ---------- */
  console.log('— ¿Volver a tu sala? —');
  await pB.goto(BASE + '/', { waitUntil: 'networkidle2' }); /* sin hash */
  await pB.waitForSelector('#volverBox:not(.hidden)', { timeout: 15000 });
  const vol = await pB.evaluate(() => ({
    t: document.querySelector('#volverTitle').textContent,
    c: document.querySelector('#volverCode').textContent,
    p: document.querySelector('#volverPoster').getAttribute('src') || '',
  }));
  ok(!!vol.t, `banner: "Estabas viendo ${vol.t}" (${vol.c})`);
  ok(/w342|image\.tmdb/.test(vol.p), `banner póster: ${vol.p.slice(0, 60)}`);
  await pB.click('#btnVolver');
  await pB.waitForFunction(() => !document.querySelector('#room').classList.contains('hidden'), { timeout: 20000 });
  ok(true, 'botón Volver reingresó a la sala');

  /* ---------- A sigue bien + salida limpia de B ---------- */
  await pB.evaluate(() => { document.querySelector('#btnLeave').click(); });
  await sleep(1500);
  const lastB = await pB.evaluate(() => localStorage.getItem('huddle_lastRoom'));
  ok(lastB === null, 'salir borra el recordatorio');

  /* ---------- v61: película → pausa + botón play + barrita ---------- */
  console.log('— Película: pausa + botón de play + barrita (v61) —');
  await pA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  await pA.click('#trendingRow .sr-card');
  await pA.waitForSelector('#peliLoading:not(.hidden)', { timeout: 15000 });
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const codeP = await pA.evaluate(() => location.hash.slice(1));
  ok(!!codeP, `sala de película: ${codeP}`);
  const sinDestello = await pA.evaluate(() => !document.querySelector('#peliLoading').classList.contains('hidden'));
  ok(sinDestello, 'sin destello: la espera siguió puesta al crear la sala');
  /* la peli queda LISTA EN PAUSA: botón de play */
  await pA.waitForSelector('#playBtn:not(.hidden)', { timeout: 120000 });
  ok(true, 'película lista en pausa — botón de play visible');
  const esperaFue = await pA.$eval('#peliLoading', (n) => n.classList.contains('hidden'));
  ok(esperaFue, 'la espera se quitó al quedar lista');
  await pA.waitForFunction(() => !document.querySelector('#seekWrap').classList.contains('hidden') && document.querySelector('#seekDur').textContent !== '0:00', { timeout: 25000 });
  const barInfo = await pA.evaluate(() => ({ dur: document.querySelector('#seekDur').textContent, cur: document.querySelector('#seekCur').textContent }));
  ok(barInfo.dur !== '0:00', `barrita con duración (${barInfo.cur} / ${barInfo.dur})`);
  /* pausada de verdad: el canvas no cambia */
  const pq1 = await movioCanvas(pA).catch(() => -1);
  await sleep(2500);
  const pq2 = await movioCanvas(pA).catch(() => -2);
  ok(pq1 === pq2, `película en pausa (canvas quieto ${pq1}=${pq2})`);
  /* TOCAR play → arranca */
  await pA.click('#playBtn');
  await pA.waitForFunction(() => document.querySelector('#playBtn').classList.contains('hidden'), { timeout: 15000 });
  ok(true, 'botón de play se fue al tocarlo');
  await sleep(6000);
  const pm1 = await movioCanvas(pA).catch(() => -1);
  await sleep(4000);
  const pm2 = await movioCanvas(pA).catch(() => -2);
  ok(pm1 !== pm2, `película corriendo tras el play (${pm1}→${pm2})`);
  await sleep(4000);
  const bar2 = await pA.evaluate(() => ({ cur: document.querySelector('#seekCur').textContent }));
  ok(bar2.cur !== '0:00', `barrita avanza (${bar2.cur})`);
  /* arrastrar la barrita */
  const dragOk = await pA.evaluate(() => {
    const bar = document.querySelector('#seekBar');
    const r = bar.getBoundingClientRect();
    const ev = (tipo, x) => bar.dispatchEvent(new PointerEvent(tipo, { bubbles: true, clientX: x, clientY: r.top + r.height / 2, pointerId: 7 }));
    ev('pointerdown', r.left + r.width * 0.6);
    ev('pointermove', r.left + r.width * 0.62);
    ev('pointerup', r.left + r.width * 0.62);
    return true;
  });
  await sleep(6000);
  const bar3 = await pA.evaluate(() => ({ cur: document.querySelector('#seekCur').textContent }));
  ok(dragOk && bar3.cur !== '0:00' && bar3.cur !== bar2.cur, `arrastrar la barrita movió la peli (${bar2.cur} → ${bar3.cur})`);
  /* botones 10/30 siguen */
  const seekResp = await pA.evaluate(async () => {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: S.code, userId: S.userId, action: { type: 'mirror', op: 'seek', delta: 30 } }) });
    return r.json();
  }).catch(() => null);
  ok(seekResp && seekResp.movio === true, 'adelantar 30s sigue funcionando');

  ok(errsA.length === 0, `A sin errores JS${errsA.length ? ' → ' + errsA[0] : ''}`);
  ok(errsB.length === 0, `B sin errores JS${errsB.length ? ' → ' + errsB[0] : ''}`);

  await bA.close(); await bB.close();
  console.log(fallos === 0 ? '\nTODO-OK' : `\nFALLOS: ${fallos}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR E2E:', e.message); process.exit(1); });
