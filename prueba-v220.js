/* Prueba v220: al adelantar la película, si el CDN no tiene ese pedacito,
   el reproductor debe SALTARLO y seguir — nunca volver al inicio. */
const puppeteer = require('puppeteer');
const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const avisos = [];
  const fallos = [];
  p.on('console', (m) => { const t = m.text(); if (/salto|no está guardado|reconect/i.test(t)) avisos.push(t.slice(0, 120)); });
  p.on('response', (r) => { if (r.status() >= 400 && r.url().includes('.ts')) fallos.push(r.status() + ' ' + r.url().slice(-28)); });
  await p.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await esperar(2500);
  await p.type('#userNick', 'saltos' + Math.floor(Math.random() * 900 + 100));
  await p.evaluate(() => { const b2 = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Entrar'); if (b2) b2.click(); });
  await esperar(9000);
  await p.evaluate(() => { const t = document.querySelector('#tabSolo'); if (t) t.click(); });
  await esperar(4000);
  console.log('--- abro la SEGUNDA tarjeta de Movie (The Runner, que tiene huecos) ---');
  await p.evaluate(() => { const cs = [...document.querySelectorAll('#nvdRow .sr-card')]; const c = cs[2] || cs[0]; c.scrollIntoView({ block: 'center' }); c.click(); });
  await esperar(8000);
  await p.evaluate(() => { const el = document.querySelector('#spEpisodios .sp-ep'); if (el) el.click(); });
  await esperar(15000);
  let v = await p.evaluate(() => { const vs = [...document.querySelectorAll('video')].filter((x) => x.currentSrc || x.src); const vv = vs[vs.length - 1]; return vv ? { t: +vv.currentTime.toFixed(1), dur: vv.duration } : null; });
  console.log('estado inicial:', JSON.stringify(v));
  console.log('--- adelanto a un tramo con huecos (minuto ~1:40) ---');
  await p.evaluate(() => { const vs = [...document.querySelectorAll('video')].filter((x) => x.currentSrc || x.src); const vv = vs[vs.length - 1]; if (vv) { vv.currentTime = 100; vv.play && vv.play(); } });
  await esperar(25000);
  v = await p.evaluate(() => { const vs = [...document.querySelectorAll('video')].filter((x) => x.currentSrc || x.src); const vv = vs[vs.length - 1]; return vv ? { t: +vv.currentTime.toFixed(1), dur: vv.duration, red: vv.networkState, err: vv.error && vv.error.code } : null; });
  console.log('estado tras adelantar:', JSON.stringify(v));
  console.log('avisos en pantalla:', JSON.stringify(avisos.slice(-6)));
  console.log('segmentos que fallaron:', fallos.length, fallos.slice(0, 3).join(' | '));
  await b.close();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
