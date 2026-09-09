/* captura-v98: PelisXD en la búsqueda (sección propia) + una peli reproducéndose en Solo */
const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cap' + Math.random().toString(36).slice(2, 7) }) }).then((r) => r.json());
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.evaluate((n, t) => { localStorage.setItem('rr-profile', JSON.stringify({ name: n, token: t })); localStorage.setItem('huddle_tab', 'solo'); }, login.name, login.token);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);

  /* 1) buscar "juego de ender" — sección PelisXD */
  const busco = await p.evaluate(async () => {
    const i = document.querySelector('#homeSearch');
    if (!i) return 'sin-input';
    i.value = 'juego de ender';
    try { await buscarInicio(); return true; } catch (e) { return 'err:' + e.message; }
  });
  console.log('búsqueda disparada:', busco);
  let xd = null;
  for (let k = 0; k < 30 && !xd; k++) {
    await sleep(1000);
    xd = await p.evaluate(() => {
      const secs = [...document.querySelectorAll('.sr-sec')];
      const xdSec = secs.find((s) => s.querySelector('.sr-sec-titulo img[src*="pelisxd"]'));
      if (!xdSec) return null;
      return { sitios: secs.map((s) => (s.querySelector('.sr-sec-titulo span') || {}).textContent), cardsXD: xdSec.querySelectorAll('[class*=card]').length, primera: (xdSec.querySelector('.sr-nombre') || {}).textContent || '' };
    }).catch(() => null);
  }
  console.log('resultados PelisXD:', JSON.stringify(xd));
  if (xd) await p.screenshot({ path: 'captura-v98-busqueda.png', fullPage: false });

  /* 2) abrir la peli de PelisXD en Solo y dejar que reproduzca */
  const r = await fetch(BASE + '/api/search?q=' + encodeURIComponent('juego de ender')).then((x) => x.json()).catch(() => null);
  const peli = r && (r.results || []).find((x) => x.site === 'PelisXD');
  console.log('peli para Solo:', peli && peli.title, peli && peli.url);
  if (peli) {
    await p.evaluate((u) => { abrirSolo(u, { title: 'El juego de Ender' }); }, peli.url);
    let vid = null;
    for (let k = 0; k < 45 && !vid; k++) {
      await sleep(2000);
      vid = await p.evaluate(() => {
        const v = document.querySelector('#soloVideo');
        if (!v || v.readyState < 2) return null;
        return { dur: isFinite(v.duration) ? Math.round(v.duration / 60) : 0, t: Math.round(v.currentTime), src: (v.currentSrc || v.src || '').slice(0, 40) };
      }).catch(() => null);
    }
    console.log('reproduciendo:', JSON.stringify(vid));
    if (vid) {
      await sleep(2500);
      await p.screenshot({ path: 'captura-v98-solo.png', fullPage: false });
      const dur = await p.evaluate(() => { const v = document.querySelector('#soloTime'); return v ? v.textContent : ''; });
      console.log('barrita:', dur);
    }
  }
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
