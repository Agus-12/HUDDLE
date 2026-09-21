/* Auditoría Caricaturas (Danimados + Lacartoons + MisCaricaturas) — sept 2026
 * Fase 1: por cada serie, descargar su página y contar episodios (mismo parse que server.js)
 * Uso: node auditoria-caricaturas.js [dani|lct|cari|todo]
 * Salida: /tmp/cari-audit-<fuente>.jsonl + resumen en consola
 */
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CONC = 8;

async function get(url, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    const html = r.ok ? await r.text() : '';
    return { ok: r.ok, status: r.status, html };
  } catch (e) { return { ok: false, status: 0, html: '', err: String(e).slice(0, 60) }; }
  finally { clearTimeout(t); }
}

/* ── DANIMADOS: mismo parse que daniLista() ── */
function daniEps(html) {
  const partes = html.split("<div class='se-c'>");
  let n = 0;
  for (const p of partes.slice(1))
    for (const it of p.split('<li').slice(1)) {
      const u = /href='(https:\/\/danimados\.cc\/episodios\/[^']+)'/.exec(it);
      if (u) n++;
    }
  return { temps: partes.length - 1, eps: n };
}

/* ── LACARTOONS: mismo parse que lctEpsDeHtml() ── */
function lctEps(html) {
  const v = new Set();
  for (const m of html.matchAll(/href="\/serie\/capitulo\/(\d+)\?t=(\d+)"/gi)) v.add(m[1]);
  return v.size;
}

/* ── MISCARICATURAS: mismo parse que cariEpsDeHtml() ── */
function cariEps(html) {
  const v = new Set();
  for (const m of html.matchAll(/<a href="(https:\/\/miscaricaturas\.com\/([a-z0-9-]+?)-(\d{2})x(\d{2})([ab])?(?:-[a-z0-9-]*)?\/?)"[^>]*>\s*([^<]+?)\s*<\/a>/gi)) v.add(m[1]);
  return v.size;
}

async function auditar(nombre, items, fn) {
  const out = fs.createWriteStream(`/tmp/cari-audit-${nombre}.jsonl`);
  let ok = 0, empty = 0, dead = 0, done = 0;
  const t0 = Date.now();
  async function worker(q) {
    for (const it of q) {
      const r = await fn(it);
      r.fuente = nombre;
      out.write(JSON.stringify(r) + '\n');
      if (r.estado === 'OK') ok++; else if (r.estado === 'VACIA') empty++; else dead++;
      done++;
      if (done % 50 === 0) console.log(`[${nombre}] ${done}/${items.length} ok=${ok} vacias=${empty} muertas=${dead} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  const colas = Array.from({ length: CONC }, () => []);
  items.forEach((it, i) => colas[i % CONC].push(it));
  await Promise.all(colas.map(worker));
  out.end();
  console.log(`[${nombre}] FIN: ${items.length} total → OK=${ok} VACIAS=${empty} MUERTAS=${dead} en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { total: items.length, ok, empty, dead };
}

async function main() {
  const cual = process.argv[2] || 'todo';
  const srv = fs.readFileSync('server.js', 'utf8');

  if (cual === 'todo' || cual === 'dani') {
    const cat = JSON.parse(fs.readFileSync('public/dani-catalogo.json', 'utf8'));
    const slugs = Object.keys(cat);
    console.log(`Danimados: ${slugs.length} series`);
    await auditar('dani', slugs, async (slug) => {
      const r = await get('https://danimados.cc/series/' + slug + '/');
      if (!r.ok) return { slug, estado: 'MUERTA', status: r.status, err: r.err || '' };
      const { temps, eps } = daniEps(r.html);
      return { slug, estado: eps > 0 ? 'OK' : 'VACIA', status: r.status, temps, eps };
    });
  }

  if (cual === 'todo' || cual === 'lct') {
    const m = /const LCT_SERIES = new Map\(\[(.*?)\]\);/s.exec(srv);
    const ids = [...m[1].matchAll(/\['(\d+)', \{ slug: '([^']+)'/g)].map(x => ({ id: x[1], slug: x[2] }));
    console.log(`Lacartoons: ${ids.length} series`);
    await auditar('lct', ids, async ({ id, slug }) => {
      const r = await get('https://www.lacartoons.com/serie/' + id);
      if (!r.ok) return { slug, id, estado: 'MUERTA', status: r.status, err: r.err || '' };
      const eps = lctEps(r.html);
      return { slug, id, estado: eps > 0 ? 'OK' : 'VACIA', status: r.status, eps };
    });
  }

  if (cual === 'todo' || cual === 'cari') {
    const m2 = /const CARI_ORDEN = \[(.*?)\];/s.exec(srv);
    const orden = [...m2[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    /* + series de la home */
    const home = await get('https://miscaricaturas.com/');
    const homeSlugs = new Set();
    if (home.ok) for (const m of home.html.matchAll(/<h2 class="entry-title[^"]*"><a href="https:\/\/miscaricaturas\.com\/([a-z0-9-]+)\/?"/gi)) {
      const s = m[1].toLowerCase();
      if (!/temporada/i.test(s) && !/\d{2}x\d{2}/i.test(s)) homeSlugs.add(s);
    }
    const slugs = [...new Set([...orden, ...homeSlugs])];
    console.log(`MisCaricaturas: ${slugs.length} series (${orden.length} curadas + ${homeSlugs.size} home)`);
    await auditar('cari', slugs, async (slug) => {
      const r = await get('https://miscaricaturas.com/' + slug + '/');
      if (!r.ok) return { slug, estado: 'MUERTA', status: r.status, err: r.err || '' };
      const eps = cariEps(r.html);
      return { slug, estado: eps > 0 ? 'OK' : 'VACIA', status: r.status, eps };
    });
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
