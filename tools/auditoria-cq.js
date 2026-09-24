/* auditoria-cq.js — v313: auditoría COMPLETA de cinecalidad.am
 * Fase A: catálogo completo (las 3 listas, ya traen code/playable/available_episodes)
 * Fase B: conteo de vivos/muertos por kind a nivel lista
 * Fase C: verificación real por muestreo — embed vimeos + m3u8 verificado
 *         (3 intentos de embed, como v313, para no culpar al título por un nodo muerto)
 * Fase D: confirmación de muertos por detalle (playable=false en ficha)
 * Uso: node auditoria-cq.js [muestra-pelis] [muestra-series]   (default 60/30) */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const fs = require('fs');
const f = async (u, ref, ms = 12000, hdrs = {}) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { headers: { 'User-Agent': UA, ...(ref ? { Referer: ref } : {}), ...hdrs }, signal: c.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
};
const json = async (u) => { const r = await f(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
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
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
/* ¿Este code de vimeos entrega video de verdad? — 3 intentos de embed */
async function codeSirve(code) {
  if (!code) return false;
  for (let i = 0; i < 3; i++) {
    if (i) await espera(500 * i);
    try {
      const r = await f('https://vimeos.net/embed-' + code + '.html', 'https://www.cinecalidad.am/');
      if (!r.ok) continue;
      const em = await r.text();
      const out = desempacar(em);
      const m3 = out && (out.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i) || [])[0];
      if (!m3) continue;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
      let ok = false;
      try { const rm = await fetch(m3, { headers: { 'User-Agent': UA, Referer: 'https://vimeos.net/' }, signal: ctl.signal }); ok = rm.ok; try { if (rm.body) await rm.body.cancel(); } catch {} } catch {}
      clearTimeout(t);
      if (ok) return true;
    } catch {}
  }
  return false;
}
/* pool sencillo de concurrencia */
async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch((e) => ({ error: String(e.message || e) })); }
  }));
  return out;
}
const rnd = (a, n) => { const c = [...a]; const o = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]); return o; };

(async () => {
  console.log('════ AUDITORÍA CINECALIDAD.AM — ' + new Date().toISOString() + ' ════');
  /* Fase A: catálogos completos */
  const cats = {};
  for (const kind of ['movie', 'tvshow', 'anime']) {
    const all = [];
    for (let p = 1; p <= 120; p++) {
      let d;
      try { d = await json(`https://tmdb.cinecalidad.am/v1/items?kind=${kind}&page=${p}&limit=100`); } catch { break; }
      const its = (d && d.items) || [];
      all.push(...its);
      const pg = (d && d.pagination) || {};
      if (!its.length || pg.has_next === false || p >= (pg.total_pages || 1)) break;
    }
    cats[kind] = all;
    console.log(`catálogo ${kind}: ${all.length}`);
  }

  /* Fase B: vivos/muertos a nivel lista */
  const resumen = {};
  const muertos = {};
  for (const kind of ['movie', 'tvshow', 'anime']) {
    const its = cats[kind];
    const esPeli = kind === 'movie';
    const vivos = its.filter((it) => esPeli ? (it.playable && it.code) : ((it.available_episodes || 0) > 0 || it.playable));
    muertos[kind] = its.filter((it) => !vivos.includes(it)).map((it) => ({ id: it.tmdb_id, t: it.title || it.original_title || String(it.tmdb_id) }));
    resumen[kind] = { total: its.length, vivos: vivos.length, muertos: its.length - vivos.length };
    console.log(`${kind}: ${resumen[kind].vivos} vivos / ${resumen[kind].muertos} muertos (nivel lista)`);
  }

  const MUESTRA_P = +(process.argv[2] || 60), MUESTRA_S = +(process.argv[3] || 30);
  const vivosP = cats.movie.filter((it) => it.playable && it.code);
  const vivosS = cats.tvshow.filter((it) => (it.available_episodes || 0) > 0 || it.playable);
  const vivosA = cats.anime.filter((it) => (it.available_episodes || 0) > 0 || it.playable);

  /* Fase C1: pelis vivas → ¿el video sirve de verdad? */
  console.log(`\n── C1: verificando embed de ${MUESTRA_P} películas al azar…`);
  const mP = rnd(vivosP, Math.min(MUESTRA_P, vivosP.length));
  let okP = 0;
  const detP = await pool(mP, 6, async (it) => {
    const sirve = await codeSirve(it.code);
    if (sirve) okP++; else console.log('  ✗ sin video real: ' + (it.title || '').slice(0, 50) + ' (code ' + it.code + ')');
    return { t: it.title, id: it.tmdb_id, ok: sirve };
  });
  console.log(`C1 resultado: ${okP}/${mP.length} películas sirven video real`);

  /* Fase C2: series vivas → playable_count por temporadas + un episodio real en 12 de ellas */
  console.log(`\n── C2: verificando ${MUESTRA_S} series al azar (Σ playable_count)…`);
  const mS = rnd(vivosS, Math.min(MUESTRA_S, vivosS.length));
  let okS = 0;
  await pool(mS, 5, async (it) => {
    let play = 0;
    try {
      const d = await json(`https://tmdb.cinecalidad.am/v1/items/tvshow/${it.tmdb_id}/seasons`);
      play = (d.seasons || []).reduce((a, s) => a + (s.playable_count || 0), 0);
    } catch {}
    if (play > 0) okS++; else console.log('  ✗ serie sin eps reproducibles: ' + (it.title || '').slice(0, 50));
    return { t: it.title, id: it.tmdb_id, play };
  });
  console.log(`C2 resultado: ${okS}/${mS.length} series con episodios reales`);
  console.log('\n── C2b: episodio REAL (embed+m3u8) de 15 series…');
  const mE = rnd(mS, Math.min(15, mS.length));
  let okE = 0;
  await pool(mE, 4, async (it) => {
    try {
      const d = await json(`https://tmdb.cinecalidad.am/v1/items/tvshow/${it.tmdb_id}/seasons`);
      const s1 = (d.seasons || []).find((s) => (s.playable_count || 0) > 0);
      if (!s1) return 0;
      const d2 = await json(`https://tmdb.cinecalidad.am/v1/items/tvshow/${it.tmdb_id}/seasons/${s1.season}`);
      const eps = (d2 && (d2.episodes || (d2.season && d2.season.episodes))) || [];
      const ep = eps.find((e) => e.playable && e.code);
      if (!ep) return 0;
      const sirve = await codeSirve(ep.code);
      if (sirve) okE++; else console.log('  ✗ ep sin video: ' + (it.title || '').slice(0, 44) + ' T' + s1.season + 'E' + ep.episode + ' (' + ep.code + ')');
    } catch (e) { console.log('  ? ' + (it.title || '').slice(0, 40) + ': ' + String(e.message || e).slice(0, 40)); }
  });
  console.log(`C2b resultado: ${okE}/${mE.length} episodios de series sirven video real`);

  console.log('\n── C3b: episodio REAL de 10 animes…');
  const mA2 = rnd(vivosA, Math.min(10, vivosA.length)); /* antes de la decl. de mA — usa vivosA */
  let okA2 = 0;
  await pool(mA2, 4, async (it) => {
    try {
      const d = await json(`https://tmdb.cinecalidad.am/v1/items/anime/${it.tmdb_id}/seasons`);
      const s1 = (d.seasons || []).find((s) => (s.playable_count || 0) > 0);
      if (!s1) return 0;
      const d2 = await json(`https://tmdb.cinecalidad.am/v1/items/anime/${it.tmdb_id}/seasons/${s1.season}`);
      const eps = (d2 && (d2.episodes || (d2.season && d2.season.episodes))) || [];
      const ep = eps.find((e) => e.playable && e.code);
      if (!ep) return 0;
      const sirve = await codeSirve(ep.code);
      if (sirve) okA2++; else console.log('  ✗ ep anime sin video: ' + (it.title || '').slice(0, 44) + ' T' + s1.season + 'E' + ep.episode + ' (' + ep.code + ')');
    } catch (e) { console.log('  ? ' + (it.title || '').slice(0, 40) + ': ' + String(e.message || e).slice(0, 40)); }
  });
  console.log(`C3b resultado: ${okA2}/${mA2.length} episodios de animes sirven video real`);
  var okAEps = okA2, mAEps = mA2.length;

  /* Fase C3: animes vivos → muestreo de playable_count */
  console.log(`\n── C3: verificando ${Math.min(20, vivosA.length)} animes al azar…`);
  const mA = rnd(vivosA, Math.min(20, vivosA.length));
  let okA = 0;
  await pool(mA, 5, async (it) => {
    let play = 0;
    try {
      const d = await json(`https://tmdb.cinecalidad.am/v1/items/anime/${it.tmdb_id}/seasons`);
      play = (d.seasons || []).reduce((a, s) => a + (s.playable_count || 0), 0);
    } catch {}
    if (play > 0) okA++; else console.log('  ✗ anime sin eps: ' + (it.title || '').slice(0, 50));
  });
  console.log(`C3 resultado: ${okA}/${mA.length} animes con episodios reales`);

  /* Fase D: confirmar muertos (muestra de 10) por ficha */
  console.log('\n── D: confirmando muertos por ficha (10 al azar entre las 3 listas)…');
  const mMuertos = rnd([...muertos.movie.map((x) => ({ ...x, k: 'movie' })), ...muertos.tvshow.map((x) => ({ ...x, k: 'tvshow' })), ...muertos.anime.map((x) => ({ ...x, k: 'anime' }))], 10);
  let confMuertos = 0;
  for (const m of mMuertos) {
    try {
      const d = await json(`https://tmdb.cinecalidad.am/v1/items/${m.k}/${m.id}`);
      const it = d && d.item;
      const realmenteMuerto = !it || !(it.playable && it.code) && !((it.available_episodes || 0) > 0);
      if (realmenteMuerto) confMuertos++;
      else console.log('  ¡ojo! la lista lo decía muerto pero la ficha NO: ' + (m.t || '').slice(0, 50));
    } catch { confMuertos++; }
  }
  console.log(`D: ${confMuertos}/${mMuertos.length} muertos confirmados en ficha`);

  /* Resumen final */
  const out = {
    fecha: new Date().toISOString(), fuente: 'cinecalidad.am (API tmdb.cinecalidad.am)',
    resumen, verificacion: {
      pelis: { muestra: mP.length, ok: okP, tasa: +(100 * okP / mP.length).toFixed(1) },
      series: { muestra: mS.length, ok: okS, epsReales: { muestra: mE.length, ok: okE } },
      animes: { muestra: mA.length, ok: okA, epsReales: { muestra: mAEps, ok: okAEps } },
      muertosConfirmados: { muestra: mMuertos.length, ok: confMuertos },
    },
    muertos,
  };
  fs.writeFileSync('/tmp/auditoria-cq.json', JSON.stringify(out, null, 1));
  console.log('\n════ RESUMEN ════');
  console.log(`pelis:   ${resumen.movie.vivos}/${resumen.movie.total} con video asignado — entrega real ${okP}/${mP.length} (${(100 * okP / mP.length).toFixed(0)}%)`);
  console.log(`series:  ${resumen.tvshow.vivos}/${resumen.tvshow.total} con episodios — entrega real ${okS}/${mS.length}, ep real ${okE}/${mE.length}`);
  console.log(`animes:  ${resumen.anime.vivos}/${resumen.anime.total} con episodios — entrega real ${okA}/${mA.length}, ep real ${okAEps}/${mAEps}`);
  console.log(`muertos: ${resumen.movie.muertos} pelis + ${resumen.tvshow.muertos} series + ${resumen.anime.muertos} animes (conf. ficha ${confMuertos}/${mMuertos.length})`);
  console.log('JSON completo en /tmp/auditoria-cq.json');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
