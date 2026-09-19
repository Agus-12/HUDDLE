const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:3999';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const p = await b.newPage();
  await p.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await esperar(2500);
  await p.type('#userNick', 'disp' + Math.floor(Math.random()*900+100));
  await p.evaluate(() => { const b2=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Entrar'); if(b2) b2.click(); });
  await esperar(9000);
  await p.evaluate(() => { const t=document.querySelector('#tabSolo'); if(t) t.click(); });
  await esperar(4000);
  await p.evaluate(() => { document.querySelector('#nvdBox .ver-todo').click(); });
  await esperar(7000);
  const info = await p.evaluate(() => ({
    total: document.querySelector('#catTotal').textContent,
    barra: document.querySelector('#catDisp').classList.contains('hidden') ? '(oculta)' : document.querySelector('#catDispTexto').textContent,
    boton: document.querySelector('#catDispBtn').textContent,
    badges: document.querySelectorAll('#catGrid .disp-badge').length,
    ejemplos: [...document.querySelectorAll('#catGrid .disp-badge')].slice(0,4).map(x=>x.textContent),
  }));
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})().catch(e => { console.error('ERROR', e); process.exit(1); });
