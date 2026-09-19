/* Prueba de humo v219: la peli del catálogo Movie debe reproducirse SÍN navegador
   remoto, en los dos modos (sala y Solo). Se corre contra un Huddle local. */
const puppeteer = require('puppeteer');
const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function abrir(b) {
  const p = await b.newPage();
  const errores = [];
  p.on('pageerror', (e) => errores.push('[JS] ' + String(e).slice(0, 200)));
  p.on('console', (m) => { const t = m.text(); if (/espej|válida|no se pudo|Chrome/i.test(t)) errores.push('[log] ' + t.slice(0, 200)); });
  p.on('response', (r) => { const u = r.url(); if (u.includes('/api/') && r.status() >= 400) errores.push('[red ' + r.status() + '] ' + u.replace(BASE, '').slice(0, 110)); });
  await p.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await esperar(2500);
  await p.type('#userNick', 'prueba' + Math.floor(Math.random() * 900 + 100));
  await p.evaluate(() => { const b2 = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Entrar'); if (b2) b2.click(); });
  await esperar(9000);
  return { p, errores };
}

async function tocarPeliYEpisodio(p, filaSel) {
  const hay = await p.evaluate((sel) => { const f = document.querySelector(sel); return f ? f.children.length : -1; }, filaSel);
  console.log('   tarjetas en ' + filaSel + ':', hay);
  if (hay <= 0) return null;
  await p.evaluate((sel) => { const c = document.querySelector(sel + ' .sr-card'); c.scrollIntoView({ block: 'center' }); c.click(); }, filaSel);
  await esperar(8000);
  const eps = await p.evaluate(() => [...document.querySelectorAll('#spEpisodios .sp-ep')].map((x) => x.innerText.trim()));
  console.log('   episodios vistos:', JSON.stringify(eps));
  await p.evaluate(() => { const el = document.querySelector('#spEpisodios .sp-ep'); if (el) el.click(); });
  await esperar(14000);
  return p.evaluate(() => {
    const vs = [...document.querySelectorAll('video')].filter((v) => v.currentSrc || v.src);
    const v = vs[vs.length - 1];
    return v ? { src: (v.currentSrc || v.src).slice(0, 90), t: +(v.currentTime || 0).toFixed(1), dur: v.duration, red: v.networkState } : null;
  });
}

(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });

  console.log('\n########## 1) MODO SALA (Juntos) ##########');
  let { p, errores } = await abrir(b);
  let v = await tocarPeliYEpisodio(p, '#nvdRow');
  console.log('   VIDEO EN SALA:', JSON.stringify(v));
  console.log('   PROBLEMAS:', errores.length ? errores.slice(-6).join('\n      ') : '(ninguno)');
  await p.close();

  console.log('\n########## 2) MODO SOLO ##########');
  ({ p, errores } = await abrir(b));
  await p.evaluate(() => { const t = document.querySelector('#tabSolo'); if (t) t.click(); });
  await esperar(6000);
  const filas = await p.evaluate(() => [...document.querySelectorAll('div[id$="Row"]')].map((x) => ({ id: x.id, n: x.children.length })).filter((x) => x.n > 0));
  console.log('   filas con tarjetas en Solo:', JSON.stringify(filas.slice(0, 8)));
  const conMovie = filas.find((f) => /nvd/i.test(f.id)) || filas[0];
  v = conMovie ? await tocarPeliYEpisodio(p, '#' + conMovie.id) : null;
  console.log('   VIDEO EN SOLO:', JSON.stringify(v));
  console.log('   PROBLEMAS:', errores.length ? errores.slice(-8).join('\n      ') : '(ninguno)');
  await p.close();
  await b.close();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
