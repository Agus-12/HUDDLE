/* Auditoría Novelas — sept 2026
 * Fase 1a: novelas360 catalogo (series/ 2 pgs) → ficha trae capítulos?
 * Fase 1b: enpantallatv recientes (home) → búsqueda trae capítulos del pref?
 * Fase 2: 8+8 capítulos → cadena de extracción completa → media vivo?
 * Uso: node auditoria-novelas.js [fase1|fase2|todo]
 */
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NV = 'https://novelas360.com/';
const EP = 'https://enpantallatv.com/';
const CONC = 6;
async function get(url, ms = 15000, extra = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, ...extra } });
    return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
  } catch (e) { return { ok: false, status: 0, html: '' }; } finally { clearTimeout(t); }
}

async function catNv360() {
  const items = [], vistos = new Set();
  for (const ruta of ['series/', 'series/page/2/']) {
    const r = await get(NV + ruta, 18000);
    if (!r.ok) continue;
    for (const m of r.html.matchAll(/<a href="(https:\/\/novelas360\.com\/categories\/([a-z0-9-]+)\/)" title="([^"]+)">[\s\S]{0,600}?data-src="([^"]+)"[\s\S]{0,1600}?<\/a>/gi)) {
      if (vistos.has(m[2])) continue;
      vistos.add(m[2]);
      items.push({ slug: m[2], titulo: m[3].slice(0, 80) });
    }
  }
  return items;
}
async function catEnp() {
  const serie = new Map();
  const r = await get(EP, 18000);
  if (!r.ok) return [];
  for (const m of r.html.matchAll(/<a href="(https:\/\/enpantallatv\.com\/([a-z0-9-]{6,90})\/?)"[^>]*>\s*<img[^>]*src="([^"]+)"/gi)) {
    let slug = m[2].replace(/\/+$/, '');
    if (/-online-gratis|capitulos-completos|novelas-(chilenas|colombianas|peruanas|espanolas|americanas|mexicanas|turcas)|estrenos-novelas|telenovela-20\d\d|^year-|^(feed|series|accion|aventura|comedia|crimen|drama|romance|terror|suspenso)$/.test(slug)) continue;
    const pm = /-temporada-(\d+)-capitulo-|-(\d{1,2})-capitulo-|-capitulo-/.exec(slug);
    if (pm) slug = slug.slice(0, pm.index);
    if (serie.has(slug)) continue;
    serie.set(slug, { pref: slug });
  }
  return [...serie.values()];
}

async function fase1() {
  const nv = await catNv360();
  const enp = await catEnp();
  console.log(`Catalogos: novelas360=${nv.length} enpantalla=${enp.length}`);
  fs.writeFileSync('/tmp/nv360.json', JSON.stringify(nv));
  fs.writeFileSync('/tmp/enp.json', JSON.stringify(enp));
  const out = fs.createWriteStream('/tmp/nv-audit-fase1.jsonl');
  let ok = 0, dead = 0, done = 0;
  const t0 = Date.now();
  async function worker(q) {
    for (const it of q) {
      let row;
      if (it.site === 'nv360') {
        const r = await get(NV + 'categories/' + it.k + '/');
        if (!r.ok) row = { key: 'nv:' + it.k, estado: 'MUERTA', status: r.status };
        else {
          const n = new Set([...r.html.matchAll(/\/video\/[a-z0-9-]+?-capitulo-(\d+)/gi)].map(m => +m[1])).size;
          row = { key: 'nv:' + it.k, estado: n ? 'OK' : 'SIN-CAPS', caps: n };
        }
      } else {
        const r = await get(EP + '?s=' + encodeURIComponent(it.k.replace(/-/g, ' ')), 18000);
        if (!r.ok) row = { key: 'enp:' + it.k, estado: 'MUERTA', status: r.status };
        else {
          const cards = [...r.html.matchAll(/<a href="(https:\/\/enpantallatv\.com\/([a-z0-9-]+?)\/?)"[^>]*>\s*<img/gi)].map(m => m[2]);
          const mios = cards.filter(s => { const i = s.indexOf('-capitulo-'); return i > 0 && (s.slice(0, i).replace(/-temporada-\d+|-\d{1,2}$/, '') === it.k || s.slice(0, i) === it.k); });
          row = { key: 'enp:' + it.k, estado: mios.length ? 'OK' : 'SIN-CAPS', caps: mios.length };
        }
      }
      out.write(JSON.stringify(row) + '\n');
      row.estado === 'OK' ? ok++ : dead++;
      done++;
      if (done % 30 === 0) console.log(`fase1 ${done} ok=${ok} dead=${dead} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  const items = [...nv.map(x => ({ site: 'nv360', k: x.slug })), ...enp.map(x => ({ site: 'enp', k: x.pref }))];
  console.log(`Total fichas: ${items.length}`);
  const colas = Array.from({ length: CONC }, () => []);
  items.forEach((it, i) => colas[i % CONC].push(it));
  await Promise.all(colas.map(worker));
  out.end();
  console.log(`FASE1 FIN: ${items.length} → OK=${ok} DEAD/SIN-CAPS=${dead}`);
}

function cogerMedia(txt, base) {
  const m3 = (/(?:file|source|src)\s*[:=]\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i.exec(txt) || /['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i.exec(txt) || [])[1];
  if (m3) return { url: m3 };
  const mp4 = (/(?:file|source|src)\s*[:=]\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i.exec(txt) || /['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i.exec(txt) || [])[1];
  if (mp4) return { url: mp4 };
  const pk = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]{0,900}?\}\(('([\s\S]*?)',(\d+),(\d+),\s*'([\s\S]*?)'\.split\('\|'\))/i.exec(txt);
  if (pk) {
    try {
      const des = pk[2].replace(/\b\d+\b/g, m2 => pk[5].split('|')[+m2] || m2);
      const m3d = /['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i.exec(des);
      if (m3d) return { url: m3d[1] };
    } catch {}
  }
  const meta = /http-equiv=["']?refresh["']?[^>]+url=([^"'>]+)/i.exec(txt);
  if (meta) return { ir: new URL(meta[1], base).href };
  const fr = /<iframe[^>]*src=["']([^"']+)["']/i.exec(txt);
  if (fr) return { ir: new URL(fr[1], base).href };
  return null;
}
async function resolverNv360(pageUrl) {
  const r = await get(pageUrl, 18000);
  if (!r.ok) return { ok: false, donde: 'cap-' + r.status };
  const iframes = [...new Set([...r.html.matchAll(/<iframe[^>]*src="([^"]+)"/gi)].map(m => m[1]))]
    .map(u => (u.startsWith('//') ? 'https:' + u : u))
    .filter(u => /^https?:\/\//.test(u) && !/facebook|youtube|youtu\.be|wp-content|dailymotion/i.test(u));
  if (!iframes.length) return { ok: false, donde: /loadermain|netu\.tv/i.test(r.html) ? 'protegido-netu' : 'sin-iframe' };
  const hosts = [...new Set(iframes.map(u => { try { return new URL(u).hostname; } catch { return '?'; } }))];
  const cand = [...iframes.filter(u => /novelas360\.cyou/i.test(u)), ...iframes.filter(u => !/novelas360\.cyou/i.test(u))];
  for (const c of cand.slice(0, 3)) {
    let actual = c, ref = pageUrl;
    for (let s = 0; s < 3; s++) {
      const rp = await get(actual, 15000, { Referer: ref });
      if (!rp.ok || !rp.html) break;
      const h = cogerMedia(rp.html, actual);
      if (!h) break;
      if (h.url) {
        try {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
          const v = await fetch(h.url, { headers: { 'User-Agent': UA, Referer: actual, Range: 'bytes=0-512' }, signal: ctl.signal });
          clearTimeout(t);
          const tx = await v.text().catch(() => '');
          if ((v.ok || v.status === 206) && (/\.m3u8/i.test(h.url) ? tx.includes('#EXT') : true)) return { ok: true, hosts, tipo: /\.m3u8/i.test(h.url) ? 'm3u8' : 'mp4' };
        } catch {}
        break;
      }
      if (h.ir && h.ir !== actual) { ref = actual; actual = h.ir; continue; }
      break;
    }
  }
  return { ok: false, donde: 'sin-media', hosts };
}
async function resolverEnpCheck(pageUrl) {
  const r = await get(pageUrl, 18000);
  if (!r.ok) return { ok: false, donde: 'cap-' + r.status };
  const cands = [];
  for (const m of r.html.matchAll(/<IFRAME[^>]*SRC="([^"]+)"/gi)) cands.push(m[1]);
  const fr = /frames\s*=\s*\[([\s\S]*?)\];/.exec(r.html);
  if (fr) for (const m of fr[1].matchAll(/(?:SRC|src)=\\?"([^"\\]+)/gi)) cands.push(m[1].replace(/\\\//g, '/'));
  const emb = [...new Set(cands.map(u => u.startsWith('//') ? 'https:' + u : u).filter(u => /^https:\/\//.test(u) && !/facebook|youtube|youtu\.be|dailymotion|wp-content/i.test(u)))];
  const hosts = [...new Set(emb.map(u => { try { return new URL(u).hostname; } catch { return '?'; } }))];
  if (!emb.length) return { ok: false, donde: 'sin-iframe' };
  const okru = emb.find(u => /ok\.ru\/videoembed\/(\d+)/i.test(u));
  const gs = emb.find(u => /goodstream\.one/i.test(u));
  if (!okru && !gs) return { ok: false, donde: 'sin-gs-ok', hosts };
  if (okru) {
    const e2 = await get(okru, 12000, { Referer: pageUrl });
    if (e2.ok && /mp4|m3u8/i.test(e2.html)) return { ok: true, hosts, via: 'ok.ru' };
  }
  if (gs) {
    const e2 = await get(gs, 12000, { Referer: pageUrl });
    if (e2.ok) return { ok: true, hosts, via: 'goodstream?' };
  }
  return { ok: false, donde: 'emb-muerto', hosts };
}

async function fase2() {
  const nv = JSON.parse(fs.readFileSync('/tmp/nv360.json', 'utf8'));
  const enp = JSON.parse(fs.readFileSync('/tmp/enp.json', 'utf8'));
  const pick = (a, n) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; } return x.slice(0, n); };
  console.log('--- NOVELAS360 (8) ---');
  for (const s of pick(nv, 8)) {
    await new Promise(r => setTimeout(r, 1200));
    const f = await get(NV + 'categories/' + s.slug + '/');
    const m = /href="(https:\/\/novelas360\.com\/video\/[a-z0-9-]+?-capitulo-\d+(?:-\d+)?\/)"/i.exec(f.html || '');
    if (!m) { console.log(s.slug, 'SIN-CAPS'); continue; }
    const t = await resolverNv360(m[1]);
    console.log(s.slug, t.ok ? 'MEDIA-OK:' + t.tipo : 'MUERTO:' + t.donde, (t.hosts || []).join(','));
  }
  console.log('--- ENPANTALLA (8) ---');
  for (const s of pick(enp, 8)) {
    await new Promise(r => setTimeout(r, 1200));
    const f = await get(EP + '?s=' + encodeURIComponent(s.pref.replace(/-/g, ' ')), 18000);
    const cards = [...(f.html || '').matchAll(/<a href="(https:\/\/enpantallatv\.com\/([a-z0-9-]+?)\/?)"[^>]*>\s*<img/gi)].map(m => m[2]);
    const cap = cards.find(x => x.includes('-capitulo-') && x.startsWith(s.pref));
    if (!cap) { console.log(s.pref, 'SIN-CAPS'); continue; }
    const t = await resolverEnpCheck(EP + cap + '/');
    console.log(s.pref, t.ok ? 'EMBED-OK:' + t.via : 'MUERTO:' + t.donde, (t.hosts || []).join(','));
  }
}
(async () => {
  const c = process.argv[2] || 'todo';
  if (c === 'todo' || c === 'fase1') await fase1();
  if (c === 'todo' || c === 'fase2') await fase2();
})();
