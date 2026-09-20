#!/usr/bin/env node
/**
 * SONDA PELISXD — Revisa películas ocultas periódicamente
 * para ver si volvieron a tener embeds funcionales (Byse).
 * 
 * Ejecutar cada 6-12 horas desde cron o desde el propio servidor.
 * Uso: node /home/user/HUDDLE/sonda-pelisxd.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OCULTAS_FILE = path.join(__dirname, 'public', 'pxd-ocultas.txt');
const LOG_FILE = path.join(__dirname, 'sonda-pelisxd.log');
const SAMPLE_SIZE = 30; // películas a revisar por ejecución

function fetch(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, text: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const t0 = Date.now();
  
  // Read ocultas
  let ocultas = [];
  try {
    ocultas = fs.readFileSync(OCULTAS_FILE, 'utf8').split('\n').filter(s => s.trim());
  } catch { console.log('No hay archivo de ocultas'); return; }
  
  if (!ocultas.length) { console.log('No hay películas ocultas'); return; }
  
  // Pick random sample
  const shuffled = [...ocultas].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, SAMPLE_SIZE);
  
  console.log(`[sonda] Revisando ${sample.length} de ${ocultas.length} ocultas...`);
  
  const revived = [];
  const stillDead = [];
  
  for (const slug of sample) {
    try {
      const r = await fetch(`https://www.pelisxd.com/pelicula/${slug}`, 12000);
      if (!r.ok) { stillDead.push(slug); continue; }
      
      // Check if it has Byse embed
      const re = /v_source[^A-Za-z0-9]{0,12}([A-Za-z0-9+/=]{24,})/g;
      let m, hasByse = false;
      while ((m = re.exec(r.text))) {
        try {
          const url = Buffer.from(m[1], 'base64').toString('utf8');
          if (/byse|byseqekaho/i.test(url)) { hasByse = true; break; }
        } catch {}
      }
      
      if (hasByse) {
        revived.push(slug);
        console.log(`  ✅ REVIVIÓ: ${slug}`);
      } else {
        stillDead.push(slug);
      }
    } catch {
      stillDead.push(slug);
    }
  }
  
  // If any revived, remove from ocultas
  if (revived.length) {
    const ocultasSet = new Set(ocultas);
    for (const s of revived) ocultasSet.delete(s);
    fs.writeFileSync(OCULTAS_FILE, [...ocultasSet].sort().join('\n') + '\n');
    console.log(`[sonda] ✅ ${revived.length} películas revivieron y se removieron de ocultas`);
  }
  
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const logLine = `[${new Date().toISOString()}] sample=${sample.length} revived=${revived.length} dead=${stillDead.length} total_ocultas=${ocultas.length} time=${elapsed}s\n`;
  fs.appendFileSync(LOG_FILE, logLine);
  console.log(`[sonda] Completado en ${elapsed}s — ${revived.length} revivieron, ${stillDead.length} siguen muertas`);
}

main().catch(e => console.error('[sonda] Error:', e.message));