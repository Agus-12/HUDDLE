/* Auditoría GoPelis — sept 2026
 * Fase 1: catalogo series (3 pgs) + pelis (16 pgs) → ficha trae /ver/tv|movie?
 * Fase 2: muestra 10+10 → cadena completa stream-player → servers → resolve → m3u8 vivo?
 * Uso: node auditoria-gopelis.js [fase1|fase2|todo]
 */
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://gopelis.com/';
const CONC = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
  } catch (e) { return { ok: false, status: 0, html: '', err: String(e).slice(0, 50) }; } finally { clearTimeout(t); }
}

async function catalogoSeries() {
  const items = [];
  for (let p = 1; p <= 3; p++) {
    const r = await get(BASE + 'series?page=' + p);
    if (!r.ok) continue;
    for (const m of r.html.matchAll(/href="\/series\/([a-z0-9-]+)"/g)) {
      if (!items.some(x => x.slug === m[1])) {
        const t = /<h3[^>]*>([^<]+)<\/h3>/.exec(r.html.slice(m.index, m.index + 6500));
        items.push({ slug: m[1], titulo: t ? t[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '' });
      }
    }
  }
  return items;
}
async function catalogoPelis() {
  const items = [];
  for (let p = 1; p <= 16; p++) {
    const r = await get(BASE + 'peliculas?page=' + p);
    if (!r.ok) continue;
    let nuevos = 0;
    for (const m of r.html.matchAll(/href="\/peliculas\/([a-z0-9-]+)"/g)) {
      if (items.some(x => x.slug === m[1])) continue;
      nuevos++;
      const t = /<h3[^>]*>([^<]+)<\/h3>/.exec(r.html.slice(m.index, m.index + 6500));
      if (t) items.push({ slug: m[1], titulo: t[1].replace(/\s+/g, ' ').trim().slice(0, 80) });
    }
    if (!nuevos) break;
  }
  return items;
}

async function fase1() {
  const series = await catalogoSeries();
  const pelis = await catalogoPelis();
  console.log(`Catalogo: ${series.length} series, ${pelis.length} pelis`);
  fs.writeFileSync('/tmp/gp-series.json', JSON.stringify(series));
  fs.writeFileSync('/tmp/gp-pelis.json', JSON.stringify(pelis));
  const out = fs.createWriteStream('/tmp/gp-audit-fase1.jsonl');
  const items = [...series.map(s => ({ ...s, tipo: 'serie' })), ...pelis.map(s => ({ ...s, tipo: 'peli' }))];
  let ok = 0, dead = 0, done = 0;
  const t0 = Date.now();
  async function worker(q) {
    for (const it of q) {
      const url = BASE + (it.tipo === 'serie' ? 'series/' : 'peliculas/') + it.slug;
      const r = await get(url);
      let row;
      if (!r.ok) row = { key: (it.tipo === 'peli' ? 'p:' : '') + it.slug, tipo: it.tipo, estado: 'MUERTA', status: r.status };
      else {
        const has = it.tipo === 'serie' ? /\/ver\/tv\/(\d+)\?season=(\d+)/.test(r.html) : /href="(\/ver\/movie\/\d+)"/.test(r.html);
        const m = it.tipo === 'serie' ? /\/ver\/tv\/(\d+)/.exec(r.html) : /\/ver\/movie\/(\d+)/.exec(r.html);
        row = { key: (it.tipo === 'peli' ? 'p:' : '') + it.slug, tipo: it.tipo, estado: has ? 'OK' : 'SIN-VER', status: r.status, id: m ? m[1] : '' };
      }
      out.write(JSON.stringify(row) + '\n');
      row.estado === 'OK' ? ok++ : dead++;
      done++;
      if (done % 50 === 0) console.log(`fase1 ${done}/${items.length} ok=${ok} dead=${dead} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  const colas = Array.from({ length: CONC }, () => []);
  items.forEach((it, i) => colas[i % CONC].push(it));
  await Promise.all(colas.map(worker));
  out.end();
  console.log(`FASE1 FIN: ${items.length} → OK=${ok} DEAD/SIN-VER=${dead}`);
}

async function resolver(urlVer, esTv) {
  /* replica resolverGopelis sin el confirm local: player → servers → resolve → #EXTM3U */
  const m = /gopelis\.com\/ver\/(?:tv|movie)\/(\d+)(?:\?season=(\d+)&ep=(\d+))?/i.exec(urlVer || '');
  if (!m) return { ok: false, donde: 'url' };
  const [, id, S, E] = m;
  const purl = BASE + 'api/stream-player?source=peliapi-player&type=' + (esTv ? `tv&id=${id}&season=${S}&episode=${E}` : `movie&id=${id}`);
  const r = await get(purl, 20000);
  if (!r.ok) return { ok: false, donde: 'player-' + r.status };
  const apiUrl = (/(?:const\s+)?API_URL\s*=\s*"([^"]+)"/.exec(r.html) || [])[1];
  const pt = (/(?:const\s+)?PAGE_TOKEN\s*=\s*"([^"]+)"/.exec(r.html) || [])[1];
  const resUrl = (/(?:const\s+)?RESOLVE_URL\s*=\s*"([^"]+)"/.exec(r.html) || [])[1] || 'https://nsrplay.space/api/v1/embed/resolve';
  if (!apiUrl || !pt) return { ok: false, donde: 'sin-token' };
  const r2 = await get(apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'pt=' + encodeURIComponent(pt), 20000);
  if (!r2.ok) return { ok: false, donde: 'sources-' + r2.status };
  let d = null; try { d = JSON.parse(r2.html); } catch {}
  const svs = (d && d.servers || []).filter(x => x && x.token).slice(0, 8);
  if (!svs.length) return { ok: false, donde: 'sin-servers' };
  const hosts = new Set();
  for (const sv of svs) {
    for (let k = 0; k < 2; k++) {
      const ru = resUrl + '?token=' + encodeURIComponent(sv.token) + '&parentUrl=' + encodeURIComponent(purl) + '&pt=' + encodeURIComponent(pt);
      const rr = await get(ru, 15000);
      let du = '';
      try { const jj = rr.ok ? JSON.parse(rr.html) : null; du = jj && jj.data && jj.data.directUrl || ''; } catch {}
      if (!du) continue;
      try { hosts.add(new URL(du).host); } catch {}
      const vd = await get(du, 10000);
      if (vd.ok && vd.html.includes('#EXTM3U')) return { ok: true, hosts: [...hosts] };
      await sleep(2500);
    }
  }
  return { ok: false, donde: 'sin-m3u8-vivo', hosts: [...hosts] };
}

async function fase2() {
  const series = JSON.parse(fs.readFileSync('/tmp/gp-series.json', 'utf8'));
  const pelis = JSON.parse(fs.readFileSync('/tmp/gp-pelis.json', 'utf8'));
  const pick = (a, n) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; } return x.slice(0, n); };
  console.log('--- SERIES (10) ---');
  for (const s of pick(series, 10)) {
    await sleep(1200);
    const f = await get(BASE + 'series/' + s.slug);
    const m = /\/ver\/tv\/(\d+)\?season=(\d+)/.exec(f.html || '');
    if (!m) { console.log(s.slug, 'SIN-VER'); continue; }
    await sleep(800);
    const t = await get(`${BASE}ver/tv/${m[1]}?season=${m[2]}`);
    const nes = [...new Set([...(t.html || '').matchAll(/Episodio\s*(\d+)/g)].map(x => +x[1]))].sort((a, b) => a - b);
    if (!nes.length) { console.log(s.slug, 'SIN-EPS'); continue; }
    const r = await resolver(`${BASE}ver/tv/${m[1]}?season=${m[2]}&ep=${nes[0]}`, true);
    console.log(s.slug, r.ok ? 'M3U8-OK' : 'MUERTO:' + r.donde, (r.hosts || []).join(','));
  }
  console.log('--- PELIS (10) ---');
  for (const s of pick(pelis, 10)) {
    await sleep(1200);
    const f = await get(BASE + 'peliculas/' + s.slug);
    const m = /href="(\/ver\/movie\/\d+)"/.exec(f.html || '');
    if (!m) { console.log(s.slug, 'SIN-VER'); continue; }
    const r = await resolver(BASE + m[1].replace(/^\//, ''), false);
    console.log(s.slug, r.ok ? 'M3U8-OK' : 'MUERTO:' + r.donde, (r.hosts || []).join(','));
  }
}
(async () => {
  const c = process.argv[2] || 'todo';
  if (c === 'todo' || c === 'fase1') await fase1();
  if (c === 'todo' || c === 'fase2') await fase2();
})();
