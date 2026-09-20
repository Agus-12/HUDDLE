#!/usr/bin/env node
/**
 * AUDITORÍA CUEVANA — Fase rápida
 * Solo consulta la API y cuenta embeds por host (sin verificar m3u8)
 */

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const SITEMAPS = Array.from({length: 9}, (_, i) => 
  `https://cuevana.mov/pelicula-sitemap${i ? i+1 : ''}.xml`
);
const API_BASE = 'https://cuevana.mov/wp-json/wpreact/v1/movie/';
const TIMEOUT = 12000;
const CONCURRENCY = 10;

let log_lines = [];
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  log_lines.push(line);
}

function fetchUrl(url, maxR = 3) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxR > 0) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = new URL(loc, url).href;
        res.resume();
        return resolve(fetchUrl(loc, maxR - 1));
      }
      let d = [];
      res.on('data', c => d.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(d);
        if (res.headers['content-encoding'] === 'gzip') {
          zlib.gunzip(buf, (e, o) => resolve({ ok: !e, status: res.statusCode, data: e ? buf.toString() : o.toString() }));
        } else {
          resolve({ ok: true, status: res.statusCode, data: buf.toString() });
        }
      });
      res.on('error', () => resolve({ ok: false, status: 0, data: '' }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: '' }); });
  });
}

async function getSitemapSlugs() {
  const slugs = [];
  for (const url of SITEMAPS) {
    const r = await fetchUrl(url);
    if (!r.ok) continue;
    const re = /<loc>https?:\/\/cuevana\.[a-z.]+\/pelicula\/(\d+)\/([^<]+)<\/loc>/g;
    let m;
    while ((m = re.exec(r.data))) {
      slugs.push({ id: m[1], slug: m[2].replace(/\/$/, '') });
    }
  }
  // Deduplicate
  const seen = new Set();
  return slugs.filter(m => {
    const k = m.slug;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function checkApi(slug) {
  const r = await fetchUrl(API_BASE + encodeURIComponent(slug));
  if (!r.ok) return { ok: false, reason: 'api_' + r.status };
  try {
    const d = JSON.parse(r.data);
    const v = d.videos || {};
    const lat = (v.latino || []).filter(e => e.url);
    const hosts = lat.map(e => {
      try { return new URL(e.url).hostname; } catch { return 'unknown'; }
    });
    return { 
      ok: true, 
      title: d.titles?.name,
      hasLatino: lat.length > 0,
      latinoCount: lat.length,
      hosts,
      allLangs: Object.keys(v).filter(k => (v[k] || []).length > 0),
    };
  } catch { return { ok: false, reason: 'json_error' }; }
}

async function processBatch(items, fn, conc) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, () => worker()));
  return results;
}

async function main() {
  log('=== AUDITORÍA CUEVANA — ESCANEO RÁPIDO (API only) ===');
  
  // 1. Sitemaps
  log('Descargando sitemaps...');
  const movies = await getSitemapSlugs();
  log(`Total películas únicas: ${movies.length}`);
  
  // 2. Check API for each movie
  log('Verificando API (10 concurrent, sin verificar m3u8)...');
  let checked = 0, withLatino = 0, withoutLatino = 0, apiErrors = 0;
  const hostCounts = {};
  const langCounts = {};
  const deadReasons = {};
  const aliveSamples = [];
  const deadSamples = [];
  
  const BATCH = 200;
  const start = Date.now();
  
  for (let s = 0; s < movies.length; s += BATCH) {
    const batch = movies.slice(s, s + BATCH);
    const results = await processBatch(batch, async m => {
      const r = await checkApi(m.slug);
      checked++;
      return { ...m, ...r };
    }, CONCURRENCY);
    
    for (const r of results) {
      if (!r.ok) {
        apiErrors++;
        deadReasons[r.reason] = (deadReasons[r.reason] || 0) + 1;
        if (deadSamples.length < 10) deadSamples.push({ slug: r.slug, reason: r.reason });
        continue;
      }
      if (r.hasLatino) {
        withLatino++;
        for (const h of r.hosts) {
          hostCounts[h] = (hostCounts[h] || 0) + 1;
        }
        if (aliveSamples.length < 20) aliveSamples.push({ slug: r.slug, title: r.title, hosts: r.hosts, count: r.latinoCount });
      } else {
        withoutLatino++;
        for (const l of r.allLangs) {
          langCounts[l] = (langCounts[l] || 0) + 1;
        }
        if (deadSamples.length < 20) deadSamples.push({ slug: r.slug, title: r.title, langs: r.allLangs, reason: 'no_latino' });
      }
    }
    
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    const rate = (checked / (elapsed || 1)).toFixed(1);
    log(`${checked}/${movies.length} (${((checked/movies.length)*100).toFixed(1)}%) | OK: ${withLatino} | Sin lat: ${withoutLatino} | Err: ${apiErrors} | ${rate}/s`);
  }
  
  // 3. Summary
  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  log('=== RESUMEN ===');
  log(`Total: ${movies.length} | Con latino: ${withLatino} (${((withLatino/movies.length)*100).toFixed(1)}%) | Sin latino: ${withoutLatino} | API errors: ${apiErrors}`);
  log(`Tiempo: ${elapsed} min`);
  
  // Sort hosts by count
  const hostsSorted = Object.entries(hostCounts).sort((a,b) => b[1] - a[1]);
  log('--- HOSTS (embeds con audio latino) ---');
  for (const [h, c] of hostsSorted) log(`  ${h}: ${c}`);
  
  // Languages without latino
  if (Object.keys(langCounts).length) {
    log('--- OTROS IDIOMAS (sin latino) ---');
    for (const [l, c] of Object.entries(langCounts).sort((a,b) => b[1] - a[1])) log(`  ${l}: ${c}`);
  }
  
  // Dead reasons
  log('--- RAZONES DE FALLO ---');
  for (const [r, c] of Object.entries(deadReasons).sort((a,b) => b[1] - a[1])) log(`  ${r}: ${c}`);
  
  // Save results
  const report = {
    date: new Date().toISOString(),
    total: movies.length,
    withLatino,
    withoutLatino,
    apiErrors,
    hostCounts: Object.fromEntries(hostsSorted),
    langCounts,
    deadReasons,
    aliveSamples,
    deadSamples,
    elapsedMin: parseFloat(elapsed),
  };
  fs.writeFileSync(__dirname + '/auditoria-cuevana-rapida.json', JSON.stringify(report, null, 2));
  log('Guardado: auditoria-cuevana-rapida.json');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });