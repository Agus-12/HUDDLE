/* Prueba v221: el botón «Ver todo» de la fila Movie debe abrir el catálogo
   completo (441 títulos por apartados) y una tarjeta debe abrir su ficha. */
const puppeteer = require('puppeteer');
const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await b.newPage();
  const errores = [];
  p.on('pageerror', (e) => errores.push('[JS] ' + String(e).slice(0, 160)));
  p.on('response', (r) => { const u = r.url(); if (u.includes('/api/') && r.status() >= 500) errores.push('[red ' + r.status() + '] ' + u.replace(BASE, '').slice(0, 90)); });
  await p.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await esperar(2500);
  await p.type('#userNick', 'catalogo' + Math.floor(Math.random() * 900 + 100));
  await p.evaluate(() => { const b2 = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Entrar'); if (b2) b2.click(); });
  await esperar(9000);
  await p.evaluate(() => { const t = document.querySelector('#tabSolo'); if (t) t.click(); });
  await esperar(4000);
  console.log('--- toco «Ver todo» de la fila Movie ---');
  await p.evaluate(() => { const v = document.querySelector('#nvdBox .ver-todo'); v.scrollIntoView({ block: 'center' }); v.click(); });
  await esperar(6000);
  let info = await p.evaluate(() => {
    const visor = document.querySelector('#catPage');
    const tarjetas = document.querySelectorAll('#catGrid .sr-card');
    return { abierto: visor && !visor.classList.contains('hidden'), titulo: (document.querySelector('#catTitulo') || {}).innerText, total: (document.querySelector('#catTotal') || {}).innerText, tarjetas: tarjetas.length, primera: tarjetas[0] ? tarjetas[0].querySelector('.sr-nombre').textContent : null };
  });
  console.log('catálogo:', JSON.stringify(info));
  console.log('--- bajo para que cargue la página 2 ---');
  await p.evaluate(() => { const s = document.querySelector('#catScroll'); s.scrollTop = s.scrollHeight; });
  await esperar(6000);
  info = await p.evaluate(() => ({ tarjetas: document.querySelectorAll('#catGrid .sr-card').length, total: (document.querySelector('#catTotal') || {}).innerText }));
  console.log('tras bajar:', JSON.stringify(info));
  console.log('--- abro la primera tarjeta ---');
  await p.evaluate(() => { document.querySelector('#catGrid .sr-card').click(); });
  await esperar(8000);
  const eps = await p.evaluate(() => [...document.querySelectorAll('#spEpisodios .sp-ep')].map((x) => x.innerText.trim()));
  console.log('episodios de la ficha abierta:', JSON.stringify(eps));
  console.log('errores:', errores.length ? errores.slice(-5).join(' | ') : '(ninguno)');
  await b.close();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
