const puppeteer = require('puppeteer');
const BASE = process.env.BASE || 'http://129.80.212.92:3000';
const paso = (t) => console.log('\n=== ' + t + ' ===');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const p = await b.newPage();
  const logs = [];
  p.on('console', (m) => { const t = m.text(); if (t) logs.push('[' + m.type() + '] ' + t.slice(0,180)); });
  p.on('pageerror', (e) => logs.push('[ERROR JS] ' + String(e).slice(0,250)));
  p.on('response', (r) => { const u = r.url(); if (u.includes('/api/')) logs.push('[red] ' + r.status() + ' ' + u.replace(BASE,'').slice(0,120)); });
  await p.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));
  paso('entrando');
  await p.type('#userNick', 'pruebachat');
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === 'Entrar'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 9000));
  await p.screenshot({ path: 'auditorias/paso1-home.png' });
  const fila = await p.evaluate(() => {
    const f = document.querySelector('#nvdRow');
    return { caja: !!document.querySelector('#nvdBox:not(.hidden)'), tarjetas: f ? f.children.length : -1,
             primera: f && f.children[0] ? { url: f.children[0].dataset.url, txt: (f.children[0].querySelector('.sr-nombre')||{}).textContent } : null };
  });
  console.log('FILA MOVIE:', JSON.stringify(fila));
  if (!fila.primera) { console.log('--- LOG ---\n' + logs.slice(-25).join('\n')); await b.close(); return; }
  paso('toco la tarjeta: ' + fila.primera.txt);
  await p.evaluate(() => { document.querySelector('#nvdRow .sr-card').scrollIntoView({block:'center'}); });
  await new Promise(r => setTimeout(r, 800));
  await p.evaluate(() => { document.querySelector('#nvdRow .sr-card').click(); });
  await new Promise(r => setTimeout(r, 8000));
  await p.screenshot({ path: 'auditorias/paso2-picker.png' });
  console.log('--- PANTALLA ---\n' + (await p.evaluate(() => document.body.innerText)).replace(/\n{2,}/g,'\n').slice(0, 700));
  const eps = await p.evaluate(() => [...document.querySelectorAll('#spEpisodios button, #spEpisodios .sp-ep')].map(x => x.innerText.trim()).slice(0,4));
  console.log('EPISODIOS:', JSON.stringify(eps));
  paso('le doy play al primer episodio');
  await p.evaluate(() => { const el = document.querySelector('#spEpisodios button, #spEpisodios .sp-ep'); if (el) el.click(); });
  await new Promise(r => setTimeout(r, 12000));
  await p.screenshot({ path: 'auditorias/paso3-play.png' });
  const video = await p.evaluate(() => { const v = document.querySelector('video'); return v ? { src: (v.currentSrc||v.src||'').slice(0,120), t: v.currentTime, dur: v.duration, err: v.error && v.error.message, red: v.networkState } : null; });
  console.log('VIDEO:', JSON.stringify(video));
  console.log('--- LOG ---\n' + logs.slice(-30).join('\n'));
  await b.close();
})().catch(e => { console.error('ERROR', e); process.exit(1); });
