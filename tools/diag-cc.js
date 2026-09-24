/* diag-cc.js — v310.1: diagnóstico paso a paso de un título de CineCalidad.
 * Replica el camino real de Huddle: página del episodio → botones play →
 * decodificación goodstream → m3u8 → variantes → primer segmento, mostrando
 * el HTTP de cada salto para ver EXACTAMENTE de dónde sale un 522.
 * Uso: node diag-cc.js [url-del-episodio]   (sin argumento busca Fundación 2x6) */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const fetchT = async (url, ref, ms = 20000, hdrs = {}) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { headers: { 'User-Agent': UA, ...(ref ? { Referer: ref } : {}), ...hdrs }, signal: c.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
};
function dec(enc) {
  try {
    const nums = Buffer.from(enc, 'base64').toString('binary').trim().split(/\s+/).map(x => parseInt(x, 10));
    if (nums.length < 8 || nums.some(x => !Number.isFinite(x))) return null;
    const crudo = nums.map(n => String.fromCharCode(n)).join('');
    const url = [...crudo].map(ch => String.fromCharCode(ch.charCodeAt(0) - 2)).join('');
    return /^https?:\/\/[a-z0-9.-]+\//i.test(url) ? url : null;
  } catch { return null; }
}
const etiqueta = (st) => st === 522 ? '  ← ¡EL 522 SALE DE AQUÍ! (el CDN no alcanza su origen)' : st === 403 ? '  (403: bloqueado/racionado)' : '';

(async () => {
  let epUrl = process.argv[2] || '';
  if (!epUrl) {
    console.log('== Buscando Fundación 2x6 en las páginas de serie…');
    for (const slug of ['fundacion', 'fundacion-2021', 'foundation', 'foundation-2021']) {
      try {
        const r = await fetchT('https://cine-calidad.mx/serie/' + slug + '/', 'https://cine-calidad.mx/');
        if (!r.ok) { console.log('  serie/' + slug + ' -> HTTP ' + r.status); continue; }
        const html = await r.text();
        const m = html.match(/href="(https:\/\/cine-calidad\.mx\/episode\/[^"]*-2x6\/?)"/i);
        if (m) { epUrl = m[1]; console.log('  encontrada: ' + epUrl + ' (slug ' + slug + ')'); break; }
        console.log('  serie/' + slug + ' cargó (' + html.length + ' bytes) pero no trae 2x6');
      } catch (e) { console.log('  serie/' + slug + ' falló: ' + e.message); }
    }
    if (!epUrl) { console.log('No encontré el episodio — pásame la URL completa: node diag-cc.js https://cine-calidad.mx/episode/…'); return; }
  }
  console.log('\n== Episodio: ' + epUrl);
  let html;
  try {
    const r = await fetchT(epUrl, 'https://cine-calidad.mx/');
    console.log('página del episodio -> HTTP ' + r.status + etiqueta(r.status));
    if (!r.ok) return;
    html = await r.text();
  } catch (e) { console.log('FALLO cargando la página: ' + e.message); return; }

  const tags = html.match(/<a\b[^>]*class="[^"]*\bplay\b[^"]*"[^>]*>/gi) || [];
  console.log('botones play encontrados: ' + tags.length);
  let embed = null, vimeos = null;
  for (const t of tags) {
    const dom = (t.match(/data-domain="([^"]*)"/i) || [])[1];
    const enc = (t.match(/data-src="([^"]*)"/i) || [])[1];
    if (!enc) continue;
    const u = dec(enc); if (!u) continue;
    console.log('  servidor ' + dom + ' -> ' + u.slice(0, 100));
    if (dom === 'goodstream' && !embed) embed = u;
    else if (dom === 'vimeos' && !vimeos) vimeos = u;
  }

  if (embed) {
    console.log('\n== goodstream: pidiendo el embed 3 veces en paralelo (cada una puede caer en nodo distinto)…');
    const uno = async (i) => {
      try {
        const r = await fetchT(embed, epUrl);
        const em = await r.text();
        const files = [...em.matchAll(/file\s*:\s*["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
        const m3u8 = files.find(f => /\.m3u8/i.test(f));
        if (!m3u8) { console.log('  intento #' + i + ' -> HTTP ' + r.status + ' cuerpo sin m3u8 (' + em.length + ' bytes)' + etiqueta(r.status)); return null; }
        console.log('  intento #' + i + ' -> m3u8: ' + m3u8.slice(0, 110));
        return m3u8;
      } catch (e) { console.log('  intento #' + i + ' falló: ' + e.message); return null; }
    };
    const m3u8s = [...new Set((await Promise.all([uno(1), uno(2), uno(3)])).filter(Boolean))];
    if (!m3u8s.length) console.log('  ningún embed trajo m3u8 — goodstream caído para este título');
    for (const m3u8 of m3u8s) {
      console.log('\n  probando m3u8…');
      try {
        const r = await fetchT(m3u8, embed, 10000);
        console.log('  master -> HTTP ' + r.status + etiqueta(r.status));
        if (!r.ok) continue;
        const body = await r.text();
        const abs = (u) => /^https?:/.test(u) ? u : new URL(u, m3u8).href;
        const vars = [...body.matchAll(/#EXT-X-STREAM-INF[^\n]*\n([^#\n]+)/g)].map(m => abs(m[1].trim()));
        const lista = vars.length ? vars : [body.split('\n').find(l => l && !l.startsWith('#'))].filter(Boolean).map(abs);
        for (const v of lista.slice(0, 2)) {
          let rv;
          try { rv = await fetchT(v, embed, 10000); } catch (e) { console.log('  variante ' + v.slice(0, 90) + ' -> ERR ' + e.message); continue; }
          console.log('  variante -> HTTP ' + rv.status + etiqueta(rv.status));
          if (rv.status !== 200 && rv.status !== 206) continue;
          const bv = await rv.text();
          const seg = bv.split('\n').find(l => l && !l.startsWith('#'));
          if (seg) {
            let rs;
            try { rs = await fetchT(abs(seg), embed, 10000, { Range: 'bytes=0-65536' }); } catch (e) { console.log('  primer segmento -> ERR ' + e.message); continue; }
            console.log('  primer segmento -> HTTP ' + rs.status + etiqueta(rs.status));
          }
        }
      } catch (e) { console.log('  m3u8 falló: ' + e.message); }
    }
  } else console.log('\n== sin servidor goodstream en la página');
  if (vimeos) console.log('\n== hay repuesto vimeos: ' + vimeos.slice(0, 100) + ' (Huddle lo intenta si goodstream falla)');
  console.log('\nlisto — pégame esta salida completa.');
})().catch(e => { console.error('error fatal:', e.message); });
