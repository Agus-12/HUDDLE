#!/usr/bin/env node
'use strict';

/*
 * Huddle — rastreador del catálogo del app Movie vía API web (info_web_get).
 *
 * Por qué así: `search/screen` no pagina (dead end 16 del CONTINUACION), pero
 * `vod/info_web_get?vod_id=N` responde la ficha pública de CUALQUIER id web
 * (o {} si no existe). Recorriendo el espacio de ids se reconstruye el
 * catálogo completo: títulos, portadas alojadas por Movie, idiomas, pianwei
 * (= app-id) y capítulos con duraciones (útiles para futuras huellas).
 *
 * Reglas de cortesía (obligatorias):
 *  - pocas peticiones por segundo (3 obreros × 250 ms ≈ 6 rps) y pausa larga
 *    ante errores/429; NUNCA subir la velocidad para "terminar antes".
 *  - reanudable: el checkpoint vive en el repo (sobrevive resets).
 *  - cuando una ficha trae series_info (demás temporadas), esos ids se
 *    marcan como cubiertos y NO se vuelven a pedir.
 *
 * Uso:
 *   node catalogo-movie.js                          # sigue desde el checkpoint
 *   node catalogo-movie.js --desde 296000 --hasta 297000   # rango manual
 *   node catalogo-movie.js --workers 2 --pausa-ms 400      # más suave
 *
 * Salidas (todo dentro del repo, para subirlo):
 *   auditorias/catalogo-web/checkpoint.json    — por dónde va + ids cubiertos
 *   auditorias/catalogo-web/bloque-{N}.json    — fichas encontradas por bloque de 25 000 ids
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAIZ = __dirname;
const DIR_SALIDA = path.join(RAIZ, 'auditorias', 'catalogo-web');
const CHECKPOINT = path.join(DIR_SALIDA, 'checkpoint.json');
const BLOQUE = 25000;

const KEY = Buffer.from('0123456789123456');
const IV = Buffer.from('2015030120123456');
const DEVICE = crypto.createHash('md5').update('1111111').digest('hex');
const API = 'https://albd.h4c5.com/api/vod/info_web_get';

const LÍMITE_SUPERIOR = 650000; /* margen sobre el mayor id visto (594285) */

function arg(nombre, defecto) {
  const i = process.argv.indexOf('--' + nombre);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : defecto;
}
const WORKERS = Math.max(1, Math.min(4, arg('workers', 3)));
const PAUSA_MS = Math.max(120, arg('pausa-ms', 250));
const DESDE_ARG = arg('desde', 0);
const HASTA_ARG = arg('hasta', 0);

function dec(txt) {
  try {
    let b64 = String(txt).trim();
    if (!b64 || b64.length < 24) return null;
    b64 += '='.repeat((-b64.length) % 4);
    const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}
function cabeceras() {
  const t = Date.now();
  return {
    'app_id': 'ppcinewebes', 'channel_code': 'ppcinewebb_1000', 'device_id': DEVICE,
    'cur_time': String(t), 'sign': crypto.createHash('md5').update('ppcineweb123' + DEVICE + t).digest('hex').toUpperCase(),
    'token': '', 'version': '30006', 'sys_platform': '3', 'app_language': 'es',
    'domain': 'escc.k5ca.com', 'origin': 'https://escc.k5ca.com', 'referer': 'https://escc.k5ca.com/',
    'user-agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile',
  };
}
function fechaParam() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${Math.floor(d.getUTCMinutes() / 10)}`;
}
function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cargarCheckpoint() {
  try {
    const c = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
    return {
      siguiente: Number(c.siguiente) || 1,
      cubiertos: new Set(Array.isArray(c.cubiertos) ? c.cubiertos : []),
      cola: Array.isArray(c.cola) ? c.cola.filter((x) => Number.isFinite(+x)).map(Number) : [],
      encontrados: Number(c.encontrados) || 0,
      pedidos: Number(c.pedidos) || 0,
      actualizadoEn: c.actualizadoEn || '',
    };
  } catch {
    return { siguiente: 1, cubiertos: new Set(), cola: [], encontrados: 0, pedidos: 0, actualizadoEn: '' };
  }
}
let cp = cargarCheckpoint();
let guardando = false;
function guardarCheckpoint() {
  if (guardando) return;
  guardando = true;
  try {
    fs.mkdirSync(DIR_SALIDA, { recursive: true });
    const tmp = CHECKPOINT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      siguiente: cp.siguiente, cubiertos: [...cp.cubiertos], cola: cp.cola,
      encontrados: cp.encontrados, pedidos: cp.pedidos, actualizadoEn: new Date().toISOString(),
    }) + '\n');
    fs.renameSync(tmp, CHECKPOINT);
  } catch (e) { console.warn('[cat] no pude guardar checkpoint:', String(e.message).slice(0, 80)); }
  guardando = false;
}
function rutaBloque(id) {
  const ini = Math.floor(id / BLOQUE) * BLOQUE;
  return path.join(DIR_SALIDA, `bloque-${ini}.json`);
}
function guardarFicha(id, ficha) {
  const archivo = rutaBloque(id);
  let lista = [];
  try { lista = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
  const i = lista.findIndex((x) => x.id === id);
  if (i >= 0) lista[i] = ficha; else lista.push(ficha);
  lista.sort((a, b) => a.id - b.id);
  const tmp = archivo + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista) + '\n');
  fs.renameSync(tmp, archivo);
}

async function pedir(id) {
  const r = await fetch(`${API}?vod_id=${id}&audio_type=es&date=${fechaParam()}`, { headers: cabeceras(), signal: AbortSignal.timeout(15000) });
  if (r.status === 429 || r.status >= 500) { const e = new Error('HTTP ' + r.status); e.reintentable = true; throw e; }
  if (!r.ok) return { miss: true };
  const crudo = dec(await r.text());
  if (!crudo) { const e = new Error('respuesta no descifrable'); e.reintentable = true; throw e; }
  let j; try { j = JSON.parse(crudo); } catch { return { miss: true }; }
  const res = j && j.result;
  if (!res || (!res.vod_name && !res.vod_collection)) return { miss: true };
  return { res };
}
function compacta(id, res) {
  const eps = Array.isArray(res.vod_collection) ? res.vod_collection : [];
  const seasons = Array.isArray(res.series_info) ? res.series_info : [];
  return {
    id,
    nombre: String(res.vod_name || '').slice(0, 160),
    tipo: res.type_name ? String(res.type_name) : (res.type_id != null ? String(res.type_id) : ''),
    anio: res.vod_year ? String(res.vod_year) : '',
    idioma: res.vod_lang ? String(res.vod_lang) : '',
    portada: String(res.vod_pic || ''),
    pianwei: Number(res.pianwei) || 0,
    estado: String(res.remark || ''),
    fin: res.vod_isend ? 1 : 0,
    temporadas: seasons.map((s) => ({ id: Number(s.vod_id || s.id) || 0, nombre: String(s.vod_name || s.title || '').slice(0, 120) })).filter((s) => s.id),
    capitulos: eps.map((e) => [Number(e.id) || 0, Number(e.vod_duration) || 0]).filter((x) => x[0]),
  };
}

let parados = false;
async function obrero(n, estado) {
  while (!parados) {
    let id = 0;
    if (cp.cola.length) id = cp.cola.shift();
    else {
      while (cp.siguiente <= (HASTA_ARG || LÍMITE_SUPERIOR)) {
        const cand = cp.siguiente++;
        if (cand < (DESDE_ARG || 1)) continue;
        if (cp.cubiertos.has(cand)) continue;
        id = cand;
        break;
      }
    }
    if (!id) { parados = true; break; }
    cp.cubiertos.add(id);
    cp.pedidos++;
    let intento = 0, ok = false;
    while (intento < 3 && !ok && !parados) {
      try {
        const { miss, res } = await pedir(id);
        ok = true;
        if (!miss) {
          const ficha = compacta(id, res);
          guardarFicha(id, ficha);
          cp.encontrados++;
          for (const t of ficha.temporadas) if (t.id && t.id !== id && !cp.cubiertos.has(t.id)) cp.cubiertos.add(t.id); /* mismas fichas por temporada: no repetir */
          console.log(`[cat] +${id} "${ficha.nombre}" (${ficha.capitulos.length} caps${ficha.temporadas.length ? ', ' + ficha.temporadas.length + ' temps' : ''}) — van ${cp.encontrados}`);
        }
      } catch (e) {
        intento++;
        const espera = e.reintentable ? 20000 : 3000;
        console.warn(`[cat] id ${id} intento ${intento}: ${String(e.message).slice(0, 70)} — pausa ${espera / 1000}s`);
        await dormir(espera);
      }
    }
    estado.hechos++;
    if (estado.hechos % 200 === 0) {
      const s = (Date.now() - estado.t0) / 1000;
      console.log(`[cat] progreso: id ${id} · ${estado.hechos} pedidos en ${Math.round(s)}s (${(estado.hechos / s).toFixed(1)}/s) · encontrados ${cp.encontrados}`);
      guardarCheckpoint();
    }
    await dormir(PAUSA_MS + Math.floor(Math.random() * 120));
  }
}

(async () => {
  fs.mkdirSync(DIR_SALIDA, { recursive: true });
  console.log(`[cat] rastreador Movie — workers ${WORKERS}, pausa ${PAUSA_MS}ms, desde ${DESDE_ARG || cp.siguiente}, hasta ${HASTA_ARG || LÍMITE_SUPERIOR}`);
  console.log(`[cat] checkpoint: siguiente ${cp.siguiente}, cubiertos ${cp.cubiertos.size}, encontrados ${cp.encontrados}`);
  const estado = { hechos: 0, t0: Date.now() };
  process.on('SIGTERM', () => { parados = true; });
  process.on('SIGINT', () => { parados = true; });
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => obrero(i, estado)));
  guardarCheckpoint();
  const s = (Date.now() - estado.t0) / 1000;
  console.log(`[cat] fin de esta tanda: ${estado.hechos} pedidos en ${Math.round(s)}s · encontrados ${cp.encontrados} · siguiente id ${cp.siguiente}`);
})().catch((e) => { console.error('[cat] fatal:', e); guardarCheckpoint(); process.exit(1); });
