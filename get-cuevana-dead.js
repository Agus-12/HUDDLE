#!/usr/bin/env node
/* Get ALL dead Cuevana slugs (no embeds) */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const SITEMAPS = Array.from({length: 9}, (_, i) => `https://cuevana.mov/pelicula-sitemap${i ? i+1 : ''}.xml`);
const API_BASE = 'https://cuevana.mov/wp-json/wpreact/v1/movie/';
const TIMEOUT = 12000;
const CONCURRENCY = 10;

function fetchUrl(url, maxR = 3) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxR > 0) {
        let loc = res.headers.location; if (loc.startsWith('/')) loc = new URL(loc, url).href;
        res.resume(); return resolve(fetchUrl(loc, maxR - 1));
      }
      let d = []; res.on('data', c => d.push(c));
      res.on('end', () => { const buf = Buffer.concat(d);
        if (res.headers['content-encoding'] === 'gzip') zlib.gunzip(buf, (e, o) => resolve({ ok: !e, status: res.statusCode, data: e ? buf.toString() : o.toString() }));
        else resolve({ ok: true, status: res.statusCode, data: buf.toString() });
      });
      res.on('error', () => resolve({ ok: false, status: 0, data: '' }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: '' }); });
  });
}

async function main() {
  console.log('Getting slugs...');
  const slugs = [];
  for (const url of SITEMAPS) {
    const r = await fetchUrl(url);
    if (!r.ok) continue;
    const re = /<loc>https?:\/\/cuevana\.[a-z.]+\/pelicula\/\d+\/([^<]+)<\/loc>/g;
    let m; while ((m = re.exec(r.data))) slugs.push(m[1].replace(/\/$/, ''));
  }
  const unique = [...new Set(slugs)];
  console.log(`Total unique: ${unique.length}`);
  
  // Check each for latino embeds
  let checked = 0, dead = [];
  const start = Date.now();
  
  for (let s = 0; s < unique.length; s += CONCURRENCY) {
    const batch = unique.slice(s, s + CONCURRENCY);
    const results = await Promise.all(batch.map(async slug => {
      const r = await fetchUrl(API_BASE + encodeURIComponent(slug));
      checked++;
      if (!r.ok) return { slug, dead: true, reason: 'api_' + r.status };
      try {
        const d = JSON.parse(r.data);
        const lat = ((d.videos || {}).latino || []).filter(e => e.url);
        if (lat.length === 0) return { slug, dead: true, reason: 'no_latino' };
        return { slug, dead: false };
      } catch { return { slug, dead: true, reason: 'json_error' }; }
    }));
    for (const r of results) { if (r.dead) dead.push(r.slug); }
    if (checked % 500 < CONCURRENCY) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`${checked}/${unique.length} | Dead: ${dead.length} | ${elapsed}s`);
    }
  }
  
  console.log(`\nDONE: ${dead.length} dead slugs out of ${unique.length}`);
  fs.writeFileSync(__dirname + '/cuevana-ocultas.txt', dead.join('\n') + '\n');
  console.log('Saved: cuevana-ocultas.txt');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });