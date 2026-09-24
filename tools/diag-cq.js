/* diag-cq.js — v312: diagnóstico de cinecalidad.am paso a paso DESDE ESTE SERVIDOR.
 * Prueba cada salto con la IP de esta máquina y marca con ← el que muera:
 * API tmdb → code → embed vimeos → m3u8 → master → segmento.
 * Uso: node diag-cq.js   (o node diag-cq.js <code> para probar un título concreto) */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
function desempacar(html) {
  try {
    const i = html.indexOf('eval(function(p,a,c,k,e,d)');
    if (i < 0) return null;
    const j = html.indexOf('</script>', i);
    let s = html.slice(i + 5, j).trim();
    if (s.endsWith(')')) s = s.slice(0, -1);
    return new Function('return ' + s)();
  } catch { return null; }
}
const f = async (u, ref, ms = 15000, hdrs = {}) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { headers: { 'User-Agent': UA, ...(ref ? { Referer: ref } : {}), ...hdrs }, signal: c.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
};
const marca = (st) => st === 403 ? '  ← 403: la CDN BLOQUEA esta IP' : st === 522 ? '  ← 522: caído' : st >= 400 ? '  ← falla aquí' : '';
async function probarCode(code, etiqueta) {
  console.log('\n== ' + etiqueta + ' (code ' + code + ')');
  const embed = 'https://vimeos.net/embed-' + code + '.html';
  let em, st = 0;
  try { const r = await f(embed, 'https://www.cinecalidad.am/'); st = r.status; em = await r.text(); }
  catch (e) { console.log('  embed -> ERROR ' + e.message + '  ← no alcanza vimeos.net desde aquí'); return; }
  console.log('  embed -> HTTP ' + st + ' (' + em.length + ' bytes)' + marca(st));
  const out = st === 200 ? desempacar(em) : null;
  if (!out) { console.log('  jugador ofuscado -> NO está (el embed no trae video para este título o cambió)'); return; }
  const m3 = (out.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i) || [])[0];
  if (!m3) { console.log('  jugador desempacado (' + out.length + ' chars) pero SIN m3u8 — el embed no sirvió el video'); return; }
  console.log('  m3u8 -> OK: ' + m3.slice(0, 95) + '…');
  let rm;
  try { rm = await f(m3, 'https://vimeos.net/'); } catch (e) { console.log('  master -> ERROR ' + e.message); return; }
  console.log('  master -> HTTP ' + rm.status + marca(rm.status));
  if (!rm.ok) return;
  const body = await rm.text();
  const variante = (body.match(/\n(https?:\/\/[^\n]+\.m3u8[^\n]*)/) || body.match(/^(https?:\/\/[^\n]+\.m3u8[^\n]*)/m) || [])[1];
  if (!variante) { console.log('  master sin variantes (playlist media directa) — con master OK basta'); return; }
  let rv;
  try { rv = await f(variante.trim(), 'https://vimeos.net/'); } catch (e) { console.log('  variante -> ERROR ' + e.message); return; }
  console.log('  variante -> HTTP ' + rv.status + marca(rv.status));
  if (!rv.ok) return;
  const bv = await rv.text();
  const seg = (bv.split('\n').find((l) => l && !l.startsWith('#')) || '');
  if (!seg) { console.log('  variante sin segmentos'); return; }
  const segUrl = /^https?:/.test(seg) ? seg : new URL(seg, variante.trim()).href;
  try {
    const rs = await f(segUrl, 'https://vimeos.net/', 15000, { Range: 'bytes=0-65536' });
    console.log('  primer segmento -> HTTP ' + rs.status + marca(rs.status));
  } catch (e) { console.log('  primer segmento -> ERROR ' + e.message); }
}
(async () => {
  console.log('== API tmdb.cinecalidad.am');
  try {
    const h = await f('https://tmdb.cinecalidad.am/health/ready');
    console.log('  health -> HTTP ' + h.status + marca(h.status));
  } catch (e) { console.log('  health -> ERROR ' + e.message + '  ← el servidor NO alcanza la API'); return; }
  if (process.argv[2]) { await probarCode(process.argv[2], 'code pedido'); return; }
  try {
    const r = await f('https://tmdb.cinecalidad.am/v1/items/tvshow/93740/seasons/2/episodes/6');
    const d = await r.json();
    const code = d && d.episode && d.episode.code;
    console.log('  Fundación T2E6 -> ' + (code ? 'code ' + code : 'SIN code' + marca(r.status)));
    if (code) await probarCode(code, 'Fundación T2E6');
  } catch (e) { console.log('  Fundación T2E6 -> ERROR ' + e.message); }
  try {
    const r = await f('https://tmdb.cinecalidad.am/v1/items/movie/1368337');
    const d = await r.json();
    const code = d && d.item && d.item.code;
    console.log('\n== La Odisea (película) -> ' + (code ? 'code ' + code : 'SIN code'));
    if (code) await probarCode(code, 'La Odisea');
  } catch (e) { console.log('  La Odisea -> ERROR ' + e.message); }
  console.log('\nlisto — pégame la salida completa.');
})().catch((e) => console.error('error fatal:', e.message));
