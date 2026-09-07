/* E2E v60: pantalla COMPLETA de espera desde el menú + carátula sin recortes
 * + adelantar/atrasar la película + todo lo anterior */
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

  /* A toca la primera card de SERIES → sala con espejo de serie */
  await pA.click('#seriesRow .sr-card');
  /* v60: la espera sale INMEDIATA, a pantalla completa, antes de entrar */
  await pA.waitForSelector('#peliLoading:not(.hidden)', { timeout: 15000 });
  const peli = await pA.evaluate(() => ({
    nombre: document.querySelector('#peliNombre').textContent,
    poster: (document.querySelector('#peliPoster').src || '').slice(0, 50),
    estado: document.querySelector('#peliEstado').textContent,
    sub: document.querySelector('#peliSub').textContent,
    fijada: getComputedStyle(document.querySelector('#peliLoading')).position  }));
  ok(!!peli.nombre, `pantalla de espera inmediata: "${peli.nombre}"`);
  ok(peli.fijada === 'fixed', 'espera a pantalla completa (fixed)');
  ok(/serie/i.test(peli.estado), `texto serie: "${peli.estado}" / "${peli.sub}"`);
  ok(/w342|image\.tmdb/.test(peli.poster), `carátula: ${peli.poster}`);
  /* esperar a que la carátula cargue de verdad para medir su proporción */
  await pA.waitForFunction(() => {
    const po = document.querySelector('#peliPoster');
    const r = po.getBoundingClientRect();
    return po.complete && r.width > 50 && r.height > 50;
  }, { timeout: 15000 }).catch(() => {});
  const ratio = await pA.evaluate(() => {
    const r = document.querySelector('#peliPoster').getBoundingClientRect();
    return r.height ? (r.width / r.height).toFixed(3) : 'NaN';
  });
  ok(Math.abs(parseFloat(ratio) - 0.667) < 0.05, `carátula SIN recortes (ratio ${ratio} ≈ 2:3)`);
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const code = await pA.evaluate(() => location.hash.slice(1));
  ok(!!code, `sala creada: ${code}`);
  /* v60: en series, la espera se quita SOLA cuando la página ya se ve */
  await pA.waitForFunction(() => document.querySelector('#peliLoading').classList.contains('hidden'), { timeout: 60000 });
  ok(true, 'serie: espera se quitó sola al renderizar la página');
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

  /* ---------- v58: película de Populares → empieza directa ---------- */
  console.log('— Película empieza directa (v58) —');
  await pA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pA.waitForSelector('#trendingBox:not(.hidden)', { timeout: 30000 });
  await pA.click('#trendingRow .sr-card');
  await pA.waitForFunction(() => location.hash.match(/^#[A-Z0-9]{4,8}$/), { timeout: 20000 });
  const codeP = await pA.evaluate(() => location.hash.slice(1));
  ok(!!codeP, `sala de película: ${codeP}`);
  await pA.waitForFunction(() => { const c = document.querySelector('#mirrorImg'); return c && c.width > 10; }, { timeout: 100000 }).catch(() => {});
  const mm1 = await movioCanvas(pA).catch(() => -1);
  await sleep(5000);
  const mm2 = await movioCanvas(pA).catch(() => -2);
  await sleep(5000);
  const mm3 = await movioCanvas(pA).catch(() => -3);
  ok(mm1 !== mm2 && mm2 !== mm3 && mm2 > 0, `película en movimiento (canvas ${mm1}→${mm2}→${mm3})`);
  /* v59: cuando la peli suena, la espera se quita SOLA */
  await pA.waitForFunction(() => document.querySelector('#peliLoading').classList.contains('hidden'), { timeout: 40000 });
  ok(true, 'pantalla de espera se quitó sola al reproducirse');
  /* v60: adelantar / atrasar */
  const seekResp = await pA.evaluate(async () => {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: S.code, userId: S.userId, action: { type: 'mirror', op: 'seek', delta: 30 } }) });
    return r.json();
  }).catch(() => null);
  ok(seekResp && seekResp.ok === true && seekResp.movio === true, `adelantar 30s → ${JSON.stringify(seekResp)}`);
  /* tras adelantar puede haber un momento negro (buffering del salto):
   * tomamos varias muestras y con que CAMBIEN, la peli está viva */
  const muestras = [];
  for (let i = 0; i < 4; i++) { muestras.push(await movioCanvas(pA).catch(() => -i)); await sleep(3500); }
  const vivas = muestras.filter((x, i) => i > 0 && x !== muestras[i - 1]).length;
  ok(vivas >= 2, `película sigue viva tras adelantar (muestras ${muestras.join(' → ')})`);
  const seekBack = await pA.evaluate(async () => {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: S.code, userId: S.userId, action: { type: 'mirror', op: 'seek', delta: -10 } }) });
    return r.json();
  }).catch(() => null);
  ok(seekBack && seekBack.movio === true, 'atrasar 10s también mueve');
  /* botones visibles en la barra del espejo */
  const botones = await pA.evaluate(() => ({
    a: !!document.querySelector('#btnSeekBack'), 
    p: !!document.querySelector('#btnSeekFwd'),
    vis: !document.querySelector('#mirrorNav').classList.contains('hidden'),
  }));
  ok(botones.a && botones.p, 'botones de adelantar/atrasar presentes');

  ok(errsA.length === 0, `A sin errores JS${errsA.length ? ' → ' + errsA[0] : ''}`);
  ok(errsB.length === 0, `B sin errores JS${errsB.length ? ' → ' + errsB[0] : ''}`);

  await bA.close(); await bB.close();
  console.log(fallos === 0 ? '\nTODO-OK' : `\nFALLOS: ${fallos}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR E2E:', e.message); process.exit(1); });
