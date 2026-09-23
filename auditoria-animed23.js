#!/usr/bin/env node
/* v290: AUDITORÍA AnimeD23 — barrido del catálogo completo (d23-slugs.txt).
 * Para cada serie: ficha → primer capítulo → clasifica el FLUJO del player
 * (direct | jwt | multi | desconocido) → sigue la cadena → cuenta tabs.
 * Objetivo: cazar cualquier serie cuyo formato de player Huddle no reconozca
 * (el bug de BAKI-DOU) o que llegue sin reproductores.
 * Salida: auditorias/animed23-audit-v290.json + resumen por consola.
 * Uso: node auditoria-animed23.js [--limite N] */
'use strict';
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CONC = 5;
const limite = (() => { const i = process.argv.indexOf('--limite'); return i > 0 ? parseInt(process.argv[i + 1], 10) : 0; })();

function slugsDe(f) { try { return fs.readFileSync(path.join(__dirname, 'public', f), 'utf8').split('\n').map(s => s.trim()).filter(Boolean); } catch { return []; } }
const OCULTAS = new Set([...slugsDe('d23-ocultas.txt'), ...slugsDe('animed23-ocultas.txt')]);
const slugs = [...new Set([...slugsDe('d23-slugs.txt'), ...slugsDe('animed23-slugs.txt')])].filter(s => !OCULTAS.has(s));
if (limite) slugs.length = Math.min(slugs.length, limite);

async function get(url, referer, ms = 15000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const h = { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'es-MX,es;q=0.9' };
    if (referer) h.Referer = referer;
    const r = await fetch(url, { headers: h, redirect: 'follow', signal: ac.signal });
    return { status: r.status, ok: r.ok, text: () => r.text() };
  } catch (e) { return { status: 0, ok: false, text: () => Promise.resolve(''), err: String(e.message || e).slice(0, 80) }; }
  finally { clearTimeout(t); }
}
function esChallenge(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  return /Just a moment|One moment, please|Attention Required.*Cloudflare/i.test(title)
    || /<form\b[^>]*\bid=["']challenge-form["']/i.test(html);
}
function tabsDeContenedor(html) {
  const tabs = [];
  for (const mm of html.matchAll(/data-player-url="([^"]+)"/g)) tabs.push(mm[1]);
  const vt = /videoTabs\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (vt) { try { for (const t of JSON.parse(vt[1].replace(/\\\//g, '/'))) if (t && t.url) tabs.push(t.url); } catch {} }
  return [...new Set(tabs)];
}
const clean = s => s.replace(/&#038;/g, '&').replace(/&amp;/g, '&');

async function clasificar(slug) {
  const out = { slug, flujo: '?', tabs: 0, estado: '?', nota: '' };
  const r = await get('https://animed23.com/anime/' + slug + '/');
  if (r.status === 404) { out.estado = 'ficha-404'; return out; }
  if (!r.ok) { out.estado = 'ficha-fallo:' + r.status; return out; }
  const html = await r.text();
  if (esChallenge(html)) { out.estado = 'challenge-ficha'; return out; }
  const eps = [...new Set([...html.matchAll(/\/capitulo\/([a-z0-9-]+)\//g)].map(m => m[1]))];
  if (!eps.length) { out.estado = 'sin-capitulos'; return out; }
  const epUrl = 'https://animed23.com/capitulo/' + eps[0] + '/';
  const r2 = await get(epUrl);
  if (!r2.ok) { out.estado = 'capitulo-fallo:' + r2.status; return out; }
  const html2 = await r2.text();
  if (esChallenge(html2)) { out.estado = 'challenge-cap'; return out; }

  /* 1) flujo directo: container.php?id=D23-… */
  const direct = /container\.php\?id=([A-Za-z0-9_-]+)/.exec(html2);
  if (direct) {
    out.flujo = 'direct';
    const esD23 = /^D23-/i.test(direct[1]);
    const curl = esD23 ? 'https://animed23.online/container.php?id=' + direct[1] + '&open=1'
                         : 'https://animed23.online/multiplayer/contenedor.php?id=' + direct[1];
    const r3 = await get(curl, epUrl);
    if (r3.ok) out.tabs = tabsDeContenedor(await r3.text()).length;
    else out.nota = 'container:' + r3.status;
    out.estado = out.tabs ? 'ok' : 'sin-tabs';
    return out;
  }
  /* 2) flujo multi (v290): multiplayer/options.php?server=multi&value=TOKEN */
  const mMulti = /<iframe[^>]+src="([^"]*multiplayer\/options\.php[^"]*)"/i.exec(html2);
  if (mMulti) {
    out.flujo = 'multi';
    let mUrl = clean(mMulti[1]); if (mUrl.startsWith('//')) mUrl = 'https:' + mUrl;
    const r3 = await get(mUrl, epUrl);
    if (!r3.ok) { out.estado = 'multi-options-fallo:' + r3.status; return out; }
    const h3 = await r3.text();
    const mCont = /iframe\.src='([^']+multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)'/i.exec(h3)
               || /src="([^"]*multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)"/i.exec(h3);
    if (!mCont) { out.estado = 'multi-sin-contenedor'; out.nota = h3.slice(0, 120).replace(/\s+/g, ' '); return out; }
    const cUrl = mCont[1].startsWith('//') ? 'https:' + mCont[1] : mCont[1];
    const r4 = await get(cUrl, mUrl);
    if (r4.ok) out.tabs = tabsDeContenedor(await r4.text()).length;
    else out.nota = 'contenedor:' + r4.status;
    out.estado = out.tabs ? 'ok' : 'sin-tabs';
    return out;
  }
  /* 3) flujo JWT: opciones/options.php */
  const mOpt = /<iframe[^>]+src="([^"]*opciones\/options\.php[^"]*)"/i.exec(html2)
            || /src="([^"]*animed23\.online\/opciones\/options\.php[^"]*)"/i.exec(html2);
  if (mOpt) {
    out.flujo = 'jwt';
    let optUrl = clean(mOpt[1]); if (optUrl.startsWith('//')) optUrl = 'https:' + optUrl;
    const r3 = await get(optUrl, epUrl);
    if (!r3.ok) { out.estado = 'jwt-options-fallo:' + r3.status; return out; }
    const h3 = await r3.text();
    const playerM = /href="([^"]*player\.php\?data=[^"]*)"/i.exec(h3) || /player\.php\?data=[A-Za-z0-9%_.\-]+/.exec(h3);
    if (!playerM) { out.estado = 'jwt-sin-player'; return out; }
    let pUrl = clean(playerM[1] || playerM[0]);
    if (pUrl.startsWith('/')) pUrl = 'https://animed23.online/opciones/' + pUrl.replace(/^\//, '');
    else if (!/^https?:/i.test(pUrl)) pUrl = 'https://animed23.online/opciones/' + pUrl;
    const r4 = await get(pUrl, optUrl);
    if (!r4.ok) { out.estado = 'jwt-player-fallo:' + r4.status; return out; }
    const h4 = await r4.text();
    const contM = /multiplayer\/contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(h4) || /contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(h4);
    if (contM) {
      const r5 = await get('https://animed23.online/multiplayer/contenedor.php?id=' + contM[1], pUrl);
      if (r5.ok) out.tabs = tabsDeContenedor(await r5.text()).length;
      else out.nota = 'contenedor:' + r5.status;
    } else {
      /* v290.2: player.php puede devolver el SELECTOR (fuente=latino|sub|cast) */
      const sel = [...h4.matchAll(/href="([^"]*player\.php\?data=[^"]*fuente=(?:latino|sub|cast)[^"]*)"/gi)].map(m => m[1]);
      if (sel.length) {
        const orden = ['latino', 'sub', 'cast'];
        sel.sort((a, b) => orden.findIndex(f => a.includes('fuente=' + f)) - orden.findIndex(f => b.includes('fuente=' + f)));
        for (const sh of sel.slice(0, 2)) {
          let sUrl = clean(sh);
          if (sUrl.startsWith('/')) sUrl = 'https://animed23.online/opciones/' + sUrl.replace(/^\//, '');
          const r5 = await get(sUrl, pUrl);
          if (!r5.ok) continue;
          const h5 = await r5.text();
          const mIfr = /<iframe[^>]+src="([^"]*multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)"/i.exec(h5);
          const c2 = /multiplayer\/contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(h5);
          let cUrl = mIfr ? mIfr[1] : (c2 ? 'https://animed23.online/multiplayer/contenedor.php?id=' + c2[1] : '');
          if (!cUrl) continue;
          const r6 = await get(cUrl, sUrl);
          if (r6.ok) out.tabs = tabsDeContenedor(await r6.text()).length;
          if (out.tabs) break;
        }
        if (!out.tabs) out.nota = 'selector-sin-contenedor';
      } else if (/d23-portada|d23-selector/i.test(h4)) out.nota = 'player-sin-contenedor-pero-vivo';
    }
    out.estado = out.tabs ? 'ok' : (out.nota.includes('vivo') ? 'ok-parcial' : 'sin-tabs');
    return out;
  }
  /* 4) nada conocido */
  out.flujo = 'desconocido';
  out.estado = 'flujo-desconocido';
  const ifr = /<iframe[^>]*src="([^"]*)"/i.exec(html2);
  out.nota = ifr ? ifr[1].slice(0, 140) : 'sin iframe (título: ' + ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html2) || [])[1] || '').trim().slice(0, 60) + ')';
  return out;
}

(async () => {
  const res = []; let i = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    while (i < slugs.length) {
      const s = slugs[i++];
      try { res.push(await clasificar(s)); } catch (e) { res.push({ slug: s, flujo: '?', tabs: 0, estado: 'excepcion', nota: String(e.message || e).slice(0, 80) }); }
      done++;
      if (done % 25 === 0) console.log('... ' + done + '/' + slugs.length);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  res.sort((a, b) => a.slug.localeCompare(b.slug));
  const resumen = {};
  for (const r of res) { const k = r.flujo + '|' + r.estado; resumen[k] = (resumen[k] || 0) + 1; }
  const out = { fecha: new Date().toISOString(), total: res.length, resumen, resultados: res };
  fs.mkdirSync(path.join(__dirname, 'auditorias'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'auditorias', 'animed23-audit-v290.json'), JSON.stringify(out, null, 1));
  console.log('\n=== RESUMEN (' + Math.round((Date.now() - t0) / 1000) + ' s) ===');
  for (const [k, v] of Object.entries(resumen).sort()) console.log(String(v).padStart(4), k);
  console.log('\n=== PROBLEMAS ===');
  const malos = res.filter(r => !/^ok/.test(r.estado));
  if (!malos.length) console.log('(ninguno — todo el catálogo trae reproductores)');
  for (const m of malos) console.log('-', m.slug, '|', m.flujo, '|', m.estado, m.nota ? '| ' + m.nota : '');
})();
