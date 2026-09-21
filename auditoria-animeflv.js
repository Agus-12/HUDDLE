/* Auditoría AnimeFLV — sept 2026
 * Fase 1: 2,955 slugs → /ver/<slug>-1 trae data-encrypt?
 * Fase 2: muestra 12 → cadena HTTP completa: enc → POST /flv → mp4upload → mp4 vivo?
 * Uso: node auditoria-animeflv.js [fase1|fase2|todo]
 */
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://vww.animeflv.one/';
const CONC = 8;
async function get(url, ms = 12000, extra = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, ...extra } });
    return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
  } catch (e) { return { ok: false, status: 0, html: '', err: String(e).slice(0, 50) }; } finally { clearTimeout(t); }
}

async function fase1() {
  const slugs = fs.readFileSync('public/animeflv-slugs.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`Slugs: ${slugs.length}`);
  const out = fs.createWriteStream('/tmp/af-audit-fase1.jsonl');
  let ok = 0, dead = 0, done = 0;
  const t0 = Date.now();
  async function worker(q) {
    for (const slug of q) {
      const r = await get(BASE + 'ver/' + slug + '-1');
      let row;
      if (!r.ok) row = { slug, estado: 'MUERTA', status: r.status };
      else {
        const enc = (/class="opt"[^>]*data-encrypt="([0-9a-f]+)"/i.exec(r.html) || [])[1];
        row = { slug, estado: enc ? 'OK' : 'SIN-ENC', status: r.status };
      }
      out.write(JSON.stringify(row) + '\n');
      row.estado === 'OK' ? ok++ : dead++;
      done++;
      if (done % 200 === 0) console.log(`fase1 ${done}/${slugs.length} ok=${ok} dead=${dead} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  const colas = Array.from({ length: CONC }, () => []);
  slugs.forEach((s, i) => colas[i % CONC].push(s));
  await Promise.all(colas.map(worker));
  out.end();
  console.log(`FASE1 FIN: ${slugs.length} → OK=${ok} DEAD/SIN-ENC=${dead}`);
}

async function resolverAf(slug) {
  const epUrl = BASE + 'ver/' + slug + '-1';
  const r = await get(epUrl, 12000, { Referer: BASE });
  if (!r.ok) return { ok: false, donde: 'ep-' + r.status };
  const enc = (/class="opt"[^>]*data-encrypt="([0-9a-f]+)"/i.exec(r.html) || [])[1];
  if (!enc) return { ok: false, donde: 'sin-enc' };
  let cuerpo = '';
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    const r2 = await fetch(BASE + 'flv', { method: 'POST', headers: { 'User-Agent': UA, Referer: epUrl, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: 'acc=opt&i=' + enc, signal: ctl.signal });
    clearTimeout(t);
    cuerpo = r2.ok ? await r2.text() : '';
  } catch { return { ok: false, donde: 'flv-timeout' }; }
  if (!cuerpo) return { ok: false, donde: 'flv-vacio' };
  const embeds = [...cuerpo.matchAll(/<li[^>]*encrypt="([0-9a-f]+)"/gi)]
    .map(m => { try { return Buffer.from(m[1], 'hex').toString('utf8'); } catch { return ''; } })
    .filter(u => /^https?:\/\//i.test(u));
  const hosts = [...new Set(embeds.map(u => { try { return new URL(u).hostname; } catch { return '?'; } }))];
  const mp4s = [...new Set(embeds.filter(u => /mp4upload\./i.test(u)))];
  if (!mp4s.length) return { ok: false, donde: 'sin-mp4upload', hosts };
  for (const emb of mp4s.slice(0, 2)) {
    const e2 = await get(emb, 12000, { Referer: epUrl });
    const mU = (e2.html || '').match(/["'](https?:\/\/[^"'\s<>]*mp4upload[^"'\s<>]*\.mp4[^"'\s<>]*)["']/i);
    if (!mU) continue;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const v = await fetch(mU[1], { headers: { 'User-Agent': UA, Referer: emb, Range: 'bytes=0-1024' }, signal: ctl.signal });
      clearTimeout(t);
      if (v.ok || v.status === 206) return { ok: true, hosts };
    } catch {}
  }
  return { ok: false, donde: 'mp4-muerto', hosts };
}

async function fase2() {
  const slugs = fs.readFileSync('public/animeflv-slugs.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const x = [...slugs];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; }
  for (const slug of x.slice(0, 12)) {
    await new Promise(r => setTimeout(r, 1500));
    const t = await resolverAf(slug);
    console.log(slug, t.ok ? 'MP4-OK' : 'MUERTO:' + t.donde, (t.hosts || []).join(','));
  }
}
(async () => {
  const c = process.argv[2] || 'todo';
  if (c === 'todo' || c === 'fase1') await fase1();
  if (c === 'todo' || c === 'fase2') await fase2();
})();
