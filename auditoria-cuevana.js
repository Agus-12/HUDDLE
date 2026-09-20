#!/usr/bin/env node
/**
 * AUDITORÍA MASIVA — Cuevana.mov (20 Sep 2026)
 * 
 * Escanea TODAS las películas del sitemap de cuevana.mov
 * y verifica qué hosts funcionan via HTTP puro.
 * 
 * Solo audio LATINO.
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');

// Config
const SITEMAPS = [
  'https://cuevana.mov/pelicula-sitemap.xml',
  'https://cuevana.mov/pelicula-sitemap2.xml',
  'https://cuevana.mov/pelicula-sitemap3.xml',
  'https://cuevana.mov/pelicula-sitemap4.xml',
  'https://cuevana.mov/pelicula-sitemap5.xml',
  'https://cuevana.mov/pelicula-sitemap6.xml',
  'https://cuevana.mov/pelicula-sitemap7.xml',
  'https://cuevana.mov/pelicula-sitemap8.xml',
  'https://cuevana.mov/pelicula-sitemap9.xml',
];

const API_BASE = 'https://cuevana.mov/wp-json/wpreact/v1/movie/';
const TIMEOUT = 15000;
const CONCURRENCY = 8;
const REPORT_FILE = __dirname + '/docs/AUDITORIA-CUEVANA-2026-09-20.md';
const OCULTAS_FILE = __dirname + '/cuevana-ocultas.txt';
const LOG_FILE = __dirname + '/auditoria-cuevana.log';

// Stats
let stats = {
  total: 0,
  withLatino: 0,
  withoutLatino: 0,
  hostStats: {},
  samples: [],
  errors: [],
  startTime: Date.now(),
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// Fetch with redirect following
function fetchUrl(url, maxRedirects = 3) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { 
      timeout: TIMEOUT, 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (compatible; HuddleAudit/1.0)',
        'Accept-Encoding': 'identity'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = new URL(loc, url).href;
        res.resume();
        return resolve(fetchUrl(loc, maxRedirects - 1));
      }
      let data = [];
      res.on('data', c => data.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(data);
        if (res.headers['content-encoding'] === 'gzip') {
          zlib.gunzip(buf, (err, out) => resolve({ 
            ok: !err, status: res.statusCode, data: err ? buf.toString() : out.toString() 
          }));
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

// Extract movie slugs from sitemap
async function getSitemapSlugs() {
  const slugs = [];
  for (const url of SITEMAPS) {
    const r = await fetchUrl(url);
    if (!r.ok) { log(`ERROR sitemap: ${url} → ${r.status}`); continue; }
    const re = /<loc>https?:\/\/cuevana\.[a-z.]+\/pelicula\/(\d+)\/([^<]+)<\/loc>/g;
    let m;
    while ((m = re.exec(r.data))) {
      slugs.push({ id: m[1], slug: m[2].replace(/\/$/, '') });
    }
    log(`Sitemap ${url.split('/').pop()}: ${slugs.length} total acumulado`);
  }
  return slugs;
}

// Extract m3u8 from embed page
async function extractM3u8(embedUrl) {
  const r = await fetchUrl(embedUrl);
  if (!r.ok) return { ok: false, host: new URL(embedUrl).hostname, reason: 'http_' + r.status };
  
  const html = r.data;
  const host = new URL(embedUrl).hostname;
  
  // 1. Direct m3u8 in HTML (goodstream.one style)
  const directM3u8 = /file\s*[:=]\s*["'](https?:\/\/[^"']+master\.m3u8[^"']*?)["']/i.exec(html);
  if (directM3u8) return { ok: true, host, m3u8: directM3u8[1], method: 'direct' };
  
  // Also try without "file" prefix
  const anyM3u8 = /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(html);
  if (anyM3u8) return { ok: true, host, m3u8: anyM3u8[1], method: 'regex' };
  
  // 2. Packed JS (vimeos.net / hlswish.com style)
  const packedRe = /eval\(function\(p,a,c,k,e,d\)\{.+?\}\('(.+?)',(\d+),(\d+),'([^']*)'\.split/;
  const pm = packedRe.exec(html);
  if (pm) {
    try {
      const pStr = pm[1], aVal = +pm[2], cVal = +pm[3], k = pm[4].split('|');
      const toBase = (n, b) => {
        if (n === 0) return '0';
        const d = [];
        while (n) { d.push('0123456789abcdefghijklmnopqrstuvwxyz'[n % b]); n = Math.floor(n / b); }
        return d.reverse().join('');
      };
      let result = pStr;
      for (let i = cVal - 1; i >= 0; i--) {
        const w = toBase(i, aVal);
        if (i < k.length && k[i]) {
          result = result.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), k[i]);
        }
      }
      const m3u8Match = /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(result);
      if (m3u8Match) return { ok: true, host, m3u8: m3u8Match[1], method: 'packed' };
    } catch (e) {}
  }
  
  // 3. DDoS-Guard / Cloudflare detection
  if (/ddos-guard|cloudflare|checking your browser/i.test(html)) {
    return { ok: false, host, reason: 'ddos_guard' };
  }
  
  return { ok: false, host, reason: 'no_m3u8' };
}

// Check if m3u8 is valid
async function verifyM3u8(url) {
  const r = await fetchUrl(url);
  return r.ok && r.data.includes('#EXTM3U');
}

// Verify a single movie via API
async function verifyMovie(id, slug) {
  const r = await fetchUrl(API_BASE + encodeURIComponent(slug));
  if (!r.ok) return { ok: false, reason: 'api_' + r.status };
  
  let data;
  try { data = JSON.parse(r.data); } catch { return { ok: false, reason: 'json_error' }; }
  
  const videos = data.videos || {};
  const latinoEmbeds = (videos.latino || []).filter(v => v.url && /latino|español/i.test(v.lang || ''));
  
  if (latinoEmbeds.length === 0) {
    // Check if there are ANY videos at all
    const allEmbeds = [...(videos.latino || []), ...(videos.spanish || []), ...(videos.english || []), ...(videos.subtitled || [])];
    return { 
      ok: false, 
      reason: 'no_latino', 
      title: data.titles?.name,
      totalEmbeds: allEmbeds.length,
      languages: Object.keys(videos).filter(k => (videos[k] || []).length > 0)
    };
  }
  
  // Try each latino embed
  const results = [];
  for (const embed of latinoEmbeds) {
    const hostResult = await extractM3u8(embed.url);
    if (hostResult.ok) {
      // Verify the m3u8 actually works
      const valid = await verifyM3u8(hostResult.m3u8);
      if (valid) {
        results.push({ 
          host: hostResult.host, 
          method: hostResult.method, 
          quality: embed.quality,
          m3u8: hostResult.m3u8 
        });
      }
    }
    // Track host stats
    const h = hostResult.host || new URL(embed.url).hostname;
    if (!stats.hostStats[h]) stats.hostStats[h] = { ok: 0, fail: 0, reasons: {} };
    if (hostResult.ok) {
      stats.hostStats[h].ok++;
    } else {
      stats.hostStats[h].fail++;
      const reason = hostResult.reason || 'unknown';
      stats.hostStats[h].reasons[reason] = (stats.hostStats[h].reasons[reason] || 0) + 1;
    }
  }
  
  if (results.length > 0) {
    return { 
      ok: true, 
      title: data.titles?.name, 
      poster: data.images?.poster,
      tmdbId: data.TMDbId,
      embeds: results,
      totalLatino: latinoEmbeds.length,
      workingLatino: results.length,
    };
  }
  
  return { ok: false, reason: 'all_embeds_failed', title: data.titles?.name, totalLatino: latinoEmbeds.length };
}

// Process batch with concurrency limit
async function processBatch(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// Main
async function main() {
  log('=== AUDITORÍA CUEVANA.MOV — INICIO ===');
  log(`Fecha: ${new Date().toISOString()}`);
  
  // 1. Get all slugs from sitemaps
  log('Fase 1: Descargando sitemaps...');
  const allMovies = await getSitemapSlugs();
  stats.total = allMovies.length;
  log(`Total películas en sitemaps: ${allMovies.length}`);
  
  // Deduplicate
  const seen = new Set();
  const movies = allMovies.filter(m => {
    const key = m.id + '/' + m.slug;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  log(`Deduplicadas: ${movies.length}`);
  
  // 2. Verify each movie via API
  log('Fase 2: Verificando películas via API (8 concurrent)...');
  let checked = 0;
  const alive = [];
  const dead = [];
  
  // Process in batches of 100 for progress reporting
  const BATCH = 100;
  for (let start = 0; start < movies.length; start += BATCH) {
    const batch = movies.slice(start, start + BATCH);
    const results = await processBatch(batch, async (movie) => {
      const result = await verifyMovie(movie.id, movie.slug);
      checked++;
      return { ...movie, ...result };
    }, CONCURRENCY);
    
    for (const r of results) {
      if (r.ok) {
        alive.push(r);
        stats.withLatino++;
      } else {
        dead.push(r);
        stats.withoutLatino++;
      }
    }
    
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
    const rate = (checked / (elapsed || 1)).toFixed(1);
    const pct = ((checked / movies.length) * 100).toFixed(1);
    log(`Progreso: ${checked}/${movies.length} (${pct}%) | Vivas: ${stats.withLatino} | Muertas: ${stats.withoutLatino} | ${rate}/s | ${elapsed}s`);
    
    // Save checkpoint every 500
    if (checked % 500 < BATCH) {
      fs.writeFileSync(__dirname + '/auditoria-cuevana-checkpoint.json', JSON.stringify({
        checked, alive: alive.length, dead: dead.length,
        aliveSamples: alive.slice(-5).map(a => ({ slug: a.slug, title: a.title, hosts: a.embeds?.map(e => e.host) })),
        deadSamples: dead.slice(-5).map(d => ({ slug: d.slug, reason: d.reason })),
      }, null, 2));
    }
  }
  
  // 3. Generate report
  log('Fase 3: Generando reporte...');
  
  // Save ocultas (dead movies)
  const ocultasSlugs = dead.map(d => d.slug);
  fs.writeFileSync(OCULTAS_FILE, ocultasSlugs.join('\n') + '\n');
  
  // Top hosts
  const hostEntries = Object.entries(stats.hostStats).sort((a, b) => b[1].ok - a[1].ok);
  
  const elapsed = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(1);
  
  const report = `# 🎬 Auditoría Cuevana.mov — ${new Date().toISOString().slice(0, 10)}

## Resumen Ejecutivo

| Concepto | Cantidad |
|---|---|
| **Total en sitemap** | **${stats.total.toLocaleString()}** |
| **Con audio latino + HTTP funcional** | **${stats.withLatino.toLocaleString()}** (${((stats.withLatino / stats.total) * 100).toFixed(1)}%) |
| **Sin audio latino o sin embeds** | **${stats.withoutLatino.toLocaleString()}** (${((stats.withoutLatino / stats.total) * 100).toFixed(1)}%) |
| **Tiempo de escaneo** | ${elapsed} minutos |

## Hosts de Video (Solo HTTP puro)

| Host | Éxito | Fallo | Razón principal |
|---|---|---|---|
${hostEntries.map(([h, s]) => {
  const mainReason = Object.entries(s.reasons).sort((a,b) => b[1] - a[1])[0];
  return `| ${h} | ${s.ok} | ${s.fail} | ${mainReason ? mainReason[0] + ' (' + mainReason[1] + ')' : '-'} |`;
}).join('\n')}

## Metodología

1. **Sitemap scraping:** Se descargaron los 9 sitemaps de \`cuevana.mov/pelicula-sitemap*.xml\`
2. **API verification:** Para cada película, se consultó \`/wp-json/wpreact/v1/movie/{slug}\`
3. **Embed testing:** Se probaron SOLO los embeds con \`lang: "latino"\` o \`"español"\`
4. **m3u8 extraction:** Se intentó extraer m3u8 de cada embed:
   - Directo en HTML (goodstream.one)
   - JS packed desempacado (vimeos.net, hlswish.com)
5. **m3u8 verification:** Se verificó que el m3u8 contenga \`#EXTM3U\`

## Filtros aplicados

- ❌ Audio inglés, subtítulado → descartados
- ❌ Hosts con DDoS-Guard (voe.sx, filemoon.sx) → descartados
- ❌ Embeds que no devuelven m3u8 → descartados
- ✅ Solo audio **LATINO** → verificados

## Muestra de películas vivas (últimas 10)

${alive.slice(-10).map(a => `- **${a.title}** (${a.slug}) → ${a.embeds.map(e => e.host).join(', ')}`).join('\n')}

## Muestra de películas muertas (últimas 10)

${dead.slice(-10).map(d => `- **${d.title || d.slug}** → ${d.reason}`).join('\n')}

## Archivos generados

- \`cuevana-ocultas.txt\` — ${ocultasSlugs.length} slugs sin audio latino funcional
- \`auditoria-cuevana-checkpoint.json\` — checkpoint de progreso
- \`auditoria-cuevana.log\` — log detallado

---

*Auditoría generada el ${new Date().toISOString()} por Huddle Agent*
`;

  fs.writeFileSync(REPORT_FILE, report);
  log(`=== COMPLETADO === Vivas: ${stats.withLatino} | Muertas: ${stats.withoutLatino} | ${elapsed} min`);
  log(`Reporte: ${REPORT_FILE}`);
  log(`Ocultas: ${OCULTAS_FILE} (${ocultasSlugs.length} slugs)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });