/* Auditoría Caricaturas FASE 2 — verifica que los players resuelven (muestra de 10 por fuente)
 * dani: ep page → data-post + admin-ajax nume=1..2 → ¿hay embed_url?
 * lct: cap page → ¿trae cubeembed.rpmvid u ok.ru embed?
 * cari: cap page → ¿trae anchor-data-container + AJAX get_system_data con iframe?
 */
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
  } catch (e) { return { ok: false, status: 0, html: '' }; } finally { clearTimeout(t); }
}
function pick(arr, n) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }

async function faseDani() {
  const oks = [];
  for (const l of fs.readFileSync('/tmp/cari-audit-dani.jsonl', 'utf8').split('\n').filter(Boolean)) {
    const d = JSON.parse(l); if (d.estado === 'OK') oks.push(d.slug);
  }
  console.log('--- DANI (10 muestra) ---');
  for (const slug of pick(oks, 10)) {
    await sleep(1500);
    const s = await get('https://danimados.cc/series/' + slug + '/');
    const m = /href='(https:\/\/danimados\.cc\/episodios\/[^']+)'/.exec(s.html || '');
    if (!m) { console.log(slug, 'SIN-EPS'); continue; }
    await sleep(1000);
    const e = await get(m[1]);
    const post = (/data-post=['"](\d+)/.exec(e.html || '') || [])[1];
    if (!post) { console.log(slug, 'SIN-POST'); continue; }
    let embed = '';
    for (const nume of [1, 2]) {
      try {
        const r2 = await fetch('https://danimados.cc/wp-admin/admin-ajax.php', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: m[1], Origin: 'https://danimados.cc' },
          body: 'action=doo_player_ajax&post=' + post + '&nume=' + nume + '&type=tv', signal: AbortSignal.timeout(12000) });
        const j2 = await r2.json().catch(() => null);
        if (j2 && j2.embed_url) { embed = String(j2.embed_url).slice(0, 90); break; }
      } catch {}
      await sleep(800);
    }
    console.log(slug, embed ? 'PLAYER-OK nume→' + embed : 'SIN-EMBED');
  }
}

async function faseLct() {
  const oks = [];
  for (const l of fs.readFileSync('/tmp/cari-audit-lct.jsonl', 'utf8').split('\n').filter(Boolean)) {
    const d = JSON.parse(l); if (d.estado === 'OK') oks.push(d);
  }
  console.log('--- LCT (10 muestra) ---');
  for (const { id, slug } of pick(oks, 10)) {
    await sleep(2000);
    const s = await get('https://www.lacartoons.com/serie/' + id);
    const m = /href="\/serie\/capitulo\/(\d+)\?t=(\d+)"/i.exec(s.html || '');
    if (!m) { console.log(slug, 'SIN-EPS'); continue; }
    await sleep(1500);
    const c = await get('https://www.lacartoons.com/serie/capitulo/' + m[1] + '?t=' + m[2]);
    const h = c.html || '';
    const rpm = /cubeembed\.rpmvid\.com\/#[a-z0-9]+/i.test(h);
    const okru = /ok\.ru\/videoembed\/\d+/i.test(h);
    console.log(slug, (rpm || okru) ? 'PLAYER-OK ' + (rpm ? 'rpmvid' : 'ok.ru') : 'SIN-PLAYER');
  }
}

async function faseCari() {
  console.log('--- CARI (10 muestra de CARI_ORDEN) ---');
  const srv = fs.readFileSync('server.js', 'utf8');
  const m2 = /const CARI_ORDEN = \[(.*?)\];/s.exec(srv);
  const orden = [...m2[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  for (const slug of pick(orden, 10)) {
    await sleep(1200);
    const s = await get('https://miscaricaturas.com/' + slug + '/');
    let eps = [...(s.html || '').matchAll(/<a href="(https:\/\/miscaricaturas\.com\/([a-z0-9-]+?)-(\d{2})x(\d{2})([ab])?(?:-[a-z0-9-]*)?\/?)"[^>]*>\s*([^<]+?)\s*<\/a>/gi)].map(m => m[1]);
    if (!eps.length) { /* serie por temporadas: seguir primer post */
      const base = slug.replace(/-(capitulos-completos[a-z]*|capitulos-y-canciones|completos|ver|latino|online)$/, '');
      const t = new RegExp('miscaricaturas\\.com/(' + base + '-temporada-\\d+)/?', 'i').exec(s.html || '');
      if (t) { await sleep(1000); const rt = await get('https://miscaricaturas.com/' + t[1] + '/');
        eps = [...(rt.html || '').matchAll(/<a href="(https:\/\/miscaricaturas\.com\/([a-z0-9-]+?)-(\d{2})x(\d{2})([ab])?(?:-[a-z0-9-]*)?\/?)"[^>]*>\s*([^<]+?)\s*<\/a>/gi)].map(m => m[1]); }
    }
    if (!eps.length) { console.log(slug, 'SIN-EPS'); continue; }
    await sleep(1000);
    const c = await get(eps[0]);
    const idm = /anchor-data-container" data-id="(\d+)"/i.exec(c.html || '');
    if (!idm) { console.log(slug, 'SIN-DATAID'); continue; }
    /* AJAX get_system_data */
    try {
      const r2 = await fetch('https://miscaricaturas.com/wp-admin/admin-ajax.php', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: eps[0] },
        body: 'action=get_system_data&id=' + idm[1], signal: AbortSignal.timeout(12000) });
      const t2 = await r2.text();
      console.log(slug, /iframe/i.test(t2) ? 'PLAYER-OK' : 'AJAX-SIN-IFRAME');
    } catch { console.log(slug, 'AJAX-ERR'); }
  }
}
(async () => { await faseDani(); await faseLct(); await faseCari(); })();
