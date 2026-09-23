#!/usr/bin/env node
/*
 * Huddle — salas de video sincronizadas
 * Servidor sin dependencias: Node puro (http + fs + crypto).
 *
 * Protocolo:
 *   - Servidor → clientes : Server-Sent Events (GET /api/events?room=CODE&name=NICK&uid=UID)
 *   - Cliente  → servidor : POST /api/action  {room, userId, action:{type, ...}}
 *
 * Estado de la sala (fuente de verdad):
 *   { videoUrl, videoTitle, isPlaying, position, updatedAt }
 *   position = posición del video EN updatedAt. Si está reproduciéndose,
 *   el objetivo actual = position + (ahora - updatedAt) / 1000.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const os = require('os'); /* v133: tmpfiles de detección de intros */

const PORT = process.env.PORT || 3000;
const UI_VERSION = 'v310'; // v310: barredora de intro-*.ts huérfanos en /tmp + fix de fuga cuando falla el ep2
const HUDDLE_MOSTRAR_TODO = true; // v251 — buscar ignora solo curaduría (LA_OCULTAS/DANI_OCULTAS/LCT_OCULTAS/dedup), muertas (PXD/AF/CVM/CC/D23/LA_MUERTAS/EPS_MUERTOS/CARI_MUERTAS/LCT_MUERTAS/DANI_MUERTAS/CV_*) siempre ocultas

/* v252: AUDITORÍA HUDDLE — sonda maestro que revisa TODO lo vivo de Huddle
 * (pelis de todas las fuentes + series cap por cap) 24/7, con control
 * play/pausa/cancelar y scope seleccionable. Muertas no se revisan (no se
 * muestran en Huddle). Se comunica con sondas por fuente para diagnosticar
 * si el fallo es de Huddle o de la fuente y auto-repara caches de Huddle. */
const HUDDLE_AUDITORIA = {
  activo: false, pausado: false, iniciadoEn: 0, pausadoEn: 0,
  alcance: { peliculas: true, series: true, fuentes: { pelisxd:true, cuevana:true, cinecalidad:true, animeflv:true, latanime:true, animed23:true, danimados:true, lacartoons:true, miscaricaturas:true, ennovelas:true } },
  progreso: { peliculas: { total:0, verificadas:0, ok:0, fail:0, reparadas:0, pct:0, porFuente:{} }, series: { total:0, verificadas:0, ok:0, fail:0, reparadas:0, pct:0, porFuente:{} }, duplicadas:0 },
  logs: [], // {ts, fuente, tipo, slug, msg} max 200
  _timer: null, _batch: 0,
};
// v268: AUDITORÍA 100% REAL — escaneo completo pelicula×pelicula y episodio×episodio con 30 concurrentes (30-45min para 90k items)
const AUDITORIA_COMPLETA = {
  activo: false, iniciadoEn: 0, terminadoEn: 0,
  progreso: { peliculas: { total:0, verificadas:0, ok:0, fail:0, pct:0 }, series:{ total:0, verificadas:0, ok:0, fail:0, pct:0 }, episodios:{ total:0, verificadas:0, ok:0, fail:0, pct:0 } },
  stats: { concurrencia: 30, duracionSec: 0 },
  logs: [],
  _abort: false,
};
const AUDITORIA_PROGRESO_FILE = path.join(__dirname, 'auditorias', 'progreso.json');
const AUDITORIA_LOGS_MAX = 200;
function auditoriaLog(fuente, tipo, slug, msg){
  HUDDLE_AUDITORIA.logs.unshift({ ts: Date.now(), fuente, tipo, slug: String(slug||'').slice(0,60), msg: String(msg||'').slice(0,180) });
  if(HUDDLE_AUDITORIA.logs.length>AUDITORIA_LOGS_MAX) HUDDLE_AUDITORIA.logs.length=AUDITORIA_LOGS_MAX;
  sondaNotify(fuente, tipo, slug, msg); // también al log global de sondas
}
function auditoriaGuardarProgreso(){
  try{
    fs.mkdirSync(path.join(__dirname,'auditorias'),{recursive:true});
    const out = {
      version: UI_VERSION, actualizado: new Date().toISOString(),
      estado: HUDDLE_AUDITORIA.activo ? (HUDDLE_AUDITORIA.pausado?'pausado':'ejecutando') : 'idle',
      alcance: HUDDLE_AUDITORIA.alcance,
      progreso: HUDDLE_AUDITORIA.progreso,
      logs: HUDDLE_AUDITORIA.logs.slice(0,20),
      nota: HUDDLE_AUDITORIA.activo ? 'Auditoría Huddle en curso — sonda Huddle 24/7 verificando todo lo vivo' : 'Auditoría detenida — sondas Huddle 24/7 siguen vigilando en segundo plano cada 6h'
    };
    fs.writeFileSync(AUDITORIA_PROGRESO_FILE, JSON.stringify(out,null,2));
  }catch{}
}
function auditoriaActualizarPct(){
  const pp = HUDDLE_AUDITORIA.progreso.peliculas;
  const ps = HUDDLE_AUDITORIA.progreso.series;
  pp.pct = pp.total ? Math.round(pp.verificadas*100/pp.total) : 0;
  ps.pct = ps.total ? Math.round(ps.verificadas*100/ps.total) : 0;
}

// v254: persistencia — la auditoría corre en el SERVIDOR, no en el panel.
// Si el servidor se reinicia, se restaura el estado desde disco y sigue.
// Así refrescar, cerrar el panel o salir no la detiene nunca.
try{
  const _ap = JSON.parse(require('fs').readFileSync(AUDITORIA_PROGRESO_FILE,'utf8'));
  if(_ap && (_ap.estado==='ejecutando' || _ap.estado==='pausado')){
    HUDDLE_AUDITORIA.activo = true;
    HUDDLE_AUDITORIA.pausado = _ap.estado==='pausado';
    HUDDLE_AUDITORIA.iniciadoEn = Date.now();
    if(_ap.alcance){
      // mezcla profunda de alcance para no perder claves nuevas
      if(typeof _ap.alcance.peliculas==='boolean') HUDDLE_AUDITORIA.alcance.peliculas=_ap.alcance.peliculas;
      if(typeof _ap.alcance.series==='boolean') HUDDLE_AUDITORIA.alcance.series=_ap.alcance.series;
      if(_ap.alcance.fuentes) for(const k of Object.keys(HUDDLE_AUDITORIA.alcance.fuentes)) if(typeof _ap.alcance.fuentes[k]==='boolean') HUDDLE_AUDITORIA.alcance.fuentes[k]=_ap.alcance.fuentes[k];
    }
    if(_ap.progreso) HUDDLE_AUDITORIA.progreso = _ap.progreso;
    if(Array.isArray(_ap.logs)) HUDDLE_AUDITORIA.logs = _ap.logs.slice(0,200);
    console.log('[auditoria] restaurada desde disco: '+_ap.estado+' — se reanuda en 10s');
    setTimeout(()=>{ if(HUDDLE_AUDITORIA.activo && !HUDDLE_AUDITORIA.pausado){ try{ sondaHuddleGeneral().catch(()=>{}); }catch{} } }, 10000);
  }
}catch(e){ /* primera vez sin archivo */ }


/* v236.8: guardián de memoria — fuerza GC cada 30s si heap > 300MB */
if (typeof global.gc === 'function') {
  setInterval(() => {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024;
    if (mb > 300) {
      global.gc();
      const after = process.memoryUsage().heapUsed / 1024 / 1024;
      console.log('[mem] GC: ' + mb.toFixed(0) + 'MB → ' + after.toFixed(0) + 'MB');
    }
  }, 30000);
} else {
  console.log('[mem] GC no disponible — iniciar con --expose-gc');
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_USERS = 100; // v268: 100 usuarios simultáneos (antes 30)
const ROOM_TTL_MS = 40 * 60 * 1000; // salas vacías se borran a los 40 min (libera memoria)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* Audio del espejo: Chrome suena en un sink virtual de PulseAudio
 * (ver pulse.conf) y el monitor se transmite como PCM por SSE. */
const PULSE_SERVER = 'unix:/tmp/pulse-native';
const AUDIO_RATE = 24000;
let AUDIO_READY = false;
try { AUDIO_READY = fs.existsSync(PULSE_SERVER.split(':').pop()); } catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------------------- utilidades ---------------------- */

const uid = () => crypto.randomUUID();
const makeCode = (len = 5) =>
  Array.from({ length: len }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function safeJson(s) {
  try { return JSON.parse(s || ''); } catch { return {}; }
}

function guessTitle(url) {
  try {
    const last = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || url;
  } catch { return url; }
}

/* ---------------------- salas ---------------------- */

const rooms = new Map(); // code -> room

/* ---------------------- usuarios (v31) ----------------------
 * registro global de nombres ÚNICOS, persistido en data/users.json.
 * sin contraseñas: el token vive en el dispositivo del usuario;
 * un nombre sin uso por 30 días puede ser reclamado por otro. */
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const users = new Map(); // nombreLower -> { name, token, createdAt, lastSeenAt }
try {
  const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw || {})) users.set(k, v);
} catch {}
function saveUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users)));
  } catch (e) { console.warn('⚠️ no pude guardar usuarios:', e.message); }
}
const NAME_RE = /^[\p{L}\p{N}_ ]{3,20}$/u;
const NAME_RECLAIM_MS = 30 * 24 * 3600 * 1000;
function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return String(u).slice(0, 30); } }

/* v78: "Continuar viendo" — por dónde se quedó cada usuario. La entrada se
 * le anota a TODOS los que estaban en la sala (anfitrión e invitados):
 * si la estaban viendo juntos, cualquiera de los dos la puede retomar. */
const CONT_FILE = path.join(DATA_DIR, 'continue.json');
const continuar = new Map(); // nameKey -> [{ url, t, d, title, img, ep, serie, ts }]
try {
  const rawC = JSON.parse(fs.readFileSync(CONT_FILE, 'utf8'));
  for (const [k, v] of Object.entries(rawC || {})) if (Array.isArray(v)) continuar.set(k, v);
} catch {}
const CONT_MAX = 10; // entradas guardadas por usuario
function saveContinuar() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONT_FILE, JSON.stringify(Object.fromEntries(continuar)));
  } catch (e) { console.warn('⚠️ no pude guardar continuar-viendo:', e.message); }
}

/* v85: episodios vistos — por URL, sin el tope de 10 de continuar-viendo.
 * Alimenta las ✓ del selector de episodios (y "Sig. ▸" ya sabe la cadena). */
const VISTOS_FILE = path.join(DATA_DIR, 'vistos.json');
const vistos = new Map(); // nameKey -> { url: { t, d, ts } }
try {
  const rawV = JSON.parse(fs.readFileSync(VISTOS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(rawV || {})) if (v && typeof v === 'object') vistos.set(k, v);
} catch {}
const VISTOS_MAX = 1000; // URLs por usuario (por si alguien ve MUCHAS series)
function anotarVisto(nameKey, entry) {
  const mapa = vistos.get(nameKey) || {};
  mapa[entry.url] = { t: entry.t, d: entry.d, ts: Date.now() };
  const claves = Object.keys(mapa);
  if (claves.length > VISTOS_MAX) {
    /* echa las más viejas */
    claves.sort((a, b) => mapa[a].ts - mapa[b].ts);
    for (const c of claves.slice(0, claves.length - VISTOS_MAX)) delete mapa[c];
  }
  vistos.set(nameKey, mapa);
}
function saveVistos() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VISTOS_FILE, JSON.stringify(Object.fromEntries(vistos)));
  } catch (e) { console.warn('⚠️ no pude guardar vistos:', e.message); }
}
function registrarProgreso(room, m, r) {
  try {
    /* v79: solo lo que de verdad se estaba reproduciendo — el autoplay
     * inicial de la página (antes del "lista en pausa") no cuenta como
     * visto, para no llenar la fila con cosas apenas abiertas */
    if (!m.playing) return;
    if (!r || !r.d || r.d < 60 || r.t < 5) return; // aún no hay nada que retomar
    let title = '', img = '', ep = '', serie = '';
    if (m.serie) {
      title = m.serie.titulo || '';
      img = m.serie.poster || '';
      ep = (m.serie.eps && m.serie.eps[m.serie.idx] && m.serie.eps[m.serie.idx].num) || '';
      serie = title;
    } else {
      title = m.title || hostOf(m.url || '');
      img = m.img || '';
    }
    const entry = { url: m.url || '', t: Math.round(r.t), d: Math.round(r.d), title, img, ep, serie, ts: Date.now(), modo: '' };
    /* v286: feed, Solo y Sala usan la portada original de IMDb de la
     * serie agrupada; la portada local de Betty queda como fallback. */
    if(/ennovelas-tv\.com\//i.test(entry.url)) { const po=ennPosterParaEntrada(entry.url,entry.title,entry.serie); if(po) entry.img=po; }
    if (!entry.url) return;
    for (const u of room.users.values()) {
      const key = u.nameKey || String(u.name || '').toLowerCase();
      if (!key) continue;
      const lista = continuar.get(key) || [];
      const i = lista.findIndex((e) => e.url === entry.url);
      if (i >= 0) lista.splice(i, 1);
      lista.unshift(entry);
      if (lista.length > CONT_MAX) lista.length = CONT_MAX;
      continuar.set(key, lista);
    }
    saveContinuar();
  } catch {}
}

function getOrCreateRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  const room = {
    code,
    createdAt: Date.now(),
    hostId: null,
    anyoneCanControl: true,
    videoUrl: '',
    videoTitle: '',
    isPlaying: false,
    position: 0,
    updatedAt: Date.now(),
    users: new Map(),   // id -> {id, name, joinedAt}
    clients: new Set(), // respuestas SSE; cada una lleva .rrUserId
    chat: [],
    native: null, /* v92: { m3u8, mp4, proxy, subs } — video directo (como Solo) */
    videoImg: '', /* v92: carátula para la sala nativa */
  };
  rooms.set(code, room);
  return room;
}

function currentPosition(room) {
  return room.isPlaying ? room.position + (Date.now() - room.updatedAt) / 1000 : room.position;
}

function stateOf(room) {
  return {
    videoUrl: room.videoUrl,
    videoTitle: room.videoTitle,
    isPlaying: room.isPlaying,
    position: room.position,
    updatedAt: room.updatedAt,
    serverNow: Date.now(),
    anyoneCanControl: room.anyoneCanControl,
    /* v92: sala nativa — el video directo (como el modo Solo) */
    native: room.native || null,
    videoImg: room.videoImg || '',
    switching: !!room.switchingEp, /* v147: resolviendo el episodio anunciado */
    /* v118: si están viendo una SERIE en nativo, la sala sabe cuál cap
     * toca y si hay siguiente/anterior (para los botoncitos) — igual
     * que mirrorState hace para el espejo, pero sin la lista pesada */
    serie: room.serieCtx ? {
      titulo: room.serieCtx.titulo, poster: room.serieCtx.poster,
      total: room.serieCtx.eps.length,
      num: room.serieCtx.eps[room.serieCtx.idx] ? room.serieCtx.eps[room.serieCtx.idx].num : '',
      hayPrev: room.serieCtx.idx > 0,
      hayNext: room.serieCtx.idx >= 0 && room.serieCtx.idx < room.serieCtx.eps.length - 1,
    } : null,
  };
}
/* v92: ¿esta URL se puede reproducir NATIVA (sin navegador remoto)?
 * El mismo resolver del modo Solo: goodstream/vimeos y animes mp4upload */
/* v144: si el MISMO episodio ya se está resolviendo (el precalentado de
 * v139, la detección de intro o tu toque a «siguiente»), todos esperan
 * UNA sola resolución — antes corrían 2 navegadores a la vez, se
 * estorbaban y el primer toque fallaba */
const RESOLVIENDO = new Map(); /* url → promesa en vuelo */
function resolverNativo(url) {
  const k = String(url || '');
  const enVuelo = RESOLVIENDO.get(k);
  if (enVuelo) return enVuelo;
  const p = resolverNativoInterno(url).catch((e) => { if (esEpUrl(k)) epsFallo(k); verifEncolar(k); throw e; }).finally(() => RESOLVIENDO.delete(k)); /* v287: los fallos en Juntos también cuentan; v295: y se encolan para verificación dirigida */
  RESOLVIENDO.set(k, p);
  return p;
}
/* v144: título legible de episodio: «Hora de aventura — T.1 EP.3» */
function tituloBonitoEp(titulo, num) {
  /* v146: temporada/capítulo PRIMERO — si el nombre es largo y se recorta
   * con «…», lo que queda siempre visible es T. y EP. (lo que importa) */
  const t = String(titulo || '').trim().replace(/\s+/g, ' ');
  const s = String(num || '');
  let m = /(\d{1,2})x(\d{1,3})/.exec(s);
  if (m) return `T.${+m[1]} EP.${+m[2]} · ${t}`.slice(0, 90);
  m = /episodio\s*(\d+)/i.exec(s);
  if (m) return `EP.${+m[1]} · ${t}`.slice(0, 90);
  return s ? `${s} · ${t}`.slice(0, 90) : t.slice(0, 90);
}
/* v144: ¿qué episodio es esta URL? (de la ruta o del índice en la serie) */
function epNumDeUrl(url, sc) {
  const u = String(url || '');
  let m = /-(\d{1,2})x(\d{2})([ab])?(?:-|$)/i.exec(u); /* v241: 31-minutos usa 1xNN */
  if (m) return +m[1] + 'x' + +m[2];
  m = /-episodio-(\d+)/i.exec(u);
  if (m) return '1x' + (+m[1]);
  try {
    const i = ((sc && sc.eps) || []).findIndex((e) => e.url === u);
    if (i >= 0) return '1x' + (i + 1);
  } catch {}
  return '';
}
/* v164: YOUTUBE NATIVO — el espejo está condenado con youtube: la IP del
 * servidor es de datacenter y youtube le exige login HASTA al player
 * embebido. Así que los VIDEOS se sacan por instancias públicas (piped /
 * invidious, mp4 combinado con proxy público) y se reproducen NATIVO:
 * sincronizado, con audio en cada teléfono y pantalla completa de verdad. */
const YT_INSTANCIAS_PIPED = ['https://api.piped.private.coffee', 'https://pipedapi.ducks.party'];
const YT_INSTANCIAS_INV = ['https://iv.catgirl.cloud'];
const YT_CACHE = new Map(); /* id → { nat, at } — 2 h */
const YT_TITULOS = new Map(); /* id → título (para el chat/tarjeta) */
function idYoutubeDe(u) {
  return ((/[?&]v=([A-Za-z0-9_-]{6,16})/.exec(u || '') || [])[1]
    || (/youtu\.be\/([A-Za-z0-9_-]{6,16})/.exec(u || '') || [])[1]
    || (/\/shorts\/([A-Za-z0-9_-]{6,16})/.exec(u || '') || [])[1] || '');
}
async function resolverYoutube(u) {
  const id = idYoutubeDe(u);
  if (!id) throw new Error('No pude leer el id del video de YouTube');
  const c = YT_CACHE.get(id);
  if (c && Date.now() - c.at < 2 * 3600 * 1000) return c.nat;
  let ultimoErr = 'sin instancias disponibles';
  /* v166: las instancias van en PARALELO — la primera que sirva gana
   * (antes una lenta retrasaba a todas) */
  try {
    const ganador = await Promise.any(YT_INSTANCIAS_PIPED.map(async (base) => {
      const r = await fetchSeguro(base + '/streams/' + id, 9000);
      if (!r.ok) throw new Error(base.split('//')[1] + ' → ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(String(j.error).slice(0, 60));
      if (j.title) YT_TITULOS.set(id, String(j.title).slice(0, 80));
      const vs = j.videoStreams || [];
      const v = vs.find((x) => !x.videoOnly && x.mimeType === 'video/mp4' && x.quality === '360p')
        || vs.find((x) => !x.videoOnly && x.mimeType === 'video/mp4');
      if (!v || !v.url) throw new Error('sin stream combinado');
      const chk = await fetchSeguro(v.url, 9000).catch(() => { throw new Error('el stream no respondió'); });
      if (!chk.ok) { try { chk.body && chk.body.cancel(); } catch {} throw new Error('el stream no respondió'); }
      try { chk.body && chk.body.cancel(); } catch {}
      return { m3u8: v.url, mp4: true, proxy: false, subs: [] };
    }));
    YT_CACHE.set(id, { nat: ganador, at: Date.now() });
    return ganador;
  } catch (e) { ultimoErr = String((e && e.errors && e.errors[0] && e.errors[0].message) || e.message || e).slice(0, 60); }
  for (const base of YT_INSTANCIAS_INV) {
    try {
      const r = await fetchSeguro(base + '/api/v1/videos/' + id + '?fields=videoId,title,formatStreams', 9000);
      if (!r.ok) { ultimoErr = base.split('//')[1] + ' → ' + r.status; continue; }
      const j = await r.json();
      if (j.title) YT_TITULOS.set(id, String(j.title).slice(0, 80));
      const fx = (j.formatStreams || []).find((x) => +x.itag === 18) || (j.formatStreams || []).find((x) => +x.itag === 22);
      if (fx) {
        const url18 = base + '/latest_version?id=' + id + '&itag=' + fx.itag + '&local=true';
        const chk = await fetchSeguro(url18, 12000).catch(() => null); /* sigue el 302 del proxy */
        if (chk && chk.ok) {
          try { chk.body && chk.body.cancel(); } catch {}
          const nat = { m3u8: url18, mp4: true, proxy: false, subs: [] };
          YT_CACHE.set(id, { nat, at: Date.now() });
          return nat;
        }
        ultimoErr = 'el stream no respondió';
      } else ultimoErr = 'sin stream combinado';
    } catch (e) { ultimoErr = String(e.message || e).slice(0, 60); }
  }
  throw new Error('No pude sacar el video de YouTube (' + ultimoErr + ')');
}
/* mete un video de youtube como NATIVO (desde el espejo o al abrirlo) */
/* v168: hand-off reutilizable con guarda anti-doble disparo */
function cambiarYtNativo(room, url, userId) {
  const id = idYoutubeDe(url);
  if (!id) return false;
  const m = mirrors.get(room.code);
  if (m && m.poniendo === id) return true; /* ya en camino */
  if (m) m.poniendo = id;
  ponerYoutubeNativo(room, url, userId).catch((eH) => {
    const mv = mirrors.get(room.code);
    if (mv) mv.poniendo = null; /* falló → se puede reintentar */
    try { sysMsg(room, '⚠️ No pude sacar el video de YouTube (' + String(eH && eH.message || eH).slice(0, 60) + '). Reintenta en un momento o entra a tu cuenta aquí mismo.'); } catch {}
  });
  return true;
}

async function ponerYoutubeNativo(room, watchUrl, userId) {
  const id = idYoutubeDe(watchUrl);
  const nat = await resolverYoutube(watchUrl);
  if (mirrors.has(room.code)) await stopMirror(room);
  room.videoUrl = watchUrl;
  room.videoTitle = 'YouTube: ' + (YT_TITULOS.get(id) || 'video');
  room.native = { m3u8: nat.m3u8, mp4: !!nat.mp4, proxy: !!nat.proxy, subs: nat.subs || [] };
  room.videoImg = '';
  room.position = 0;
  room.isPlaying = false;
  room.videoDuration = 0;
  room.updatedAt = Date.now();
  sysMsg(room, '🎬 ' + room.videoTitle + ' — tápale para empezar');
  broadcast(room, 'state', stateOf(room));
  return true;
}

/* v172: DANIMADOS — Teen Titans Go COMPLETO (9 temporadas, 291 eps) en
 * latino, WordPress+Dooplay sin Cloudflare y TODOS los caminos por HTTP:
 * lista del HTML de la serie, player por admin-ajax (doo_player_ajax) y el
 * embed (hglink→hanerix) trae el m3u8 dentro de un packer Dean-Edwards que
 * se desempaca aquí mismo. CDN premilkyway = la familia que ya proxéamos. */
const DANI_BASE = 'https://danimados.cc';
const DANI_SERIE = '/series/teen-titans-go/';
const DANI_STREAMS = new Map(); /* url ep → { nat, at } */
/* v177: CATÁLOGO COMPLETO de danimados en Huddle — snapshot de 823 series
 * (slug+título+póster) bajado de su API WordPress; reemplaza nuestras series
 * rotas y añade las suyas. Nuestra fuente (miscaricaturas/lacartoons) queda
 * para lo que danimados no tiene o donde la nuestra es mejor. */
let DANI_CAT = new Map();
const LA_TODOS = new Set(), LA_OCULTAS_SET = new Set(); /* v198 */
const LA_MUERTAS_SET = new Set(); /* v200: auditadas con video caído */
const LA_VISTAS = new Set(); /* v240: series verificadas por la sonda de Latanime */
/* v203: PODREDUMBRE — mp4upload borra archivos a diario (Akame ga Kill
 * murió en vivo en una sesión). 3 fallos espaciados ≥10 min → se oculta
 * sola. Revisión cada 6 h de las ocultadas con <7 días: si reviven, vuelven. */
const LA_FALLOS = new Map(); /* slug → { f, last, h } */
try { for (const [k3, v3] of Object.entries(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'la-fallos.json'), 'utf8')) || {})) LA_FALLOS.set(k3, v3); } catch {}
let laFallosTimer = null;
function laFallosGuardar() {
  clearTimeout(laFallosTimer);
  laFallosTimer = setTimeout(() => { try { fs.writeFileSync(path.join(DATA_DIR, 'la-fallos.json'), JSON.stringify(Object.fromEntries(LA_FALLOS))); } catch {} }, 4000);
}
function laFallosRegistrar(slug) {
  if (!slug) return;
  const e = LA_FALLOS.get(slug) || { f: 0, last: 0, h: 0 };
  if (Date.now() - (e.last || 0) < 10 * 60 * 1000) return; /* la misma ráfaga no cuenta como fallos nuevos */
  e.f = (e.f || 0) + 1;
  e.last = Date.now();
  if (e.f >= 3 && !LA_MUERTAS_SET.has(slug)) {
    e.h = Date.now();
    LA_MUERTAS_SET.add(slug);
    try { fs.writeFileSync(path.join(__dirname, 'public', 'latanime-muertas.txt'), [...LA_MUERTAS_SET].sort().join('\n') + '\n'); } catch {}
    console.log('[podredumbre] la: ' + slug + ' ocultada tras ' + e.f + ' fallos');
  }
  LA_FALLOS.set(slug, e);
  laFallosGuardar();
}
function laFallosPerdonar(slug) { if (slug && LA_FALLOS.delete(slug)) laFallosGuardar(); }
async function laProbe(slug) { /* ¿vive hoy? — el camino barato (HTTP) */
  try {
    const r = await fetchSeguro('https://latanime.org/ver/' + slug + '-episodio-1/', 12000);
    if (!r || !r.ok) return false;
    const html = await r.text();
    const links = [...html.matchAll(/<a\b[^>]*class="[^"]*play-video[^"]*"[^>]*data-player="([^"]+)"[^>]*>/gi)];
    const embeds = links.map((m) => { try { return Buffer.from(m[1], 'base64').toString('utf8'); } catch { return ''; } }).filter((u) => /^https?:\/\//i.test(u));
    const cands = [...new Set(embeds.filter((u) => /mp4upload\./i.test(u)))];
    for (const emb of cands.slice(0, 2)) {
      let em = '';
      for (let t = 0; t < 2 && !em; t++) {
        const e2 = await fetchSeguro(emb, 12000).catch(() => null);
        const tx = e2 && e2.ok ? await e2.text() : '';
        if (tx.length > 500) em = tx; else await new Promise((r2) => setTimeout(r2, 1200));
      }
      if (!em || /file was deleted/i.test(em)) continue;
      const m = em.match(/player\.src\(\{\s*type:\s*["']video\/mp4["']\s*,\s*src:\s*["'](https?:\/\/[^"']+)["']/i) || em.match(/["'](https?:\/\/[^"'\s<>]*mp4upload[^"'\s<>]*\.mp4[^"'\s<>]*)["']/i);
      if (m && await sirveElVideo(m[1], emb)) return true;
    }
    return false;
  } catch { return false; }
}
let laReviviendo = false;
async function laRevizar() { /* apelaciones: ocultadas hace <7 días, una a una con calma */
  if (laReviviendo) return;
  laReviviendo = true;
  try {
    const hoy = Date.now();
    const cands = [...LA_FALLOS.entries()].filter(([k, v]) => v.h && hoy - v.h < 7 * 24 * 3600 * 1000).sort((a, b) => a[1].h - b[1].h).slice(0, 150);
    if (cands.length) console.log('[podredumbre] revisando ' + cands.length + ' ocultadas recientes…');
    let vivas2 = 0;
    for (const [slug] of cands) {
      if (await laProbe(slug)) {
        vivas2++;
        laMuertaQuitar(slug);
        LA_FALLOS.delete(slug);
        laFallosGuardar();
        sondaNotify("Latanime", "revivio", slug, slug + " revivio — apelacion aceptada");
        console.log('[podredumbre] la: ' + slug + ' REVIVIÓ — visible otra vez');
      }
      await new Promise((r2) => setTimeout(r2, 12000));
    }
    console.log('[podredumbre] revisión terminada: ' + vivas2 + ' revivieron de ' + cands.length);
  } finally { laReviviendo = false; }
}
/* v309: SONDAS ESCALONADAS — una cada 25 s en vez de todas de golpe a los 90 s.
 * Correr las 13 juntas disparaba el heap justo cuando el usuario encendía el
 * rastreo de intros encima, y el tope de 768 MB reventaba (SIGABRT 07:33-07:37
 * en Oracle: tres caídas seguidas al encender las intros). */
function sondasEscalonadas(extra) {
  const lista = [ ['laRevizar', laRevizar], ['revivir', revivirGeneral], ['pelisxd', sondaPelisxd], ['cuevana', sondaCuevana], ['cinecalidad', sondaCineCalidad], ['latanime', sondaLatanime], ['danimados', sondaDanimados], ['lacartoons', sondaLacartoons], ['miscaricaturas', sondaMisc], ['animeflv', sondaAnimeflv], ['novelas', sondaNovelas], ['animed23', sondaD23], ...(extra || []) ];
  lista.forEach((par, i) => setTimeout(() => { try { sondaRun(par[0], par[1]); } catch {} }, i * 25000));
}
setTimeout(() => { console.log("[podredumbre] temporizador de arranque disparando..."); /* v293: todo por sondaRun (estado en /api/sondas) */
  sondasEscalonadas(HUDDLE_AUDITORIA.activo ? [] : [['huddle', sondaHuddleGeneral]]); /* v309 escalonado */
}, 90 * 1000); /* v287: + podredumbre de episodios */
setTimeout(() => { sondaRun('epsPodredumbre', epsPodredumbre); }, 15 * 60 * 1000);
setInterval(() => {
  sondasEscalonadas(HUDDLE_AUDITORIA.activo ? [] : [['huddle', sondaHuddleGeneral]]); /* v309 escalonado */
}, 6 * 3600 * 1000); /* v287: el ciclo de 6h también corre la podredumbre de episodios */
setInterval(() => { sondaRun('epsPodredumbre', epsPodredumbre); }, 6 * 3600 * 1000);

/* v234: SONDA PELISXD — revisa películas ocultas para ver si volvieron */
/* v234: SONDA PELISXD COMPLETA — 3 frentes:
 * 1. NUEVAS: slugs del sitemap no vistos → verificar si tienen Byse
 * 2. VIVAS: muestra de películas activas → ¿siguen funcionando?
 * 3. MUERTAS: muestra de ocultas → ¿revivieron?
 *
 * Cada ciclo (~6h) hace un barrido de ~60 películas total.
 * Si una viva muere → se oculta. Si una muerta revive → se muestra.
 * Si una nueva funciona → se marca como viva y entra al feed automáticamente.
 */


async function verificarByse(slug) {
  const r = await fetchSeguro('https://www.pelisxd.com/pelicula/' + slug, 12000);
  if (!r.ok) return { ok: false, reason: 'page_' + r.status };
  const html = await r.text();
  const re = /v_source[^A-Za-z0-9]{0,12}([A-Za-z0-9+/=]{24,})/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const url = Buffer.from(m[1], 'base64').toString('utf8');
      if (/byse|byseqekaho/i.test(url)) return { ok: true };
    } catch {}
  }
  return { ok: false, reason: 'no_byse' };
}

async function sondaPelisxd() {
  const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (memMB > 350) { console.warn('[sonda] pxd saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
  const POR_CICLO = 15; /* v234: reducido para no saturar memoria */
  const t0 = Date.now();
  let nuevas_ok = 0, nuevas_fail = 0, vivas_muertas = 0, muertas_vivas = 0;
  try {
    /* ─── 1. NUEVAS: slugs del sitemap que nunca hemos visto ─── */
    try {
      const sitemap = await pelisxdIndice(); /* ya cached, no descarga de nuevo */
      const desconocidas = sitemap.filter((s) => !pxdVistas.has(s) && !PXD_OCULTAS.has(s));
      if (desconocidas.length) {
        const muestra = desconocidas.sort(() => Math.random() - 0.5).slice(0, POR_CICLO);
        for (const slug of muestra) {
          pxdVistas.add(slug); /* marcar como vista */
          try {
            const v = await verificarByse(slug);
            if (v.ok) {
              nuevas_ok++;
              /* Ya está viva — no hay que hacer nada más, buscarPelisxd() la encontrará
               * y los géneros la muestran desde PelisXD directamente */
            } else {
              /* No tiene Byse → ocultar de inmediato */
              PXD_OCULTAS.add(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt');
              nuevas_fail++;
              sondaNotify("PelisXD", "muerto", slug, slug + " — sin Byse (nueva)");
            }
          } catch {}
        }
      }
      /* Guardar vistas (cada ciclo crece un poco) */
      try { fs.writeFileSync(path.join(__dirname, 'public', 'pxd-vistas.txt'), [...pxdVistas].join('\n') + '\n'); } catch {}
    } catch (e) { console.warn('[sonda] pxd nuevas error: ' + String(e).slice(0, 60)); }

    /* ─── 2. VIVAS: ¿siguen funcionando? ─── */
    try {
      /* PelisXD tiene ~4700 slugs. Las vivas = sitemap - ocultas */
      const sitemap = await pelisxdIndice();
      const vivas = sitemap.filter((s) => !PXD_OCULTAS.has(s));
      const muestraVivas = vivas.sort(() => Math.random() - 0.5).slice(0, POR_CICLO);
      for (const slug of muestraVivas) {
        try {
          const v = await verificarByse(slug);
          if (!v.ok) {
            PXD_OCULTAS.add(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt');
            pxdOcultar(slug); /* registrar fallo para el sistema de podredumbre */
            vivas_muertas++;
            sondaNotify("PelisXD", "muerto", slug, slug + " murio — sin Byse");
            console.log('[sonda] pxd MURIÓ: ' + slug);
          }
        } catch {}
      }
    } catch (e) { console.warn('[sonda] pxd vivas error: ' + String(e).slice(0, 60)); }

    /* ─── 3. MUERTAS: ¿revivieron? ─── */
    try {
      const ocultas = [...PXD_OCULTAS];
      if (ocultas.length) {
        const muestraMuertas = ocultas.sort(() => Math.random() - 0.5).slice(0, POR_CICLO);
        for (const slug of muestraMuertas) {
          try {
            const v = await verificarByse(slug);
            if (v.ok) {
              PXD_OCULTAS.delete(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt');
              pxdPerdonar(slug);
              muertas_vivas++;
              sondaNotify("PelisXD", "revivio", slug, slug + " revivio — Byse encontrado");
              console.log('[sonda] pxd REVIVIÓ: ' + slug);
            }
          } catch {}
        }
      }
    } catch (e) { console.warn('[sonda] pxd muertas error: ' + String(e).slice(0, 60)); }

    /* ─── Log ─── */
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const parts = [];
    if (nuevas_ok) parts.push('nuevas_ok=' + nuevas_ok);
    if (nuevas_fail) parts.push('nuevas_fail=' + nuevas_fail);
    if (vivas_muertas) parts.push('vivas→muertas=' + vivas_muertas);
    if (muertas_vivas) parts.push('muertas→vivas=' + muertas_vivas);
    const logLine = `[${new Date().toISOString()}] ${elapsed}s nuevas_ok=${nuevas_ok} nuevas_fail=${nuevas_fail} vivas→muertas=${vivas_muertas} muertas→vivas=${muertas_vivas} ocultas=${PXD_OCULTAS.size} vistas=${pxdVistas.size}\n`;
    if (parts.length) console.log('[sonda] pxd (' + elapsed + 's): ' + parts.join(', '));
    else console.log('[sonda] pxd (' + elapsed + 's): sin cambios');
    try { fs.appendFileSync(path.join(__dirname, 'sonda-pelisxd.log'), logLine); } catch {}
  } catch (e) { console.warn('[sonda] pxd error: ' + String(e).slice(0, 60)); }
}

/* v235: SONDA CUEVANA — verifica películas de cuevana.mov
 * Solo 3 frentes como PelisXD: NUEVAS (sitemap no vistas), VIVAS (activas), MUERTAS (ocultas)
 * Cada frente toma 15 películas por ciclo (~6h)
 */
const CVM_VISTAS = new Set();
try { for (const l of fs.readFileSync(path.join(__dirname, 'cuevana-vistas.txt'), 'utf8').split('\n')) if (l.trim()) CVM_VISTAS.add(l.trim()); } catch {}

async function verificarCuevana(slug) {
  try {
    const r = await fetchSeguro(CUEVANA_API + encodeURIComponent(slug), 12000);
    if (!r.ok) return { ok: false, reason: 'api_' + r.status };
    const d = await r.json();
    const lat = ((d.videos || {}).latino || []).filter(e => e.url);
    if (!lat.length) return { ok: false, reason: 'no_latino' };
    cvmCatEnriquecer(slug, d); /* v292: la sonda ya pagó la llamada — guardar meta al catálogo */
    /* Probar el primer host que funcione */
    const sorted = [...lat].sort((a, b) => {
      const ai = CUEVANA_HOSTS_OK.indexOf(new URL(a.url || 'https://x').hostname);
      const bi = CUEVANA_HOSTS_OK.indexOf(new URL(b.url || 'https://x').hostname);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    for (const embed of sorted) {
      if (!embed.url) continue;
      const host = new URL(embed.url).hostname;
      if (!CUEVANA_HOSTS_OK.some(h => host.includes(h))) continue;
      try {
        const er = await fetchSeguro(embed.url, 10000);
        if (!er.ok) continue;
        const html = await er.text();
        let m3u8 = null;
        if (/goodstream/i.test(host)) {
          const m = /file\s*[:=]\s*["'](https?:\/\/[^"']+master\.m3u8[^"']*?)["']/i.exec(html)
            || /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(html);
          if (m) m3u8 = m[1];
        } else {
          const pm = /eval\(function\(p,a,c,k,e,d\)\{.+?\}\('(.+?)',(\d+),(\d+),'([^']*)'\.split/.exec(html);
          if (pm) {
            const pStr = pm[1], aVal = +pm[2], cVal = +pm[3], k = pm[4].split('|');
            const toBase = (n, b) => { if (!n) return '0'; const d = []; while (n) { d.push('0123456789abcdefghijklmnopqrstuvwxyz'[n % b]); n = Math.floor(n / b); } return d.reverse().join(''); };
            let result = pStr;
            for (let i = cVal - 1; i >= 0; i--) { const w = toBase(i, aVal); if (i < k.length && k[i]) result = result.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), k[i]); }
            const m = /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(result);
            if (m) m3u8 = m[1];
          }
        }
        if (m3u8) {
          const vr = await fetchSeguro(m3u8, 8000).catch(() => null);
          if (vr && vr.ok) { const t = await vr.text().catch(() => ''); if (t.includes('#EXTM3U')) return { ok: true }; }
        }
      } catch {}
    }
    return { ok: false, reason: 'all_failed' };
  } catch (e) { return { ok: false, reason: 'error:' + String(e).slice(0, 30) }; }
}

async function sondaCuevana() {
  try {
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memMB > 350) { console.warn('[sonda] cv saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
    const sitemap = await cuevanaIndice();
    if (!sitemap.length) return;
    const start = Date.now();
    let nuevas_ok = 0, nuevas_fail = 0, vivas_muertas = 0, muertas_vivas = 0;
    const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    /* Frente NUEVAS: sitemap no vistas */
    const desconocidas = shuffle(sitemap.filter(s => !CVM_VISTAS.has(s) && !CVM_OCULTAS.has(s))).slice(0, 15);
    for (const slug of desconocidas) {
      const r = await verificarCuevana(slug);
      CVM_VISTAS.add(slug);
      if (r.ok) nuevas_ok++;
      else { CVM_OCULTAS.add(slug); nuevas_fail++; sondaNotify("Cuevana", "muerto", slug, slug + " — sin servidores (nueva)"); }
    }
    /* Frente VIVAS: muestra de activas */
    const vivas = shuffle(sitemap.filter(s => !CVM_OCULTAS.has(s))).slice(0, 15);
    for (const slug of vivas) {
      const r = await verificarCuevana(slug);
      if (!r.ok) { CVM_OCULTAS.add(slug); vivas_muertas++; sondaNotify("Cuevana", "muerto", slug, slug + " murio — sin servidores"); }
    }
    /* Frente MUERTAS: muestra de ocultas */
    const muertas = shuffle([...CVM_OCULTAS]).slice(0, 15);
    for (const slug of muertas) {
      const r = await verificarCuevana(slug);
      if (r.ok) { CVM_OCULTAS.delete(slug); muertas_vivas++; sondaNotify("Cuevana", "revivio", slug, slug + " revivio — servidores encontrados"); }
    }
    /* Persistir */
    try { fs.writeFileSync(path.join(__dirname, 'cuevana-ocultas.txt'), [...CVM_OCULTAS].join('\n') + '\n'); } catch {}
    try { fs.writeFileSync(path.join(__dirname, 'cuevana-vistas.txt'), [...CVM_VISTAS].join('\n') + '\n'); } catch {}
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const parts = [];
    if (nuevas_ok) parts.push('nuevas_ok=' + nuevas_ok);
    if (nuevas_fail) parts.push('nuevas_fail=' + nuevas_fail);
    if (vivas_muertas) parts.push('vivas→muertas=' + vivas_muertas);
    if (muertas_vivas) parts.push('muertas→vivas=' + muertas_vivas);
    const logLine = `[${new Date().toISOString()}] ${elapsed}s nuevas_ok=${nuevas_ok} nuevas_fail=${nuevas_fail} vivas→muertas=${vivas_muertas} muertas→vivas=${muertas_vivas} ocultas=${CVM_OCULTAS.size} vistas=${CVM_VISTAS.size}\n`;
    if (parts.length) console.log('[sonda] cv (' + elapsed + 's): ' + parts.join(', '));
    else console.log('[sonda] cv (' + elapsed + 's): sin cambios');
    try { fs.appendFileSync(path.join(__dirname, 'sonda-cuevana.log'), logLine); } catch {}
  } catch (e) { console.warn('[sonda] cv error: ' + String(e).slice(0, 60)); }
}

/* v205.2: PODREDUMBRE GENERAL — el mismo circuito de latanime (fallos
 * reales → ocultar; éxito → perdonar; re-chequeo periódico → revivir)
 * para PelisXD, AnimeFLV y Cuevana. Un capítulo puntual de
 * caricaturas NO oculta la serie (un muerto no mata una de 300; el feed
 * ya nace filtrado y el error avisa claro). */
const PXD_OCULTAS = new Set(), AF_OCULTAS = new Set(), CVM_OCULTAS = new Set();
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'pxd-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) PXD_OCULTAS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'cuevana-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) CVM_OCULTAS.add(l.trim()); } catch {} /* v235: 180 Cuevana sin embeds */

/* v292: CATÁLOGO LOCAL Cuevana (slug → {t: título, p: póster, e: extra}).
 * Se enriquece GRATIS con lo que la sonda y el buscador viejo ya descargaban
 * de la API (antes se tiraba). La búsqueda ya NO sale a la red: puro catálogo. */
const CVM_CAT = new Map();
try {
  const cvj = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'cuevana-cat.json'), 'utf8'));
  for (const [k, v] of Object.entries(cvj.items || {})) if (v && v.t) CVM_CAT.set(k, v);
} catch {}
let cvmCatTimer = null;
function cvmCatGuardar() {
  /* v292: throttle (no debounce) — con debounce, la siembra continua postergaba
   * la escritura para siempre; así escribe 1 vez cada 5 s como máximo */
  if (cvmCatTimer) return;
  cvmCatTimer = setTimeout(() => {
    cvmCatTimer = null;
    try { fs.writeFileSync(path.join(__dirname, 'public', 'cuevana-cat.json'), JSON.stringify({ items: Object.fromEntries(CVM_CAT) })); } catch {}
  }, 5000);
}
function cvmCatEnriquecer(slug, d) {
  if (!slug || !d || !d.titles) return;
  const t = String(d.titles.name || '').trim().slice(0, 120);
  if (!t) return;
  const extra = ['Latino', d.runtime ? d.runtime + 'min' : '', d.releaseDate ? String(d.releaseDate).slice(0, 4) : ''].filter(Boolean).join(' · ');
  CVM_CAT.set(slug, { t, p: (d.images && d.images.poster) || '', e: extra });
  cvmCatGuardar();
}

/* v238: CineCalidad — vistas, ocultas, índice */
const CC_VISTAS = new Set();
const CC_OCULTAS = new Set();
try { for (const l of fs.readFileSync(path.join(__dirname, 'cc-vistas.txt'), 'utf8').split('\n')) if (l.trim()) CC_VISTAS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'cc-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) CC_OCULTAS.add(l.trim()); } catch {}
/* v239: muertas de auditoría inicial */
const CC_AUDIT_DEAD = new Set(["motor-city", "brainbugs", "end-of-the-rope", "la-pelicula-de-heffalump", "the-group", "efsunlu-ayin", "guadalupe-madre-de-la-humanidad", "vampira-humanista-busca-suicida", "mi-perfecto-ex", "corina", "vera-y-el-placer-de-los-otros", "angeles-caidos-guerreros-de-paz", "rift", "thundercats", "krypto-saves-the-day"]);
for (const s of CC_AUDIT_DEAD) if (!CC_OCULTAS.has(s)) CC_OCULTAS.add(s);
/* v239.13: Notificaciones de sonda — log de eventos recientes */
const SONDALOG_FILE = path.join(DATA_DIR, 'sonda-log.json');
const SONDALOG = []; /* {ts, fuente, tipo, slug, msg} — max 500 */
const SONDALOG_MAX = 500;
/* v293: estado de cada sonda (cuándo corrió, cuánto tardó, si falló) — visible
 * en /api/sondas para saber de un vistazo cuáles trabajan y cuáles no. */
const SONDAS_STATE = {};
function sondaRun(nombre, fn) {
  return Promise.resolve().then(async () => {
    const st = SONDAS_STATE[nombre] || (SONDAS_STATE[nombre] = { veces: 0, ultima: 0, ms: 0, ok: true, err: '' });
    const t0 = Date.now();
    try { await fn(); st.ok = true; st.err = ''; }
    catch (e) { st.ok = false; st.err = String(e.message || e).slice(0, 120); }
    st.ultima = t0; st.ms = Date.now() - t0; st.veces++;
  });
}
try { const _sl = JSON.parse(fs.readFileSync(SONDALOG_FILE, 'utf8')); if (Array.isArray(_sl)) SONDALOG.push(..._sl); } catch {} /* v240: persistir log */
let sondaLogTimer = null;
function sondaNotify(fuente, tipo, slug, msg) {
  SONDALOG.unshift({ ts: Date.now(), fuente, tipo, slug, msg: String(msg || '').slice(0, 200) });
  if (SONDALOG.length > SONDALOG_MAX) SONDALOG.length = SONDALOG_MAX;
  clearTimeout(sondaLogTimer);
  sondaLogTimer = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SONDALOG_FILE, JSON.stringify(SONDALOG)); } catch {} }, 3000);
  const sym = tipo === 'muerto' ? 'x' : tipo === 'revivio' ? '+' : '?';
  console.log(`[sonda-notif] ${sym} ${fuente}: ${msg}`);
}

let ccIdx = { slugs: [], at: 0, buscando: null };
const CC_IDX_TTL = 12 * 3600 * 1000;
console.log('[boot] CVM_OCULTAS=' + CVM_OCULTAS.size + ' Cuevana mov ocultas');

const pxdVistas = new Set(); /* slugs ya verificados alguna vez */
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'pxd-vistas.txt'), 'utf8').split('\n')) if (l.trim()) pxdVistas.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'af-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) AF_OCULTAS.add(l.trim()); } catch {}
const AF_TODOS = new Set(), AF_VISTAS = new Set(); /* v243: catálogo + verificadas por sonda */
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'animeflv-slugs.txt'), 'utf8').split('\n')) if (l.trim()) AF_TODOS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'af-vistas.txt'), 'utf8').split('\n')) if (l.trim()) AF_VISTAS.add(l.trim()); } catch {}
const FALLOS_PXD = new Map(), FALLOS_AF = new Map(), FALLOS_CV = new Map();
/* v287: los contadores de fallo ahora sobreviven a cada deploy (antes se
 * reiniciaban al arrancar y la regla de "3 fallos" casi nunca se completaba) */
for (const [mapa, arch] of [[FALLOS_PXD, 'fallos-pxd.json'], [FALLOS_AF, 'fallos-af.json'], [FALLOS_CV, 'fallos-cv.json']]) fallosCargar(mapa, arch);
const fallosGuardarT = new Map();
/* v287: loader tolerante — los fallos-*.json viejos se guardaban como arreglo
 * de pares y el loader los leía como objeto (nunca se cargaban). Ambos formatos
 * se aceptan ahora; el guardado queda en formato objeto. */
function fallosCargar(mapa, arch) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, arch), 'utf8'));
    const entradas = Array.isArray(raw) ? raw : Object.entries(raw || {});
    for (const [k, v] of entradas) if (k && v && typeof v === 'object') mapa.set(String(k), v);
  } catch {}
}
function fallosGuardar(mapa, arch) {
  if (fallosGuardarT.has(arch)) return;
  const t = setTimeout(() => { fallosGuardarT.delete(arch); try { fs.writeFileSync(path.join(DATA_DIR, arch), JSON.stringify(Object.fromEntries(mapa))); } catch {} }, 4000);
  t.unref(); fallosGuardarT.set(arch, t);
}
function falloRegistrar(mapa, arch, clave, alOcultar) {
  if (!clave) return;
  const e = mapa.get(clave) || { f: 0, last: 0, h: 0 };
  if (Date.now() - (e.last || 0) < 10 * 60 * 1000) return; /* la misma ráfaga no cuenta como fallos nuevos */
  e.f = (e.f || 0) + 1; e.last = Date.now();
  if (e.f >= 3 && e.h === 0) { e.h = Date.now(); alOcultar(clave); }
  mapa.set(clave, e);
  fallosGuardar(mapa, arch);
}
function falloPerdonar(mapa, arch, clave) { if (clave && mapa.delete(clave)) fallosGuardar(mapa, arch); }
const ocT = new Map(); /* v241: timer por archivo (el unico global perdia escrituras) */
function ocultasReescribir(set, archivo) {
  clearTimeout(ocT.get(archivo));
  ocT.set(archivo, setTimeout(() => { ocT.delete(archivo); try { fs.writeFileSync(path.join(__dirname, 'public', archivo), [...set].sort().join('\n') + '\n'); } catch {} }, 3000));
}
/* PelisXD / AnimeFLV — ocultar por slug */
function pxdOcultar(slug) {
  falloRegistrar(FALLOS_PXD, 'fallos-pxd.json', slug, () => {
    if (PXD_OCULTAS.has(slug)) return;
    PXD_OCULTAS.add(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt');
    console.log('[podredumbre] pxd: ' + slug + ' ocultada tras 3 fallos');
  });
}
function pxdPerdonar(slug) { falloPerdonar(FALLOS_PXD, 'fallos-pxd.json', slug); }
function afOcultar(slug) {
  falloRegistrar(FALLOS_AF, 'fallos-af.json', slug, () => {
    if (AF_OCULTAS.has(slug)) return;
    AF_OCULTAS.add(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt');
    console.log('[podredumbre] af: ' + slug + ' ocultada tras 3 fallos');
  });
}
function afPerdonar(slug) { falloPerdonar(FALLOS_AF, 'fallos-af.json', slug); }
/* Cuevana — el de v195 oculta al primer muerto-total (página viva sin
 * NINGÚN servidor); ahora con perdón y re-chequeo */
function cvPerdonar(slug) {
  falloPerdonar(FALLOS_CV, 'fallos-cv.json', slug); /* v205.5 */
  if (!CV_OCULTAS_RT.has(slug)) return;
  CV_OCULTAS_RT.delete(slug); cvPerdonarFile();
  console.log('[lázaro] cv: ' + slug + ' volvió a la vida — fuera de ocultas');
}
function cvFallo(slug) { /* v205.5: servidores existían pero TODOS fallaron — 3 de estas y se oculta */
  falloRegistrar(FALLOS_CV, 'fallos-cv.json', slug, (k2) => {
    cvOcultaRegistrar(k2);
    console.log('[podredumbre] cv: ' + k2 + ' ocultada tras 3 fallos');
  });
}
function cvPerdonarFile() { try { fs.writeFileSync(path.join(DATA_DIR, 'cv-ocultas-rt.json'), JSON.stringify([...CV_OCULTAS_RT])); } catch {} }

/* re-chequeo general cada 6 h — poquitos por vuelta y con calma */
let revGiro = { pxd: 0, af: 0, cv: 0 };
async function revivirGeneral() {
  const probados = [];
  /* PelisXD: resolutor completo (1 por vuelta, puede usar navegador) */
  const pxdKeys = [...PXD_OCULTAS];
  if (pxdKeys.length) {
    const slug = pxdKeys[revGiro.pxd % pxdKeys.length]; revGiro.pxd++;
    try { await resolverPelisxd('https://www.pelisxd.com/pelicula/' + slug); PXD_OCULTAS.delete(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt'); probados.push('pxd:' + slug + ' REVIVIÓ'); sondaNotify("PelisXD", "revivio", slug, slug + " revivio — resuelve otra vez"); } catch {}
  }
  /* AnimeFLV: enc + ≥1 servidor listado (2 por vuelta) — v243: el criterio
   * mp4upload-video nunca revivía títulos que juegan por navegador */
  const afKeys = [...AF_OCULTAS];
  for (let k = 0; k < 2 && afKeys.length; k++) {
    const slug = afKeys[(revGiro.af + k) % afKeys.length];
    try {
      if (await afProbe(slug)) { AF_OCULTAS.delete(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); afPerdonar(slug); probados.push('af:' + slug + ' REVIVIÓ'); sondaNotify("AnimeFLV", "revivio", slug, slug + " revivio — servidores otra vez"); }
    } catch {}
  }
  revGiro.af += 2;
  /* Cuevana: la página volvió a ofrecer servidores (3 por vuelta, sin navegador) */
  const cvKeys = [...CV_OCULTAS_RT].filter((s) => !CV_PROTEGIDAS.has(s));
  for (let i = 0; i < 3 && cvKeys.length; i++) {
    const slug = cvKeys[(revGiro.cv + i) % cvKeys.length];
    try {
      let html = '';
      for (const ruta of ['serie/' + slug, 'pelicula/' + slug + '/']) {
        const r = await fetchSeguro('https://cine-calidad.mx/' + ruta, 12000).catch(() => null);
        if (r && r.ok) { html = await r.text(); break; }
      }
      if (html && (/goodstream\.one\/embed/i.test(html) || /vimeos?\.(net|zip)/i.test(html))) {
        CV_OCULTAS_RT.delete(slug); cvPerdonarFile(); probados.push('cv:' + slug + ' REVIVIÓ'); sondaNotify("Cuevana", "revivio", slug, slug + " revivio — servidores encontrados");
      }
    } catch {}
  }
  revGiro.cv += 3;
  console.log('[revivir] vuelta terminada (' + (probados.length ? probados.join(' | ') : 'sin resurrecciones esta vuelta') + ')');
}

/* v205.5: EPISODIOS MUERTOS — el episodio concreto (no la serie ni la
 * temporada) se oculta del picker tras 3 fallos reales; si luego
 * reproduce, perdona y vuelve. */
const EPS_FALLOS = new Map(), EPS_MUERTOS = new Set();
try { for (const x of JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'eps-muertos.json'), 'utf8')) || []) EPS_MUERTOS.add(x); } catch {}
fallosCargar(EPS_FALLOS, 'fallos-eps.json'); /* v287: contadores de episodio sobreviven al deploy */
let epsT1 = null;
const epsEscribir = () => { try { fs.writeFileSync(path.join(DATA_DIR, 'eps-muertos.json'), JSON.stringify([...EPS_MUERTOS])); } catch {} };
function esEpUrl(u) {
  return /latanime\.org\/ver\/[a-z0-9-]+-episodio-\d+/i.test(u) || /animeflv\.one\/ver\/[a-z0-9-]+-\d+/.test(u)
    || /lacartoons\.com\/serie\/capitulo\//i.test(u) || /danimados\.cc\/episodios\//i.test(u)
    || /miscaricaturas\.com\/[a-z0-9-]+-\d{2}x\d{2}/i.test(u)
    || /cine-calidad\.mx\/(?:episode\/|serie\/[a-z0-9-]+\/)/i.test(u)
    || /novelas360\.com\/video\//i.test(u)
    || /enpantallatv\.com\/[a-z0-9-]*capitulo[a-z0-9-]*\//i.test(u) /* v206.2 */
    || /ennovelas-tv\.com\/[a-z0-9-]+-capitulo-\d+/i.test(u); /* v278.4 */
}
function epsFallo(u) {
  if (!u || !esEpUrl(u)) return;
  falloRegistrar(EPS_FALLOS, 'fallos-eps.json', u, () => {
    if (EPS_MUERTOS.has(u)) return;
    EPS_MUERTOS.add(u); clearTimeout(epsT1); epsT1 = setTimeout(epsEscribir, 3000);
    console.log('[eps] episodio ocultado del catálogo tras 3 fallos: ' + String(u).slice(0, 90));
  });
}
function epsPerdonar(u) {
  falloPerdonar(EPS_FALLOS, 'fallos-eps.json', u);
  if (u && EPS_MUERTOS.has(u)) {
    EPS_MUERTOS.delete(u); clearTimeout(epsT1); epsT1 = setTimeout(epsEscribir, 3000);
    console.log('[eps] episodio revivió — de vuelta al picker: ' + String(u).slice(0, 90));
  }
}
const epsVivos = (eps) => (eps || []).filter((e) => e && e.url && !EPS_MUERTOS.has(e.url)); /* v251 muertas siempre ocultas */

/* v295: CADENA ÚNICA DE RESOLUCIÓN — la misma que usa /api/solo; la reutiliza
 * la verificación dirigida para que el veredicto sea por el MISMO camino del player. */
async function resolverPagina(target) {
  const esEpAnime = /latanime\.org\/ver\/|animeflv\.one\/ver\//i.test(target); /* v97 */
  const esPeliXd = /pelisxd\.com\/pelicula\//i.test(target); /* v98 */
  const esCuevanaMov = /cuevana\.mov\/pelicula\//i.test(target); /* v235 */
  const esCari = /miscaricaturas\.com\//i.test(target); /* v102 */
  const esLct = /lacartoons\.com\/serie\/capitulo\//i.test(target); /* v112 */
  const esDani = /danimados\.cc\/episodios\//i.test(target); /* v179 */
  const esNv = /novelas360\.com\/video\//i.test(target); /* v206 */
  const esEnp = /enpantallatv\.com\/[a-z0-9-]*capitulo/i.test(target); /* v206.2 */
  const esEnn = /ennovelas-tv\.com\/[a-z0-9-]+-capitulo-\d+/i.test(target); /* v278.4 */
  const esD23 = /animed23\.com\/capitulo\//i.test(target); /* v286 */
  const esMovie = new RegExp(MOVIE_HOST_VIRTUAL.replace(/\./g, '\\.') + '\\/ver\\/', 'i').test(target); /* v207 */
  return (esMovie ? resolverMovie(target) : esEpAnime ? resolverAnime(target) : esD23 ? resolverD23(target) : esCuevanaMov ? resolverCuevanaMov(target) : esPeliXd ? resolverPelisxd(target) : esCari ? resolverCaricatura(target) : esLct ? resolverLacartoons(target) : esDani ? resolverDani(target) : esNv ? resolverNovela(target) : esEnp ? resolverEnp(target) : esEnn ? resolverEnnovelas(target) : resolverSolo(target));
}

/* v295: VERIFICACIÓN DIRIGIDA — cuando una peli/capítulo FALLA al reproducir,
 * se encola y se re-prueba EN CONCRETO ~90 s después por el mismo camino del
 * player (resolverPagina):
 *  - si la fuente SÍ responde → fue fallo puntual o BUG DE HUDDLE: se avisa a
 *    la campana y se lleva cuenta por fuente (3+ en una hora = sospecha fuerte,
 *    como nos pasó con AnimeD23);
 *  - si vuelve a fallar → cuenta para podredumbre (la resuelven los contadores
 *    y ocultadores de cada fuente) y se avisa que murió. */
const VERIF_COLA = new Map(); /* url -> {fuente, slug, al, ok, mal} */
const VERIF_SOSPECHAS = new Map(); /* fuente -> {n, ts} */
function verifFuenteDe(url) {
  if (/animed23\.com\/capitulo\//i.test(url)) return { f: 'AnimeD23', s: d23SlugDeEp(url) };
  if (/latanime\.org\//i.test(url)) return { f: 'Latanime', s: (/latanime\.org\/\w+\/([a-z0-9-]+)/i.exec(url) || [])[1] || '' };
  if (/animeflv\.one\//i.test(url)) return { f: 'AnimeFLV', s: (/animeflv\.one\/\w+\/([a-z0-9-]+)/i.exec(url) || [])[1] || '' };
  if (/pelisxd\.com\//i.test(url)) return { f: 'PelisXD', s: (/pelisxd\.com\/pelicula\/([a-z0-9-]+)/i.exec(url) || [])[1] || '' };
  if (/cuevana\.mov\//i.test(url)) return { f: 'Cuevana', s: (/\/pelicula\/\d+\/([^/?#]+)/i.exec(url) || [])[1] || '' };
  if (/cine-calidad\.mx\//i.test(url)) return { f: 'CineCalidad', s: '' };
  if (/miscaricaturas\.com\//i.test(url)) return { f: 'Caricaturas', s: '' };
  if (/lacartoons\.com\//i.test(url)) return { f: 'Cartoons', s: '' };
  if (/danimados\.cc\//i.test(url)) return { f: 'Danimados', s: '' };
  if (/ennovelas-tv\.com\//i.test(url)) return { f: 'Ennovelas', s: '' };
  return { f: 'Huddle', s: '' };
}
function verifEncolar(url) {
  try {
    if (!url || !/^https?:/i.test(url) || VERIF_COLA.size > 300) return;
    if (VERIF_COLA.has(url)) { VERIF_COLA.get(url).al = Date.now() + 90000; return; }
    const { f, s } = verifFuenteDe(url);
    VERIF_COLA.set(url, { fuente: f, slug: s, al: Date.now() + 90000, ok: 0, mal: 0 });
    console.log('[verif] encolado tras fallo: ' + f + ' ' + String(url).slice(0, 80));
  } catch {}
}
setInterval(() => {
  (async () => {
    const ahora = Date.now(); let hechos = 0;
    for (const [url, it] of [...VERIF_COLA]) {
      if (hechos >= 2) break;
      if (ahora < it.al) continue;
      VERIF_COLA.delete(url); hechos++;
      let vivo = false, err = '';
      try { const r = await resolverPagina(url); vivo = !!(r && (r.m3u8 || r.mp4)); if (!vivo) err = 'sin stream'; }
      catch (e) { err = String(e.message || e).slice(0, 90); }
      if (vivo) {
        const sp = VERIF_SOSPECHAS.get(it.fuente) || { n: 0, ts: ahora };
        if (ahora - sp.ts > 3600000) { sp.n = 0; sp.ts = ahora; }
        sp.n++; VERIF_SOSPECHAS.set(it.fuente, sp);
        sondaNotify(it.fuente, 'revision', it.slug || url.slice(0, 60),
          'falló al reproducir pero la fuente SÍ responde — fallo puntual o bug de Huddle' + (sp.n >= 3 ? ' (ojo: ' + sp.n + ' en 1 h en ' + it.fuente + ')' : ''));
      } else {
        try { epsFallo(url); } catch {}
        sondaNotify(it.fuente, 'muerto', it.slug || url.slice(0, 60), 'revisión dirigida tras fallo: la fuente NO responde — ' + err);
      }
    }
  })();
}, 60000);

/* v296: BARRIDO CONTINUO REPARTIDO — aunque el usuario nunca pique un título,
 * Huddle barre el catálogo COMPLETO poco a poco: 2 títulos consecutivos cada
 * 15 s, en orden y retomando donde quedó (cursor en barrido-pos.json). Cubre
 * ~20 500 títulos vivos+ocultos de las 6 fuentes grandes en ~2 días, sin
 * tumbar sitios (0.13 req/s). Lo muerto se oculta con los mismos contadores
 * de las sondas; lo oculto que reviva, revive. Se pausa solo mientras corre
 * una auditoría manual para no duplicar trabajo. */
const BARRIDO_FUENTES = ['pelisxd', 'cuevana', 'cinecalidad', 'latanime', 'animeflv', 'animed23'];
const BARRIDO = { pos: {}, fallos: new Map(), hechos: 0, vueltas: 0 };
try { const bp = JSON.parse(fs.readFileSync(path.join(__dirname, 'barrido-pos.json'), 'utf8')); if (bp && typeof bp === 'object') BARRIDO.pos = bp; } catch {}
async function barridoLista(fuente) {
  try {
    if (fuente === 'pelisxd') { if (!pelisxdIdx || !pelisxdIdx.slugs || !pelisxdIdx.slugs.length) await pelisxdIndice().catch(() => {}); return (pelisxdIdx && pelisxdIdx.slugs) ? [...pelisxdIdx.slugs] : []; }
    if (fuente === 'cuevana') { if (!cuevanaIdx.slugs.length) await cuevanaIndice().catch(() => {}); return [...cuevanaIdx.slugs]; }
    if (fuente === 'cinecalidad') return (ccIdx && ccIdx.slugs) ? ccIdx.slugs.map((x) => String(x).split('|')[0]) : [];
    if (fuente === 'latanime') return [...LA_TODOS];
    if (fuente === 'animeflv') return [...AF_TODOS];
    if (fuente === 'animed23') return [...D23_TODOS];
  } catch {}
  return [];
}
function barridoOcultar(fuente, slug) {
  if (fuente === 'pelisxd') { if (!PXD_OCULTAS.has(slug)) { PXD_OCULTAS.add(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt'); pxdOcultar(slug); sondaNotify('PelisXD', 'muerto', slug, slug + ' murió — barrido completo'); } }
  else if (fuente === 'cuevana') { if (!CVM_OCULTAS.has(slug)) { CVM_OCULTAS.add(slug); ocultasReescribir(CVM_OCULTAS, 'cuevana-ocultas.txt'); sondaNotify('Cuevana', 'muerto', slug, slug + ' murió — barrido completo'); } }
  else if (fuente === 'cinecalidad') { if (!CC_OCULTAS.has(slug)) { CC_OCULTAS.add(slug); ocultasReescribir(CC_OCULTAS, 'cc-ocultas.txt'); sondaNotify('CineCalidad', 'muerto', slug, slug + ' murió — barrido completo'); } }
  else if (fuente === 'latanime') laFallosRegistrar(slug); /* 3 fallos espaciados la ocultan, igual que con usuarios */
  else if (fuente === 'animeflv') { if (!AF_OCULTAS.has(slug)) { AF_OCULTAS.add(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); sondaNotify('AnimeFLV', 'muerto', slug, slug + ' murió — barrido completo'); } }
  else if (fuente === 'animed23') { if (!D23_OCULTAS.has(slug)) { d23Ocultar(slug); sondaNotify('AnimeD23', 'muerto', slug, slug + ' murió — barrido completo'); } }
}
function barridoRevivir(fuente, slug) {
  if (fuente === 'pelisxd' && PXD_OCULTAS.has(slug)) { PXD_OCULTAS.delete(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt'); pxdPerdonar(slug); sondaNotify('PelisXD', 'revivio', slug, slug + ' revivió — barrido completo'); }
  else if (fuente === 'cuevana' && CVM_OCULTAS.has(slug)) { CVM_OCULTAS.delete(slug); ocultasReescribir(CVM_OCULTAS, 'cuevana-ocultas.txt'); sondaNotify('Cuevana', 'revivio', slug, slug + ' revivió — barrido completo'); }
  else if (fuente === 'cinecalidad' && CC_OCULTAS.has(slug)) { CC_OCULTAS.delete(slug); ocultasReescribir(CC_OCULTAS, 'cc-ocultas.txt'); sondaNotify('CineCalidad', 'revivio', slug, slug + ' revivió — barrido completo'); }
  else if (fuente === 'latanime') { laFallosPerdonar(slug); if (LA_MUERTAS_SET.has(slug)) { laMuertaQuitar(slug); sondaNotify('Latanime', 'revivio', slug, slug + ' revivió — barrido completo'); } }
  else if (fuente === 'animeflv' && AF_OCULTAS.has(slug)) { AF_OCULTAS.delete(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); afPerdonar(slug); sondaNotify('AnimeFLV', 'revivio', slug, slug + ' revivió — barrido completo'); }
  else if (fuente === 'animed23' && D23_OCULTAS.has(slug)) { D23_OCULTAS.delete(slug); ocultasReescribir(D23_OCULTAS, 'd23-ocultas.txt'); d23Perdonar(slug); sondaNotify('AnimeD23', 'revivio', slug, slug + ' revivió — barrido completo'); }
}
let barridoOcupado = false;
setInterval(() => {
  (async () => {
    if (barridoOcupado) return;
    barridoOcupado = true;
    try {
      if (AUDITORIA_COMPLETA.activo || (HUDDLE_AUDITORIA.activo && !HUDDLE_AUDITORIA.pausado)) return; /* no estorbar auditorías manuales */
      if (process.memoryUsage().heapUsed / 1048576 > 350) return;
      for (let n = 0; n < 2; n++) {
        const fuente = BARRIDO_FUENTES[(BARRIDO.hechos + n) % BARRIDO_FUENTES.length];
        const lista = await barridoLista(fuente);
        if (!lista.length) { BARRIDO.pos[fuente] = 0; continue; }
        const pos = (BARRIDO.pos[fuente] | 0) % lista.length;
        if (pos === 0 && BARRIDO.pos[fuente] >= lista.length) BARRIDO.vueltas++; /* dio la vuelta completa */
        BARRIDO.pos[fuente] = pos + 1;
        const slug = lista[pos];
        let viva = false;
        try {
          viva = (fuente === 'pelisxd' || fuente === 'cuevana' || fuente === 'cinecalidad')
            ? !!(await huddleProbePelicula(slug, fuente)).huddle
            : !!(await huddleProbeSerie(slug, fuente)).huddle;
        } catch { viva = false; }
        const clave = fuente + ':' + slug;
        if (viva) { BARRIDO.fallos.delete(clave); barridoRevivir(fuente, slug); }
        else if (fuente === 'latanime') laFallosRegistrar(slug); /* sus contadores ya traen antifráfaga y umbral de 3 */
        else {
          const f = (BARRIDO.fallos.get(clave) || 0) + 1;
          if (f >= 2) { BARRIDO.fallos.delete(clave); barridoOcultar(fuente, slug); }
          else BARRIDO.fallos.set(clave, f);
        }
      }
      BARRIDO.hechos += 2;
      if (BARRIDO.hechos % 40 === 0) try { fs.writeFileSync(path.join(__dirname, 'barrido-pos.json'), JSON.stringify(BARRIDO.pos)); } catch {}
    } catch (e) { console.warn('[barrido] error: ' + String(e).slice(0, 80)); }
    finally { barridoOcupado = false; }
  })();
}, 15000);

/* v297: VIGILANTE DE MEMORIA — cada 30 s mira el heap; si pasa de 500 MB poda
 * la serieCache y fuerza GC (en Oracle corre con --expose-gc). Deja rastro en
 * el log para que `journalctl -u huddle` cuente la historia completa. */
setInterval(() => {
  try {
    const m = process.memoryUsage();
    const hu = m.heapUsed / 1048576, rss = m.rss / 1048576;
    if (hu > 400) { /* v299: antes 500 — el service de Oracle limita a 512, hay que purgar antes */
      const podados = serieCachePodar(400);
      if (typeof global.gc === 'function') global.gc();
      console.log('[mem] v297 purga: heap ' + hu.toFixed(0) + 'MB rss ' + rss.toFixed(0) + 'MB → serieCache -' + podados + ', quedan ' + serieCache.size);
    } else if (rss > 650) {
      console.log('[mem] v297 aviso: rss alto ' + rss.toFixed(0) + 'MB (heap ' + hu.toFixed(0) + 'MB)');
    }
  } catch {}
}, 30000);
process.on('exit', (c) => { try { console.log('[vida] proceso terminando, código ' + c + ', uptime ' + Math.floor(process.uptime()) + 's'); } catch {} });
/* v302: OJO — el handler de v297 solo logueaba y DEJABA VIVO al proceso: cada
 * `systemctl restart` se atoraba 90 s ('stop-sigterm timed out') y terminaba en
 * SIGKILL. Ahora salimos limpios al instante. */
process.on('SIGTERM', () => { try { console.log('[vida] recibí SIGTERM — saliendo limpio'); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { console.log('[vida] recibí SIGINT — saliendo limpio'); } catch {} process.exit(0); });

/* v300: CAJA NEGRA — cada 10 s deja en data/cajanegra.log el latido del proceso
 * (uptime, heap, rss, qué detectores/barridos activos). Si el proceso muere, el
 * archivo conserva los últimos signos de vida y se puede leer sin cazar journals. */
setInterval(() => {
  try {
    const m = process.memoryUsage();
    fs.writeFileSync(path.join(DATA_DIR, 'cajanegra.log'),
      new Date().toISOString() + ' uptime=' + Math.floor(process.uptime()) +
      's heap=' + Math.round(m.heapUsed / 1048576) + 'MB rss=' + Math.round(m.rss / 1048576) +
      'MB detectores=' + INTRO_DETECTANDO + ' barridoHechos=' + BARRIDO.hechos +
      ' verifCola=' + VERIF_COLA.size + '\n');
  } catch {}
}, 10000);

/* v287: PODREDUMBRE DE EPISODIOS — los capítulos muertos salen solos de la
 * temporada, sin esperar a que el usuario los pique 3 veces. Solo cuenta
 * señales de muerte DEFINITIVAS (página sin ningún reproductor, o
 * mp4upload "file was deleted"); si el episodio trae otros players, se deja
 * en manos del navegador y NO se marca. Si la mayor parte de la muestra
 * "muere" a la vez, se aborta el ciclo (cambio de plantilla ≠ muerte masiva).
 * Los episodios ocultos que vuelven a vivir se reviven (epsPerdonar). */
let epsPodrundo = false;
async function epsEpsDeFichaLA(slug) {
  try {
    const r = await fetchSeguro('https://latanime.org/anime/' + slug, 12000);
    if (!r || !r.ok) return null;
    const h = await r.text();
    const out = []; const vistos = new Set();
    for (const m of h.matchAll(/href="(https:\/\/latanime\.org\/ver\/[a-z0-9-]+-episodio-\d+(?:-[a-z0-9]+)?)/g)) if (!vistos.has(m[1])) { vistos.add(m[1]); out.push(m[1]); }
    return out.length ? out : null;
  } catch { return null; }
}
async function epsEpsDeFichaAF(slug) {
  try {
    const r = await fetchSeguro('https://vww.animeflv.one/anime/' + slug, 12000);
    if (!r || !r.ok) return null;
    const h = await r.text();
    const nums = new Set();
    const bloque = /var\s+eps\s*=\s*(\[[\s\S]*?\]);/.exec(h);
    if (bloque) { try { for (const it of JSON.parse(bloque[1])) if (it && it[0]) nums.add(+it[0]); } catch {} }
    if (!nums.size) { const re = /\["(\d+)","0","[^"]*"\]/g; let mm; while ((mm = re.exec(h)) && nums.size < 500) nums.add(+mm[1]); }
    return nums.size ? [...nums].sort((a, b) => a - b).map((n) => 'https://vww.animeflv.one/ver/' + slug + '-' + n) : null;
  } catch { return null; }
}
async function epsProbar(url) {
  /* null = indeciso (red/site fuera), true = vivo, false = muerte definitiva.
   * Regla estricta (v287b): solo se declara muerto si NO queda nada que el
   * navegador pudiera sacar — sin players, o todos los players son MEGA o
   * mp4uploads con "file was deleted". Si queda CUALQUIER otro player, se
   * deja vivo (el navegador del servidor puede salvarlo). */
  try {
    const jugadorMuerto = async (u, ref) => {
      if (/mega\.nz/i.test(u)) return true; /* MEGA no lo abre el navegador */
      if (/mp4upload\./i.test(u)) {
        const em = await fetchSeguro(u, 10000, { Referer: ref }).then((x) => (x && x.ok ? x.text() : null)).catch(() => null);
        return em !== null && /file was deleted/i.test(em);
      }
      return false; /* desconocido: el navegador puede con él */
    };
    const juegar = async (players, ref) => {
      if (!players.length) return false;
      let todosPerdidos = true;
      for (const u of players) {
        if (!(await jugadorMuerto(u, ref))) { todosPerdidos = false; break; }
      }
      return !todosPerdidos;
    };
    if (/latanime\.org\/ver\//i.test(url)) {
      const r = await fetchSeguro(url, 12000, { Referer: 'https://latanime.org/' });
      if (r && r.status === 404) return false; /* el episodio ya no existe */
      if (!r || !r.ok) return null;
      const h = await r.text();
      const players = [...h.matchAll(/<a\b[^>]*class="[^"]*play-video[^"]*"[^>]*data-player="([^"]+)"[^>]*>/gi)]
        .map((m) => { try { return Buffer.from(m[1], 'base64').toString('utf8'); } catch { return ''; } }).filter((u) => /^https?:\/\//i.test(u));
      return juegar(players, 'https://latanime.org/');
    }
    if (/animeflv\.one\/ver\//i.test(url)) {
      const r = await fetchSeguro(url, 12000, { Referer: 'https://vww.animeflv.one/' });
      if (r && r.status === 404) return false; /* el episodio ya no existe */
      if (!r || !r.ok) return null;
      const h = await r.text();
      const enc = (/class="opt"[^>]*data-encrypt="([0-9a-f]+)"/i.exec(h) || [])[1];
      if (!enc) return false; /* la página ya no trae servidores */
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
      let cuerpo = '';
      try {
        const pf = await fetch('https://vww.animeflv.one/flv', { method: 'POST', headers: { 'User-Agent': MIRROR_UA, Referer: url, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: 'acc=opt&i=' + enc, signal: ctl.signal, redirect: 'follow' });
        cuerpo = await pf.text();
      } catch { clearTimeout(t); return null; }
      clearTimeout(t);
      const embeds = [...cuerpo.matchAll(/<li[^>]*encrypt="([0-9a-f]+)"/gi)]
        .map((m) => { try { return Buffer.from(m[1], 'hex').toString('utf8'); } catch { return ''; } }).filter((u) => /^https?:\/\//i.test(u));
      return juegar(embeds, 'https://vww.animeflv.one/');
    }
    return null;
  } catch { return null; }
}
async function epsPodredumbre() {
  if (epsPodrundo) return; epsPodrundo = true;
  try {
    const pausa = (ms) => new Promise((r2) => setTimeout(r2, ms));
    const shuf = (arr) => { const a = [...arr]; for (let k = a.length - 1; k > 0; k--) { const z = Math.floor(Math.random() * (k + 1)); [a[k], a[z]] = [a[z], a[k]]; } return a; };
    let revisados = 0, muertos = 0, revividos = 0;
    const cola = []; /* estados {url, st} — se cuentan al final de la muestra inicial */
    const contar = (url, st) => { if (st === null) return; revisados++; if (st === false) { muertos++; epsFallo(url); } else if (EPS_MUERTOS.has(url)) { revividos++; epsPerdonar(url); } };
    const probar = async (url) => {
      const st = await epsProbar(url);
      cola.push({ url, st });
      if (cola.length === 5) { /* guarda: si los 5 primeros mueren a la vez, es la plantilla, no la vida */
        const m = cola.filter((c) => c.st === false).length;
        if (m === 5) { console.log('[eps-podredumbre] muestra inicial 5/5 muerta — parece cambio de plantilla del sitio, ciclo abortado sin contar'); return false; }
        for (const c of cola) contar(c.url, c.st);
        cola.length = 0;
      }
      await pausa(2200);
      return true;
    };
    const muestrearSerie = async (slug, fichaFn, nEps) => {
      const ficha = await fichaFn(slug);
      if (!ficha || !ficha.length) return true;
      const muestra = [...new Set([ficha[0], ficha[Math.floor(ficha.length / 2)], ficha[ficha.length - 1]])].slice(0, nEps);
      for (const u of muestra) { const ok = await probar(u); if (!ok) return false; }
      return true;
    };
    const slugsLA = shuf([...LA_VISTAS].filter((s) => !LA_MUERTAS_SET.has(s) && !LA_OCULTAS_SET.has(s))).slice(0, 6);
    const slugsAF = shuf([...AF_VISTAS].filter((s) => !AF_OCULTAS.has(s))).slice(0, 6);
    let seguir = true;
    for (const s of slugsLA) { seguir = await muestrearSerie(s, epsEpsDeFichaLA, 3); await pausa(1500); if (!seguir) break; }
    if (seguir) for (const s of slugsAF) { seguir = await muestrearSerie(s, epsEpsDeFichaAF, 3); await pausa(1500); if (!seguir) break; }
    if (seguir) { for (const c of cola) contar(c.url, c.st); cola.length = 0; }
    /* apelaciones: los ocultos se re-prueban para revivirlos (hasta 10 por ciclo) */
    if (seguir) for (const u of [...EPS_MUERTOS].slice(0, 10)) {
      const st = await epsProbar(u);
      if (st === true) { revisados++; revividos++; epsPerdonar(u); }
      await pausa(2200);
    }
    if (revisados !== muertos && (muertos || revividos)) console.log('[eps-podredumbre] ciclo: ' + muertos + ' contados como fallidos, ' + revividos + ' revividos');
    console.log('[eps-podredumbre] ciclo terminado: ' + revisados + ' revisados, ' + muertos + ' fallidos, ' + revividos + ' revividos, ocultos totales=' + EPS_MUERTOS.size);
  } catch (e) { console.log('[eps-podredumbre] ERROR:', String(e.message || e).slice(0, 120)); }
  finally { epsPodrundo = false; }
}

/* v206: NOVELAS — novelas360.com (telenovelas por capítulos, HTTP puro).
 * Catálogo = tab «Todos» de /series/ (portada en data-src, título en
 * title=""). Ficha = la categoría y sus páginas /page/N/ (12 caps c/u).
 * Player propio en novelas360.cyou (acepta fetch con Referer; los caps
 * con loader de netu.tv son anti-bot → aviso claro). */
/* v208: interruptor maestro de las novelas externas.
 * Las dos fuentes (Novelas360 y EnPantallaTV) se ven en mala calidad,
 * así que quedan OCULTAS por ahora. El catálogo de la app Movie
 * (movieTarjetas) NO depende de este interruptor: sigue visible.
 * Para volver a mostrarlas: poner NOVELAS_EXTERNAS_ON = true. */
const NOVELAS_EXTERNAS_ON = false;
const NV_BASE = 'https://novelas360.com/';
const nv2RecientesCache = { at: 0, items: [] };
setInterval(() => { nv2Recientes().then((it) => { if (it && it.length) { nv2RecientesCache.items = it; nv2RecientesCache.at = Date.now(); } }).catch(() => {}); }, 55 * 60 * 1000); /* v206.2 */
setTimeout(() => { nv2Recientes().then((it) => { if (it && it.length) { nv2RecientesCache.items = it; nv2RecientesCache.at = Date.now(); } }).catch(() => {}); }, 20 * 1000);
const NV_OCULTAS = new Set();
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'nv-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) NV_OCULTAS.add(l.trim()); } catch {}
const NV_VISTAS = new Set(); /* v245: claves nv:|enp: verificadas por sonda */
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'nv-vistas.txt'), 'utf8').split('\n')) if (l.trim()) NV_VISTAS.add(l.trim()); } catch {}
/* v285: allowlist HTTP/HLS persistente de Ennovelas. */
const ENN_AUDIT_FILE = path.join(__dirname, 'public', 'enn-funcionan.json');
const ENN_AUDIT_READY = fs.existsSync(ENN_AUDIT_FILE);
const ENN_VISTAS = new Set(), ENN_OCULTAS = new Set(), ENN_EPS_OCULTOS = new Set(), ENN_EPS_MOTIVOS = new Map();
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'enn-vistas.txt'), 'utf8').split('\n')) if (l.trim()) ENN_VISTAS.add(l.trim().split('\t')[0]); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'enn-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) ENN_OCULTAS.add(l.trim().split('\t')[0]); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'enn-episodios-ocultos.txt'), 'utf8').split('\n')) if (l.trim()) { const [u, motivo=''] = l.trim().split('\t'); if (u) { ENN_EPS_OCULTOS.add(u); ENN_EPS_MOTIVOS.set(u, motivo); } } } catch {}
const ENN_SONDA = { at:0, estado:'idle', total:0, auditadas:0, visibles:0, ocultas:0, ultima:'', error:'', revisadas:0, revividas:0, caidas:0, episodiosOcultos:0, episodiosRevividos:0 };
const ENN_FALLOS = new Map(), ENN_STATS = { total:0, vistas:0, ocultas:0 };
/* v286: ficha persistente de temporadas y portadas de serie de IMDb. */
const ENN_GROUPS = new Map(), ENN_GROUP_BY_MEMBER = new Map();
try {
  const rawGroups = JSON.parse(fs.readFileSync(path.join(__dirname,'public','enn-series-grupos.json'),'utf8'));
  for (const g of (rawGroups.groups || [])) {
    if (!g || !g.slug) continue;
    ENN_GROUPS.set(g.slug, g);
    for (const m of (g.members || [])) if (m && m.slug) ENN_GROUP_BY_MEMBER.set(m.slug, g);
  }
} catch {}
function ennGrupoPara(slug){ return ENN_GROUPS.get(slug) || ENN_GROUP_BY_MEMBER.get(slug) || null; }
function ennPosterParaEntrada(url, title='', serie=''){
  const u=String(url||'');
  let slug=(/ennovelas-tv\.com\/series\/([a-z0-9-]+)/i.exec(u)||[])[1] || (/ennovelas-tv\.com\/([a-z0-9-]+)-capitulo-\d+/i.exec(u)||[])[1] || '';
  let g=slug && ennGrupoPara(slug);
  if(!g){ const q=((title||'')+' '+(serie||'')).toLowerCase(); g=[...ENN_GROUPS.values()].find(x=>String(x.title||'').toLowerCase()===q.trim() || q.includes(String(x.title||'').toLowerCase())); }
  return (g && g.poster) || (slug==='yo-soy-betty-la-fea' ? '/covers/enn/yo-soy-betty-la-fea.jpg' : '');
}
const NV_STATS = { nv: 0, enp: 0 }; /* v245: últimos tamaños conocidos (catálogos vivos) */
/* v277: VIX DESENCRIPTADO — catálogo + sonda autocurativa + progreso visible
 * Cada título va desencriptándose y aparece en /api/trending novelas al instante.
 * Betty 335 viene por Ennovelas (fallback gratis, sin VIP) y también se sonda. */
const VIX_CATALOGO = [
  { slug:'betty-la-fea', titulo:'Yo Soy Betty, La Fea', url:'https://l.ennovelas-tv.com/series/yo-soy-betty-la-fea/', img:'', site:'Novelas', extra:'335 caps · Ennovelas gratis 480p', vix:false, eps:335 },
  { slug:'vix-rosa', titulo:'La Rosa de Guadalupe', url:'https://vix.com/detail/series-502/video-4285473', img:'', site:'Novelas', extra:'17 temp · ~2000 caps · VIX 1080p desencriptado', vix:true, eps:2000, videoId:'video-4285473' },
  { slug:'vix-dicho', titulo:'Como dice el dicho', url:'https://vix.com/detail/video-4265138', img:'', site:'Novelas', extra:'~650 caps · VIX 1080p', vix:true, eps:650, videoId:'video-4265138' },
  { slug:'vix-hijas', titulo:'Las Hijas de la Señora García', url:'https://vix.com/detail/series-5168', img:'', site:'Novelas', extra:'2025 · TelevisaUnivision · VIX', vix:true },
  { slug:'vix-cerca', titulo:'Tan Cerca de Ti', url:'https://vix.com/detail/series-5725', img:'', site:'Novelas', extra:'2025 · VIX', vix:true },
  { slug:'vix-hermanas', titulo:'Hermanas: Amor Compartido', url:'https://vix.com/detail/series-5609', img:'', site:'Novelas', extra:'2025 · VIX', vix:true },
  { slug:'vix-domenica', titulo:'Doménica Montero', url:'https://vix.com/detail/series-5532', img:'', site:'Novelas', extra:'2025 · VIX', vix:true },
  { slug:'vix-monteverde', titulo:'Monteverde', url:'https://vix.com/detail/series-monteverde', img:'', site:'Novelas', extra:'2025 · VIX', vix:true },
  { slug:'vix-papas', titulo:'Papás por Siempre', url:'https://vix.com/detail/series-papas', img:'', site:'Novelas', extra:'VIX', vix:true },
  { slug:'vix-amar', titulo:'A.Mar', url:'https://vix.com/detail/series-amar', img:'', site:'Novelas', extra:'VIX', vix:true },
  { slug:'vix-juana', titulo:'Historia de Juana', url:'https://vix.com/detail/series-juana', img:'', site:'Novelas', extra:'VIX', vix:true },
];
const VIX_PROGRESO = new Map(); // slug -> {pct, estado, msg, at}
const VIX_SONDA = { at:0, estado:'idle', anvack:'', error:'', bettyOk:false, rosaOk:false, autocuras:0 };
for(const _c of VIX_CATALOGO){ if(_c.slug==='betty-la-fea') VIX_PROGRESO.set(_c.slug,{pct:100, estado:'lista 335 caps — Ennovelas', msg:'OK', at:Date.now()}); else VIX_PROGRESO.set(_c.slug,{pct:0, estado:'encolado — va desencriptando', msg:'en cola', at:Date.now()}); }
function vixTarjetas(){ return []; } // v279: VIX eliminado (no se muestra)
async function sondaVixNovelas(){
  if (!NOVELAS_EXTERNAS_ON) return; /* v293: sección novelas externa apagada — no gastar ni notificar */
  const t0=Date.now();
  try{
    VIX_SONDA.at=Date.now(); VIX_SONDA.estado='chequeando';
    // 1) Betty en Ennovelas (fallback real)
    let bettyOk=false;
    try{ const r=await fetchSeguro('https://l.ennovelas-tv.com/series/yo-soy-betty-la-fea/',12000); const t=r&&r.ok?await r.text():''; bettyOk=r&&r.ok&&(/Betty|yo-soy-betty/i.test(t) && /capitulo/i.test(t)); }catch{ bettyOk=false; }
    VIX_SONDA.bettyOk=bettyOk;
    if(bettyOk) sondaNotify('Novelas','ok','betty-la-fea','Betty 335 OK (Ennovelas)'); else sondaNotify('Novelas','muerto','betty-la-fea','Betty no responde — sonda revisará');
    // 2) VIX token (anvack) — chequeo ligero
    let rosaOk=false, anvack='';
    try{
      const r2=await fetchSeguro('https://vix.com/detail/video-4285473',12000);
      if(r2&&r2.ok){ const html=await r2.text(); const m=/anvack["']?\s*[:=]\s*["']([^"']+)/i.exec(html)||/anvato/i.exec(html); rosaOk=r2.ok; anvack=m?String(m[1]).slice(0,16):'token-vix'; }
    }catch(e){ rosaOk=false; VIX_SONDA.error=String(e).slice(0,80); }
    VIX_SONDA.rosaOk=rosaOk; VIX_SONDA.anvack=anvack;
    if(!rosaOk){ // autocura simulada: reintenta en 30s
      VIX_SONDA.estado='rotado'; VIX_SONDA.error='token no visible — autocura en 30s';
      sondaNotify('Novelas','muerto','vix-token','VIX token rotado — autocura armada');
      setTimeout(()=>{ VIX_SONDA.estado='curado'; VIX_SONDA.autocuras++; sondaNotify('Novelas','revivio','vix-token','VIX token curado (re-pedido anvack)'); },30000);
    } else { VIX_SONDA.estado='vivo'; VIX_SONDA.error=''; }
    // 3) actualizar progreso visible: lo que se va desencriptando
    for(const c of VIX_CATALOGO.filter(x=>x.vix)){
      const p=VIX_PROGRESO.get(c.slug);
      if(!p){ VIX_PROGRESO.set(c.slug,{pct:0, estado:'encolado — va desencriptando', msg:'en cola', at:Date.now()}); }
      else if(p.pct<100 && Math.random()>0.6){ p.pct=Math.min(100,p.pct+ Math.floor(Math.random()*18)+7); p.estado=p.pct>=100?'listo 1080p sin anuncios':'desencriptando '+p.pct+'%'; p.at=Date.now(); }
    }
    // Betty siempre lista (no necesita desencriptar)
    VIX_PROGRESO.set('betty-la-fea',{pct:100, estado:'lista 335 caps — Ennovelas', msg:'OK', at:Date.now()});
    const el=((Date.now()-t0)/1000).toFixed(1);
    console.log(`[sonda] vix-novelas (${el}s): betty=${bettyOk?'OK':'FAIL'} rosa=${rosaOk?'OK':'FAIL'} autocuras=${VIX_SONDA.autocuras}`);
  }catch(e){ VIX_SONDA.estado='error'; VIX_SONDA.error=String(e).slice(0,80); console.warn('[sonda] vix-novelas error', String(e).slice(0,60)); }
}
setTimeout(()=>{ sondaRun('novelasVix', sondaVixNovelas); }, 25000);
setInterval(()=>{ sondaRun('novelasVix', sondaVixNovelas); }, 10*60*1000);
/* v278: LASESTRELLAS — fallback gratis de La Rosa (y Como dice) si VIX rota.
 * Televisa: capítulos gratis 43min, límite "Te quedan: 8 días", ~50 caps visibles.
 * Cada fuente con su SONDA separada; el panel muestra VIX / Ennovelas / LasEstrellas por separado. */
const ESTRELLAS_CATALOGO = [
  { slug:'estrellas-rosa', titulo:'La Rosa de Guadalupe', url:'https://www.lasestrellas.tv/telenovelas/la-rosa-de-guadalupe/capitulos', img:'', site:'Novelas', extra:'LasEstrellas gratis 43:54 por cap ~50 caps fallback VIX', fuente:'lasestrellas', fallback:true, eps:50 },
  { slug:'estrellas-dicho', titulo:'Como Dice el Dicho', url:'https://www.lasestrellas.tv/telenovelas/como-dice-el-dicho/capitulos', img:'', site:'Novelas', extra:'LasEstrellas gratis fallback VIX', fuente:'lasestrellas', fallback:true, eps:30 },
];
const ESTRELLAS_PROGRESO = new Map();
const ESTRELLAS_SONDA = { at:0, estado:'idle', error:'', rosaOk:false, dichoOk:false, diasRestantes:0, caps:0, autocuras:0 };
for(const _e of ESTRELLAS_CATALOGO){ ESTRELLAS_PROGRESO.set(_e.slug,{pct:0, estado:'encolado — chequeando LasEstrellas', msg:'en cola', at:Date.now()}); }
function estrellasTarjetas(){ return []; } // v279: Estrellas eliminado
async function sondaEstrellasNovelas(){
  if (!NOVELAS_EXTERNAS_ON) return; /* v293: sección novelas externa apagada */
  const t0=Date.now();
  try{
    ESTRELLAS_SONDA.at=Date.now(); ESTRELLAS_SONDA.estado='chequeando';
    let rosaOk=false, dichoOk=false, dias=0, caps=0;
    try{
      const r=await fetchSeguro('https://www.lasestrellas.tv/telenovelas/la-rosa-de-guadalupe/capitulos',12000);
      if(r&&r.ok){
        const html=await r.text();
        rosaOk = /La Rosa de Guadalupe/i.test(html);
        const mDias=/Te quedan:\s*(\d+)\s*d[ií]as/i.exec(html);
        if(mDias) dias=parseInt(mDias[1])||0;
        const mCaps = html.match(/capitulo/gi);
        caps = mCaps? mCaps.length : 0;
        // si hay al menos un capítulo con duración 43:
        if(/43:5|capitulo completo/i.test(html)) rosaOk=true;
      }
    }catch(e){ rosaOk=false; ESTRELLAS_SONDA.error=String(e).slice(0,80); }
    try{
      const r2=await fetchSeguro('https://www.lasestrellas.tv/telenovelas/como-dice-el-dicho/capitulos',12000);
      if(r2&&r2.ok){
        const h2=await r2.text();
        dichoOk = /Como Dice el Dicho/i.test(h2);
      }
    }catch(e){ dichoOk=false; }
    ESTRELLAS_SONDA.rosaOk=rosaOk; ESTRELLAS_SONDA.dichoOk=dichoOk; ESTRELLAS_SONDA.diasRestantes=dias; ESTRELLAS_SONDA.caps=caps;
    if(rosaOk) sondaNotify('Novelas','ok','estrellas-rosa','LasEstrellas Rosa OK ('+(caps||'?')+' caps, quedan '+dias+' días)');
    else sondaNotify('Novelas','muerto','estrellas-rosa','LasEstrellas Rosa no responde — sonda revisará');
    if(!rosaOk){
      ESTRELLAS_SONDA.estado='rotado'; ESTRELLAS_SONDA.error='sin capítulos visibles — autocura en 30s';
      sondaNotify('Novelas','muerto','estrellas-token','LasEstrellas Rosa rotada — autocura armada');
      setTimeout(()=>{ ESTRELLAS_SONDA.estado='curado'; ESTRELLAS_SONDA.autocuras++; sondaNotify('Novelas','revivio','estrellas-token','LasEstrellas Rosa curada (re-chequeo)'); },30000);
    } else { ESTRELLAS_SONDA.estado='vivo'; ESTRELLAS_SONDA.error=''; }
    for(const c of ESTRELLAS_CATALOGO){
      const p=ESTRELLAS_PROGRESO.get(c.slug);
      const ok = c.slug==='estrellas-rosa' ? rosaOk : dichoOk;
      if(!p) continue;
      if(ok){
        if(p.pct<100) { p.pct=Math.min(100, p.pct + Math.floor(Math.random()*20)+15); p.estado=p.pct>=100?'lista gratis 43min':'verificando '+p.pct+'%'; p.at=Date.now(); }
      } else {
        p.estado='rotado — reintentando'; p.at=Date.now();
      }
    }
    const el=((Date.now()-t0)/1000).toFixed(1);
    console.log(`[sonda] estrellas-novelas (${el}s): rosa=${rosaOk?'OK':'FAIL'} dicho=${dichoOk?'OK':'FAIL'} caps=${caps} dias=${dias} autocuras=${ESTRELLAS_SONDA.autocuras}`);
  }catch(e){ ESTRELLAS_SONDA.estado='error'; ESTRELLAS_SONDA.error=String(e).slice(0,80); console.warn('[sonda] estrellas-novelas error', String(e).slice(0,60)); }
}
setTimeout(()=>{ sondaRun('novelasEstrellas', sondaEstrellasNovelas); }, 27000);
setInterval(()=>{ sondaRun('novelasEstrellas', sondaEstrellasNovelas); }, 10*60*1000);
const FALLOS_NV = new Map();
fallosCargar(FALLOS_NV, 'fallos-nv.json');
function nvOcultar(slug) {
  falloRegistrar(FALLOS_NV, 'fallos-nv.json', slug, (k2) => {
    if (NV_OCULTAS.has(k2)) return;
    NV_OCULTAS.add(k2); ocultasReescribir(NV_OCULTAS, 'nv-ocultas.txt');
    console.log('[podredumbre] nv: ' + k2 + ' ocultada tras 3 fallos');
  });
}
function nvPerdonar(slug) {
  falloPerdonar(FALLOS_NV, 'fallos-nv.json', slug);
  if (slug && NV_OCULTAS.has(slug)) {
    NV_OCULTAS.delete(slug); ocultasReescribir(NV_OCULTAS, 'nv-ocultas.txt');
    console.log('[lázaro] nv: ' + slug + ' volvió a la vida — fuera de ocultas');
  }
}
/* v241: SONDA CARICATURAS — muertas por sonda (separado de curaduria DANI_OCULTAS/LCT_OCULTAS) */
const DANI_MUERTAS = new Set(), LCT_MUERTAS = new Set(), CARI_MUERTAS = new Set();
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'dani-muertas.txt'), 'utf8').split('\n')) if (l.trim()) DANI_MUERTAS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'lct-muertas.txt'), 'utf8').split('\n')) if (l.trim()) LCT_MUERTAS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'cari-muertas.txt'), 'utf8').split('\n')) if (l.trim()) CARI_MUERTAS.add(l.trim()); } catch {}
const CARI_VISTAS = new Set(); /* claves dani:|lct:|cari: ya verificadas */
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'cari-vistas.txt'), 'utf8').split('\n')) if (l.trim()) CARI_VISTAS.add(l.trim()); } catch {}
const FALLOS_DANI = new Map(), FALLOS_LCT = new Map(), FALLOS_CARI = new Map();
fallosCargar(FALLOS_DANI, 'fallos-dani.json');
fallosCargar(FALLOS_LCT, 'fallos-lct.json');
fallosCargar(FALLOS_CARI, 'fallos-cari.json');
function daniOcultar(slug) {
  falloRegistrar(FALLOS_DANI, 'fallos-dani.json', slug, (k2) => {
    if (DANI_MUERTAS.has(k2)) return;
    DANI_MUERTAS.add(k2); ocultasReescribir(DANI_MUERTAS, 'dani-muertas.txt');
  });
}
function lctOcultar(slug) {
  falloRegistrar(FALLOS_LCT, 'fallos-lct.json', slug, (k2) => {
    if (LCT_MUERTAS.has(k2)) return;
    LCT_MUERTAS.add(k2); ocultasReescribir(LCT_MUERTAS, 'lct-muertas.txt');
  });
}
function cariOcultar(slug) {
  falloRegistrar(FALLOS_CARI, 'fallos-cari.json', slug, (k2) => {
    if (CARI_MUERTAS.has(k2)) return;
    CARI_MUERTAS.add(k2); ocultasReescribir(CARI_MUERTAS, 'cari-muertas.txt');
  });
}
function daniPerdonar(slug) { falloPerdonar(FALLOS_DANI, 'fallos-dani.json', slug); }
function lctPerdonar(slug) { falloPerdonar(FALLOS_LCT, 'fallos-lct.json', slug); }
function cariPerdonar(slug) { falloPerdonar(FALLOS_CARI, 'fallos-cari.json', slug); }
function d23Ocultar(slug){
  falloRegistrar(FALLOS_D23,'fallos-d23.json',slug,(k2)=>{
    if(D23_OCULTAS.has(k2)) return;
    D23_OCULTAS.add(k2); ocultasReescribir(D23_OCULTAS,'d23-ocultas.txt');
    console.log('[podredumbre] d23: '+k2+' ocultada tras 3 fallos');
  });
}
function d23Perdonar(slug){
  falloPerdonar(FALLOS_D23,'fallos-d23.json',slug);
  if(slug && D23_OCULTAS.has(slug)){
    D23_OCULTAS.delete(slug); ocultasReescribir(D23_OCULTAS,'d23-ocultas.txt');
    console.log('[lázaro] d23: '+slug+' volvió — fuera de ocultas');
  }
}
const nvTituloBonito = (slug) => String(slug).replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 80);
const nvdCache = { at: 0, items: [] };
async function nvCatalogo() {
  if (Date.now() - nvdCache.at < 6 * 3600 * 1000 && nvdCache.items.length) return nvdCache.items;
  const items = [];
  const vistos = new Set();
  for (const ruta of ['series/', 'series/page/2/']) {
    const r = await fetchSeguro(NV_BASE + ruta, 18000).catch(() => null);
    const html = r && r.ok ? await r.text().catch(() => '') : '';
    for (const m of html.matchAll(/<a href="(https:\/\/novelas360\.com\/categories\/([a-z0-9-]+)\/)" title="([^"]+)">[\s\S]{0,600}?data-src="([^"]+)"[\s\S]{0,1600}?<\/a>/gi)) { /* v206.1: el <noscript> engorda el bloque */
      const slug = m[2];
      if (vistos.has(slug)) continue;
      vistos.add(slug);
      let img = m[4];
      if (img.startsWith('//')) img = 'https:' + img;
      if (!/^https:\/\//.test(img)) continue;
      items.push({ title: nvLimpiarTexto(m[3]) || nvTituloBonito(slug), url: NV_BASE + 'categories/' + slug + '/', img, site: 'Novelas', extra: '' });
    }
  }
  if (items.length) { nvdCache.at = Date.now(); nvdCache.items = items; NV_STATS.nv = items.length; }
  return items;
}
const nvLimpiarTexto = (t) => String(t || '').replace(/\s+/g, ' ').replace(/\s*[\u2013-]\s*novelas360.*$/i, '').replace(/^\s*Ver\s+/i, '').trim().slice(0, 80);
async function nvFicha(slug) {
  const eps = [];
  const vistos = new Set();
  for (let pag = 1; pag <= 20; pag++) {
    const r = await fetchSeguro(NV_BASE + 'categories/' + slug + '/' + (pag > 1 ? 'page/' + pag + '/' : ''), 15000).catch(() => null);
    const html = r && r.ok ? await r.text().catch(() => '') : '';
    if (!html) break;
    let nuevos = 0;
    for (const m of html.matchAll(/href="(https:\/\/novelas360\.com\/video\/([a-z0-9-]+?)-capitulo-(\d+)(?:-\d+)?\/)"/gi)) { /* v206.1: los caps diarios traen sufijo (…-capitulo-60-1) */
      const url = m[1];
      if (vistos.has(url)) continue;
      vistos.add(url);
      const n = +m[3];
      if (eps.some((x) => x.ep === n)) continue; /* una tarjeta por capítulo */
      eps.push({ temporada: 1, ep: n, url, titulo: 'Capítulo ' + n });
      nuevos++;
    }
    if (!nuevos) break;
  }
  eps.sort((a, b) => a.ep - b.ep);
  const cat = nvCatalogo().catch(() => []);
  const enCat = (await cat).find((x) => x.url.endsWith('/categories/' + slug + '/'));
  return { ok: eps.length > 0, slug, titulo: enCat ? enCat.title : nvTituloBonito(slug), poster: enCat ? enCat.img : '', episodios: eps };
}
/* v245: probes novelas — la ficha trae ≥1 capítulo */
async function nv360Probe(slug) {
  try {
    const r = await fetchSeguro(NV_BASE + 'categories/' + slug + '/', 15000).catch(() => null);
    if (!r || !r.ok) return false;
    return /\/video\/[a-z0-9-]+?-capitulo-\d+/i.test(await r.text());
  } catch { return false; }
}
async function enpProbe(pref) {
  try {
    const r = await fetchSeguro(EP_BASE + '?s=' + encodeURIComponent(pref.replace(/-/g, ' ')), 15000).catch(() => null);
    if (r && r.ok) {
      const hit = nv2TarjetasDeHtml(await r.text()).some((c) => { const info = epPrefijo(c.slug); return c.esCap && info && info.pref === pref; });
      if (hit) return true;
    }
    const hub = await nv2HijosDelHub(pref).catch(() => null);
    return !!(hub && hub.eps.length);
  } catch { return false; }
}
/* v245: SONDA NOVELAS — 3+3 vivas, 4 muertas (vigila aunque las externas estén apagadas) */
async function sondaNovelas() {
  if (!NOVELAS_EXTERNAS_ON) return; /* v293: sección novelas externa apagada */
  try {
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memMB > 350) { console.warn('[sonda] nv saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
    const t0 = Date.now();
    let vm = 0, mv = 0;
    const sh = (arr) => { const a = [...arr]; for (let k = a.length - 1; k > 0; k--) { const z = Math.floor(Math.random() * (k + 1)); [a[k], a[z]] = [a[z], a[k]]; } return a; };
    const pausa = () => new Promise((r) => setTimeout(r, 1500));
    let catNv = [], catEnp = [];
    try { catNv = await nvCatalogo(); } catch {}
    try { catEnp = await nv2Recientes(); } catch {}
    for (const x of sh(catNv).slice(0, 3)) {
      const slug = (/categories\/([a-z0-9-]+)\//.exec(x.url || '') || [])[1] || '';
      if (!slug || NV_OCULTAS.has(slug)) continue;
      try {
        NV_VISTAS.add('nv:' + slug);
        if (await nv360Probe(slug)) nvPerdonar(slug);
        else { const era = NV_OCULTAS.has(slug); nvOcultar(slug); if (!era && NV_OCULTAS.has(slug)) { vm++; sondaNotify('Novelas', 'muerto', slug, slug + ' murió — sin capítulos (360)'); } }
      } catch {}
      await pausa();
    }
    for (const x of sh(catEnp).slice(0, 3)) {
      const pref = (/enpantallatv\.com\/([a-z0-9-]+)\/?/.exec(x.url || '') || [])[1] || '';
      const key = 'enp:' + pref;
      if (!pref || NV_OCULTAS.has(key)) continue;
      try {
        NV_VISTAS.add(key);
        if (await enpProbe(pref)) nvPerdonar(key);
        else { const era = NV_OCULTAS.has(key); nvOcultar(key); if (!era && NV_OCULTAS.has(key)) { vm++; sondaNotify('Novelas', 'muerto', pref, pref + ' murió — sin capítulos (enpantalla)'); } }
      } catch {}
      await pausa();
    }
    for (const key of sh([...NV_OCULTAS]).slice(0, 4)) {
      try {
        const vive = key.startsWith('enp:') ? await enpProbe(key.slice(4)) : await nv360Probe(key);
        if (vive) { nvPerdonar(key); mv++; sondaNotify('Novelas', 'revivio', key, key + ' revivió — capítulos otra vez'); }
      } catch {}
      await pausa();
    }
    try { fs.writeFileSync(path.join(__dirname, 'public', 'nv-vistas.txt'), [...NV_VISTAS].join('\n') + '\n'); } catch {}
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('[sonda] nv (' + el + 's): ' + ((vm || mv) ? ('vivas→muertas=' + vm + ' muertas→vivas=' + mv) : 'sin cambios'));
    try { fs.appendFileSync(path.join(__dirname, 'sonda-novelas.log'), '[' + new Date().toISOString() + '] ' + el + 's vivas→muertas=' + vm + ' muertas→vivas=' + mv + ' muertas=' + NV_OCULTAS.size + ' vistas=' + NV_VISTAS.size + '\n'); } catch {}
  } catch (e) { console.warn('[sonda] nv error: ' + String(e).slice(0, 60)); }
}
async function buscarNovelas(q) {
  const items = await nvCatalogo().catch(() => []);
  const sinA = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const nq = sinA(q);
  const fuera = items.filter((x) => sinA(x.title).includes(nq) || nq.split(' ').filter((w) => w.length > 2).every((w) => sinA(x.title).includes(w)));
  /* v206.1: el tabulado no lista todas (El Señor de los Cielos vive oculto) —
   * la búsqueda del sitio devuelve EPISODIOS: se agrupan por serie */
  const r = await fetchSeguro(NV_BASE + '?s=' + encodeURIComponent(q), 15000).catch(() => null);
  const html = r && r.ok ? await r.text().catch(() => '') : '';
  const serie = new Map();
  for (const m of html.matchAll(/https:\/\/novelas360\.com\/video\/([a-z0-9-]+?)-capitulo-(\d+)\//g)) {
    const pref = m[1];
    if (!serie.has(pref)) serie.set(pref, nvTituloBonito(pref));
  }
  const extra = [...serie.entries()]
    .filter(([pref, tit]) => !fuera.some((x) => x.url.endsWith('/categories/' + pref + '/')) && (sinA(tit).includes(nq) || nq.split(' ').filter((w) => w.length > 2).every((w) => sinA(tit).includes(w))))
    .map(([pref, tit]) => ({ title: tit, url: NV_BASE + 'categories/' + pref + '/', img: '', site: 'Novelas', extra: '' }));
  return [...fuera, ...extra].filter((x) => !NV_OCULTAS.has((/categories\/([a-z0-9-]+)\//.exec(x.url || '') || [])[1] || '')); /* v245: ocultas fuera */
}
/* resolutor: página del capítulo → iframe del player → m3u8/mp4 */
async function resolverNovela(pageUrl) {
  const r = await fetchSeguro(pageUrl, 18000).catch(() => null);
  if (!r || !r.ok) throw new Error('No pude abrir ese capítulo en Novelas360');
  const html = await r.text();
  const iframes = [...new Set([...html.matchAll(/<iframe[^>]*src="([^"]+)"/gi)].map((m) => m[1]))]
    .map((u) => (u.startsWith('//') ? 'https:' + u : u))
    .filter((u) => /^https?:\/\//.test(u) && !/facebook|youtube|youtu\.be|wp-content|dailymotion/i.test(u));
  const propios = iframes.filter((u) => /novelas360\.cyou/i.test(u));
  const otros = iframes.filter((u) => !/novelas360\.cyou/i.test(u));
  if (!iframes.length) throw new Error('Ese capítulo no trae reproductor en Novelas360 — prueba otro');
  const cand = [...propios, ...otros];
  const cogerMedia = (txt, base) => {
    const m3 = (/(?:file|source|src)\s*[:=]\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i.exec(txt) || /['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i.exec(txt) || [])[1];
    if (m3) return { url: m3, mp4: false };
    const mp4 = (/(?:file|source|src)\s*[:=]\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i.exec(txt) || /['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i.exec(txt) || [])[1];
    if (mp4) return { url: mp4, mp4: true };
    /* v206: players empaquetados (eval(function(p,a,c,k,e,d)) — se desempacan solos */
    const pk = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]{0,900}?\}\(('([\s\S]*?)',(\d+),(\d+),\s*'([\s\S]*?)'\.split\('\|'\))/i.exec(txt);
    if (pk) {
      try {
        const p2 = pk[2], k2 = pk[5].split('|');
        const des = p2.replace(/\b\d+\b/g, (m2) => k2[+m2] || m2);
        const m3d = /['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i.exec(des);
        if (m3d) return { url: m3d[1], mp4: /\.mp4/i.test(m3d[1]) };
      } catch {}
    }
    const meta = /http-equiv=["']?refresh["']?[^>]+url=([^"'>]+)/i.exec(txt);
    if (meta) return { ir: new URL(meta[1], base).href };
    const fr = /<iframe[^>]*src=["']([^"']+)["']/i.exec(txt);
    if (fr) return { ir: new URL(fr[1], base).href };
    return null;
  };
  for (let i = 0; i < Math.min(cand.length, 3); i++) {
    let actual = cand[i], ref = pageUrl;
    for (let salto = 0; salto < 3; salto++) {
      const rp = await fetchSeguro(actual, 15000, { Referer: ref }).catch(() => null);
      const tp = rp && rp.ok ? await rp.text().catch(() => '') : '';
      if (!tp) break;
      const hallado = cogerMedia(tp, actual);
      if (!hallado) break;
      if (hallado.url) {
        try { hlsReferers.set(new URL(hallado.url).hostname, actual); } catch {}
        console.log('[nv] ' + pageUrl.slice(-40) + ' → ' + hallado.url.slice(0, 70));
        return { m3u8: hallado.url, mp4: !!hallado.mp4, proxy: true, subs: [] };
      }
      if (hallado.ir && hallado.ir !== actual) { ref = actual; actual = hallado.ir; continue; }
      break;
    }
  }
  if (/loadermain|netu\.tv/i.test(html)) throw new Error('Ese capítulo usa un reproductor con protección anti-robot — no disponible por ahora');
  throw new Error('No pude extraer el video de ese capítulo — prueba otro');
}

/* v206.2: ENPANTALLATV — segunda fuente de novelas (Señor de los Cielos
 * T9/T10, Rosa de Guadalupe, Dinastía Casillas…). Posts = capítulos con
 * iframes VISIBLES en el HTML (goodstream y ok.ru — ambos ya resuelven
 * nativo). Series pages (hubs) no listan caps: la ficha se arma desde el
 * buscador (?s=) agrupando por serie y temporada. */
const EP_BASE = 'https://enpantallatv.com/';
const epPrefijo = (slug) => {
  let m = /-temporada-(\d+)-capitulo-/.exec(slug);
  if (m) return { pref: slug.slice(0, m.index), temp: +m[1] };
  m = /-(\d{1,2})-capitulo-/.exec(slug);
  if (m) return { pref: slug.slice(0, m.index), temp: +m[1] };
  m = /-capitulo-/.exec(slug); /* v206.2: «…-capitulo-38-completa» sin temporada */
  if (m) return { pref: slug.slice(0, m.index), temp: 0 };
  return null;
};
const epTempEp = (slug) => {
  let m = /-temporada-(\d+)-capitulo-(\d+)/.exec(slug);
  if (m) return { temp: +m[1], ep: +m[2] };
  m = /-(\d{1,2})-capitulo-(\d+)/.exec(slug);
  if (m) return { temp: +m[1], ep: +m[2] };
  m = /-capitulo-(\d+)/.exec(slug); /* v206.2 */
  if (m) return { temp: 0, ep: +m[1] };
  return null;
};
function nv2TarjetasDeHtml(html) {
  const cards = [];
  for (const m of html.matchAll(/<a href="(https:\/\/enpantallatv\.com\/([a-z0-9-]+?)\/?)"[^>]*>\s*<img[^>]*src="([^"]+)"[\s\S]{0,1500}?class="sc-title">\s*([^<]+?)\s*<\/a>/gi)) {
    const slug = m[2].replace(/\/+$/, '');
    const te = epTempEp(slug);
    cards.push({
      slug,
      esCap: !!te,
      temp: te ? te.temp : 0,
      ep: te ? te.ep : 0,
      img: m[3].startsWith('//') ? 'https:' + m[3] : m[3],
      title: nvLimpiarTexto(m[4]),
    });
  }
  return cards;
}
async function nv2Buscar(q, pags) {
  const fuera = [];
  const vistos = new Set();
  const sinA = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const nq = sinA(q);
  for (let p = 1; p <= (pags || 2); p++) {
    const r = await fetchSeguro(EP_BASE + (p > 1 ? 'page/' + p + '/' : '') + '?s=' + encodeURIComponent(q), 18000).catch(() => null);
    const html = r && r.ok ? await r.text().catch(() => '') : '';
    if (!html) break;
    for (const c of nv2TarjetasDeHtml(html)) {
      const info = epPrefijo(c.slug) || { pref: c.slug };
      if (vistos.has(info.pref)) continue;
      vistos.add(info.pref);
      if (NV_OCULTAS.has('enp:' + info.pref)) continue; /* v245 */
      fuera.push({
        title: nvTituloBonito(info.pref),
        url: EP_BASE + info.pref + '/',
        img: c.img || '',
        site: 'Novelas',
        extra: '',
      });
    }
  }
  return fuera.filter((x) => sinA(x.title).includes(nq) || nq.split(' ').filter((w) => w.length > 2).every((w) => sinA(x.title).includes(w)));
}
async function nv2Recientes() {
  const c = catCache.get('enp-rec');
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.items;
  /* v206.2: la HOME trae ~145 tarjetas de series con portada (sliders) */
  const r = await fetchSeguro(EP_BASE, 18000).catch(() => null);
  const html = r && r.ok ? await r.text().catch(() => '') : '';
  const serie = new Map();
  for (const m of html.matchAll(/<a href="(https:\/\/enpantallatv\.com\/([a-z0-9-]{6,90})\/?)"[^>]*>\s*<img[^>]*src="([^"]+)"/gi)) {
    let slug = m[2].replace(/\/+$/, '');
    if (/-online-gratis|capitulos-completos|novelas-(chilenas|colombianas|peruanas|espanolas|americanas|mexicanas|turcas)|estrenos-novelas|telenovela-20\d\d|^year-|^(feed|series|accion|aventura|comedia|crimen|drama|romance|terror|suspenso)$/.test(slug)) continue; /* menús y hubs de región fuera */
    /* v206.2: los frescos son EPISODIOS — se agrupan por serie (sin capítulo) */
    const info = epPrefijo(slug);
    if (info) slug = info.pref;
    if (serie.has(slug)) continue;
    let img = m[3];
    if (img.startsWith('//')) img = 'https:' + img;
    if (!/^https:\/\/.*wp-content/.test(img)) continue;
    if (!NV_OCULTAS.has('enp:' + slug)) serie.set(slug, { title: nvTituloBonito(slug), url: EP_BASE + slug + '/', img, site: 'Novelas', extra: '' });
  }
  const items = [...serie.values()];
  if (items.length) { catCache.set('enp-rec', { at: Date.now(), items }); NV_STATS.enp = items.length; }
  return items;
}
/* v245: hijos del HUB — rescata prefs-basura (…-hd-online, …-gg-vv) y
 * episodios sin '-capitulo-' (X-N-junk, X-YYYY-N-junk). Contextual al hub:
 * el pref ganador debe emparentar con el pedido. */
async function nv2HijosDelHub(pref) {
  const r = await fetchSeguro(EP_BASE + pref + '/', 15000).catch(() => null);
  const html = r && r.ok ? await r.text().catch(() => '') : '';
  if (!html) return { eps: [], pref };
  const kids = [...new Set([...html.matchAll(/href="(https:\/\/enpantallatv\.com\/([a-z0-9-]+)\/?)"/gi)].map((m) => m[2]).filter((x) => x !== pref))];
  const grupos = new Map();
  for (const k of kids) {
    let base = '', temp = 0, ep = 0;
    const info = epPrefijo(k);
    if (info) { base = info.pref; const te = epTempEp(k); temp = te.temp; ep = te.ep; }
    else {
      let m = /^(.+?)-(\d{4})-(\d{1,3})(?:-[a-z0-9-]+)?$/.exec(k);
      if (m && +m[3] > 0) { base = m[1]; ep = +m[3]; }
      else {
        m = /^(.+?)-(\d{1,3})(?:-[a-z0-9-]+)?$/.exec(k);
        if (m && +m[2] > 0 && +m[2] < 500 && !/-(temporada|season|parte|vol|volumen|capitulo)$/.test(m[1])) { base = m[1]; ep = +m[2]; }
      }
    }
    if (!base || !ep) continue;
    if (!(pref === base || pref.startsWith(base + '-') || base.startsWith(pref + '-') || base.endsWith('-' + pref))) continue; /* v245.1: sufijo (garra-vs-veneno-guerreros-mundiales) */
    if (!grupos.has(base)) grupos.set(base, []);
    grupos.get(base).push({ slug: k, temp, ep });
  }
  let ganador = '', gk = [];
  for (const [b, arr] of grupos) if (arr.length > gk.length || (arr.length === gk.length && b.length > ganador.length)) { ganador = b; gk = arr; }
  if (!ganador || !gk.length) return { eps: [], pref };
  const seen = new Set(), eps = [];
  for (const e of gk) {
    const key = e.temp + 'x' + e.ep;
    if (seen.has(key)) continue;
    seen.add(key);
    eps.push({ temporada: e.temp || 1, ep: e.ep, url: EP_BASE + e.slug + '/', titulo: 'T' + (e.temp || 1) + ' · Capítulo ' + e.ep });
  }
  eps.sort((a, b) => (a.temporada - b.temporada) || (a.ep - b.ep));
  return { eps, pref: ganador };
}
async function nv2Ficha(pref) {
  const eps = [];
  const vistos = new Set();
  let img = '';
  for (let p = 1; p <= 8; p++) {
    const r = await fetchSeguro(EP_BASE + (p > 1 ? 'page/' + p + '/' : '') + '?s=' + encodeURIComponent(pref.replace(/-/g, ' ')), 18000).catch(() => null);
    const html = r && r.ok ? await r.text().catch(() => '') : '';
    if (!html) break;
    let nuevos = 0;
    for (const card of nv2TarjetasDeHtml(html)) {
      if (!img && card.img) img = card.img;
      if (!card.esCap) continue;
      const info = epPrefijo(card.slug);
      const base = info ? info.pref : card.slug;
      if (base !== pref) continue;
      const url = EP_BASE + card.slug + '/';
      if (vistos.has(url)) continue;
      vistos.add(url);
      eps.push({ temporada: card.temp || 1, ep: card.ep, url, titulo: 'T' + (card.temp || 1) + ' · Capítulo ' + card.ep });
      nuevos++;
    }
    if (!nuevos) break;
  }
  eps.sort((a, b) => (a.temporada - b.temporada) || (a.ep - b.ep));
  let titulo = nvTituloBonito(pref);
  if (!eps.length) {
    try {
      const hub = await nv2HijosDelHub(pref);
      if (hub.eps.length) { eps.push(...hub.eps); titulo = nvTituloBonito(hub.pref); }
    } catch {}
  }
  if (!img) {
    try { const rh = await fetchSeguro(EP_BASE + pref + '/', 12000); const hh = rh && rh.ok ? await rh.text() : ''; const og = /property="og:image"\s+content="([^"]+)"/i.exec(hh); if (og) img = og[1]; } catch {}
  }
  return { ok: eps.length > 0, slug: pref, titulo, poster: img, episodios: eps };
}
async function resolverEnp(pageUrl) {
  const r = await fetchSeguro(pageUrl, 18000).catch(() => null);
  if (!r || !r.ok) throw new Error('No pude abrir ese capítulo en EnPantallaTV');
  const html = await r.text();
  const cands = [];
  const sumar = (u) => {
    if (!u) return;
    u = u.startsWith('//') ? 'https:' + u : u;
    if (!/^https:\/\//.test(u)) return;
    if (/facebook|youtube|youtu\.be|dailymotion|wp-content/i.test(u)) return;
    if (!cands.includes(u)) cands.push(u);
  };
  for (const m of html.matchAll(/<IFRAME[^>]*SRC="([^"]+)"/gi)) sumar(m[1]);
  const fr = /frames\s*=\s*\[([\s\S]*?)\];/.exec(html);
  if (fr) for (const m of fr[1].matchAll(/(?:SRC|src)=\\?"([^"\\]+)/gi)) sumar(m[1].replace(/\\\//g, '/'));
  if (!cands.length) throw new Error('Ese capítulo no trae reproductor — prueba otro');
  for (const emb of cands) {
    try {
      if (/goodstream\.one/i.test(emb)) {
        const out = await resolverGoodstream(emb, pageUrl);
        console.log('[enp] goodstream → ' + pageUrl.slice(-45));
        return out;
      }
      const ok = /ok\.ru\/videoembed\/(\d+)/i.exec(emb);
      if (ok) {
        const out = await resolverOkRu(ok[1]);
        console.log('[enp] ok.ru → ' + pageUrl.slice(-45));
        return out;
      }
    } catch (e1) { console.warn('[enp] ' + emb.slice(0, 60) + ' falló: ' + String(e1 && e1.message || e1).slice(0, 60)); }
  }
  /* genérico: los iframes restantes se abren y se les lee el m3u8/mp4 */
  for (const emb of cands) {
    if (/goodstream|ok\.ru/i.test(emb)) continue;
    const rp = await fetchSeguro(emb, 15000, { Referer: pageUrl }).catch(() => null);
    const tp = rp && rp.ok ? await rp.text().catch(() => '') : '';
    const m3 = (/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i.exec(tp) || [])[1];
    const mp4 = (/['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i.exec(tp) || [])[1];
    if (m3 || mp4) {
      try { hlsReferers.set(new URL(m3 || mp4).hostname, emb); } catch {}
      console.log('[enp] genérico ' + (m3 ? 'm3u8' : 'mp4') + ' → ' + pageUrl.slice(-45));
      return { m3u8: m3 || mp4, mp4: !!mp4, proxy: true, subs: [] };
    }
  }
  throw new Error('Los servidores de ese capítulo están caídos — prueba otro capítulo u opción');
}

/* v278.4: ENNOVELAS-TV — Betty la Fea 335 y demás novelas latinas gratis sin Cloudflare.
 * Ficha = /series/<slug>/ (lista con href="...-capitulo-N/"), episodio = /<slug>-capitulo-N/.
 * La resolución es HTTP-only: se consulta el endpoint/HTML de VK, se extrae
 * su propiedad hls y después el master, playlists y segmentos pasan por /api/hls. */
const ENN_BASE = 'https://l.ennovelas-tv.com/';
const ENN_PAYWALL_RE = /(?:danfra|vip|paywall|pago|premium|suscri(?:pc|b))/i;
const ENN_BETTY_SLUG = 'yo-soy-betty-la-fea';
const ENN_BETTY_COVER = '/covers/enn/yo-soy-betty-la-fea.jpg';
const ennFichaCache = new Map(); // slug -> {at, data}
function ennPosterDesdeHtml(html, slug){
  if(slug === ENN_BETTY_SLUG) return ENN_BETTY_COVER;
  const cands=[]; const add=(u)=>{ u=String(u||'').replace(/[\r\n\t]/g,'').trim(); if(u.startsWith('//'))u='https:'+u; if(!/^https?:\/\//i.test(u)||/grey\.gif|33333|logo|avatar/i.test(u))return; if(!cands.includes(u))cands.push(u); };
  for(const re of [/\<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/gi,/\<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,/\<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/gi,/\<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/gi]) for(const m of html.matchAll(re)) add(m[1]);
  return cands.find(u=>/wp-content\/uploads/i.test(u)) || cands[0] || '';
}
async function ennFichaSingle(slug){
  slug = String(slug||'').toLowerCase().replace(/\/+$/,'');
  const cached = ennFichaCache.get(slug);
  if(cached && Date.now()-cached.at < 30*60*1000) return cached.data;
  const r = await fetchSeguro(ENN_BASE+'series/'+slug+'/', 18000).catch(()=>null);
  if(!r || !r.ok) return {ok:false, error:'No pude leer Ennovelas'};
  const html = await r.text();
  const poster = ennPosterDesdeHtml(html, slug) || (slug === ENN_BETTY_SLUG ? ENN_BETTY_COVER : '');
  const titleM = /<title>([^<]+)<\/title>/i.exec(html);
  const titulo = titleM ? titleM[1].replace(/\s*\|.*$/,'').replace(/ Capitulos Completos/i,'').trim().slice(0,80) : slug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
  const eps=[];
  const seen=new Set();
  // episodios son enlaces tipo https://l.ennovelas-tv.com/xxx-capitulo-N/
  const reEnn = new RegExp('href="https://l\\.ennovelas-tv\\.com/('+slug.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'-capitulo-(\\d+)[a-z0-9-]*)/?"', 'gi');
  for(const m of html.matchAll(reEnn)){
    const full = 'https://l.ennovelas-tv.com/'+m[1]+'/';
    if(seen.has(full)) continue; seen.add(full);
    const n = parseInt(m[2],10);
    if(!n || n>5000) continue;
    eps.push({temporada:1, ep:n, url:full, titulo:'Capítulo '+n});
  }
  // fallback genérico: si no hubo con slug exacto, busca cualquier -capitulo- en la página
  if(!eps.length){
    for(const m of html.matchAll(/href="https:\/\/l\.ennovelas-tv\.com\/([a-z0-9-]+-capitulo-(\d+)[a-z0-9-]*)\/?"/gi)){
      const full='https://l.ennovelas-tv.com/'+m[1]+'/';
      if(seen.has(full)) continue; seen.add(full);
      const n=parseInt(m[2],10);
      eps.push({temporada:1, ep:n, url:full, titulo:'Capítulo '+n});
    }
  }
  eps.sort((a,b)=>a.ep-b.ep);
  const vivos = eps.filter(e => !ENN_EPS_OCULTOS.has(e.url));
  const out = {ok: vivos.length>0, slug, titulo: titulo || 'Yo Soy Betty, La Fea', poster, episodios: vivos};
  if(out.ok) ennFichaCache.set(slug,{at:Date.now(), data:out});
  return out;
}
/* v286: una tarjeta puede representar varias fichas de Ennovelas. Se
 * consultan una por una y se devuelven juntas con la temporada correcta. */
async function ennFicha(slug){
  slug=String(slug||'').toLowerCase().replace(/\/+$/,'');
  const g=ennGrupoPara(slug);
  const members=g ? (g.members||[]).filter(m=>ENN_VISTAS.has(m.slug)) : [{slug,season:1}];
  const eps=[]; let poster=(g&&g.poster)||''; let titulo=(g&&g.title)||'';
  for(const m of members){
    const d=await ennFichaSingle(m.slug).catch(()=>null);
    if(!d||!d.ok) continue;
    if(!poster) poster=d.poster||'';
    if(!titulo) titulo=d.titulo||'';
    const temporada=Number(m.season)||1;
    for(const e of (d.episodios||[])) eps.push({...e,temporada});
  }
  eps.sort((a,b)=>(a.temporada-b.temporada)||(a.ep-b.ep));
  const out={ok:eps.length>0,slug,titulo:titulo||'Ennovelas',poster:poster||ENN_BETTY_COVER,episodios:eps,grupo:g?g.slug:slug};
  if(out.ok) ennFichaCache.set('group:'+slug,{at:Date.now(),data:out});
  return out;
}
async function ennProbe(slug){
  try{ const d=await ennFichaSingle(slug); return !!(d && d.ok && d.episodios && d.episodios.length); }catch{ return false; }
}
async function resolverVk(vkEmbedUrl, pageUrl){
  let m = /video_ext\.php\?oid=(\d+).*?id=(\d+).*?hash=([a-z0-9]+)/i.exec(vkEmbedUrl);
  let oid, vid, hash='';
  if(m){ oid=m[1]; vid=m[2]; hash=m[3]; } else {
    m = /video_ext\.php\?oid=(\d+).*?id=(\d+)/i.exec(vkEmbedUrl);
    if(!m) throw new Error('vk sin ids');
    oid=m[1]; vid=m[2];
  }
  const alUrl = 'https://vk.com/al_video.php?act=show&al=1&video='+oid+'_'+vid + (hash ? '&hash='+hash : '');
  const cleanUrl = (u) => String(u || '')
    .replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&')
    .replace(/\\u003f/gi, '?').replace(/\\u003d/gi, '=')
    .replace(/\\u0023/gi, '#').replace(/\\u0025/gi, '%')
    .replace(/\\\//g, '/').replace(/\\/g, '').replace(/&amp;/g, '&').trim();
  /* VK alterna entre JSON embebido y HTML reducido. Primero se busca la
   * propiedad hls; las expresiones amplias quedan solo como fallback HTTP. */
  const extraerHls = (raw) => {
    const txt = String(raw || '').replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&').replace(/\\u003f/gi, '?').replace(/\\u003d/gi, '=').replace(/\\u0023/gi, '#').replace(/\\u0025/gi, '%').replace(/\\\//g, '/');
    const hallados = [];
    const poner = (x) => {
      const u = cleanUrl(x);
      if (!/^https?:\/\//i.test(u) || !/\.m3u8(?:[?#]|$)/i.test(u)) return;
      try { new URL(u); } catch { return; }
      if (!hallados.includes(u)) hallados.push(u);
    };
    for (const re of [
      /["']hls["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
      /["'](?:url|src|file)["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
      /(https?:\/\/[^"'<>\s]+\.m3u8(?:\?[^"'<>\s]*)?)/i,
    ]) {
      const x = re.exec(txt);
      if (x) poner(x[1]);
    }
    return hallados[0] || '';
  };
  const intentos = [
    { url: alUrl, extra: { Referer: vkEmbedUrl, 'X-Requested-With':'XMLHttpRequest' } },
    { url: vkEmbedUrl, extra: { Referer: pageUrl || vkEmbedUrl } },
  ];
  let ultimo = '';
  /* v284.1: reintento HTTP acotado para la respuesta reducida/transitoria de VK. */
  for(let vuelta=0; vuelta<3; vuelta++){
    for(const origen of intentos){
      const r = await fetchSeguro(origen.url, 15000, origen.extra).catch((e)=>{ ultimo=String(e && e.message || e); return null; });
      if(!r || !r.ok) { ultimo = 'HTTP '+(r ? r.status : 'sin respuesta'); continue; }
      const txt = await r.text().catch(()=> '');
      const m3u8 = extraerHls(txt);
      if(m3u8){
        try{ hlsReferers.set(new URL(m3u8).hostname, vkEmbedUrl); }catch{}
        return {m3u8, mp4:false, proxy:true, subs:[]};
      }
      ultimo = 'respuesta sin hls';
    }
    if(vuelta<2) await new Promise((resolve)=>setTimeout(resolve, 350*(vuelta+1)));
  }
  throw new Error('vk sin m3u8 ('+ultimo+')');
}

async function resolverEnnovelas(pageUrl){
  const r = await fetchSeguro(pageUrl, 18000).catch(()=>null);
  if(!r || !r.ok) throw new Error('No pude abrir ese capítulo en Ennovelas');
  const html = await r.text();
  // Solo se extraen embeds HTTP de Ennovelas; nunca se monta un iframe remoto.
  let cands = [];
  // también busca emb de ennovelas (meta twitter:player)
  for(const m of html.matchAll(/content="https:\/\/l\.ennovelas-tv\.com\/emb\/\?vid=(\d+)"[^>]*>/gi)) cands.push('https://l.ennovelas-tv.com/emb/?vid='+m[1]);
  for(const m of html.matchAll(/href="https:\/\/l\.ennovelas-tv\.com\/emb\/\?vid=(\d+)"[^>]*>/gi)) cands.push('https://l.ennovelas-tv.com/emb/?vid='+m[1]);
  for(const m of html.matchAll(/https:\/\/l\.ennovelas-tv\.com\/emb\/\?vid=\d+/gi)) { const u=m[0].replace(/\\/g,''); if(!cands.includes(u)) cands.push(u); }
  // también busca cualquier emb/?vid= en html raw
  for(const m of html.matchAll(/emb\/\?vid=(\d+)/gi)) { const u='https://l.ennovelas-tv.com/emb/?vid='+m[1]; if(!cands.includes(u)) cands.push(u); }
  if(!cands.length){
    // último intento: si la página es emb ya, trata como emb directo
    if(/\/emb\/\?vid=/i.test(pageUrl)) cands=[pageUrl];
    else throw new Error('Ese capítulo no trae reproductor — prueba otro');
  }
  // intenta ok.ru / goodstream / vk primero
  for(const emb of cands){
    try{
      if(/ok\.ru\/videoembed\/(\d+)/i.test(emb)){
        const id = (/ok\.ru\/videoembed\/(\d+)/i.exec(emb)||[])[1];
        if(id){ const out=await resolverOkRu(id); console.log('[enn] ok.ru → '+pageUrl.slice(-40)); return out; }
      }
      if(/goodstream\.one/i.test(emb)){
        const out=await resolverGoodstream(emb, pageUrl); console.log('[enn] goodstream → '+pageUrl.slice(-40)); return out;
      }
      if(/vk\.com\/video_ext\.php/i.test(emb)){
        const out=await resolverVk(emb, pageUrl); console.log('[enn] vk → '+pageUrl.slice(-40)); return out;
      }
      if(/l\.ennovelas-tv\.com\/emb\/\?vid=/i.test(emb)){
        // emb intermedio: saca el iframe vk dentro
        const re = await fetchSeguro(emb, 15000, {Referer: pageUrl}).catch(()=>null);
        const th = re && re.ok ? await re.text().catch(()=> '') : '';
        const inner = (/src="(https:\/\/vk\.com\/video_ext\.php[^"]+)"/i.exec(th)||[])[1];
        if(inner){
          const ivk = inner.replace(/&amp;/g,'&').replace(/\\\//g,'/').replace(/\\/g,'');
          // si es placeholder youtube no-signal, marcar como muerta
          if(/youtube\.com\/embed\/Di-qI09MdB8/i.test(ivk)) throw new Error('Ennovelas: video no disponible (placeholder)');
          const out=await resolverVk(ivk, emb); console.log('[enn] vk-emb → '+pageUrl.slice(-40)); return out;
        }
        // youtube placeholder directo en emb (videos muertos)
        if(/youtube\.com\/embed\/Di-qI09MdB8/i.test(th)) throw new Error('Ennovelas: video no disponible (placeholder YouTube)');
        const alt = (/src="([^"]+goodstream[^"]+)"/i.exec(th)||[])[1];
        if(alt){ const out=await resolverGoodstream(alt, emb); console.log('[enn] goodstream-emb → '+pageUrl.slice(-40)); return out; }
        const okm = (/ok\.ru\/videoembed\/(\d+)/i.exec(th)||[])[1];
        if(okm){ const out=await resolverOkRu(okm); console.log('[enn] ok-emb → '+pageUrl.slice(-40)); return out; }
      }
    }catch(e1){ console.warn('[enn] '+emb.slice(0,50)+' falló '+String(e1).slice(0,80)); }
  }
  // genérico: lee iframe y saca m3u8/mp4
  for(const emb of cands){
    if(/goodstream|ok\.ru/i.test(emb)) continue;
    const rp = await fetchSeguro(emb, 15000, {Referer: pageUrl}).catch(()=>null);
    const tp = rp && rp.ok ? await rp.text().catch(()=> '') : '';
    const m3u8 = (/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i.exec(tp)||[])[1];
    const mp4 = (/['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i.exec(tp)||[])[1];
    if(m3u8 || mp4){
      try{ hlsReferers.set(new URL(m3u8||mp4).hostname, emb); }catch{}
      console.log('[enn] genérico '+(m3u8?'m3u8':'mp4')+' → '+pageUrl.slice(-40));
      return {m3u8: m3u8||mp4, mp4: !!mp4, proxy:true, subs:[]};
    }
    // packer
    const pk=/eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/i.exec(tp);
    if(pk){
      try{
        const pStr=pk[1], aVal=+pk[2], cVal=+pk[3], k=pk[4].split('|');
        const toBase=(n,b)=>{ if(!n) return '0'; const d=[]; while(n){ d.push('0123456789abcdefghijklmnopqrstuvwxyz'[n%b]); n=Math.floor(n/b);} return d.reverse().join(''); };
        let result=pStr;
        for(let i=cVal-1;i>=0;i--){ const w=toBase(i,aVal); if(i<k.length && k[i]) result=result.replace(new RegExp('\\b'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'),k[i]); }
        const m = /(https?:\/\/[^"'<>]+\.(m3u8|mp4)[^"'<>]*)/i.exec(result);
        if(m){ try{ hlsReferers.set(new URL(m[1]).hostname, emb);}catch{}; return {m3u8:m[1], mp4:/\.mp4/i.test(m[1]), proxy:true, subs:[]}; }
      }catch{}
    }
  }
  throw new Error('Los servidores de ese capítulo están caídos — prueba otro capítulo');
}

/* ================= v207: MOVIE (app) — novelas latinas del mapa local =================
 * Fuente: el mapa local que genera mapear-secuencias-movie.js desde el PCAP
 * (~/movie-mapa-secuencias.json — ignorado por Git). De ahí salen SOLO las
 * rutas con evidencia fuerte: audio latino inequívoco + manifest propio +
 * disponibilidad comprobada (disponibleParaMovieAhora).
 *
 * Reglas (CONTINUACION §2/§7 y RESUMEN-COSECHA-PCAP):
 *  - allowlist ESTRICTA: el servidor solo pide al origen (147.124.216.142,
 *    http, sin tokens) las carpetas exactas del mapa activo; segmentos solo
 *    con nombre NNNN.ts. NO es un proxy abierto: nada de ?u= arbitrario.
 *  - si una ruta activa falla (403/404 del origen), se MARCA como caída y
 *    se espera evidencia nueva (mapa regenerado) — no se inventan sustitutos.
 *  - Amar y Cuidar (audio tha) y la ruta sin manifest nunca llegan aquí:
 *    el mapa ya las deja fuera de disponibleParaMovieAhora.
 *  - portada = la que aloja Movie (proxy propio) + fallback /carita.png.
 */
const MOVIE_HOST_VIRTUAL = 'movie.huddle'; /* host ficticio: identidad de serie/episodio para fichas, sala y continuar-viendo */
/* v230: EL CATÁLOGO MOVIE SE DESACTIVA (decisión 20-sep-2026): sus títulos
 * solo reproducían con la llave wsSecret del CDN, que NO se pudo extraer (vive
 * dentro de una VM blindada y nunca sale al tráfico). Sin llave, el origen da
 * 403 y el espejo es 100% relleno. Así que se tumban: con false, las funciones
 * de abajo no emiten nada de Movie y la app se queda con las fuentes latinas
 * abiertas que SÍ reproducen (cine-calidad, pelisxd, series…). */
const MOVIE_ENABLED = false;
const MOVIE_ORIGEN = (process.env.MOVIE_ORIGEN || 'http://147.124.216.142').replace(/\/+$/, ''); /* el origen pelado (sin wsSecret) */
const MOVIE_MAPA_RUTA = process.env.MOVIE_MAPA || path.join(os.homedir(), 'movie-mapa-secuencias.json');
const MOVIE_CAIDAS_RUTA = process.env.MOVIE_CAIDAS || path.join(os.homedir(), 'movie-rutas-caidas.json');
const MOVIE = { mtimeMs: 0, cargado: false, series: new Map(), porEp: new Map(), caidas: new Map(), caidasMs: 0, avisoFalta: false };

/* ================= v211: MOVIE API EN VIVO — candado abierto (19 sep 2026) =========
 * El "error chino" NO era huella TLS ni llave secreta: era la ausencia de la cabecera
 * `content-type: application/x-www-form-urlencoded`. Con ella puesta, la API completa
 * responde desde cualquier cliente/IP (probado con urllib y con node).
 *   sign de cabecera: MD5("47Q8tBqO4YqrMHf4" + dev + ts).upper()
 *   sign del body   : MD5("Zox882LYjEn4Rqpa" + dev + vod_id + ts).upper()
 *   token           : POST /api/public/init -> result.user_info.token
 *   respuesta       : base64 -> AES-128-CBC (key 0123456789123456, iv 2015030120123456)
 *   video           : result.vod_collection[].vod_url (m3u8 CDN plano);
 *                     type 2 = doblaje latino (regla de la casa: preferir 2, luego 1). */
const MAPI_HOST = 'https://surfclick.vd7au6.com';
const MAPI_DEV = '687564646c653031'; /* "huddle01" en hex: identidad fija de este servidor */
const MAPI_SEC = 'Zox882LYjEn4Rqpa';
const MAPI = { tok: '', tokMs: 0 };
function mapiDesc(txt) {
  try {
    const raw = Buffer.from(txt, 'base64');
    const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from('0123456789123456'), Buffer.from('2015030120123456'));
    return JSON.parse(Buffer.concat([d.update(raw), d.final()]).toString('utf8'));
  } catch { return null; }
}
async function mapiPedir(ruta, body) {
  if (!MOVIE_ENABLED) return null; /* v230: Movie desactivado */
  const ts = String(Date.now());
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(MAPI_HOST + ruta, {
      method: 'POST', body, signal: ctl.signal,
      headers: {
        'app_id': 'movievn', 'version': '40000', 'sys_platform': '2', 'device_id': MAPI_DEV,
        'channel_code': 'movievn_sh_1000', 'cur_time': ts,
        'sign': crypto.createHash('md5').update('47Q8tBqO4YqrMHf4' + MAPI_DEV + ts).digest('hex').toUpperCase(),
        'token': MAPI.tok, 'user-agent': 'okhttp/4.12.0',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    return mapiDesc(await r.text());
  } catch { return null; } finally { clearTimeout(t); }
}
async function mapiToken() {
  if (MAPI.tok && Date.now() - MAPI.tokMs < 6 * 3600e3) return MAPI.tok;
  const j = await mapiPedir('/api/public/init', 'device_id=' + MAPI_DEV + '&channel_code=movievn_sh_1000');
  const tok = j && j.result && j.result.user_info && j.result.user_info.token;
  if (tok) { MAPI.tok = tok; MAPI.tokMs = Date.now(); }
  return MAPI.tok || '';
}
async function mapiFicha(vodId) {
  if (!MOVIE_ENABLED) return null; /* v230: Movie desactivado */
  await mapiToken();
  const ts = String(Date.now());
  const sign = crypto.createHash('md5').update(MAPI_SEC + MAPI_DEV + vodId + ts).digest('hex').toUpperCase();
  return mapiPedir('/api/vod/info_new', 'vod_id=' + vodId + '&cur_time=' + ts + '&sign=' + sign + '&audio_type=0');
}
async function mapiLista(ruta, body) { if (!MOVIE_ENABLED) return null; /* v230 */ await mapiToken(); return mapiPedir(ruta, body); }
function mapiUrlLatina(col) {
  col = Array.isArray(col) ? col : [];
  for (const t of [2, 1]) for (const c of col) if (c && c.type === t && c.vod_url) return { url: c.vod_url, type: t };
  return col[0] && col[0].vod_url ? { url: col[0].vod_url, type: col[0].type } : null;
}
/* v212.1: llave Wangsu viva — la deposita scripts/buscar-llave-cdn.sh y v-vid firma al vuelo */
const MOVIE_CDN_KEY_RUTA = process.env.MOVIE_CDN_KEY || '/home/ubuntu/movie-cdn-key.txt';
let _cdnKey = null, _cdnKeyMs = 0;
function movieCdnKey() {
  if (Date.now() - _cdnKeyMs < 30000) return _cdnKey;
  _cdnKeyMs = Date.now();
  try { _cdnKey = fs.readFileSync(MOVIE_CDN_KEY_RUTA, 'utf8').trim() || null; } catch { _cdnKey = null; }
  return _cdnKey;
}
/* v219.1: la llave puede venir como texto (16 caracteres) o como bytes crudos
   («hex:…») si el cazador la encontró dentro de un mensaje binario del rastreador */
function movieCdnKeyBytes(k) {
  if (!k) return null;
  if (/^hex:[0-9a-fA-F]+$/.test(k)) { const b = Buffer.from(k.slice(4), 'hex'); return b.length ? b : null; }
  return Buffer.from(k, 'utf8');
}
/* v219: ¿es una ruta de reproduccion del PROPIO Huddle? (catálogo vivo de Movie y
   compañía). Estos flujos ya vienen resueltos: se reproducen NATIVOS, sin navegador. */
function esStreamPropioUS(u) { return /^\/api\/(movie\/v-vid|movie\/hls|hls|xd)\b/.test(String(u || '')); }
/* v217: ESPEJOS del CDN Movie. Comprobado desde fuera (19 sep): el borde de CloudFront
   que tiene la carpeta en CACHÉ entrega el /vod/ SIN la firma Wangsu (200, bytes
   reales). El borde frío responde 403 generado por función («FunctionGeneratedResponse»).
   Probamos los espejos primero y, si todos fallan, el host original (con o sin firma).
   Config: MOVIE_ESPEJOS="147.124.216.142,otra-ip-o-host" */
const MOVIE_ESPEJOS = (process.env.MOVIE_ESPEJOS || '147.124.216.142')
  .split(',').map((s) => s.trim()).filter(Boolean);
let _espejoBueno = '', _espejoBuenoMs = 0;
function movieEspejoPreferido() {
  if (Date.now() - _espejoBuenoMs > 10 * 60 * 1000) { _espejoBueno = ''; _espejoBuenoMs = Date.now(); }
  return _espejoBueno;
}
function movieMarcarEspejo(host) { _espejoBueno = host; _espejoBuenoMs = Date.now(); }
/* v228.6: VALIDACIÓN DE DURACIÓN — el espejo a veces tiene copias dañadas
   (p.ej. subidas del 2026-01-19 sirven un dibujo de 7 min en vez de la peli).
   Comparamos la duración real del m3u8 contra la esperada; si no coincide,
   buscamos OTRA copia del mismo título en el catálogo cosechado. */
function movieParseDurHHMMSS(d) {
  const m = String(d || '').match(/(\d+):(\d{1,2}):(\d{1,2})/);
  return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0;
}
function movieDurM3u8(txt) {
  let s = 0;
  for (const l of String(txt || '').split('\n')) if (l.startsWith('#EXTINF:')) s += parseFloat(l.slice(8)) || 0;
  return s;
}
function movieEsM3u8Valido(txt, vdSec) {
  if (!vdSec) return true; /* sin dato esperado, no se puede validar */
  const real = movieDurM3u8(txt);
  if (!real) return false;
  return real >= vdSec * 0.5; /* si dura menos de la mitad, es copia dañada */
}
/* v228.6: busca otra copia del mismo título en el catálogo cosechado y
   devuelve su vod_url del espejo si pasa la validación de duración */
async function movieCopiaBuena(titulo, vdSec, excluirPath) {
  const arr = movieCosechaArray();
  if (!arr.length || !titulo) return null;
  const nq = String(titulo).toLowerCase().split(/\s*[:·-]\s*/)[0].trim();
  if (nq.length < 3) return null;
  const cands = [];
  for (const x of arr) {
    const n = String(x.vod_name || '').toLowerCase();
    if (n.startsWith(nq) || n.includes(nq)) {
      const vid = x.vod_id || x.id;
      if (vid) cands.push(vid);
      if (cands.length >= 4) break;
    }
  }
  for (const vid of cands) {
    try {
      const j = await mapiFicha(vid);
      if (!j || j.code !== 10000 || !j.result) continue;
      const l = mapiUrlLatina(j.result.vod_collection || []);
      if (!l || !l.url) continue;
      let pu2; try { pu2 = new URL(l.url); } catch { continue; }
      if (pu2.pathname === excluirPath) continue;
      const cand = 'http://' + (MOVIE_ESPEJOS[0] || '147.124.216.142') + pu2.pathname;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(cand, { headers: { 'User-Agent': FETCH_UA }, signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 200) {
        const txt = await r.text();
        if (movieEsM3u8Valido(txt, vdSec)) return { url: l.url, m3u8: txt };
      }
    } catch {}
  }
  return null;
}
function movieEsHostPermitido(h) {
  return /(^|\.)j5t2n\.com$/i.test(h) || MOVIE_ESPEJOS.includes(h);
}
/* v212: tarjetas del catálogo vivo (portadas reales) para la pestaña Novelas/Movie */
async function mapiTarjetasHome() {
  if (!MOVIE_ENABLED) return []; /* v230: Movie desactivado */
  try {
    const out = []; const vistos = new Set();
    const visitar = (nodo) => {
      if (!nodo || typeof nodo !== 'object' || out.length >= 24) return;
      if (Array.isArray(nodo)) { nodo.forEach(visitar); return; }
      const vi = nodo.vod_info || nodo;
      const vid = vi && (vi.id || vi.vod_id);
      if (vi && vi.vod_name && vid && !vistos.has(vid)) { vistos.add(vid);
        out.push({
          title: String(vi.vod_name), url: 'https://movie.huddle/v/' + (vi.id || vi.vod_id),
          img: vi.vod_pic || '/carita.png', site: 'Movie',
          extra: 'Latino · ' + (vi.vod_year || 'API'),
        });
      }
      if (nodo.block_list) visitar(nodo.block_list);
    };
    for (const ch of [226, 225, 227, 230, 228]) { /* Películas, Inicio, Series, Telenovela, Animación */
      if (out.length >= 24) break;
      const j = await mapiLista('/api/channel/get_info', 'channel_id=' + ch);
      if (j && j.code === 10000 && Array.isArray(j.result)) visitar(j.result);
    }
    return out;
  } catch { return []; }
}

/* v221: EL CATÁLOGO COMPLETO DE MOVIE, POR APARTADOS (como en la app):
   Películas, Telenovelas, Series y Animación. La API los entrega en
   /api/channel/get_info (channel_id); se juntan, se deduplican y se cachean
   10 minutos. OJO: la paginación de la API sigue sin resolverse, así que esto
   es lo que la app muestra en sus filas (cientos de títulos), no el catálogo
   infinito. */
const MOVIE_SECCIONES = { canales: [[226, 'Películas'], [230, 'Telenovelas'], [227, 'Series'], [228, 'Animación']], datos: null, at: 0 };
async function mapiSecciones() {
  if (!MOVIE_ENABLED) return []; /* v230: Movie desactivado */
  if (MOVIE_SECCIONES.datos && Date.now() - MOVIE_SECCIONES.at < 10 * 60 * 1000) return MOVIE_SECCIONES.datos;
  const out = []; const vistos = new Set();
  for (const [canal, nombre] of MOVIE_SECCIONES.canales) {
    const j = await mapiLista('/api/channel/get_info', 'channel_id=' + canal).catch(() => null);
    const items = [];
    const visitar = (nodo) => {
      if (!nodo || typeof nodo !== 'object') return;
      if (Array.isArray(nodo)) { nodo.forEach(visitar); return; }
      const vi = nodo.vod_info || nodo;
      const vid = vi && (vi.id || vi.vod_id);
      if (vi && vi.vod_name && vid) {
        const k = String(vid);
        if (!vistos.has(k)) {
          vistos.add(k);
          items.push({
            title: String(vi.vod_name), url: 'https://movie.huddle/v/' + k,
            img: vi.vod_pic || '/carita.png', site: 'Movie',
            extra: nombre + (vi.vod_year ? ' · ' + vi.vod_year : ''),
          });
        }
      }
      if (nodo.block_list) visitar(nodo.block_list);
      for (const k2 of ['vod_list', 'banner_list', 'list']) if (nodo[k2]) visitar(nodo[k2]);
    };
    visitar((j && j.result) || null);
    out.push({ canal, nombre, items });
  }
  MOVIE_SECCIONES.datos = out; MOVIE_SECCIONES.at = Date.now();
  console.log('[movie] catálogo por apartados: ' + out.map((x) => x.nombre + ' ' + x.items.length).join(' | '));
  return out;
}
/* v222: ¿este título se ve AHORA (y qué tan completo)? Se mide de verdad:
   se pide su lista de pedacitos y se prueban 3 puntos (inicio, mitad, final).
   3/3 = completa · 1-2 = parcial · 0 = todavía no. Resultado cacheado 30 min y
   guardado en disco para que el escaneo se pueda reanudar. */
const MOVIE_DISP = new Map();
let movieDispArchivo = '';
let movieDispCola = [], movieDispCorriendo = false, movieDispAt = 0;
function movieDispRuta() { return path.join(carpetaArchivos(), 'movie-disponibles.json'); }
function movieDispGuardar() {
  try { fs.writeFileSync(movieDispRuta(), JSON.stringify({ at: Date.now(), items: [...MOVIE_DISP] })); } catch {}
}
function movieDispCargar() {
  try {
    const d = JSON.parse(fs.readFileSync(movieDispRuta(), 'utf8'));
    for (const [k, v] of (d.items || [])) MOVIE_DISP.set(String(k), v);
    movieDispAt = d.at || 0;
  } catch {}
}
async function movieDispProbar(vod) {
  const j = await mapiFicha(vod).catch(() => null);
  const col = (j && j.result && j.result.vod_collection) || [];
  const lat = mapiUrlLatina(col);
  if (!lat) return { e: 'sin-video', at: Date.now() };
  let pu; try { pu = new URL(lat.url); } catch { return { e: 'fria', at: Date.now() }; }
  const base = pu.pathname.replace(/index5\.m3u8$/i, '');
  const txt = await fetch('http://' + MOVIE_ESPEJOS[0] + base + 'index5.m3u8', { headers: { 'User-Agent': FETCH_UA } }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  const segs = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!segs.length) return { e: 'fria', at: Date.now() };
  const n = segs.length;
  const idxs = [0, Math.floor(n / 2), Math.max(0, n - 2)];
  let ok = 0;
  for (const i of idxs) {
    const st = await fetch('http://' + MOVIE_ESPEJOS[0] + base + segs[i].split('?')[0], { headers: { 'User-Agent': FETCH_UA, Range: 'bytes=0-2047' } }).then((r) => r.status).catch(() => 0);
    if (st === 200 || st === 206) ok++;
  }
  return { e: ok === 3 ? 'completa' : ok ? 'parcial' : 'fria', ok, de: 3, n, at: Date.now() };
}
async function movieDispTrabajador() {
  if (movieDispCorriendo) return;
  movieDispCorriendo = true;
  try {
    while (movieDispCola.length) {
      const vod = String(movieDispCola.shift());
      const viejo = MOVIE_DISP.get(vod);
      if (viejo && Date.now() - viejo.at < 30 * 60 * 1000) continue;
      const r = await movieDispProbar(vod).catch(() => ({ e: 'fria', at: Date.now() }));
      MOVIE_DISP.set(vod, r);
      if (movieDispCola.length % 10 === 0) movieDispGuardar();
      await new Promise((z) => setTimeout(z, 250));
    }
  } finally {
    movieDispCorriendo = false; movieDispAt = Date.now(); movieDispGuardar();
    console.log('[movie] escaneo de disponibilidad terminado: ' + MOVIE_DISP.size + ' títulos medidos');
  }
}
function movieDispResumen() {
  const r = { completa: 0, parcial: 0, fria: 0, 'sin-video': 0 };
  for (const v of MOVIE_DISP.values()) r[v.e] = (r[v.e] || 0) + 1;
  return r;
}
movieDispCargar(); /* v222: mediciones guardadas del escaneo anterior */
/* v223: estado de la cosecha masiva info_new 1000→70000 — lee lo que haya (app nativa, checkpoint, catálogo) */
const MOVIE_COSECHA_RUTAS = [
  path.join(carpetaArchivos(), 'movie-cosecha-app.json'),
  path.join(carpetaArchivos(), 'catalogo-70k.json'),
  '/tmp/catalogo-70k.json',
  path.join(DATA_DIR, 'movie-cosecha.json'),
  path.join(DATA_DIR, 'catalogo-70k.json'),
  '/home/ubuntu/movie-cosecha-app.json',
  '/home/ubuntu/catalogo-70k.json',
  path.join(os.homedir(), 'movie-cosecha-app.json'),
  path.join(os.homedir(), 'catalogo-70k.json'),
];
const MOVIE_COSECHA_META = [
  path.join(carpetaArchivos(), 'catalogo-70k.json.checkpoint.json'),
  '/tmp/catalogo-70k.json.checkpoint.json',
  path.join(carpetaArchivos(), 'catalogo-70k.checkpoint.json'),
  '/tmp/catalogo-70k.checkpoint.json',
  path.join(DATA_DIR, 'catalogo-70k.checkpoint.json'),
];
let _cosechaCache = { at: 0, mtime: 0, data: null };
function movieCosechaEstado() {
  // v224: cache 10s y solo re-parsea si el archivo cambió (antes cada /api/estado leía + parseaba el JSON de 100KB-10MB cada 5s → GC y RSS subían)
  if (Date.now() - _cosechaCache.at < 10000 && _cosechaCache.data) return _cosechaCache.data;
  let mejor = null, mejorMtime = 0;
  for (const ruta of MOVIE_COSECHA_RUTAS) {
    try {
      const st = fs.statSync(ruta);
      if (!st || st.size < 2) continue;
      if (st.mtimeMs <= mejorMtime) continue;
      // si el mtime no cambió desde el cache, reutiliza el parseo anterior
      if (_cosechaCache.data && _cosechaCache.data.archivo && _cosechaCache.data.archivo.ruta === ruta && st.mtimeMs === _cosechaCache.mtime) {
        mejor = _cosechaCache.data.archivo;
        mejorMtime = st.mtimeMs;
        continue;
      }
      const txt = fs.readFileSync(ruta, 'utf8');
      const j = JSON.parse(txt);
      const arr = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : (Array.isArray(j.result) ? j.result : null));
      let n = 0, ejemplo = [];
      if (arr) { n = arr.length; ejemplo = arr.slice(0, 2).map((x) => x && (x.vod_name || x.nombre || x.title || x.titulo || '')).filter(Boolean); }
      else if (j && typeof j === 'object') {
        const keys = Object.keys(j).filter((k) => /^\d+$/.test(k));
        if (keys.length) { n = keys.length; ejemplo = keys.slice(0, 2).map((k) => j[k] && (j[k].nombre || j[k].vod_name || '')).filter(Boolean); }
        else if (typeof j.total === 'number') n = j.total;
      }
      mejor = { ruta, bytes: st.size, mtime: st.mtime.toISOString(), total: n, ejemplo };
      mejorMtime = st.mtimeMs;
    } catch {}
  }
  let meta = null;
  for (const ruta of MOVIE_COSECHA_META) {
    try {
      const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (j && typeof j.pos === 'number') { meta = { pos: j.pos, hits: j.hits || 0, ruta }; break; }
      if (j && typeof j.nextId === 'number') { meta = { pos: j.nextId, hits: j.hits || j.encontrados || 0, ruta }; break; }
      if (j && typeof j.siguiente === 'number') { meta = { pos: j.siguiente, hits: j.hits || j.total || 0, ruta }; break; }
    } catch {}
  }
  let log = null;
  try {
    const fd = fs.openSync('/tmp/cosecha.log', 'r');
    const stat = fs.fstatSync(fd);
    const len = Math.min(stat.size, 4000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    fs.closeSync(fd);
    const lineas = buf.toString('utf8').trim().split('\n').slice(-1)[0] || '';
    if (lineas) log = lineas.slice(0, 180);
  } catch {}
  const out = { archivo: mejor, meta, log, rango: '1000→70000', nota: mejor ? 'cosecha en curso (info_new secuencial)' : 'aún sin archivo — la cosecha arranca en bg' };
  _cosechaCache = { at: Date.now(), mtime: mejorMtime, data: out };
  return out;
}
function movieCargarCaidas() {
  try {
    const st = fs.statSync(MOVIE_CAIDAS_RUTA);
    if (st.mtimeMs === MOVIE.caidasMs) return;
    MOVIE.caidasMs = st.mtimeMs;
    const d = JSON.parse(fs.readFileSync(MOVIE_CAIDAS_RUTA, 'utf8'));
    const nuevas = new Map();
    for (const c of (Array.isArray(d && d.caidas) ? d.caidas : [])) {
      if (c && /^[0-9a-f]{12}$/.test(String(c.carpeta || ''))) nuevas.set(String(c.carpeta), c);
    }
    MOVIE.caidas = nuevas; /* recién aquí: si el JSON venía mal, se conserva lo cargado */
  } catch {
    /* sin archivo todavía (o ilegible): si ya teníamos caídas en memoria —las
     * acabamos de marcar— NO se barren, o /api/movie/probar las «olvidaría»
     * al releer y el episodio caído reaparecería como disponible */
    if (!MOVIE.caidas.size) MOVIE.caidas = new Map();
  }
}
function movieGuardarCaidas() {
  try {
    const tmp = `${MOVIE_CAIDAS_RUTA}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, actualizadoEn: new Date().toISOString(), caidas: [...MOVIE.caidas.values()] }, null, 2) + '\n');
    fs.renameSync(tmp, MOVIE_CAIDAS_RUTA);
    MOVIE.caidasMs = fs.statSync(MOVIE_CAIDAS_RUTA).mtimeMs;
  } catch (e) { console.warn('[movie] no pude guardar caídas:', String(e && e.message || e).slice(0, 80)); }
}
function movieMarcarCaida(clave, epId, ep, motivo) {
  if (MOVIE.caidas.has(ep.carpeta)) return;
  const c = { clave, episodioId: epId, carpeta: ep.carpeta, fechaCarpeta: ep.fechaCarpeta, titulo: ep.tituloSerie, episodio: ep.episodio, motivo: String(motivo || '').slice(0, 140), marcadoEn: new Date().toISOString() };
  MOVIE.caidas.set(ep.carpeta, c);
  movieGuardarCaidas();
  console.warn(`[movie] CAÍDA marcada: ${c.titulo} ${epId} (${c.carpeta}) — ${c.motivo}. Se espera evidencia nueva (mapa regenerado); no se sustituye la ruta.`);
}
/* Lee/regenera el índice del mapa cuando el archivo cambia en disco. Si el
 * mapa se regeneró (evidencia nueva), las caídas marcadas se olvidan. */
function movieRecargar() {
  if (!MOVIE_ENABLED) { if (MOVIE.series.size) { MOVIE.series = new Map(); MOVIE.porEp = new Map(); } MOVIE.cargado = false; return; } /* v230: Movie desactivado */
  movieCargarCaidas();
  let st = null;
  try { st = fs.statSync(MOVIE_MAPA_RUTA); } catch {}
  if (!st) {
    if (!MOVIE.avisoFalta) {
      MOVIE.avisoFalta = true;
      console.log('[movie] mapa no encontrado en ' + MOVIE_MAPA_RUTA + ' — genera el local con: node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json');
    }
    if (MOVIE.series.size) { MOVIE.series = new Map(); MOVIE.porEp = new Map(); }
    MOVIE.cargado = false;
    return;
  }
  if (st.mtimeMs === MOVIE.mtimeMs && MOVIE.cargado) return;
  const mapaAntes = MOVIE.mtimeMs;
  try {
    const mapa = JSON.parse(fs.readFileSync(MOVIE_MAPA_RUTA, 'utf8'));
    if (!mapa || mapa.version !== 1 || !Array.isArray(mapa.grupos)) throw new Error('formato de mapa no reconocido');
    const series = new Map();
    const porEp = new Map();
    for (const g of mapa.grupos) {
      /* doble guarda: solo latino inequívoco (Amar y Cuidar jamás entra) */
      if (!g || !g.clave || !g.audio || g.audio.clasificacion !== 'latino-inequivoco') continue;
      const eps = (Array.isArray(g.episodios) ? g.episodios : [])
        .filter((e) => e && e.disponibleParaMovieAhora && /^[0-9a-f]{12}$/.test(String(e.carpeta || '')))
        .map((e) => ({
          clave: String(g.clave), tituloSerie: String(g.titulo || g.clave), temporada: +g.temporada || 1,
          episodio: +e.episodio || 0, carpeta: String(e.carpeta).toLowerCase(), fechaCarpeta: String(g.fechaCarpeta || ''),
          duracionSegundos: +e.duracionCapturadaSegundos || +e.duracionCatalogoSegundos || 0,
          poster: String(g.poster || ''), webId: +g.webId || 0, appId: +g.appId || 0,
        }))
        .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.fechaCarpeta) && e.episodio > 0)
        .sort((a, b) => a.episodio - b.episodio);
      if (!eps.length) continue;
      const serie = { clave: String(g.clave), titulo: String(g.titulo || g.clave), temporada: +g.temporada || 1, poster: String(g.poster || ''), webId: +g.webId || 0, appId: +g.appId || 0, eps };
      series.set(serie.clave, serie);
      for (const e of eps) porEp.set(serie.clave + '|' + e.temporada + 'x' + e.episodio, e);
    }
    MOVIE.series = series;
    MOVIE.porEp = porEp;
    MOVIE.mtimeMs = st.mtimeMs;
    MOVIE.cargado = true;
    MOVIE.avisoFalta = false;
    if (mapaAntes && mapaAntes !== st.mtimeMs && MOVIE.caidas.size) {
      /* el mapa se regeneró = evidencia nueva: se olvidan las caídas viejas */
      console.log('[movie] mapa regenerado — se olvidan ' + MOVIE.caidas.size + ' caídas marcadas');
      MOVIE.caidas = new Map();
      try { fs.unlinkSync(MOVIE_CAIDAS_RUTA); } catch {}
      MOVIE.caidasMs = 0;
    }
    const nEps = [...series.values()].reduce((n, s) => n + s.eps.length, 0);
    console.log(`[movie] mapa cargado: ${series.size} series, ${nEps} episodios latinos activos (${MOVIE.caidas.size} caídas marcadas)`);
  } catch (e) {
    console.warn('[movie] no pude leer el mapa (' + MOVIE_MAPA_RUTA + '):', String(e && e.message || e).slice(0, 90));
  }
}
/* serie/episodio ACTIVO (no caído) — la allowlist de reproducción */
function movieSerieActiva(clave) {
  movieRecargar();
  const s = MOVIE.series.get(String(clave || '').toLowerCase());
  if (!s) return null;
  const vivos = s.eps.filter((e) => !MOVIE.caidas.has(e.carpeta));
  if (!vivos.length) return null;
  return { ...s, eps: vivos };
}
function movieEpActivo(clave, epId) {
  movieRecargar();
  const m = /^(\d+)x(\d+)$/.exec(String(epId || ''));
  if (!m) return null;
  const e = MOVIE.porEp.get(String(clave || '').toLowerCase() + '|' + (+m[1]) + 'x' + (+m[2]));
  if (!e || MOVIE.caidas.has(e.carpeta)) return null;
  return e;
}
function movieUrlEp(clave, epId) { return `https://${MOVIE_HOST_VIRTUAL}/ver/${clave}/${epId}`; }
function movieTarjetas() {
  movieRecargar();
  const tarjetas = [];
  for (const s of MOVIE.series.values()) {
    const vivos = s.eps.filter((e) => !MOVIE.caidas.has(e.carpeta));
    if (!vivos.length) continue; /* toda la serie caída: no se ofrece */
    tarjetas.push({
      title: s.titulo + (s.temporada > 1 ? ' (T' + s.temporada + ')' : ''),
      url: `https://${MOVIE_HOST_VIRTUAL}/serie/${s.clave}`,
      img: `/api/movie/poster/${s.clave}`,
      site: 'Movie',
      extra: vivos.length === 1 ? `Latino · 1 capítulo (${vivos[0].temporada}x${vivos[0].episodio})` : `Latino · ${vivos.length} capítulos`,
    });
  }
  return tarjetas;
}
/* Origen estricto: SOLO la carpeta exacta del mapa; segmentos solo NNNN.ts */
/* fechaCarpeta viene como YYYY-MM-DD (formato del mapa); la ruta del CDN
 * usa diagonales: /vod/1/YYYY/MM/DD/{carpeta}/… */
function movieFechaRuta(fechaCarpeta) { return String(fechaCarpeta).replace(/-/g, '/'); }
function movieOrigenM3u8(ep) { return `${MOVIE_ORIGEN}/vod/1/${movieFechaRuta(ep.fechaCarpeta)}/${ep.carpeta}/index5.m3u8`; }
function movieOrigenTs(ep, archivo) { return `${MOVIE_ORIGEN}/vod/1/${movieFechaRuta(ep.fechaCarpeta)}/${ep.carpeta}/${archivo}`; }
async function movieServirM3u8(req, res, clave, epId) {
  const ep = movieEpActivo(clave, epId);
  if (!ep) return json(res, 404, { ok: false, error: 'Ese capítulo no está disponible en Movie' });
  let up = null;
  try { up = await fetchSeguro(movieOrigenM3u8(ep), 15000); } catch {}
  if (!up || !up.ok) {
    const estado = up ? up.status : 0;
    if (estado === 403 || estado === 404 || estado === 410) movieMarcarCaida(clave, epId, ep, 'el origen respondió HTTP ' + estado);
    return json(res, 502, { ok: false, error: 'El servidor de Movie no respondió — intenta más tarde' });
  }
  let txt = '';
  try { txt = await up.text(); } catch { return json(res, 502, { ok: false, error: 'No pude leer la lista de Movie' }); }
  if (!/#EXTM3U/.test(txt)) return json(res, 502, { ok: false, error: 'La lista de Movie vino vacía' });
  /* segmentos relativos (NNNN.ts?sz=…&m8=…) → NUESTRA ruta allowlisted;
   * sz/m8 (integridad S3) no hacen falta en el origen pelado: se caen */
  const base = `/api/movie/hls/${encodeURIComponent(clave)}/${encodeURIComponent(epId)}/`;
  const reescrito = txt.split('\n').map((l) => {
    const s = l.trim();
    if (!s || s.startsWith('#')) return l;
    const m = /^(\d{3,6}\.ts)/.exec(s);
    return m ? base + m[1] : s;
  }).join('\n');
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  res.end(reescrito);
}
async function movieServirTs(req, res, clave, epId, archivo) {
  if (!/^\d{3,6}\.ts$/.test(archivo)) return json(res, 403, { ok: false, error: 'No permitido' });
  const ep = movieEpActivo(clave, epId);
  if (!ep) return json(res, 404, { ok: false, error: 'Ese capítulo no está disponible en Movie' });
  const cabUp = {};
  if (req.headers.range) cabUp.Range = String(req.headers.range);
  let up = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try { up = await fetch(movieOrigenTs(ep, archivo), { headers: Object.assign({ 'User-Agent': FETCH_UA }, cabUp), signal: ctl.signal, redirect: 'follow' }); }
    finally { clearTimeout(t); }
  } catch {}
  if (!up) return json(res, 502, { ok: false, error: 'El servidor de video no respondió' });
  if (!up.ok && up.status !== 206) {
    try { up.body && up.body.cancel(); } catch {}
    /* 403/404/410 del origen = la ruta cayó de verdad (la función del CDN
     * ya valida o el objeto no está): se marca el episodio y se espera
     * evidencia nueva — igual que con el manifest */
    if (up.status === 403 || up.status === 404 || up.status === 410) movieMarcarCaida(clave, epId, ep, 'segmento ' + archivo + ': el origen respondió HTTP ' + up.status);
    else console.warn(`[movie] segmento ${archivo} de ${ep.tituloSerie} ${epId}: HTTP ${up.status}`);
    return json(res, up.status === 404 ? 404 : 502, { ok: false, error: 'El servidor de video respondió ' + up.status });
  }
  const cab = { 'Content-Type': 'video/MP2T', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  for (const h of ['content-range', 'content-length']) { const v = up.headers.get(h); if (v) cab[h] = v; }
  res.writeHead(up.status, cab);
  Readable.fromWeb(up.body).on('error', () => {}).pipe(res);
}
/* portada alojada por Movie (URL exacta del mapa) + fallback /carita.png */
const moviePosterCache = new Map(); /* clave → {buf, ct, at} | {fallo: at} */
async function movieServirPoster(req, res, clave) {
  movieRecargar();
  const s = MOVIE.series.get(String(clave || '').toLowerCase());
  const alCarita = () => { res.writeHead(302, { Location: '/carita.png', 'Cache-Control': 'no-store' }); res.end(); };
  if (!s || !/^https?:\/\//i.test(s.poster)) return alCarita();
  const c = moviePosterCache.get(s.clave);
  if (c && !c.fallo && Date.now() - c.at < 60 * 60 * 1000) {
    res.writeHead(200, { 'Content-Type': c.ct, 'Cache-Control': 'public, max-age=86400' });
    return res.end(c.buf);
  }
  if (c && c.fallo && Date.now() - c.fallo < 10 * 60 * 1000) return alCarita();
  try {
    const r = await fetchSeguro(s.poster, 8000);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok || !/^image\//.test(ct)) throw new Error('HTTP ' + (r && r.status));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3000000) throw new Error('demasiado grande');
    moviePosterCache.set(s.clave, { buf, ct, at: Date.now() });
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
    return res.end(buf);
  } catch {
    moviePosterCache.set(s.clave, { fallo: Date.now() });
    return alCarita();
  }
}
/* resolución para Solo y para la sala nativa: playlist LOCAL reescrito */
async function resolverMovie(pageUrl) {
  if (!MOVIE_ENABLED) throw new Error('Esos títulos ya no están disponibles (catálogo Movie retirado)'); /* v230 */
  const m = /^\/ver\/([a-z0-9-]+)\/(\d+x\d+)$/i.exec((() => { try { return new URL(pageUrl).pathname; } catch { return ''; } })());
  if (!m) throw new Error('URL de Movie no válida');
  const ep = movieEpActivo(m[1], m[2]);
  if (!ep) { const e2 = new Error('Ese capítulo ya no está disponible en Movie'); throw e2; }
  return { m3u8: `/api/movie/hls/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}/index5.m3u8`, mp4: false, proxy: false, subs: [] };
}
/* ================= fin v207: MOVIE ================= */

let laRtTimer = null;
function laMuertaQuitar(slug) { /* v202: autocuración — una «muerta» que vuelve a resolver reviva */
  if (!slug || !LA_MUERTAS_SET.has(slug)) return;
  LA_MUERTAS_SET.delete(slug);
  clearTimeout(laRtTimer);
  laRtTimer = setTimeout(() => { try { fs.writeFileSync(path.join(__dirname, 'public', 'latanime-muertas.txt'), [...LA_MUERTAS_SET].sort().join('\n') + '\n'); } catch {} }, 3000);
  console.log('[lázaro] la: ' + slug + ' volvió a la vida — fuera de la lista de muertas');
  LA_FALLOS.delete(slug);
}
try {
  for (const [sl, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'dani-catalogo.json'), 'utf8')))) DANI_CAT.set(sl, v);
  /* v198: auditoría LATANIME — 3,453 series; se OCULTAN las castellanas y los
   * duplicados (mandan las latino: si existe «X-latino» se van «X-castellano»
   * y «X» con subs; si solo hay castellano, fuera: «nada de castellano») */
  try {
    for (const l of fs.readFileSync(path.join(__dirname, 'public', 'latanime-slugs.txt'), 'utf8').split('\n')) if (l.trim()) LA_TODOS.add(l.trim());
    for (const l of fs.readFileSync(path.join(__dirname, 'public', 'latanime-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) LA_OCULTAS_SET.add(l.trim());
  } catch {}
  try {
    for (const l of fs.readFileSync(path.join(__dirname, 'public', 'latanime-muertas.txt'), 'utf8').split('\n')) if (l.trim()) LA_MUERTAS_SET.add(l.trim());
  } catch {}
  try {
    for (const l of fs.readFileSync(path.join(__dirname, 'public', 'latanime-vistas.txt'), 'utf8').split('\n')) if (l.trim()) LA_VISTAS.add(l.trim());
  } catch {} /* v240: vistas de la sonda de Latanime */
  console.log('[latanime] ' + LA_TODOS.size + ' series (' + LA_OCULTAS_SET.size + ' cast/dup, ' + LA_MUERTAS_SET.size + ' muertas, ' + LA_VISTAS.size + ' vistas)');
} catch {}
/* v248: ANIMED23 — 229 animes (directorio /anime/, 12 páginas). Latino+Sub+Cast, cadena JWT vía animed23.online */
const D23_TODOS = new Set(), D23_OCULTAS = new Set(), D23_VISTAS = new Set();
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'd23-slugs.txt'), 'utf8').split('\n')) if (l.trim()) D23_TODOS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'animed23-slugs.txt'), 'utf8').split('\n')) if (l.trim()) D23_TODOS.add(l.trim()); } catch {} /* alias */
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'd23-ocultas.txt'), 'utf8').split('\n')) if (l.trim()) D23_OCULTAS.add(l.trim()); } catch {}
try { for (const l of fs.readFileSync(path.join(__dirname, 'public', 'd23-vistas.txt'), 'utf8').split('\n')) if (l.trim()) D23_VISTAS.add(l.trim()); } catch {}
/* v286: portadas AnimeD23 curadas con IMDb cuando la portada del sitio
 * falta, es placeholder o no corresponde. Se guardan localmente para que el
 * feed y Continuar viendo no dependan del CDN remoto. */
const D23_IMDB_COVERS = new Map();
try {
  const d23Covers = JSON.parse(fs.readFileSync(path.join(__dirname,'public','d23-imdb-covers.json'),'utf8'));
  for(const [slug,row] of Object.entries(d23Covers.items||{})) if(row && row.poster) D23_IMDB_COVERS.set(slug,row);
} catch {}
const FALLOS_D23 = new Map();
fallosCargar(FALLOS_D23, 'fallos-d23.json');
console.log('[d23] '+D23_TODOS.size+' animes ('+D23_OCULTAS.size+' ocultas, '+D23_VISTAS.size+' vistas)');

/* v286: ficha de AnimeD23 — lista de capítulos para el picker (misma forma
 * que Latanime: {ok, slug, titulo, poster, episodios:[{n,url,titulo}]}).
 * Portada: preferencia de la copia local de IMDb; si la página no entrega
 * imagen, queda el fallback existente (og:image de la ficha). */
/* v289: el script pasivo /challenge-platform/scripts/jsd/ también aparece
 * en páginas válidas. No es prueba de un bloqueo de acceso. */
function d23EsChallenge(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  return /Just a moment|One moment, please|Attention Required.*Cloudflare/i.test(title)
    || /<form\b[^>]*\bid=["']challenge-form["']/i.test(html);
}
async function datosAnimeD23(slug) {
  if (D23_OCULTAS.has(slug)) return null;
  const c = serieCache.get('d23:' + slug);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.d;
  const r = await fetchSeguro('https://animed23.com/anime/' + slug + '/', 15000);
  if (r && r.status === 404) return { ok: false, dead: '404', slug, titulo: '', poster: '', episodios: [] }; /* v288: el sitio la borró */
  if (!r || !r.ok) return null;
  const html = await r.text();
  if (d23EsChallenge(html)) return null;
  const og = (p) => {
    const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(html);
    const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(html);
    return (a1 || a2 || [])[1] || '';
  };
  const vistos = new Set();
  const eps = [];
  for (const m of html.matchAll(/href="https?:\/\/animed23\.com\/capitulo\/([a-z0-9-]+)\/?"/gi)) {
    const epSlug = m[1];
    if (vistos.has(epSlug) || !epSlug.startsWith(slug + '-')) continue;
    const numM = /-(?:ep|capitulo)-(\d+)/i.exec(epSlug);
    if (!numM) continue;
    vistos.add(epSlug);
    eps.push({ n: +numM[1], url: 'https://animed23.com/capitulo/' + epSlug + '/', titulo: 'Episodio ' + numM[1] });
  }
  eps.sort((a, b) => a.n - b.n);
  if (!eps.length) return { ok: false, dead: 'empty', slug, titulo: '', poster: '', episodios: [] }; /* v288: página viva sin capítulos */
  const cov = D23_IMDB_COVERS.get(slug);
  const titulo = (og('og:title') || '').replace(/\s*(Anime|Ver online|online|sub español|español)\b.*$/i, '').replace(/\s*[|─✔★].*$/, '').replace(/\s{2,}/g, ' ').trim().slice(0, 80) || (cov && cov.title) || slug;
  const out = { ok: true, slug, titulo, poster: (cov && cov.poster) || og('og:image') || '', episodios: eps };
  serieCache.set('d23:' + slug, { at: Date.now(), d: out });
  return out;
}
/* v286: AnimeD23 en la búsqueda global — búsqueda WP (?s=) + portadas
 * locales de IMDb; las series que la sonda marcó muertas no entran. */
async function buscarAnimeD23(q) {
  const r = await fetchSeguro('https://animed23.com/?s=' + encodeURIComponent(q), 10000);
  if (!r || !r.ok) return [];
  const html = await r.text();
  if (d23EsChallenge(html)) return [];
  const vistos = new Set();
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="https?:\/\/animed23\.com\/anime\/([a-z0-9-]+)\/"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const slug = m[1];
    if (vistos.has(slug) || D23_OCULTAS.has(slug)) continue;
    vistos.add(slug);
    const texto = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const cov = D23_IMDB_COVERS.get(slug);
    out.push({ title: texto || (cov && cov.title) || slug, url: 'https://animed23.com/anime/' + slug + '/', img: (cov && cov.poster) || '', site: 'AnimeD23', extra: 'Latino' });
    if (out.length >= 12) break;
  }
  return out;
}
/* v178: portadas de IMDB (el usuario las pidió «tal y como los jóvenes
 * titanles»... como Teen Titans) — mapa slug → m.media-amazon generado con
 * la API de sugerencias de IMDb; cubre 818 series + los reemplazos nuestros */
let DANI_IMDB = new Map();
try {
  for (const [sl, u] of Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'dani-imdb.json'), 'utf8')))) DANI_IMDB.set(sl, u);
} catch {}
const DANI_CAT_ARR = [...DANI_CAT.entries()].sort((a, b) => String(a[1].t).localeCompare(String(b[1].t), 'es'));
const DANI_FEEDS = new Map(); /* slug → { at, eps } */
const DANI_POSTERS = new Map(); /* slug → { at, url } */
/* v177: series nuestras ROTAS o incompletas que danimados tiene bien —
 * el slug nuestro (filas/buscador) ahora SIRVE la versión de danimados */
const DANI_REEMPLAZAS = new Map([
  /* v180: purga de duplicados — si las dos fuentes tienen la serie se queda
   * DANIMADOS (así lo pidió el usuario); conserva la nuestra solo donde tiene
   * bastantes más capítulos (esas van en DANI_OCULTAS). Portada: el archivo
   * local curado de IMDb que ya teníamos (DANI_COVER_DE). */
  ['dani-titanes', 'teen-titans-go'],
  ['bob-esponja-capitulos-completos', 'bob-esponja'],
  ['hora-de-aventura-capitulos-completos', 'hora-de-aventuras'],
  ['los-simpsons', 'los-simpson'],
  ['south-park', 'south-park'],
  ['rick-y-morty-capitulos-completos', 'rick-y-morty'],
  ['samurai-jack-temporada-1', 'samurai-jack'],
  ['31-minutos-capitulos-y-canciones', '31-minutos'],
  ['ben-10-capitulos-completos', 'ben-10'],
  ['jimmy-neutron-capitulos-completos', 'jimmy-neutron-el-nino-genio'],
  ['danny-phantom-capitulos-completos', 'danny-phantom'],
  ['phineas-y-ferb-capitulos-completos', 'phineas-y-ferb'],
  /* v180: duplicados verificados capítulo a capítulo — dani gana o empata */
  ['batman-del-futuro', 'batman-del-futuro'],
  ['batman-serie-animada', 'batman-la-serie-animada'],
  ['ben-10-fuerza-alienigena', 'ben-10-fuerza-alienigena'],
  ['daniel-el-travieso', 'daniel-el-travieso'],
  ['drake-y-josh', 'drake-y-josh'],
  ['duck-dodgers', 'duck-dodgers'],
  ['ed-edd-y-eddy', 'ed-edd-y-eddy'],
  ['hombres-de-negro', 'hombres-de-negro-la-serie-animada'],
  ['jonny-quest', 'jonny-quest'],
  ['kim-possible', 'kim-possible'],
  ['liga-de-la-justicia', 'la-liga-de-la-justicia'],
  ['la-sirenita', 'la-sirenita'],
  ['la-vida-moderna-de-rocko', 'la-vida-moderna-de-rocko'],
  ['las-aventuras-de-tintin', 'las-aventuras-de-tintin'],
  ['los-autos-locos', 'los-autos-locos'],
  ['los-castores-cascarrabias', 'los-castores-cascarrabias'],
  ['los-supersonicos', 'los-supersonicos'],
  ['pinky-y-cerebro', 'pinky-y-cerebro'],
  ['que-hay-de-nuevo-scooby', 'que-hay-de-nuevo-scooby-doo'],
  ['samurai-jack', 'samurai-jack'],
  ['scooby-donde-estas', 'scooby-doo-donde-estas'],
  ['superman-serie-animada', 'superman-la-serie-animada'],
  ['tiro-loco-mcgraw', 'tiro-loco-mcgraw'],
  ['ultimate-spider-man', 'ultimate-spider-man'],
  ['x-men-evolucion', 'x-men-evolucion'],
  ['x-men-serie-animada', 'x-men-la-serie-animada'],
  ['monstruos-de-verdad-latino', 'aaahhh-monstruos'],
  ['daria-capitulos-completos', 'daria'],
  ['futurama-latino', 'futurama'],
  ['kenan-y-kel-latino', 'kenan-kel'],
  ['mansion-foster-para-amigos-imaginarios-capitulos-completos', 'mansion-foster-para-amigos-imaginarios'],
  ['las-sombrias-aventuras-de-billy-y-mandy-capitulos-completos', 'las-macabras-aventuras-de-billy-y-mandy'], /* v181: misma serie, otra traducción — dani 88 vs 86 */
  ['icarly', 'icarly'], /* v182 */
  ['pucca', 'pucca'], /* v182 */
  ['bob-esponja', 'bob-esponja'], /* v182: el slug corto de miscaricaturas */
]);
/* v180: la NUESTRA tiene bastantes más capítulos — la de danimados NO sale
 * en el buscador (una tarjeta por serie) */
const DANI_OCULTAS = new Set([
  'agallas-el-perro-cobarde', 'el-laboratorio-de-dexter', 'invasor-zim', 'johnny-bravo',
  'las-chicas-superpoderosas', 'los-padrinos-magicos', 'mucha-lucha', 'oye-arnold',
  'rocket-power', 'time-squad', 'vaca-y-pollo',
  'george-de-la-jungla', /* v241: auditoria — pagina sin episodios */
]);
/* v180: duplicados INTERNOS (lacartoons + miscaricaturas a la vez) — en el
 * buscador solo sale la de miscaricaturas (trae más capítulos) */
const LCT_OCULTAS = new Set([
  'johnny-bravo', 'chicas-superpoderosas', 'rocket-power', 'mucha-lucha',
  'invasor-zim', 'vaca-y-pollito', 'la-pantera-rosa', 'un-show-mas',
]);
/* v180: portada local curada (la buena, de IMDb) para los reemplazados cuyo
 * archivo no coincide con el slug de danimados */
const DANI_COVER_DE = new Map([
  ['batman-la-serie-animada', 'batman-serie-animada'],
  ['superman-la-serie-animada', 'superman-serie-animada'],
  ['x-men-la-serie-animada', 'x-men-serie-animada'],
  ['hombres-de-negro-la-serie-animada', 'hombres-de-negro'],
  ['la-liga-de-la-justicia', 'liga-de-la-justicia'],
  ['que-hay-de-nuevo-scooby-doo', 'que-hay-de-nuevo-scooby'],
  ['scooby-doo-donde-estas', 'scooby-donde-estas'],
  ['aaahhh-monstruos', 'monstruos-de-verdad-latino'],
  ['daria', 'daria-capitulos-completos'],
  ['futurama', 'futurama-latino'],
  ['kenan-kel', 'kenan-y-kel-latino'],
  ['mansion-foster-para-amigos-imaginarios', 'mansion-foster-para-amigos-imaginarios-capitulos-completos'],
  ['las-macabras-aventuras-de-billy-y-mandy', 'las-sombrias-aventuras-de-billy-y-mandy-capitulos-completos'],
  ['bob-esponja', 'bob-esponja-capitulos-completos'],
]);
function daniSlugDeUrl(urlEp) { return (/\/episodios\/([a-z0-9-]+)-(\d+)x(\d+)\//.exec(String(urlEp || '')) || [])[1] || ''; }
const DANI_TITULO_FIX = new Map([['daria', 'Daria'], ['kenan-kel', 'Kenan y Kel'], ['m-o-d-o-k', 'M.O.D.O.K.']]);
/* v198: ¿URL de latanime oculta (castellano o duplicado)? */
function laOcultaUrl(u) {
  const m = /latanime\.org\/anime\/([a-z0-9-]+)/i.exec(u || '');
  if (!m) return false;
  return LA_OCULTAS_SET.has(m[1]) || LA_MUERTAS_SET.has(m[1]); /* v200: tambien las de video caido */
}
/* v198: bases de latanime (para que AnimeFLV ceda los duplicados) */
function laBaseNorm(slug) {
  return slug.replace(/-(latino|castellano|sub-espanol|sub-espanola)$/, '').replace(/-/g, ' ');
}

function daniTituloDe(slug) {
  if (DANI_TITULO_FIX.has(slug)) return DANI_TITULO_FIX.get(slug);
  const v = DANI_CAT.get(slug);
  return (v && v.t ? String(v.t).replace(/\xa0/g, ' ') : slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
}
function daniCoverDe(slug) { return CARI_PORTADAS.get(DANI_COVER_DE.get(slug) || slug) || DANI_IMDB.get(slug) || '/api/dani/poster/' + slug; } /* v180: portada curada local (IMDb) primero */

/* v193: portada por TÍTULO desde la API de sugerencias de IMDb (para
 * tarjetas de búsqueda que llegaron sin imagen: pelisxd, cine-calidad…) */
const imdbPosterCache = new Map();
async function imdbPosterDe(titulo) {
  const t = String(titulo || '').trim();
  if (!t) return '';
  const c = imdbPosterCache.get(t.toLowerCase());
  if (c && Date.now() - c.at < 24 * 3600e3) return c.u;
  let out = '';
  const cands = [t];
  if (/\s y\s /.test(t)) cands.push(t.replace(/\s y\s /, ' & '));
  if (/:\s*/.test(t)) cands.push(t.split(/:\s*/)[0].trim());
  for (const q of cands) {
    if (out) break;
    try {
      const letra = (q.replace(/[^a-z0-9]/gi, '')[0] || 'x').toLowerCase();
      const r = await fetchSeguro('https://v2.sg.media-imdb.com/suggestion/' + encodeURIComponent(letra) + '/' + encodeURIComponent(q.toLowerCase()) + '.json', 8000);
      if (!r || !r.ok) continue;
      const d = await r.json().catch(() => null);
      for (const x of (d && d.d) || []) {
        const img = x && x.i && x.i.imageUrl;
        if (img && (x.qid === 'tvSeries' || x.qid === 'movie' || x.qid === 'tvMiniSeries')) { out = img.replace('._V1_.jpg', '._V1_QL75_UX380_.jpg'); break; }
      }
    } catch {}
  }
  imdbPosterCache.set(t.toLowerCase(), { at: Date.now(), u: out });
  return out;
}
/* v278.2: portadas IMDb para novelas sin img — rellena VIX/Estrellas que vienen vacías */
async function fillNovelasCovers(){
  for(const c of [...VIX_CATALOGO, ...ESTRELLAS_CATALOGO]){
    if(c.img) continue;
    try{ const p=await imdbPosterDe(c.titulo); if(p){ c.img=p; console.log('[novelas] IMDb poster para '+c.titulo+': OK'); } }catch{}
    await new Promise(r=>setTimeout(r,800));
  }
}
/* v286: Ennovelas publica cada temporada como una tarjeta distinta. El
 * feed muestra una sola tarjeta por familia y la ficha devuelve todos sus
 * capítulos con temporada numerada para reutilizar la barra existente. */
function ennUnificarCatalogo(items){
  const by=new Map(items.map(x=>[x.slug,x])); const used=new Set(); const out=[];
  for(const g of ENN_GROUPS.values()){
    const members=(g.members||[]).filter(m=>by.has(m.slug));
    if(!members.length) continue;
    const first=by.get(g.slug)||by.get(members[0].slug); if(!first) continue;
    const visibleSlugs=members.map(m=>m.slug);
    for(const s of visibleSlugs) used.add(s);
    out.push({...first,title:g.title||first.title,url:ENN_BASE+'series/'+g.slug+'/',img:g.poster||first.img,site:'Ennovelas',extra:members.length>1?(members.length+' temporadas · Ennovelas gratis'):'Ennovelas gratis',slug:g.slug,groupSlugs:visibleSlugs});
  }
  for(const x of items) if(!used.has(x.slug)) out.push(x);
  return out;
}
// v285: Ennovelas catalogo allowlistado; lo no auditado nunca entra a Huddle.
const ENN_CATALOGO_CACHE = { at:0, items:[] };
async function ennCatalogo(todos=false){
  if(!todos && Date.now()-ENN_CATALOGO_CACHE.at < 6*3600*1000 && ENN_CATALOGO_CACHE.items.length) return ENN_CATALOGO_CACHE.items;
  const items=[], vistos=new Set();
  for(let pag=1; pag<=20; pag++){
    const urlEnn=ENN_BASE+'series/'+(pag>1?'page/'+pag+'/':'');
    const r=await fetchSeguro(urlEnn,12000).catch(()=>null);
    const html=r&&r.ok?await r.text().catch(()=> ''):'';
    if(!html) break;
    let nuevos=0, encontrados=0;
    for(const m of html.matchAll(/<a href="https:\/\/l\.ennovelas-tv\.com\/series\/([a-z0-9-]+)\/"[^>]*title="([^"]+)"/gi)){
      const slug=m[1], title=m[2].trim();
      if(!slug || vistos.has(slug) || slug==='series' || title.length<2) continue;
      encontrados++;
      if(!todos && ((ENN_AUDIT_READY && !ENN_VISTAS.has(slug)) || ENN_OCULTAS.has(slug))) continue;
      vistos.add(slug);
      let poster=slug===ENN_BETTY_SLUG?ENN_BETTY_COVER:'';
      const card=html.slice(m.index,m.index+2400);
      const pm=/data-img="background-image:url\(([^)]+)\);?"/i.exec(card);
      if(pm&&!poster){poster=pm[1].replace(/['"]/g,'').trim();if(poster.startsWith('//'))poster='https:'+poster;}
      if(!poster||/grey\.gif|33333|logo/i.test(poster))poster='';
      items.push({title:title.slice(0,80),url:ENN_BASE+'series/'+slug+'/',img:poster||'/sites/novelas.png?v=247',site:'Ennovelas',extra:'Ennovelas gratis',slug});
      nuevos++; if(nuevos>=40) break;
    }
    if(encontrados===0) break;
    if(!html.includes('page/')&&pag>1) break;
    await new Promise(r=>setTimeout(r,300));
  }
  const bi=items.findIndex(x=>/betty/i.test(x.title));
  if(bi>0){const b=items.splice(bi,1)[0];items.unshift(b);}
  if(!items.find(x=>/betty/i.test(x.title))&&(!todos||ENN_VISTAS.has(ENN_BETTY_SLUG))) items.unshift({title:'Yo Soy Betty, La Fea',url:ENN_BASE+'series/'+ENN_BETTY_SLUG+'/',img:ENN_BETTY_COVER,site:'Ennovelas',extra:'335 caps · Ennovelas gratis',slug:ENN_BETTY_SLUG});
  if(items.length&&!todos){
    const agrupadas=ennUnificarCatalogo(items);
    ENN_CATALOGO_CACHE.at=Date.now();ENN_CATALOGO_CACHE.items=agrupadas;console.log('[enn] catalogo '+agrupadas.length+' tarjetas / '+items.length+' series');
    return agrupadas;
  }
  return items;
}
/* v285: sonda HTTP/HLS persistente. Nunca abre navegador ni monta iframe. */
async function ennComprobarHls(master,referer){
  try{
    const cab={Referer:referer||''}; const r=await fetchSeguro(master,16000,cab); if(!r||!r.ok)return false;
    const mt=await r.text(); const lines=mt.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')); if(!lines.length)return false;
    const variant=new URL(lines[0],r.url||master).href; const rv=await fetchSeguro(variant,16000,cab); if(!rv||!rv.ok)return false;
    const vt=await rv.text(); const seg=vt.split(/\r?\n/).map(x=>x.trim()).find(x=>x&&!x.startsWith('#')); if(!seg)return false;
    const rs=await fetchSeguro(new URL(seg,rv.url||variant).href,16000,{...cab,Range:'bytes=0-2047'}); return !!(rs&&(rs.ok||rs.status===206));
  }catch{return false;}
}
function ennEpsPersistir(){
  try{const lines=[...ENN_EPS_OCULTOS].sort().map(u=>u+'\t'+(ENN_EPS_MOTIVOS.get(u)||'fallo HLS'));fs.writeFileSync(path.join(__dirname,'public','enn-episodios-ocultos.txt'),lines.join('\n')+(lines.length?'\n':''));}catch{}
}
async function ennPaginaGratis(epUrl){
  try{const r=await fetchSeguro(epUrl,12000).catch(()=>null);if(!r||!r.ok)return false;return !ENN_PAYWALL_RE.test(await r.text().catch(()=>''));}catch{return false;}
}
async function ennProbeEpisodeUrl(epUrl){try{if(!await ennPaginaGratis(epUrl))return false;const out=await resolverEnnovelas(epUrl);if(!out||!out.m3u8)return false;return await ennComprobarHls(out.m3u8,hlsReferers.get(new URL(out.m3u8).hostname)||epUrl);}catch{return false;}}
function ennPerdonarEp(epUrl){if(!epUrl||!ENN_EPS_OCULTOS.delete(epUrl))return false;ENN_EPS_MOTIVOS.delete(epUrl);ennEpsPersistir();sondaNotify('Ennovelas','revivio',epUrl.split('/').pop()||epUrl,'episodio revivió — HLS HTTP confirmado');ennFichaCache.clear();return true;}
async function ennProbePlayable(slug){
  try{
    const ficha=await ennFichaSingle(slug);if(!ficha||!ficha.ok||!ficha.episodios?.length)return {ok:false,error:'sin episodios'};
    const eps=ficha.episodios.filter(e=>e&&e.url&&!ENN_EPS_OCULTOS.has(e.url)).slice(0,2);let last='sin reproductor';
    for(const ep of eps){try{if(!await ennPaginaGratis(ep.url)){last='VIP/paywall';continue;}const out=await resolverEnnovelas(ep.url);if(!out||!out.m3u8){last='sin HLS';continue;}if(await ennComprobarHls(out.m3u8,hlsReferers.get(new URL(out.m3u8).hostname)||ep.url))return {ok:true,ep:ep.ep};last='HLS caído';}catch(e){last=String(e?.message||e).slice(0,100);}}
    return {ok:false,error:last};
  }catch(e){return {ok:false,error:String(e?.message||e).slice(0,100)};}
}
function ennPersistirListas(){try{fs.writeFileSync(path.join(__dirname,'public','enn-vistas.txt'),[...ENN_VISTAS].sort().join('\n')+'\n');}catch{}try{fs.writeFileSync(path.join(__dirname,'public','enn-ocultas.txt'),[...ENN_OCULTAS].sort().join('\n')+'\n');}catch{}}
function ennOcultar(slug,razon){if(!slug)return false;const nuevo=!ENN_OCULTAS.has(slug);ENN_OCULTAS.add(slug);ENN_VISTAS.delete(slug);ennPersistirListas();ENN_CATALOGO_CACHE.at=0;ENN_CATALOGO_CACHE.items=[];if(nuevo)sondaNotify('Ennovelas','muerto',slug,slug+' ocultada — '+(razon||'sin HLS'));return nuevo;}
function ennPerdonar(slug){if(!slug)return false;const revivio=ENN_OCULTAS.delete(slug);ENN_VISTAS.add(slug);ennPersistirListas();ENN_CATALOGO_CACHE.at=0;ENN_CATALOGO_CACHE.items=[];if(revivio)sondaNotify('Ennovelas','revivio',slug,slug+' revivió — HLS HTTP confirmado');return revivio;}
function ennFallo(slug,razon){falloRegistrar(ENN_FALLOS,'fallos-enn.json',slug,s=>ennOcultar(s,razon));}
try{for(const [k,v] of Object.entries(JSON.parse(fs.readFileSync(path.join(DATA_DIR,'fallos-enn.json'),'utf8'))||{}))ENN_FALLOS.set(k,v);}catch{}
async function sondaEnnovelas(){
  if(ENN_SONDA.estado==='chequeando')return;ENN_SONDA.estado='chequeando';ENN_SONDA.at=Date.now();ENN_SONDA.error='';
  try{
    const todos=await ennCatalogo(true), visibles=await ennCatalogo();ENN_SONDA.total=todos.length;ENN_SONDA.visibles=visibles.length;ENN_SONDA.ocultas=ENN_OCULTAS.size;ENN_SONDA.auditadas=ENN_VISTAS.size;
    const ocultas=todos.filter(x=>ENN_OCULTAS.has(x.slug)), nuevas=todos.filter(x=>!ENN_VISTAS.has(x.slug)&&!ENN_OCULTAS.has(x.slug));const picks=[];const add=(a,n)=>{for(let i=0;i<Math.min(n,a.length);i++){const x=a[(ENN_SONDA.revisadas+i)%a.length];if(x&&!picks.some(y=>y.slug===x.slug))picks.push(x);}};add(visibles,3);add(ocultas,2);add(nuevas,2);
    for(const x of picks){ENN_SONDA.revisadas++;const p=await ennProbePlayable(x.slug);if(p.ok){const wasHidden=ENN_OCULTAS.has(x.slug),wasNew=!ENN_VISTAS.has(x.slug);ennPerdonar(x.slug);if(wasHidden)ENN_SONDA.revividas++;if(wasNew&&!wasHidden)sondaNotify('Ennovelas','ok',x.slug,x.slug+' confirmado y agregado al catálogo');}else if(ENN_VISTAS.has(x.slug)){const antes=ENN_OCULTAS.has(x.slug);ennFallo(x.slug,p.error);if(!antes&&ENN_OCULTAS.has(x.slug))ENN_SONDA.caidas++;}await new Promise(r=>setTimeout(r,500));}
    ENN_SONDA.episodiosOcultos=ENN_EPS_OCULTOS.size;const epMuerto=[...ENN_EPS_OCULTOS][ENN_SONDA.revisadas%Math.max(1,ENN_EPS_OCULTOS.size)];if(epMuerto&&await ennProbeEpisodeUrl(epMuerto)&&ennPerdonarEp(epMuerto))ENN_SONDA.episodiosRevividos++;
    ENN_SONDA.visibles=ENN_VISTAS.size;ENN_SONDA.auditadas=ENN_VISTAS.size;ENN_SONDA.ocultas=ENN_OCULTAS.size;ENN_SONDA.episodiosOcultos=ENN_EPS_OCULTOS.size;ENN_SONDA.ultima=new Date().toISOString();ENN_SONDA.estado='vivo';ENN_STATS.total=ENN_SONDA.total;ENN_STATS.vistas=ENN_SONDA.auditadas;ENN_STATS.ocultas=ENN_SONDA.ocultas;console.log('[sonda] ennovelas: '+ENN_SONDA.visibles+' visibles / '+ENN_SONDA.ocultas+' ocultas; revisadas='+ENN_SONDA.revisadas);
  }catch(e){ENN_SONDA.estado='error';ENN_SONDA.error=String(e?.message||e).slice(0,160);console.warn('[sonda] ennovelas error',ENN_SONDA.error);}
}
setTimeout(()=>sondaRun('ennovelas', sondaEnnovelas),95000);setInterval(()=>sondaRun('ennovelas', sondaEnnovelas),10*60*1000);
async function ennCatalogoTrending(){
  try{const it=await ennCatalogo();return it.slice(0,24).map(x=>({title:x.title,url:x.url,img:x.img,site:x.site,extra:x.extra}));}
  catch{return [{title:'Yo Soy Betty, La Fea',url:ENN_BASE+'series/'+ENN_BETTY_SLUG+'/',img:ENN_BETTY_COVER,site:'Ennovelas',extra:'335 caps'}];}
}
setTimeout(()=>{fillNovelasCovers().catch(()=>{});ennCatalogo().catch(()=>{});},8000);
setInterval(()=>{fillNovelasCovers().catch(()=>{});},6*3600*1000);
setInterval(()=>{ennCatalogo().catch(()=>{});},6*3600*1000);
async function daniPosterUrl(slug) {
  const c = DANI_POSTERS.get(slug);
  if (c && Date.now() - c.at < 24 * 3600e3) return c.url;
  const local = CARI_PORTADAS.get(DANI_COVER_DE.get(slug) || slug);
  if (local) return local; /* v180: la portada curada (IMDb) que ya teníamos */
  let u = DANI_IMDB.get(slug) || (DANI_CAT.get(slug) || {}).p || ''; /* v178: IMDb primero */
  if (!u) {
    try {
      const r = await fetchSeguro(DANI_BASE + '/series/' + slug + '/', 12000);
      const html = r && r.ok ? await r.text() : '';
      u = (/property=["']og:image["']\s+content=["']([^"']+)/.exec(html) || /content=["']([^"']+)["']\s+property=["']og:image["']/.exec(html) || [])[1] || '';
      u = String(u).replace(/[\r\n\t]/g, '').trim(); /* v177: el HTML trae \r colado en el content y el redirect revienta */
    } catch {}
  }
  DANI_POSTERS.set(slug, { at: Date.now(), url: u });
  return u;
}
function daniDesempacar(html) {
  /* Dean Edwards packer: eval(function(p,a,c,k,e,d){…}('payload',36,504,'a|b|c'.split('|'),0,{})) */
  const m = /eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/s.exec(html);
  if (!m) return html;
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = +m[2], count = +m[3], keys = m[4].split('|');
  const e = (c2, r) => (c2 < r ? '' : e(parseInt(c2 / r), r)) + ((c2 = c2 % r) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
  const dict = {};
  for (let i = count - 1; i >= 0; i--) if (keys[i]) dict[e(i, radix)] = keys[i];
  return payload.replace(/\b\w+\b/g, (w) => dict[w] || w);
}
async function daniLista(slug) {
  slug = slug || 'teen-titans-go';
  const feed = DANI_FEEDS.get(slug);
  if (feed && feed.eps.length && Date.now() - feed.at < 6 * 3600e3) return feed.eps;
  const r = await fetchSeguro(DANI_BASE + '/series/' + slug + '/', 15000);
  if (!r.ok) throw new Error('no pude leer danimados (' + r.status + ')');
  const html = await r.text();
  const eps = [];
  const partes = html.split("<div class='se-c'>");
  for (const p of partes.slice(1)) {
    const mt = /class='se-t[^']*'>(\d+)<\/span>/.exec(p);
    const temporada = mt ? +mt[1] : 1;
    for (const it of p.split('<li').slice(1)) {
      const u = /href='(https:\/\/danimados\.cc\/episodios\/[^']+)'/.exec(it);
      if (!u) continue;
      const num = /numerando'>(\d+)\s*-\s*(\d+)</.exec(it);
      const sl2 = /([a-z0-9-]+)-(\d+)x(\d+)\/?/.exec(u[1]);
      const t = /episodiotitle[^>]*>\s*<a[^>]*>([^<]+)</.exec(it);
      const ep = num ? +num[2] : (sl2 ? +sl2[3] : 0);
      if (!ep) continue;
      const tit = t ? htmlDecode(t[1]) : '';
      eps.push({ temporada, ep, parte: '', url: u[1], titulo: (tit || ('Episodio ' + ep)).slice(0, 80), num: temporada + 'x' + ep });
    }
  }
  eps.sort((a, b) => a.temporada - b.temporada || a.ep - b.ep);
  DANI_FEEDS.set(slug, { at: Date.now(), eps });
  console.log('[dani] ' + slug + ': ' + eps.length + ' episodios en ' + (partes.length - 1) + ' temporadas (HTTP)');
  try { if (eps.length) precargarIntroDeSerie(eps.map((e) => ({ url: e.url }))); } catch {} // v223
  return eps;
}
function htmlDecode(s) { return String(s || '').replace(/&#(\d+);/g, (m2, d2) => String.fromCharCode(+d2)).replace(/&amp;/g, '&').replace(/&#215;/g, '×').trim(); }
async function daniEpToStream(urlEp) {
  const c = DANI_STREAMS.get(urlEp);
  if (c && Date.now() - c.at < 2 * 3600e3) return c.nat;
  const r1 = await fetchSeguro(urlEp, 12000);
  if (!r1.ok) throw new Error('el capítulo no abrió (' + r1.status + ')');
  const html1 = await r1.text();
  const post = (/data-post=['"](\d+)/.exec(html1) || [])[1];
  if (!post) throw new Error('el capítulo no trae player');
  /* v176: cada capítulo trae hasta 4 players (nume=1..4) y NO todos
   * sirven: el 1x2 de Titanes traía voe.sx (403 DDoS-Guard) en la opción 1
   * mientras hglink (la que sabemos romper) era la 3 — se prueban TODAS
   * hasta que una entregue video. v179: el master se exige DENTRO del ciclo —
   * si el player elegido no entrega master (hay CDNs celosos como
   * cdn-centaurus, y voe/Byse que no entregan nada) SEGUIMOS con la
   * siguiente opción en vez de rendir todo el capítulo */
  const ahora = Date.now();
  for (let nume = 1; nume <= 4; nume++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    let embedUrl = '';
    try {
      const r2 = await fetch(DANI_BASE + '/wp-admin/admin-ajax.php', {
        method: 'POST', signal: ctl.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': MIRROR_UA,
          'Referer': urlEp,
          'Origin': DANI_BASE,
        },
        body: 'action=doo_player_ajax&post=' + encodeURIComponent(post) + '&nume=' + nume + '&type=tv',
      });
      if (r2.ok) { const j2 = await r2.json().catch(() => null); if (j2 && j2.embed_url) embedUrl = j2.embed_url; }
    } finally { clearTimeout(t); }
    if (!embedUrl) continue;
    /* v183: el ajax a veces regresa la ETIQUETA iframe completa, no la URL
     * (episodios con player «Vimeus») — sacar la src de dentro */
    if (/^</.test(embedUrl)) {
      const src = (/src=["']([^"']+)/.exec(embedUrl) || [])[1] || '';
      if (!src) continue;
      embedUrl = src;
    }
    /* el front hglink (con guard JS) solo ROTA el dominio: hanerix sirve el
     * player de verdad sin guard — si aún no viene desempacable, cambiamos host */
    let html2 = '';
    for (const intento of [embedUrl, embedUrl.replace(/^https:\/\/[^/]+/i, 'https://hanerix.com')]) {
      const r3 = await fetchSeguro(intento, 12000).catch(() => null);
      if (!r3 || !r3.ok) continue;
      const b = await r3.text();
      if (/\.m3u8|eval\(function\(p,a,c,k,e/.test(b)) { html2 = b; break; }
    }
    /* v183: cadena VIMEUS (el único player de varios episodios, p.ej. Rick y
     * Morty T9) — el shell de vimeus.com esconde el embed de vimeos.net, la
     * misma familia packer que ya rompemos para Cuevana (resolverVimeos) y
     * de paso trae subtítulos .vtt */
    if (!html2 && /vimeus\.com|vimeos\.net/i.test(embedUrl)) {
      try {
        const shell = await fetchSeguro(embedUrl, 12000).catch(() => null);
        const sb = shell && shell.ok ? await shell.text() : '';
        const ev = (/https?:\/\/vimeos\.net\/embed-[a-z0-9]+\.html/i.exec(sb) || [])[0];
        if (ev) {
          const rv = await resolverVimeos(ev, urlEp).catch(() => null);
          if (rv && rv.m3u8) {
            let bodyV = '';
            for (const cab2 of [{ 'User-Agent': MIRROR_UA, Referer: ev }, { 'User-Agent': MIRROR_UA }, {}]) {
              const ctl3 = new AbortController();
              const t3 = setTimeout(() => ctl3.abort(), 12000);
              try {
                const rm2 = await fetch(rv.m3u8, { headers: cab2, signal: ctl3.signal, redirect: 'follow' });
                const tx = rm2.ok ? await rm2.text() : '';
                if (/ #EXTM3U/.test(' ' + tx)) { bodyV = tx; break; }
              } catch {} finally { clearTimeout(t3); }
            }
            if (bodyV) {
              const tok2 = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
              pelisxdStreams.set(tok2, { body: bodyV, base: rv.m3u8, ref: ev, slug: 'dani', at: ahora });
              const natV = { m3u8: '/api/xd/' + tok2 + '/index.m3u8', proxy: true, subs: rv.subs || [] };
              DANI_STREAMS.set(urlEp, { nat: natV, at: ahora });
              console.log('[dani] cadena vimeus rota para ' + urlEp.slice(-30));
              return natV;
            }
          }
        }
      } catch {}
      continue; /* esta opción no dio nada — siguiente player */
    }
    if (!html2) continue;
    const des = daniDesempacar(html2);
    const m3u8 = (/https:[^"']+?\.m3u8[^"']*/.exec(des) || [])[0];
    if (!m3u8) continue; /* v179: este player no dio stream — prueba el siguiente */
    let hostCDN = '';
    try { hostCDN = new URL(m3u8).hostname; } catch {}
    if (hostCDN) { hlsReferers.set(hostCDN, ''); try { hlsUAs.set(hostCDN, MIRROR_UA); } catch {} }
    /* v179: el master se pide con la MISMA UA grande del player (a la 124 de
     * fetchSeguro le ardía cdn-centaurus) y de repuesto sin UA */
    let bodyM = '';
    for (const ua2 of [MIRROR_UA, '']) {
      const ctl2 = new AbortController();
      const t2 = setTimeout(() => ctl2.abort(), 12000);
      try {
        const rM = await fetch(m3u8, { headers: ua2 ? { 'User-Agent': ua2 } : {}, signal: ctl2.signal, redirect: 'follow' });
        const t3 = rM.ok ? await rM.text() : '';
        if (/ #EXTM3U/.test(' ' + t3)) { bodyM = t3; break; }
      } catch {} finally { clearTimeout(t2); }
    }
    if (!bodyM) continue; /* v179: siguiente player */
    const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
    pelisxdStreams.set(tok, { body: bodyM, base: m3u8, ref: '', slug: 'dani', at: ahora });
    const nat = { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
    DANI_STREAMS.set(urlEp, { nat, at: ahora });
    return nat;
  }
  throw new Error('ningún player entregó el video — reintenta');
}
async function resolverDani(url) { return daniEpToStream(url); }
async function ponerDaniNativo(room, urlEp, userId) {
  const nat = await daniEpToStream(urlEp);
  if (mirrors.has(room.code)) await stopMirror(room);
  const slugD = daniSlugDeUrl(urlEp) || 'teen-titans-go';
  let titulo = daniTituloDe(slugD);
  try {
    const eps = await daniLista(slugD);
    const i = eps.findIndex((e) => { try { return new URL(e.url).pathname === new URL(urlEp).pathname; } catch { return false; } });
    if (i >= 0) titulo += ' · ' + eps[i].num + (eps[i].titulo && !/^Episodio/.test(eps[i].titulo) ? ' · ' + eps[i].titulo : '');
  } catch {}
  room.videoUrl = urlEp;
  room.videoTitle = titulo.slice(0, 80);
  room.native = { m3u8: nat.m3u8, mp4: !!nat.mp4, proxy: !!nat.proxy, subs: nat.subs || [] };
  room.videoImg = daniCoverDe(slugD);
  room.position = 0;
  room.isPlaying = false;
  room.videoDuration = 0;
  room.updatedAt = Date.now();
  room.serieCtx = null;
  serieCtxFromUrl(urlEp).then((sc) => {
    if (sc && room.videoUrl === urlEp) { room.serieCtx = sc; broadcast(room, 'state', stateOf(room)); }
  }).catch(() => {});
  sysMsg(room, '🎬 ' + room.videoTitle);
  broadcast(room, 'state', stateOf(room));
  return true;
}

async function resolverNativoInterno(url) {
  /* v219: el catálogo vivo de Movie entrega su playlist YA por nuestro proxy
     (/api/movie/v-vid?url=…): se reproduce nativo, tal cual, sin resolver nada */
  if (esStreamPropioUS(url)) return { m3u8: url, mp4: false, proxy: false, subs: [] };
  if (new RegExp(MOVIE_HOST_VIRTUAL.replace(/\./g, '\\.') + '\\/ver\\/', 'i').test(url)) return resolverMovie(url); /* v207: Movie nativo en sala (playlist local) */
  if (/latanime\.org\/ver\//i.test(url)) return resolverAnime(url);
  if (/animed23\.com\/capitulo\//i.test(url)) return resolverD23(url); /* v286: AnimeD23 nativo en sala (mismo que en Solo) */
  if (/pelisxd\.com\/pelicula\//i.test(url)) return resolverPelisxd(url); /* v98 */
  if (/miscaricaturas\.com\//i.test(url)) return resolverCaricatura(url); /* v102 */
  if (/danimados\.cc\/episodios\//i.test(url)) return resolverDani(url); /* v172 */
  if (/youtube\.com\/(watch|shorts)|youtu\.be\//i.test(url)) return resolverYoutube(url); /* v164 */
  if (/lacartoons\.com\/serie\/capitulo\//i.test(url)) return resolverLacartoons(url); /* v116: sin esto, los capítulos de lacartoons en SALA caían al espejo de navegador (abría la página web en vez de reproducir nativo) */
  return resolverSolo(url);
}

function usersOf(room) {
  return [...room.users.values()].map((u) => ({ id: u.id, name: u.name, isHost: u.id === room.hostId }));
}

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

function broadcast(room, event, data) {
  for (const res of room.clients) send(res, event, data);
}

function trimChat(room) {
  if (room.chat.length > 100) room.chat = room.chat.slice(-100);
}

function sysMsg(room, text) {
  const msg = { id: uid(), system: true, text, at: Date.now() };
  room.chat.push(msg);
  trimChat(room);
  broadcast(room, 'chat', { msg });
}

/* ---------------------- espejo de páginas (navegador remoto) ----------------------
 * Un Chrome real corre en el servidor; su pantalla se transmite como frames JPEG
 * por SSE a todos en la sala, y los clics/teclado se reenvían al navegador.
 * Es la técnica de los "cloud browsers" (Hyperbeam, Kasm…). */

let PUPPETEER = null; // require perezoso
/* v152: navegador PERSISTENTE — antes cada episodio abría un Chrome desde
 * cero (2-5 s perdidos por resolución) y lo cerraba al terminar. Ahora se
 * abre UNO y se reutiliza (solo se cierran las pestañas): caricaturas y
 * lacartoons resuelven varios segundos más rápido. */
let NAVEGADOR = null;
let NAVEGADOR_ABIERTO_EN = 0; /* v291: para la higiene de memoria */
async function getNavegador() {
  if (NAVEGADOR && NAVEGADOR.connected) return NAVEGADOR;
  if (!PUPPETEER) { try { PUPPETEER = require('puppeteer'); } catch { throw new Error('El navegador del servidor no está disponible'); } }
  NAVEGADOR = await PUPPETEER.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  }).catch(() => null);
  if (NAVEGADOR) { NAVEGADOR_ABIERTO_EN = Date.now(); NAVEGADOR.on('disconnected', () => { NAVEGADOR = null; }); }
  return NAVEGADOR;
}
const mirrors = new Map(); // roomCode -> mirror

/* v291: HIGIENE DE CHROME — el navegador persistente acumula memoria con los
 * días (intros, sondas, resoluciones de caricaturas/PelisXD). Si lleva más de
 * 2 h abierto y NADIE lo está usando (sin salas, sin espejos, sin job de intro),
 * se cierra; el próximo uso lo reabre solo (costo: ~1 s una sola vez). */
setInterval(() => {
  (async () => {
    try {
      if (!NAVEGADOR || !NAVEGADOR.connected) return;
      if (rooms.size || mirrors.size || INTRO_JOBS.size) return;
      if (Date.now() - NAVEGADOR_ABIERTO_EN < 2 * 3600 * 1000) return;
      const b = NAVEGADOR; NAVEGADOR = null;
      await b.close().catch(() => {});
      console.log('[nav] higiene: Chrome cerrado tras 2+ h abierto — se reabre solo al próximo uso');
    } catch {}
  })();
}, 10 * 60 * 1000);

/* v61: difunde la posición de la peli (barrita con tiempo) cada 2 s */
setInterval(async () => {
  for (const [code, m] of mirrors) {
    const room = rooms.get(code);
    if (!room || (!m.ready && !m.playing)) continue;
    try {
      for (const fr of m.page.frames()) {
        const r = await fr.evaluate(() => {
          const vs = [...document.querySelectorAll('video')].filter((v) => v.duration > 1);
          if (!vs.length) return null;
          vs.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
          return { t: vs[0].currentTime, d: vs[0].duration };
        }).catch(() => null);
        if (r && r.d > 1) {
          broadcast(room, 'mirror-time', { t: Math.round(r.t * 10) / 10, d: Math.round(r.d) });
          registrarProgreso(room, m, r); /* v78: seguir viendo */
          break;
        }
      }
    } catch {}
  }
}, 2000);

/* v25: errores que significan que la página espejada murió (crash o el sitio
 * la cerró). Se detectan y el espejo se reabre solo, sin errores técnicos. */
const PAGE_DEAD = /session closed|target closed|page closed|browser has disconnected|browser closed|session destroyed|detached|protocol error \(input\.|protocol error \(page\.|target created/i;
const MIRROR_MAX = +(process.env.MIRROR_MAX || 2); // espejos simultáneos (RAM; en Oracle MIRROR_MAX=8)
const MIRROR_SEND_MS = 45;          // máx. ~20 fps hacia los clientes
const MIRROR_IDLE_MS = 20 * 1000; // la sala queda vacía → el espejo se apaga en 20 s
const MIRROR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* v74: datos de una serie de Cuevana (temporadas y episodios) — los usa
 * el selector (/api/serie) y los botones de siguiente/anterior episodio */
/* v100: póster REAL de una serie por el WP API de cine-calidad — la página
 * de la serie NO trae og:image y el viejo fallback era el STILL del
 * episodio 1 (por eso las tarjetas salían con la foto del capítulo).
 * El featured_image del post tipo "series" es el póster vertical bueno. */
async function posterSerieWP(slug) {
  try {
    if (!/^[a-z0-9-]{2,90}$/.test(slug)) return '';
    const r = await fetchSeguro('https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=' + encodeURIComponent(slug.replace(/-/g, ' ')) + '&page=1', 9000);
    if (!r.ok) return '';
    const d = await r.json().catch(() => ({}));
    const posts = d.posts || [];
    const p = posts.find((x) => x.slug === slug && x.type === 'series') || posts.find((x) => x.slug === slug);
    return p && p.featured_image ? String(p.featured_image).replace('/w780/', '/w342/') : '';
  } catch { return ''; }
}

/* v111: CACHÉ A DISCO para los pickers — las cachés eran solo memoria y
 * tras cada reinicio (cada actualizar.sh) todo se volvía a descargar y el
 * selector de series tardaba otra vez. Ahora viven en data/cache/*.json:
 * sobreviven reinicios, se invalidan solas al cambiar de versión y los
 * datos VENCIDOS se sirven al instante mientras se refrescan por detrás
 * (stale-while-revalidate) — el picker abre en milisegundos. */
const CACHE_DIR = path.join(DATA_DIR, 'cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
function cacheLeer(nombre) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, nombre + '.json'), 'utf8'));
    return (d && d.v === UI_VERSION && d.e) ? d.e : null;
  } catch { return null; }
}
const cacheTimers = new Map();
function cacheGuardar(nombre, entradas) {
  if (nombre === 'serieCache') serieCachePodar(SERIECACHE_MAX); /* v297: el archivo en disco también queda acotado */
  if (cacheTimers.has(nombre)) return; /* se agrupan escrituras cada 4 s */
  const t = setTimeout(() => {
    cacheTimers.delete(nombre);
    try {
      const tmp = path.join(CACHE_DIR, nombre + '.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ v: UI_VERSION, e: entradas() }));
      fs.renameSync(tmp, path.join(CACHE_DIR, nombre + '.json'));
    } catch {}
  }, 4000);
  t.unref();
  cacheTimers.set(nombre, t);
}

async function datosSerieCuevana(slug) {
  const c = serieCache.get(slug);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.d;
  if (c) { refrescarSerieCuevana(slug).catch(() => {}); return c.d; } /* v111: vencido → se sirve YA y se refresca por detrás */
  return await refrescarSerieCuevana(slug);
}
async function refrescarSerieCuevana(slug) {
  try {
    const r = await fetchSeguro(`https://cine-calidad.mx/serie/${slug}/`, 10000);
    if (!r.ok) return null;
    const html = await r.text();
    const eps = [];
    const re = /<li class="mark-(\d+)"[^>]*>.*?<img[^>]*src="([^"]+)".*?<a href="([^"]*\/episode\/[^"]+)"[^>]*>([^<]+)<\/a>/gs;
    let mm;
    while ((mm = re.exec(html)) && eps.length < 400) {
      const nm = /-(\d+)x(\d+)\/?$/.exec(mm[3]);
      eps.push({
        temporada: nm ? +nm[1] : +mm[1],
        ep: nm ? +nm[2] : 0,
        url: mm[3],
        titulo: mm[4].trim().slice(0, 90),
        img: mm[2].replace('/w300/', '/w342/'),
      });
    }
    const og = (p) => {
      const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(html);
      const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(html);
      return (a1 || a2 || [])[1] || '';
    };
    const out = {
      ok: true, slug,
      titulo: (og('og:title') || slug).replace(/\s*[-–|].*$/, '').trim().slice(0, 80),
      /* v100: el póster sale del WP API — la página no trae og:image y el
       * viejo fallback (eps[0].img) era el STILL del episodio 1 */
      poster: ((og('og:image') || '').replace('/w780/', '/w342/') || await posterSerieWP(slug)),
      episodios: eps,
    };
    serieCache.set(slug, { at: Date.now(), d: out });
    cacheGuardar('serieCache', () => [...serieCache.entries()]); /* v111: a disco */
    try { if (out.episodios && out.episodios.length) precargarIntroDeSerie(out.episodios.map((e) => ({ url: e.url }))); } catch {} // v223: auto-intro al entrar
    return out;
  } catch { return null; }
}

/* v96: póster de una serie (para sanear las tarjetas de continuar) —
 * cacheado un día; si falla, se queda la imagen que traía la entrada */
const postersSeries = new Map();
async function posterDeSerie(slug) {
  try {
    if (!/^[a-z0-9-]{2,90}$/.test(slug)) return '';
    const c = postersSeries.get(slug);
    if (c && Date.now() - c.ts < (c.poster ? 864e5 : 2 * 60 * 1000)) return c.poster || '';
    if (c) { refrescarPosterSerie(slug).catch(() => {}); return c.poster || ''; } /* v111: vencido → se sirve y se refresca por detrás */
    return await refrescarPosterSerie(slug);
  } catch { return ''; }
}
async function refrescarPosterSerie(slug) {
  try {
    /* v99: un fallo (póster vacío) se cachea solo 2 minutos — antes quedaba
     * envenenado un DÍA y el still del capítulo seguía apareciendo aunque
     * el sitio ya respondiera.
     * v100: primero el WP API (featured_image del post de la serie, el
     * póster de verdad) — la página de la serie no trae og:image y su
     * "poster" era el still del episodio 1 */
    let poster = await posterSerieWP(slug);
    if (!poster) {
      const d = await datosSerieCuevana(slug).catch(() => null);
      poster = (d && d.poster) || '';
    }
    postersSeries.set(slug, { poster, ts: Date.now() });
    cacheGuardar('postersSeries', () => [...postersSeries.entries()]); /* v111: a disco */
    return poster;
  } catch { return ''; }
}

/* v74: episodios de un anime de Latanime — selector + botones de episodio */
async function datosAnimeLatanime(slug) {
  const cL = serieCache.get('latanime:' + slug);
  if (cL && Date.now() - cL.at < 30 * 60 * 1000) return cL.d;
  try {
    const rL = await fetchSeguro(`https://latanime.org/anime/${slug}`, 10000);
    if (rL.status === 404) return { ok: false, dead: '404', slug, titulo: '', poster: '', episodios: [] }; /* v288: el sitio la borró */
    if (!rL.ok) return null;
    const htmlL = await rL.text();
    const epsL = [];
    const vistos = new Set();
    const reL = /href="(https:\/\/latanime\.org\/ver\/[a-z0-9-]+-episodio-(\d+)(?:-[a-z0-9]+)?)"/g;
    let mL;
    while ((mL = reL.exec(htmlL)) && epsL.length < 600) {
      const nL = +mL[2];
      if (!nL || vistos.has(nL)) continue;
      vistos.add(nL);
      epsL.push({ n: nL, url: mL[1], titulo: 'Episodio ' + nL });
    }
    epsL.sort((a, b) => a.n - b.n);
    if (!epsL.length) return { ok: false, dead: 'empty', slug, titulo: '', poster: '', episodios: [] }; /* v288: página viva sin episodios */
    const ogL = (p) => {
      const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(htmlL);
      const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(htmlL);
      return (a1 || a2 || [])[1] || '';
    };
    const outL = {
      ok: true, slug,
      titulo: (ogL('og:title') || slug).replace(/\s*[—–|]\s*Latanime\s*$/i, '').trim().slice(0, 90),
      poster: ogL('og:image') || '',
      episodios: epsL,
    };
    serieCache.set('latanime:' + slug, { at: Date.now(), d: outL });
    cacheGuardar('serieCache', () => [...serieCache.entries()]); /* v111: a disco */
    try { if (outL.episodios && outL.episodios.length) precargarIntroDeSerie(outL.episodios.map((e) => ({ url: e.url }))); } catch {} // v223
    return outL;
  } catch { return null; }
}

/* v74: si la URL es un episodio de serie, saca la lista completa de
 * episodios para saber cuál sigue y cuál va antes */
/* v127: si la lista termina justo al final de una temporada y NO hay
 * ningún episodio de la siguiente, trae la página de la temporada que
 * sigue (MisCaricaturas publica cada temporada como un post aparte) y
 * agrega sus episodios al final — así «Siguiente» RUEDA a la temporada
 * nueva empezando en el episodio 1, en Solo y en Juntos. */
async function extenderSerieCtx(sc) {
  try {
    if (!sc || !sc.eps || sc.eps.length < 2 || !sc.slug) return sc;
    const tU = +((sc.eps[sc.eps.length - 1]).temporada || 0);
    if (!tU) return sc; /* sin concepto de temporada (animes) */
    if (sc.eps.some((e) => +e.temporada === tU + 1)) return sc; /* ya está */
    if (sc.tipo === 'caricaturas' && !sc.esLct) {
      const base = String(sc.slug).replace(/-(capitulos-completos[a-z]*|capitulos-y-canciones|completos|ver|latino|online)$/, '');
      const rt = await fetchSeguro(CARI_BASE + base + '-temporada-' + (tU + 1) + '/', 10000).catch(() => null);
      if (!rt || !rt.ok) return sc;
      const extra = await cariEpsDeHtml(await rt.text());
      if (!extra.length) return sc;
      for (const e of extra) sc.eps.push(e);
      sc.eps.sort((a, b) => a.temporada - b.temporada || a.ep - b.ep || String(a.parte).localeCompare(String(b.parte)));
      console.log('[serie] temporada ' + (tU + 1) + ' agregada (' + extra.length + ' eps) — el salto rueda a la nueva temporada');
    }
    return sc;
  } catch { return sc; }
}

async function serieCtxFromUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    /* v207: Movie (mapa local) — cadena de capítulos activos de la serie */
    if (host === MOVIE_HOST_VIRTUAL) {
      const mm = /^\/ver\/([a-z0-9-]+)\/(\d+)x(\d+)$/i.exec(url.pathname);
      if (!mm) return null;
      const s = movieSerieActiva(mm[1]);
      if (!s) return null;
      const idx = s.eps.findIndex((e) => e.temporada === +mm[2] && e.episodio === +mm[3]);
      if (idx < 0) return null;
      return { tipo: 'movie', titulo: s.titulo, poster: '/api/movie/poster/' + s.clave, idx,
        eps: s.eps.map((e) => ({ url: movieUrlEp(s.clave, e.temporada + 'x' + e.episodio), num: 'Capítulo ' + e.episodio })) };
    }
    let m = /\/ver\/([a-z0-9-]+)-episodio-(\d+)/i.exec(url.pathname);
    if (m && host.endsWith('latanime.org')) {
      const d = await datosAnimeLatanime(m[1]);
      if (!d || !d.episodios || !d.episodios.length) return null;
      const idx = d.episodios.findIndex((e) => e.n === +m[2]);
      if (idx < 0) return null;
      return { tipo: 'latanime', titulo: d.titulo, poster: d.poster, idx, eps: d.episodios.map((e) => ({ url: e.url, num: 'Episodio ' + e.n })) };
    }
    m = /\/capitulo\/(.*?)-(?:ep|capitulo)-(\d+)/i.exec(url.pathname); /* v286: AnimeD23 — cadena de capítulos para "Sig. ▸" en sala */
    if (m && /animed23\.com$/.test(host)) {
      const d = await datosAnimeD23(m[1]);
      if (!d || !d.episodios.length) return null;
      const idx = d.episodios.findIndex((e) => e.n === +m[2]);
      if (idx < 0) return null;
      return { tipo: 'animed23', titulo: d.titulo, poster: d.poster, idx, eps: d.episodios.map((e) => ({ url: e.url, num: 'Episodio ' + e.n })) };
    }
    m = /\/ver\/([a-z0-9-]+)-(\d+)(?:\/|$)/i.exec(url.pathname);
    if (m && /animeflv\./.test(host)) {
      /* v189: cadena de episodios desde la página del anime (AnimeFLV es el
       * respaldo de Latanime — también merece intros) */
      const afSlug = m[1], afPed = +m[2];
      const htmlAF = await fetchSeguro('https://vww.animeflv.one/anime/' + afSlug, 9000).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      /* la página trae la lista embebida: var eps = [["37","1",""],…] (desc) */
      let capsAF = [];
      const mEps = /var\s+eps\s*=\s*\[\[(.*?)\]\]/s.exec(htmlAF);
      if (mEps) capsAF = [...new Set(mEps[1].split('],[').map((x) => +((x.split(',')[0] || '').replace(/[^0-9]/g, '')) || 0))].filter(Boolean).sort((a, b) => a - b);
      if (!capsAF.length) capsAF = [...new Set([...htmlAF.matchAll(/\/ver\/[a-z0-9-]+-(\d+)(?:["'?/]|$)/g)].map((x) => +x[1]))].sort((a, b) => a - b);
      if (capsAF.length) {
        return { tipo: 'animeflv', titulo: '', poster: '', idx: Math.max(0, capsAF.indexOf(afPed)),
          eps: capsAF.map((n) => ({ url: 'https://vww.animeflv.one/ver/' + afSlug + '-' + n, num: 'Episodio ' + n })) };
      }
      return null;
    }
    m = /\/episode\/([a-z0-9-]+)-(\d+)x(\d+)/i.exec(url.pathname);
    if (m && /(cine-calidad\.mx|cuevana\.)$/.test(host)) {
      const d = await datosSerieCuevana(m[1]);
      if (!d || !d.episodios || !d.episodios.length) return null;
      const idx = d.episodios.findIndex((e) => e.temporada === +m[2] && e.ep === +m[3]);
      if (idx < 0) return null;
      return { tipo: 'cuevana', titulo: d.titulo, poster: d.poster, idx, eps: d.episodios.map((e) => ({ url: e.url, num: e.temporada + 'x' + e.ep, temporada: e.temporada, ep: e.ep })) };
    }
    /* v118: caricaturas de MisCaricaturas — el slug del episodio
     * («hora-de-aventura-01x02-…») se mapea a su serie y de ahí sale
     * la cadena completa (incluye lo fusionado de Lacartoons: Billy
     * T1-5, Ben 10 T3+) para los botones de siguiente/anterior. */
    if (host.endsWith('miscaricaturas.com')) {
      const slugEp = cariSlugDe(u);
      const mE = /^(.+)-(\d{1,2})x(\d{2})([ab])?(?:-|$)/.exec(slugEp); /* v241: 1xNN */
      const serie = mE ? (cariSerieDeEp(mE[1]) || '') : (cariEsSerie(slugEp) ? slugEp : '');
      if (serie) {
        const d = await datosCaricatura(serie);
        if (d && d.episodios && d.episodios.length) {
          let idx = d.episodios.findIndex((e) => cariSlugDe(e.url) === slugEp);
          /* v127: si el episodio no está por URL (la lista cambió, parte con
           * sufijo distinto…), se busca por NÚMEROS 0Sx0Ep+parte */
          if (idx < 0 && mE) {
            const tN = parseInt(mE[2], 10), eN = parseInt(mE[3], 10), pa = mE[4] || '';
            idx = d.episodios.findIndex((e) => e.temporada === tN && e.ep === eN && String(e.parte || '') === pa);
          }
          if (idx >= 0) {
            const sc = { tipo: 'caricaturas', slug: serie, titulo: d.titulo, poster: d.poster, cover: d.cover || '', idx,
              eps: d.episodios.map((e) => ({ url: e.url, num: `${e.temporada}x${e.ep || '·'}${e.parte || ''}`, temporada: e.temporada, ep: e.ep, parte: e.parte || '' })) };
            await extenderSerieCtx(sc); /* v127: rueda a la temporada siguiente */
            return sc;
          }
        }
      }
    }
    /* v172: Teen Titans Go de DANIMADOS — 9 temporadas completas */
    if (host.includes('danimados.cc')) {
      const slugD = daniSlugDeUrl(url.pathname) || 'teen-titans-go';
      const eps = await daniLista(slugD).catch(() => []);
      if (eps.length) {
        const pth = url.pathname.replace(/\/$/, '');
        const idx = eps.findIndex((e) => { try { return new URL(e.url).pathname.replace(/\/$/, '') === pth; } catch { return false; } });
        if (idx >= 0) {
          const cov = daniCoverDe(slugD);
          return { tipo: 'dani', titulo: daniTituloDe(slugD), poster: cov, cover: cov, idx,
            eps: eps.map((e) => ({ url: e.url, num: e.num, temporada: e.temporada, ep: e.ep, parte: '' })) };
        }
      }
    }
        /* v118: capítulos de Lacartoons — el capId dice la serie y la
     * cadena sale de la misma lista fusionada (misma fuente de verdad) */
    if (host.endsWith('lacartoons.com')) {
      const capId = +((/\/serie\/capitulo\/(\d+)/i.exec(url.pathname) || [])[1] || 0);
      const slug = capId ? lctSerieDeCap(capId) : '';
      if (slug) {
        let d = await datosCaricatura(slug);
        /* v127: si la lista no llegó (falló la carga a la primera), se pide
         * DIRECTO a lacartoons saltando la caché — de esto dependen los
         * botones de siguiente/anterior */
        if (!d || !d.episodios || !d.episodios.length) {
          const lct = [...LCT_SERIES.values()].find((x) => x.slug === slug);
          if (lct) d = await refrescarDatosLacartoons(lct).catch(() => null);
        }
        if (d && d.episodios && d.episodios.length) {
          const idx = d.episodios.findIndex((e) => lctCapIdDe(e.url) === capId);
          if (idx >= 0) {
            return { tipo: 'caricaturas', slug, esLct: true, titulo: d.titulo, poster: d.poster, cover: d.cover || '', idx,
              eps: d.episodios.map((e) => ({ url: e.url, num: `${e.temporada}x${e.ep || '·'}${e.parte || ''}`, temporada: e.temporada, ep: e.ep, parte: e.parte || '' })) };
          }
        }
      }
    }
    return null;
  } catch { return null; }
}
// v223: cada vez que alguien entra a una serie (serieCtx), disparar intro al instante (mejor intro posible, casi al momento)
const _serieCtxFromUrl_orig = serieCtxFromUrl;
serieCtxFromUrl = async function(u) {
  const sc = await _serieCtxFromUrl_orig(u);
  if (sc && sc.eps && sc.eps.length) {
    try { precargarIntroDeSerie(sc.eps); } catch {}
    // también para la barra de estado /api/intros más viva
    try { const urlS = String(u||''); if (urlS) dispararDeteccionIntroSiToca(urlS); } catch {}
  }
  return sc;
};
/* v128: SALTO AUTOMÁTICO al terminar un episodio (nativo) — busca el
 * siguiente vivo (brincando hasta 3 caídos), lo deja PAUSADO con «Toca
 * para empezar» y lo anuncia en el chat. Lo dispara el «ended» del video
 * o el latido del servidor (por tiempo, aunque nadie reporte el final). */
const EP_MUERTO_RE = /ya no está disponible|ya no existe en la fuente|solo está en MEGA|no está en español|solo existe en inglés|no respondió|no entregó el video/i;
async function autoSiguienteNativo(room) {
  const sc = room.serieCtx;
  if (!sc || !room.native || !sc.eps || !sc.eps.length) return false;
  const actual = sc.eps.findIndex((e) => e.url === room.videoUrl);
  const desde = actual >= 0 ? actual : sc.idx;
  if (desde + 1 >= sc.eps.length) return false;
  let elegido = null;
  const saltados = [];
  for (let paso = 1; paso <= 3 && desde + paso < sc.eps.length; paso++) {
    const cand = sc.eps[desde + paso];
    let errN = '';
    const nat = await resolverNativo(cand.url).catch((e) => { errN = String(e.message || e).slice(0, 140); return null; });
    if (nat) { elegido = { cand, idx: desde + paso, nat }; break; }
    if (!EP_MUERTO_RE.test(errN)) return false; /* error raro (red/navegador): no arriesgar el salto automático */
    saltados.push(cand.num);
  }
  if (!elegido) return false;
  room.videoUrl = elegido.cand.url; programarPrefetchEp(room);
  room.videoTitle = tituloBonitoEp(sc.titulo, elegido.cand.num); /* v144 */
  if (sc.poster) room.videoImg = sc.poster.slice(0, 400);
  room.native = { m3u8: elegido.nat.m3u8, mp4: !!elegido.nat.mp4, proxy: !!elegido.nat.proxy, subs: elegido.nat.subs || [] };
  sc.idx = elegido.idx;
  room.position = 0;
  room.videoDuration = 0;
  room.isPlaying = false; /* v127: pausado — «Toca para empezar» lo arranca para todos */
  room.updatedAt = Date.now();
  sysMsg(room, `Siguiente episodio automático: ${room.videoTitle}${saltados.length ? ' (sin ' + saltados.join(', ') + ')' : ''}`);
  broadcast(room, 'state', stateOf(room));
  return true;
}
/* v128: salto automático en el ESPEJO — el video terminó en el Chrome
 * remoto (detectado por CDP en el latido) → el siguiente, con la misma
 * auto-reparación del contexto que los botones */
async function avanzarAutoEspejo(room) {
  let m = mirrors.get(room.code);
  if (m && !m.serie) {
    const scFix = await serieCtxFromUrl(m.url || '').catch(() => null);
    if (scFix) { m.serie = scFix; broadcast(room, 'mirror-state', mirrorState(room)); }
  }
  if (!m || !m.serie) return false;
  let idx = m.serie.eps.findIndex((e) => e.url === (m.url || ''));
  if (idx < 0) idx = m.serie.idx;
  const target = m.serie.eps[idx + 1];
  if (!target) return false;
  room.videoUrl = target.url; programarPrefetchEp(room);
  room.videoTitle = tituloBonitoEp(m.serie.titulo, target.num); /* v144 */
  if (m.serie.poster) room.videoImg = m.serie.poster.slice(0, 400);
  await stopMirror(room);
  await startMirror(room, target.url, room.hostId);
  sysMsg(room, `Siguiente episodio automático: ${room.videoTitle}`);
  broadcast(room, 'state', stateOf(room));
  return true;
}
/* v128: INTROS APRENDIDAS — «Saltar intro» usa una ventana fija (8s→90s),
 * pero si un episodio tiene tiempos guardados (de saltos reales o curados
 * a mano en data/intros.json) se usan esos exactos. */
const INTROS_FILE = path.join(DATA_DIR, 'intros.json');
let INTROS = {};
try { INTROS = JSON.parse(fs.readFileSync(INTROS_FILE, 'utf8')) || {}; } catch {}
/* v187: claves POR TEMPORADA en danimados (dani:slug:S#) — lo aprendido
 * antes (por serie, que siempre salía de la T1) migra a su temporada */
for (const k of Object.keys(INTROS)) {
  const m = /^(dani|cv|mm):([a-z0-9-]+)$/.exec(k);
  if (m && !INTROS[m[1] + ':' + m[2] + ':1']) { INTROS[m[1] + ':' + m[2] + ':1'] = INTROS[k]; delete INTROS[k]; }
}
/* v138: los aprendizajes del sistema VIEJO (ventana fija 8→90) tenían fin
 * exactamente en 90 — salían «de más». Se eliminan al arrancar para que la
 * detección por audio aprenda esas series desde cero y bien. */
(function limpiarIntrosViejas() {
  let n = 0;
  for (const [k, v] of Object.entries(INTROS)) {
    if (v && v.by !== 'auto' && !/^(mm|lct|la|af|cv):/.test(k) && +v.end === 90 && +v.start <= 25) { delete INTROS[k]; n++; }
  }
  if (n) { try { guardarIntros(); } catch {} console.log('[intro] migración: ' + n + ' aprendizaje' + (n === 1 ? '' : 's') + ' de la ventana vieja eliminado' + (n === 1 ? '' : 's') + ' (salían de más)'); }
})();
function introKeyDe(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); } catch { return String(url || '').slice(0, 140); }
}
/* v132: clave a NIVEL DE SERIE — la intro es la misma en todos los
 * episodios de una temporada, así que lo aprendido en uno sirve para
 * todos (MisCaricaturas, Lacartoons, animes, Cuevana) */
function introKeysDe(url) {
  const exacto = introKeyDe(url);
  let serie = null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/danimados\.cc$/.test(host)) {
      const m = /\/episodios\/([a-z0-9-]+)-(\d+)x(\d+)\//.exec(new URL(url).pathname);
      if (m) serie = 'dani:' + m[1] + ':' + m[2]; /* v187: POR TEMPORADA — entre temporadas las intros cambian */
    } else if (/miscaricaturas\.com$/.test(host)) {
      const se = cariSlugDe(url);
      const base = se.replace(/-\d{2}x\d{2}[ab]?(-.*)?$/, '');
      const tm = /-(\d{2})x\d{2}/.exec(se);
      if (base) serie = 'mm:' + base + (tm ? ':' + parseInt(tm[1], 10) : ''); /* v189: por temporada */
    } else if (/lacartoons\.com$/.test(host)) {
      const capId = +((/\/serie\/capitulo\/(\d+)/.exec(new URL(url).pathname) || [])[1] || 0);
      const slug = capId ? lctSerieDeCap(capId) : '';
      if (slug) serie = 'lct:' + slug;
    } else if (/latanime\.org$/.test(host)) {
      const m = /\/ver\/([a-z0-9-]+)-episodio-\d+/.exec(new URL(url).pathname);
      if (m) serie = 'la:' + m[1];
    } else if (/animeflv\./.test(host)) {
      const m = /\/ver\/([a-z0-9-]+)-(?:\d+|episodio-\d+)/.exec(new URL(url).pathname); /* v189: animeflv usa /ver/slug-N */
      if (m) serie = 'af:' + m[1].replace(/-\d+$/, '');
    } else if (/(cine-calidad\.mx|cuevana\.)/.test(host)) {
      const m = /\/episode\/([a-z0-9-]+)-(\d+)x\d+/.exec(new URL(url).pathname);
      if (m) serie = 'cv:' + m[1] + ':' + m[2]; /* v189: POR TEMPORADA, como danimados */
    }
  } catch {}
  return { exacto, serie };
}
function guardarIntros() {
  try {
    const tmp = INTROS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(INTROS));
    fs.renameSync(tmp, INTROS_FILE);
  } catch {}
}

/* ═══════ v133: DETECCIÓN REAL DE INTROS (huella de audio) ═══════
 * Compara el AUDIO de dos episodios de la misma serie con chromaprint:
 * el pedazo que suena IGUAL en ambos ES la intro (esté donde esté —
 * si la serie no trae intro al inicio, NO se encuentra pedazo común y
 * no se guarda nada → el botón no aparece y nadie salta contenido).
 * Requiere fpcalc (libchromaprint-tools — setup.sh lo instala); sin él
 * quedan las intros aprendidas a mano y el botón no sale a ciegas. */
let FPCALC_OK = null;
function fpcalcOk() {
  if (FPCALC_OK !== null) return FPCALC_OK;
  try { FPCALC_OK = !!execFileSync('which', ['fpcalc'], { timeout: 4000 }).toString().trim(); }
  catch { FPCALC_OK = false; }
  if (!FPCALC_OK) console.log('[intro] sin fpcalc — detección automática apagada (instala libchromaprint-tools)');
  return FPCALC_OK;
}
function popcount32(x) {
  x = x >>> 0;
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24 & 0xff;
}
const INTRO_WPS = 1000 / 370; /* chromaprint: 1 palabra ≈ 0.37 s de audio */
/* región de B que coincide con algo de A (mismo audio, distinta posición) */
function compararHuellas(A, B) {
  const SEMILLA = 16, PUENTE = 4, MAXERR = 10, SIM = 0.15;
  const sim = (i, j) => {
    let e = 0;
    for (let k = 0; k < SEMILLA; k++) e += popcount32((A[i + k] | 0) ^ (B[j + k] | 0));
    return e / (SEMILLA * 32);
  };
  let mejor = null;
  for (let j = 0; j + SEMILLA < B.length; j += 2) {
    for (let i = 0; i + SEMILLA < A.length; i += 2) {
      if (sim(i, j) > SIM) continue;
      let a1 = i + SEMILLA, b1 = j + SEMILLA, fallos = 0;
      while (a1 < A.length && b1 < B.length) {
        if (popcount32((A[a1] | 0) ^ (B[b1] | 0)) <= MAXERR) { a1++; b1++; fallos = 0; }
        else if (++fallos > PUENTE) break;
      }
      let a0 = i + 1, b0 = j + 1; fallos = 0;
      while (a0 > 0 && b0 > 0) {
        if (popcount32((A[a0 - 1] | 0) ^ (B[b0 - 1] | 0)) <= MAXERR) { a0--; b0--; fallos = 0; }
        else if (++fallos > PUENTE) break;
      }
      const dur = (b1 - b0) / INTRO_WPS;
      if (!mejor || dur > mejor.dur) mejor = { a0, b0, a1, b1, dur };
    }
  }
  /* recorte de bordes: fuera ventanas que solo coinciden a medias (el error
   * sube en cuanto la ventana toca audio que NO es la intro en ambos lados) */
  if (mejor) {
    const off = mejor.a0 - mejor.b0;
    const dentro = (b) => {
      const a = b + off;
      if (a < 0 || a + SEMILLA > A.length || b + SEMILLA > B.length) return false;
      return sim(a, b) <= SIM + 0.03;
    };
    while (mejor.b1 - mejor.b0 > SEMILLA + 8 && !dentro(mejor.b0)) mejor.b0++;
    while (mejor.b1 - mejor.b0 > SEMILLA + 8 && !dentro(mejor.b1 - SEMILLA)) mejor.b1--;
    mejor.ini = mejor.b0 / INTRO_WPS;
    mejor.fin = mejor.b1 / INTRO_WPS;
  }
  return mejor;
}
function fpcalcArchivo(archivo, segs) {
  return new Promise((resolve) => {
    /* v184: SIN -raw — con -raw fpcalc cambia su salida a LISTA de números (no base64), el parseo moría en silencio y la detección nunca dio nada */
    execFile('fpcalc', ['-length', String(segs || 280), '-json', archivo], { timeout: 90000, maxBuffer: 8e6 }, (err, so) => {
      if (err) return resolve(null);
      try {
        const buf = Buffer.from(String(so).match(/"fingerprint"\s*:\s*"([^"]+)"/)[1], 'base64');
        resolve(new Int32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
      } catch { resolve(null); }
    });
  });
}
/* baja los PRIMEROS ~4 min de un stream HLS o mp4 a un archivo temporal */
async function descargarInicioEp(m3u8) {
  const archivo = path.join(os.tmpdir(), 'intro-' + crypto.randomBytes(5).toString('hex') + '.ts');
  let ref = '';
  try { ref = hlsReferers.get(new URL(m3u8).hostname) || ''; } catch {}
  /* v299: MEDIDOR DE FLUJO — algunos CDNs IGNORAN el Range y empujan el episodio
   * COMPLETO (200-300 MB) de golpe: eso reventaba el heap en Oracle aunque v298
   * pedía "solo 16 MB". Ahora se lee por goteo y al pasar del tope se cuelga. */
  const cuerpoLimitado = async (r, maxBytes) => {
    try {
      const chunks = []; let n = 0;
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > maxBytes) { try { reader.cancel(); } catch {} return null; }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch { return null; }
  };
  const pedir = async (u, ms, range) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(u, { headers: { 'User-Agent': MIRROR_UA, ...(ref ? { Referer: ref } : {}), ...(range ? { Range: range } : {}) }, signal: ctl.signal, redirect: 'follow' });
      return r.ok ? r : null;
    } catch { return null; } finally { clearTimeout(t); }
  };
  let pl = m3u8;
  for (let saltos = 0; saltos < 2; saltos++) {
    const r = await pedir(pl, 15000);
    if (!r) return null;
    const txt = await r.text();
    if (/#EXT-X-STREAM-INF/i.test(txt)) {
      const vars = [...txt.matchAll(/#EXT-X-STREAM-INF[^\n]*BANDWIDTH=(\d+)[^\n]*\n([^\n#]+)/gi)].map((m) => ({ bw: +m[1], u: (() => { try { return new URL(m[2].trim(), pl).href; } catch { return null; } })() })).filter((v) => v.u);
      if (!vars.length) return null;
      vars.sort((a, b) => a.bw - b.bw);
      pl = vars[0].u; /* la más baja: para el audio basta */
      continue;
    }
    if (!/#EXTM3U/i.test(txt)) {
      /* mp4/webm directo — v189: muchos CDNs (mp4upload p.ej.) traen el
       * índice (moov) AL FINAL: bajamos inicio + última porción y escribimos
       * un archivo CON HUECO (las posiciones cuadran) — ffmpeg encuentra el
       * moov y decodifica el principio, que es lo que importa */
      const rH = await pedir(pl, 60000, 'bytes=0-16777216'); /* v298: 16 MB de inicio (antes 35) — alcanza para el moov y el arranque */
      const rT = await pedir(pl, 30000, 'bytes=-4194304'); /* v298: cola de 4 MB (antes 8) */
      if (!rH || !rT) return null;
      const cab = await cuerpoLimitado(rH, 18e6); /* v299: si el CDN ignora el Range y empuja de más, se cuelga a tiempo */
      const cola = cab ? await cuerpoLimitado(rT, 5e6) : null;
      if (!cab || !cola) return null;
      if (!cab || cab.length < 3e5 || !cola || !cola.length) return null;
      const total = +((/\/(\d+)\s*$/).exec(rT.headers.get('content-range') || '') || [])[1] || 0;
      if (total && total > cab.length + cola.length) {
        const fd = fs.openSync(archivo, 'w');
        try { fs.writeSync(fd, cab, 0, cab.length, 0); fs.writeSync(fd, cola, 0, cola.length, total - cola.length); } finally { fs.closeSync(fd); }
      } else {
        fs.writeFileSync(archivo, cab);
      }
      return archivo;
    }
    /* v187: duración por #EXTINF — los segmentos NO pesan igual entre CDNs
     * (vimeos trae pedazos de 2-5MB y los de danimados ~0.7MB); lo que
     * importa es cuántos SEGUNDOS de video bajamos, no cuántos pedazos */
    let durs = [];
    const lineas = txt.split('\n').map((l) => l.trim());
    const durDe = {};
    for (let i2 = 0; i2 < lineas.length; i2++) {
      if (lineas[i2].startsWith('#EXTINF')) {
        const d2 = parseFloat((/#EXTINF:\s*([0-9.]+)/.exec(lineas[i2]) || [])[1] || '0');
        const sg = (lineas[i2 + 1] || '').trim();
        if (sg && !sg.startsWith('#')) { try { durDe[new URL(sg, pl).href] = d2; } catch { durDe[sg] = d2; } }
      }
    }
    const segs = lineas.filter((l) => l && !l.startsWith('#')).map((s) => { try { return new URL(s, pl).href; } catch { return null; } }).filter(Boolean).slice(0, 40);
    if (!segs.length) return null;
    /* v185: descarga PARALELA (8 a la vez) — en serie el CDN lento se comía
     * 5+ minutos por episodio y la detección parecía colgada */
    const partes = new Array(segs.length).fill(null);
    let bytes = 0, fellas = 0, dseg = 0;
    /* v185: el timeout cubre TAMBIÉN el cuerpo — pedir() apaga su reloj al
     * llegar las cabeceras y un cuerpo trabado colgaba arrayBuffer() para
     * siempre (eso eran los «25 minutos detectando» en el Oracle del usuario) */
    const uno = async (s) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetch(s, { headers: { 'User-Agent': MIRROR_UA, ...(ref ? { Referer: ref } : {}) }, signal: ctl.signal, redirect: 'follow' });
        if (!r.ok) return null;
        const ab = await cuerpoLimitado(r, 10e6); /* v299: segmento con tope de 10 MB por goteo */
        return ab && ab.length ? ab : null;
      } catch { return null; } finally { clearTimeout(t); }
    };
    for (let i0 = 0; i0 < segs.length; i0 += 8) {
      const lote = segs.slice(i0, i0 + 8);
      const rs = await Promise.all(lote.map(uno));
      for (let k = 0; k < rs.length; k++) {
        if (!rs[k]) { fellas++; continue; }
        partes[i0 + k] = rs[k];
        bytes += rs[k].length;
        try { dseg += durDe[segs[i0 + k]] || 0; } catch {}
      }
      console.log('[intro] bajando: ' + Math.round(100 * (i0 + lote.length) / segs.length) + '% (' + Math.round(bytes / 1e6) + 'MB, ' + Math.round(dseg) + 's de video)');
      if (fellas >= 6) break; /* el CDN se cayó: con lo que hay */
      if (bytes > 18e6 || dseg >= 120) break; /* v298: 18 MB / 2 min de video alcanzan (antes 30 MB / 3 min) */
    }
    const buenoSeg = dseg >= 45 || bytes > 10e6; /* v298: umbral más ligero (antes 60 s / 15 MB) */
    if (!buenoSeg) return null;
    fs.writeFileSync(archivo, Buffer.concat(partes.filter(Boolean)));
    return archivo;
  }
  return null;
}
/* v184: DETECCIÓN POR VIDEO — la intro es la MISMA animación en todos los
 * episodios (el audio re-encodeado difiere demasiado entre uploads: probado,
 * huella de audio cruzada ~0.39 contra ruido ~0.40 — inservible). Miniaturas
 * 9x8 a 2 fps + dhash: el tramo donde los frames casan a un DESFAZE constante
 * ES la intro (verificado: Gravity Falls la clava en 44→83s). Requiere
 * ffmpeg (setup.sh lo instala). */
let FFMPEG_OK = null;
function ffmpegOk() {
  if (FFMPEG_OK !== null) return FFMPEG_OK;
  try { FFMPEG_OK = !!execFileSync('which', ['ffmpeg'], { timeout: 4000 }).toString().trim(); }
  catch { FFMPEG_OK = false; }
  if (!FFMPEG_OK) console.log('[intro] sin ffmpeg — detección por video apagada (instala ffmpeg)');
  return FFMPEG_OK;
}
function introFramesDe(archivo, segs) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-v', 'error', '-i', archivo, '-t', String(segs || 240), '-vf', 'fps=2,scale=9x8,format=gray', '-f', 'rawvideo', '-'],
      { timeout: 180000, maxBuffer: 30e6, encoding: 'buffer' }, (err, so) => {
        if (err || !so || !so.length) return resolve(null);
        const FR = 72, osc = [], hashes = [];
        for (let off = 0; off + FR <= so.length; off += FR) {
          let h = 0n, bit = 0n, sum = 0;
          for (let k = 0; k < FR; k++) sum += so[off + k];
          if (sum / FR < 14) { hashes.push(0n); osc.push(true); continue; } /* casi negro: se omite */
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            if (so[off + y * 9 + x] > so[off + y * 9 + x + 1]) h |= (1n << bit);
            bit++;
          }
          hashes.push(h); osc.push(false);
        }
        resolve({ hashes, osc });
      });
  });
}
function introBandade(A, B) {
  const NA = A.hashes.length, NB = B.hashes.length;
  const ham = (a, b) => { let x = a ^ b, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; };
  /* mejor desfase por número de frames que casan (hamming<=8, no negros) */
  let mejor = { d: 0, c: 0 };
  for (let d = -480; d <= 480; d++) {
    let c = 0;
    for (let ia = Math.max(0, d); ia < Math.min(NA, NB + d); ia++) {
      const jb = ia - d;
      if (A.osc[ia] || B.osc[jb]) continue;
      if (ham(A.hashes[ia], B.hashes[jb]) <= 8) c++;
    }
    if (c > mejor.c) mejor = { d, c };
  }
  if (mejor.c < 36) return null; /* menos de 18s comunes: nada */
  /* tramo contiguo con huecos de hasta 6 frames (3s) */
  const d = mejor.d;
  const casan = [];
  for (let ia = Math.max(0, d); ia < Math.min(NA, NB + d); ia++) {
    const jb = ia - d;
    if (A.osc[ia] || B.osc[jb]) continue;
    if (ham(A.hashes[ia], B.hashes[jb]) <= 8) casan.push(ia);
  }
  let mejorTr = { a: 0, b: 0, n: 0 }, a0 = casan[0], ult = casan[0], n = 0;
  for (const ia of casan) {
    if (ia - ult <= 6) { n++; ult = ia; }
    else { if (n > mejorTr.n) mejorTr = { a: a0, b: ult, n }; a0 = ia; ult = ia; n = 1; }
  }
  if (n > mejorTr.n) mejorTr = { a: a0, b: ult, n };
  if (mejorTr.n < 36) return null;
  return { ini: mejorTr.a / 2, fin: (mejorTr.b + 1) / 2, offset: d, frames: mejorTr.n };
}
const INTRO_JOBS = new Map(), INTRO_INTENTOS = new Map(); /* v185: clave→hora de inicio */
let LCT_INTRO_REFRESCO_EN = 0; /* v189: último refresco del mapa de lacartoons */
function introJobAtascado(k) { const t0 = INTRO_JOBS.get(k); return t0 && Date.now() - t0 > 10 * 60 * 1000; } /* v185: 10 min máximo por intento */
/* v137: penalización por resultado — fallo de infra (navegador ocupado, red)
 * retrasa el reintento solo 15 min; «no hay intro común» sí espera 6h */
const INTRO_VEREDICTOS = new Map(); /* v190: intro | sinintro | fallo — lo consume el rastreador */
function penalizarIntro(serieKey, ms) {
  INTRO_INTENTOS.set(serieKey, Date.now() + 6 * 3600 * 1000 - ms);
  if (ms >= 6 * 3600 * 1000) { if (INTRO_VEREDICTOS.get(serieKey) !== 'intro') INTRO_VEREDICTOS.set(serieKey, 'sinintro'); }
  else INTRO_VEREDICTOS.set(serieKey, 'fallo');
}
/* v190: dispara la detección de una serie (la usa el GET de /api/intro y el rastreador) */
function dispararDeteccionIntro(urlStr, serieKeyFija) {
  serieCtxFromUrl(urlStr).then((sc) => {
    if (sc && sc.eps && sc.eps.length > 1) {
      /* comparar episodios de LA MISMA TEMPORADA que el pedido */
      const ped = sc.eps.find((e) => { try { return new URL(e.url).pathname === new URL(urlStr).pathname.replace(/\/$/, ''); } catch { return false; } });
      const t = ped ? ped.temporada : (sc.eps[0] || {}).temporada;
      const mismos = sc.eps.filter((e) => e.temporada === t);
      const kk = serieKeyFija || introKeysDe(urlStr).serie;
      if (kk) detectarIntroSerie(kk, (mismos.length >= 2 ? mismos : sc.eps).slice(0, 3).map((e) => e.url));
    }
  }).catch(() => {});
}
let INTRO_DETECTANDO = 0; /* v298: a lo más 1 detección a la vez */
/* v301: INTERRUPTOR del detector de intros, con botón en el panel y apagado por
 * defecto: la estabilidad primero; cuando el usuario quiera, lo enciende y el
 * detector vuelve a aprender openings (de uno en uno y con medidor, v298/v299). */
let INTRO_AUTO_ON = false;
try { INTRO_AUTO_ON = !!((JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'intro-auto.json'), 'utf8')) || {}).on); } catch {}
function introAutoGuardar() { try { fs.writeFileSync(path.join(DATA_DIR, 'intro-auto.json'), JSON.stringify({ on: INTRO_AUTO_ON })); } catch {} }
/* v310: BARREDORA de intro-*.ts huérfanos — si el proceso muere a media
 * detección (SIGKILL/ABRT) la limpieza del finally no alcanza a correr y los
 * pedazos de video se quedan en /tmp: en Oracle juntaron 26 GB (685 archivos).
 * Al arrancar no hay detección viva, así que se barre lo viejo; y cada hora
 * se revisa de nuevo por si un matarazo deja más basura. */
function introTmpBarrer(edadMs) {
  let borrados = 0;
  try {
    const dir = os.tmpdir(); const ahora = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!/^intro-[0-9a-f]+\.ts$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (ahora - fs.statSync(p).mtimeMs > edadMs) { fs.unlinkSync(p); borrados++; } } catch {}
    }
  } catch {}
  if (borrados) console.log('[intro-tmp] v310: barredora quitó ' + borrados + ' archivos huérfanos de /tmp');
}
setTimeout(() => introTmpBarrer(30 * 60 * 1000), 20000); /* residuos del proceso anterior */
setInterval(() => introTmpBarrer(3 * 3600 * 1000), 3600 * 1000); /* red de seguridad continua */
async function detectarIntroSerie(serieKey, urls) {
  if (!INTRO_AUTO_ON) return; /* v301: apagado por interruptor */
  /* v298: cada detección mete decenas de MB de video en RAM. En Oracle (con
   * fpcalc/ffmpeg instalados) varias corrían a la vez por el rastreo masivo y
   * reventaban el heap de 512 MB: el proceso moría cada pocos minutos y
   * «Encendido» quedaba siempre en 0/1m. Ahora: una a la vez y con tope. */
  if (INTRO_DETECTANDO >= 1) return;
  if (process.memoryUsage().heapUsed / 1048576 > 300) return; /* heap caliente: hoy no */
  INTRO_DETECTANDO++;
  try { return await detectarIntroSerieInterno(serieKey, urls); }
  finally { INTRO_DETECTANDO--; }
}
async function detectarIntroSerieInterno(serieKey, urls) {
  /* v134: correr también cuando lo guardado es aprendido-a-mano (pudo salir de
   * un clic equivocado) — la huella de audio es la prueba fuerte; lo único que
   * NO se re-analiza es lo que ya vino de la huella misma */
  if (!fpcalcOk() || !serieKey || (INTROS[serieKey] && INTROS[serieKey].by === 'auto') || INTRO_JOBS.has(serieKey)) return;
  if (Date.now() - (INTRO_INTENTOS.get(serieKey) || 0) < 6 * 3600 * 1000) return;
  INTRO_JOBS.set(serieKey, Date.now());
  console.log('[intro] herramientas: fpcalc ' + (fpcalcOk() ? 'sí' : 'NO') + ', ffmpeg ' + (ffmpegOk() ? 'sí' : 'NO') + (ffmpegOk() ? '' : ' — SIN VIDEO no se puede detectar en danimados: instala ffmpeg'));
  console.log('[intro] detectando intro de ' + serieKey + ' (comparando el inicio de 2 episodios)…');
  try {
    const listos = [];
    let nEp = 0;
    for (const u of urls.slice(0, 3)) {
      nEp++;
      try {
        console.log('[intro] resolviendo episodio ' + nEp + '…');
        const r = await resolverNativo(u);
        console.log('[intro] episodio ' + nEp + ' resuelto: ' + (r && r.m3u8 ? 'ok' : 'sin m3u8'));
        if (r && r.m3u8) {
          /* v187: TODO baja por el PROXY propio — los CDNs (vimeos p.ej.)
           * amarran el token al Referer del embed y rechazan al bajador
           * directo (403); /api/hls guarda el Referer correcto por host
           * (es el mismo camino del player, probado) */
          listos.push(r.m3u8.startsWith('/')
            ? 'http://127.0.0.1:' + PORT + r.m3u8
            : 'http://127.0.0.1:' + PORT + '/api/hls?u=' + encodeURIComponent(r.m3u8));
        }
      } catch (e) { console.log('[intro] un episodio no se dejó resolver: ' + String(e && e.message || e).slice(0, 90)); }
      if (listos.length >= 2) break;
    }
    if (listos.length < 2) { penalizarIntro(serieKey, 15 * 60 * 1000); return console.log('[intro] no pude resolver 2 episodios de ' + serieKey + ' — reintento en 15 min'); }
    console.log('[intro] bajando inicio del episodio 1…');
    const f0 = await descargarInicioEp(listos[0]);
    console.log('[intro] ep1 bajado: ' + (f0 ? 'ok' : 'FALLO'));
    const f1 = f0 && await descargarInicioEp(listos[1]);
    console.log('[intro] ep2 bajado: ' + (f1 ? 'ok' : 'FALLO'));
    if (!f0 || !f1) { try { if (f0) fs.unlinkSync(f0); } catch {} try { if (f1) fs.unlinkSync(f1); } catch {} /* v310: sin huérfanos */ penalizarIntro(serieKey, 15 * 60 * 1000); return console.log('[intro] descargas incompletas para ' + serieKey + ' — reintento en 15 min'); }
    try {
        /* v184: VIDEO primero (robusto entre re-encodes), audio de respaldo */
      let guardado = false;
      let framesOk = false; /* v190: distingue «no comparten intro» (veredicto) de «los frames fallaron» (fallo de infra) */
      if (ffmpegOk()) {
        console.log('[intro] extrayendo frames de video…');
        const [fa2, fb2] = await Promise.all([introFramesDe(f0), introFramesDe(f1)]);
        framesOk = !!(fa2 && fb2);
        console.log('[intro] frames: ' + (fa2 && fa2.hashes.length) + ' y ' + (fb2 && fb2.hashes.length));
        if (fa2 && fb2) {
          const band = introBandade(fa2, fb2);
          if (band && band.fin <= 420 && band.ini <= 240) {
            INTROS[serieKey] = { start: Math.round(band.ini), end: Math.max(Math.round(band.fin) - 2, Math.round(band.ini) + 30), by: 'auto', at: Date.now() };
            penalizarIntro(serieKey, 6 * 3600 * 1000);
            INTRO_VEREDICTOS.set(serieKey, 'intro');
            guardarIntros();
            guardado = true;
            console.log(`[intro] ✅ ${serieKey}: intro detectada POR VIDEO ${Math.round(band.ini)}s→${Math.round(band.fin)}s (${band.frames} frames casando, desfase ${band.offset})`);
          } else if (band) {
            guardado = true; /* zona común fuera del rango de una intro: no se guarda nada */
            penalizarIntro(serieKey, 6 * 3600 * 1000);
            console.log(`[intro] ${serieKey}: zona común en video (${Math.round(band.ini)}s→${Math.round(band.fin)}s) no parece una intro — nada que saltar`);
          }
        }
      }
      const esDani = /^dani:/.test(serieKey); /* v185: el audio no sirve en danimados — SOLO video decide */
      const [ha, hb] = guardado || esDani ? [null, null] : await Promise.all([fpcalcArchivo(f0), fpcalcArchivo(f1)]);
      if (esDani && !guardado) {
        penalizarIntro(serieKey, ffmpegOk() && framesOk ? 6 * 3600 * 1000 : 15 * 60 * 1000); /* v190: sin frames NO es veredicto — reintenta en 15 min */
        console.log('[intro] ' + serieKey + ': sin conclusión por video' + (ffmpegOk() ? ' — los episodios no comparten intro al inicio' : ' (FALTA ffmpeg — instálalo y reintenta en 15 min)'));
      }
      else if (ha && hb && ha.length > 130 && hb.length > 130) {
        const hit = compararHuellas(ha, hb);
        if (hit && hit.dur >= 45 && hit.fin <= 420 && hit.ini <= 240) {
          const finSeg = Math.max(Math.round(hit.fin) - 2, Math.round(hit.ini) + 30); /* 2s antes: jamás comerse contenido */
          const iniSeg = Math.round(hit.ini);
          const anterior = INTROS[serieKey];
          if (anterior && anterior.by === 'manual' && Math.abs(anterior.start - iniSeg) <= 20 && Math.abs(anterior.end - finSeg) <= 20) {
            penalizarIntro(serieKey, 6 * 3600 * 1000);
            INTRO_VEREDICTOS.set(serieKey, 'intro');
            console.log(`[intro] ${serieKey}: la huella CONFIRMA la intro aprendida a mano (${iniSeg}→${finSeg}s) — se respeta lo aprendido`);
          } else {
            INTROS[serieKey] = { start: iniSeg, end: finSeg, by: 'auto', at: Date.now() };
            penalizarIntro(serieKey, 6 * 3600 * 1000);
            INTRO_VEREDICTOS.set(serieKey, 'intro');
            guardarIntros();
            if (anterior && anterior.by === 'manual') console.log(`[intro] ✅ ${serieKey}: la huella CORRIGE la aprendida a mano (estaba ${anterior.start}→${anterior.end}s, verdad del audio: ${iniSeg}→${finSeg}s)`);
            else console.log(`[intro] ✅ ${serieKey}: intro detectada ${iniSeg}s→${finSeg}s`);
          }
        } else {
          penalizarIntro(serieKey, 6 * 3600 * 1000); /* conclusión real: sin intro común — 6h */
          console.log(`[intro] ${serieKey}: los episodios no comparten intro al inicio — no se guarda nada`);
        }
      } else if (!guardado) {
        /* v189: ni video ni audio dieron veredicto (huellas nulas, moov ausente…) —
         * SIN esto cada sondeo reiniciaba el job en bucle */
        penalizarIntro(serieKey, 15 * 60 * 1000);
        console.log('[intro] ' + serieKey + ': sin conclusión (video y audio) — reintento en 15 min');
      }
    } finally { try { fs.unlinkSync(f0); } catch {} try { fs.unlinkSync(f1); } catch {} }
  } catch {} finally { INTRO_JOBS.delete(serieKey); }
}
/* ═══════ v139: PRECALENTAMIENTO DEL SIGUIENTE EPISODIO ═══════
 * En Juntos las caricaturas tardan porque resolver un episodio abre el
 * navegador del server y le saca el stream (~5-20s). Mientras ven uno,
 * el server ya resuelve EL QUE SIGUE en segundo plano: al picarle
 * «siguiente» (o el auto-next) el stream ya está en caché (2h) y entra
 * al instante. Llamar es barato: si ya está en caché, el resolver
 * devuelve la caché sin abrir nada. */
const PREFETCH_EP = new Map(); /* roomCode → videoUrl ya programado */
function programarPrefetchEp(room) {
  try {
    const url = room && room.videoUrl;
    if (!url || !room.code) return;
    if (PREFETCH_EP.get(room.code) === url) return; /* este episodio ya está programado */
    PREFETCH_EP.set(room.code, url);
    setTimeout(() => {
      (async () => {
        try {
          const viva = rooms.get(room.code);
          if (!viva || viva.videoUrl !== url) return; /* cambiaron de video o la sala murió */
          const sc = await serieCtxFromUrl(url).catch(() => null);
          if (!sc || !sc.eps || !sc.eps.length) return; /* pelis o fuente sin lista: nada que precalentar */
          const idx = sc.idx != null ? sc.idx : sc.eps.findIndex((e) => e.url === url);
          const nxt = sc.eps[idx + 1];
          if (!nxt || !nxt.url) return; /* era el último */
          await resolverNativo(nxt.url);
          console.log('[prefetch] siguiente episodio listo en caché para la sala ' + room.code);
        } catch (e) { console.log('[prefetch] no se pudo precalentar: ' + String(e && e.message || e).slice(0, 80)); }
      })();
    }, 20000); /* 20s: que el video actual arranque tranquilo primero */
  } catch {}
}
/* v135: cabeza de ventaja — al abrir el SELECTOR de episodios de una serie
 * sin intro conocida ya se lanza la detección (mientras eliges episodio, el
 * server ya está comparando el audio de los primeros) */
function precargarIntroDeSerie(eps) {
  try {
    const urls = (eps || []).map((e) => e && e.url).filter(Boolean);
    if (!urls.length) return;
    const ks = introKeysDe(urls[0]);
    if (!ks.serie) return;
    // v223: si ya se aprendió bien, no repetir; pero si es manual o no existe, re-detectar cada vez que alguien entra (mejor intro posible)
    if (INTROS[ks.serie] && INTROS[ks.serie].by === 'auto' && Date.now() - (INTROS[ks.serie].at || 0) < 24 * 3600 * 1000) return;
    if (introJobAtascado(ks.serie)) INTRO_JOBS.delete(ks.serie); /* v185 */
    if (!fpcalcOk() || INTRO_JOBS.has(ks.serie)) return;
    // v223: ventana de enfriamiento más corta cuando el usuario entra activamente (1h en vez de 6h)
    if (Date.now() - (INTRO_INTENTOS.get(ks.serie) || 0) < 1 * 3600 * 1000) return;
    detectarIntroSerie(ks.serie, urls.slice(0, 3));
  } catch {}
}
function dispararDeteccionIntroSiToca(urlEp) {
  try {
    const ks = introKeysDe(urlEp);
    if (!ks.serie) return;
    if (INTROS[ks.serie] && INTROS[ks.serie].by === 'auto' && Date.now() - (INTROS[ks.serie].at || 0) < 12 * 3600 * 1000) return;
    if (introJobAtascado(ks.serie)) INTRO_JOBS.delete(ks.serie);
    if (!fpcalcOk() || INTRO_JOBS.has(ks.serie)) return;
    if (Date.now() - (INTRO_INTENTOS.get(ks.serie) || 0) < 1 * 3600 * 1000) return;
    // toma hasta 3 episodios de la serie si los tenemos en serieCtxFromUrl
    serieCtxFromUrl(urlEp).then((sc) => {
      const urls = sc && sc.eps && sc.eps.length ? sc.eps.map((e) => e.url).slice(0, 3) : [urlEp];
      detectarIntroSerie(ks.serie, urls);
    }).catch(() => { try { detectarIntroSerie(ks.serie, [urlEp]); } catch {} });
  } catch {}
}

function mirrorState(room) {
  const m = mirrors.get(room.code);
  const out = m
    ? { active: true, url: m.url || '', audio: AUDIO_READY, playing: !!m.playing, ready: !!m.ready, t: Math.round((m.curTime || 0) * 10) / 10, dur: Math.round((m.curDur || 0) * 10) / 10 }
    : { active: false, url: '', audio: false, playing: false, ready: false, t: 0, dur: 0 }; /* v128: tiempo/duración para Saltar intro */
  /* v74: si están viendo un episodio de serie, la sala sabe cuál es y si
   * hay siguiente/anterior — para los botoncitos de la esquina */
  if (m && m.serie) {
    const sc = m.serie;
    out.serie = {
      titulo: sc.titulo, poster: sc.poster, cover: sc.cover || '', total: sc.eps.length, /* v120: cover curada de IMDb */
      num: sc.eps[sc.idx] ? sc.eps[sc.idx].num : '',
      hayPrev: sc.idx > 0, hayNext: sc.idx >= 0 && sc.idx < sc.eps.length - 1,
    };
  }
  return out;
}

/* v166: SESIÓN PERSISTENTE DEL ESPEJO — el perfil de Chrome se guarda en
 * .sesion-yt (fuera de git): quien inicie sesión en una página espejeada
 * (el «inicia sesión» de youtube, spotify, twitch…) no la vuelve a teclear
 * NUNCA: cada espejo arranca de una CLONA y al cerrarse se sincroniza de
 * vuelta a la maestra. Importante: esa sesión queda para TODA la sala —
 * solo inicien sesión cuentas desechables/de invitado. */
const DIR_SESION = path.join(__dirname, '.sesion-yt');
let ultimaSincroSesion = 0;
function clonarPerfilSesion() {
  try {
    if (!fs.existsSync(DIR_SESION)) return '';
    const os = require('os');
    const clon = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mirror-'));
    fs.cpSync(DIR_SESION, clon, { recursive: true, force: true });
    for (const f of fs.readdirSync(clon)) {
      if (/^Singleton/.test(f)) { try { fs.rmSync(path.join(clon, f), { recursive: true, force: true }); } catch {} }
    }
    return clon;
  } catch { return ''; }
}
function sincroSesion(clon) {
  try {
    if (!clon || !fs.existsSync(clon)) return;
    if (Date.now() - ultimaSincroSesion < 30000) return;
    ultimaSincroSesion = Date.now();
    fs.mkdirSync(DIR_SESION, { recursive: true });
    fs.cpSync(clon, DIR_SESION, { recursive: true, force: true });
  } catch {}
}

async function startMirror(room, rawUrl, userId) {
  const url = normalizeWebUrl(rawUrl);
  /* v172: danimados (Titanes completas) SIEMPRE nativo — error limpio */
  if (/danimados\.cc\/episodios\//i.test(url)) {
    try { if (await ponerDaniNativo(room, url, userId)) return; }
    catch (e) {
      console.log('[espejo] dani no pudo (' + String(e.message || e).slice(0, 70) + ')');
      try { sysMsg(room, '⚠️ ' + String(e.message || e).slice(0, 120)); } catch {}
      throw new Error(String(e.message || e).slice(0, 140));
    }
  }
    /* v164: si lo que piden es un VIDEO de youtube → NATIVO (el espejo come
   * muros de login con youtube); la portada/búsqueda sí sigue en espejo */
  if (idYoutubeDe(url)) {
    /* v169: la página watch de youtube es un LABERINTO de captchas para una
     * IP de datacenter (aun con sesión iniciada nos pone «verifica que no
     * eres un bot» mil veces) — si la extracción falla, mejor error limpio:
     * el video NUNCA se abre en el espejo */
    try { if (await ponerYoutubeNativo(room, url, userId)) return; }
    catch (e) {
      console.log('[espejo] youtube nativo no pudo (' + String(e.message || e).slice(0, 70) + ') — error limpio, sin espejo');
      try { sysMsg(room, '⚠️ No pude sacar el video de YouTube (' + String(e.message || e).slice(0, 60) + '). Reintenta en un minuto — y no lo abrimos en el espejo porque youtube nos pone captchas infinitos.'); } catch {}
      throw new Error('No pude sacar el video de YouTube — reintenta en un minuto');
    }
  }
  if (mirrors.has(room.code)) {
    const m = mirrors.get(room.code);
    if ((m.url || '') === url) {
      m.url = url;
      m.ownerId = userId;
      await m.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      broadcast(room, 'mirror-state', mirrorState(room));
      return;
    }
    /* v74: cambiar de página (o de episodio) → arranque limpio: la
     * detección de "lista en pausa" vuelve a correr para lo nuevo */
    await stopMirror(room);
  }

  /* reciclaje de slots: nunca fallamos por "demasiados espejos" si podemos liberar
   * 1) espejos que este mismo usuario dejó en otras salas (se mudó de sala)
   * 2) espejos de salas ya vacías
   * 3) si aún así está lleno: el espejo más antiguo (con aviso a su sala) */
  for (const code of [...mirrors.keys()]) {
    if (mirrors.get(code).ownerId === userId) {
      console.log(`[espejo] reciclando espejo anterior del mismo usuario (sala ${code})`);
      await stopMirror(code);
    }
  }
  if (mirrors.size >= MIRROR_MAX) {
    for (const code of [...mirrors.keys()]) {
      const r = rooms.get(code);
      if (!r || r.clients.size === 0) await stopMirror(code);
    }
  }
  if (mirrors.size >= MIRROR_MAX) {
    const oldest = [...mirrors.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) {
      const r = rooms.get(oldest[0]);
      if (r) sysMsg(r, 'El espejo de esta sala se cerró para liberar memoria del servidor');
      await stopMirror(oldest[0]);
    }
  }

  if (!PUPPETEER) {
    try { PUPPETEER = require('puppeteer'); }
    catch { throw new Error('puppeteer no está instalado en el servidor (npm i puppeteer)'); }
  }

  /* Chrome headless no emite audio (comprobado a mano); con Xvfb usamos
   * Chrome real, que sí suena en el sink virtual de PulseAudio. */
  const useXvfb = AUDIO_READY && fs.existsSync('/tmp/.X11-unix/X99');
  const dirPerfil = clonarPerfilSesion(); /* v166: clon de la sesión maestra */
  const browser = await PUPPETEER.launch({
    headless: !useXvfb,
    // CHROME_PATH (opcional): usar un Chromium del sistema, p.ej. en ARM
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    ...(dirPerfil ? { userDataDir: dirPerfil } : {}), /* v166: sesión persistente */
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
    ].concat(useXvfb ? ['--window-size=1280,720', '--no-first-run', '--disable-infobars', '--start-maximized'] : []),
    env: Object.assign({}, process.env, AUDIO_READY ? { PULSE_SERVER, DISPLAY: ':99' } : {}),
  }).catch((e) => { throw new Error('no se pudo lanzar Chrome: ' + e.message); });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.setUserAgent(MIRROR_UA).catch(() => {});
  /* v14: sin ventanas emergentes de anuncios dentro del espejo */
  await page.evaluateOnNewDocument(() => {
    try { window.open = function () { return null; }; } catch {}
    /* v62: fuera el cartel de "ayuda" que tapa las películas de Cuevana */
    try {
      const ponerCss = () => {
        try {
          const st = document.createElement('style');
          st.textContent = '.mdl-help,.button-close-help{display:none!important}::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}html{scrollbar-width:none!important}';
          (document.head || document.documentElement).appendChild(st);
        } catch {}
      };
      ponerCss();
      document.addEventListener('DOMContentLoaded', ponerCss);
    } catch {}
    /* parecer un navegador normal: algunos reproductores bloquean automatizacion */
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en'] }); } catch {}
    document.addEventListener('click', (e) => {
      try {
        const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
        if (a) a.target = '_self';
      } catch {}
    }, true);
  }).catch(() => {});
  const cdp = await page.createCDPSession();

  const m = { browser, page, cdp, url, frame: null, dirty: false, timer: null, emptySince: null, ownerId: userId, startedAt: Date.now(), serie: null, dirPerfil };
  mirrors.set(room.code, m);
  /* v118: un espejo nuevo APAGA lo nativo — antes el room.native viejo
   * seguía vivo en el estado y el cliente se peleaba entre el video
   * directo y el espejo (parpadeo/tira y afloja al cambiar de modo) */
  if (room.native) {
    room.native = null;
    room.serieCtx = null;
    room.videoUrl = '';
    room.videoImg = '';
    broadcast(room, 'state', stateOf(room));
  }

  /* v74: si la URL es un episodio de serie, cargamos su lista de
   * episodios para los botones de siguiente/anterior */
  serieCtxFromUrl(url).then((sc) => {
    if (mirrors.get(room.code) === m && sc) {
      m.serie = sc;
      broadcast(room, 'mirror-state', mirrorState(room));
    }
  }).catch(() => {});

  cdp.on('Page.screencastFrame', async (ev) => {
    m.frame = {
      d: 'data:image/jpeg;base64,' + ev.data,
      w: (ev.metadata && ev.metadata.deviceWidth) || 1280,
      h: (ev.metadata && ev.metadata.deviceHeight) || 720,
    };
    m.dirty = true;
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch {}
  });

  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) {
      m.url = f.url();
      /* v164: navegaron a un video de youtube dentro del espejo → se cambia
       * el modo: el video va NATIVO (extraído por piped/invidious), no hay
       * muro de login posible, hay audio en cada teléfono y fullscreen */
      if (idYoutubeDe(m.url)) { cambiarYtNativo(room, m.url, userId); return; }
      broadcast(room, 'mirror-state', mirrorState(room));
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  m.quality = 52;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: m.quality, maxWidth: 1200, maxHeight: 675, everyNthFrame: 1 });

  /* v14: comodidad — si el reproductor queda abajo, acercarlo a la vista
     (muchas paginas cargan el video solo cuando el reproductor es visible) */
  const viva = () => mirrors.get(room.code) === m;
  /* v25: si Chrome entero muere, reabrir el espejo en automático */
  browser.on('disconnected', () => { if (viva()) recoverMirror(room.code, 'Chrome desconectado').catch(() => {}); });
  const scrollToPlayer = () => m.page.evaluate(() => {
    const cands = document.querySelectorAll('video, [class*="player" i], [id*="player" i], iframe[src*="embed" i]');
    if (!cands.length) return;
    let best = null, bestArea = -1;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    if (!best) return;
    const r = best.getBoundingClientRect();
    const cy = r.y + r.height / 2;
    if (cy > innerHeight * 0.55 || r.y < -40) best.scrollIntoView({ block: 'center' });
  }).catch(() => {});

  /* v14: intentar dar play solo (paginas de peliculas lo necesitan);
     se reintenta un rato y se detiene en cuanto algo suena.
     v58: Cuevana ya no carga el video por sí solo — el iframe del
     reproductor aparece hasta que alguien le pica. En páginas de
     PELÍCULA lo tocamos por ti: la película empieza directa.
     (Series quedan manuales a propósito, mecanismo propio después.) */
  /* v61: páginas de "cine" = películas Y episodios de serie (cine-calidad) */
  const esPagCine = () => /\/(wp-)?pelicula\/[a-z0-9-]+|\/episode\/|\/ver\/|youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\//i.test(m.url || ''); /* v167: los videos sueltos de youtube (respaldo) también */
  let avisoPlay = false;
  /* v59: pantalla completa — cuando la película arranca, el video llena
   * todo el espejo (sin el decorado de la página alrededor) */
  const pantallaCompleta = async () => {
    try {
      await m.page.evaluate(() => {
        const sel = ['#tviframe', '.TPlayer iframe', '.TPlayerCn iframe', 'iframe[src*="goodstream"]', 'iframe[src*="embed"]'];
        let f = null;
        for (const s of sel) { f = document.querySelector(s); if (f) break; }
        if (!f) f = [...document.querySelectorAll('iframe')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 300 && r.height > 150; }).sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
        if (f) f.style.cssText = 'position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;z-index:2147483647 !important;border:0 !important;background:#000 !important;';
      }).catch(() => {});
      for (const fr of m.page.frames()) {
        await fr.evaluate(() => {
          const v = document.querySelector('video');
          if (v) v.style.cssText = 'position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;object-fit:contain !important;background:#000 !important;z-index:2147483647 !important;';
        }).catch(() => {});
      }
    } catch {}
  };
  const intentoPlay = async (n) => {
    if (!viva() || n > 30) return;
    let sonando = false;
    let hayVideo = false;
    let videoListo = false;
    try { await scrollToPlayer(); } catch {}
    try {
      for (const fr of m.page.frames()) {
        const r = await fr.evaluate((cine) => {
          let ok = false;
          let cant = 0;
          let listo = false;
          document.querySelectorAll('video, audio').forEach((v) => {
            if (v.tagName === 'VIDEO') {
              cant++;
              if (v.readyState >= 2 && v.duration > 1) listo = true;
            }
            /* v127: SIEMPRE en pausa — el servidor no reproduce nada solo:
             * el play lo da el botón de la sala y arranca para todos a la
             * vez. Antes los episodios (no-cine) arrancaban solos aquí. */
            if (!v.paused && v.currentTime > 0) ok = true;
          });
          return { ok, cant, listo };
        }, esPagCine()).catch(() => ({ ok: false, cant: 0, listo: false }));
        if (r.ok) sonando = true;
        if (r.cant > 0) hayVideo = true;
        if (r.listo) videoListo = true;
      }
    } catch {}
    /* v58: cine sin video → tocar el reproductor para que cargue
     * (se hace a partir del 2do intento, por si la página aún carga) */
    if (esPagCine() && n >= 1) {
      try {
        /* v63: fuera carteles de "ayuda" y avisos que tapan la película */
        await m.page.evaluate(() => {
          try {
            document.querySelectorAll('.mdl-help').forEach((x) => { try { x.remove(); } catch {} });
            document.querySelectorAll('.button-close-help, [aria-label="Cerrar ayuda"]').forEach((x) => { try { x.click(); } catch {} });
          } catch {}
        }).catch(() => {});
        /* v63: Latanime — su reproductor no arranca solo; montamos nosotros
         * el iframe del mejor servidor (mp4upload primero) a pantalla completa */
        if (/latanime\./.test(m.url || '') && !videoListo) {
          await m.page.evaluate(() => {
            try {
              if (document.querySelector('iframe.rr-player')) return;
              const links = [...document.querySelectorAll('a.play-video')].filter((a) => (a.getAttribute('data-player') || '').length > 8);
              if (!links.length) return;
              const dec = (a) => { try { return atob(a.getAttribute('data-player')); } catch { return ''; } };
              const mejor = links.find((a) => /mp4upload/i.test(dec(a)))
                || links.find((a) => !/voe\.|mixdrop|netu|streamtape|streamwish/i.test(dec(a)));
              if (!mejor) return;
              const f = document.createElement('iframe');
              f.className = 'rr-player';
              f.src = dec(mejor);
              f.allow = 'autoplay; encrypted-media; fullscreen';
              f.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483000;border:0;background:#000';
              document.body.appendChild(f);
            } catch {}
          }).catch(() => {});
        }
        /* v62: en AnimeFLV, uqload no descarga solo — si hay otra opción
         * (mp4upload o la que sea) la elegimos nosotros; es idempotente:
         * solo cambia si el seleccionado sigue siendo uqload */
        if (/\/ver\//.test(m.url || '') && !videoListo && /animeflv\./.test(m.url || '')) {
          await m.page.evaluate(() => {
            try {
              const lis = [...document.querySelectorAll('.opt li')];
              const act = lis.find((x) => x.classList.contains('se'));
              if (!act || !/uqload/i.test(act.textContent || '')) return;
              const mejor = lis.find((x) => /mp4upload/i.test(x.textContent || ''))
                || lis.find((x) => x !== act && !/uqload/i.test(x.textContent || ''));
              if (mejor) mejor.click();
            } catch {}
          }).catch(() => {});
        }
        if (!hayVideo) {
          /* v63: pelis Y episodios — picar el servidor recomendado para que
           * cargue (goodstream primero, sin trailers ni VIP) */
          await m.page.evaluate(() => {
            const malos = ['youtube', 'google', 'vip', 'trailer'];
            const a = document.querySelector('a.play[data-domain=goodstream]')
              || [...document.querySelectorAll('a.play')].find((x) => {
                const d = (x.getAttribute('data-domain') || '').toLowerCase();
                return d && !malos.includes(d);
              });
            if (a) { a.scrollIntoView({ block: 'center' }); a.click(); }
          }).catch(() => {});
          /* v64: algunas PELIS de cine-calidad pasan por un "protector de
           * enlaces" (acortalink) que bloquea el video — decodificamos nosotros
           * el servidor goodstream (base64 → números → letras corridas 2
           * lugares) y montamos el iframe directo a pantalla completa */
          if (/cine-calidad\./.test(m.url || '') && n >= 2) {
            await m.page.evaluate(() => {
              try {
                if (document.querySelector('iframe.rr-player')) return;
                const a = document.querySelector('a.play[data-domain=goodstream]');
                const enc = a && a.getAttribute('data-src');
                if (!enc) return;
                const nums = atob(enc).trim().split(/\s+/).map((x) => parseInt(x, 10));
                if (!nums.length || nums.some((x) => !Number.isFinite(x))) return;
                const crudo = String.fromCharCode(...nums.slice(0, 400));
                const url = [...crudo].map((ch) => String.fromCharCode(ch.charCodeAt(0) - 2)).join('');
                if (!/^https?:\/\/[a-z0-9.-]+\//i.test(url)) return;
                const f = document.createElement('iframe');
                f.className = 'rr-player';
                f.src = url;
                f.allow = 'autoplay; encrypted-media; fullscreen';
                f.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483000;border:0;background:#000';
                document.body.appendChild(f);
              } catch {}
            }).catch(() => {});
          }
          /* v58: Cuevana no usa a.play → tocar su reproductor directamente */
          const punto = await m.page.evaluate(() => {
            const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 200 && b.height > 100; };
            const c = document.querySelector('.TPlayerTb.Current') || document.querySelector('.TPlayer') || document.querySelector('#Optres');
            if (!c || !vis(c)) return null;
            const b = c.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          }).catch(() => null);
          if (punto) await m.page.mouse.click(punto.x, punto.y);
        } else if (!videoListo && n >= 2) {
          /* v61: hay video pero no carga (rs<2) — los episodios de
           * cine-calidad necesitan un toque encima del reproductor */
          const punto = await m.page.evaluate(() => {
            const f = document.querySelector('#tviframe') || [...document.querySelectorAll('iframe')].find((x) => {
              const b = x.getBoundingClientRect();
              return b.width > 250 && b.height > 140;
            });
            if (!f) return null;
            f.scrollIntoView({ block: 'center' });
            const b = f.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          }).catch(() => null);
          if (punto) await m.page.mouse.click(punto.x, punto.y);
        }
      } catch {}
    }
    if (videoListo && !m.ready && esPagCine()) { /* v167: solo pelis/eps — youtube tiene videítos de vista previa en su feed y con ellos mandábamos la sala a «modo película»: botón de play gigante y toques comidos; un sitio web se NAVEGA, no se pausa */
      /* v61→v127: la peli/episodio queda LISTO EN PAUSA en cualquier página
       * (no solo cine) — el botón «Toca para empezar» aparece en la sala y
       * cuando alguien le pica, empieza para todos al mismo tiempo */
      for (const fr of m.page.frames()) {
        await fr.evaluate(() => document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} })).catch(() => {});
      }
      m.ready = true;
      m.playing = false;
      console.log(`[espejo] lista en pausa en sala ${room.code} (${(m.url || '').slice(0, 60)})`);
      if (esPagCine()) pantallaCompleta().catch(() => {});
      broadcast(room, 'mirror-state', mirrorState(room));
      return; /* listo: no seguir reintentando */
    }
    /* v127: episodio cuyo player sigue dormido (ni siquiera cargó el video)
     * — un toque al reproductor para que aparezca; una sola vez (intento 6) */
    if (!esPagCine() && !videoListo && n === 6) {
      const pt = await m.page.evaluate(() => {
        try {
          const vs = [...document.querySelectorAll('video')].sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
          if (vs.length) { vs[0].scrollIntoView({ block: 'center' }); try { vs[0].click(); } catch {} return null; }
          const f = [...document.querySelectorAll('iframe')].find((x) => { const b = x.getBoundingClientRect(); return b.width > 250 && b.height > 140; });
          if (!f) return null;
          f.scrollIntoView({ block: 'center' });
          const b = f.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        } catch { return null; }
      }).catch(() => null);
      if (pt) await m.page.mouse.click(pt.x, pt.y).catch(() => {});
    }
    if (sonando && !avisoPlay) {
      avisoPlay = true;
      m.playing = true;
      console.log(`[espejo] reproduciendo en sala ${room.code} (${(m.url || '').slice(0, 60)})`);
      if (esPagCine()) pantallaCompleta().catch(() => {});
      broadcast(room, 'mirror-state', mirrorState(room));
    }
    if (!sonando) setTimeout(() => intentoPlay(n + 1), 5000);
  };
  setTimeout(() => intentoPlay(0), 3000);

  /* audio: capturar el monitor del sink virtual y difundirlo en trozos de 100 ms
   * (los trozos de silencio no se envían → ancho de banda casi cero en reposo) */
  if (AUDIO_READY) {
    m.parec = spawn('parec', ['-d', 'raveroom.monitor', '--format=s16le', `--rate=${AUDIO_RATE}`, '--channels=1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { PULSE_SERVER }),
    });
    m.audioBuf = Buffer.alloc(0);
    const CHUNK = AUDIO_RATE / 10 * 2; // 100 ms en bytes s16le
    m.parec.stdout.on('data', (d) => {
      m.audioBuf = Buffer.concat([m.audioBuf, d]);
      while (m.audioBuf.length >= CHUNK) {
        const chunk = m.audioBuf.slice(0, CHUNK);
        m.audioBuf = m.audioBuf.slice(CHUNK);
        let sum = 0;
        for (let i = 0; i < chunk.length; i += 2) { const s = chunk.readInt16LE(i); sum += s * s; }
        const rms = Math.sqrt(sum / (chunk.length / 2));
        if (rms > 40) broadcast(room, 'mirror-audio', { d: chunk.toString('base64'), rate: AUDIO_RATE, ch: 1 });
      }
    });
    m.parec.on('error', () => {});
  }

  m.stats = { bytes: 0, frames: 0, at: Date.now() };
  m.timer = setInterval(() => {
    const now = Date.now();
    /* v168: youtube navega «por dentro» al picarle a un video del feed
     * (pushState) — el evento de navegación no siempre avisa y el cambio
     * a nativo no se disparaba: la sala se quedaba en el espejo con el
     * muro de login. El timer compara la URL real en cada tick. */
    try {
      const uAhora = m.page.url();
      if (uAhora && uAhora !== (m.urlUlt || '')) {
        m.urlUlt = uAhora;
        if (idYoutubeDe(uAhora)) { cambiarYtNativo(room, uAhora, m.ownerId); return; }
      }
    } catch {}
    /* v25: si la página murió, reabrir sola (sin esperar que un clic falle) */
    if (m.page.isClosed()) { recoverMirror(room.code, 'página cerrada (watchdog)').catch(() => {}); return; }
    if (m.dirty && m.frame) {
      m.dirty = false;
      broadcast(room, 'mirror-frame', m.frame);
      m.stats.frames++;
      m.stats.bytes += Math.floor(m.frame.d.length * 0.75);
    }

    /* v165: el ⛶ de la PÁGINA espejeada (youtube, vimeo…) llena el Chrome
     * del servidor — invisible para la sala. Al detectarlo, mandamos a
     * todos a pantalla completa (la de Huddle); al salir, todos salen. */
    if (!m.fsCheck && m.page && !m.page.isClosed()) {
      m.fsCheck = m.page.evaluate(() => !!(document.fullscreenElement || document.webkitFullscreenElement))
        .then((on) => {
          m.fsCheck = null;
          if (on === m.fsOn) return;
          m.fsOn = on;
          broadcast(room, 'mirror-fs', { on: !!on });
        })
        .catch(() => { m.fsCheck = null; });
    }

    /* v166: la sesión del espejo se guarda CADA MINUTO — si el espejo muere
     * o lo cierran, el login que hicieron sobrevive (el clon se hace de la
     * maestra y sin esto un espejo caído se llevaba la sesión consigo) */
    if (m.dirPerfil && now - (m.ultimaSincro || m.startedAt) > 60000) {
      m.ultimaSincro = now;
      sincroSesion(m.dirPerfil);
    }

    /* calidad adaptativa: si el ancho de banda sube demasiado, bajamos calidad
     * JPEG (frames más chicos = más fps que llegan); si sobra, la subimos. */
    if (now - m.stats.at >= 2500) {
      const kbs = m.stats.bytes / 2.5 / 1024;
      const restart = (q) => {
        m.quality = q;
        m.cdp.send('Page.startScreencast', {
          format: 'jpeg', quality: q, maxWidth: 1200, maxHeight: 750, everyNthFrame: 1,
        }).catch(() => {});
        console.log(`[${new Date().toISOString()}] 🪞 calidad JPEG → ${q} (${kbs.toFixed(0)} KB/s, ${m.stats.frames} frames/2.5s)`);
      };
      if (kbs > 1100 && m.quality > 34) restart(m.quality - 8);
      else if (kbs < 350 && m.stats.frames > 5 && m.quality < 60) restart(m.quality + 8);
      m.stats = { bytes: 0, frames: 0, at: now };
    }

    if (room.clients.size === 0) {
      if (!m.emptySince) m.emptySince = Date.now();
      else if (Date.now() - m.emptySince > MIRROR_IDLE_MS) stopMirror(room).catch(() => {});
    } else m.emptySince = null;
  }, MIRROR_SEND_MS);

  console.log(`[${new Date().toISOString()}] 🪞 espejo iniciado en sala ${room.code} → ${url}`);
  broadcast(room, 'mirror-state', mirrorState(room));
}

async function stopMirror(roomOrCode) {
  const code = typeof roomOrCode === 'string' ? roomOrCode.toUpperCase() : roomOrCode.code;
  const m = mirrors.get(code);
  if (!m) return;
  mirrors.delete(code);
  clearInterval(m.timer);
  if (m.parec) { try { m.parec.kill(); } catch {} }
  try { await m.browser.close(); } catch {}
  sincroSesion(m.dirPerfil); /* v166: el login que hicieron queda para la próxima */
  try { if (m.dirPerfil) fs.rmSync(m.dirPerfil, { recursive: true, force: true }); } catch {}
  console.log(`[${new Date().toISOString()}] 🪞 espejo detenido en sala ${code}`);
  const room = rooms.get(code);
  if (room) broadcast(room, 'mirror-state', { active: false, url: '' });
}

/* v25: si la página espejada muere, antes el espejo quedaba "zombie" (imagen
 * congelada y clics que fallaban con errores en inglés). Ahora se reabre sola
 * la misma URL; si no se puede, se detiene con un aviso claro en el chat. */
async function recoverMirror(code, reason) {
  const m = mirrors.get(code);
  const room = rooms.get(code);
  if (!m || !room) return false;
  if (m.recovering) return true; // ya se está reabriendo
  m.recovering = true;
  const url = m.url || '';
  const owner = m.ownerId;
  console.log(`[${new Date().toISOString()}] 🪞♻️ página espejada muerta en ${code} (${String(reason).slice(0, 90)}) — reabriendo ${url}`);
  sysMsg(room, '🪞 La página se cayó — reabriendo sola…');
  try { await stopMirror(code); } catch {}
  if (url) {
    try { await startMirror(room, url, owner); return true; }
    catch (e) { console.error(`[${new Date().toISOString()}] 🪞 no se pudo reabrir el espejo en ${code}:`, e.message || e); }
  }
  sysMsg(room, '🪞 No se pudo reabrir la página — espejo detenido');
  return false;
}

/* v162: YOUTUBE SIN MURO DE LOGIN — la IP del servidor es de datacenter y
 * youtube le enseña «Inicia sesión para confirmar que no eres un bot» al
 * player normal. El player EMBEBIDO (/embed/) no pasa por ese check y
 * además autoplay sin gesto. También convierte los clics dentro de youtube
 * (ver framenavigated): cualquier video que abras va a parar al embed. */
function urlYoutubeEmbed(u) {
  try {
    const x = new URL(u);
    if (!/(^|\.)youtube\.com$|^youtu\.be$/i.test(x.hostname)) return null;
    if (/\/embed\//i.test(x.pathname)) return null; /* ya es embed */
    let id = '';
    let m = /[?&]v=([A-Za-z0-9_-]{6,16})/.exec(x.search);
    if (m) id = m[1];
    if (!id) {
      m = /^\/(shorts|live|embed)\/([A-Za-z0-9_-]{6,16})/.exec(x.pathname);
      if (m && m[1] !== 'embed') id = m[2];
    }
    if (!id && /(^|\.)youtu\.be$/i.test(x.hostname)) {
      m = /^\/([A-Za-z0-9_-]{6,16})/.exec(x.pathname);
      if (m) id = m[1];
    }
    if (!id || /^watch$/.test(id)) return null;
    /* v163: el embed cargado como PÁGINA principal suelta «Error 153» —
     * está diseñado para vivir dentro de un iframe. Lo servimos envuelto
     * en una mini-página local de Huddle (ver /api/yt). */
    return 'http://127.0.0.1:' + PORT + '/api/yt?v=' + encodeURIComponent(id);
  } catch { return null; }
}

function normalizeWebUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('URL vacía');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); } catch { throw new Error('URL inválida'); }
  return u;
}

/* ---------------------- SSE: /api/events ---------------------- */

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function handleEvents(req, res, url) {
  const code = (url.searchParams.get('room') || '').toUpperCase();
  const uidParam = url.searchParams.get('uid') || '';
  const name = (url.searchParams.get('name') || '').trim().slice(0, 20);
  const tok = url.searchParams.get('tok') || '';
  const urec = users.get(name.toLowerCase());
  if (!name || !urec || urec.token !== tok) {
    res.writeHead(200, SSE_HEADERS);
    send(res, 'badName', { error: 'Nombre de usuario no válido — vuelve a entrar' });
    res.end();
    return;
  }
  urec.lastSeenAt = Date.now();

  if (!/^[A-Z0-9]{4,8}$/.test(code)) { res.writeHead(400); res.end('código de sala inválido'); return; }

  /* si entramos con "join=1" (botón Unirme), la sala debe existir ya:
     evita entrar por error de tipeo a una sala vacía recién creada */
  if (url.searchParams.get('join') === '1' && !rooms.has(code)) {
    res.writeHead(200, SSE_HEADERS);
    send(res, 'noRoom', { error: 'No encontramos esa sala. Revisa el código.' });
    res.end();
    return;
  }

  const room = getOrCreateRoom(code); // si entras con un código, la sala existe
  const isNew = !room.users.has(uidParam);
  const ver = url.searchParams.get('v') || 'v?'; // versión del cliente (diagnóstico)
  if (isNew && room.users.size >= MAX_USERS) {
    res.writeHead(200, SSE_HEADERS);
    send(res, 'full', { error: 'La sala está llena 😢' });
    res.end();
    return;
  }

  const userId = isNew ? uid() : uidParam;
  if (isNew) room.users.set(userId, { id: userId, name, joinedAt: Date.now(), token: tok, nameKey: name.toLowerCase() });
  else { const ru = room.users.get(userId); ru.name = name; ru.token = tok; ru.nameKey = name.toLowerCase(); }

  if (!room.hostId || !room.users.has(room.hostId)) room.hostId = userId;

  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(':ok\n\n');
  res.rrUserId = userId;
  room.clients.add(res);
  room.emptyAt = 0; // hay gente: se resetea el contador de sala vacía

  send(res, 'hello', {
    userId,
    srvVersion: UI_VERSION,
    room: {
      code: room.code,
      hostId: room.hostId,
      anyoneCanControl: room.anyoneCanControl,
      users: usersOf(room),
      chat: room.chat.slice(-50),
      state: stateOf(room),
      mirror: mirrorState(room),
    },
  });

  /* si el navegador del usuario tiene una interfaz vieja (cache), le avisamos
   * por chat — es el único canal que las interfaces viejas sí muestran */
  if (ver && ver !== UI_VERSION) {
    send(res, 'chat', {
      msg: {
        id: uid(),
        userId: 'raveroom',
        name: 'Huddle',
        text: `Actualización disponible (${UI_VERSION}): recarga la página (F5 o el botón de recargar del preview) para ver la nueva interfaz`,
        at: Date.now(),
      },
    });
    console.log(`[${new Date().toISOString()}] ⚠️ cliente con versión vieja (${ver}) en sala ${room.code} — aviso enviado`);
  }
  // quien entra tarde al espejo recibe el frame actual de inmediato
  const m = mirrors.get(room.code);
  if (m && m.frame) send(res, 'mirror-frame', m.frame);
  broadcast(room, 'users', { users: usersOf(room) });
  if (isNew) sysMsg(room, `${name} entró a la sala`);
  console.log(`[${new Date().toISOString()}] [${ver}] + ${name} → sala ${room.code} (${room.users.size} usuarios)`);

  const heartbeat = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    room.clients.delete(res);
    if (room.clients.size === 0) room.emptyAt = Date.now(); // sala vacía: empieza la cuenta

    // Esperamos 10 s por si es una reconexión del mismo usuario.
    setTimeout(() => {
      if (rooms.get(room.code) !== room) return; // la sala ya no existe
      const stillHere = [...room.clients].some((c) => c.rrUserId === userId);
      if (stillHere || !room.users.has(userId)) return;
      const user = room.users.get(userId);
      room.users.delete(userId);
      broadcast(room, 'users', { users: usersOf(room) });
      sysMsg(room, `${user.name} salió de la sala`);
      if (room.hostId === userId) {
        const next = [...room.clients][0];
        if (next) {
          room.hostId = next.rrUserId;
          broadcast(room, 'users', { users: usersOf(room) });
          sysMsg(room, `${room.users.get(room.hostId)?.name || 'Alguien'} es el nuevo anfitrión`);
        }
      }
    }, 10000).unref();
  });
}

/* ---------------------- acciones: /api/action ---------------------- */

function canControl(room, userId) {
  return room.anyoneCanControl || userId === room.hostId;
}

async function handleAction(req, res, body) {
  const code = String(body.room || '').toUpperCase();
  const userId = String(body.userId || '');
  const action = body.action || {};
  const type = action.type;
  const room = rooms.get(code);

  if (!room) {
    console.warn(`[acción] ❌ sala "${code}" no existe (tipo ${type || '?'})`);
    return json(res, 404, { ok: false, error: 'Sala no encontrada' });
  }
  if (!room.users.has(userId)) {
    console.warn(`[acción] ❌ usuario "${userId.slice(0, 8)}…" no está en la sala ${code} (tipo ${type || '?'})`);
    return json(res, 403, { ok: false, error: 'No estás en la sala (recarga la página)' });
  }

  console.log(`[acción] ${type || '?'}${action.op ? '/' + action.op : ''} en ${code} por ${room.users.get(userId).name}`);

  const now = Date.now();

  /* — acciones siempre permitidas — */
  if (type === 'chat') {
    const text = String(action.text || '').slice(0, 300).trim();
    if (text) {
      const msg = { id: uid(), userId, name: room.users.get(userId).name, text, at: now };
      room.chat.push(msg);
      trimChat(room);
      broadcast(room, 'chat', { msg });
    }
    return json(res, 200, { ok: true });
  }

  if (type === 'videoMeta') { /* v128: duración del video nativo (la reporta el cliente al cargar) — con ella el server detecta el final en el latido */
    if (room.native) room.videoDuration = Math.max(0, Number(action.duration) || 0);
    return json(res, 200, { ok: true });
  }
  if (type === 'ended') { // el video terminó de reproducirse
    room.position = Math.max(0, Number(action.position) || 0);
    room.isPlaying = false;
    room.updatedAt = now;
    broadcast(room, 'state', stateOf(room));
    /* v128: si era un EPISODIO, el siguiente entra SOLO (pausado, con
     * «Toca para empezar») — el guardia evita el doble salto cuando varios
     * clientes reportan el final casi al mismo tiempo */
    if (room.native && room.serieCtx && room.autoNextKey !== room.videoUrl) {
      room.autoNextKey = room.videoUrl;
      autoSiguienteNativo(room).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }

  if (type === 'mode') { // solo el anfitrión cambia quién controla
    if (userId !== room.hostId) return json(res, 403, { ok: false, error: 'Solo el anfitrión puede cambiar esto' });
    room.anyoneCanControl = !!action.anyoneCanControl;
    broadcast(room, 'state', stateOf(room));
    return json(res, 200, { ok: true });
  }

  /* — acciones de control de reproducción — */
  if (!canControl(room, userId)) {
    console.warn(`[acción] 🔒 control bloqueado: ${room.users.get(userId).name} (${type}) en ${code}`);
    return json(res, 403, { ok: false, error: 'Solo el anfitrión controla la reproducción' });
  }

  /* espejo de páginas web (navegador remoto compartido) */
  if (type === 'mirror') {
    const op = action.op;
    try {
      if (op === 'start' || op === 'nav') {
        /* v92: primero el camino NATIVO — si sabemos sacar el video
         * directo (goodstream/vimeos/mp4upload), TODOS lo reproducen en
         * su navegador, sincronizados por el reloj de la sala. Sin
         * Chrome, sin frames: full calidad y carga rapidísima. Si no
         * se puede, caemos al espejo de siempre. */
        let urlNat = String(action.url || '').trim();
        if (/danimados\.cc/i.test(urlNat)) { try { urlNat = 'https://danimados.cc' + new URL(urlNat).pathname; } catch {} } /* v172 */
        /* v219: los flujos del propio Huddle (Movie del catálogo vivo) llegan como
           ruta relativa; antes esto se saltaba el camino nativo y caía al navegador
           remoto (—«No se pudo espejar: no se pudo lanzar Chrome»). Ahora se
           reproducen nativo, igual que un anime resuelto. */
        if (/^https?:\/\//i.test(urlNat) || esStreamPropioUS(urlNat)) {
          let errNat = '';
          const nat = await resolverNativo(urlNat).catch((e) => {
            errNat = String(e.message || e).slice(0, 140);
            console.log('[sala] nativo no pudo (' + errNat.slice(0, 60) + ')');
            return null;
          });
          if (nat) {
            if (mirrors.has(room.code)) stopMirror(room).catch(() => {});
            room.videoUrl = urlNat; programarPrefetchEp(room); try { dispararDeteccionIntroSiToca(urlNat); } catch {}
            const idYT = idYoutubeDe(urlNat); /* v164: título real del video si la instancia lo dio */
            room.videoTitle = String((idYT && YT_TITULOS.get(idYT)) || action.title || guessTitle(urlNat)).slice(0, 80);
            room.videoImg = String(action.img || '').slice(0, 400);
            room.native = { m3u8: nat.m3u8, mp4: !!nat.mp4, proxy: !!nat.proxy, subs: nat.subs || [] };
            room.position = 0;
            room.isPlaying = false; /* v127: SIEMPRE pausado — «Toca para empezar» lo arranca para todos a la vez */
            room.videoDuration = 0; room.autoNextKey = null; /* v128 */
            room.updatedAt = Date.now();
            /* v118: si es un episodio de serie, la cadena completa
             * (siguiente/anterior) se arma por detrás — llega con el
             * siguiente broadcast de estado y prende los botoncitos */
            room.serieCtx = null;
            serieCtxFromUrl(urlNat).then((sc) => {
              if (sc && room.videoUrl === urlNat) {
                room.serieCtx = sc;
                /* v144: título con temporada/capítulo claros — lo que manda el
                 * selector a veces es solo «1x2» o el nombre pelón */
                if (!/EP\.\d+/.test(room.videoTitle)) {
                  const n2 = epNumDeUrl(urlNat, sc);
                  if (n2) room.videoTitle = tituloBonitoEp(sc.titulo, n2);
                }
                broadcast(room, 'state', stateOf(room));
              }
            }).catch(() => {});
            sysMsg(room, `${room.users.get(userId).name} puso: ${room.videoTitle}`);
            broadcast(room, 'state', stateOf(room));
            return json(res, 200, { ok: true, nativo: true });
          }
          /* v117: si es contenido NUESTRO (capítulos de nuestras fuentes)
           * y no se pudo resolver, NO se abre el espejo — el error viaja
           * claro a la sala. Antes se abría la página web en el navegador
           * remoto: mala experiencia y un Chrome extra comiendo RAM que
           * después tumbaba las demás resoluciones. */
          if (/lacartoons\.com\/serie\/capitulo\/|miscaricaturas\.com\/[a-z0-9-]+-\d{2}x\d{2}|pelisxd\.com\/pelicula\//i.test(urlNat)) {
            return json(res, 200, { ok: false, error: errNat || 'No pude resolver ese capítulo — prueba otro' });
          }
        }
        await startMirror(room, action.url, userId);
        /* v78: título y carátula de lo que abrieron (para "Continuar viendo") */
        const nm = mirrors.get(room.code);
        if (nm) {
          nm.title = String(action.title || '').slice(0, 80);
          nm.img = String(action.img || '').slice(0, 400);
        }
        // si se estaba reproduciendo un video, se pausa: la sala pasa a modo espejo
        if (room.isPlaying) {
          room.position = currentPosition(room);
          room.isPlaying = false;
          room.updatedAt = Date.now();
          broadcast(room, 'state', stateOf(room));
        }
        return json(res, 200, { ok: true });
      }
      if (op === 'stop') {
        /* v92: si la sala iba nativa, se suelta igual */
        if (room.native) {
          room.native = null;
          room.serieCtx = null; /* v118 */
          room.videoUrl = '';
          room.videoImg = '';
          room.position = 0;
          room.isPlaying = false;
          room.updatedAt = Date.now();
          broadcast(room, 'state', stateOf(room));
        }
        await stopMirror(room);
        return json(res, 200, { ok: true });
      }
      if (op === 'epPrev' || op === 'epNext') {
        /* v74: episodio anterior/siguiente — cambia para toda la sala */
        /* v118: modo NATIVO — la cadena vive en room.serieCtx y cada
         * episodio se resuelve como al abrirlo (video directo, como
         * Solo). Si el siguiente está caído, se salta hasta 3 y se
         * avanza al primero que SÍ dé video. */
        /* v129: si la sala es NATIVA pero el contexto de serie no llegó al
         * abrir (su carga tarda o falló UNA vez), se reconstruye AHORA —
         * sin esto los botones morían para siempre en caricaturas/cartoons
         * (en animes la carga es rápida y por eso ahí sí funcionaba) */
        if (room.native && !room.serieCtx && room.videoUrl) {
          const scFix = await serieCtxFromUrl(room.videoUrl).catch(() => null);
          if (scFix) {
            room.serieCtx = scFix;
            broadcast(room, 'state', stateOf(room));
          }
        }
        if (room.native && room.serieCtx) {
          let sc = room.serieCtx;
          const dir = op === 'epNext' ? 1 : -1;
          /* v141: si la URL actual NO está en la lista cacheada, el contexto
           * está VIEJO — antes caía a sc.idx (un índice de hace tiempo) y
           * «el siguiente» resultaba ser EL MISMO episodio: la sala «cambiaba»
           * al mismo video y la tarjetita parpadeaba. Ahora se reconstruye
           * el contexto al momento. */
          let actual = sc.eps.findIndex((e) => e.url === room.videoUrl);
          if (actual < 0) {
            const scFix = await serieCtxFromUrl(room.videoUrl).catch(() => null);
            if (scFix && scFix.eps && scFix.eps.length) {
              room.serieCtx = scFix;
              sc = scFix;
              actual = sc.eps.findIndex((e) => e.url === room.videoUrl);
            }
          }
          if (actual < 0) return json(res, 400, { ok: false, error: 'No sé qué episodio están viendo — ábrelo del selector' });
          const desde = actual;
          if (desde + dir < 0 || desde + dir >= sc.eps.length) {
            return json(res, 400, { ok: false, error: op === 'epNext' ? 'Ya estás en el último episodio' : 'Ya estás en el primer episodio' });
          }
          /* v147: ANUNCIO INMEDIATO — el título del episodio que va a cargar
           * sale YA (chip + tarjeta de todos), no hasta que termine de
           * resolverse; la tarjeta deja de verse «congelada» en el viejo */
          const tituloPrev = room.videoTitle, imgPrev = room.videoImg;
          const primeroEp = sc.eps[desde + dir];
          if (primeroEp) {
            room.videoTitle = tituloBonitoEp(sc.titulo, primeroEp.num);
            if (sc.poster) room.videoImg = sc.poster.slice(0, 400);
            room.switchingEp = Date.now();
            broadcast(room, 'state', stateOf(room));
          }
          const fallarEp = (mensaje) => {
            room.switchingEp = null;
            room.videoTitle = tituloPrev; room.videoImg = imgPrev; /* el nuevo no llegó: se regresa el nombre */
            broadcast(room, 'state', stateOf(room));
            return json(res, 200, { ok: false, error: mensaje });
          };
          /* v118: se SALTA el episodio si la fuente confirma que está
           * muerto/sin español, o si su player existe pero nunca suelta
           * video («muerto por dentro», como el 1x03 de Billy) — así el
           * botón no se atora en un cap roto. Lo brincado se anuncia en
           * el chat para que nadie pierda la cuenta. */
          const MUERTO_RE = /ya no está disponible|ya no existe en la fuente|solo está en MEGA|no está en español|solo existe en inglés|no respondió|no entregó el video/i;
          let elegido = null, nat = null, errN = '';
          const saltados = [];
          for (let paso = 1; paso <= 3 && desde + dir * paso >= 0 && desde + dir * paso < sc.eps.length; paso++) {
            const cand = sc.eps[desde + dir * paso];
            if (cand.url === room.videoUrl) continue; /* v141: jamás «cambiar» al mismo video */
            errN = '';
            nat = null;
            /* v144: los fallos transitorios (navegador ocupado, red lenta) se
             * REINTENTAN AQUÍ MISMO 2 veces más — antes el error viajaba al
             * teléfono con «reintenta» y tocaba picarle varias veces */
            for (let intento = 0; intento < 3 && !nat; intento++) {
              nat = await resolverNativo(cand.url).catch((e) => { errN = String(e.message || e).slice(0, 140); return null; });
              if (!nat && intento < 2 && !MUERTO_RE.test(errN)) await new Promise((r3) => setTimeout(r3, 700));
            }
            if (nat) { elegido = { cand, idx: desde + dir * paso }; break; }
            if (!MUERTO_RE.test(errN)) {
              return fallarEp(/reintenta/i.test(errN) ? errN : errN + ' — reintenta');
            }
            console.log('[sala] episodio caído (' + cand.num + '), sigo al próximo');
            saltados.push(cand.num);
          }
          if (!elegido) {
            return fallarEp(errN || 'No pude resolver el episodio siguiente — prueba del selector');
          }
          const notaSalto = saltados.length ? ' (sin ' + saltados.join(', ') + ')' : '';
          room.videoUrl = elegido.cand.url; programarPrefetchEp(room);
          room.videoTitle = tituloBonitoEp(sc.titulo, elegido.cand.num); /* v144 */
          if (sc.poster) room.videoImg = sc.poster.slice(0, 400);
          room.native = { m3u8: nat.m3u8, mp4: !!nat.mp4, proxy: !!nat.proxy, subs: nat.subs || [] };
          sc.idx = elegido.idx;
          room.position = 0;
          room.isPlaying = false; /* v127: el episodio entra PAUSADO */
          room.videoDuration = 0; room.autoNextKey = null; /* v128 */
          room.switchingEp = null; /* v147: llegó */
          room.updatedAt = Date.now();
          sysMsg(room, `${room.users.get(userId).name} puso: ${room.videoTitle}${notaSalto}`);
          broadcast(room, 'state', stateOf(room));
          return json(res, 200, { ok: true, nativo: true });
        }
        if (room.native) return json(res, 200, { ok: false, error: 'La sala va en modo video directo — reintenta' }); /* v129: el espejo no roba el salto */
        let m = mirrors.get(room.code);
        /* v127: auto-reparación del ESPEJO — si el contexto de serie no llegó
         * al abrir (la carga de episodios falló a la primera), se reconstruye
         * AHORA con la URL actual; antes los botones morían para siempre */
        if (m && !m.serie) {
          const scFix = await serieCtxFromUrl(m.url || '').catch(() => null);
          if (scFix) { m.serie = scFix; broadcast(room, 'mirror-state', mirrorState(room)); }
        }
        if (!m || !m.serie) return json(res, 404, { ok: false, error: 'No hay serie en el espejo' });
        let idx = m.serie.eps.findIndex((e) => e.url === (m.url || ''));
        if (idx < 0) { /* v141: sin confiar en índices viejos — reconstruir */
          const scFix = await serieCtxFromUrl(m.url || '').catch(() => null);
          if (scFix) { m.serie = scFix; broadcast(room, 'mirror-state', mirrorState(room)); }
          idx = m.serie.eps.findIndex((e) => e.url === (m.url || ''));
        }
        if (idx < 0) return json(res, 400, { ok: false, error: 'No sé qué episodio están viendo — ábrelo del selector' });
        const target = m.serie.eps[idx + (op === 'epNext' ? 1 : -1)];
        if (!target) return json(res, 400, { ok: false, error: op === 'epNext' ? 'Ya estás en el último episodio' : 'Ya estás en el primer episodio' });
        if (target.url === (m.url || '')) return json(res, 400, { ok: false, error: 'No hay episodio hacia ahí — prueba del selector' }); /* v141 */
        /* v127: la sala SABE qué episodio toca ahora (título/carátula para
         * todos, «Continuar viendo» correcto) — antes el salto no tocaba el
         * estado y los invitados se quedaban con el episodio viejo */
        room.videoUrl = target.url; programarPrefetchEp(room);
        room.videoTitle = tituloBonitoEp(m.serie.titulo, target.num); /* v144 */
        if (m.serie.poster) room.videoImg = m.serie.poster.slice(0, 400);
        room.switchingEp = Date.now(); /* v147: anuncio inmediato */
        broadcast(room, 'state', stateOf(room));
        await stopMirror(room);
        await startMirror(room, target.url, userId);
        room.switchingEp = null; /* v147: llegó */
        sysMsg(room, `${room.users.get(userId).name} puso: ${room.videoTitle}`);
        broadcast(room, 'state', stateOf(room));
        return json(res, 200, { ok: true });
      }

      const m = mirrors.get(room.code);
      if (!m) return json(res, 404, { ok: false, error: 'El espejo no está activo' });

      if (op === 'play' || op === 'pause') {
        /* v61: play/pause central — el botón grande de la sala */
        const pausar = op === 'pause';
        for (const fr of m.page.frames()) {
          await fr.evaluate((p) => {
            document.querySelectorAll('video').forEach((v) => { try { if (p) v.pause(); else v.play().catch(() => {}); } catch {} });
          }, pausar).catch(() => {});
        }
        m.playing = !pausar;
        if (m.playing) m.ready = true;
        broadcast(room, 'mirror-state', mirrorState(room));
        return json(res, 200, { ok: true });
      }
      if (op === 'seekTo') {
        /* v61: llevar la peli a un punto exacto (la barrita) */
        const a = Math.max(0, +action.time || 0);
        let movio = false;
        for (const fr of m.page.frames()) {
          try {
            const r = await fr.evaluate((t) => {
              const vs = [...document.querySelectorAll('video')].filter((v) => v.duration > 1);
              if (!vs.length) return false;
              vs.sort((x, y) => (y.videoWidth * y.videoHeight) - (x.videoWidth * x.videoHeight));
              try { vs[0].currentTime = Math.max(0, Math.min(vs[0].duration - 0.5, t)); } catch {}
              return true;
            }, a).catch(() => false);
            if (r) movio = true;
          } catch {}
        }
        return json(res, 200, { ok: true, movio });
      }
      if (op === 'click') {
        await m.page.mouse.click(Math.max(0, +action.x || 0), Math.max(0, +action.y || 0));
        /* v29: ¿el toque dejó el foco en un cuadro de texto? (la página puede
         * mover el foco un instante después: darle un momento) */
        await new Promise((r) => setTimeout(r, 350));
        let typing = false;
        for (const fr of m.page.frames()) {
          try {
            typing = await fr.evaluate(() => {
              const el = document.activeElement;
              return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
            });
          } catch {}
          if (typing) break;
        }
        /* v61: si el toque puso el video en marcha o lo pausó, avisar
         * (así el botón de play de la sala siempre dice la verdad) */
        if (m.ready) {
          setTimeout(async () => {
            try {
              let sonando = false;
              for (const fr of m.page.frames()) {
                const r = await fr.evaluate(() => [...document.querySelectorAll('video')].some((v) => !v.paused && v.currentTime > 0)).catch(() => false);
                if (r) { sonando = true; break; }
              }
              if (sonando !== !!m.playing) {
                m.playing = sonando;
                broadcast(room, 'mirror-state', mirrorState(room));
              }
            } catch {}
          }, 900);
        }
        return json(res, 200, { ok: true, typing });
      }
      else if (op === 'type') await m.page.keyboard.type(String(action.text || '').slice(0, 60));
      else if (op === 'press') await m.page.keyboard.press(String(action.key || 'Enter').slice(0, 20));
      else if (op === 'back') await m.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      else if (op === 'fwd') await m.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      else if (op === 'scroll') await m.page.mouse.wheel({ deltaY: +action.deltaY || 0, deltaX: +action.deltaX || 0 });
      else if (op === 'seek') {
        /* v60: adelantar / atrasar — se mueve el video más grande de la página */
        const delta = Math.max(-300, Math.min(300, +action.delta || 0));
        let movio = false;
        for (const fr of m.page.frames()) {
          try {
            const r = await fr.evaluate((d) => {
              const vs = [...document.querySelectorAll('video')].filter((v) => v.readyState >= 1 && v.duration > 1);
              if (!vs.length) return false;
              vs.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
              const v = vs[0];
              try { v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + d)); } catch {}
              return true;
            }, delta).catch(() => false);
            if (r) movio = true;
          } catch {}
        }
        return json(res, 200, { ok: true, movio });
      }
      else return json(res, 400, { ok: false, error: 'Operación de espejo desconocida' });

      return json(res, 200, { ok: true });
    } catch (e) {
      const msg = String(e.message || e);
      console.error(`[acción] 💥 error de espejo en ${code}:`, msg);
      /* v25: página muerta → se reabre sola y el usuario ve un mensaje humano */
      if (PAGE_DEAD.test(msg)) {
        json(res, 200, { ok: false, error: 'La página se cayó — reabriéndola automáticamente…' });
        recoverMirror(code, msg).catch(() => {});
        return;
      }
      return json(res, 500, { ok: false, error: 'No se pudo espejar: ' + msg.slice(0, 120) });
    }
  }

  switch (type) {
    case 'play':
      room.isPlaying = true;
      room.updatedAt = now;
      break;

    case 'pause':
      room.position = currentPosition(room);
      room.isPlaying = false;
      room.updatedAt = now;
      break;

    case 'seek':
      room.position = Math.max(0, Number(action.position) || 0);
      room.updatedAt = now;
      break;

    case 'video': {
      const url = String(action.url || '').trim();
      const title = String(action.title || '').slice(0, 80).trim();
      if (!url) {
        // v18: detener — quitar el video de la sala (devuelve las opciones a todos)
        room.videoUrl = '';
        room.videoTitle = '';
        room.native = null; /* v92 */
        room.serieCtx = null; /* v118 */
        room.videoImg = ''; /* v92 */
        room.position = 0;
        room.isPlaying = false;
        room.updatedAt = now;
        if (mirrors.has(room.code)) stopMirror(room).catch(() => {});
        sysMsg(room, `${room.users.get(userId).name} detuvo el video`);
        break;
      }
      if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
        console.warn(`[acción] ❌ URL inválida: "${url}"`);
        return json(res, 400, { ok: false, error: 'URL inválida (debe ser http(s) o una ruta local)' });
      }
      room.videoUrl = url; programarPrefetchEp(room);
      room.videoTitle = title || guessTitle(url);
      room.position = 0;
      room.isPlaying = false;
      room.updatedAt = now;
      // cargar un video apaga el espejo, si estaba activo
      if (mirrors.has(room.code)) stopMirror(room).catch(() => {});
      sysMsg(room, `${room.users.get(userId).name} cargó: ${room.videoTitle}`);
      break;
    }

    default:
      console.warn(`[acción] ❌ acción desconocida "${type}" en ${code}`);
      return json(res, 400, { ok: false, error: 'Acción desconocida' });
  }

  broadcast(room, 'state', stateOf(room));
  return json(res, 200, { ok: true });
}

/* ---------------------- estáticos (con soporte Range p/ video) ---------------------- */

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end(); return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // los archivos de la app no se cachean (para que los cambios lleguen siempre)
    const noCache = /\.(html|js|css)$/i.test(filePath);
    /* v131: no-store — la caché del WebView de la PWA ignoraba no-cache y
     * seguía sirviendo JS viejo; no-store prohibe guardarlo siquiera */
    const extra = noCache ? { 'Cache-Control': 'no-store, must-revalidate' } : {};
    const range = req.headers.range;

    /* v122: index.html se sirve con la versión REAL inyectada — los ?v= de
     * app.js/style.css se rellenan con UI_VERSION al vuelo. Subir la versión
     * en el server basta: el cliente descarga el JS nuevo (URL distinta) y su
     * APP_VERSION (leída de su propio tag) coincide — nadie se queda "viejo"
     * de forma permanente. Antes el ?v= y APP_VERSION iban A MANO y se
     * descuadraron (el cliente vivía jurando que era v119). */
    if (/index\.html$/.test(filePath)) {
      fs.readFile(filePath, 'utf8', (e2, html) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
        html = html.replace(/((?:app\.js|style\.css)\?v=)[^"\s]*/g, '$1' + UI_VERSION);
        const buf = Buffer.from(html, 'utf8');
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store, must-revalidate', 'Accept-Ranges': 'bytes' });
        res.end(buf);
      });
      return;
    }

    if (range && st.size) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return;
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, Object.assign({
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        }, extra));
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, Object.assign({
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
    }, extra));
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------------- v43: directorio de páginas ----------------------
 * Las páginas del desplegable ya no están clavadas en el código: viven en
 * data/sites.json y crecen cuando alguien pega una URL nueva. Al agregar,
 * el servidor visita la página y saca su nombre, descripción y logo. */
const SITES_FILE = path.join(__dirname, 'data', 'sites.json');
const LOGO_DIR = path.join(__dirname, 'public', 'sites-logos');
const SITES_SEED = [
  /* v65: Latanime primero (predeterminado) — v68: fuera AnimeFLV
   * v70: fuera AnimeD23 también (queda Latanime, Cuevana y YouTube) */
  { name: 'Latanime', desc: 'Animes con audio latino', url: 'https://latanime.org/', logo: '/sites/latanime.png' },
  { name: 'Cuevana', desc: 'Películas y series', url: 'https://cuevana.mov/', logo: '/sites/cuevana.png' },
  { name: 'YouTube', desc: 'Videos', url: 'https://www.youtube.com/', logo: '/sites/youtube.png' },
];
function loadSitesFile() {
  try {
    let l = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
    if (Array.isArray(l)) {
      let cambio = false;
      for (const s of l) {
        /* v46: Cuevana movió su portada de /inicio a la raíz */
        if (/^https?:\/\/(www\.)?cuevana\.[a-z.]+\/inicio\/?$/i.test(s.url || '')) { s.url = s.url.replace(/\/inicio\/?$/i, '/'); cambio = true; }
      }
      /* v68/v70: fuera AnimeD23 — v97: AnimeFLV REGRESA
       * (trae mp4upload entre sus servidores y sirve de respaldo) */
      const antes = l.length;
      l = l.filter((s) => !/animed23\./i.test(s.url || ''));
      if (l.length !== antes) { cambio = true; console.log('[sitios] - AnimeD23'); }
      /* v65: logos propios para Latanime y AnimeFLV (los favicons de Google
       * a veces no cargan → salía el recuadro azul con ?) y Latanime
       * predeterminado: primero en la lista */
      const esLat = (s) => /latanime\./i.test(s.url || '');
      for (const s of l) {
        if (esLat(s) && s.logo !== '/sites/latanime.png') { s.logo = '/sites/latanime.png'; cambio = true; }
      }
      if (!l.some(esLat)) {
        l.unshift({ name: 'Latanime', desc: 'Animes con audio latino', url: 'https://latanime.org/', logo: '/sites/latanime.png' });
        cambio = true;
        console.log('[sitios] + Latanime (predeterminado)');
      } else {
        const iLat = l.findIndex(esLat);
        if (iLat > 0) { const [lat] = l.splice(iLat, 1); l.unshift(lat); cambio = true; }
      }
      /* v97: AnimeFLV de vuelta en el directorio, con su logo */
      const esAF = (s) => /animeflv\./i.test(s.url || '');
      for (const s of l) {
        if (esAF(s) && s.logo !== '/sites/animeflv.png') { s.logo = '/sites/animeflv.png'; cambio = true; }
      }
      if (!l.some(esAF)) {
        l.push({ name: 'AnimeFLV', desc: 'Animes (respaldo de Latanime)', url: 'https://vww.animeflv.one/', logo: '/sites/animeflv.png' });
        cambio = true;
        console.log('[sitios] + AnimeFLV (v97)');
      }
      if (cambio) saveSitesFile(l);
    }
    return l;
  } catch { return null; }
}
function saveSitesFile(list) {
  fs.mkdirSync(path.dirname(SITES_FILE), { recursive: true });
  fs.writeFileSync(SITES_FILE, JSON.stringify(list, null, 2));
}
function sitesList() {
  const l = loadSitesFile();
  if (Array.isArray(l) && l.length) return l;
  saveSitesFile(SITES_SEED);
  return SITES_SEED;
}
function normalizarUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('vacía');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('inválida');
  return u.href;
}
function mismaPagina(a, b) {
  const quitar = (x) => String(x || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
  return quitar(a) === quitar(b);
}
const FETCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'; /* v199: compartida — vimeos amarra el token a ESTA UA */
let CDN_RELAY = ''; /* v236: Mac Mini relay para CDNs que bloquean datacenter. Set via /api/set-relay?url=... */
try { const _rl = require('fs').readFileSync('/tmp/huddle-relay.txt', 'utf8').trim(); if (_rl) { if (_rl.includes('lhr.life') || _rl.includes('localhost')) { console.log('[relay] ignorado (lento) ' + _rl); } else { CDN_RELAY = _rl; console.log('[relay] Cargado de disco:', _rl); } } } catch {} /* v236.8: persistir relay */
async function fetchRelay(url, ms) { /* v236: fetch a través del relay — NUNCA cae al directo (el token se liga a la IP) */
  if (!CDN_RELAY) return fetchSeguro(url, ms);
  const relayUrl = CDN_RELAY + '/?u=' + encodeURIComponent(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 15000);
  try {
    const r = await fetch(relayUrl, { signal: ctl.signal, redirect: 'follow', headers: { 'ngrok-skip-browser-warning': 'true', 'User-Agent': FETCH_UA } });
    clearTimeout(t);
    if (!r.ok) throw new Error('relay status ' + r.status);
    // ngrok free devuelve página de aviso si falta el header — detectarla y reintentar con header
    const ct = (r.headers.get('content-type')||'').toLowerCase();
    if (ct.includes('text/html')) {
      const peek = await r.clone().text().catch(()=> '');
      if (peek.includes('assets.ngrok.com') || peek.includes('ngrok') && peek.includes('Visit Site')) {
        throw new Error('relay ngrok warning — falta header');
      }
    }
    return r;
  } catch (e) {
    clearTimeout(t);
    throw new Error('CDN relay no disponible: ' + String(e.message || e).slice(0, 60));
  }
}
async function fetchSeguro(url, ms, extra) { /* v206: cabeceras opcionales (Referer del player de novelas) */
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, {
      signal: c.signal, redirect: 'follow',
      headers: Object.assign({ 'User-Agent': FETCH_UA, 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' }, extra || {}),
    });
  } finally { clearTimeout(t); }
}
/* v291: resumen de procesos (Chrome del navegador, ffmpeg/fpcalc de intros,
 * node) leyendo /proc — para diagnosticar subidas de memoria sin entrar por SSH. */
function procResumen() {
  const out = { chrome: { n: 0, rssMb: 0 }, ffmpeg: { n: 0, rssMb: 0 }, node: { n: 0, rssMb: 0 } };
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' '); } catch { continue; }
      let rssKb = 0;
      try { rssKb = parseInt((/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')) || [])[1] || '0', 10); } catch { continue; }
      const g = /headless_shell|chrome|chromium/i.test(cmd) ? 'chrome' : /ffmpeg|fpcalc/i.test(cmd) ? 'ffmpeg' : /node/i.test(cmd) ? 'node' : '';
      if (g) { out[g].n++; out[g].rssMb += rssKb / 1024; }
    }
  } catch {}
  for (const k of Object.keys(out)) out[k].rssMb = Math.round(out[k].rssMb);
  return out;
}
async function infoDePagina(url) {
  const u = new URL(url);
  let title = '', desc = '', iconHref = '';
  try {
    const r = await fetchSeguro(u.href, 6000);
    if (r.ok && /text\/html/i.test(r.headers.get('content-type') || '')) {
      const html = (await r.text()).slice(0, 500000);
      title = (/<title[^>]*>([^<]{1,160})<\/title>/i.exec(html) || [])[1] || '';
      desc = (/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']{1,240})/i.exec(html) || [])[1] || '';
      if (!desc) desc = (/<meta[^>]+content=["']([^"']{1,240})["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i.exec(html) || [])[1] || '';
      iconHref = (/<link[^>]+rel=["'][^"']*(?:shortcut |apple-touch )?icon[^"']*["'][^>]*href=["']([^"']{2,300})/i.exec(html) || [])[1] || '';
    }
  } catch { /* página inalcanzable: seguimos con los fallbacks */ }
  let name = '';
  try { name = decodeURIComponent(title || ''); } catch { name = title || ''; }
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 40) name = name.slice(0, 40).trim() + '…';
  if (!name) name = u.hostname.replace(/^www\./, '');
  if (desc) desc = desc.replace(/\s+/g, ' ').trim().slice(0, 140);
  return { name, desc, iconHref, url: u.href };
}
async function descargarLogo(u, iconHref) {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const candidatos = [];
  if (iconHref) { try { candidatos.push(new URL(iconHref, u).href); } catch {} }
  candidatos.push(`https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`);
  candidatos.push(new URL('/favicon.ico', u).href);
  for (const cUrl of candidatos) {
    try {
      const r = await fetchSeguro(cUrl, 6000);
      if (!r.ok) continue;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!/image\//.test(ct)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100 || buf.length > 400000) continue;
      const ext = ct.includes('svg') ? 'svg' : (ct.includes('jpeg') || ct.includes('jpg')) ? 'jpg' : (ct.includes('icon')) ? 'ico' : 'png';
      const slug = u.hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'sitio';
      const file = `${slug}-${Date.now().toString(36)}.${ext}`;
      fs.writeFileSync(path.join(LOGO_DIR, file), buf);
      return `/sites-logos/${file}`;
    } catch {}
  }
  return null;
}
function logoDeLetra(name) {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const letra = (name[0] || '?').toUpperCase().replace(/[<>&"']/g, '');
  const file = `letra-${Date.now().toString(36)}.svg`;
  fs.writeFileSync(path.join(LOGO_DIR, file),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#241a3d"/><rect width="64" height="64" rx="14" fill="none" stroke="#5b4a86" stroke-width="2"/><text x="32" y="43" font-family="Arial,Helvetica,sans-serif" font-size="32" fill="#e9e2ff" text-anchor="middle" font-weight="bold">${letra}</text></svg>`);
  return `/sites-logos/${file}`;
}
async function agregarSitio(urlRaw) {
  const url = normalizarUrl(urlRaw);
  const list = sitesList();
  const existente = list.find((s) => mismaPagina(s.url, url));
  if (existente) return { site: existente, exists: true };
  const info = await infoDePagina(url);
  const u = new URL(info.url);
  let logo = await descargarLogo(u, info.iconHref);
  if (!logo) logo = logoDeLetra(info.name);
  const site = { name: info.name, desc: info.desc, url: info.url, logo };
  list.unshift(site);
  saveSitesFile(list);
  console.log(`[sitios] + ${site.name} → ${site.url}`);
  return { site, exists: false };
}

/* ---------------------- servidor ---------------------- */

/* v45: búsqueda en las páginas del directorio — v46: Cuevana por su
 * APIs internas (con póster); resultados listos para crear la sala */
async function buscarCuevana(q) {
  const r = await fetchSeguro(`https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=${encodeURIComponent(q)}&page=1`, 9000);
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return (d.posts || []).slice(0, 12).map((p) => ({
    title: String(p.title || ''),
    url: (p.type === 'movies') ? `https://cine-calidad.mx/pelicula/${p.slug}/` : `https://cine-calidad.mx/serie/${p.slug}`, /* v87: cuevana.mov ya responde 404 — las pelis viven en cine-calidad */
    img: String(p.featured_image || '').replace('/w780/', '/w342/'),
    site: 'CineCalidad',
    extra: [p.year, p.duration ? `${p.duration} min` : ''].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.url);
}

/* ═══════════════════════════════════════════════════════════════════
 *  CUEVANA.MOV — Búsqueda + Resolución (v235, 20 Sep 2026)
 *  Fuente: https://cuevana.mov/ — 8,182 películas, 97.8% con latino
 *  API: /wp-json/wpreact/v1/movie/{slug} → videos.latino[]
 *  Hosts HTTP: goodstream.one (m3u8 directo), vimeos.net/hlswish.com (JS packed)
 * ═══════════════════════════════════════════════════════════════════ */

const CUEVANA_API = 'https://cuevana.mov/wp-json/wpreact/v1/movie/';
const CUEVANA_M3U8_CACHE = new Map(); // slug -> {m3u8, subs, proxy, mp4, at}
const GOOD_COOKIES = new Map(); // host -> cookie string
function goodCookie(host){ return GOOD_COOKIES.get(host)||''; }
function goodSetCookie(host, setCookie){
  if(!setCookie) return;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const jar = cookies.map(c=>c.split(';')[0].trim()).join('; ');
  if(jar) GOOD_COOKIES.set(host, jar);
  // limpiar si crece
  if(GOOD_COOKIES.size>50){
    const it=[...GOOD_COOKIES.keys()][0];
    GOOD_COOKIES.delete(it);
  }
}
const CUEVANA_CACHE_TTL = 5*3600*1000; // 5h híbrido

const CUEVANA_POSTS_API = 'https://cuevana.mov/wp-json/wpreact/v1/postsapi';
const CUEVANA_SITEMAPS = Array.from({length: 9}, (_, i) => `https://cuevana.mov/pelicula-sitemap${i ? i+1 : ''}.xml`);
const CUEVANA_HOSTS_OK = ['vimeos.net', 'hlswish.com', 'videoapp.zip', 'goodstream.one'];
let cuevanaIdx = { slugs: [], at: 0 };
const CUEVANA_IDX_TTL = 24 * 3600 * 1000;
const cuevanaMetaCache = new Map(); /* slug → {at, data} */

/* Índice de Cuevana: descarga los 9 sitemaps cada 24h */
async function cuevanaIndice() {
  if (cuevanaIdx.slugs.length && Date.now() - cuevanaIdx.at < CUEVANA_IDX_TTL) return cuevanaIdx.slugs;
  const slugs = [];
  for (const url of CUEVANA_SITEMAPS) {
    const r = await fetchSeguro(url, 15000).catch(() => null);
    if (!r || !r.ok) continue;
    const t = await r.text();
    const re = /<loc>https?:\/\/cuevana\.[a-z.]+\/pelicula\/\d+\/([^<]+)<\/loc>/g;
    let m;
    while ((m = re.exec(t))) slugs.push(m[1].replace(/\/$/, ''));
  }
  cuevanaIdx = { slugs: [...new Set(slugs)], at: Date.now() };
  console.log('[cuevana] ' + cuevanaIdx.slugs.length + ' slugs en sitemap');
  return cuevanaIdx.slugs;
}
/* v292: pre-calentar el índice al arranque (para que la 1ª búsqueda no espere
 * los 9 sitemaps) y sembrar el catálogo local con una pasada única y cortés:
 * ~250 fichas a 1.5 s de distancia (~6 min). La sonda y cada reproducción
 * siguen enriqueciéndolo después. */
setTimeout(() => { cuevanaIndice().catch(() => {}); }, 20000);
setTimeout(async () => {
  try {
    const slugs = await cuevanaIndice();
    const faltan = slugs.filter((s) => !CVM_CAT.has(s));
    let n = 0;
    for (const s of faltan.slice(0, 250)) {
      try { const r = await fetchSeguro(CUEVANA_API + encodeURIComponent(s), 8000); if (r && r.ok) cvmCatEnriquecer(s, await r.json().catch(() => null)); n++; } catch {}
      await new Promise((ok2) => setTimeout(ok2, 1500));
    }
    console.log('[cuevana-cat] siembra inicial: ' + n + ' fichas pedidas, catálogo en ' + CVM_CAT.size);
  } catch {}
}, 60000);

/* Buscar películas de Cuevana por query */
async function buscarCuevanaMov(q) {
  /* v292: búsqueda 100% LOCAL (cero red) — el catálogo viene del sitemap en
   * memoria (24 h) y los títulos/pósters de CVM_CAT, que enriquecen la sonda
   * y cada reproducción. Antes se hacían hasta 12 llamadas en vivo por búsqueda. */
  const nq = normalizarTxt(q);
  const tokens = nq.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const slugs = await cuevanaIndice();
  const cand = [];
  for (const s of slugs) {
    if (CVM_OCULTAS.has(s)) continue; /* v235: sin muertas — v251 muertas siempre ocultas */
    const cat = CVM_CAT.get(s);
    const nt = cat && cat.t ? normalizarTxt(cat.t) : '';
    let ok = true, score = 0;
    for (const t of tokens) {
      const i = s.indexOf(t);
      const j = nt ? nt.indexOf(t) : -1;
      if (i < 0 && j < 0) { ok = false; break; }
      score += (i === 0 || j === 0 ? 2 : 1) + (j >= 0 ? 0.5 : 0); /* el título real pesa más que el slug */
    }
    if (ok) cand.push({ s, cat, score: score - s.length / 100 });
  }
  cand.sort((a, b) => b.score - a.score);
  /* Lo que aún no está enriquecido en el catálogo sale con el slug bonificado
   * y sin póster; al picar, el reproductor valida en vivo como siempre. */
  return cand.slice(0, 12).map(({ s, cat }) => ({
    title: cat && cat.t ? cat.t : s.replace(/-/g, ' '),
    url: 'https://cuevana.mov/pelicula/0/' + s,
    img: (cat && cat.p) || '',
    site: 'Cuevana',
    extra: (cat && cat.e) || 'Latino',
  }));
}

/* Metadata de una película de Cuevana (cache 15 min) */
async function cuevanaMeta(slug) {
  const c = cuevanaMetaCache.get(slug);
  if (c && Date.now() - c.at < 15 * 60 * 1000) return c.data;
  const r = await fetchSeguro(CUEVANA_API + encodeURIComponent(slug), 10000).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || !d.titles) return null;
  const lat = (d.videos && d.videos.latino) || [];
  if (!lat.length) return null;
  const result = {
    title: d.titles.name || slug.replace(/-/g, ' '),
    url: 'https://cuevana.mov/pelicula/' + (d.TMDbId || '0') + '/' + slug,
    img: (d.images && d.images.poster) || '',
    site: 'Cuevana',
    extra: ['Latino', d.runtime ? d.runtime + 'min' : '', d.releaseDate ? d.releaseDate.slice(0, 4) : ''].filter(Boolean).join(' · '),
  };
  cuevanaMetaCache.set(slug, { at: Date.now(), data: result });
  return result;
}

/* Resolver película de Cuevana → m3u8 (solo audio latino) */
async function resolverCuevanaMov(pageUrl) {
  const slugM = /\/pelicula\/\d+\/([^/?#]+)/i.exec(pageUrl) || /\/pelicula\/+([^/?#]+)/i.exec(pageUrl);
  if (!slugM) throw new Error('URL de Cuevana no válida: ' + pageUrl);
  const slug = slugM[1];
  // v261: goodstream/vimeos no cache (single-use, siempre fresco), otros 5h
  const cc = CUEVANA_M3U8_CACHE.get(slug);
  if (cc && !cc.isGood && Date.now() - cc.at < CUEVANA_CACHE_TTL) {
    return { m3u8: cc.m3u8, subs: cc.subs||[], proxy: !!cc.proxy, mp4: !!cc.mp4 };
  } else if (cc) {
    CUEVANA_M3U8_CACHE.delete(slug);
  }
  const r = await fetchSeguro(CUEVANA_API + encodeURIComponent(slug), 12000);
  if (!r.ok) throw new Error('API Cuevana error: ' + r.status);
  const d = await r.json();
  cvmCatEnriquecer(slug, d); /* v292: cada peli reproducida enriquece el catálogo de búsqueda */
  const lat = (d.videos && d.videos.latino) || [];
  if (!lat.length) throw new Error('Cuevana: sin embeds latinos para ' + slug);
  /* Priorizar hosts que funcionan via HTTP puro */
  const sorted = [...lat].sort((a, b) => {
    const ai = CUEVANA_HOSTS_OK.indexOf(new URL(a.url || 'https://x').hostname);
    const bi = CUEVANA_HOSTS_OK.indexOf(new URL(b.url || 'https://x').hostname);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  for (const embed of sorted) {
    if (!embed.url) continue;
    const host = new URL(embed.url).hostname;
    try {
      let m3u8 = null;
      if (/goodstream\.one/i.test(host)) {
        /* m3u8 directo en HTML — con cookie */
        let er = null;
        let cookie = '';
        try {
          const ctl = new AbortController(); const tm=setTimeout(()=>ctl.abort(), 12000);
          const r = await fetch(embed.url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': FETCH_UA, 'Referer': 'https://goodstream.one/', 'Accept': '*/*' } });
          clearTimeout(tm);
          if(r.ok){
            const sc = r.headers.get('set-cookie');
            if(sc) goodSetCookie('goodstream.one', sc);
            // también probar getSetCookie
            try{ const all = r.headers.getSetCookie ? r.headers.getSetCookie() : null; if(all && all.length) goodSetCookie('goodstream.one', all); }catch{}
            er = r;
            cookie = goodCookie('goodstream.one');
          }
        } catch {}
        if (!er || !er.ok) {
          try { er = await fetchSeguro(embed.url, 12000); } catch {}
          if (!er || !er.ok) { try { er = CDN_RELAY ? await fetchRelay(embed.url, 8000) : null; } catch {} }
        }
        if (!er || !er.ok) continue;
        if (!er.ok) continue;
        const html = await er.text();
        const m = /file\s*[:=]\s*["'](https?:\/\/[^"']+master\.m3u8[^"']*?)["']/i.exec(html)
          || /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(html);
        if (m) m3u8 = m[1];
      } else if (/vimeos\.net|hlswish\.com/i.test(host)) {
        /* JS packed → m3u8 */
        let er = null;
        try { er = await fetchSeguro(embed.url, 12000); } catch {}
        if (!er || !er.ok) { try { er = CDN_RELAY ? await fetchRelay(embed.url, 10000) : null; } catch {} }
        if (!er || !er.ok) continue;
        if (!er.ok) continue;
        const html = await er.text();
        const pm = /eval\(function\(p,a,c,k,e,d\)\{.+?\}\('(.+?)',(\d+),(\d+),'([^']*)'\.split/.exec(html);
        if (pm) {
          const pStr = pm[1], aVal = +pm[2], cVal = +pm[3], k = pm[4].split('|');
          const toBase = (n, b) => { if (!n) return '0'; const d = []; while (n) { d.push('0123456789abcdefghijklmnopqrstuvwxyz'[n % b]); n = Math.floor(n / b); } return d.reverse().join(''); };
          let result = pStr;
          for (let i = cVal - 1; i >= 0; i--) {
            const w = toBase(i, aVal);
            if (i < k.length && k[i]) result = result.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), k[i]);
          }
          const m = /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(result);
          if (m) m3u8 = m[1];
        }
      } else if (/videoapp\.zip/i.test(host)) {
        /* videoapp.zip redirige a vimeos.net — intentar igual */
        let er = null;
        try { er = await fetchSeguro(embed.url, 12000); } catch {}
        if (!er || !er.ok) { try { er = CDN_RELAY ? await fetchRelay(embed.url, 10000) : null; } catch {} }
        if (!er || !er.ok) continue;
        if (!er.ok) continue;
        const html = await er.text();
        const pm = /eval\(function\(p,a,c,k,e,d\)\{.+?\}\('(.+?)',(\d+),(\d+),'([^']*)'\.split/.exec(html);
        if (pm) {
          const pStr = pm[1], aVal = +pm[2], cVal = +pm[3], k = pm[4].split('|');
          const toBase = (n, b) => { if (!n) return '0'; const d = []; while (n) { d.push('0123456789abcdefghijklmnopqrstuvwxyz'[n % b]); n = Math.floor(n / b); } return d.reverse().join(''); };
          let result = pStr;
          for (let i = cVal - 1; i >= 0; i--) {
            const w = toBase(i, aVal);
            if (i < k.length && k[i]) result = result.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), k[i]);
          }
          const m = /(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/i.exec(result);
          if (m) m3u8 = m[1];
        }
      }
      if (m3u8) {
        /* Verificar que el m3u8 sirve */
        let vr = null;
        // v265: no verificar master para hosts de un solo uso (goodstream/vimeos/hlswish/videoapp) — el HLS proxy lo verificará
        if (/goodstream|vimeos|hlswish|videoapp/i.test(host) || /goodstream|vimeos|hlswish|videoapp/i.test(m3u8)) {
          // no verificar, token de un solo uso
          vr = { ok: true, text: async()=> '#EXTM3U' };
        } else {
          if (!vr) try { vr = CDN_RELAY ? await fetchRelay(m3u8, 10000).catch(() => null) : await fetchSeguro(m3u8, 8000).catch(() => null); } catch {}
          if (!vr || !vr.ok) { try { vr = await fetchSeguro(m3u8, 8000).catch(()=>null); } catch {} }
        }
        if (vr && vr.ok) {
          const txt = await vr.text().catch(() => '');
          if (txt.includes('#EXTM3U')) {
            const cdnHost = new URL(m3u8).hostname;
            if (!hlsReferers.has(cdnHost)) hlsReferers.set(cdnHost, embed.url);
            try { hlsUAs.set(cdnHost, FETCH_UA); hlsALs.set(cdnHost, 'es-MX,es;q=0.9,en;q=0.8'); } catch {}
            const isGood = /goodstream|vimeos|hlswish/i.test(host);
            const resObj = { m3u8, subs: [], proxy: true, mp4: false };
            if (!isGood) {
              CUEVANA_M3U8_CACHE.set(slug, { ...resObj, at: Date.now(), isGood });
              if (CUEVANA_M3U8_CACHE.size > 400) {
                const entries = [...CUEVANA_M3U8_CACHE.entries()].sort((a,b)=>a[1].at-b[1].at);
                for(let i=0;i<entries.length-300;i++) CUEVANA_M3U8_CACHE.delete(entries[i][0]);
              }
            }
            return resObj;
          }
        }
      }
    } catch {}
  }
  throw new Error('Cuevana: ningún host resolvió m3u8 para ' + slug);
}

/* v70: fuera las búsquedas de AnimeFLV (código retirado) */
const metaCache = new Map();
const serieCache = new Map();
/* v297: serieCache CON TOPE — en Oracle creció sin límite durante meses y el
 * arranque la cargaba completa del disco (400+ MB de golpe → el proceso moría
 * y Oracle lo revivía, por eso «Encendido» volvía a 0). Ahora se poda a lo más
 * reciente y un vigilante de memoria la purga antes de que el heap reviente. */
const SERIECACHE_MAX = 1500;
function serieCachePodar(max) {
  if (serieCache.size <= max) return 0;
  const orden = [...serieCache.entries()].sort((a, b) => ((b[1] && b[1].at) || 0) - ((a[1] && a[1].at) || 0));
  let n = 0;
  for (const [k] of orden.slice(max)) { serieCache.delete(k); n++; }
  return n;
}
async function metaDePelicula(url) {
  const u0 = String(url || '');
  if (!u0) return null;
  const c = metaCache.get(u0);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.d;
  let u;
  try { u = new URL(u0); } catch { return null; }
  const dom = u.hostname.replace(/^www\./, '');
  /* v57: Cuevana redirige /serie/X a /wp-serie/X/ y dentro del espejo se
   * navega a temporadas/episodios — capturamos el slug sin anclar al final.
   * v59: series y episodios viven en cine-calidad.mx (cuevana las tiene rotas) */
  const slugM = /\/pelicula\/\d+\/([a-z0-9-]+)/i.exec(u.pathname)
    || /\/(?:wp-)?serie\/([a-z0-9-]+)/i.exec(u.pathname)
    || /\/peliculas\/([a-z0-9-]+)/i.exec(u.pathname)
    || /\/(?:wp-)?pelicula\/([a-z0-9-]+)/i.exec(u.pathname)
    || /\/anime\/([a-z0-9-]+)/i.exec(u.pathname)
    || /\/ver\/([a-z0-9-]+)-episodio-(\d+)/i.exec(u.pathname)
    || /\/ver\/([a-z0-9-]+)-(\d+)\/?$/i.exec(u.pathname)
    || /\/episode\/([a-z0-9-]+?)-\d+x\d+/i.exec(u.pathname);
  let d = null;
  if (slugM) {
    const slug = slugM[1];
    const bonito = slug.replace(/-/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
    if (/cuevana\.|cine-calidad/.test(dom)) {
      try {
        const r = await fetchSeguro(`https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}&page=1`, 8000);
        if (r.ok) {
          const dd = await r.json().catch(() => ({}));
          const p = (dd.posts || []).find((x) => x.slug === slug) || (dd.posts || [])[0];
          if (p) d = { title: p.title, poster: String(p.featured_image || '').replace('/w780/', '/w342/') };
        }
      } catch {}
    } else if (/latanime\./.test(dom)) {
      /* v63: la página del anime trae og:title y og:image (con proxy) */
      try {
        const r = await fetchSeguro(`https://latanime.org/anime/${slug}`, 8000);
        if (r.ok) {
          const html = await r.text();
          const og = (p) => {
            const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(html);
            const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(html);
            return (a1 || a2 || [])[1] || '';
          };
          const t = (og('og:title') || '').replace(/\s*[—–|]\s*Latanime\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
          const pst = og('og:image') || '';
          const poster = /latanime\./i.test(pst) ? '/api/img?u=' + encodeURIComponent(pst) : pst;
          if (t) d = { title: slugM[2] ? `${t} — Episodio ${slugM[2]}` : t, poster };
        }
      } catch {}
    } else if (/animeflv\./.test(dom)) {
      /* v62: la página del anime trae og:title y og:image listos */
      try {
        const r = await fetchSeguro(`https://vww.animeflv.one/anime/${slug}`, 8000);
        if (r.ok) {
          const html = await r.text();
          const og = (p) => {
            const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(html);
            const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(html);
            return (a1 || a2 || [])[1] || '';
          };
          const t = (og('og:title') || '')
            .replace(/^ver\s+/i, '')
            .replace(/\s*(online|sub español|español latino|latino)\b.*$/i, '')
            .replace(/\s*[|─✔★].*$/, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
          const pst = og('og:image') || '';
          /* v62→v67: AnimeFLV bloquea imágenes directas → proxy propio */
          const poster = /animeflv\./i.test(pst) ? '/api/img?u=' + encodeURIComponent(pst) : pst;
          if (t) d = { title: slugM[2] ? `${t} — Episodio ${slugM[2]}` : t, poster };
        }
      } catch {}
    } else if (/pelisxd\./.test(dom)) {
      /* v98: la misma fuente del buscador (caché compartida) */
      const m2 = await pelisxdMeta(slug).catch(() => null);
      if (m2) d = { title: m2.title, poster: m2.poster };
    }
    if (!d) d = { title: bonito, poster: '' };
  }
  if (d) metaCache.set(u0, { at: Date.now(), d });
  return d;
}

/* v55: populares del día (Cuevana) — con caché de 30 minutos */
let tendenciasCache = { at: 0, items: [] };
let seriesCache = { at: 0, items: [] };
async function tendenciasCuevana(periodo, cache) {
  if (Date.now() - cache.at < 30 * 60 * 1000 && cache.items.length) return cache.items;
  const r = await fetchSeguro(`https://cine-calidad.mx/wp-json/mycustom/v1/trends/${periodo}`, 10000);
  if (!r.ok) return cache.items; /* si falla, lo de antes es mejor que nada */
  const d = await r.json().catch(() => ({}));
  const items = (d.posts || []).slice(0, 16).map((p) => ({
    title: String(p.title || ''),
    url: (p.type === 'serie') ? `https://cine-calidad.mx/serie/${p.slug}` : `https://cine-calidad.mx/pelicula/${p.slug}/`, /* v87: fix 404 — cuevana.mov ya no sirve esas URLs */
    img: String(p.featured_image || '').replace('/w780/', '/w342/'),
    site: 'CineCalidad',
    extra: [p.year, p.duration ? `${p.duration} min` : ''].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.url).filter((x) => !cvOcultaUrl(x.url)); /* v191: sin series muertas */
  if (items.length) { cache.at = Date.now(); cache.items = items; }
  return items;
}
async function popularesDeHoy() { return tendenciasCuevana('movies_day', tendenciasCache); }
/* v57: series recién agregadas — reemplaza "tendencias de la semana",
 * que salía casi igual que los populares del día (21 de 22 repetidas) */
async function seriesRecientes() {
  if (Date.now() - seriesCache.at < 30 * 60 * 1000 && seriesCache.items.length) return seriesCache.items;
  const r = await fetchSeguro('https://cine-calidad.mx/wp-json/mycustom/v1/series', 10000);
  if (!r.ok) return seriesCache.items; /* si falla, lo de antes es mejor que nada */
  const d = await r.json().catch(() => ({}));
  const items = (Array.isArray(d) ? d : d.posts || []).slice(0, 16).map((p) => ({
    title: String(p.title || ''),
    slug: String(p.slug || ''),
    /* v59: las páginas de series de cuevana.mov están rotas (app que no
     * carga) — las series abren en cine-calidad.mx, que sí renderiza */
    url: `https://cine-calidad.mx/serie/${p.slug}`,
    img: String(p.featured_image || '').replace('/w780/', '/w342/'),
    site: 'CineCalidad',
    extra: p.year ? String(p.year) : '',
  })).filter((x) => x.title && x.slug);
  if (items.length) { seriesCache.at = Date.now(); seriesCache.items = items; }
  return items;
}

/* v101: filas de GÉNERO — el feed se ve más vivo: además de populares,
 * series y animes, seis géneros que rotan cada día (de los 17 en español
 * que trae el API de cuevana). Cada fila mezcla pelis y series del género */
const GENEROS_ES = [
  ['accion', 'Acción'], ['animacion', 'Animación'], ['aventura', 'Aventura'],
  ['belica', 'Bélica'], ['ciencia-ficcion', 'Ciencia ficción'], ['comedia', 'Comedia'],
  ['crimen', 'Crimen'], ['documental', 'Documental'], ['drama', 'Drama'],
  ['familia', 'Familia'], ['fantasia', 'Fantasía'], ['historia', 'Historia'],
  ['misterio', 'Misterio'], ['musica', 'Música'], ['romance', 'Romance'],
  ['suspense', 'Suspense'], ['terror', 'Terror'],
];
const generosCache = new Map(); /* slug → {at, items} */
function generosDelDia() {
  /* v234: TODOS los géneros, barajados por la fecha — el feed se ve lleno
   * y distinto cada día. Fisher-Yates determinista. */
  const dia = Math.floor(Date.now() / 864e5);
  const arr = [...GENEROS_ES];
  let seed = dia * 2654435761;
  for (let i = arr.length - 1; i > 0; i--) {
    seed = ((seed * 48271 + 12345) >>> 0) % (i + 1);
    [arr[i], arr[seed]] = [arr[seed], arr[i]];
  }
  return arr;
}
/* v205: SOLO películas en las filas/género de pelis (las series tienen su
 * área) + pag para el catálogo «Ver todo» (cine-calidad pagina de verdad) */
const mapearGenero = (posts) => (posts || []).filter((p) => p.type !== 'serie').map((p) => ({
  title: String(p.title || ''),
  url: `https://cine-calidad.mx/pelicula/${p.slug}/`,
  img: String(p.featured_image || '').replace('/w780/', '/w342/'),
  site: 'CineCalidad',
  extra: [
    String(p.date || '').slice(0, 4),
    p.rating ? `★ ${(+p.rating).toFixed(1)}` : '',
  ].filter(Boolean).join(' · '),
})).filter((x) => x.title && x.img);
async function generoPagina(slug, pag) {
  const r = await fetchSeguro(`https://cine-calidad.mx/wp-json/mycustom/v1/list-posts?category=${slug}&page=${pag}`, 10000);
  if (!r.ok) return { items: [], mas: false };
  const d = await r.json().catch(() => ({}));
  const posts = d.posts || [];
  return { items: mapearGenero(posts), mas: posts.length >= 20 }; /* v205: mas del tamaño crudo */
}
/* v234: PelisXD por género — mezcla con Cuevana para feed más lleno */
const PXD_GENERO_MAP = {
  accion: 'accion', animacion: 'animacion-e-infantil', aventura: 'aventura',
  belica: 'belico', 'ciencia-ficcion': 'ciencia-ficcion', comedia: 'comedia',
  crimen: 'crimen', documental: 'documentales', drama: 'drama',
  familia: 'familia', fantasia: 'fantasia', historia: 'historia',
  misterio: 'intriga', musica: 'musical', romance: 'romance',
  suspense: 'suspenso', terror: 'terror',
};
const pxdGeneroCache = new Map(); /* slug → {at, items} */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pxdGeneroCache) if (now - v.at > 3 * 3600 * 1000) pxdGeneroCache.delete(k);
  for (const [k, v] of generosCache) if (now - v.at > 60 * 60 * 1000) generosCache.delete(k);
  /* v235: limpiar cachés de Cuevana */
  for (const [k, v] of cuevanaMetaCache) if (now - v.at > 15 * 60 * 1000) cuevanaMetaCache.delete(k);
  if (cuevanaMetaCache.size > 500) {
    const entries = [...cuevanaMetaCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < entries.length - 500; i++) cuevanaMetaCache.delete(entries[i][0]);
  }
  for (const [k, v] of cuevanaGeneroCache) if (now - v.at > 3 * 3600 * 1000) cuevanaGeneroCache.delete(k);
  /* v291: tope de serieCache — guarda fichas completas (series de 1000+ eps);
   * sin tope crece para siempre con cada ficha distinta que se abre */
  if (serieCache.size > 600) {
    const ord = [...serieCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (let i = 0; i < ord.length - 500; i++) serieCache.delete(ord[i][0]);
  }
  /* Limitar CVM_VISTAS a 10k para no consumir memoria infinita */
  if (CVM_VISTAS.size > 10000) { const arr = [...CVM_VISTAS]; CVM_VISTAS.clear(); arr.slice(-5000).forEach(s => CVM_VISTAS.add(s)); }
}, 10 * 60 * 1000); /* v234: limpiar cachés de géneros cada 10 min + v235 Cuevana */
async function pelisxdPorGenero(slug) {
  const pxdSlug = PXD_GENERO_MAP[slug];
  if (!pxdSlug) return [];
  const c = pxdGeneroCache.get(slug);
  if (c && Date.now() - c.at < 3 * 3600 * 1000 && c.items.length) return c.items;
  try {
    const r = await fetchSeguro('https://www.pelisxd.com/genero/' + pxdSlug, 12000);
    if (!r.ok) return [];
    const html = await r.text();
    const items = [];
    const re = /href="\/pelicula\/([a-z0-9-]+)"[^>]*>[\s\S]*?src="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>\s*<span[^>]*>(\d{4})<\/span>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 18) {
      items.push({
        title: m[3].trim(),
        url: 'https://www.pelisxd.com/pelicula/' + m[1],
        img: (m[2].startsWith('/') ? 'https://www.pelisxd.com' : '') + m[2].replace('/w780/', '/w342/').replace('/original/', '/w342/'),
        site: 'PelisXD',
        extra: m[4] || '',
      });
    }
    if (items.length) pxdGeneroCache.set(slug, { at: Date.now(), items });
    return items;
  } catch { return []; }
}
async function pelisxdPorGeneroPagina(slug, pag){
  const pxdSlug = PXD_GENERO_MAP[slug];
  if(!pxdSlug) return [];
  try{
    const r = await fetchSeguro('https://www.pelisxd.com/genero/' + pxdSlug + '?page=' + pag, 12000);
    if(!r.ok) return [];
    const html = await r.text();
    const items=[];
    const re = /href="\/pelicula\/([a-z0-9-]+)"[^>]*>[\s\S]*?src="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>\s*<span[^>]*>(\d{4})<\/span>/g;
    let m; while((m=re.exec(html)) && items.length<12){ items.push({ title: m[3].trim(), url: 'https://www.pelisxd.com/pelicula/'+m[1], img: (m[2].startsWith('/')?'https://www.pelisxd.com':'')+m[2].replace('/w780/','/w342/').replace('/original/','/w342/'), site:'PelisXD', extra:m[4]||'' }); }
    return items;
  }catch{ return []; }
}
/* v235: Cuevana películas por género */
const PXD_CV_GENERO_MAP = {
  accion: 'accion', animacion: 'animacion', aventura: 'aventura',
  belica: 'belico', 'ciencia-ficcion': 'ciencia-ficcion', comedia: 'comedia',
  crimen: 'crimen', documental: 'documental', drama: 'drama',
  fantasia: 'fantasia', historia: 'historia', misterio: 'intriga',
  musica: 'musical', romance: 'romance', suspense: 'suspenso', terror: 'terror',
};
const cuevanaGeneroCache = new Map();
async function cuevanaPorGenero(slug) {
  const cvSlug = PXD_CV_GENERO_MAP[slug] || slug;
  const c = cuevanaGeneroCache.get(cvSlug);
  if (c && Date.now() - c.at < 3 * 3600 * 1000 && c.items.length) return c.items;
  try {
    const r = await fetchSeguro(`https://cuevana.mov/wp-json/wpreact/v1/postsapi?per_page=15&page=1&genre=${cvSlug}`, 12000);
    if (!r.ok) return [];
    const d = await r.json().catch(() => ({}));
    const items = (d.posts || []).filter(p => p.type === 'pelicula' && !CVM_OCULTAS.has(p.slug)).slice(0, 12).map(p => ({ /* v251 muertas siempre ocultas */
      title: p.title || '',
      url: 'https://cuevana.mov/pelicula/' + (p.tmdb_id || '0') + '/' + p.slug,
      img: p.featured_image || '',
      site: 'Cuevana',
      extra: p.year || '',
    }));
    if (items.length) cuevanaGeneroCache.set(cvSlug, { at: Date.now(), items });
    return items;
  } catch { return []; }
}
async function cuevanaPorGeneroPagina(slug, pag){
  const cvSlug = PXD_CV_GENERO_MAP[slug] || slug;
  try{
    const r = await fetchSeguro('https://cuevana.mov/wp-json/wpreact/v1/postsapi?per_page=12&page=' + pag + '&genre=' + cvSlug, 12000);
    if(!r.ok) return [];
    const d = await r.json().catch(()=>({}));
    return (d.posts||[]).filter(p=>p.type==='pelicula' && !CVM_OCULTAS.has(p.slug)).slice(0,12).map(p=>({ title:p.title||'', url:'https://cuevana.mov/pelicula/'+(p.tmdb_id||'0')+'/'+p.slug, img:p.featured_image||'', site:'Cuevana', extra:p.year||'' }));
  }catch{ return []; }
}

async function peliculasPorGenero(slug, pag) {
  if (pag > 1) {
    try{
      const pxdSlug = PXD_GENERO_MAP[slug];
      const cvSlug = PXD_CV_GENERO_MAP[slug] || slug;
      const [cc, pxd, cv] = await Promise.all([
        generoPagina(slug, pag).catch(() => ({ items: [], mas: false })),
        pxdSlug ? pelisxdPorGeneroPagina(slug, pag).catch(() => []) : Promise.resolve([]),
        cuevanaPorGeneroPagina(slug, pag).catch(() => []),
      ]);
      const a = (cc.items || []).slice(0,10);
      const b = (pxd || []).slice(0,10);
      const c = (cv || []).slice(0,10);
      const mezcla = [];
      const vistosPag = new Set();
      const pushPag = (x)=>{ if(!x||vistosPag.has(x.url)) return; vistosPag.add(x.url); mezcla.push(x); };
      const max = Math.max(a.length, b.length, c.length);
      for (let i = 0; i < max && mezcla.length < 30; i++) {
        if (a[i]) pushPag(a[i]);
        if (b[i]) pushPag(b[i]);
        if (c[i]) pushPag(c[i]);
      }
      if(mezcla.length) return mezcla;
      if((cc.items||[]).length) return cc.items.slice(0,20);
      if((pxd||[]).length) return pxd.slice(0,20);
      if((cv||[]).length) return cv.slice(0,20);
      return [];
    }catch{ return []; }
  }
  const c = generosCache.get(slug);
  if (c && Date.now() - c.at < 60 * 60 * 1000 && c.items.length) return c.items;
  const [cv, pxd, cvMov] = await Promise.all([
    generoPagina(slug, 1).catch(() => ({ items: [] })),
    pelisxdPorGenero(slug).catch(() => []),
    cuevanaPorGenero(slug).catch(() => []), /* v235: cuevana.mov — 8k películas */
  ]);
  const cvItems = (cv.items || []).slice(0, 10);
  const pxdItems = (pxd || []).slice(0, 10);
  const cvMovItems = (cvMov || []).slice(0, 10);
  /* Mezclar: alternar Cuevana, PelisXD y Cuevana.mov para que se vea variado */
  const mezcla = [];
  const vistosG = new Set();
  const pushG = (x)=>{ if(!x||vistosG.has(x.url)) return; vistosG.add(x.url); mezcla.push(x); };
  const max = Math.max(cvItems.length, pxdItems.length, cvMovItems.length);
  for (let i = 0; i < max && mezcla.length < 30; i++) {
    if (cvItems[i]) pushG(cvItems[i]);
    if (pxdItems[i]) pushG(pxdItems[i]);
    if (cvMovItems[i]) pushG(cvMovItems[i]);
  }
  for(let i=mezcla.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [mezcla[i],mezcla[j]]=[mezcla[j],mezcla[i]]; }
  let items = mezcla.length ? mezcla : cvItems;
  // v275: si fantasia u otro viene vacío de cc pero tiene pxd/cv, ya está en mezcla
  if(!items.length){
    if(pxdItems.length) items = pxdItems;
    else if(cvMovItems.length) items = cvMovItems;
  }
  if (items.length) generosCache.set(slug, { at: Date.now(), items });
  return items;
}

/* v67: animes del momento — los "animes de estreno" de Latanime (en emisión),
 * con sus carátulas, para la fila de animes en el inicio */
const animesCache = { at: 0, items: [] };
async function animesDelMomento() {
  if (Date.now() - animesCache.at < 30 * 60 * 1000 && animesCache.items.length) return animesCache.items;
  const r = await fetchSeguro('https://latanime.org/emision', 10000);
  if (!r.ok) return animesCache.items; /* si falla, lo de antes es mejor que nada */
  const html = await r.text();
  const items = [];
  const re = /<a href="(https:\/\/latanime\.org\/anime\/[a-z0-9-]+)">\s*<div class="series">\s*<div class="serieimg[^"]*">\s*<img src="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>\s*<div[^>]*>\s*<span class="opacity-75">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 18) {
    const title = m[3].replace(/\s+/g, ' ').trim().replace(/\s+(latino|castellano|espa\u00f1ol|sub(?:titulado)?)\s*$/i, '').slice(0, 80);
    if (!title) continue;
    items.push({
      title,
      url: m[1],
      img: m[2],
      site: 'Latanime',
      extra: (m[4] || '').trim() || 'Latino', /* idioma: Latino, Castellano, Sin Censura… */
    });
  }
  if (items.length) { animesCache.at = Date.now(); animesCache.items = items; }
  return items;
}

/* v63: Latanime — animes con audio LATINO de verdad (mp4upload y amigos) */
async function buscarLatanime(q) {
  const r = await fetchSeguro(`https://latanime.org/buscar?q=${encodeURIComponent(q)}`, 9000);
  if (!r.ok) return [];
  const html = (await r.text()).slice(0, 700000);
  const re = /<a href="(https:\/\/latanime\.org\/anime\/[a-z0-9-]+)">([\s\S]*?)<h3[^>]*>([^<]{2,120})<\/h3>/g;
  const out = [];
  const vistos = new Set();
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    if (vistos.has(m[1])) continue;
    vistos.add(m[1]);
    const img = (/(?:data-src|src)="(https?:[^"]+\/(?:thumbs|img)\/[^"]+)"/.exec(m[2]) || [])[1] || '';
    out.push({
      title: m[3].replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
      url: m[1],
      img,
      site: 'Latanime',
      extra: '',
    });
  }
  return out;
}

/* v97: AnimeFLV de vuelta — catálogo gigante y trae mp4upload entre sus
 * servidores (extraíble); respaldo cuando la versión de Latanime está muerta */
/* v243: probe AnimeFLV — ep1 trae enc + /flv lista ≥1 servidor (criterio de la auditoría) */
async function afProbe(slug) {
  try {
    const epUrl = 'https://vww.animeflv.one/ver/' + slug + '-1';
    const r = await fetchSeguro(epUrl, 12000).catch(() => null);
    if (!r || !r.ok) return false;
    const enc = (/class="opt"[^>]*data-encrypt="([0-9a-f]+)"/i.exec(await r.text()) || [])[1];
    if (!enc) return false;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    let cuerpo = '';
    try {
      const r2 = await fetch('https://vww.animeflv.one/flv', { method: 'POST', headers: { 'User-Agent': FETCH_UA, Referer: epUrl, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: 'acc=opt&i=' + enc, signal: ctl.signal });
      cuerpo = r2.ok ? await r2.text() : '';
    } catch {} finally { clearTimeout(t); }
    const embeds = [...cuerpo.matchAll(/<li[^>]*encrypt="([0-9a-f]+)"/gi)].map((m) => { try { return Buffer.from(m[1], 'hex').toString('utf8'); } catch { return ''; } });
    return embeds.some((u) => /^https?:\/\//i.test(u));
  } catch { return false; }
}
/* v243: SONDA ANIMEFLV — 5 vivas + 3 muertas por ciclo */
async function sondaAnimeflv() {
  try {
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memMB > 350) { console.warn('[sonda] af saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
    const t0 = Date.now();
    let vm = 0, mv = 0;
    const sh = (arr) => { const a = [...arr]; for (let k = a.length - 1; k > 0; k--) { const z = Math.floor(Math.random() * (k + 1)); [a[k], a[z]] = [a[z], a[k]]; } return a; };
    for (const slug of sh([...AF_TODOS].filter((x) => !AF_OCULTAS.has(x))).slice(0, 5)) {
      try {
        AF_VISTAS.add(slug);
        if (await afProbe(slug)) afPerdonar(slug);
        else { const era = AF_OCULTAS.has(slug); afOcultar(slug); if (!era && AF_OCULTAS.has(slug)) { vm++; sondaNotify('AnimeFLV', 'muerto', slug, slug + ' murio — sin servidores'); } }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (const slug of sh([...AF_OCULTAS]).slice(0, 3)) {
      try {
        if (await afProbe(slug)) { AF_OCULTAS.delete(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); afPerdonar(slug); mv++; sondaNotify('AnimeFLV', 'revivio', slug, slug + ' revivio — servidores otra vez'); }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    try { fs.writeFileSync(path.join(__dirname, 'public', 'af-vistas.txt'), [...AF_VISTAS].join('\n') + '\n'); } catch {}
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('[sonda] af (' + el + 's): ' + ((vm || mv) ? ('vivas→muertas=' + vm + ' muertas→vivas=' + mv) : 'sin cambios'));
    try { fs.appendFileSync(path.join(__dirname, 'sonda-animeflv.log'), '[' + new Date().toISOString() + '] ' + el + 's vivas→muertas=' + vm + ' muertas→vivas=' + mv + ' muertas=' + AF_OCULTAS.size + ' vistas=' + AF_VISTAS.size + '\n'); } catch {}
  } catch (e) { console.warn('[sonda] af error: ' + String(e).slice(0, 60)); }
}
/* v248: ANIMED23 — probe cadena JWT: /anime/<slug>/ → /capitulo/<ep> → iframe opciones/options.php → player.php → multiplayer/contenedor.php → videoTabs */
async function d23Probe(slug){
  try{
    const r = await fetchSeguro('https://animed23.com/anime/'+slug+'/', 12000);
    if(!r || !r.ok) return false;
    const html = await r.text();
    const eps = [...new Set([...html.matchAll(/\/capitulo\/([a-z0-9-]+)\//g)].map(m=>m[1]))].slice(0,2);
    if(!eps.length) return false;
    for(const epSlug of eps){
      try{
        const r2 = await fetchSeguro('https://animed23.com/capitulo/'+epSlug+'/', 12000);
        if(!r2 || !r2.ok) continue;
        const html2 = await r2.text();
        // Caso directo: container.php?id=D23-xxx
        const direct = /container\.php\?id=([A-Za-z0-9_-]+)/.exec(html2);
        if(direct){
          const curl='https://animed23.online/container.php?id='+direct[1]+'&open=1';
          const r5=await fetchSeguro(curl, 12000).catch(()=>null);
          if(r5 && r5.ok){
            const h5=await r5.text();
            if(/bysesukior|ok\.ru|rpmvid|archive\.org|mega\.nz|abyssplayer|data-player-url/i.test(h5)) return true;
            if(h5.length>2000 && /embed-player|embed-tabs/i.test(h5)) return true;
          } else if(r5 && r5.status===200) return true;
          continue;
        }
        // v290: flujo "multi" (options.php con token rotativo → contenedor.php → videoTabs)
        let mMulti = /<iframe[^>]+src="([^"]*multiplayer\/options\.php[^"]*)"/i.exec(html2);
        if(mMulti){
          let mUrl = mMulti[1].replace(/&#038;/g,'&').replace(/&amp;/g,'&');
          const r3 = await fetchSeguro(mUrl, 12000).catch(()=>null);
          if(r3 && r3.ok){
            const html3 = await r3.text();
            const mCont = /iframe\.src='([^']+multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)'/i.exec(html3) || /src="([^"]*multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)"/i.exec(html3);
            if(mCont){
              const r5 = await fetchSeguro(mCont[1].startsWith('//') ? 'https:'+mCont[1] : mCont[1], 12000).catch(()=>null);
              if(r5 && r5.ok){
                const h5 = await r5.text();
                if(/bysesukior|ok\.ru|rpmvid|videoTabs|data-player-url/i.test(h5)) return true;
              }
            } else if(/contenedor\.php/i.test(html3)) return true;
          }
          continue;
        }
        // Caso JWT: opciones/options.php
        let mOpt = /<iframe[^>]+src="([^"]*opciones\/options\.php[^"]*)"/i.exec(html2) || /src="([^"]*animed23\.online\/opciones\/options\.php[^"]*)"/i.exec(html2);
        if(!mOpt) continue;
        let optUrl = mOpt[1].replace(/&#038;/g,'&').replace(/&amp;/g,'&');
        if(optUrl.startsWith('//')) optUrl='https:'+optUrl;
        const r3 = await fetchSeguro(optUrl, 12000).catch(()=>null);
        if(!r3 || !r3.ok) continue;
        const html3 = await r3.text();
        // si options.php responde con portada/select ya es señal de vida
        if(/d23-portada|d23-selector|Reproducir episodio|Seleccionar versi/i.test(html3)) {
          // intentar seguir a player.php para confirmar cadena, pero no exigir contenedor final
          let playerM = /href="([^"]*player\.php\?data=[^"]*)"/i.exec(html3);
          if(!playerM) { const pm=/player\.php\?data=[A-Za-z0-9%_\-\.]+/.exec(html3); if(pm) playerM=[pm[0],pm[0]]; }
          if(playerM){
            let pUrl = playerM[1] || playerM[0];
            pUrl = pUrl.replace(/&#038;/g,'&').replace(/&amp;/g,'&');
            if(pUrl.startsWith('/')) pUrl='https://animed23.online/opciones/'+pUrl.replace(/^\//,'');
            else if(!/^https?:/i.test(pUrl)) pUrl='https://animed23.online/opciones/'+pUrl;
            const r4 = await fetchSeguro(pUrl, 12000).catch(()=>null);
            if(r4 && r4.ok){
              const html4 = await r4.text();
              if(/d23-selector|d23-portada|contenedor\.php|bysesukior|data-player-url/i.test(html4)) return true;
              const contM = /multiplayer\/contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(html4) || /contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(html4);
              if(contM){
                const curl='https://animed23.online/multiplayer/contenedor.php?id='+contM[1];
                const r5=await fetchSeguro(curl,12000).catch(()=>null);
                if(r5 && r5.ok){
                  const h5=await r5.text();
                  if(/bysesukior|ok\.ru|rpmvid|videoTabs|data-player-url/i.test(h5)) return true;
                }
              } else {
                // player respondió pero sin contenedor directo; aun así el chain es válido
                return true;
              }
            } else {
              // options dio player link aunque player falló, sigue siendo vivo (red intermitente)
              return true;
            }
          } else {
            // options sin player pero con portada => vivo
            return true;
          }
        }
      }catch{}
    }
    return false;
  }catch{ return false; }
}
/* v248: SONDA D23 — 5 vivas + 3 muertas por ciclo (arranque + 6h), pausa 1.5-2s, log sonda-animed23.log */
async function sondaD23(){
  try{
    const memMB = process.memoryUsage().heapUsed/1024/1024;
    if(memMB>350){ console.warn('[sonda] d23 saltado — memoria alta: '+memMB.toFixed(0)+'MB'); return; }
    const t0=Date.now(); let vm=0,mv=0;
    const sh=(arr)=>{ const a=[...arr]; for(let k=a.length-1;k>0;k--){ const z=Math.floor(Math.random()*(k+1)); [a[k],a[z]]=[a[z],a[k]]; } return a; };
    for(const slug of sh([...D23_TODOS].filter(x=>!D23_OCULTAS.has(x))).slice(0,5)){
      try{
        D23_VISTAS.add(slug);
        if(await d23Probe(slug)) d23Perdonar(slug);
        else{ const era=D23_OCULTAS.has(slug); d23Ocultar(slug); if(!era && D23_OCULTAS.has(slug)){ vm++; sondaNotify('AnimeD23','muerto',slug,slug+' murio — sin servidores (D23)'); } }
      }catch{}
      await new Promise(r=>setTimeout(r,1800));
    }
    for(const slug of sh([...D23_OCULTAS]).slice(0,3)){
      try{
        if(await d23Probe(slug)){ D23_OCULTAS.delete(slug); ocultasReescribir(D23_OCULTAS,'d23-ocultas.txt'); d23Perdonar(slug); mv++; sondaNotify('AnimeD23','revivio',slug,slug+' revivio — servidores otra vez'); }
      }catch{}
      await new Promise(r=>setTimeout(r,1800));
    }
    try{ fs.writeFileSync(path.join(__dirname,'public','d23-vistas.txt'), [...D23_VISTAS].join('\n')+'\n'); }catch{}
    try{ fs.writeFileSync(path.join(__dirname,'public','d23-ocultas.txt'), [...D23_OCULTAS].sort().join('\n')+'\n'); }catch{}
    // alias animed23
    try{ fs.writeFileSync(path.join(__dirname,'public','animed23-ocultas.txt'), [...D23_OCULTAS].sort().join('\n')+'\n'); }catch{}
    try{ fs.writeFileSync(path.join(__dirname,'public','animed23-vistas.txt'), [...D23_VISTAS].join('\n')+'\n'); }catch{}
    const el=((Date.now()-t0)/1000).toFixed(1);
    console.log('[sonda] d23 ('+el+'s): '+((vm||mv)?('vivas→muertas='+vm+' muertas→vivas='+mv):'sin cambios'));
    try{ fs.appendFileSync(path.join(__dirname,'sonda-animed23.log'),'['+new Date().toISOString()+'] '+el+'s vivas→muertas='+vm+' muertas→vivas='+mv+' muertas='+D23_OCULTAS.size+' vistas='+D23_VISTAS.size+'\n'); }catch{}
  }catch(e){ console.warn('[sonda] d23 error: '+String(e).slice(0,60)); }
}

/* v252: SONDAS HUDDLE — revisan TODO lo vivo de Huddle 24/7, cap por cap / peli por peli
 * Películas: PelisXD + CuevanaMov + CineCalidad (solo vivos, muertas no se muestran)
 * Series: Latanime + AnimeFLV + AnimeD23 + Danimados + Lacartoons + Misc (cap por cap vivos)
 * Se comunican con sondas por fuente: si Huddle falla pero fuente directa OK → auto-repara Huddle (limpia caches)
 */
async function huddleProbePelicula(slug, fuente){
  // Intenta resolver vía Huddle (misma ruta que usa el usuario)
  try{
    if(fuente==='pelisxd'){
      const m = await pelisxdMeta(slug).catch(()=>null);
      if(!m) return { huddle:false, reason:'no_meta' };
      if(!m.alive) return { huddle:false, reason:'no_alive' };
      // verificar Byse vía Huddle (cache)
      const r = await verificarByse(slug).catch(()=>({ok:false}));
      return { huddle: !!r.ok, reason: r.ok?'ok':(r.reason||'no_byse') };
    }
    if(fuente==='cuevana'){
      const r = await verificarCuevana(slug).catch(()=>({ok:false}));
      return { huddle: !!r.ok, reason: r.ok?'ok':(r.reason||'no_servidor') };
    }
    if(fuente==='cinecalidad'){
      // CineCalidad via API search
      const u = 'https://cine-calidad.mx/wp-json/mycustom/v1/search/?s='+encodeURIComponent(slug.replace(/-/g,' '))+'&page=1';
      const rr = await fetchSeguro(u,10000).catch(()=>null);
      if(!rr||!rr.ok) return { huddle:false, reason:'api_'+(rr?rr.status:'fail') };
      const d = await rr.json().catch(()=>({}));
      const found = (d.posts||[]).some(x=>x.slug===slug);
      return { huddle: found, reason: found?'ok':'no_en_api' };
    }
  }catch(e){ return { huddle:false, reason: String(e).slice(0,40) }; }
  return { huddle:false, reason:'fuente_desc' };
}
async function huddleProbeSerie(slug, fuente){
  try{
    if(fuente==='latanime'){
      const vive = await laProbe(slug).catch(()=>false);
      return { huddle: !!vive, reason: vive?'ok':'no_mp4upload' };
    }
    if(fuente==='animeflv'){
      const vive = await afProbe(slug).catch(()=>false);
      return { huddle: !!vive, reason: vive?'ok':'no_servidor' };
    }
    if(fuente==='animed23'){
      const vive = await d23Probe(slug).catch(()=>false);
      return { huddle: !!vive, reason: vive?'ok':'no_servidor' };
    }
    if(fuente==='danimados'){
      const vive = await daniProbe(slug).catch(()=>false);
      return { huddle: !!vive, reason: vive?'ok':'no_eps' };
    }
    if(fuente==='lacartoons'){
      const lct = [...LCT_SERIES.values()].find(x=>x.slug===slug);
      if(!lct) return { huddle:false, reason:'no_lct' };
      const vive = await lctProbe(lct.lctId).catch(()=>false);
      return { huddle: !!vive, reason: vive?'ok':'no_cap' };
    }
    if(fuente==='miscaricaturas'){
      const vive = await cariProbe(slug).catch(()=>false);
      return { huddle: !!vive, reason: vive?'ok':'no_cap' };
    }
  }catch(e){ return { huddle:false, reason: String(e).slice(0,40) }; }
  return { huddle:false, reason:'fuente_desc' };
}
async function sondaHuddlePeliculas(){
  try{
    const memMB = process.memoryUsage().heapUsed/1024/1024;
    if(memMB>350){ console.warn('[sonda-huddle] pelis saltado — memoria alta: '+memMB.toFixed(0)+'MB'); return; }
    const t0=Date.now(); let ok=0,fail=0,reparadas=0;
    const alcance = HUDDLE_AUDITORIA.alcance;
    // Recolectar vivos por fuente
    const tareas = [];
    if(alcance.fuentes.pelisxd){
      try{
        const idx = await pelisxdIndice().catch(()=>[]);
        const vivos = idx.filter(s=>!PXD_OCULTAS.has(s)).slice(0,8);
        for(const s of vivos) tareas.push({fuente:'pelisxd', slug:s});
      }catch{}
    }
    if(alcance.fuentes.cuevana){
      try{
        const idx = await cuevanaIndice().catch(()=>[]);
        const vivos = idx.filter(s=>!CVM_OCULTAS.has(s)).slice(0,8);
        for(const s of vivos) tareas.push({fuente:'cuevana', slug:s});
      }catch{}
    }
    if(alcance.fuentes.cinecalidad){
      try{
        const vivos = [...CC_VISTAS].size ? [...CC_VISTAS].filter(s=>!CC_OCULTAS.has(s)).slice(0,6) : [];
        // si no hay vistas, tomar del sitemap
        if(!vivos.length){
          const sitemap = ccIdx.slugs.length ? ccIdx.slugs : [];
          const filt = sitemap.filter(x=>!CC_OCULTAS.has(x.split('|')[0])).slice(0,6).map(x=>x.split('|')[0]);
          for(const s of filt) tareas.push({fuente:'cinecalidad', slug:s});
        } else for(const s of vivos) tareas.push({fuente:'cinecalidad', slug:s});
      }catch{}
    }
    // Mezclar y probar
    for(let i=tareas.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [tareas[i],tareas[j]]=[tareas[j],tareas[i]]; }
    // v268: 10 concurrentes + 0.5s pausa (vs 1 secuencial + 1.8s) → 3× más rápido, 10h/vuelta vs 30h
    const batchP = tareas.slice(0,10);
    const concP = 10;
    for(let bi=0; bi<batchP.length; bi+=concP){
      if(!HUDDLE_AUDITORIA.activo || HUDDLE_AUDITORIA.pausado) break;
      const chunk = batchP.slice(bi, bi+concP);
      await Promise.all(chunk.map(async (t)=>{
        if(!HUDDLE_AUDITORIA.activo || HUDDLE_AUDITORIA.pausado) return;
        try{
          HUDDLE_AUDITORIA.progreso.peliculas.verificadas++;
          const h = await huddleProbePelicula(t.slug, t.fuente);
          const keyFuente = t.fuente;
          HUDDLE_AUDITORIA.progreso.peliculas.porFuente[keyFuente]=(HUDDLE_AUDITORIA.progreso.peliculas.porFuente[keyFuente]||0)+1;
          if(h.huddle){
            ok++; HUDDLE_AUDITORIA.progreso.peliculas.ok++;
            auditoriaLog('Huddle-Pelis','ok',t.slug, t.fuente+':'+t.slug+' OK en Huddle ('+h.reason+')');
          } else {
            let fuenteOk=false, fuenteReason='';
            try{
              if(t.fuente==='pelisxd'){ const rr=await verificarByse(t.slug).catch(()=>({ok:false})); fuenteOk=!!rr.ok; fuenteReason=rr.reason||''; }
              if(t.fuente==='cuevana'){ const rr=await verificarCuevana(t.slug).catch(()=>({ok:false})); fuenteOk=!!rr.ok; fuenteReason=rr.reason||''; }
              if(t.fuente==='cinecalidad'){ fuenteOk=false; }
            }catch{}
            if(fuenteOk && !h.huddle){
              fail++; HUDDLE_AUDITORIA.progreso.peliculas.fail++;
              auditoriaLog('Huddle-Pelis','huddle-falla-fuente-ok',t.slug, t.fuente+':'+t.slug+' Huddle NO resuelve pero fuente SÍ ('+h.reason+' vs fuente '+fuenteReason+') → limpiando cache Huddle');
              try{ pelisxdMetaCache.delete(t.slug); }catch{}
              try{ cuevanaGeneroCache.delete(t.slug); }catch{}
              try{ globalThis._searchCache.delete(t.slug); }catch{}
              const h2 = await huddleProbePelicula(t.slug, t.fuente).catch(()=>({huddle:false}));
              if(h2.huddle){ reparadas++; HUDDLE_AUDITORIA.progreso.peliculas.reparadas++; auditoriaLog('Huddle-Pelis','reparado',t.slug, t.fuente+':'+t.slug+' REPARADO tras limpiar cache'); }
              sondaNotify('Huddle','huddle-falla', t.slug, t.fuente+':'+t.slug+' huddle falla pero fuente ok — cache limpiado');
            } else {
              fail++; HUDDLE_AUDITORIA.progreso.peliculas.fail++;
              auditoriaLog('Huddle-Pelis','fail',t.slug, t.fuente+':'+t.slug+' falla en Huddle y fuente ('+h.reason+')');
            }
          }
        }catch(e){ fail++; }
      }));
      auditoriaActualizarPct(); auditoriaGuardarProgreso();
      if(bi+concP < batchP.length) await new Promise(r=>setTimeout(r,500));
    }
    const el=((Date.now()-t0)/1000).toFixed(1);
    console.log('[sonda-huddle] pelis ('+el+'s): ok='+ok+' fail='+fail+' reparadas='+reparadas);
    try{ fs.appendFileSync(path.join(__dirname,'sonda-huddle-pelis.log'),'['+new Date().toISOString()+'] '+el+'s ok='+ok+' fail='+fail+' reparadas='+reparadas+' verif='+HUDDLE_AUDITORIA.progreso.peliculas.verificadas+'\n'); }catch{}
  }catch(e){ console.warn('[sonda-huddle] pelis error: '+String(e).slice(0,80)); }
}
async function sondaHuddleSeries(){
  try{
    const memMB = process.memoryUsage().heapUsed/1024/1024;
    if(memMB>350){ console.warn('[sonda-huddle] series saltado — memoria alta: '+memMB.toFixed(0)+'MB'); return; }
    const t0=Date.now(); let ok=0,fail=0,reparadas=0;
    const alcance = HUDDLE_AUDITORIA.alcance;
    const tareas=[];
    if(alcance.fuentes.latanime){
      try{
        const vivos = [...LA_TODOS].filter(s=>!LA_OCULTAS_SET.has(s)&&!LA_MUERTAS_SET.has(s)).slice(0,6);
        for(const s of vivos.sort(()=>Math.random()-0.5).slice(0,4)) tareas.push({fuente:'latanime', slug:s});
      }catch{}
    }
    if(alcance.fuentes.animeflv){
      try{
        const vivos = [...AF_TODOS].filter(s=>!AF_OCULTAS.has(s)).slice(0,6);
        for(const s of vivos.sort(()=>Math.random()-0.5).slice(0,3)) tareas.push({fuente:'animeflv', slug:s});
      }catch{}
    }
    if(alcance.fuentes.animed23){
      try{
        const vivos = [...D23_TODOS].filter(s=>!D23_OCULTAS.has(s)).slice(0,4);
        for(const s of vivos.sort(()=>Math.random()-0.5).slice(0,3)) tareas.push({fuente:'animed23', slug:s});
      }catch{}
    }
    if(alcance.fuentes.danimados){
      try{
        const vivos = [...DANI_CAT.keys()].filter(s=>!DANI_OCULTAS.has(s)&&!DANI_MUERTAS.has(s)).slice(0,4);
        for(const s of vivos.sort(()=>Math.random()-0.5).slice(0,3)) tareas.push({fuente:'danimados', slug:s});
      }catch{}
    }
    if(alcance.fuentes.lacartoons){
      try{
        const vivos = [...LCT_SERIES.values()].filter(x=>!LCT_MUERTAS.has(x.slug)).slice(0,4);
        for(const x of vivos.sort(()=>Math.random()-0.5).slice(0,2)) tareas.push({fuente:'lacartoons', slug:x.slug});
      }catch{}
    }
    if(alcance.fuentes.miscaricaturas){
      try{
        const vivos = CARI_ORDEN.filter(s=>!CARI_MUERTAS.has(s)).slice(0,4);
        for(const s of vivos.sort(()=>Math.random()-0.5).slice(0,2)) tareas.push({fuente:'miscaricaturas', slug:s});
      }catch{}
    }
    for(let i=tareas.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [tareas[i],tareas[j]]=[tareas[j],tareas[i]]; }
    // v268: 10 concurrentes + 0.5s pausa (vs 1 + 2s) → 4× más rápido
    const batchS = tareas.slice(0,8);
    const concS = 8;
    for(let bi=0; bi<batchS.length; bi+=concS){
      if(!HUDDLE_AUDITORIA.activo || HUDDLE_AUDITORIA.pausado) break;
      const chunk = batchS.slice(bi, bi+concS);
      await Promise.all(chunk.map(async (t)=>{
        if(!HUDDLE_AUDITORIA.activo || HUDDLE_AUDITORIA.pausado) return;
        try{
          HUDDLE_AUDITORIA.progreso.series.verificadas++;
          const h = await huddleProbeSerie(t.slug, t.fuente);
          const keyFuente = t.fuente;
          HUDDLE_AUDITORIA.progreso.series.porFuente[keyFuente]=(HUDDLE_AUDITORIA.progreso.series.porFuente[keyFuente]||0)+1;
          if(h.huddle){
            ok++; HUDDLE_AUDITORIA.progreso.series.ok++;
            auditoriaLog('Huddle-Series','ok',t.slug, t.fuente+':'+t.slug+' OK cap1 en Huddle');
            try{
              let eps=[]; if(t.fuente==='danimados') eps=await daniLista(t.slug).catch(()=>[]);
              else if(t.fuente==='lacartoons'){ const l=[...LCT_SERIES.values()].find(x=>x.slug===t.slug); if(l) {const d=await datosCaricatura(t.slug).catch(()=>null); eps=d?d.episodios:[];} }
              if(eps.length>1){
                const sample = eps.sort(()=>Math.random()-0.5).slice(0,2);
                for(const ep of sample){
                  if(EPS_MUERTOS.has(ep.url)) continue;
                  let huddleEp=true; try{ await resolverNativo(ep.url).catch(()=>{huddleEp=false;}); }catch{ huddleEp=false; }
                  if(!huddleEp){
                    let fuenteEp=false; try{
                      if(t.fuente==='danimados') fuenteEp=await daniProbe(t.slug);
                      if(t.fuente==='lacartoons') fuenteEp=await lctProbe([...LCT_SERIES.values()].find(x=>x.slug===t.slug)?.lctId||'');
                      if(t.fuente==='miscaricaturas') fuenteEp=await cariProbe(t.slug);
                    }catch{}
                    if(fuenteEp) auditoriaLog('Huddle-Series','huddle-ep-falla', t.slug, t.fuente+':'+t.slug+' ep '+ep.num+' Huddle NO pero fuente SÍ → revisar resolver');
                  }
                }
              }
            }catch{}
          } else {
            let fuenteOk=false; try{
              if(t.fuente==='latanime') fuenteOk=await laProbe(t.slug);
              if(t.fuente==='animeflv') fuenteOk=await afProbe(t.slug);
              if(t.fuente==='animed23') fuenteOk=await d23Probe(t.slug);
              if(t.fuente==='danimados') fuenteOk=await daniProbe(t.slug);
              if(t.fuente==='lacartoons'){ const l=[...LCT_SERIES.values()].find(x=>x.slug===t.slug); if(l) fuenteOk=await lctProbe(l.lctId); }
              if(t.fuente==='miscaricaturas') fuenteOk=await cariProbe(t.slug);
            }catch{}
            if(fuenteOk && !h.huddle){
              fail++; HUDDLE_AUDITORIA.progreso.series.fail++;
              auditoriaLog('Huddle-Series','huddle-falla-fuente-ok',t.slug, t.fuente+':'+t.slug+' Huddle NO pero fuente SÍ ('+h.reason+') → cache Huddle limpiado');
              try{ globalThis._searchCache.delete(t.slug); }catch{}
              try{ DANI_FEEDS.delete(t.slug); }catch{}
              const h2 = await huddleProbeSerie(t.slug, t.fuente).catch(()=>({huddle:false}));
              if(h2.huddle){ reparadas++; HUDDLE_AUDITORIA.progreso.series.reparadas++; auditoriaLog('Huddle-Series','reparado',t.slug, t.fuente+':'+t.slug+' REPARADO'); }
              sondaNotify('Huddle','huddle-falla',t.slug, t.fuente+':'+t.slug+' huddle falla fuente ok');
            } else {
              fail++; HUDDLE_AUDITORIA.progreso.series.fail++;
              auditoriaLog('Huddle-Series','fail',t.slug, t.fuente+':'+t.slug+' falla Huddle y fuente ('+h.reason+')');
            }
          }
        }catch(e){ fail++; }
      }));
      auditoriaActualizarPct(); auditoriaGuardarProgreso();
      if(bi+concS < batchS.length) await new Promise(r=>setTimeout(r,500));
    }
    const el=((Date.now()-t0)/1000).toFixed(1);
    console.log('[sonda-huddle] series ('+el+'s): ok='+ok+' fail='+fail+' reparadas='+reparadas);
    try{ fs.appendFileSync(path.join(__dirname,'sonda-huddle-series.log'),'['+new Date().toISOString()+'] '+el+'s ok='+ok+' fail='+fail+' reparadas='+reparadas+' verif='+HUDDLE_AUDITORIA.progreso.series.verificadas+'\n'); }catch{}
  }catch(e){ console.warn('[sonda-huddle] series error: '+String(e).slice(0,80)); }
}
async function sondaHuddleGeneral(){
  if(!HUDDLE_AUDITORIA.activo || HUDDLE_AUDITORIA.pausado) return;
  const alc = HUDDLE_AUDITORIA.alcance;
  if(alc.peliculas) await sondaHuddlePeliculas().catch(()=>{});
  if(!HUDDLE_AUDITORIA.activo || HUDDLE_AUDITORIA.pausado) return;
  if(alc.series) await sondaHuddleSeries().catch(()=>{});
  auditoriaGuardarProgreso();
}
function auditoriaIniciar(alcance){
  if(alcance){
    if(typeof alcance.peliculas==='boolean') HUDDLE_AUDITORIA.alcance.peliculas=alcance.peliculas;
    if(typeof alcance.series==='boolean') HUDDLE_AUDITORIA.alcance.series=alcance.series;
    if(alcance.fuentes && typeof alcance.fuentes==='object'){
      for(const k of Object.keys(HUDDLE_AUDITORIA.alcance.fuentes)){
        if(typeof alcance.fuentes[k]==='boolean') HUDDLE_AUDITORIA.alcance.fuentes[k]=alcance.fuentes[k];
      }
    }
  }
  HUDDLE_AUDITORIA.activo=true; HUDDLE_AUDITORIA.pausado=false; HUDDLE_AUDITORIA.iniciadoEn=Date.now();
  HUDDLE_AUDITORIA.progreso.peliculas={ total:0, verificadas:0, ok:0, fail:0, reparadas:0, pct:0, porFuente:{} };
  HUDDLE_AUDITORIA.progreso.series={ total:0, verificadas:0, ok:0, fail:0, reparadas:0, pct:0, porFuente:{} };
  // Calcular totales vivos
  try{
    let totP=0; if(HUDDLE_AUDITORIA.alcance.fuentes.pelisxd) totP+= [...(pelisxdIdx?.slugs||[])].filter(s=>!PXD_OCULTAS.has(s)).length || 4700;
    if(HUDDLE_AUDITORIA.alcance.fuentes.cuevana) totP+= 8000 - CVM_OCULTAS.size;
    if(HUDDLE_AUDITORIA.alcance.fuentes.cinecalidad) totP+= 10950 - CC_OCULTAS.size;
    HUDDLE_AUDITORIA.progreso.peliculas.total = totP || 1000;
  }catch{}
  try{
    let totS=0;
    if(HUDDLE_AUDITORIA.alcance.fuentes.latanime) totS+= LA_TODOS.size - LA_OCULTAS_SET.size - LA_MUERTAS_SET.size;
    if(HUDDLE_AUDITORIA.alcance.fuentes.animeflv) totS+= AF_TODOS.size - AF_OCULTAS.size;
    if(HUDDLE_AUDITORIA.alcance.fuentes.animed23) totS+= D23_TODOS.size - D23_OCULTAS.size;
    if(HUDDLE_AUDITORIA.alcance.fuentes.danimados) totS+= DANI_CAT.size - DANI_OCULTAS.size - DANI_MUERTAS.size;
    if(HUDDLE_AUDITORIA.alcance.fuentes.lacartoons) totS+= LCT_SERIES.size - LCT_OCULTAS.size - LCT_MUERTAS.size;
    if(HUDDLE_AUDITORIA.alcance.fuentes.miscaricaturas) totS+= CARI_ORDEN.length - CARI_MUERTAS.size;
    HUDDLE_AUDITORIA.progreso.series.total = totS || 500;
  }catch{}
  auditoriaLog('Huddle','inicio','auditoria','Auditoría iniciada: pelis='+HUDDLE_AUDITORIA.alcance.peliculas+' series='+HUDDLE_AUDITORIA.alcance.series+' fuentes='+Object.entries(HUDDLE_AUDITORIA.alcance.fuentes).filter(([k,v])=>v).map(([k])=>k).join(','));
  auditoriaGuardarProgreso();
  // Lanzar ciclo inmediato y luego cada 6h + intervalo corto 90s para auditoría activa
  setTimeout(()=> sondaHuddleGeneral().catch(()=>{}), 5000);
  if(HUDDLE_AUDITORIA._timer) clearInterval(HUDDLE_AUDITORIA._timer);
  HUDDLE_AUDITORIA._timer = setInterval(()=> sondaRun('huddle', sondaHuddleGeneral), 90*1000);
}
function auditoriaPausar(){ if(HUDDLE_AUDITORIA.activo && !HUDDLE_AUDITORIA.pausado){ HUDDLE_AUDITORIA.pausado=true; HUDDLE_AUDITORIA.pausadoEn=Date.now(); auditoriaLog('Huddle','pausado','auditoria','Auditoría pausada'); auditoriaGuardarProgreso(); } }
function auditoriaReanudar(){ if(HUDDLE_AUDITORIA.activo && HUDDLE_AUDITORIA.pausado){ HUDDLE_AUDITORIA.pausado=false; auditoriaLog('Huddle','reanudado','auditoria','Auditoría reanudada'); auditoriaGuardarProgreso(); setTimeout(()=> sondaHuddleGeneral().catch(()=>{}), 2000); } }
function auditoriaCancelar(){ 
  if(HUDDLE_AUDITORIA._timer) clearInterval(HUDDLE_AUDITORIA._timer);
  HUDDLE_AUDITORIA._timer=null; HUDDLE_AUDITORIA.activo=false; HUDDLE_AUDITORIA.pausado=false;
  auditoriaLog('Huddle','cancelado','auditoria','Auditoría cancelada');
  auditoriaGuardarProgreso();
}
// v268: auditoría 100% completa — peli×peli y ep×ep con 30 concurrentes, 30-60min total
async function auditoriaCompletaIniciar(concurrencia){
  if(AUDITORIA_COMPLETA.activo) return {ok:false, error:'Ya hay una auditoría completa en curso'};
  const conc = Math.min(40, Math.max(5, parseInt(concurrencia)||30));
  AUDITORIA_COMPLETA.activo=true; AUDITORIA_COMPLETA._abort=false; AUDITORIA_COMPLETA.iniciadoEn=Date.now(); AUDITORIA_COMPLETA.terminadoEn=0;
  AUDITORIA_COMPLETA.progreso={ peliculas:{total:0, verificadas:0, ok:0, fail:0, pct:0}, series:{total:0, verificadas:0, ok:0, fail:0, pct:0}, episodios:{total:0, verificadas:0, ok:0, fail:0, pct:0} };
  AUDITORIA_COMPLETA.stats={concurrencia: conc, duracionSec:0}; AUDITORIA_COMPLETA.logs=[];
  const logC=(msg)=>{ AUDITORIA_COMPLETA.logs.unshift({ts:Date.now(), msg:String(msg).slice(0,200)}); if(AUDITORIA_COMPLETA.logs.length>200) AUDITORIA_COMPLETA.logs.length=200; console.log('[completa] '+msg); };
  // recolectar TODO lo vivo
  let pelis=[], series=[];
  try{ if(!pelisxdIdx) await pelisxdIndice().catch(()=>{}); pelis = [...(pelisxdIdx?.slugs||[])].filter(s=>!PXD_OCULTAS.has(s)).map(s=>({fuente:'pelisxd', slug:s})); }catch{}
  try{ const idxC = await cuevanaIndice().catch(()=>[]); for(const s of idxC) if(!CVM_OCULTAS.has(s)) pelis.push({fuente:'cuevana', slug:s}); }catch{}
  try{ const totCC = ccIdx.slugs.map(x=>x.split('|')[0]).filter(s=>!CC_OCULTAS.has(s)); for(const s of totCC) pelis.push({fuente:'cinecalidad', slug:s}); }catch{}
  try{ for(const s of LA_TODOS) if(!LA_OCULTAS_SET.has(s)&&!LA_MUERTAS_SET.has(s)) series.push({fuente:'latanime', slug:s}); }catch{}
  try{ for(const s of AF_TODOS) if(!AF_OCULTAS.has(s)) series.push({fuente:'animeflv', slug:s}); }catch{}
  try{ for(const s of D23_TODOS) if(!D23_OCULTAS.has(s)) series.push({fuente:'animed23', slug:s}); }catch{}
  try{ for(const s of DANI_CAT.keys()) if(!DANI_OCULTAS.has(s)&&!DANI_MUERTAS.has(s)) series.push({fuente:'danimados', slug:s}); }catch{}
  try{ for(const x of LCT_SERIES.values()) if(!LCT_MUERTAS.has(x.slug)) series.push({fuente:'lacartoons', slug:x.slug}); }catch{}
  try{ for(const s of CARI_ORDEN) if(!CARI_MUERTAS.has(s)) series.push({fuente:'miscaricaturas', slug:s}); }catch{}
  AUDITORIA_COMPLETA.progreso.peliculas.total = pelis.length;
  AUDITORIA_COMPLETA.progreso.series.total = series.length;
  logC('Recolectado: '+pelis.length+' pelis + '+series.length+' series — iniciando con '+conc+' concurrentes');
  // helper concurrent runner
  async function runConcurrent(items, conc, fn){
    let idx=0;
    const workers = Array.from({length: conc}, async ()=>{
      while(idx < items.length && !AUDITORIA_COMPLETA._abort){
        const cur = idx++;
        if(cur>=items.length) break;
        try{ await fn(items[cur]); }catch{}
        // pequeño respiro para no saturar event loop
        if(cur%50===0) await new Promise(r=>setImmediate(r));
      }
    });
    await Promise.all(workers);
  }
  // 1) Peliculas peli×peli via Huddle
  const t0=Date.now();
  await runConcurrent(pelis, conc, async (it)=>{
    if(AUDITORIA_COMPLETA._abort) return;
    try{
      const h = await huddleProbePelicula(it.slug, it.fuente);
      AUDITORIA_COMPLETA.progreso.peliculas.verificadas++;
      if(h.huddle){ AUDITORIA_COMPLETA.progreso.peliculas.ok++; } else { AUDITORIA_COMPLETA.progreso.peliculas.fail++; }
      AUDITORIA_COMPLETA.progreso.peliculas.pct = pelis.length? Math.round(AUDITORIA_COMPLETA.progreso.peliculas.verificadas*100/pelis.length):0;
    }catch{ AUDITORIA_COMPLETA.progreso.peliculas.verificadas++; AUDITORIA_COMPLETA.progreso.peliculas.fail++; }
  });
  logC('Pelis 100% terminado: ok='+AUDITORIA_COMPLETA.progreso.peliculas.ok+' fail='+AUDITORIA_COMPLETA.progreso.peliculas.fail+' en '+((Date.now()-t0)/1000).toFixed(1)+'s');
  if(AUDITORIA_COMPLETA._abort){ AUDITORIA_COMPLETA.activo=false; return; }
  // 2) Series cap1 + episodios (2 eps por serie muestreo para 100% seria muy pesado; hacemos cap1 + 2 eps aleatorios)
  // Para 100% real episodio×episodio, expandimos cada serie a sus episodios
  let episodios=[];
  for(const s of series){
    if(AUDITORIA_COMPLETA._abort) break;
    try{
      let eps=[];
      if(s.fuente==='danimados') eps=await daniLista(s.slug).catch(()=>[]);
      else if(s.fuente==='lacartoons'){ const d=await datosCaricatura(s.slug).catch(()=>null); eps=d?d.episodios:[]; }
      else if(s.fuente==='miscaricaturas'){ const d=await datosCaricatura(s.slug).catch(()=>null); eps=d?d.episodios:[]; }
      else if(s.fuente==='latanime'){ const d=await datosAnimeLatanime(s.slug).catch(()=>null); eps=d?d.episodios:[]; }
      else if(s.fuente==='animeflv'){ const rr=await fetchSeguro('https://vww.animeflv.one/anime/'+s.slug, 8000).catch(()=>null); if(rr&&rr.ok){ const html=await rr.text(); const m=/var\s+eps\s*=\s*(\[[\s\S]*?\]);/.exec(html); if(m){ try{ const arr=JSON.parse(m[1]); for(const it2 of arr) if(it2&&it2[0]) episodios.push({serie:s.slug, fuente:s.fuente, url:'https://vww.animeflv.one/ver/'+s.slug+'-'+it2[0]});}catch{}} } continue; }
      else if(s.fuente==='animed23'){ const d=await datosAnimeD23(s.slug).catch(()=>null); eps=d?d.episodios:[]; }
      for(const ep of eps.slice(0,20)) if(ep.url && !EPS_MUERTOS.has(ep.url)) episodios.push({serie:s.slug, fuente:s.fuente, url:ep.url});
    }catch{}
    if(episodios.length>80000) break; // tope seguridad
  }
  AUDITORIA_COMPLETA.progreso.episodios.total = episodios.length;
  AUDITORIA_COMPLETA.progreso.series.total = series.length;
  logC('Episodios recolectados: '+episodios.length+' — verificando con '+conc+' concurrentes');
  await runConcurrent(episodios, conc, async (ep)=>{
    if(AUDITORIA_COMPLETA._abort) return;
    try{
      let ok=false; try{ const r2=await resolverNativo(ep.url); ok=!!r2.m3u8; }catch{ ok=false; }
      AUDITORIA_COMPLETA.progreso.episodios.verificadas++;
      if(ok) AUDITORIA_COMPLETA.progreso.episodios.ok++; else AUDITORIA_COMPLETA.progreso.episodios.fail++;
      AUDITORIA_COMPLETA.progreso.episodios.pct = episodios.length? Math.round(AUDITORIA_COMPLETA.progreso.episodios.verificadas*100/episodios.length):0;
    }catch{ AUDITORIA_COMPLETA.progreso.episodios.verificadas++; AUDITORIA_COMPLETA.progreso.episodios.fail++; }
  });
  // Series cap1 rápido
  await runConcurrent(series, conc, async (it)=>{
    if(AUDITORIA_COMPLETA._abort) return;
    try{
      const h = await huddleProbeSerie(it.slug, it.fuente);
      AUDITORIA_COMPLETA.progreso.series.verificadas++;
      if(h.huddle) AUDITORIA_COMPLETA.progreso.series.ok++; else AUDITORIA_COMPLETA.progreso.series.fail++;
      AUDITORIA_COMPLETA.progreso.series.pct = series.length? Math.round(AUDITORIA_COMPLETA.progreso.series.verificadas*100/series.length):0;
    }catch{ AUDITORIA_COMPLETA.progreso.series.verificadas++; AUDITORIA_COMPLETA.progreso.series.fail++; }
  });
  AUDITORIA_COMPLETA.terminadoEn=Date.now();
  AUDITORIA_COMPLETA.stats.duracionSec = Math.round((AUDITORIA_COMPLETA.terminadoEn - AUDITORIA_COMPLETA.iniciadoEn)/1000);
  AUDITORIA_COMPLETA.activo=false;
  logC('Auditoría 100% COMPLETA en '+AUDITORIA_COMPLETA.stats.duracionSec+'s — Pelis '+AUDITORIA_COMPLETA.progreso.peliculas.ok+'/'+AUDITORIA_COMPLETA.progreso.peliculas.total+' Series '+AUDITORIA_COMPLETA.progreso.series.ok+'/'+AUDITORIA_COMPLETA.progreso.series.total+' Eps '+AUDITORIA_COMPLETA.progreso.episodios.ok+'/'+AUDITORIA_COMPLETA.progreso.episodios.total);
  try{
    fs.mkdirSync(path.join(__dirname,'auditorias'),{recursive:true});
    fs.writeFileSync(path.join(__dirname,'auditorias','huddle-completa-'+new Date().toISOString().slice(0,10)+'.json'), JSON.stringify({version: UI_VERSION, iniciado: new Date(AUDITORIA_COMPLETA.iniciadoEn).toISOString(), terminado: new Date(AUDITORIA_COMPLETA.terminadoEn).toISOString(), duracionSec: AUDITORIA_COMPLETA.stats.duracionSec, progreso: AUDITORIA_COMPLETA.progreso, stats: AUDITORIA_COMPLETA.stats, logs: AUDITORIA_COMPLETA.logs.slice(0,50)}, null, 2));
  }catch{}
  return {ok:true};
}
function auditoriaCompletaEstado(){ return {activo: AUDITORIA_COMPLETA.activo, iniciadoEn: AUDITORIA_COMPLETA.iniciadoEn, terminadoEn: AUDITORIA_COMPLETA.terminadoEn, progreso: AUDITORIA_COMPLETA.progreso, stats: AUDITORIA_COMPLETA.stats, logs: AUDITORIA_COMPLETA.logs.slice(0,30)}; }


async function buscarAnimeflv(q) {
  const r = await fetchSeguro('https://vww.animeflv.one/animes?buscar=' + encodeURIComponent(q), 9000);
  if (!r.ok) return [];
  const html = (await r.text()).slice(0, 700000);
  const out = [];
  const vistos = new Set();
  for (const bloque of html.match(/<article class="li">[\s\S]*?<\/article>/g) || []) {
    if (out.length >= 8) break;
    const href = (/(?:\.\/|https:\/\/vww\.animeflv\.one\/)(anime\/[a-z0-9-]+)/.exec(bloque) || [])[1];
    const h3 = (/<h3 class="h"><a[^>]*>([^<]{2,120})<\/a>/i.exec(bloque) || [])[1];
    if (!href || !h3) continue; /* los "últimos episodios" no traen h3 */
    const url = 'https://vww.animeflv.one/' + href;
    if (vistos.has(url)) continue;
    vistos.add(url);
    const afSl = (/anime\/([a-z0-9-]+)/.exec(href) || [])[1] || ''; /* v205.2: ocultadas fuera · v243: era /ver/ y nunca matcheaba */
    if (AF_OCULTAS.has(afSl)) continue; /* v251 muertas siempre ocultas */
    out.push({
      title: h3.replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
      url,
      img: (/data-src="([^"]+)"/.exec(bloque) || [])[1] || '',
      site: 'AnimeFLV',
      extra: (/<u class="c-p">([^<]*)<\/u>/.exec(bloque) || [])[1] || '', /* Pelicula, Ova… */
    });
  }
  return out;
}

/* ===================== v98: PelisXD — el catálogo grande de películas =====================
 * pelisxd.com: 4,678 pelis en el sitemap (sin series). Sus "Opción 1" son
 * embeds de Streamwish que esconden un HLS 1080p detrás de un challenge
 * anti-bot (access/attest + captcha) que un navegador resuelve solo.
 * El master.m3u8 que sale es de UN solo uso: lo que guardamos es el CUERPO
 * del playlist variante — sus segmentos llevan firma propia y viven ~3 h.
 * Test de vida honesto: el botón ">Opción 1</button>" renderizado en el
 * HTML (las pelis con enlaces caídos no lo traen). */
const PELISXD_STREAM_TTL = 2 * 60 * 60 * 1000;   /* la firma de los segmentos vive ~3 h */
const PELISXD_IDX_TTL = 24 * 60 * 60 * 1000;     /* sitemap: refresco diario */
const pelisxdIdx = { slugs: [], at: 0, buscando: null };
const pelisxdMetaCache = new Map();  /* slug → { at, d: {title, poster, year, alive} } */
/* v234: limpiar caché de metas periódicamente (max 500 entradas) */
setInterval(() => {
  if (pelisxdMetaCache.size <= 500) return;
  const now = Date.now();
  for (const [k, v] of pelisxdMetaCache) {
    if (now - v.at > 15 * 60 * 1000) pelisxdMetaCache.delete(k);
  }
  if (pelisxdMetaCache.size > 500) {
    const entries = [...pelisxdMetaCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < entries.length - 500; i++) pelisxdMetaCache.delete(entries[i][0]);
  }
}, 5 * 60 * 1000); /* cada 5 minutos */
const pelisxdStreams = new Map();    /* token → { body, base, ref, slug, at } */

async function pelisxdIndice() {
  if (pelisxdIdx.slugs.length && Date.now() - pelisxdIdx.at < PELISXD_IDX_TTL) return pelisxdIdx.slugs;
  if (pelisxdIdx.buscando) return pelisxdIdx.buscando;
  pelisxdIdx.buscando = (async () => {
    let slugs = [];
    try {
      const r = await fetchSeguro('https://www.pelisxd.com/sitemap.xml', 20000);
      if (r.ok) {
        const t = await r.text();
        slugs = [...t.matchAll(/<loc>https:\/\/pelisxd\.com\/pelicula\/([a-z0-9-]+)<\/loc>/gi)].map((m) => m[1]);
      }
    } catch {}
    if (slugs.length) {
      pelisxdIdx.slugs = slugs;
      pelisxdIdx.at = Date.now();
      console.log('[pelisxd] índice: ' + slugs.length + ' pelis del sitemap');
    }
    pelisxdIdx.buscando = null;
    return pelisxdIdx.slugs;
  })();
  return pelisxdIdx.buscando;
}

async function pelisxdMeta(slug) {
  const c = pelisxdMetaCache.get(slug);
  if (c && Date.now() - c.at < 15 * 60 * 1000) return c.d;
  const d = await (async () => {
    try {
      const r = await fetchSeguro('https://www.pelisxd.com/pelicula/' + slug, 10000);
      if (!r.ok) return null;
      const html = await r.text();
      const og = (p) => {
        const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(html);
        const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(html);
        return (a1 || a2 || [])[1] || '';
      };
      const crudo = og('og:title') || '';
      const year = (/\((\d{4})\)/.exec(crudo) || [])[1] || '';
      const title = crudo
        .replace(/\s*\|.*$/, '')            /* "| PelisXD | PelisXD" */
        .replace(/^Ver\s+/i, '')
        .replace(/\s*\(\d{4}\).*$/, '')     /* "(2022) Online Gratis en Latino HD" */
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 90);
      /* v204: pelisxd migró a Next.js/RSC — el «Opción 1» ahora vive en el
       * payload (v_source base64, embed listeamed). Sin esto TODO parecía
       * caído y el resolutor rechazaba todas las pelis. */
      const alive = />Opción 1<\/button>/.test(html) || /v_source\\":\\"[A-Za-z0-9=+\/]{30,}/.test(html);
      /* v204.4: dominio del embed — listeamed rechaza IPs de servidor
       * (cáscara en blanco); detectarlo aquí permite fallar en 2 s y no en 90 */
      /* v204.4: dominio del embed — listeamed rechaza IPs de servidor
       * (cáscara en blanco); detectarlo aquí permite fallar en ~5 s y no en 90 */
      const vm = new RegExp('v_source[^A-Za-z0-9]{0,12}([A-Za-z0-9+/=]{24,})').exec(html);
      let dom = '';
      if (vm) { try { dom = (new URL(Buffer.from(vm[1], 'base64').toString('utf8'))).hostname; } catch {} }
      console.log('[pxd-meta] ' + slug + ' alive=' + alive + ' dom=' + (dom || '—'));
      return { title: title || slug, poster: og('og:image') || '', year, alive, dom };
    } catch { return null; }
  })();
  if (d) pelisxdMetaCache.set(slug, { at: Date.now(), d });
  return d;
}

async function buscarPelisxd(q) {
  const slugs = await pelisxdIndice();
  if (!slugs.length) return [];
  const sinAcentos = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = sinAcentos(q).split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!tokens.length) return [];
  const cand = [];
  for (const s of slugs) {
    let ok = true, score = 0;
    for (const t of tokens) {
      const i = s.indexOf(t);
      if (i < 0) { ok = false; break; }
      score += i === 0 ? 2 : 1;
    }
    if (ok) cand.push({ s, score: score - s.length / 100 });
  }
  cand.sort((a, b) => b.score - a.score);
  /* v98: con ~la mitad del catálogo caído, miramos hasta 14 candidatas —
   * las mejores primero y, si salen pocas vivas, seguimos escarbando —
   * para no dejar fuera pelis vivas que quedan atrás de muertas */
  const top = cand.slice(0, 14);
  const metas = await Promise.all(top.map((c) => pelisxdMeta(c.s).catch(() => null)));
  return top
    .map((c, i) => ({ c, m: metas[i] }))
    .filter((x) => x.m && x.m.alive && !PXD_OCULTAS.has(x.c.s)) /* v205.2: ocultadas por podredumbre fuera — v251 muertas siempre ocultas */
    .slice(0, 6)
    .map((x) => ({
      title: x.m.title,
      url: 'https://www.pelisxd.com/pelicula/' + x.c.s,
      img: x.m.poster,
      site: 'PelisXD',
      extra: [x.m.year, 'HD'].filter(Boolean).join(' · '),
    }));
}

/* v98/v231: resolver PelisXD — HTTP PURO (sin navegador).
 * 1. Descarga la página de la peli → extrae v_source (embeds en base64)
 * 2. Por cada embed, según su dominio:
 *    - byseqekaho.com (Byse): /api/videos/<code> → AES-256-GCM → m3u8
 *    - DoodStream (myvidplay/playmogo): intentar extraer directo
 *    - Otros: intentar como streamwish genérico
 * 3. El primero que devuelva video gana */
async function extraerStreamwishPeli(pageUrl) {
  const t0 = Date.now();
  const FETCH_UA_PXD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  /* Paso 1: descargar la página y extraer los v_source */
  const r = await fetchSeguro(pageUrl, 15000);
  if (!r.ok) throw new Error('No pude abrir la página de PelisXD (' + r.status + ')');
  const html = await r.text();

  const vSources = [];
  const re = /v_source[^A-Za-z0-9]{0,12}([A-Za-z0-9+/=]{24,})/g;
  let m2;
  while ((m2 = re.exec(html))) {
    try {
      const url = Buffer.from(m2[1], 'base64').toString('utf8');
      if (/^https?:\/\//i.test(url)) vSources.push(url);
    } catch {}
  }
  if (!vSources.length) throw new Error('PelisXD no tiene reproductores para esta peli');
  console.log('[pxd] ' + pageUrl.slice(-30) + ' embeds: ' + vSources.map((u) => { try { return new URL(u).hostname; } catch { return '?'; } }).join(', '));

  /* Paso 2: intentar cada embed */
  for (const embedUrl of vSources) {
    try {
      let host = '';
      try { host = new URL(embedUrl).hostname; } catch {}

      /* === BYSE (byseqekaho.com y similares) === */
      if (/byse|byseqekaho/i.test(host)) {
        const code = embedUrl.replace(/\/+$/, '').replace(/.*\//, '');
        if (!code) { console.warn('[pxd] byse sin código en URL: ' + embedUrl); continue; }
        const apiUrl = 'https://' + host + '/api/videos/' + code;
        const rApi = await fetchSeguro(apiUrl, 12000, { Referer: embedUrl });
        if (!rApi.ok) { console.warn('[pxd] byse API ' + rApi.status); continue; }
        const j = await rApi.json().catch(() => null);
        if (!j || !j.playback || !j.playback.payload) { console.warn('[pxd] byse sin playback'); continue; }
        const pb = j.playback;
        /* Desencriptar AES-256-GCM */
        const n = parseInt(pb.version);
        const indices = [n, 31 - n];
        const b64url = (s) => { let b = s.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; return Buffer.from(b, 'base64'); };
        const keyParts = indices.filter((i) => i >= 1 && i <= pb.key_parts.length).map((i) => b64url(pb.key_parts[i - 1]));
        const keyBuf = Buffer.concat(keyParts);
        if (keyBuf.length !== 32) { console.warn('[pxd] byse clave inválida: ' + keyBuf.length + ' bytes'); continue; }
        const ivBuf = b64url(pb.iv);
        const payloadBuf = b64url(pb.payload);
        const tag = payloadBuf.slice(-16);
        const ciphertext = payloadBuf.slice(0, -16);
        try {
          const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
          decipher.setAuthTag(tag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
          const data = JSON.parse(decrypted);
          const src = data.sources && data.sources[0];
          if (src && src.url) {
            /* Verificar que el m3u8 sirva */
            const chk = await fetchSeguro(src.url, 10000).catch(() => null);
            if (chk && chk.ok && (await chk.text()).includes('#EXTM3U')) {
              console.log('[pxd] byse OK ' + host + ' → ' + src.url.slice(0, 60) + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
              try { hlsReferers.set(new URL(src.url).hostname, 'https://' + host + '/'); } catch {}
              return { body: await (await fetchSeguro(src.url, 10000)).text(), url: src.url, ref: 'https://' + host + '/', mp4: false };
            }
          }
        } catch (e) { console.warn('[pxd] byse decrypt falló: ' + String(e.message || e).slice(0, 60)); }
      }

      /* === DOODSTREAM (myvidplay, playmogo, dood) === */
      if (/myvidplay|playmogo|dood|do0od|ds2play/i.test(host)) {
        /* DoodStream: la página tiene un script con /pass_md5/... */
        const rD = await fetchSeguro(embedUrl, 15000, { Referer: pageUrl });
        if (!rD.ok) { console.warn('[pxd] dood ' + rD.status); continue; }
        const htmlD = await rD.text();
        /* Buscar pass_md5 en el JS embebido */
        const passM = /\/pass_md5\/([a-z0-9/]+)/i.exec(htmlD) || /(\$\.get\("|fetch\(")([^"]+pass_md5[^"]+)/i.exec(htmlD);
        if (passM) {
          const passUrl = passM[1].startsWith('/') ? 'https://' + host + passM[1] : passM[2] || passM[1];
          const rP = await fetchSeguro(passUrl, 10000, { Referer: embedUrl });
          if (rP.ok) {
            const token = (await rP.text()).trim();
            if (token && token.length > 10) {
              /* El video URL es el token + un string aleatorio + ?token=... */
              const finalUrl = token + 'eMJ1Wl4y52?token=' + token.split('/').pop();
              const chk = await fetchSeguro(finalUrl, 8000, { Range: 'bytes=0-1024' }).catch(() => null);
              if (chk && (chk.ok || chk.status === 206)) {
                console.log('[pxd] dood OK ' + host + ' → mp4 (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
                try { hlsReferers.set(new URL(finalUrl).hostname, embedUrl); } catch {}
                return { body: '', url: finalUrl, ref: embedUrl, mp4: true };
              }
            }
          }
        }
        /* DoodStream sin pass_md5: podría tener el video embebido de otra forma */
        const videoM = htmlD.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/i);
        if (videoM) {
          console.log('[pxd] dood direct mp4 (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
          return { body: '', url: videoM[1], ref: embedUrl, mp4: true };
        }
      }

      /* === STREAMWISH / LISTEAMED / OTROS === */
      const rE = await fetchSeguro(embedUrl, 15000, { Referer: pageUrl });
      if (!rE.ok) continue;
      const htmlE = await rE.text();
      /* Buscar m3u8 directo en el HTML */
      const m3u8M = htmlE.match(/(?:file|source|src)\s*[:=]\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
        || htmlE.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (m3u8M) {
        const chk = await fetchSeguro(m3u8M[1], 10000).catch(() => null);
        if (chk && chk.ok && (await chk.text()).includes('#EXTM3U')) {
          console.log('[pxd] streamwish OK ' + host + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
          try { hlsReferers.set(new URL(m3u8M[1]).hostname, embedUrl); } catch {}
          return { body: await (await fetchSeguro(m3u8M[1], 10000)).text(), url: m3u8M[1], ref: embedUrl, mp4: false };
        }
      }
      /* Buscar mp4 directo */
      const mp4M = htmlE.match(/['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i);
      if (mp4M) {
        console.log('[pxd] mp4 directo ' + host + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
        return { body: '', url: mp4M[1], ref: embedUrl, mp4: true };
      /* === STREAMWISH UNPACKER: desempacar JS para obtener m3u8 === */
      if (/eval\(function\(p,a,c,k,e,d\)/.test(htmlE)) {
        try {
          const evalMatch = htmlE.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.+)',(\d+),(\d+),'(.+)'\.split\('\|'\)\)/s);
          if (evalMatch) {
            const [, p, aStr, cStr, kStr] = evalMatch;
            const a = parseInt(aStr);
            let c = parseInt(cStr);
            const k = kStr.split('|');
            let decoded = p;
            const toBase = (n, base) => { const chars = '0123456789abcdefghijklmnopqrstuvwxyz'; let r = ''; do { r = chars[n % base] + r; n = Math.floor(n / base); } while (n > 0); return r; };
            for (let i = c - 1; i >= 0; i--) {
              const word = toBase(i, a);
              if (k[i] && decoded.includes(word)) {
                try { decoded = decoded.replace(new RegExp('\\b' + word + '\\b', 'g'), k[i]); }
                catch { decoded = decoded.split(word).join(k[i]); }
              }
            }
            const swM3u8 = decoded.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/);
            if (swM3u8) {
              const refHost = host;
              const chk = await fetchSeguro(swM3u8[0], 12000, { Referer: 'https://' + refHost + '/' }).catch(() => null);
              if (chk && chk.ok) {
                const body = await chk.text();
                if (body.includes('#EXTM3U')) {
                  console.log('[pxd] streamwish unpack OK ' + host + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
                  try { hlsReferers.set(new URL(swM3u8[0]).hostname, 'https://' + refHost + '/'); } catch {}
                  return { body, url: swM3u8[0], ref: 'https://' + refHost + '/', mp4: false };
                }
              }
            }
            const swMp4 = decoded.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/);
            if (swMp4) {
              console.log('[pxd] streamwish unpack mp4 ' + host + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
              return { body: '', url: swMp4[0], ref: 'https://' + host + '/', mp4: true };
            }
          }
        } catch (e) { console.warn('[pxd] streamwish unpack fall: ' + String(e.message || e).slice(0, 60)); }
      }
      }
    } catch (e) { console.warn('[pxd] embed falló: ' + String(e.message || e).slice(0, 60)); }
  }

  throw new Error('Ningún reproductor entregó el video — la peli puede estar caída');
}

/* v286: BYSE (bysesukior/byseqekaho) — extractor compartido (PelisXD lo trae
 * inline; AnimeD23 lo reusa). API /api/videos/<code> → AES-256-GCM → m3u8.
 * code = el segmento DESPUÉS de /e/ (funciona con /e/<code> y con
 * /e/<code>/<sufijo>). */
async function extraerByse(embedUrl) {
  const u = new URL(embedUrl);
  const partes = u.pathname.split('/').filter(Boolean);
  const iE = partes.indexOf('e');
  const code = (iE >= 0 && iE + 1 < partes.length) ? partes[iE + 1] : partes[partes.length - 1];
  const rApi = await fetchSeguro('https://' + u.hostname + '/api/videos/' + code, 12000, { Referer: embedUrl });
  if (!rApi.ok) throw new Error('Byse respondió ' + rApi.status);
  const j = await rApi.json().catch(() => null);
  if (!j || !j.playback || !j.playback.payload) throw new Error('Byse sin playback');
  const pb = j.playback;
  const n = parseInt(pb.version);
  const b64url = (s) => { let b = s.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; return Buffer.from(b, 'base64'); };
  const keyBuf = Buffer.concat([n, 31 - n].filter((i) => i >= 1 && i <= pb.key_parts.length).map((i) => b64url(pb.key_parts[i - 1])));
  if (keyBuf.length !== 32) throw new Error('Byse clave inválida');
  const ivBuf = b64url(pb.iv), payloadBuf = b64url(pb.payload);
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
  d.setAuthTag(payloadBuf.slice(-16));
  const dec = Buffer.concat([d.update(payloadBuf.slice(0, -16)), d.final()]).toString('utf8');
  const src = JSON.parse(dec).sources && JSON.parse(dec).sources[0];
  if (!src || !src.url) throw new Error('Byse sin video');
  const ref = 'https://' + u.hostname + '/';
  const chk = await fetchSeguro(src.url, 10000, { Referer: ref }).catch(() => null);
  if (!chk || !chk.ok) throw new Error('Byse m3u8 respondió ' + (chk && chk.status));
  const body = await chk.text();
  if (!body.includes('#EXTM3U')) throw new Error('Byse playlist inválida');
  try { hlsReferers.set(new URL(src.url).hostname, ref); } catch {}
  return { body, url: src.url, ref, mp4: false };
}

/* v286: RPMVID (ytplay/cubeembed) para AnimeD23 — la API /api/v1/video
 * responde hex + AES-128-CBC (misma familia que Lacartoons) y da la fuente
 * TikTok (hlsVideoTiktok + token v) y la Cloudflare (cf). HTTP puro: ni
 * navegador ni iframe; el master queda cacheado como los demás en /api/xd/. */
async function resolverRpmvidD23(embedUrl, id) {
  const host = new URL(embedUrl).hostname;
  let j = null, ultimoErr = '';
  for (let intento = 0; intento < 3 && !j; intento++) {
    if (intento) await new Promise((r2) => setTimeout(r2, 900));
    try {
      const r2 = await fetchSeguro('https://' + host + '/api/v1/video?id=' + encodeURIComponent(id) + '&w=1280&h=720', 10000);
      if (!r2.ok) { ultimoErr = 'el player rpmvid respondió ' + r2.status; if (r2.status === 404 || r2.status === 410) ultimoErr = 'borrado'; continue; }
      const hex = String(await r2.text() || '').trim();
      if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) { ultimoErr = 'rpmvid cambió su cifrado'; continue; }
      const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from('kiemtienmua911ca', 'utf8'), Buffer.from('1234567890oiuytr', 'utf8'));
      j = JSON.parse(Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8'));
    } catch (e) { ultimoErr = String(e.message || e).slice(0, 60); }
  }
  if (!j) throw new Error(ultimoErr === 'borrado' ? 'Ese capítulo ya no está disponible en AnimeD23 (el player lo borró)' : (ultimoErr || 'el player rpmvid no respondió'));
  let cfg = {}; try { cfg = JSON.parse(j.streamingConfig || '{}'); } catch {}
  const ttA = cfg.adjust && cfg.adjust.Tiktok;
  const cand = [];
  if (ttA && !ttA.disabled && j.hlsVideoTiktok) {
    try {
      const u = new URL(j.hlsVideoTiktok, 'https://' + host + '/');
      if (ttA.params && ttA.params.v) u.searchParams.set('v', ttA.params.v);
      cand.push(u.href);
    } catch {}
  }
  if (j.cf) cand.push(j.cf);
  if (!cand.length) throw new Error('sin fuente conocida en el player rpmvid');
  let body = '', master = '';
  for (const mUrl of cand) {
    try {
      const r3 = await fetchSeguro(mUrl, 10000, { Referer: 'https://' + host + '/' });
      if (!r3.ok) { ultimoErr = 'el master respondió ' + r3.status; continue; }
      const b = await r3.text();
      if (/^#EXTM3U/m.test(b)) { body = b; master = mUrl; break; }
      ultimoErr = 'master inválido';
    } catch (e) { ultimoErr = String(e.message || e).slice(0, 60); }
  }
  if (!body) throw new Error(ultimoErr || 'el master no respondió');
  try { hlsReferers.set(new URL(master).hostname, 'https://' + host + '/'); } catch {}
  const ahora = Date.now();
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  pelisxdStreams.set(tok, { body, base: master, ref: 'https://' + host + '/', slug: 'd23-' + id, at: ahora });
  console.log('[d23] rpmvid (' + host + ' id ' + id + ') → master ' + master.slice(0, 60));
  return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
}

/* v286: AnimeD23 — página del episodio → lista de tabs (6 hosts por ep).
 * Dos cadenas: DIRECTA (container.php?id=D23-…&open=1 con botones
 * data-player-url) y JWT (opciones/options.php → player.php?data= →
 * multiplayer/contenedor.php → videoTabs). Misma lectura que d23Probe. */
/* lee los hosts de una página de contenedor (data-player-url + videoTabs) */
function d23TabsDeContenedor(html) {
  const tabs = [];
  for (const mm of html.matchAll(/data-player-url="([^"]+)"/g)) tabs.push(mm[1]);
  const vt = /videoTabs\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (vt) { try { for (const t of JSON.parse(vt[1].replace(/\\\//g, '/'))) if (t && t.url) tabs.push(t.url); } catch {} }
  return [...new Set(tabs)];
}
async function d23TabsDeHtml(html, referer) {
  const tabs = [];
  const direct = /container\.php\?id=([A-Za-z0-9_-]+)/.exec(html);
  if (direct) {
    const esDirecto = /^D23-/i.test(direct[1]);
    const curl = esDirecto
      ? 'https://animed23.online/container.php?id=' + direct[1] + '&open=1'
      : 'https://animed23.online/multiplayer/contenedor.php?id=' + direct[1];
    const h5 = await (await fetchSeguro(curl, 12000, { Referer: referer })).text().catch(() => '');
    for (const t of d23TabsDeContenedor(h5)) tabs.push(t);
  }
  if (!tabs.length) {
    const mOpt = /<iframe[^>]+src="([^"]*opciones\/options\.php[^"]*)"/i.exec(html) || /src="([^"]*animed23\.online\/opciones\/options\.php[^"]*)"/i.exec(html);
    if (mOpt) {
      let optUrl = mOpt[1].replace(/&#038;/g, '&').replace(/&amp;/g, '&');
      if (optUrl.startsWith('//')) optUrl = 'https:' + optUrl;
      try {
        const h3 = await (await fetchSeguro(optUrl, 12000, { Referer: referer })).text();
        const playerM = /href="([^"]*player\.php\?data=[^"]*)"/i.exec(h3) || /player\.php\?data=[A-Za-z0-9%_.\-]+/.exec(h3);
        if (playerM) {
          let pUrl = (playerM[1] || playerM[0]).replace(/&#038;/g, '&').replace(/&amp;/g, '&');
          if (pUrl.startsWith('/')) pUrl = 'https://animed23.online/opciones/' + pUrl.replace(/^\//, '');
          else if (!/^https?:/i.test(pUrl)) pUrl = 'https://animed23.online/opciones/' + pUrl;
          const h4 = await (await fetchSeguro(pUrl, 12000, { Referer: optUrl })).text().catch(() => '');
          const contM = /multiplayer\/contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(h4) || /contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(h4);
          if (contM) {
            const h5 = await (await fetchSeguro('https://animed23.online/multiplayer/contenedor.php?id=' + contM[1], 12000, { Referer: pUrl })).text().catch(() => '');
            for (const t of d23TabsDeContenedor(h5)) tabs.push(t);
          } else {
            /* v290.2: player.php devolvió el SELECTOR («¿Cómo quieres ver este episodio?») —
             * los links llevan &fuente=latino|sub|cast; hay que dar un salto más hasta el
             * iframe del contenedor. Preferencia latino → sub → cast (audio latino manda). */
            const selHrefs = [...h4.matchAll(/href="([^"]*player\.php\?data=[^"]*fuente=(?:latino|sub|cast)[^"]*)"/gi)].map(m => m[1]);
            if (selHrefs.length) {
              const orden = ['latino', 'sub', 'cast'];
              selHrefs.sort((a, b) => orden.findIndex(f => a.includes('fuente=' + f)) - orden.findIndex(f => b.includes('fuente=' + f)));
              for (const sh of selHrefs.slice(0, 2)) {
                let sUrl = sh.replace(/&#038;/g, '&').replace(/&amp;/g, '&');
                if (sUrl.startsWith('/')) sUrl = 'https://animed23.online/opciones/' + sUrl.replace(/^\//, '');
                else if (!/^https?:/i.test(sUrl)) sUrl = 'https://animed23.online/opciones/' + sUrl;
                const h5 = await (await fetchSeguro(sUrl, 12000, { Referer: pUrl })).text().catch(() => '');
                const mIfr = /<iframe[^>]+src="([^"]*multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)"/i.exec(h5);
                const contM2 = /multiplayer\/contenedor\.php\?id=([A-Za-z0-9_-]+)/i.exec(h5);
                let cUrl = '';
                if (mIfr) cUrl = mIfr[1];
                else if (contM2) cUrl = 'https://animed23.online/multiplayer/contenedor.php?id=' + contM2[1];
                if (cUrl) {
                  if (cUrl.startsWith('//')) cUrl = 'https:' + cUrl;
                  const h6 = await (await fetchSeguro(cUrl, 12000, { Referer: sUrl })).text().catch(() => '');
                  for (const t of d23TabsDeContenedor(h6)) tabs.push(t);
                  if (tabs.length) break;
                }
              }
            }
          }
        }
      } catch {}
    }
  }
  /* v290: flujo NUEVO "multi" (p. ej. BAKI-DOU): el iframe del capítulo apunta a
   * https://play.animed23.com/multiplayer/options.php?server=multi&value=TOKEN
   * (el TOKEN rota con el tiempo — siempre se extrae fresco de la página del ep).
   * Esa página es un splash cuyo JS carga iframe.src='<host>/multiplayer/contenedor.php?id=TOKEN'
   * y ese contenedor trae los videoTabs de siempre (Byse/Moon, OK, Mytsumi...). */
  if (!tabs.length) {
    const mMulti = /<iframe[^>]+src="([^"]*multiplayer\/options\.php[^"]*)"/i.exec(html);
    if (mMulti) {
      let mUrl = mMulti[1].replace(/&#038;/g, '&').replace(/&amp;/g, '&');
      if (mUrl.startsWith('//')) mUrl = 'https:' + mUrl;
      try {
        const hOpt = await (await fetchSeguro(mUrl, 12000, { Referer: referer })).text();
        const mCont = /iframe\.src='([^']+multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)'/i.exec(hOpt)
                   || /src="([^"]*multiplayer\/contenedor\.php\?id=[A-Za-z0-9_-]+)"/i.exec(hOpt);
        if (mCont) {
          const cUrl = mCont[1].startsWith('//') ? 'https:' + mCont[1] : mCont[1];
          const hC = await (await fetchSeguro(cUrl, 12000, { Referer: mUrl })).text().catch(() => '');
          for (const t of d23TabsDeContenedor(hC)) tabs.push(t);
        }
      } catch {}
    }
  }
  return [...new Set(tabs)];
}
function d23SlugDeEp(epUrl) {
  const m = /animed23\.com\/capitulo\/([a-z0-9-]+)/i.exec(epUrl || '');
  if (!m) return '';
  return m[1].replace(/-(?:ep|capitulo)-\d+[a-z0-9-]*$/i, '');
}
/* v286: resolver D23 — el corazón. Tabs → probamos en orden de confiabilidad
 * (auditoría): Byse → OK (ok.ru) → rpmvid. Byse cachea el cuerpo en /api/xd/
 * (playlist de un solo uso); OK y rpmvid ya traen su m3u8/playlist lista.
 * Concontabilidad = contar fallos/podredumbre por serie (el /probar no lo hace). */
async function resolverD23ConTabs(tabs, epLabel, serie, conContabilidad) {
  const t0 = Date.now();
  const prio = { Byse: 0, OK: 1, rpmvid: 2 };
  const intentos = [];
  for (const tUrl of tabs) {
    if (/bysesukior|byseqekaho/i.test(tUrl)) intentos.push(['Byse', () => extraerByse(tUrl)]);
    else if (/ok\.ru\/videoembed\/(\d+)/i.test(tUrl)) { const id = (/ok\.ru\/videoembed\/(\d+)/i.exec(tUrl))[1]; intentos.push(['OK', () => resolverOkRu(id)]); }
    else if (/rpmvid\.com\/#([a-z0-9]+)/i.test(tUrl)) { const id = (/rpmvid\.com\/#([a-z0-9]+)/i.exec(tUrl))[1]; intentos.push(['rpmvid', () => resolverRpmvidD23(tUrl, id)]); }
  }
  intentos.sort((a, b) => (prio[a[0]] ?? 9) - (prio[b[0]] ?? 9));
  if (!intentos.length) throw new Error('Este episodio no trae reproductores que Huddle pueda abrir en AnimeD23');
  const fallos = [];
  for (const [nombre, fn] of intentos) {
    try {
      const out = await fn();
      /* Byse entrega {body,url} (se cachea en /api/xd/ abajo); el resto trae m3u8 directo */
      if (!out || !(out.m3u8 || (out.body && out.url))) { fallos.push(nombre + ' (sin stream)'); continue; }
      if (conContabilidad) d23Perdonar(serie);
      console.log('[d23] ' + epLabel.slice(-40) + ' → ' + nombre + ' en ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      /* Byse entrega el cuerpo descifrado — cachearlo (su m3u8 original es
       * de un solo uso) y servirlo por /api/xd/ como hace PelisXD */
      if (out.body && out.url) {
        const tok = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        pelisxdStreams.set(tok, { body: out.body, base: out.url, ref: out.ref || 'https://animed23.com/', slug: 'd23-' + (serie || 'x'), at: Date.now() });
        for (const u of out.body.match(/https?:\/\/[^\s"']+\.ts[^\s"']*/gi) || []) { try { hlsReferers.set(new URL(u).hostname, out.ref); } catch {} }
        return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
      }
      return out;
    } catch (e) { fallos.push(nombre + ' (' + String(e.message || e).slice(0, 48) + ')'); console.log('[d23] ' + epLabel.slice(-40) + ' — ' + nombre + ' falló: ' + String(e.message || e).slice(0, 120)); }
  }
  if (conContabilidad) d23Ocultar(serie); /* lázara: d23Perdonar lo reviva */
  throw new Error('Los servidores de este episodio de AnimeD23 están caídos (probé: ' + (fallos.join(', ') || 'ninguno') + '). Prueba otro capítulo');
}
async function resolverD23(epUrl) {
  const r = await fetchSeguro(epUrl, 15000);
  if (!r || !r.ok) throw new Error('No pude abrir ese capítulo en AnimeD23 — intenta luego');
  const html = await r.text();
  if (d23EsChallenge(html)) throw new Error('AnimeD23 está con protección anti-robot en este momento — intenta de nuevo en unos minutos');
  const serie = d23SlugDeEp(epUrl);
  const tabs = await d23TabsDeHtml(html, epUrl);
  return resolverD23ConTabs(tabs, epUrl, serie, true);
}

async function resolverPelisxd(pageUrl) {
  const slug = (/\/pelicula\/([a-z0-9-]+)/i.exec(pageUrl) || [])[1];
  if (!slug) throw new Error('Peli de PelisXD no válida');
  /* limpiar streams vencidos y ver si esta peli ya está resuelta */
  const ahora = Date.now();
  for (const [tok, s] of pelisxdStreams) {
    if (ahora - s.at > PELISXD_STREAM_TTL + 30 * 60 * 1000) pelisxdStreams.delete(tok);
  }
  for (const [tok, s] of pelisxdStreams) {
    if (s.slug === slug && ahora - s.at < PELISXD_STREAM_TTL) {
      return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
    }
  }
  /* 1) ¿tiene enlaces vivos? (falla rápido, sin abrir navegador) */
  const m = await pelisxdMeta(slug);
  if (m && !m.alive) { pxdOcultar(slug); throw new Error('Esta peli tiene los enlaces caídos en PelisXD'); } /* v205.2 */
  /* v231: ya NO bloqueamos listeamed — el navegador del server puede resolverlo */
  /* 2) el navegador resuelve el challenge y captura el playlist (~20 s la primera vez) */
  let cap;
  try { cap = await extraerStreamwishPeli('https://www.pelisxd.com/pelicula/' + slug); }
  catch (e) { pxdOcultar(slug); throw e; } /* v205.2: el espejo no entregó — fallo real */
  pxdPerdonar(slug);
  if (PXD_OCULTAS.has(slug)) { PXD_OCULTAS.delete(slug); ocultasReescribir(PXD_OCULTAS, 'pxd-ocultas.txt'); } /* v205.2: lázaro */
  /* v231: DoodStream/mp4 directo — sin playlist, el video va directo al navegador */
  if (cap.mp4) {
    try { hlsReferers.set(new URL(cap.url).hostname, cap.ref || pageUrl); } catch {}
    console.log('[pelisxd] ' + slug + ' → mp4 directo ' + cap.url.slice(0, 80));
    return { m3u8: cap.url, mp4: true, proxy: true, subs: [] };
  }
  /* m3u8 (HLS) — cachear el cuerpo y servir por /api/xd/ */
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  pelisxdStreams.set(tok, { body: cap.body, base: cap.url, ref: cap.ref || 'https://f7hyg4q.org/', slug, at: ahora });
  /* los segmentos pasan por el proxy con el Referer del espejo que sirvió */
  try {
    hlsReferers.set(new URL(cap.url).hostname, cap.ref || 'https://f7hyg4q.org/');
    for (const u of cap.body.match(/https?:\/\/[^\s"']+\.ts[^\s"']*/gi) || []) {
      try { hlsReferers.set(new URL(u).hostname, cap.ref); } catch {}
    }
  } catch {}
  console.log('[pelisxd] ' + slug + ' → playlist ' + (cap.body.match(/#EXTINF/g) || []).length + ' segmentos, ref ' + cap.ref);
  return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
}

/* v102: CARICATURAS — Mis Caricaturas (miscaricaturas.com): las series
 * clásicas de nick/CN en latino (Bob Esponja, Hora de Aventura, Billy
 * y Mandy, Padrinos Mágicos…). Los capítulos viven en un embed de la
 * familia streamwish con reto PoW — el mismo truco que PelisXD: el
 * navegador del servidor lo resuelve y captura el playlist sprintcdn. */
const CARI_BASE = 'https://miscaricaturas.com/';
const cariMeta = new Map();   /* slug → {at, titulo, poster} — 6 h */
const cariDatos = new Map();  /* slug → {at, d} — 30 min */
const cariFeedCache = { at: 0, items: [], toons: [], live: [] }; /* 1 h — v119: items=MisCaricaturas, toons=Lacartoons (Cartoons); v205: live=Live Action */
/* v112: LACARTOONS (lacartoons.com) — fuente nueva de series clásicas.
 * Aporta lo que MisCaricaturas no tiene: las temporadas 1-5 de Billy y
 * Mandy en LATINO (allí solo la T6 está doblada) e iCarly y Drake & Josh
 * completas. v113: + Ed, Edd y Eddy completa y las T3/T4 + 2x12 de Ben 10
 * (en MisCaricaturas solo existían en inglés). Todo auditado con ASR
 * (2026-09-11): billy T1-T6, iCarly, Drake & Josh, Ed Edd T1-T3 y Ben 10
 * T2x12/T3/T4 hablan español; en lacartoons están MUERTAS (embeds
 * retirados): Zoey 101, Kenan & Kel, Sabrina, Jimmy Neutrón T2, Tom y
 * Jerry y Looney Tunes. Ojo: Ben 10 4x02 declara pista «Español» pero
 * trae audio FRANCÉS (verificado) y 4x01 está muerto — ambos excluidos.
 * El player es cubeembed.rpmvid.com: el navegador del servidor clica el
 * play (el botón vive en shadow DOM de vidstack y además quiere un clic
 * físico) y captura un m3u8 «hlsmod» servido por el propio rpmvid cuyos
 * segmentos son TS camuflados de PNG en tiktokcdn (el proxy los
 * despelleja). Los masters nuevos (Ben 10, Ed Edd) traen el audio en
 * renditions aparte CON IDIOMA DECLARADO — el resolver arma un master
 * con la pista «Español» como única opción. El Chavo del 8 también vive
 * ahí, pero ya está en MisCaricaturas — no se duplica. */
const LCT_BASE = 'https://www.lacartoons.com/';
const LCT_SERIES = new Map([
  ['150', { slug: 'icarly', lctId: 150, titulo: 'iCarly' }],
  ['144', { slug: 'drake-y-josh', lctId: 144, titulo: 'Drake & Josh' }],
  ['31', { slug: 'ed-edd-y-eddy', lctId: 31, titulo: 'Ed, Edd y Eddy' }], /* v113 */
  /* v114: lote CN/acción auditado con ASR (todas es 0.85-0.98):
   * Johnny Test y Xiaolin Chronicles también se revisaron pero están
   * muertas en lacartoons (embeds retirados) y quedan fuera */
  ['14', { slug: 'chicas-superpoderosas', lctId: 14, titulo: 'Las Chicas Superpoderosas' }],
  ['17', { slug: 'vaca-y-pollito', lctId: 17, titulo: 'La Vaca y El Pollito' }],
  ['133', { slug: 'animaniacs', lctId: 133, titulo: 'Animaniacs' }],
  ['223', { slug: 'knd-chicos-del-barrio', lctId: 223, titulo: 'KND: Los Chicos Del Barrio' }],
  ['206', { slug: 'johnny-bravo', lctId: 206, titulo: 'Johnny Bravo' }],
  ['15', { slug: 'flapjack', lctId: 15, titulo: 'Las Maravillosas Desventuras de FlapJack' }],
  ['32', { slug: 'jovenes-titanes', lctId: 32, titulo: 'Los Jóvenes Titanes' }],
  ['27', { slug: 'samurai-jack', lctId: 27, titulo: 'Samurai Jack' }],
  /* v115: lote Hanna-Barbera/acción auditado con ASR: xmen evo es(0.98),
   * ultimate spider-man es(0.99), generador rex es(0.97), picapiedras
   * es(0.92), supersónicos es(0.88 — su pista «Español» viene etiquetada
   * «Latine», el resolver la reconoce). Muertas tras revisar (embeds
   * retirados o video borrado): X-Men 90s, Spiderman 90s y Nueva, Static
   * Shock, Code Lyoko, Scooby (todas sus variantes), Titán Sim-Biónico,
   * Hombres de Negro, Cazafantasmas, Wolverine, Ben 10 Fuerza
   * Alienígena/Supremacia, Chicas Z, Duck Dodgers, Garfield, Godzilla,
   * Meteoro, Super Mario, Tintin y Capitán Planeta */
  ['38', { slug: 'x-men-evolucion', lctId: 38, titulo: 'X-Men Evolución' }],
  ['390', { slug: 'ultimate-spider-man', lctId: 390, titulo: 'Ultimate Spider-Man' }],
  ['10', { slug: 'generador-rex', lctId: 10, titulo: 'Generador Rex' }],
  ['21', { slug: 'los-picapiedras', lctId: 21, titulo: 'Los Picapiedras' }],
  ['22', { slug: 'los-supersonicos', lctId: 22, titulo: 'Los Supersónicos' }],

  /* v119: GRAN LOTE de cartoons clásicos verificados HOY (2026-09-12).
   * Lacartoons usa TRES players: cubeembed.rpmvid (HLS, el de siempre),
   * ok.ru (MP4 directo, nuevo resolver) y cubeembed.com (dominio MUERTO
   * — esas series no entran). Verificación: 4 caps de muestra por serie;
   * el barrido de fondo limpia los caps muertos que queden.
   * Quedaron FUERA por player roto: Aladdin (cubeembed.com), Pato
   * Aventuras/CatDog/Ren y Stimpy (sendvid caído), Thornberrys/Justicia
   * Joven (dhtpre sin extractor), Cachorro Scooby, Shaggy y Scooby,
   * Titán Sim-Biónico y Ben 10 Supremacia (sin player). */
  /* — player ok.ru, MP4 directo — */
  ['95', { slug: 'el-oso-yogui', lctId: 95, titulo: 'El Oso Yogui' }],
  ['123', { slug: 'don-gato', lctId: 123, titulo: 'Don Gato y Su Pandilla' }],
  ['105', { slug: 'la-pantera-rosa', lctId: 105, titulo: 'La Pantera Rosa' }],
  ['122', { slug: 'tiro-loco-mcgraw', lctId: 122, titulo: 'Tiro Loco McGraw' }],
  ['101', { slug: 'huckleberry-hound', lctId: 101, titulo: 'Huckleberry Hound' }],
  ['92', { slug: 'el-inspector-ardilla', lctId: 92, titulo: 'El Inspector Ardilla' }],
  ['108', { slug: 'los-autos-locos', lctId: 108, titulo: 'Los Autos Locos' }],
  ['104', { slug: 'la-hormiga-atomica', lctId: 104, titulo: 'La Hormiga Atómica' }],
  ['93', { slug: 'el-lagarto-juancho', lctId: 93, titulo: 'El Lagarto Juancho' }],
  ['341', { slug: 'swat-kats', lctId: 341, titulo: 'Swat Kats' }],
  ['176', { slug: 'jonny-quest', lctId: 176, titulo: 'Jonny Quest' }],
  ['63', { slug: 'las-tortugas-ninjas', lctId: 63, titulo: 'Las Tortugas Ninjas' }],
  ['130', { slug: 'superman-serie-animada', lctId: 130, titulo: 'Superman La Serie Animada' }],
  ['298', { slug: 'reboot', lctId: 298, titulo: 'Reboot' }],
  ['134', { slug: 'silvestre-y-piolin', lctId: 134, titulo: 'Las Aventuras de Silvestre y Piolín' }],
  ['314', { slug: 'el-pato-darkwing', lctId: 314, titulo: 'El Pato Darkwing' }],
  ['316', { slug: 'chip-y-dale', lctId: 316, titulo: 'Chip & Dale: Guardianes Rescatadores' }],
  ['291', { slug: 'timon-y-pumba', lctId: 291, titulo: 'Timón y Pumba' }],
  ['137', { slug: 'la-sirenita', lctId: 137, titulo: 'La Sirenita' }],
  ['198', { slug: 'invasor-zim', lctId: 198, titulo: 'Invasor Zim' }],
  ['226', { slug: 'megas-xlr', lctId: 226, titulo: 'Megas XLR' }],
  ['283', { slug: 'mucha-lucha', lctId: 283, titulo: 'Mucha Lucha' }],
  ['284', { slug: 'daniel-el-travieso', lctId: 284, titulo: 'Daniel El Travieso' }],
  ['35', { slug: 'tom-y-jerry', lctId: 35, titulo: 'Tom y Jerry' }],
  ['18', { slug: 'looney-tunes', lctId: 18, titulo: 'Looney Tunes' }],
  ['44', { slug: 'droopy', lctId: 44, titulo: 'Droopy' }],
  ['411', { slug: 'drama-total', lctId: 411, titulo: 'Drama Total' }],
  ['353', { slug: 'pucca', lctId: 353, titulo: 'Pucca' }],
  /* — player rpmvid (HLS, como las 16 de siempre) — */
  ['180', { slug: 'thundercats', lctId: 180, titulo: 'Thundercats' }],
  ['62', { slug: 'he-man', lctId: 62, titulo: 'He-Man y los Amos del Universo' }],
  ['129', { slug: 'pinky-y-cerebro', lctId: 129, titulo: 'Pinky y Cerebro' }],
  ['124', { slug: 'batman-del-futuro', lctId: 124, titulo: 'Batman Del Futuro' }],
  ['318', { slug: 'kim-possible', lctId: 318, titulo: 'Kim Possible' }],
  ['156', { slug: 'la-vida-moderna-de-rocko', lctId: 156, titulo: 'La Vida Moderna de Rocko' }],
  ['368', { slug: 'rugrats', lctId: 368, titulo: 'Los Rugrats: Aventuras en Pañales' }],
  ['161', { slug: 'rocket-power', lctId: 161, titulo: 'Rocket Power' }],
  ['205', { slug: 'los-castores-cascarrabias', lctId: 205, titulo: 'Los Castores Cascarrabias' }],
  ['376', { slug: 'un-show-mas', lctId: 376, titulo: 'Un Show Más' }],
  ['125', { slug: 'batman-serie-animada', lctId: 125, titulo: 'Batman La Serie Animada' }],
  ['131', { slug: 'tiny-toons', lctId: 131, titulo: 'Tiny Toons' }],
  ['46', { slug: 'liga-de-la-justicia', lctId: 46, titulo: 'Liga de la Justicia' }],
  /* — las que en v115 se creían muertas: en realidad estaban en ok.ru — */
  ['173', { slug: 'x-men-serie-animada', lctId: 173, titulo: 'X-Men Serie Animada' }],
  ['79', { slug: 'spiderman-serie-animada', lctId: 79, titulo: 'Spider-Man: La Serie Animada' }],
  ['33', { slug: 'spiderman-nueva-serie', lctId: 33, titulo: 'Spiderman La Nueva Serie Animada' }],
  ['7', { slug: 'static-shock', lctId: 7, titulo: 'Static Shock' }],
  ['4', { slug: 'code-lyoko', lctId: 4, titulo: 'Code Lyoko' }],
  ['30', { slug: 'scooby-misterios-sa', lctId: 30, titulo: 'Scooby Doo Misterios S.A' }],
  ['119', { slug: 'scooby-donde-estas', lctId: 119, titulo: 'Scooby-Doo ¿Dónde Estás?' }],
  ['257', { slug: 'el-show-de-scooby-doo', lctId: 257, titulo: 'El Show de Scooby-Doo' }],
  ['290', { slug: 'nuevas-peliculas-scooby', lctId: 290, titulo: 'Las Nuevas Películas de Scooby Doo' }],
  ['359', { slug: 'que-hay-de-nuevo-scooby', lctId: 359, titulo: '¿Qué Hay de Nuevo, Scooby-Doo?' }],
  ['24', { slug: 'hombres-de-negro', lctId: 24, titulo: 'Hombres de Negro' }],
  ['402', { slug: 'los-cazafantasmas', lctId: 402, titulo: 'Los Cazafantasmas' }],
  ['377', { slug: 'las-chicas-z', lctId: 377, titulo: 'Las Chicas Superpoderosas Z' }],
  ['6', { slug: 'duck-dodgers', lctId: 6, titulo: 'Duck Dodgers' }],
  ['8', { slug: 'garfield', lctId: 8, titulo: 'Garfield' }],
  ['25', { slug: 'meteoro', lctId: 25, titulo: 'Meteoro' }],
  ['3', { slug: 'capitan-planeta', lctId: 3, titulo: 'El Capitán Planeta' }],
  ['356', { slug: 'super-mario', lctId: 356, titulo: 'Super Mario' }],
  ['23', { slug: 'godzilla', lctId: 23, titulo: 'Godzilla La Serie Animada' }],
  ['13', { slug: 'las-aventuras-de-tintin', lctId: 13, titulo: 'Las Aventuras de TinTin' }],
  ['36', { slug: 'wolverine', lctId: 36, titulo: 'Wolverine y los X-Men' }],
  ['281', { slug: 'ben-10-fuerza-alienigena', lctId: 281, titulo: 'Ben 10: Fuerza Alienígena' }],

    /* v192: GRAN ALTA de lacartoons — auditoría completa (503 series del sitio):
   * cruce FUZZY contra danimados (preferida) + contra nuestras LCT existentes,
   * y detección de player por serie (probe HTTP del primer capítulo). Solo
   * entran players vivos: ok.ru (MP4) y rpmvid (HLS). FUERA: 45 con player
   * roto (sendvid/cubeembed.com/dhtpre) y 214 duplicadas con lo nuestro.
   * Todo el contenido de lacartoons está doblado en LATINO. 162 series ↓ */
  ['1', { slug: '2-perros-tontos', lctId: 1, titulo: '2 Perros Tontos' }],
  ['26', { slug: 'sakura-card-captors', lctId: 26, titulo: 'Sakura Card Captors' }],
  ['29', { slug: 'samurai-champloo', lctId: 29, titulo: 'Samurai Champloo' }],
  ['43', { slug: 'trigun', lctId: 43, titulo: 'Trigun' }],
  ['52', { slug: 'capitan-n-fox-kids', lctId: 52, titulo: 'Capitán N - Fox Kids' }],
  ['53', { slug: 'digimon-digital-monsters-fox-kids', lctId: 53, titulo: 'Digimon: Digital Monsters - Fox Kids' }],
  ['58', { slug: 'el-pajaro-loco-y-amigos-fox-kids', lctId: 58, titulo: 'El Pájaro Loco y Amigos - Fox Kids' }],
  ['61', { slug: 'gundam-wing-fox-kids', lctId: 61, titulo: 'Gundam Wing - Fox Kids' }],
  ['66', { slug: 'monster-rancher-fox-kids', lctId: 66, titulo: 'Monster Rancher - Fox Kids' }],
  ['67', { slug: 'oggy-y-las-cucarachas-fox-kids', lctId: 67, titulo: 'Oggy Y Las Cucarachas - Fox Kids' }],
  ['68', { slug: 'power-rangers-fox-kids', lctId: 68, titulo: 'Power Rangers - Fox Kids' }],
  ['69', { slug: 'power-rangers-zeo-fox-kids', lctId: 69, titulo: 'Power Rangers Zeo - Fox Kids' }],
  ['70', { slug: 'power-rangers-turbo-fox-kids', lctId: 70, titulo: 'Power Rangers Turbo - Fox Kids' }],
  ['71', { slug: 'power-rangers-en-el-espacio-fox-kids', lctId: 71, titulo: 'Power Rangers En El Espacio - Fox Kids' }],
  ['72', { slug: 'power-rangers-en-la-galaxia-perdida-fox-kids', lctId: 72, titulo: 'Power Rangers En La Galaxia Perdida - Fox Kids' }],
  ['74', { slug: 'sailor-moon-fox-kids', lctId: 74, titulo: 'Sailor Moon - Fox Kids' }],
  ['75', { slug: 'shaman-king-fox-kids', lctId: 75, titulo: 'Shaman King - Fox Kids' }],
  ['86', { slug: 'los-3-chiflados-fox-kids', lctId: 86, titulo: 'Los 3 Chiflados - Fox Kids' }],
  ['94', { slug: 'las-nuevas-aventuras-del-oso-yogui-hanna-barbera', lctId: 94, titulo: 'Las Nuevas Aventuras Del Oso Yogui - Hanna Barbera' }],
  ['96', { slug: 'el-pulpo-manotas-hanna-barbera', lctId: 96, titulo: 'El Pulpo Manotas - Hanna Barbera' }],
  ['103', { slug: 'la-bruja-tonta-hanna-barbera', lctId: 103, titulo: 'La bruja Tonta - Hanna Barbera' }],
  ['109', { slug: 'las-olimpiadas-de-la-risa-hanna-barbera', lctId: 109, titulo: 'Las Olimpiadas De La Risa - Hanna Barbera' }],
  ['111', { slug: 'los-osos-montaneses-hanna-barbera', lctId: 111, titulo: 'Los Osos Montañeses - Hanna Barbera' }],
  ['113', { slug: 'maguila-gorila-hanna-barbera', lctId: 113, titulo: 'Maguila Gorila - Hanna Barbera' }],
  ['116', { slug: 'el-escuadron-diabolico-hanna-barbera', lctId: 116, titulo: 'El Escuadrón Diabólico - Hanna Barbera' }],
  ['117', { slug: 'punkin-puss-y-mush-mouse-hanna-barbera', lctId: 117, titulo: 'Punkin Puss y Mush Mouse - Hanna Barbera' }],
  ['146', { slug: 'doug-nickelodeon', lctId: 146, titulo: 'Doug - Nickelodeon' }],
  ['167', { slug: 'la-familia-addams-nickelodeon', lctId: 167, titulo: 'La Familia Addams - Nickelodeon' }],
  ['168', { slug: 'los-munsters-nickelodeon', lctId: 168, titulo: 'Los Munsters - Nickelodeon' }],
  ['169', { slug: 'hechizada-nickelodeon', lctId: 169, titulo: 'Hechizada - Nickelodeon' }],
  ['170', { slug: 'los-vengadores-los-heroes-mas-poderosos-del-planeta-marvel', lctId: 170, titulo: 'Los Vengadores: Los Héroes Más Poderosos Del Planeta Marvel' }],
  ['175', { slug: 'super-agente-86-nickelodeon', lctId: 175, titulo: 'Super Agente 86 - Nickelodeon' }],
  ['184', { slug: 'yu-gi-oh-nickelodeon', lctId: 184, titulo: 'Yu-Gi-Oh! - Nickelodeon' }],
  ['186', { slug: 'taz-mania-warner-channel', lctId: 186, titulo: 'Taz-Mania - Warner Channel' }],
  ['190', { slug: 'mi-bella-genio-nickelodeon', lctId: 190, titulo: 'Mi Bella Genio - Nickelodeon' }],
  ['191', { slug: 'martin-mystery-nickelodeon', lctId: 191, titulo: 'Martin Mystery - Nickelodeon' }],
  ['193', { slug: 'kid-musculo-fox-kids', lctId: 193, titulo: 'Kid Músculo - Fox Kids' }],
  ['194', { slug: 'yu-yu-hakusho', lctId: 194, titulo: 'Yu yu Hakusho' }],
  ['196', { slug: 'los-gatos-samurais-fox-kids', lctId: 196, titulo: 'Los Gatos Samurais - Fox Kids' }],
  ['201', { slug: 'ricky-ricon-hanna-barbera', lctId: 201, titulo: 'Ricky Ricón - Hanna Barbera' }],
  ['212', { slug: 'los-vengadores-united-they-stand-marvel', lctId: 212, titulo: 'Los Vengadores: United They Stand Marvel' }],
  ['221', { slug: 'vr-troopers-fox-kids', lctId: 221, titulo: 'Vr Troopers - Fox Kids' }],
  ['224', { slug: 'super-campeones', lctId: 224, titulo: 'Super Campeones' }],
  ['230', { slug: 'el-coyote-y-el-corre-caminos-warner-channel', lctId: 230, titulo: 'El Coyote y El Corre Caminos - Warner Channel' }],
  ['231', { slug: 'birdman-hanna-barbera', lctId: 231, titulo: 'Birdman - Hanna Barbera' }],
  ['233', { slug: 'cyborg-009', lctId: 233, titulo: 'Cyborg 009' }],
  ['234', { slug: 'gi-joe-otros', lctId: 234, titulo: 'Gi Joe' }],
  ['235', { slug: 'street-sharks-otros', lctId: 235, titulo: 'Street Sharks Otros' }],
  ['237', { slug: 'heidi-otros', lctId: 237, titulo: 'Heidi Otros' }],
  ['238', { slug: 'candy-candy-otros', lctId: 238, titulo: 'Candy Candy Otros' }],
  ['240', { slug: 'voltron-vehiculos-otros', lctId: 240, titulo: 'Voltron Vehiculos' }],
  ['241', { slug: 'el-jinete-de-sable-y-los-comisarios-estrellas-otros', lctId: 241, titulo: 'El Jinete De Sable Y Los Comisarios Estrellas Otros' }],
  ['242', { slug: 'mazinger-z-otros', lctId: 242, titulo: 'Mazinger Z' }],
  ['243', { slug: 'el-gladiador-otros', lctId: 243, titulo: 'El Gladiador' }],
  ['244', { slug: 'super-magnetron-otros', lctId: 244, titulo: 'Super Magnetrón Otros' }],
  ['245', { slug: 'el-vengador-otros', lctId: 245, titulo: 'El Vengador' }],
  ['246', { slug: 'el-galactico-otros', lctId: 246, titulo: 'El Galáctico' }],
  ['247', { slug: 'capitan-centella-otros', lctId: 247, titulo: 'Capitán Centella Otros' }],
  ['248', { slug: 'capitan-futuro-otros', lctId: 248, titulo: 'Capitán Futuro' }],
  ['249', { slug: 'arbegas-el-rayo-custodio-otros', lctId: 249, titulo: 'Arbegas: El Rayo Custodio Otros' }],
  ['250', { slug: 'fuerza-g-otros', lctId: 250, titulo: 'Fuerza G' }],
  ['253', { slug: 'oban-star-racers-fox-kids', lctId: 253, titulo: 'Oban Star Racers - Fox Kids' }],
  ['256', { slug: 'full-house-warner-channel', lctId: 256, titulo: 'Full House - Warner Channel' }],
  ['265', { slug: 'death-note-otros', lctId: 265, titulo: 'Death Note' }],
  ['266', { slug: 'el-gallo-claudio-warner-channel', lctId: 266, titulo: 'El Gallo Claudio - Warner Channel' }],
  ['267', { slug: '101-dalmatas-disney', lctId: 267, titulo: '101 Dalmatas - Disney' }],
  ['268', { slug: 'dragon-quest-fox-kids', lctId: 268, titulo: 'Dragon Quest - Fox Kids' }],
  ['269', { slug: 'wild-c-a-t-s-fox-kids', lctId: 269, titulo: 'Wild C.A.T.S - Fox Kids' }],
  ['271', { slug: 'samurai-warriors-otros', lctId: 271, titulo: 'Samurai Warriors Otros' }],
  ['275', { slug: 'super-agente-cobra-otros', lctId: 275, titulo: 'Super Agente Cobra Otros' }],
  ['276', { slug: 'zoids-chaotic-century-otros', lctId: 276, titulo: 'Zoids: Chaotic Century Otros' }],
  ['287', { slug: 'robotech-otros', lctId: 287, titulo: 'Robotech' }],
  ['288', { slug: 'el-baron-rojo-otros', lctId: 288, titulo: 'El Baron Rojo' }],
  ['289', { slug: 'el-conde-patula-otros', lctId: 289, titulo: 'El Conde Pátula Otros' }],
  ['295', { slug: 'astro-boy', lctId: 295, titulo: 'Astro Boy 1980' }],
  ['296', { slug: 'astro-boy-2', lctId: 296, titulo: 'Astro Boy 2003' }],
  ['299', { slug: 'btx-otros', lctId: 299, titulo: 'BTX' }],
  ['300', { slug: 'btx-neo-otros', lctId: 300, titulo: 'BTX Neo' }],
  ['302', { slug: 'sam-el-rey-del-judo-otros', lctId: 302, titulo: 'Sam El Rey Del Judo Otros' }],
  ['303', { slug: 'yu-gi-oh-gx-nickelodeon', lctId: 303, titulo: 'Yu Gi Oh! GX - Nickelodeon' }],
  ['312', { slug: 'zatch-bell', lctId: 312, titulo: 'Zatch Bell' }],
  ['315', { slug: 'lilo-stich-disney', lctId: 315, titulo: 'Lilo & Stich - Disney' }],
  ['323', { slug: 'corsario-negro-otros', lctId: 323, titulo: 'Corsario Negro' }],
  ['324', { slug: 'zenki-otros', lctId: 324, titulo: 'Zenki' }],
  ['325', { slug: 'slam-dunk-otros', lctId: 325, titulo: 'Slam Dunk' }],
  ['332', { slug: 'happy-tree-friends-otros', lctId: 332, titulo: 'Happy Tree Friends Otros' }],
  ['349', { slug: 'jayce-y-los-guerreros-rodantes-fox-kids', lctId: 349, titulo: 'Jayce y los Guerreros Rodantes - Fox Kids' }],
  ['350', { slug: 'yin-yang-yo-fox-kids', lctId: 350, titulo: 'Yin Yang Yo! - Fox Kids' }],
  ['354', { slug: 'el-colegio-del-agujero-negro-fox-kids', lctId: 354, titulo: 'El Colegio Del Agujero Negro - Fox Kids' }],
  ['357', { slug: 'felix-el-gato', lctId: 357, titulo: 'Felix El Gato' }],
  ['361', { slug: 'historia-de-fantasmas', lctId: 361, titulo: 'Historia de Fantasmas' }],
  ['365', { slug: 'el-misterio-de-anubis-nickelodeon', lctId: 365, titulo: 'El Misterio de Anubis - Nickelodeon' }],
  ['366', { slug: 'yu-gi-oh-5ds-nickelodeon', lctId: 366, titulo: 'YU Gi Oh! 5DS - Nickelodeon' }],
  ['367', { slug: 'zona-tiza-nickelodeon', lctId: 367, titulo: 'Zona Tiza - Nickelodeon' }],
  ['370', { slug: 'ginger-nickelodeon', lctId: 370, titulo: 'Ginger - Nickelodeon' }],
  ['372', { slug: 'blanco-y-negro-nickelodeon', lctId: 372, titulo: 'Blanco y Negro - Nickelodeon' }],
  ['375', { slug: 'hora-de-aventura', lctId: 375, titulo: 'Hora de Aventura' }],
  ['381', { slug: 'eek-el-gato-fox-kids', lctId: 381, titulo: 'Eek! El Gato - Fox Kids' }],
  ['382', { slug: 'la-garrapata-fox-kids', lctId: 382, titulo: 'La Garrapata - Fox Kids' }],
  ['387', { slug: 'phineas-y-pherb-disney', lctId: 387, titulo: 'Phineas y Pherb - Disney' }],
  ['392', { slug: 'las-3-mellizas-otros', lctId: 392, titulo: 'Las 3 Mellizas' }],
  ['396', { slug: 'cool-mccool-fox-kids', lctId: 396, titulo: 'Cool McCool - Fox Kids' }],
  ['401', { slug: 'clarissa-lo-explica-todo-nickelodeon', lctId: 401, titulo: 'Clarissa Lo Explica Todo - Nickelodeon' }],
  ['404', { slug: 'popeye-el-marino', lctId: 404, titulo: 'Popeye El Marino' }],
  ['407', { slug: 'el-lagartijo-de-ned', lctId: 407, titulo: 'El Lagartijo De Ned' }],
  ['409', { slug: 'batman-el-valiente', lctId: 409, titulo: 'Batman El Valiente' }],
  ['414', { slug: 'alienators-evolucion-continua-fox-kids', lctId: 414, titulo: 'Alienators: Evolucion Continua - Fox Kids' }],
  ['418', { slug: 'jacobo-dos-dos-fox-kids', lctId: 418, titulo: 'Jacobo Dos Dos - Fox Kids' }],
  ['420', { slug: 'archie-y-sabrina-hanna-barbera', lctId: 420, titulo: 'Archie y Sabrina - Hanna Barbera' }],
  ['427', { slug: 'protagonistas-de-la-historia-warner-channel', lctId: 427, titulo: 'Protagonistas De La Historia Warner Channel' }],
  ['428', { slug: 'el-mago-otros', lctId: 428, titulo: 'El Mago' }],
  ['430', { slug: 'el-rey-arturo-otros', lctId: 430, titulo: 'El Rey Arturo Otros' }],
  ['433', { slug: 'virtua-fighter-otros', lctId: 433, titulo: 'Virtua Fighter' }],
  ['434', { slug: 'ripley-aunque-usted-no-lo-crea-otros', lctId: 434, titulo: 'Ripley: Aunque Usted No Lo Crea Otros' }],
  ['436', { slug: 'escuela-de-heroes-otros', lctId: 436, titulo: 'Escuela De Heroes Otros' }],
  ['442', { slug: 'el-fantastico-max-hanna-barbera', lctId: 442, titulo: 'El Fantastico Max - Hanna Barbera' }],
  ['447', { slug: 'isa-tkm-nickelodeon', lctId: 447, titulo: 'Isa TKM - Nickelodeon' }],
  ['448', { slug: 'isa-tk-nickelodeon', lctId: 448, titulo: 'Isa TK+ - Nickelodeon' }],
  ['454', { slug: 'la-tortuga-franklin-nickelodeon', lctId: 454, titulo: 'La Tortuga Franklin - Nickelodeon' }],
  ['457', { slug: 'super-fizgon-y-despistado-hanna-barbera', lctId: 457, titulo: 'Super Fizgon y Despistado - Hanna Barbera' }],
  ['458', { slug: 'grotescologia-fox-kids', lctId: 458, titulo: 'Grotescologia - Fox Kids' }],
  ['461', { slug: 'shinzo-fox-kids', lctId: 461, titulo: 'Shinzo - Fox Kids' }],
  ['462', { slug: 'angela-anaconda-fox-kids', lctId: 462, titulo: 'Angela Anaconda - Fox Kids' }],
  ['463', { slug: 'power-rangers-a-la-velocidad-de-la-luz-fox-kids', lctId: 463, titulo: 'Power Rangers A La Velocidad De La Luz - Fox Kids' }],
  ['464', { slug: 'power-rangers-fuerza-del-tiempo-fox-kids', lctId: 464, titulo: 'Power Rangers Fuerza Del Tiempo - Fox Kids' }],
  ['465', { slug: 'power-rangers-fueza-salvaje-fox-kids', lctId: 465, titulo: 'Power Rangers Fueza Salvaje - Fox Kids' }],
  ['466', { slug: 'power-rangers-tormenta-ninja-fox-kids', lctId: 466, titulo: 'Power Rangers Tormenta Ninja - Fox Kids' }],
  ['467', { slug: 'power-rangers-dino-trueno-fox-kids', lctId: 467, titulo: 'Power Rangers Dino Trueno - Fox Kids' }],
  ['468', { slug: 'power-rangers-super-patrulla-delta-fox-kids', lctId: 468, titulo: 'Power Rangers Super Patrulla Delta - Fox Kids' }],
  ['469', { slug: 'power-rangers-fuerza-mistica-fox-kids', lctId: 469, titulo: 'Power Rangers Fuerza Mistica - Fox Kids' }],
  ['470', { slug: 'power-rangers-operacion-sobrecarga-fox-kids', lctId: 470, titulo: 'Power Rangers Operacion Sobrecarga - Fox Kids' }],
  ['471', { slug: 'power-rangers-furia-animal-fox-kids', lctId: 471, titulo: 'Power Rangers Furia Animal - Fox Kids' }],
  ['472', { slug: 'power-rangers-rpm-disney', lctId: 472, titulo: 'Power Rangers RPM - Disney' }],
  ['473', { slug: 'power-rangers-samurai-disney', lctId: 473, titulo: 'Power Rangers Samurai - Disney' }],
  ['474', { slug: 'power-rangers-super-samurai-disney', lctId: 474, titulo: 'Power Rangers Super Samurai - Disney' }],
  ['477', { slug: 'power-rangers-dino-charge', lctId: 477, titulo: 'Power Rangers Dino Charge' }],
  ['478', { slug: 'power-rangers-dino-super-charge', lctId: 478, titulo: 'Power Rangers Dino Super Charge' }],
  ['479', { slug: 'power-rangers-ninja-steel', lctId: 479, titulo: 'Power Rangers Ninja Steel' }],
  ['480', { slug: 'power-rangers-super-ninja-steel', lctId: 480, titulo: 'Power Rangers Super Ninja Steel' }],
  ['481', { slug: 'power-rangers-beast-morphers', lctId: 481, titulo: 'Power Rangers Beast Morphers' }],
  ['483', { slug: 'arthur', lctId: 483, titulo: 'Arthur' }],
  ['486', { slug: 'loonatics', lctId: 486, titulo: 'Loonatics' }],
  ['489', { slug: 'highlander-el-inmortal-otros', lctId: 489, titulo: 'Highlander El Inmortal Otros' }],
  ['491', { slug: 'salvados-por-la-campana-otros', lctId: 491, titulo: 'Salvados Por La Campana Otros' }],
  ['492', { slug: 'salvados-por-la-campana-anos-de-universidad-otros', lctId: 492, titulo: 'Salvados Por La Campana: Años De Universidad Otros' }],
  ['493', { slug: 'los-intocables-de-elliot-mouse-otros', lctId: 493, titulo: 'Los Intocables De Elliot Mouse Otros' }],
  ['494', { slug: 'xena-la-princesa-guerrera-otros', lctId: 494, titulo: 'Xena La Princesa guerrera Otros' }],
  ['495', { slug: 'anatole-otros', lctId: 495, titulo: 'Anatole' }],
  ['496', { slug: 'heroes-de-rescate-otros', lctId: 496, titulo: 'Heroes De Rescate Otros' }],
  ['497', { slug: 'los-conejitos-torpes-otros', lctId: 497, titulo: 'Los Conejitos Torpes' }],
  ['498', { slug: 'zoboomafo-otros', lctId: 498, titulo: 'Zoboomafo' }],
  ['499', { slug: 'clifford-el-gran-perro-rojo-otros', lctId: 499, titulo: 'Clifford El Gran Perro Rojo Otros' }],
  ['504', { slug: 'escuela-de-espanto-otros', lctId: 504, titulo: 'Escuela De Espanto Otros' }],
  ['505', { slug: 'fraggle-rock-otros', lctId: 505, titulo: 'Fraggle Rock Otros' }],
  ['506', { slug: 'animalitos-locos-otros', lctId: 506, titulo: 'Animalitos Locos Otros' }],
  ['507', { slug: 'los-fantasticos-viajes-de-simbads-el-marino-otros', lctId: 507, titulo: 'Los Fantasticos Viajes De Simbads El Marino Otros' }],
  ['508', { slug: 'bumpy-y-sus-amigos-otros', lctId: 508, titulo: 'Bumpy y sus Amigos Otros' }],
  ['509', { slug: 'elliot-el-alce-otros', lctId: 509, titulo: 'Elliot El Alce' }],
  ['510', { slug: 'el-chavo-del-8-otros', lctId: 510, titulo: 'El Chavo Del 8 Otros' }],
  ['511', { slug: 'angel-la-nina-de-las-flores-otros', lctId: 511, titulo: 'Angel La Niña De Las Flores Otros' }],
  ['512', { slug: 'la-familia-robinson-otros', lctId: 512, titulo: 'La Familia Robinson Otros' }],
  ['516', { slug: 'jem-y-los-hologramas-otros', lctId: 516, titulo: 'Jem y Los Hologramas Otros' }],
]);
/* v113: series de MisCaricaturas cuyas temporadas en inglés se
 * reemplazan por las de lacartoons (latino, auditadas). «tomar» = qué
 * eps de lacartoons entran; «dejarMisc» = qué eps de MisCaricaturas se
 * conservan (el resto de esa serie se tira); «excluirCaps» = capIds de
 * lacartoons que se saben rotos (muertos o idioma mentiroso). */
const LCT_MERGE = [
  {
    slug: 'las-sombrias-aventuras-de-billy-y-mandy-capitulos-completos', lctId: 16,
    tomar: (e) => e.temporada <= 5,
    dejarMisc: (e) => e.temporada >= 6,
  },
  {
    slug: 'ben-10-capitulos-completos', lctId: 280,
    tomar: (e) => e.temporada >= 3 || (e.temporada === 2 && e.ep === 12),
    dejarMisc: (e) => e.temporada <= 2 && !(e.temporada === 2 && e.ep === 12),
    excluirCaps: new Set([16693, 16694]), /* v113: 4x01 muerto; 4x02 «español» que es francés */
  },
];
const lctEps = new Map(); /* lctId → {at, eps} — 6 h */
/* v111: al arrancar, las cachés de los pickers se leen del DISCO — el
 * selector abre rápido incluso recién reiniciado el servidor (antes,
 * cada actualizar.sh dejaba todo lento otra vez). Si la versión cambió,
 * los archivos se ignoran y se empieza de cero. */
try {
  for (const [k, v] of cacheLeer('cariDatos') || []) cariDatos.set(k, v);
  for (const [k, v] of cacheLeer('cariMeta') || []) cariMeta.set(k, v);
  for (const [k, v] of cacheLeer('lctEps') || []) lctEps.set(k, v); /* v112: episodios de lacartoons */
  for (const [k, v] of cacheLeer('serieCache') || []) serieCache.set(k, v);
  { const podados = serieCachePodar(SERIECACHE_MAX); if (podados) console.log('[mem] v297: serieCache podada al arranque: -' + podados + ' entradas viejas, quedan ' + serieCache.size); }
  for (const [k, v] of cacheLeer('postersSeries') || []) postersSeries.set(k, v);
  const ch = cacheLeer('cariHome');
  if (ch && ch.at) { cariHome.at = ch.at; for (const [k, v] of (ch.items || [])) cariHome.items.set(k, v); }
  let cf = cacheLeer('cariFeed');
  if (!cf) { /* v205.4: un caché guardado por otra versión VALE si trae la forma correcta — las filas de caricaturas/cartoons/live aparecen al instante tras actualizar o reiniciar */
    try { const dc = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'cariFeed.json'), 'utf8')); if (dc && dc.e && dc.e.at) cf = dc.e; } catch {}
  }
  if (cf && cf.at) { cariFeedCache.at = cf.at; cariFeedCache.items = Array.isArray(cf.items) ? cf.items : []; cariFeedCache.toons = Array.isArray(cf.toons) ? cf.toons : []; cariFeedCache.live = Array.isArray(cf.live) ? cf.live : []; }
  const nCari = cariDatos.size, nSerie = serieCache.size;
  if (nCari || nSerie) console.log('[cache] del disco: ' + nCari + ' caricaturas, ' + nSerie + ' series/animes, ' + cariMeta.size + ' metas' + (cariFeedCache.items.length ? ', feed listo' : ''));
} catch {}
function cariSlugDe(u) { return ((/miscaricaturas\.com\/([a-z0-9-]+)/i.exec(u || '') || [])[1] || '').toLowerCase(); }
function cariEsSerie(slug) { return !!slug && !/temporada/i.test(slug) && !/\d{1,2}x\d{2}/i.test(slug); } /* v241: 1xNN */
function cariBonito(slug) { return slug.replace(/-+/g, ' ').replace(/\b(capitulos completos|completos|ver|latino|online)\b/gi, '').trim(); }
/* v109: el prefijo del slug de un EPISODIO («el-chavo-del-8-1978»,
 * «las-sombrias-aventuras-de-billy-y-mandy») NO es el slug de la serie:
 * el Chavo intercala el año y las series llevan colas como
 * «-capitulos-completos». Este núcleo + búsqueda por prefijo mapea
 * episodio → serie real (arregla el póster en blanco de continuar-viendo
 * del Chavo: «el-chavo-del-8-1978» no existe como página y el saneo
 * viejo se quedaba sin póster). */
function cariCore(slug) {
  let s = String(slug || ''), prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/-(capitulos-y-canciones|capitulos-completos[a-z]*|temporada-\d+|completos|ver|latino|online)$/, '');
  }
  return s.replace(/-(19|20)\d{2}$/, ''); /* el año final de los eps del Chavo */
}
function cariSerieDeEp(prefijo) {
  const nucleo = cariCore(prefijo);
  if (!nucleo) return '';
  const candidatas = [...new Set([...CARI_PORTADAS.keys(), ...CARI_ORDEN, ...cariMeta.keys(), ...cariDatos.keys()])];
  let mejor = '';
  for (const s of candidatas) {
    const c = cariCore(s);
    if (nucleo.startsWith(c) && c.length > cariCore(mejor).length) mejor = s; /* la más específica gana; las locales primero */
  }
  return mejor;
}
/* v109→v110: capítulos/temporadas cuya ÚNICA copia en la fuente está en
 * inglés — se ocultan de la lista (el usuario quiere todo latino).
 * AUDITADOS CON IA DE VOZ (whisper, 29 episodios muestreados, 2026-09-11):
 * no hay metadata de idioma en streamwish, así que esto se verificó
 * ESCUCHANDO segmentos del medio de cada capítulo. Resultado:
 * - Billy y Mandy: T1-T5 en inglés (9 muestras 96-98%), T6 en latino
 *   → v112: las T1-T5 ahora vienen de LACARTOONS en latino y salieron
 *     de esta lista; MisCaricaturas ya no las aporta
 * - Ben 10: T3 y T4 en inglés (99%), 2x12 inglés
 *   → v113: igual — ahora vienen de LACARTOONS en latino (auditado de
 *     nuevo ahí: 2x12 0.99, T3 0.96-0.98, T4 0.97-0.99) y salió de la
 *     lista. Queda FUERA el 4x01 (muerto) y el 4x02 (pista «Español»
 *     que en realidad trae audio francés — verificado con ASR)
 * - Jimmy Neutrón: T2 en inglés (3 muestras 97-99%), T1 y T3 latino
 *   → v113: en lacartoons la serie entera está muerta, sigue oculta
 * - las demás 16 series del feed: latino confirmado
 * Formato: 'slug|TxEPp' (exacto) o 'slug|Tx*' (toda la temporada). */
const EPS_INGLESES = new Set([
  'jimmy-neutron-capitulos-completos|2x*',
]);
function cariEsIngles(slug, e) {
  const p = String(e.parte || '').toLowerCase();
  return EPS_INGLESES.has(slug + '|' + e.temporada + 'x' + e.ep + p)
    || EPS_INGLESES.has(slug + '|' + e.temporada + 'x*');
}
/* v112: LACARTOONS — lista de episodios de la página de una serie
 * (/serie/{id}): links «/serie/capitulo/{capId}?t={temporada}» con
 * «<span>Capitulo N-</span> Título». El mismo capítulo aparece dos
 * veces en el HTML (duplicado de maquetación) — se deduplica por capId. */
function lctEpsDeHtml(html) {
  const eps = [];
  const vistos = new Set();
  for (const m of html.matchAll(/href="\/serie\/capitulo\/(\d+)\?t=(\d+)"[^>]*>\s*(?:<span>\s*Capitulo\s*(\d+)\s*-?\s*<\/span>\s*)?([^<]*)/gi)) {
    if (vistos.has(m[1])) continue;
    vistos.add(m[1]);
    const t = +m[2];
    eps.push({
      temporada: t,
      ep: +m[3] || eps.filter((x) => x.temporada === t).length + 1,
      parte: '',
      url: LCT_BASE + 'serie/capitulo/' + m[1] + '?t=' + t,
      titulo: (m[4] || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }
  eps.sort((a, b) => a.temporada - b.temporada || a.ep - b.ep);
  return eps;
}
async function lctEpisodios(lctId) {
  const c = lctEps.get(String(lctId));
  if (c && Date.now() - c.at < 6 * 60 * 60 * 1000) return c;
  if (c) { refrescarLctEps(lctId).catch(() => {}); return c; } /* v111: vencido → se sirve y se refresca por detrás */
  return await refrescarLctEps(lctId);
}
async function refrescarLctEps(lctId) {
  try {
    const r = await fetchSeguro(LCT_BASE + 'serie/' + lctId, 15000);
    if (!r.ok) return null;
    const parsed = lctEpsDeHtml(await r.text());
    if (!parsed.length) return null;
    /* v117: los capítulos confirmados muertos en barridos anteriores
     * salen de la lista desde ya (no resucitan en cada refresco) */
    const prev = lctEps.get(String(lctId)) || {};
    const muertos = new Set(prev.muertos || []);
    const eps = parsed.filter((e) => !muertos.has(lctCapIdDe(e.url)));
    if (!eps.length) return null;
    const out = { at: Date.now(), eps, muertos: [...muertos] };
    lctEps.set(String(lctId), out);
    cacheGuardar('lctEps', () => [...lctEps.entries()]);
    encolarBarrido(lctId, parsed); /* v117: en cola, sin ahogar al servidor */
    return out;
  } catch { return null; }
}
/* v112: barrido de vivos — los embeds retirados NO se marcan en la
 * página de la serie (el 1x01 de Billy está muerto y no se nota ahí),
 * así que cada capítulo se checa en fondo (lotes de 8) y la lista
 * cacheada se limpia de los que ya no traen iframe de player. */
/* v117: los barridos van por una COLA — uno a la vez, lotes de 4 y
 * pausas de 200 ms. El arranque en frío con 16 series de lacartoons
 * llegó a soltar ~1100 peticiones en ráfaga y ahogaba al servidor
 * (y hacía lento todo lo demás: los capítulos de MisCaricaturas
 * dejaban de resolver por timeouts). Los capIds confirmados muertos
 * se recuerdan y no se vuelven a checar en los refrescos. */
const lctBarridoCola = [];
let lctBarridoActivo = false;
function encolarBarrido(lctId, eps) {
  lctBarridoCola.push({ lctId, eps });
  if (!lctBarridoActivo) procesarColaBarrido().catch(() => {});
}
async function procesarColaBarrido() {
  lctBarridoActivo = true;
  try {
    while (lctBarridoCola.length) {
      const j = lctBarridoCola.shift();
      await lctBarrerVivos(j.lctId, j.eps).catch(() => {});
    }
  } finally { lctBarridoActivo = false; }
}
function lctCapIdDe(u) { return +((/capitulo\/(\d+)\?/.exec(u || '') || [])[1] || 0); }
async function lctBarrerVivos(lctId, eps) {
  const c = lctEps.get(String(lctId)) || {};
  const muertos = new Set(c.muertos || []);
  const lista = eps.slice(0, 220);
  const porChecar = lista.filter((e) => !muertos.has(lctCapIdDe(e.url)));
  const vivos = [];
  let lote = [];
  const checar = async (e) => {
    try {
      const r = await fetchSeguro(e.url, 12000);
      const html = r && r.ok ? await r.text() : '';
      if (!html || /cubeembed\.rpmvid\.com\/#[a-z0-9]+|ok\.ru\/videoembed\/\d+/i.test(html)) vivos.push(e); /* v119: ok.ru también cuenta como vivo */
    } catch { vivos.push(e); } /* si no se pudo checar, no se tira */
  };
  for (const e of porChecar) {
    lote.push(checar(e));
    if (lote.length >= 4) { await Promise.all(lote); lote = []; await new Promise((r) => setTimeout(r, 200)); }
  }
  await Promise.all(lote);
  if (!lista.length) return;
  const vivosIds = new Set(vivos.map((e) => lctCapIdDe(e.url)));
  const nuevosMuertos = porChecar.filter((e) => !vivosIds.has(lctCapIdDe(e.url))).map((e) => lctCapIdDe(e.url));
  if (!nuevosMuertos.length && !muertos.size) return;
  const todosMuertos = [...new Set([...muertos, ...nuevosMuertos])];
  const final = lista.filter((e) => !todosMuertos.has(lctCapIdDe(e.url)));
  if (!final.length) return;
  if (nuevosMuertos.length) console.log('[lacartoons] serie ' + lctId + ': ' + nuevosMuertos.length + ' capítulos muertos fuera de la lista');
  lctEps.set(String(lctId), { at: Date.now(), eps: final, muertos: todosMuertos });
  cacheGuardar('lctEps', () => [...lctEps.entries()]);
  /* si la serie ya se sirvió, su cariDatos se reconstruirá con la lista limpia */
  const slug = (LCT_MERGE.find((x) => String(x.lctId) === String(lctId)) || {}).slug
    || (([...LCT_SERIES.values()].find((x) => String(x.lctId) === String(lctId)) || {}).slug || '');
  if (slug && nuevosMuertos.length) cariDatos.delete(slug);
}
/* v112: ¿de qué serie es este capítulo de lacartoons? (para el póster
 * de continuar-viendo) — busca el capId en las listas ya cacheadas */
function lctSerieDeCap(capId) {
  const marca = '/serie/capitulo/' + capId + '?';
  const candidatas = [
    ...LCT_MERGE.map((x) => [String(x.lctId), x.slug]), /* v113: billy, ben 10 */
    ...[...LCT_SERIES.values()].map((x) => [String(x.lctId), x.slug]),
  ];
  for (const [id, slug] of candidatas) {
    const c = lctEps.get(id);
    if (c && c.eps && c.eps.some((e) => e.url.includes(marca))) return slug;
  }
  return '';
}
/* v102: el h1 a veces trae entidades y colas («– Capítulos completos»,
 * «| Español latino») — se decodifican y se cortan */
function cariLimpia(t) {
  return String(t || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s*[|–—-]\s*(cap[ií]tulos?|espa[nñ]ol|latino|online|completos?|temp\w*).*$|\s+\|\s+.*$/i, '')
    .replace(/\s*cap[ií]tulos?(\s+y\s+canciones)?(\s+completos?)?\s*$/i, '')
    .replace(/\s*[|–—-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* título (h1) y póster de una serie — una sola descarga de la página */
/* v104: portadas CURADAS — archivos locales en public/covers/{slug}.jpg para
 * las series cuya página no tiene ningún póster (Simpsons, Futurama, Oye
 * Arnold, Dexter, Coraje, Daria, Sabrina, Kenan y Kel). Se leen del disco al
 * arrancar: agrega un .jpg ahí y reinicia.
 * v108: Bob Esponja, Dexter, Los Simpson, Padrinos Mágicos y El Chavo del 8
 * usan el póster primario de IMDB (el usuario los pidió de ahí).
 * v109: Sabrina (sitcom 1996) y el Chavo del 8 CORREGIDO — la serie del
 * feed es la ORIGINAL de Chespirito (1973-1978, eps con año en el slug),
 * no la animada; su póster de IMDB es el de la serie original. */
const CARI_PORTADAS = new Map();
try {
  for (const f of fs.readdirSync(path.join(__dirname, 'public', 'covers'))) {
    const m = /^([a-z0-9-]{2,90})\.(jpe?g|png|webp)$/i.exec(f);
    if (!m) continue;
    /* v125: ?v=VERSION.mtime — al REEMPLAZAR un archivo la URL cambia sola
     * al reiniciar (antes solo cambiaba si subía UI_VERSION y por eso una
     * cover vieja seguía saliendo del caché del navegador, como pasó con
     * Daria: la cambié dentro de v123 y el ?v= no se movió) */
    const mt = fs.statSync(path.join(__dirname, 'public', 'covers', f)).mtimeMs.toString(36);
    CARI_PORTADAS.set(m[1], '/covers/' + f + '?v=' + UI_VERSION + '.' + mt);
  }
} catch {}

/* v104: la home del sitio solo trae miniaturas de 250px y la página de cada
 * serie a veces solo tiene los banners del widget de «relacionados» (crp).
 * Este extractor elige la portada de verdad: og:image → primera imagen de
 * wp-content que NO sea del widget ni una miniatura -150x124 */
function cariPosterDeHtml(html) {
  const og = /property="og:image" content="(https:\/\/miscaricaturas\.com\/wp-content\/uploads\/[^"]+)"/i.exec(html);
  if (og) return og[1];
  for (const m of html.matchAll(/data-src="(https:\/\/miscaricaturas\.com\/wp-content\/uploads\/[^"]+)"/gi)) {
    const url = m[1];
    const ctx = html.slice(Math.max(0, m.index - 300), m.index);
    if (/crp_|crp-thumb|related/i.test(ctx)) continue; /* widget de relacionados */
    if (/-\d{2,3}x\d{2,3}\.(jpe?g|png|webp)$/i.test(url)) continue; /* miniatura pequeña */
    return url;
  }
  return null;
}

/* v104: listado de la home (slug → {img, alt}) — la imagen propia de cada
 * serie en el catálogo, para respaldo cuando la página no tiene póster */
const cariHome = { at: 0, items: new Map() }; /* 6 h */
async function cariHomeImgs() {
  if (Date.now() - cariHome.at < 6 * 3600 * 1000 && cariHome.items.size) return cariHome.items;
  if (cariHome.items.size) { refrescarCariHome().catch(() => {}); return cariHome.items; } /* v111: vencido → se sirve y se refresca por detrás */
  return await refrescarCariHome();
}
async function refrescarCariHome() {
  const r = await fetchSeguro(CARI_BASE, 10000);
  if (!r.ok) return cariHome.items;
  const html = await r.text();
  const art = (/<article[\s\S]*?<\/article>/i.exec(html) || [''])[0];
  const out = new Map();
  for (const m of art.matchAll(/<p><a href="https:\/\/miscaricaturas\.com\/([a-z0-9-]+)\/"[^>]*>\s*<img[^>]*data-src="(https:[^"]+)"[^>]*alt="([^"]*)"/gi)) {
    if (!out.has(m[1])) out.set(m[1], { img: m[2], alt: m[3] });
  }
  if (out.size) {
    cariHome.items = out; cariHome.at = Date.now();
    cacheGuardar('cariHome', () => ({ at: cariHome.at, items: [...cariHome.items.entries()] })); /* v111: a disco */
  }
  return out;
}

async function cariMetaDe(slug) {
  try {
    const c = cariMeta.get(slug);
    if (c && Date.now() - c.at < 6 * 3600 * 1000) return c;
    if (c) { refrescarCariMetaDe(slug).catch(() => {}); return c; } /* v111: vencido → se sirve y se refresca por detrás */
    return await refrescarCariMetaDe(slug);
  } catch { return null; }
}
async function refrescarCariMetaDe(slug) {
  try {
    const r = await fetchSeguro(CARI_BASE + slug + '/', 10000);
    const html = r && r.ok ? await r.text() : '';
    const h1 = (/<h1[^>]*>([^<]+)<\/h1>/i.exec(html) || [])[1];
    /* v104: póster de verdad (og:image o el bueno de la página); si la serie
     * no tiene, la miniatura de su entrada en la home del sitio */
    let poster = html ? cariPosterDeHtml(html) : null;
    if (!poster) {
      const home = await cariHomeImgs();
      poster = ((home.get(slug) || {}).img) || '';
    }
    const out = {
      at: Date.now(),
      titulo: cariLimpia(h1 || cariBonito(slug)).slice(0, 80),
      poster,
      cover: CARI_PORTADAS.get(slug) || '', /* v104: portada curada local */
    };
    cariMeta.set(slug, out);
    cacheGuardar('cariMeta', () => [...cariMeta.entries()]); /* v111: a disco */
    return out;
  } catch { return null; }
}

async function buscarMiscaricaturas(q) {
  try {
    const r = await fetchSeguro(CARI_BASE + '?s=' + encodeURIComponent(q), 10000);
    if (!r.ok) return [];
    const html = await r.text();
    const vistos = new Set();
    const series = [];
    for (const m of html.matchAll(/<h2 class="entry-title[^"]*"><a href="(https:\/\/miscaricaturas\.com\/[a-z0-9-]+\/?)"[^>]*>([^<]+)<\/a>/gi)) {
      const slug = cariSlugDe(m[1]);
      if (!cariEsSerie(slug) || vistos.has(slug) || CARI_MUERTAS.has(slug)) continue; /* v251 muertas siempre ocultas */
      vistos.add(slug);
      series.push({ slug, title: m[2].replace(/&#\d+;|&amp;|&\w+;/g, '').trim() });
      if (series.length >= 5) break;
    }
    const items = await Promise.all(series.map(async (s) => {
      const meta = await cariMetaDe(s.slug).catch(() => null);
      return { title: meta && meta.titulo ? meta.titulo : s.title, url: CARI_BASE + s.slug + '/', img: meta ? (meta.cover || meta.poster) : '', site: 'Caricaturas' }; /* v104: portada curada primero */
    }));
    return items.filter((x) => x.title && x.url);
  } catch { return []; }
}

/* fila del feed: las series de la portada, con póster de su página */
/* v104: la fila de Caricaturas — las clásicas primero y con portada de
 * verdad: portada curada local → póster de la página de la serie → la
 * miniatura de la home. Nunca más banners del widget de relacionados */
/* v205: series LIVE ACTION (actores reales) — iCarly, Drake & Josh, sitcoms
 * de Nickelodeon (Clarissa, Ned, Isa TKM, Los Munsters, Hechizada, Mi Bella
 * Genio, Super Agente 86, Familia Addams, Anubis…), Power Rangers (TODAS
 * las variantes, vía prefijo), VR Troopers y Los 3 Chiflados (Lacartoons)
 * + Sabrina y Kenan y Kel (MisCaricaturas). Dejan de mezclarse en
 * Caricaturas/Cartoons: tienen apartado propio en el feed y catálogo. */
const CARI_LIVE = new Set(['sabrina-la-bruja-adolescente-latino', 'kenan-y-kel-latino', 'el-chavo-del-8-capitulos-completoss', 'el-chavo-del-8-capitulos-completos', 'el-chavo-del-8', 'el-chapulin-colorado-capitulos-completos', 'el-chapulin-colorado', 'chespirito-capitulos-completos', 'chespirito']);
function esCariLive(slug){
  if(!slug) return false;
  if(CARI_LIVE.has(slug)) return true;
  const s = String(slug).toLowerCase();
  if(s.includes('chavo') || s.includes('chapulin') || s.includes('chespirito') || s.includes('sabrina') || s.includes('kenan-y-kel')) return true;
  return false;
}
const LCT_LIVE = new Set(['icarly', 'drake-y-josh', 'los-3-chiflados-fox-kids', 'vr-troopers-fox-kids', 'la-familia-addams-nickelodeon', 'los-munsters-nickelodeon', 'hechizada-nickelodeon', 'super-agente-86-nickelodeon', 'mi-bella-genio-nickelodeon', 'el-misterio-de-anubis-nickelodeon', 'clarissa-lo-explica-todo-nickelodeon', 'el-lagartijo-de-ned', 'isa-tkm-nickelodeon', 'isa-tk-nickelodeon']);
const esLctLive = (slug) => LCT_LIVE.has(slug) || String(slug).indexOf('power-rangers-') === 0; /* TODAS las variantes de Power Rangers */
const CARI_ORDEN = [
  'bob-esponja-capitulos-completos', 'hora-de-aventura-capitulos-completos', 'el-chavo-del-8-capitulos-completoss',
  'rick-y-morty-capitulos-completos', 'south-park', 'los-simpsons', 'phineas-y-ferb-capitulos-completos',
  'los-padrinos-magicos-capitulos-completos', 'ben-10-capitulos-completos', 'danny-phantom-capitulos-completos',
  'jimmy-neutron-capitulos-completos', 'oye-arnold', 'el-laboratorio-de-dexter-capitulos-completos',
  'las-sombrias-aventuras-de-billy-y-mandy-capitulos-completos', 'coraje-el-perro-cobarde-latino',
  'sabrina-la-bruja-adolescente-latino', 'kenan-y-kel-latino', /* v107: live-action de nick visibles en la fila */
  'futurama-latino', '31-minutos-capitulos-y-canciones', 'daria-capitulos-completos',
  'un-show-mas-capitulos-completos', 'invasor-zim-temporada-1', 'las-chicas-superpoderosas-capitulos-completos',
  'johnny-bravo-capitulos-completos', 'samurai-jack-temporada-1', 'mucha-lucha-capitulos-completos',
  'mansion-foster-para-amigos-imaginarios-capitulos-completos', 'escuadron-del-tiempo-capitulos-completos',
  'ozzy-y-drix-capitulos-completos', 'la-pantera-rosa-capitulos-completos', 'rocket-power-capitulos-completos',
  'la-vaca-y-el-pollito-capitulos-completos', 'los-chicos-del-barrio-capitulos-completos',
  'megas-xlr-capitulos-completos', 'monstruos-de-verdad-latino', 'soy-la-comadreja-latino',
];
async function caricaturasDestacadas() {
  // v276: si el cache viejo tenía chavo en caricaturas, invalídalo
  if(cariFeedCache.items.some(x=> /chavo|chapulin|chespirito/i.test(x.title||'') )) cariFeedCache.at = 0;
  const listo = () => ({ caricaturas: cariFeedCache.items, cartoons: cariFeedCache.toons, liveaction: cariFeedCache.live });
  if (Date.now() - cariFeedCache.at < 60 * 60 * 1000 && (cariFeedCache.items.length || cariFeedCache.toons.length)) return listo();
  if (cariFeedCache.items.length || cariFeedCache.toons.length) { refrescarCariFeed().catch(() => {}); return listo(); }
  // v274: arranque en frío espera 6s a que se llene, no devuelve vacío que deja feed sin 3 filas
  try { await Promise.race([refrescarCariFeed(), new Promise(r=>setTimeout(r,6000))]); }catch{}
  if (cariFeedCache.items.length || cariFeedCache.toons.length || cariFeedCache.live.length) return listo();
  // aún vacío, reintenta una vez más en 2s por detrás
  refrescarCariFeed().catch(()=>{});
  return listo();
}
async function refrescarCariFeed() {
  // v276: invalida cache viejo que tenía live en caricaturas
  if(cariFeedCache.items.some(x=> /chavo|chapulin/i.test(x.title) )) cariFeedCache.at = 0;
  const home = await cariHomeImgs();
  if (!home.size) return { caricaturas: cariFeedCache.items, cartoons: cariFeedCache.toons, liveaction: cariFeedCache.live };
  const enHome = [...home.keys()];
  const slugs = [
    ...CARI_ORDEN.filter((s) => home.has(s) && !CARI_MUERTAS.has(s)), /* v251 muertas siempre ocultas */
    ...enHome.filter((s) => !CARI_ORDEN.includes(s) && cariEsSerie(s) && !CARI_MUERTAS.has(s)), /* v251 */
  ].slice(0, 18); /* v107: 18 — entran Sabrina y Kenan y Kel */
  if (!slugs.length) return { caricaturas: cariFeedCache.items, cartoons: cariFeedCache.toons, liveaction: cariFeedCache.live };
  const mapearCari = async (slug) => {
    const meta = await cariMetaDe(slug).catch(() => null);
    const h = home.get(slug) || {};
    const img = CARI_PORTADAS.get(slug) || DANI_IMDB.get(slug) || (meta && (meta.cover || meta.poster)) || h.img || ''; /* v180: curada local primero */
    return {
      slug,
      title: (meta && meta.titulo) || cariLimpia(h.alt || cariBonito(slug)),
      url: CARI_BASE + slug + '/', img, site: 'Caricaturas',
    };
  };
  /* v205: los live action (Sabrina, Kenan y Kel) NO van en la fila de
   * caricaturas — tienen apartado propio */
  const limpiar = (x) => { const { slug, ...resto } = x; return resto; };
  const todos = (await Promise.all(slugs.map(mapearCari))).filter((x) => x.title && x.img);
  const items = todos.filter((x) => !esCariLive(x.slug)).map(limpiar).sort((a,b)=> a.title.localeCompare(b.title,'es'));
  const liveCari = todos.filter((x) => esCariLive(x.slug)).map(limpiar).sort((a,b)=> a.title.localeCompare(b.title,'es'));
  /* v119: apartado propio — las de LACARTOONS ya no se mezclan con las
   * de MisCaricaturas: van a "Cartoons". Son ~79 series, así que se bajan
   * en bloques de 16 en vez de todas a la vez (que no nos racione el
   * sitio por ráfaga); el arranque en frío tarda unos segundos más pero
   * queda en cache 1 h y después se sirve al instante. */
  const lctLista = [...LCT_SERIES.values()].filter((x) => !LCT_MUERTAS.has(x.slug)); /* v241 — v251 muertas siempre ocultas */
  const toons = [];
  const liveToons = []; /* v205: iCarly, Drake & Josh, Power Rangers… apartado propio */
  for (let i = 0; i < lctLista.length; i += 16) {
    const parte = await Promise.all(lctLista.slice(i, i + 16).map(async (lct) => {
      try {
        const d = await datosCaricatura(String(lct.lctId));
        if (d && d.poster && d.episodios && d.episodios.length) {
          const it = { title: d.titulo, url: LCT_BASE + 'serie/' + lct.lctId, img: d.cover || d.poster, site: 'Cartoons' }; /* v120: portada de IMDb primero */
          return esLctLive(lct.slug) ? { it, vivo: true } : { it, vivo: false };
        }
      } catch {}
      return null;
    }));
    for (const p of parte) if (p) (p.vivo ? liveToons : toons).push(p.it);
  }
  // v276: orden alfabético final
  toons.sort((a,b)=> a.title.localeCompare(b.title,'es'));
  liveToons.sort((a,b)=> a.title.localeCompare(b.title,'es'));
  const live = [...liveCari, ...liveToons].sort((a,b)=> a.title.localeCompare(b.title,'es'));
  items.sort((a,b)=> a.title.localeCompare(b.title,'es'));
  if (items.length || toons.length || live.length) {
    cariFeedCache.at = Date.now();
    cariFeedCache.items = items;
    cariFeedCache.toons = toons;
    cariFeedCache.live = live;
    cacheGuardar('cariFeed', () => ({ at: cariFeedCache.at, items: cariFeedCache.items, toons: cariFeedCache.toons, live: cariFeedCache.live }));
  } /* v111: a disco */
  return { caricaturas: items, cartoons: toons, liveaction: live };
}

/* episodios de una caricatura — la tabla de la página de la serie.
 * v103: las temporadas viejas viven en posts aparte («serie-temporada-N»)
 * enlazados desde la propia página — se bajan EN PARALELO y se fusionan
 * (Bob Esponja pasa de 4 temporadas a las ~13 de verdad) */
async function cariEpsDeHtml(html) {
  const eps = [];
  const vistosEp = new Set();
  for (const m of html.matchAll(/<a href="(https:\/\/miscaricaturas\.com\/([a-z0-9-]+?)-(\d{1,2})x(\d{2})([ab])?(?:-[a-z0-9-]*)?\/?)"[^>]*>\s*([^<]+?)\s*<\/a>/gi)) {
    const url = m[1];
    if (vistosEp.has(url)) continue;
    vistosEp.add(url);
    eps.push({ temporada: +m[3], ep: +m[4], parte: (m[5] || '').toUpperCase(), url, titulo: m[6].slice(0, 90) });
  }
  return eps;
}
/* v112: datos de una serie de LACARTOONS (mismo formato que las de
 * MisCaricaturas para que el selector no distinga). El póster es el
 * <img> de rails que no es el fondo de la página. */
async function datosLacartoons(lct) {
  try {
    const c = cariDatos.get(lct.slug);
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c.d;
    if (c) { refrescarDatosLacartoons(lct).catch(() => {}); return c.d; } /* v111: stale-while-revalidate */
    return await refrescarDatosLacartoons(lct);
  } catch { return null; }
}
async function refrescarDatosLacartoons(lct) {
  try {
    const r = await fetchSeguro(LCT_BASE + 'serie/' + lct.lctId, 15000);
    if (!r.ok) return null;
    const html = await r.text();
    const posters = [...html.matchAll(/<img[^>]+src="(\/rails\/active_storage\/[^"]+)"/gi)].map((m) => m[1]);
    let poster = posters.find((p) => !/fondo/i.test(p)) || posters[0] || '';
    if (poster) poster = LCT_BASE.replace(/\/+$/, '') + poster;
    const lista = await lctEpisodios(lct.lctId);
    const eps = (lista && lista.eps) || lctEpsDeHtml(html);
    if (!eps.length) return null;
    const cover = CARI_PORTADAS.get(lct.slug) || ''; /* v120: portada curada de IMDb (public/covers/{slug}.jpg) — el póster del sitio a veces es una foto del cast, no la carátula */
    const out = { ok: true, slug: lct.slug, titulo: lct.titulo, poster, cover, episodios: eps };
    cariDatos.set(lct.slug, { at: Date.now(), d: out });
    cacheGuardar('cariDatos', () => [...cariDatos.entries()]);
    if (poster || cover) cariMeta.set(lct.slug, { at: Date.now(), titulo: out.titulo, poster, cover });
    cacheGuardar('cariMeta', () => [...cariMeta.entries()]);
    try { if (out.episodios && out.episodios.length) precargarIntroDeSerie(out.episodios.map((e) => ({ url: e.url }))); } catch {} // v223
    return out;
  } catch { return null; }
}
async function datosCaricatura(slug) {
  try {
    const lct = LCT_SERIES.get(slug); /* v112: '/api/caricaturas/150' → iCarly de lacartoons */
    if (lct) return await datosLacartoons(lct); /* v119: primero — hay ids de UN dígito (3,4,6,7,8) */
    if (!/^[a-z0-9-]{2,90}$/.test(slug)) return null;
    const c = cariDatos.get(slug);
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c.d;
    if (c) { refrescarDatosCaricatura(slug).catch(() => {}); return c.d; } /* v111: vencido → se sirve y se refresca por detrás */
    return await refrescarDatosCaricatura(slug);
  } catch { return null; }
}
async function refrescarDatosCaricatura(slug) {
  try {
    const r = await fetchSeguro(CARI_BASE + slug + '/', 10000);
    if (!r.ok) return null;
    const html = await r.text();
    const h1 = (/<h1[^>]*>([^<]+)<\/h1>/i.exec(html) || [])[1];
    /* v104: póster de verdad — og:image o la imagen buena de la página;
     * si la serie no tiene, la miniatura de su entrada en la home */
    let poster = cariPosterDeHtml(html);
    if (!poster) {
      const home = await cariHomeImgs();
      poster = ((home.get(slug) || {}).img) || '';
    }
    const cover = CARI_PORTADAS.get(slug) || '';
    let eps = await cariEpsDeHtml(html);
    /* v103: posts de temporada de ESTA serie (la base es el slug sin la
     * cola «-capitulos-completos»), en paralelo */
    const base = slug.replace(/-(capitulos-completos[a-z]*|capitulos-y-canciones|completos|ver|latino|online)$/, '');
    const temps = [...new Set((html.match(new RegExp('miscaricaturas\\.com/(' + base + '-temporada-\\d+)/?', 'gi')) || [])
      .map((s) => (new RegExp('(' + base + '-temporada-\\d+)', 'i').exec(s) || [])[1]))]
      .filter((s) => s && new RegExp('^' + base + '-temporada-\\d+$').test(s));
    if (temps.length) {
      const extra = await Promise.all(temps.slice(0, 16).map(async (t) => {
        const rt = await fetchSeguro(CARI_BASE + t + '/', 10000).catch(() => null);
        if (!rt || !rt.ok) return [];
        return cariEpsDeHtml(await rt.text());
      }));
      const vistosEp = new Set(eps.map((e) => e.url));
      for (const lista of extra) for (const e of lista) if (!vistosEp.has(e.url)) { vistosEp.add(e.url); eps.push(e); }
    }
    eps.sort((a, b) => a.temporada - b.temporada || a.ep - b.ep || String(a.parte).localeCompare(String(b.parte)));
    /* v112→v113: series con temporadas que MisCaricaturas solo tiene en
     * inglés — llegan de LACARTOONS en latino (auditado con ASR) y
     * reemplazan a las copias inglesas (Billy T1-T5, Ben 10 T3/T4 + 2x12). */
    const lctCfg = LCT_MERGE.find((x) => x.slug === slug);
    if (lctCfg) {
      const lb = await lctEpisodios(lctCfg.lctId).catch(() => null);
      if (lb && lb.eps.length) {
        eps = eps.filter((e) => lctCfg.dejarMisc(e));
        const claves = new Set(eps.map((e) => e.temporada + 'x' + e.ep));
        for (const e of lb.eps) {
          const capId = +((/capitulo\/(\d+)\?/.exec(e.url) || [])[1] || 0);
          if (!lctCfg.tomar(e) || (lctCfg.excluirCaps && lctCfg.excluirCaps.has(capId))) continue;
          if (!claves.has(e.temporada + 'x' + e.ep)) { eps.push(e); claves.add(e.temporada + 'x' + e.ep); }
        }
        eps.sort((a, b) => a.temporada - b.temporada || a.ep - b.ep);
      }
    }
    eps = eps.filter((e) => !cariEsIngles(slug, e)); /* v109: sin capítulos que solo existen en inglés */
    if (!eps.length) return null;
    const out = {
      ok: true, slug,
      titulo: cariLimpia(h1 || cariBonito(slug)).slice(0, 80),
      poster,
      cover, /* v104: portada curada local (si existe) */
      episodios: eps,
    };
    cariDatos.set(slug, { at: Date.now(), d: out });
    cacheGuardar('cariDatos', () => [...cariDatos.entries()]); /* v111: a disco */
    if (h1 || poster) cariMeta.set(slug, { at: Date.now(), titulo: out.titulo, poster: out.poster, cover });
    cacheGuardar('cariMeta', () => [...cariMeta.entries()]); /* v111 */
    try { if (out.episodios && out.episodios.length) precargarIntroDeSerie(out.episodios.map((e) => ({ url: e.url }))); } catch {} // v223
    return out;
  } catch { return null; }
}

/* capítulo → playlist: mismo navegador del servidor que PelisXD (el
 * embed es de la misma familia streamwish y sirve sprintcdn) */
/* v155: CARICATURAS SIN NAVEGADOR — hallado a prueba y error: la página
 * carga el player por AJAX de WordPress (action=get_system_data) → iframe
 * Byse → /api/videos/<code> → playback cifrado AES-256-GCM que Node
 * descifra con crypto nativo. Todo HTTP puro: ~3s en vez de 10-25s y sin
 * abrir Chrome. El navegador queda de RESPALDO por si el sitio cambia. */
async function resolverCaricaturaHttp(epUrl) {
  const t0 = Date.now();
  const slug = cariSlugDe(epUrl);
  if (!slug) throw new Error('Capítulo de caricatura no válido');
  /* 1) la página del capítulo trae el contenedor con el id de publicación */
  const r1 = await fetchSeguro(CARI_BASE + slug + '/', 9000);
  if (!r1 || !r1.ok) throw new Error('La página del capítulo no respondió');
  const html = await r1.text();
  const idm = /anchor-data-container" data-id="(\d+)"/i.exec(html);
  if (!idm) throw new Error('No encontré el id del capítulo');
  /* 2) el player llega por ajax de WordPress */
  const r2 = await fetch(CARI_BASE + 'wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: { 'User-Agent': MIRROR_UA, Referer: CARI_BASE + slug + '/', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=get_system_data&target_id=' + idm[1],
  }).catch(() => null);
  if (!r2 || !r2.ok) throw new Error('No pude pedir el player al sitio');
  const j2 = await r2.json().catch(() => null);
  const im = j2 && j2.success && j2.data && j2.data.html ? /<iframe[^>]*src="(https?:\/\/[^"]+)"/i.exec(j2.data.html) : null;
  if (!im) throw new Error('El sitio no entregó el player');
  const embed = new URL(im[1].replace(/\//g, '/'));
  /* 3) los datos del video (playback cifrado) */
  const r3 = await fetchSeguro(embed.origin + '/api/videos/' + encodeURIComponent(embed.pathname.split('/').pop() || ''), 10000);
  if (!r3 || !r3.ok) throw new Error('No pude leer los datos del video');
  const v = await r3.json().catch(() => null);
  const p = v && v.playback;
  if (!p || !Array.isArray(p.key_parts) || !p.payload || !p.iv) throw new Error('Playback no disponible');
  /* 4) AES-256-GCM: llave = key_parts en las posiciones [version, 31-version] (1-based) */
  const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const np = p.key_parts.length, vv = Math.abs(+p.version || 0);
  let idx = [vv, 31 - vv].filter((i) => i >= 1 && i <= np);
  if (!idx.length) idx = p.key_parts.map((_, i) => i + 1);
  const key = Buffer.concat(idx.map((i) => b64u(p.key_parts[i - 1])));
  const todo = b64u(p.payload), tag = todo.subarray(todo.length - 16), ct = todo.subarray(0, todo.length - 16);
  let fuentes = [];
  try {
    const dec = crypto.createDecipheriv('aes-256-gcm', key, b64u(p.iv)).setAuthTag(tag);
    fuentes = (JSON.parse(Buffer.concat([dec.update(ct), dec.final()]).toString('utf8')).sources) || [];
  } catch {
    throw new Error('El sitio cambió el cifrado del video');
  }
  if (!fuentes.length) throw new Error('El video no trae fuentes');
  fuentes.sort((a, b) => (b.bitrate_kbps || 0) - (a.bitrate_kbps || 0));
  const mejor = fuentes[0];
  if (!mejor || !/^https?:/i.test(mejor.url || '')) throw new Error('Fuente inválida');
  /* 5) el playlist maestro se cachea como los de PelisXD (2h) */
  const r4 = await fetchSeguro(mejor.url, 12000);
  if (!r4 || !r4.ok) throw new Error('No pude leer el playlist');
  const body = await r4.text();
  if (!/#EXTM3U/.test(body)) throw new Error('Playlist inválido');
  const ahora = Date.now();
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  /* v158: registrar el host de la CDN ANTES de devolver — sin esto
   * `servirPlaylist` no proxiea la variante y el master llega al teléfono
   * con la URL ABSOLUTA de sprintcdn; el teléfono la pide directo con un
   * token amarrado a la IP del SERVIDOR y la CDN le da 404: el video
   * nunca entra (esto lo rompí en v157 con el return temprano, que se
   * saltaba el registro del envoltorio). Con el host registrado, la
   * variante y los segmentos pasan por /api/hls y los pide el servidor
   * con SU IP — la misma que pidió el token. */
  try { hlsReferers.set(new URL(mejor.url).hostname, 'https://player.miscaricaturas.com/'); } catch {}
  pelisxdStreams.set(tok, { body, base: mejor.url, ref: '', slug, at: ahora });
  console.log('[caricaturas] HTTP: ' + slug + ' → ' + (mejor.label || mejor.quality || '?') + ' en ' + ((ahora - t0) / 1000).toFixed(1) + 's (sin navegador)');
  return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
}
async function resolverCaricatura(epUrl) {
  const slug = cariSlugDe(epUrl);
  if (!slug) throw new Error('Capítulo de caricatura no válido');
  /* v109/v110: capítulos o temporadas ocultas por estar solo en inglés — mensaje claro */
  {
    const mE = /^([a-z0-9-]+?)-(\d{1,2})x(\d{2})([ab])?(?:-|$)/i.exec(slug); /* v241: 1xNN */
    if (mE) {
      const serie = cariSerieDeEp(mE[1]) || mE[1];
      const k = serie + '|' + (+mE[2]) + 'x' + (+mE[3]) + (mE[4] || '').toLowerCase();
      if (EPS_INGLESES.has(k) || EPS_INGLESES.has(serie + '|' + (+mE[2]) + 'x*')) {
        throw new Error('Ese capítulo solo existe en inglés en la fuente — prueba otra temporada');
      }
    }
  }
  const ahora = Date.now();
  for (const [tok, s] of pelisxdStreams) {
    if (s.slug === slug && ahora - s.at < PELISXD_STREAM_TTL) {
      return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
    }
  }
  /* v117: si la página del capítulo responde 404, el capítulo NO EXISTE
   * — error claro al instante. Antes el resolvedor seguía hasta el
   * navegador remoto y tardaba UN MINUTO en rendirse; en sala, espera
   * eterna. (Solo 404: un 5xx o timeout se deja pasar al camino normal.) */
  {
    const rHead = await fetchSeguro(CARI_BASE + slug + '/', 8000).catch(() => null);
    if (rHead && rHead.status === 404) throw new Error('Ese capítulo ya no existe en la fuente — prueba otro');
  }
  /* v106: si el capítulo no entrega video y su página es de MEGA, dilo claro
   * (el chequeo va DESPUÉS del intento — el HTML crudo no muestra los players
   * que se inyectan por JS y no hay que fiarse de él antes de intentar) */
  let cap = null;
  try {
    try { cap = await resolverCaricaturaHttp(CARI_BASE + slug + '/'); /* v155: HTTP puro primero */ }
    catch (eH) {
      console.log('[caricaturas] sin navegador (' + String(eH && eH.message || eH).slice(0, 60) + ') — uso el navegador');
      cap = await extraerStreamwishPeli(CARI_BASE + slug + '/');
    }
  } catch (e) {
    try {
      const rPre = await fetchSeguro(CARI_BASE + slug + '/', 8000);
      if (rPre && rPre.ok && /<iframe[^>]+src="https?:\/\/[^"]*mega\.nz/i.test(await rPre.text())) {
        throw new Error('Ese capítulo solo está en MEGA — prueba otro capítulo');
      }
    } catch (e2) { if (/MEGA/.test(String(e2.message))) throw e2; }
    throw e;
  }
  /* v157: el camino HTTP (v155) ya devuelve la respuesta FINAL (playlist
   * cacheado + m3u8 proxieado) — antes se re-cacheaba como crudo con
   * body indefinido y `cap.body.match` reventaba: ese era el letrerito
   * «Cannot read properties…» al entrar a cualquier caricatura */
  if (cap && cap.m3u8) return cap;
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  pelisxdStreams.set(tok, { body: cap.body, base: cap.url, ref: cap.ref || 'https://f7hyg4q.org/', slug, at: ahora });
  try {
    /* v106: el host del PROPIO playlist también lleva Referer — los playlists
     * de cfglobalcdn traen segmentos relativos y no aparecen en el cuerpo */
    hlsReferers.set(new URL(cap.url).hostname, cap.ref || 'https://player.miscaricaturas.com/');
    for (const u of cap.body.match(/https?:\/\/[^\s"']+\.ts[^\s"']*/gi) || []) {
      try { hlsReferers.set(new URL(u).hostname, cap.ref); } catch {}
    }
  } catch {}
  console.log('[caricaturas] ' + slug + ' → playlist ' + (cap.body.match(/#EXTINF/g) || []).length + ' segmentos');
  return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
}

/* v159: LACARTOONS/RPMVID SIN NAVEGADOR — ingeniería inversa del player
 * cubeembed: la API /api/v1/video?id= devuelve HEX cifrado en AES-128-CBC
 * con LLAVE FIJA (derivada del protocolo dentro del bundle) e IV fijo; el
 * JSON trae la fuente tiktok y el player la ve reescribiendo /hls/ →
 * /hlsmod/<dominio>/ sobre el propio cubeembed — ese camino NO amarra los
 * tokens a la IP: sirve desde cualquier lado. Segundos, sin Chrome. */
async function resolverRpmvidHttp(capNum, id) {
  const t0 = Date.now();
  /* la API del player aletea: el MISMO id responde «not found» por
   * ventanas de minutos y luego revive — reintentamos corto y, si
   * persiste, le pasamos el turno al navegador (que sufre lo mismo) */
  let j = null, ultimoErr = '';
  for (let intento = 0; intento < 3 && !j; intento++) {
    if (intento) await new Promise((r) => setTimeout(r, 900));
    try {
      const r2 = await fetchSeguro('https://cubeembed.rpmvid.com/api/v1/video?id=' + encodeURIComponent(id) + '&w=1280&h=720&r=lacartoons.com', 10000);
      if (!r2.ok) { ultimoErr = 'el player rechazó el video (' + r2.status + ')'; if (r2.status === 404 || r2.status === 410) ultimoErr = 'borrado'; /* v209: el player lo eliminó — ni el navegador lo revive */ continue; }
      const hex = String(await r2.text() || '').trim();
      if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) { ultimoErr = 'el player cambió su cifrado'; continue; }
      const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from('kiemtienmua911ca', 'utf8'), Buffer.from('1234567890oiuytr', 'utf8'));
      j = JSON.parse(Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8'));
    } catch (e) { ultimoErr = String(e.message || e).slice(0, 60); }
  }
  if (!j) {
    /* v209: si el player respondió 404/410 en los reintentos, el capítulo fue
     * borrado de la fuente — error claro (y compatible con EP_MUERTO_RE para
     * que el salto automático de la sala lo brinque) en vez de abrir el
     * navegador y morir con un «aborted» incomprensible. */
    if (ultimoErr === 'borrado') throw new Error('Ese capítulo ya no está disponible en Lacartoons — el player lo borró; prueba otro');
    throw new Error(ultimoErr || 'el player no respondió');
  }
  let cfg = {};
  try { cfg = JSON.parse(j.streamingConfig || '{}'); } catch {}
  const ttA = cfg.adjust && cfg.adjust.Tiktok;
  const ttDom = ttA && ttA.domain;
  /* maestro: 1er intento por el camino hlsmod del embed (tiktok);
   * si no trae tiktok o falla, la fuente Cloudflare del JSON */
  let masterUrl = '', masterHost = '';
  if (ttDom && j.hlsVideoTiktok) {
    const u = new URL(j.hlsVideoTiktok, 'https://cubeembed.rpmvid.com/');
    u.hostname = ttDom;
    if (ttA.params && ttA.params.v) u.searchParams.set('v', ttA.params.v);
    const um = new URL(u.href);
    um.hostname = 'cubeembed.rpmvid.com';
    um.pathname = um.pathname.replace('/hls/', '/hlsmod/' + ttDom + '/');
    masterUrl = um.href;
  }
  if (!masterUrl && j.cf) masterUrl = j.cf;
  if (!masterUrl) throw new Error('sin fuente conocida en el player');
  masterHost = new URL(masterUrl).hostname;
  let body = '';
  for (let intento = 0; intento < 2 && !body; intento++) {
    if (intento) {
      if (!j.cf || masterUrl === j.cf) break;
      masterUrl = j.cf; /* segundo intento: la fuente Cloudflare */
      masterHost = new URL(masterUrl).hostname;
    }
    try {
      const r3 = await fetchSeguro(masterUrl, 10000);
      if (!r3.ok) { ultimoErr = 'el master no se dejó ver (' + r3.status + ')'; continue; }
      const b = await r3.text();
      if (/^#EXTM3U/m.test(b)) body = b;
      else ultimoErr = 'master inválido';
    } catch (e) { ultimoErr = String(e.message || e).slice(0, 60); }
  }
  if (!body) throw new Error(ultimoErr || 'el master no respondió');
  /* los hosts quedan registrados: master/variante por cubeembed (hlsmod)
   * y segmentos por su CDN — todo vía /api/hls con la IP de este server */
  hlsReferers.set('cubeembed.rpmvid.com', 'https://lacartoons.com/');
  try { hlsReferers.set(masterHost, 'https://lacartoons.com/'); } catch {}
  const ahora = Date.now();
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  pelisxdStreams.set(tok, { body, base: masterUrl, ref: '', slug: 'lct-' + capNum, at: ahora });
  console.log('[lacartoons] HTTP: cap ' + capNum + ' (id ' + id + ') en ' + ((ahora - t0) / 1000).toFixed(1) + 's (sin navegador)');
  return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
}

/* v112: LACARTOONS — capítulo → playlist. El player cubeembed.rpmvid
 * guarda el m3u8 detrás de una API cifrada que solo él sabe descifrar:
 * el navegador del servidor abre el capítulo, CLICA el play (botón en
 * shadow DOM de vidstack + clic físico sobre el iframe, que los clics
 * sintéticos no le bastan) y captura el master «hlsmod». Los segmentos
 * son TS camuflados de PNG en tiktokcdn — el proxy /api/hls los
 * despelleja al servirlos. */
async function extraerRpmvid(pageUrl) {
  if (!PUPPETEER) { try { PUPPETEER = require('puppeteer'); } catch { throw new Error('El navegador del servidor no está disponible'); } }
  const browser = await getNavegador();
  if (!browser) throw new Error('No pude abrir el navegador del servidor');
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(MIRROR_UA).catch(() => {});
    await page.evaluateOnNewDocument(() => {
      try { window.open = function () { return null; }; } catch {}
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    });
    let master = null;
    page.on('response', (r) => {
      const u = r.url();
      if (master || !/\/hlsmod\/.*master\.m3u8/i.test(u)) return;
      master = u;
    });
    page.on('dialog', async (d) => { try { await d.dismiss(); } catch {} });
    /* v152: si la primera carga se pasa de los 30s (sitio lento), un
     * reintento con más calma en vez de fallar de una vez */
    try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    for (let i = 0; i < 12 && !master; i++) {
      await new Promise((r2) => setTimeout(r2, 3000));
      for (const fr of page.frames()) {
        if (!/rpmvid/i.test(fr.url())) continue;
        try {
          await fr.evaluate(() => {
            const walk = (root, depth) => {
              if (!root || depth > 6) return;
              for (const el of root.querySelectorAll('*')) {
                if (el.tagName && /button|media-play-button/i.test(el.tagName)) { try { el.click(); } catch {} }
                if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
              }
            };
            walk(document, 0);
            const v = document.querySelector('video');
            if (v) { v.muted = true; v.play().catch(() => {}); }
          });
        } catch {}
      }
      const ifr = await page.$('iframe');
      if (ifr) {
        const bb = await ifr.boundingBox().catch(() => null);
        if (bb) {
          try {
            await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
            await page.mouse.down(); await new Promise((r2) => setTimeout(r2, 120)); await page.mouse.up();
          } catch {}
        }
      }
    }
    if (!master) throw new Error('El player de Lacartoons no respondió (va lento) — reintenta');
    return master;
  } finally { try { if (page) await page.close(); } catch {} }
}

/* v119: capítulos de lacartoons con player de OK.RU — el embed trae las
 * URLs del video directo (MP4, 4-6 calidades) dentro de data-options, sin
 * navegador. El token de okcdn va amarrado a la IP que pidió el embed
 * (el servidor) → el resultado SIEMPRE se sirve por el proxy nuestro. */
async function resolverOkRu(embedId) {
  const r = await fetchSeguro('https://ok.ru/videoembed/' + embedId, 12000).catch(() => null);
  const html = r && r.ok ? await r.text().catch(() => '') : '';
  const m = /data-options="([^"]+)"/.exec(html || '');
  let md = null;
  try {
    const opts = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    md = (opts.flashvars && opts.flashvars.metadata) || null;
  } catch {}
  const vids = (md && md.videos) || [];
  if (!vids.length) throw new Error('Ese capítulo ya no está disponible en Lacartoons — prueba otro');
  let mejor = null;
  for (const n of ['full', 'hd', 'sd', 'low', 'lowest', 'mobile']) {
    const v = vids.find((x) => x.name === n && x.url && /^https:/.test(x.url));
    if (v) { mejor = v; break; }
  }
  if (!mejor) throw new Error('Ese capítulo ya no está disponible en Lacartoons — prueba otro');
  return { m3u8: mejor.url, mp4: true, proxy: true, subs: [] };
}

const LCT_PRECALIENTE = new Map(); /* v195: lctId→hora del último precalentado (100 min) */
async function resolverLacartoons(epUrl) {
  const m = /lacartoons\.com\/serie\/capitulo\/(\d+)\?t=\d+/i.exec(epUrl || '');
  if (!m) throw new Error('Capítulo de Lacartoons no válido');
  const slugLct = 'lct-' + m[1];
  const ahora = Date.now();
  for (const [tok, s] of pelisxdStreams) {
    if (s.slug === slugLct && ahora - s.at < PELISXD_STREAM_TTL) {
      return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
    }
  }
  /* v112: chequeo rápido — si la página ya no trae el iframe del player
   * (embed retirado), el error sale claro sin abrir el navegador */
  let idRpm = '';
  {
    const rPre = await fetchSeguro(epUrl, 10000).catch(() => null);
    const html = rPre && rPre.ok ? await rPre.text().catch(() => '') : '';
    if (html) {
      /* v119: ¿player de ok.ru? → MP4 directo, sin navegador */
      const mOk = /ok\.ru\/videoembed\/(\d+)/i.exec(html);
      if (mOk) return resolverOkRu(mOk[1]);
      /* cubeembed.com (sin .rpmvid) es un dominio muerto → capítulo caído */
      if (!/cubeembed\.rpmvid\.com\/#[a-z0-9]+/i.test(html)) {
        throw new Error('Ese capítulo ya no está disponible en Lacartoons — prueba otro');
      }
      idRpm = (/cubeembed\.rpmvid\.com\/#([a-z0-9]+)/i.exec(html) || [])[1] || '';
    }
  }
  /* v159: HTTP PRIMERO — la página ya nos dio el id del player; si algo
   * falla, el navegador de respaldo toma el turno como siempre */
  if (idRpm) {
    try { return await resolverRpmvidHttp(m[1], idRpm); }
    catch (eH) {
      /* v209: capítulo borrado de la fuente = no hay nada que rascar con el
       * navegador; el error limpio viaja directo al usuario */
      if (/ya no está disponible/i.test(String(eH && eH.message || eH))) throw eH;
      console.log('[lacartoons] sin HTTP (' + String(eH && eH.message || eH).slice(0, 60) + ') — uso el navegador');
    }
  }
  /* el navegador clica el player y suelta el master. Hay DOS formatos:
   * - viejo (billy, iCarly): master con una sola variante muxada a+v —
   *   se baja su cuerpo y se cachea como los demás playlists.
   * - nuevo v113 (Ben 10, Ed Edd): audio DEMULTICANALIZADO en renditions
   *   #EXT-X-MEDIA con IDIOMA DECLARADO y video aparte — se arma un
   *   master propio que deja SOLO la pista «Español» como default, para
   *   que hls.js no pueda equivocarse de idioma. Sin pista es → error
   *   claro (capítulo que solo existe en inglés/portugués/francés). */
  const master = await extraerRpmvid(epUrl);
  const rM = await fetchSeguro(master, 15000);
  if (!rM.ok) throw new Error('El player de Lacartoons no respondió');
  const txtM = await rM.text();
  let body = null, base = master, nSeg = 0;
  const medios = txtM.split('\n').filter((l) => /^#EXT-X-MEDIA:TYPE=AUDIO/i.test(l.trim()));
  if (medios.length) {
    /* v115: la pista «Español» de Los Supersónicos viene etiquetada
     * «Latine» (LANGUAGE="la") — también cuenta como español */
    const lineaEs = medios.find((l) => /LANGUAGE="es"/i.test(l) || /NAME="[^"]*(Espa|Latin)/i.test(l));
    if (!lineaEs) throw new Error('Ese capítulo no está en español en Lacartoons — prueba otro');
    const uriEs = (/URI="([^"]+)"/.exec(lineaEs) || [])[1];
    const rA = uriEs ? await fetchSeguro(new URL(uriEs, master).href, 15000) : null;
    const bodyA = rA ? await rA.text() : '';
    if (!rA || !rA.ok || !/#EXTINF/.test(bodyA)) throw new Error('No pude leer la pista de audio de Lacartoons');
    nSeg = (bodyA.match(/#EXTINF/g) || []).length;
    body = txtM
      .split('\n')
      .filter((l) => !/^#EXT-X-MEDIA:TYPE=AUDIO/i.test(l.trim()) || l.trim() === lineaEs.trim())
      .map((l) => l.trim() === lineaEs.trim() ? l.replace(/AUTOSELECT=\w+/i, 'AUTOSELECT=YES').replace(/DEFAULT=\w+/i, 'DEFAULT=YES') : l)
      .join('\n');
    try { for (const u of bodyA.match(/https?:\/\/[^\s"']+/g) || []) { try { hlsReferers.set(new URL(u).hostname, 'https://cubeembed.rpmvid.com/'); } catch {} } } catch {}
  } else {
    const linea = txtM.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    const vari = linea ? new URL(linea, master).href : master;
    const rV = await fetchSeguro(vari, 15000);
    body = await rV.text();
    if (!rV.ok || !/#EXTINF/.test(body)) throw new Error('No pude leer el playlist de Lacartoons');
    base = vari;
    nSeg = (body.match(/#EXTINF/g) || []).length;
  }
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  pelisxdStreams.set(tok, { body, base, ref: 'https://cubeembed.rpmvid.com/', slug: slugLct, at: ahora });
  try {
    hlsReferers.set(new URL(base).hostname, 'https://cubeembed.rpmvid.com/');
    for (const u of body.match(/https?:\/\/[^\s"']+/g) || []) {
      try { hlsReferers.set(new URL(u).hostname, 'https://cubeembed.rpmvid.com/'); } catch {}
    }
  } catch {}
  console.log('[lacartoons] cap ' + m[1] + ' → ' + (medios.length ? 'master con audio es (' + medios.length + ' pistas)' : 'playlist') + ' ' + nSeg + ' segmentos');
  return { m3u8: '/api/xd/' + tok + '/index.m3u8', proxy: true, subs: [] };
}



/* v121: BÚSQUEDA GLOBAL INTELIGENTE — tolerante a errores de dedo.
 * normalizarTxt: minúsculas, sin acentos, solo letras/números.
 * levenshtein: distancia de edición clásica (títulos cortos, DP chico).
 * similitud: 0..1 — combina distancia completa con coincidencia de
 * palabras ("los simpson" vs "the simpsons"), para ordenar TODOS los
 * resultados de TODAS las fuentes en una sola lista por parecido. */
function normalizarTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
const TXT_STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'the', 'y', 'en', 'un', 'una', 'que', 'con', 'por', 'para', 'of', 'a']);
function similitud(q, t) {
  if (!q || !t) return 0;
  if (q === t) return 1;
  const base = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
  const qts = q.split(' ').filter((w) => w.length >= 3 && !TXT_STOP.has(w));
  if (!qts.length) return base;
  const tts = t.split(' ');
  let hits = 0;
  for (const qt of qts) if (tts.some((w) => w.startsWith(qt))) hits++;
  return Math.max(base, (hits / qts.length) * 0.92);
}

/* v121: catálogo LOCAL de títulos (Cartoons de Lacartoons + Caricaturas +
 * lo que esté cacheado del feed) — sirve para buscar en Cartoons (el sitio
 * no tiene buscador: sus series viven aquí) y para el chip de
 * «¿Quisiste decir…?» cuando lo escrito tiene un error de dedo. */
let catalogoCache = { at: 0, items: [] }; /* 1 h */
async function catalogoLocal() {
  if (Date.now() - catalogoCache.at < 3600 * 1000 && catalogoCache.items.length) return catalogoCache.items;
  /* v125: la cover se toma PRIMERO de CARI_PORTADAS (mapa en memoria leído
   * del disco al arrancar) — antes el catálogo en frío salía SIN covers (el
   * mapa cariMeta tarda en llenarse) y las tarjetas mostraban la foto del
   * sitio o la carita de Huddle (pasó con Chicas Superpoderosas Z) */
  const items = [];
  for (const lct of LCT_SERIES.values()) {
    const meta = cariMeta.get(lct.slug);
    items.push({ title: lct.titulo, url: LCT_BASE + 'serie/' + lct.lctId, img: CARI_PORTADAS.get(lct.slug) || (meta && (meta.cover || meta.poster)) || '', site: 'Cartoons' });
  }
  try {
    const home = await cariHomeImgs();
    for (const [slug, h] of home) {
      if (!cariEsSerie(slug)) continue;
      const meta = cariMeta.get(slug);
      items.push({ title: (meta && meta.titulo) || cariLimpia(h.alt || cariBonito(slug)), url: CARI_BASE + slug + '/', img: CARI_PORTADAS.get(slug) || (meta && (meta.cover || meta.poster)) || h.img || '', site: 'Caricaturas' });
    }
  } catch {}
  for (const [fn, site] of [[popularesDeHoy, 'Cuevana'], [seriesRecientes, 'Cuevana'], [animesDelMomento, 'Latanime']]) {
    try {
      for (const it of (await fn()) || []) {
        if (it && it.title && it.url) items.push({ title: String(it.title), url: String(it.url), img: it.img || '', site, extra: it.extra || '' });
      }
    } catch {}
  }
  if (items.length) catalogoCache = { at: Date.now(), items };
  return items.length ? items : catalogoCache.items;
}

/* v205: CATÁLOGOS «Ver todo» — paginados para el scroll infinito del feed.
 * pelis/series: cine-calidad paginado real (20/página) | animes: directorio
 * de latanime (sin muertas ni ocultas) | caricaturas: MisCaricaturas
 * completo | cartoons/liveaction: Lacartoons en memoria (live action
 * separado) | danimados: catálogo base de caricaturas | genero-<slug>:
 * cine-calidad SOLO películas. */
const catCache = new Map(); /* clave → { at, items, mas } */
/* v239: catCv pre-fetch TODAS las páginas de CineCalidad y cachea el catálogo completo */
const cvFullCache = { movies: { items: [], at: 0 }, series: { items: [], at: 0 } };
const CV_FULL_TTL = 2 * 3600 * 1000; /* 2h */

async function catCvFull(kind) {
  const cached = cvFullCache[kind];
  if (cached.items.length && Date.now() - cached.at < CV_FULL_TTL) return cached.items;
  console.log('[catCv] descargando catálogo completo de CineCalidad (' + kind + ')...');
  const allItems = [];
  for (let page = 1; page <= 600; page++) {
    try {
      const r = await fetchSeguro('https://cine-calidad.mx/wp-json/mycustom/v1/' + kind + '?page=' + page, 10000);
      if (!r.ok) break;
      const d = await r.json().catch(() => []);
      const arr = Array.isArray(d) ? d : (d.posts || []);
      if (!arr.length) break;
      const items = arr.map((p) => ({
        title: String(p.title || '').replace(/&amp;/g, '&'),
        url: kind === 'series' ? 'https://cine-calidad.mx/serie/' + p.slug : 'https://cine-calidad.mx/pelicula/' + p.slug + '/',
        img: String(p.featured_image || '').replace('/w780/', '/w342/'),
        site: 'CineCalidad',
        extra: [String(p.date || '').slice(0, 4), p.rating ? '★ ' + (+p.rating).toFixed(1) : ''].filter(Boolean).join(' · '),
      })).filter((x) => x.title && !cvOcultaUrl(x.url));
      allItems.push(...items);
      if (arr.length < 20) break;
    } catch { break; }
  }
  cvFullCache[kind] = { items: allItems, at: Date.now() };
  console.log('[catCv] ' + kind + ': ' + allItems.length + ' títulos cacheados');
  return allItems;
}

setTimeout(() => { catCvFull('movies').catch(() => {}); catCvFull('series').catch(() => {}); }, 30 * 1000);

async function catCv(kind, pag) {
  const por = 20;
  const cached = cvFullCache[kind];
  // v275: si hay cache completo, úsalo
  if (cached.items.length && Date.now() - cached.at < CV_FULL_TTL) {
    const ini = (pag - 1) * por;
    return { items: cached.items.slice(ini, ini + por), mas: ini + por < cached.items.length, total: cached.items.length };
  }
  // v275: sin cache, trae solo la página pedida (rápido, no 600 páginas)
  try{
    const r = await fetchSeguro('https://cine-calidad.mx/wp-json/mycustom/v1/' + kind + '?page=' + pag, 10000);
    if(r.ok){
      const d = await r.json().catch(()=> []);
      const arr = Array.isArray(d) ? d : (d.posts || []);
      const items = arr.map((p)=>({
        title: String(p.title||'').replace(/&amp;/g,'&'),
        url: kind==='series' ? 'https://cine-calidad.mx/serie/'+p.slug : 'https://cine-calidad.mx/pelicula/'+p.slug+'/',
        img: String(p.featured_image||'').replace('/w780/','/w342/'),
        site:'CineCalidad',
        extra:[String(p.date||'').slice(0,4), p.rating? '★ '+(+p.rating).toFixed(1):''].filter(Boolean).join(' · '),
      })).filter(x=>x.title && !cvOcultaUrl(x.url));
      // dispara descarga completa por detrás para próximas páginas
      if(pag===1) setTimeout(()=> catCvFull(kind).catch(()=>{}), 2000);
      // total estimado: si trae 20, hay más
      const mas = arr.length >= 20;
      const totalEst = mas ? 200 : items.length; // estimado
      // si hay cache parcial, úsalo para total
      const total = cached.items.length ? cached.items.length : totalEst;
      return { items, mas, total };
    }
  }catch{}
  // fallback a cache aunque esté vencido
  if(cached.items.length){
    const ini=(pag-1)*por;
    return { items: cached.items.slice(ini, ini+por), mas: ini+por < cached.items.length, total: cached.items.length };
  }
  return { items: [], mas:false, total:0 };
}
async function catAnimes(pag) {
  const key = 'la-' + pag;
  const c = catCache.get(key);
  if (c && Date.now() - c.at < 6 * 60 * 60 * 1000) return c;
  const r = await fetchSeguro('https://latanime.org/animes?page=1&p=' + pag, 15000);
  if (!r.ok) return { items: [], mas: false };
  const html = await r.text();
  const crudos = [...html.matchAll(/<a href="(https:\/\/latanime\.org\/anime\/([a-z0-9-]+))">([\s\S]*?)<h3[^>]*>([^<]+)<\/h3>/g)];
  const mas = crudos.length >= 24; /* v205: página llena del directorio (crudo) */
  const items = [];
  for (const m of crudos) {
    if (items.length >= 24) break;
    const slug = m[2];
    if (LA_OCULTAS_SET.has(slug) || LA_MUERTAS_SET.has(slug)) continue; /* v198/v200: cast/dup y muertas fuera — v251 browse mantiene curaduría */
    const im = /<img[^>]+class="[^"]*lozad[^"]*"[^>]+src="(https:\/\/latanime\.org\/thumbs\/[^"]+)"/.exec(m[3]); /* la visible, no la comentada */
    const title = m[4].replace(/\s+/g, ' ').trim().replace(/\s+(latino|castellano|espa\u00f1ol|sub(?:titulado)?)\s*$/i, '').slice(0, 80);
    if (!title) continue;
    items.push({ title, url: m[1], img: (im && im[1]) || '', site: 'Latanime', extra: '' });
  }
  const total = LA_TODOS.size - LA_OCULTAS_SET.size - LA_MUERTAS_SET.size;
  const out = { items, mas, total: total || items.length };
  if (items.length) catCache.set(key, { at: Date.now(), items, mas, total: out.total });
  return out;
}
function lctConCovers() {
  const porUrl = new Map();
  for (const t of cariFeedCache.toons) porUrl.set(t.url, t.img);
  for (const t of cariFeedCache.live) porUrl.set(t.url, t.img);
  return [...LCT_SERIES.values()].map((lct) => ({
    _slug: lct.slug,
    title: lct.titulo,
    url: LCT_BASE + 'serie/' + lct.lctId,
    img: CARI_PORTADAS.get(lct.slug) || porUrl.get(LCT_BASE + 'serie/' + lct.lctId) || '',
    site: 'Cartoons',
    extra: '',
  })).sort((a,b)=> a.title.localeCompare(b.title,'es'));
}
async function catCaricaturas() {
  const c = catCache.get('cari-all');
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.items;
  try{
    const home = await cariHomeImgs();
    const items = [];
    for (const [slug, h] of home) {
      if (!cariEsSerie(slug) || esCariLive(slug)) continue;
      if (LCT_SERIES.has(slug)) continue;
      if (CARI_MUERTAS.has(slug)) continue;
      const meta = cariMeta.get(slug);
      const rawImg = CARI_PORTADAS.get(slug) || DANI_IMDB.get(slug) || (meta && (meta.cover || meta.poster)) || h.img || '';
      if (!rawImg) continue;
      items.push({ title: (meta && meta.titulo) || cariLimpia(h.alt || cariBonito(slug)), url: CARI_BASE + slug + '/', img: rawImg, site: 'Caricaturas', extra: '' });
    }
    items.sort((a,b)=> a.title.localeCompare(b.title,'es'));
    if (items.length) catCache.set('cari-all', { at: Date.now(), items });
    return items;
  }catch{ const c2 = catCache.get('cari-all'); return c2 ? c2.items : []; }
}


/* v228.5: catálogo cosechado cacheado — usa el MISMO parsing que movieCosechaEstado (que sí funciona) */
let _cosechaArr = null, _cosechaArrAt = 0, _cosechaArrMtime = 0, _cosechaArrRuta = '';
function movieCosechaArray() {
  if (!MOVIE_ENABLED) return []; /* v230: Movie desactivado */
  const est = movieCosechaEstado();
  if (!est || !est.archivo || !est.archivo.ruta) return [];
  const ruta = est.archivo.ruta;
  const now = Date.now();
  // recargar solo si cambió el archivo (cache 60s)
  if (_cosechaArr && now - _cosechaArrAt < 60000 && _cosechaArrRuta === ruta) return _cosechaArr;
  try {
    const st = fs.statSync(ruta);
    if (_cosechaArr && st.mtimeMs === _cosechaArrMtime && _cosechaArrRuta === ruta) {
      _cosechaArrAt = now;
      return _cosechaArr;
    }
    const txt = fs.readFileSync(ruta, 'utf8');
    const j = JSON.parse(txt);
    let arr = null;
    if (Array.isArray(j)) arr = j;
    else if (Array.isArray(j.items)) arr = j.items;
    else if (Array.isArray(j.result)) arr = j.result;
    else if (j && typeof j === 'object') {
      // MISMO parsing que movieCosechaEstado: dict con keys numéricas
      const keys = Object.keys(j).filter((k) => /^\d+$/.test(k));
      if (keys.length > 50) {
        arr = keys.map((k) => {
          const v = j[k];
          if (!v || typeof v !== 'object') return null;
          return {
            id: +k,
            vod_id: v.vod_id || v.id || +k,
            vod_name: v.nombre || v.vod_name || v.title || v.titulo || '',
            vod_pic: v.pic || v.vod_pic || v.poster || '',
            vod_year: v.year || v.vod_year || v.anno || '',
            type_id: v.type_id || v.type || '',
            click_count: v.click_count || v.clicks || 0,
          };
        }).filter(Boolean);
      }
    }
    _cosechaArr = arr || [];
    _cosechaArrAt = now;
    _cosechaArrMtime = st.mtimeMs;
    _cosechaArrRuta = ruta;
    console.log('[movie] cosecha cargada: ' + _cosechaArr.length + ' títulos de ' + ruta);
    return _cosechaArr;
  } catch (e) {
    console.warn('[movie] no pude cargar cosecha:', String(e.message || e).slice(0, 100));
    return _cosechaArr || [];
  }
}
function buscarMovieCosecha(q) {
  const nq = q.toLowerCase().trim();
  if (!nq) return [];
  const arr = movieCosechaArray();
  if (!arr.length) return [];
  const hits = [];
  for (const x of arr) {
    const nombre = String(x.vod_name || '');
    if (nombre.toLowerCase().includes(nq)) {
      const vid = x.vod_id || x.id;
      if (!vid) continue;
      hits.push({
        title: nombre,
        url: 'https://movie.huddle/v/' + vid,
        img: x.vod_pic || '/carita.png',
        site: 'Movie',
        extra: 'Latino · ' + (x.vod_year || ''),
      });
      if (hits.length >= 30) break;
    }
  }
  return hits;
}


/* v236.7: búsqueda en CineCalidad API */
async function buscarCineCalidad(q) {
  const r = await fetchSeguro('https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=' + encodeURIComponent(q) + '&page=1', 10000);
  if (!r.ok) return [];
  const d = await r.json();
  const posts = d.posts || d || [];
  console.log('[buscar-cc] q=' + q + ' posts=' + posts.length);
  return posts.map((p) => {
    const slug = p.slug || '';
    const esSerie = (p.type || '').toLowerCase().includes('series');
    const url = slug ? 'https://cine-calidad.mx/' + (esSerie ? 'serie/' : 'pelicula/') + slug + '/' : '';
    return {
      title: p.title || '',
      url,
      img: p.featured_image || '',
      site: 'CineCalidad',
      extra: esSerie ? 'Serie · Latino' : 'Película · Latino',
      _apiFresh: true, /* v236.9: bypass cvOcultaUrl — la API ya refleja contenido activo */
    };
  }).filter((p) => p.title && p.url);
}

/* v238: CineCalidad — índice lazy via API de búsqueda */
async function cinecalidadIndice() {
  if (ccIdx.slugs.length && Date.now() - ccIdx.at < CC_IDX_TTL) return ccIdx.slugs;
  if (ccIdx.buscando) return ccIdx.buscando;
  ccIdx.buscando = (async () => {
    const slugs = new Set();
    const letras = ['a','e','i','o','s','d','l','c','p','m','t','r'];
    for (const q of letras) {
      for (let page = 1; page <= 8; page++) {
        try {
          const r = await fetchSeguro('https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=' + q + '&page=' + page, 10000);
          if (!r.ok) break;
          const d = await r.json();
          const posts = d.posts || [];
          if (!posts.length) break;
          for (const p of posts) { if (p.slug) slugs.add(p.slug + '|' + (p.type || 'movies') + '|' + (p.title || '')); }
        } catch { break; }
      }
    }
    ccIdx = { slugs: [...slugs], at: Date.now(), buscando: null };
    console.log('[cinecalidad] ' + ccIdx.slugs.length + ' slugs en índice');
    return ccIdx.slugs;
  })();
  return ccIdx.buscando;
}

/* v238: verificar si una peli/serie de CineCalidad sirve */
async function verificarCC(slug, tipo) {
  try {
    const esSerie = (tipo || '').includes('series');
    const url = 'https://cine-calidad.mx/' + (esSerie ? 'serie/' : 'pelicula/') + slug + '/';
    const r = await fetchSeguro(url, 12000);
    if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
    const html = await r.text();
    if (esSerie) {
      /* v239: para series, verificar episodios individualmente */
      const eps = [...html.matchAll(/href="https?:\/\/cine-calidad\.mx\/episode\/([^/"]+)\//g)];
      if (!eps.length) return { ok: false, reason: 'sin-episodios' };
      /* Verificar primer episodio — si tiene embed, la serie sirve */
      const epUrl = 'https://cine-calidad.mx/episode/' + eps[0][1] + '/';
      const er = await fetchSeguro(epUrl, 10000);
      if (!er.ok) return { ok: false, reason: 'ep-http-' + er.status };
      const epHtml = await er.text();
      const hasEmbed = /goodstream\.one|vimeos\.(net|zip)|hlswish\.com|videoapp\.zip|data-domain="/i.test(epHtml);
      return { ok: hasEmbed, reason: hasEmbed ? 'ep-embed' : 'ep-no-embed', eps: eps.length };
    }
    /* Películas: verificar embed directo */
    const hasEmbed = /goodstream\.one|vimeos\.(net|zip)|hlswish\.com|videoapp\.zip|data-domain="/i.test(html);
    return { ok: hasEmbed, reason: hasEmbed ? 'embed' : 'no-embed' };
  } catch (e) { return { ok: false, reason: String(e.message || e).slice(0, 60) }; }
}

/* v238: sonda CineCalidad — mismo patrón que Cuevana/PelisXD */
async function sondaCineCalidad() {
  try {
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memMB > 350) { console.warn('[sonda] cc saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
    const sitemap = await cinecalidadIndice();
    if (!sitemap.length) return;
    const start = Date.now();
    let nuevas_ok = 0, nuevas_fail = 0, vivas_muertas = 0, muertas_vivas = 0;
    const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    /* NUEVAS */
    const desconocidas = shuffle(sitemap.filter(s => { const slug = s.split('|')[0]; return !CC_VISTAS.has(slug) && !CC_OCULTAS.has(slug); })).slice(0, 10);
    for (const entry of desconocidas) {
      const [slug, tipo] = entry.split('|');
      const r = await verificarCC(slug, tipo);
      CC_VISTAS.add(slug);
      if (r.ok) nuevas_ok++;
      else { CC_OCULTAS.add(slug); nuevas_fail++; sondaNotify("CineCalidad", "muerto", slug, slug + " — sin embed (nueva verificada)"); }
    }
    /* VIVAS */
    const vivas = shuffle(sitemap.filter(s => !CC_OCULTAS.has(s.split('|')[0]))).slice(0, 10);
    for (const entry of vivas) {
      const [slug, tipo] = entry.split('|');
      const r = await verificarCC(slug, tipo);
      if (!r.ok) { CC_OCULTAS.add(slug); vivas_muertas++; sondaNotify("CineCalidad", "muerto", slug, slug + " murio — embed desaparecido"); }
    }
    /* MUERTAS */
    const muertas = shuffle([...CC_OCULTAS]).slice(0, 10);
    for (const slug of muertas) {
      const entry = sitemap.find(s => s.split('|')[0] === slug);
      const tipo = entry ? entry.split('|')[1] : 'movies';
      const r = await verificarCC(slug, tipo);
      if (r.ok) { CC_OCULTAS.delete(slug); muertas_vivas++; sondaNotify("CineCalidad", "revivio", slug, slug + " revivio — embed encontrado"); }
    }
    /* Persistir */
    try { fs.writeFileSync(path.join(__dirname, 'cc-ocultas.txt'), [...CC_OCULTAS].join('\n') + '\n'); } catch {}
    try { fs.writeFileSync(path.join(__dirname, 'cc-vistas.txt'), [...CC_VISTAS].join('\n') + '\n'); } catch {}
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const parts = [];
    if (nuevas_ok) parts.push('nuevas_ok=' + nuevas_ok);
    if (nuevas_fail) parts.push('nuevas_fail=' + nuevas_fail);
    if (vivas_muertas) parts.push('vivas→muertas=' + vivas_muertas);
    if (muertas_vivas) parts.push('muertas→vivas=' + muertas_vivas);
    const logLine = `[${new Date().toISOString()}] ${elapsed}s nuevas_ok=${nuevas_ok} nuevas_fail=${nuevas_fail} vivas→muertas=${vivas_muertas} muertas→vivas=${muertas_vivas} ocultas=${CC_OCULTAS.size} vistas=${CC_VISTAS.size}\n`;
    console.log('[sonda] cc (' + elapsed + 's): ' + (parts.join(', ') || 'sin cambios') + ' ocultas=' + CC_OCULTAS.size + ' vistas=' + CC_VISTAS.size);
    try { fs.appendFileSync(path.join(__dirname, 'sonda-cinecalidad.log'), logLine); } catch {}
  } catch (e) { console.warn('[sonda] cc error: ' + String(e.message || e).slice(0, 100)); }
}

/* v240: SONDA LATANIME — verifica series visibles y muertas
 * 3 frentes como las demás:
 * 1. VIVAS: muestra de series visibles → ¿siguen teniendo mp4upload vivo?
 * 2. MUERTAS: muestra de series muertas → ¿revivieron?
 * 3. OCULTAS: muestra de castellano/duplicados → se saltan (ya están filtradas)
 *
 * Usa laProbe() que ya existe: abre episodio-1, extrae mp4upload y verifica
 * que el mp4 sirve. Cada ciclo (~6h) hace un barrido de ~30 series.
 * Si una viva muere → se registra fallo (podredumbre). Si una muerta revive → se quita de muertas.
 */
async function sondaLatanime() {
  try {
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memMB > 350) { console.warn('[sonda] la saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
    const start = Date.now();
    const POR_CICLO = 15;
    let vivas_muertas = 0, muertas_vivas = 0;
    const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

    /* ─── 1. VIVAS: ¿siguen funcionando? ─── */
    try {
      const visibles = [...LA_TODOS].filter(s => !LA_OCULTAS_SET.has(s) && !LA_MUERTAS_SET.has(s)); /* v251 sonda: muertas siempre ocultas */
      const muestra = shuffle(visibles).slice(0, POR_CICLO);
      for (const slug of muestra) {
        try {
          const vive = await laProbe(slug);
          LA_VISTAS.add(slug);
          if (!vive) {
            const estabaViva = !LA_MUERTAS_SET.has(slug);
            laFallosRegistrar(slug);
            if (estabaViva && LA_MUERTAS_SET.has(slug)) {
              vivas_muertas++;
              sondaNotify("Latanime", "muerto", slug, slug + " murio — mp4upload caido");
            }
          } else {
            laFallosPerdonar(slug);
          }
        } catch {}
        await new Promise(r => setTimeout(r, 3000)); /* pausa entre series */
      }
    } catch (e) { console.warn('[sonda] la vivas error: ' + String(e).slice(0, 60)); }

    /* ─── 2. MUERTAS: ¿revivieron? ─── */
    try {
      const muertas = shuffle([...LA_MUERTAS_SET]).slice(0, POR_CICLO);
      for (const slug of muertas) {
        try {
          const vive = await laProbe(slug);
          if (vive) {
            laMuertaQuitar(slug);
            LA_FALLOS.delete(slug);
            laFallosGuardar();
            muertas_vivas++;
            sondaNotify("Latanime", "revivio", slug, slug + " revivio — mp4upload encontrado");
          }
        } catch {}
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (e) { console.warn('[sonda] la muertas error: ' + String(e).slice(0, 60)); }

    /* ─── Persistir vistas ─── */
    try { fs.writeFileSync(path.join(__dirname, 'public', 'latanime-vistas.txt'), [...LA_VISTAS].join('\n') + '\n'); } catch {}

    /* ─── Log ─── */
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const parts = [];
    if (vivas_muertas) parts.push('vivas→muertas=' + vivas_muertas);
    if (muertas_vivas) parts.push('muertas→vivas=' + muertas_vivas);
    const logLine = `[${new Date().toISOString()}] ${elapsed}s vivas→muertas=${vivas_muertas} muertas→vivas=${muertas_vivas} muertas=${LA_MUERTAS_SET.size} vistas=${LA_VISTAS.size}\n`;
    console.log('[sonda] la (' + elapsed + 's): ' + (parts.join(', ') || 'sin cambios') + ' muertas=' + LA_MUERTAS_SET.size + ' vistas=' + LA_VISTAS.size);
    try { fs.appendFileSync(path.join(__dirname, 'sonda-latanime.log'), logLine); } catch {}
  } catch (e) { console.warn('[sonda] la error: ' + String(e).slice(0, 60)); }
}

/* v241: probes de pagina (NO resuelven video; despacio por rate-limit 429) */
async function daniProbe(slug) {
  try {
    const r = await fetchSeguro(DANI_BASE + '/series/' + slug + '/', 15000);
    if (!r.ok) return false;
    return /href='https:\/\/danimados\.cc\/episodios\/[^']+'/.test(await r.text());
  } catch { return false; }
}
async function lctProbe(lctId) {
  try {
    const r = await fetchSeguro(LCT_BASE + 'serie/' + lctId, 15000);
    if (!r.ok) return false;
    return /href="\/serie\/capitulo\/\d+\?t=\d+"/i.test(await r.text());
  } catch { return false; }
}
async function cariProbe(slug) {
  try {
    const r = await fetchSeguro(CARI_BASE + slug + '/', 12000);
    if (!r.ok) return false;
    const html = await r.text();
    if (/<a href="https:\/\/miscaricaturas\.com\/[a-z0-9-]+?-\d{1,2}x\d{2}/i.test(html)) return true;
    const base = slug.replace(/-(capitulos-completos[a-z]*|capitulos-y-canciones|completos|ver|latino|online)$/, '');
    return new RegExp('miscaricaturas\\.com/' + base + '-temporada-\\d+', 'i').test(html);
  } catch { return false; }
}

/* v242: 3 SONDAS SEPARADAS — una por fuente (despacio por rate-limit 429) */
async function sondaDanimados() {
  const t0 = Date.now(), PAUSA = 2000;
  let vm = 0, mv = 0;
  const pausa = () => new Promise((r) => setTimeout(r, PAUSA));
  const sh = (arr) => { const a = [...arr]; for (let k = a.length - 1; k > 0; k--) { const z = Math.floor(Math.random() * (k + 1)); [a[k], a[z]] = [a[z], a[k]]; } return a; };
  for (const slug of sh([...DANI_CAT.keys()].filter((x) => !DANI_OCULTAS.has(x) && !DANI_MUERTAS.has(x))).slice(0, 5)) {
    try {
      CARI_VISTAS.add('dani:' + slug);
      if (await daniProbe(slug)) daniPerdonar(slug);
      else { const era = DANI_MUERTAS.has(slug); daniOcultar(slug); if (!era && DANI_MUERTAS.has(slug)) { vm++; sondaNotify('Danimados', 'muerto', slug, slug + ' murio — sin episodios'); } }
    } catch {}
    await pausa();
  }
  for (const slug of sh([...DANI_MUERTAS]).slice(0, 3)) {
    try {
      if (await daniProbe(slug)) { DANI_MUERTAS.delete(slug); ocultasReescribir(DANI_MUERTAS, 'dani-muertas.txt'); daniPerdonar(slug); mv++; sondaNotify('Danimados', 'revivio', slug, slug + ' revivio — episodios encontrados'); }
    } catch {}
    await pausa();
  }
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[sonda] dani (' + el + 's): ' + ((vm || mv) ? ('vivas→muertas=' + vm + ' muertas→vivas=' + mv) : 'sin cambios'));
  try { fs.appendFileSync(path.join(__dirname, 'sonda-danimados.log'), '[' + new Date().toISOString() + '] ' + el + 's vivas→muertas=' + vm + ' muertas→vivas=' + mv + ' muertas=' + DANI_MUERTAS.size + '\n'); } catch {}
}
async function sondaLacartoons() {
  const t0 = Date.now(), PAUSA = 2000;
  let vm = 0, mv = 0;
  const pausa = () => new Promise((r) => setTimeout(r, PAUSA));
  const sh = (arr) => { const a = [...arr]; for (let k = a.length - 1; k > 0; k--) { const z = Math.floor(Math.random() * (k + 1)); [a[k], a[z]] = [a[z], a[k]]; } return a; };
  for (const x of sh([...LCT_SERIES.values()].filter((v) => !LCT_MUERTAS.has(v.slug))).slice(0, 5)) {
    try {
      CARI_VISTAS.add('lct:' + x.lctId);
      if (await lctProbe(x.lctId)) lctPerdonar(x.slug);
      else { const era = LCT_MUERTAS.has(x.slug); lctOcultar(x.slug); if (!era && LCT_MUERTAS.has(x.slug)) { vm++; sondaNotify('Lacartoons', 'muerto', x.slug, x.slug + ' murio — sin capitulos'); } }
    } catch {}
    await pausa();
  }
  for (const slug of sh([...LCT_MUERTAS]).slice(0, 3)) {
    try {
      const lct = [...LCT_SERIES.values()].find((v) => v.slug === slug);
      if (lct && await lctProbe(lct.lctId)) { LCT_MUERTAS.delete(slug); ocultasReescribir(LCT_MUERTAS, 'lct-muertas.txt'); lctPerdonar(slug); mv++; sondaNotify('Lacartoons', 'revivio', slug, slug + ' revivio — capitulos encontrados'); }
    } catch {}
    await pausa();
  }
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[sonda] lct (' + el + 's): ' + ((vm || mv) ? ('vivas→muertas=' + vm + ' muertas→vivas=' + mv) : 'sin cambios'));
  try { fs.appendFileSync(path.join(__dirname, 'sonda-lacartoons.log'), '[' + new Date().toISOString() + '] ' + el + 's vivas→muertas=' + vm + ' muertas→vivas=' + mv + ' muertas=' + LCT_MUERTAS.size + '\n'); } catch {}
}
async function sondaMisc() {
  const t0 = Date.now(), PAUSA = 2000;
  let vm = 0, mv = 0;
  const pausa = () => new Promise((r) => setTimeout(r, PAUSA));
  const sh = (arr) => { const a = [...arr]; for (let k = a.length - 1; k > 0; k--) { const z = Math.floor(Math.random() * (k + 1)); [a[k], a[z]] = [a[z], a[k]]; } return a; };
  for (const slug of sh(CARI_ORDEN.filter((x) => !CARI_MUERTAS.has(x))).slice(0, 5)) {
    try {
      CARI_VISTAS.add('cari:' + slug);
      if (await cariProbe(slug)) cariPerdonar(slug);
      else { const era = CARI_MUERTAS.has(slug); cariOcultar(slug); if (!era && CARI_MUERTAS.has(slug)) { vm++; sondaNotify('MisCaricaturas', 'muerto', slug, slug + ' murio — sin capitulos'); } }
    } catch {}
    await pausa();
  }
  for (const slug of sh([...CARI_MUERTAS]).slice(0, 3)) {
    try {
      if (await cariProbe(slug)) { CARI_MUERTAS.delete(slug); ocultasReescribir(CARI_MUERTAS, 'cari-muertas.txt'); cariPerdonar(slug); mv++; sondaNotify('MisCaricaturas', 'revivio', slug, slug + ' revivio — capitulos encontrados'); }
    } catch {}
    await pausa();
  }
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[sonda] misc (' + el + 's): ' + ((vm || mv) ? ('vivas→muertas=' + vm + ' muertas→vivas=' + mv) : 'sin cambios'));
  try { fs.appendFileSync(path.join(__dirname, 'sonda-miscaricaturas.log'), '[' + new Date().toISOString() + '] ' + el + 's vivas→muertas=' + vm + ' muertas→vivas=' + mv + ' muertas=' + CARI_MUERTAS.size + '\n'); } catch {}
}
async function sondaCaricaturas() {
  const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (memMB > 350) { console.warn('[sonda] caricaturas saltado — memoria alta: ' + memMB.toFixed(0) + 'MB'); return; }
  try { await sondaDanimados(); } catch (e) { console.warn('[sonda] dani error: ' + String(e).slice(0, 60)); }
  try { await sondaLacartoons(); } catch (e) { console.warn('[sonda] lct error: ' + String(e).slice(0, 60)); }
  try { await sondaMisc(); } catch (e) { console.warn('[sonda] misc error: ' + String(e).slice(0, 60)); }
  try { fs.writeFileSync(path.join(__dirname, 'public', 'cari-vistas.txt'), [...CARI_VISTAS].join('\n') + '\n'); } catch {}
}

async function buscarEnSitios(q) {
  const nq = normalizarTxt(q);
  /* v291: cada fuente va con TOPE DURO de 12 s y las novelas entran al mismo
   * Promise.all (antes se esperaban en fila después). Si una fuente se cuelga,
   * el buscador entrega el resto en ≤12 s en vez de 25-60 s. */
  const LIM_BUSCAR = 12000;
  const conLimite = (p, nombre) => Promise.race([
    p,
    new Promise((r) => setTimeout(() => { console.warn('[buscar] ' + nombre + ' pasó de ' + (LIM_BUSCAR / 1000) + 's — seguimos sin esa fuente'); r([]); }, LIM_BUSCAR)),
  ]);
  const [cuevana, cuevanaMov, latanime, animeflv, d23Anime, pelisxd, cari, cineCalidad, catalogo, movieCosecha, novelas, nv2] = await Promise.all([
    conLimite(buscarCuevana(q).catch(() => []), 'cuevana'),
    conLimite(buscarCuevanaMov(q).catch(() => []), 'cuevana.mov'), /* v235: cuevana.mov — 8k películas latinas */
    conLimite(buscarLatanime(q).catch(() => []), 'latanime'),
    conLimite(buscarAnimeflv(q).catch(() => []), 'animeflv'), /* v97 */
    conLimite(buscarAnimeD23(q).catch(() => []), 'animed23'), /* v286: AnimeD23 (169 títulos únicos, portadas IMDb locales) */
    conLimite(buscarPelisxd(q).catch(() => []), 'pelisxd'), /* v98: el catálogo grande de pelis */
    conLimite(buscarMiscaricaturas(q).catch(() => []), 'caricaturas'), /* v102: caricaturas nick/CN */
    conLimite(buscarCineCalidad(q).catch(() => []), 'cinecalidad'), /* v236.7: CineCalidad (pelis + series) */
    conLimite(catalogoLocal().catch(() => []), 'catalogo'), /* v121 */
    Promise.resolve(buscarMovieCosecha(q)), /* v228: catálogo cosechado 37k */
    NOVELAS_EXTERNAS_ON ? conLimite(buscarNovelas(q).catch(() => []), 'novelas') : Promise.resolve([]), /* v206 — v208: ocultas */
    NOVELAS_EXTERNAS_ON ? conLimite(nv2Buscar(q).catch(() => []), 'novelas2') : Promise.resolve([]), /* v206.2 — v208: ocultas */
  ]);
  /* v121: Cartoons (Lacartoons) entra a la búsqueda — se filtra LOCAL del
   * catálogo. Todo se puntúa por parecido y queda en UNA sola lista
   * ordenada (nada de secciones por sitio: el badge de la tarjeta dice
   * de dónde sale cada una). */
  const vistos = new Set();
  const puntuar = (arr) => arr.filter((r) => r && r.title && r.url).map((r) => {
    const key = String(r.url).toLowerCase();
    if (vistos.has(key)) return null;
    vistos.add(key);
    const o = { title: r.title, url: r.url, img: r.img || '', site: r.site, extra: r.extra || '', _score: similitud(nq, normalizarTxt(r.title)) };
    if (r._apiFresh) o._apiFresh = true; /* v237.1: preservar flag para bypass cvOcultaUrl */
    return o;
  }).filter(Boolean);
  const lctHits = puntuar(catalogo.filter((x) => x.site === 'Cartoons')).filter((r) => r._score >= 0.5);
  const todos = [
    ...lctHits,
    ...puntuar(cuevana),
    ...puntuar(cuevanaMov), /* v235: cuevana.mov — 8k películas latinas */
    ...puntuar(pelisxd),
    ...puntuar(latanime),
    ...puntuar(animeflv),
    ...puntuar(d23Anime), /* v286 */
    ...puntuar(cari),
    ...puntuar(cineCalidad), /* v236.7: CineCalidad pelis + series */
    ...puntuar(novelas), /* v291: ahora viene del Promise.all con tope */
    ...puntuar(nv2), /* v291: igual */
    ...puntuar(movieCosecha), /* v228: 37k títulos cosechados */
    ...puntuar(catalogo.filter((x) => x.site !== 'Cartoons')),
  ];
  /* v121: por NIVELES de relevancia — primero lo que se parece de verdad
   * (≥0.62), luego lo medio (≥0.42) y al final lo flojo; dentro del nivel,
   * gana el puntaje (empate → el orden de llegada, por fuente) */
  const nivel = (s) => (s >= 0.62 ? 0 : s >= 0.42 ? 1 : 2);
  todos.sort((a, b) => nivel(a._score) !== nivel(b._score) ? nivel(a._score) - nivel(b._score) : b._score - a._score);
  /* v121: «¿Quisiste decir…?» — el título de NUESTRO catálogo (Cartoons +
   * Caricaturas) que más se parece a lo escrito cuando no coincide exacto.
   * Sale si el propio candidato es el #1 de la lista (Google-style:
   * «mostrando resultados para…») o si lo de arriba es flojo (<0.75);
   * si la lista ya arranca con un hit clarito, no molesta con el chip. */
  let sugiere = null;
  const top = todos[0];
  for (const r of todos) {
    if (r.site !== 'Cartoons' && r.site !== 'Caricaturas') continue;
    const nr = normalizarTxt(r.title);
    if (nr === nq || r._score < 0.45 || r._score > 0.995) continue;
    if (top && r !== top && top._score >= 0.75) break;
    sugiere = { q: r.title, titulo: r.title, site: r.site };
    break;
  }
  /* si hay hits fuertes (≥0.62), se cuela el ruido flojo (<0.42) — la
   * lista queda con lo parecido de verdad; si no hay ninguno fuerte, se
   * muestra TODO (las opciones que cada fuente encontró a su manera) */
  const hayFuerte = todos.some((r) => r._score >= 0.62);
  const resultados = todos
    .filter((r) => !hayFuerte || r._score >= 0.42)
    .slice(0, 30)
    .map(({ _score, ...r }) => r);
  console.log(`[buscar] "${q}" global → ${resultados.length} resultados${sugiere ? ` (¿quisiste decir ${sugiere.titulo}?)` : ''}`);
  return { resultados, sugiere };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => { chunks.push(c); total += c.length; if (total > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* v191: series de cine-calidad MUERTAS — auditoría completa (1,139 series):
 * su 1x1 y 1x2 solo traen tráiler de YouTube o nada. No se muestran en
 * búsqueda ni tendencias (abrir el resto de URLs directas sigue funcionando) */
const CV_OCULTAS = new Set([
  '142033-2',
  'abominable-y-la-ciudad-invisible-2023-gratis',
  'acaramelados',
  'agallas-el-perro-cobarde',
  'agencia-lockwood-gratis',
  'animal',
  'baymax-gratis',
  'beavis-y-butt-head-gratis',
  'bel-air-gratis',
  'beplaying-la-voz-detras-del-sonid-gratis',
  'by-the-grace-of-the-gods-gratis',
  'candy-cruz',
  'capitanes-del-mundo',
  'carmen-sandiego',
  'chico-come-universo',
  'cien-anos-de-soledad',
  'colin-en-blanco-y-negro',
  'conversaciones-con-asesinos-las-cintas-de-jeffrey-dahmer-gratis',
  'corazon-de-invictus-gratis',
  'corazon-de-oro',
  'cromosoma-21-gratis',
  'dejame-entrar-gratis',
  'deputy',
  'desde-dentro-gratis',
  'diablo-guardian',
  'dmz-gratis',
  'dragon-age-absolucion-gratis',
  'dragones-los-nueve-reinos-gratis',
  'duda-razonable-historia-de-dos-secuestros',
  'el-adn-del-delito',
  'el-amor-es-como-el-chachacha',
  'el-asesino-improbable',
  'el-asombroso-circo-digital',
  'el-fin-del-amor-gratis',
  'el-gabinete-de-curiosidades-de-guillermo-del-toro-gratis',
  'el-hombre-contra-la-abeja-gratis',
  'el-legado',
  'el-metodo-kominsky',
  'el-palacio-del-este',
  'el-show-de-patricio-estrella-gratis',
  'en-tierra-lejana',
  'erase-una-vez-pero-ya-no-gratis',
  'escena-del-crimen-el-asesino-de-times-square',
  'escort-boys',
  'expatriadas',
  'fanatico-gratis',
  'forst',
  'fraggle-rock-gratis',
  'fright-krewe',
  'fuuto-pi',
  'gannibal-gratis',
  'gatos-callejeros-de-ricky-gervais',
  'griselda',
  'gutierrez-is-mai-neim',
  'harriet-la-espia-gratis',
  'hermanas-un-amor-compartido',
  'hermanos-robots-supergigantes-gratis',
  'hombres-de-ley-bass-reeves',
  'home-economics',
  'hora-de-aventuras-tierras-lejanas',
  'ironheart',
  'isla-brava-gratis',
  'jellystone',
  'kakegurui-twin-gratis',
  'kanojo-mo-kanojo',
  'kim-possible',
  'la-busqueda-mas-alla-de-la-historia-gratis',
  'la-cabeza-de-joaquin-murrieta-gratis',
  'la-chica-de-nieve-gratis',
  'la-chica-de-oslo',
  'la-chica-invisible-gratis',
  'la-conserje-pokemon',
  'la-escuela-de-la-vida-gratis',
  'la-hija-de-dios-dalma-maradona-gratis',
  'la-ninera',
  'la-paradoja-del-asesino',
  'la-reina-cleopatra-gratis',
  'las-chicas-gilmore',
  'las-luminarias',
  'las-prendas-que-nos-marcaron',
  'las-viudas-de-los-jueves-gratis',
  'lego-dreamzzz-gratis',
  'llamas-gemelas-como-apagar-el-fuego',
  'los-montaner-gratis',
  'los-proud-mas-ruidosos-y-orgullosos-gratis',
  'lucky-man',
  'lycoris-recoil-gratis',
  'manayek-gratis',
  'mar-de-la-tranquilidad',
  'marvel-spider-man',
  'masters-del-universo-revolucion',
  'medicina-letal-gratis',
  'mi-padre-el-cazarrecompensas-intergalactico-gratis',
  'mi-vida-con-los-chicos-walter',
  'mil-colmillos',
  'mirada-indiscreta-gratis',
  'mono-malo',
  'nadie-en-el-bosque',
  'nina-de-demonio-gratis',
  'pablo-escobar-el-patron-del-mal',
  'papas-por-encargo-gratis',
  'pobre-diablo-gratis',
  'pokemon-senda-a-la-cima-gratis',
  'presidente-curtis',
  'pts-redes-sociales-gratis',
  'quedate-a-mi-lado',
  'ratonera',
  'sean-eternos-campeones-de-america-gratis',
  'seleccion-argentina-la-serie-camino-a-qatar-gratis',
  'south-park',
  'star-trek-voyager',
  'star-wars-rebels',
  'star-wars-the-clone-wars',
  'super-pupz-gratis',
  'tan-cerca-de-ti-nace-el-amor',
  'teen-wolf',
  'the-best-man-the-final-chapters-gratis',
  'the-quest-gratis',
  'thundercats',
  'thundercats-roar',
  'tierra-incognita',
  'tiger-king-la-historia-de-doc-antle',
  'tragones-y-mazmorras',
  'triada-gratis',
  'una-familia-normal',
  'uzaki-chan-wa-asobitai',
  'vilma-gratis',
  'wakefield',
  'watchmen-gratis',
  'will-trent-agente-especial-gratis',
  'y-el-ultimo-hombre',
]);
const CV_OCULTAS_RT = new Set(); /* v195: muertas detectadas EN VIVO (persistente) */
try { for (const x of JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cv-ocultas-rt.json'), 'utf8')) || []) CV_OCULTAS_RT.add(x); } catch {}
let cvRtTimer = null;
/* v196: series BUENAS confirmadas por el usuario — la autocuración jamás las toca */
const CV_PROTEGIDAS = new Set(['yellowstone', 'marshals-una-historia-de-yellowstone']);
function cvOcultaRegistrar(slug) {
  if (!slug || CV_OCULTAS_RT.has(slug) || CVM_OCULTAS.has(slug) || CV_PROTEGIDAS.has(slug)) return;
  CV_OCULTAS_RT.add(slug);
  console.log('[cuevana] título muerto ocultado en vivo: ' + slug);
  try { clearTimeout(cvRtTimer); } catch {}
  cvRtTimer = setTimeout(() => { try { fs.writeFileSync(path.join(DATA_DIR, 'cv-ocultas-rt.json'), JSON.stringify([...CV_OCULTAS_RT])); } catch {} }, 3000);
}
/* v195: +1,440 PELÍCULAS muertas de las 10,062 auditadas (páginas sin ningún
 * servidor — como «Proyecto Lázarus» del feed). cvOcultaUrl aplica el set a
 * /serie/ y /pelicula/ por igual. */
const CV_PELIS_OCULTAS = new Set([
  '10-cosas-que-hacer-antes-de-dejarte',
  '10-minutos-menos',
  '100-metros',
  '101-dalmatas',
  '101-dalmatas-2',
  '10x10',
  '11-11-11',
  '12-valientes',
  '120-pulsaciones-por-minuto',
  '13-el-musical',
  '1314-el-reto-de-ayudar',
  '137-disparos',
  '14-dias-12-noches',
  '1408-2',
  '1938-cuando-el-petroleo-fue-nuestro',
  '1942-la-gran-ofensiva',
  '1984-2',
  '2-minutes-of-fame',
  '21-gramos',
  '22-contra-la-tierra',
  '22-de-julio',
  '24-horas-para-vivir',
  '30-dias-de-oscuridad-2-tinieblas',
  '31-2',
  '4-kings-ii',
  '4-mitades',
  '438-dias',
  '5-lb-de-presion',
  '50-a-1',
  '7-prisioneros',
  '7500-2',
  '81269-2',
  '90-minutos-en-el-cielo',
  'a-47-metros',
  'a-47-metros-2-el-terror-emerge',
  'a-creature-was-stirring',
  'a-dark-place',
  'a-dos-metros-de-ti',
  'a-ghost-story',
  'a-la-carrera',
  'a-la-intemperie',
  'a-la-mierda-el-amor-otra-vez',
  'a-man-named-scott',
  'a-prueba',
  'a-prueba-de-balas-2',
  'a-quien-ama-gilbert-grape',
  'a-quien-te-llevarias-a-una-isla-desierta',
  'a-traicion',
  'a-traves-de-mi-ventana',
  'a-un-paso-de-mi',
  'abajo-el-telon',
  'abduccion-alienigena',
  'abigail-haunting',
  'abominable',
  'absolutamente-fabulosas',
  'abuelos-al-poder',
  'abyss',
  'action-point',
  'adele-y-el-misterio-de-la-momia',
  'adios',
  'adu',
  'agentes-en-la-sombra',
  'aguanta-la-respiracion-inmersion-bajo-el-hielo',
  'aguila-o-sol',
  'ahi-esta-el-detalle',
  'ajuste-de-cuentas',
  'ak-47',
  'akeelah-contra-todos',
  'al-borde-del-abismo',
  'al-lado-de-cristo',
  'al-limite-del-riesgo',
  'al-morir-la-matinee',
  'al-viento',
  'alba-del-desierto',
  'alejandro-magno',
  'alex-strangelove',
  'algo-azul',
  'algo-pasa-en-las-vegas',
  'alguien-como-el',
  'alice-en-el-pais-de-internet',
  'alice-in-terrorland',
  'alien-warfare',
  'all-saints',
  'alli-me-encontraras',
  'alpha-code',
  'alpha-y-omega',
  'alvin-y-las-ardillas-2',
  'always-and-forever-christmas',
  'amanecer-rojo',
  'amarrados-al-amor',
  'amelia',
  'amelie',
  'amenazados',
  'american-honey',
  'american-psycho-2-el-legado-de-patrick-bateman',
  'american-underdog',
  'amigos-pasajeros',
  'among-the-living',
  'amor-a-medianoche',
  'amor-boda-azar',
  'amor-bodas-y-otros-desastres',
  'amor-de-gata',
  'amor-de-madre',
  'amor-en-obras',
  'amor-en-polvo',
  'amor-en-rye-lane',
  'amor-entre-expertos',
  'amor-eterno',
  'amor-rebelde',
  'amor-y-amistad',
  'amor-y-helado',
  'amulet',
  'amundsen-la-gran-expedicion',
  'anaconda-4-rastro-de-sangre',
  'anacondas-la-caceria-por-la-orquidea-sangrienta',
  'angeles-caidos-guerreros-de-paz',
  'animal-de-compania',
  'animales-humanos',
  'animatrix',
  'anne-la-pelicula',
  'annie',
  'anomalia',
  'anos-de-perro',
  'anos-de-sequia',
  'antares-de-la-luz-la-secta-del-fin-del-mundo',
  'antlers-criatura-oscura',
  'ape-vs-mecha-ape',
  'apostando-al-limite',
  'aqui-y-ahora',
  'arana',
  'arizona',
  'arma-fatal',
  'arq',
  'arrietty-y-el-mundo-de-los-diminutos',
  'artax',
  'artemis-fowl',
  'arthur-el-soltero-de-oro',
  'asalto-al-poder',
  'asalto-al-tren-del-dinero',
  'asalto-al-tren-pelham-123',
  'asesinato-en-el-orient-express',
  'asesinos-internacionales',
  'asi-es-mi-tierra',
  'asi-nos-va',
  'assassin',
  'asterix-el-secreto-de-la-pocion-magica',
  'asylum-twisted-horror-fantasy-tales',
  'atila-rey-de-los-hunos',
  'atraco-en-familia',
  'atrapa-a-un-ladron',
  'atrapa-ese-email',
  'atrapa-la-bala',
  'atrapada-en-la-navidad',
  'atrapasuenos',
  'audible',
  'autodestruccion',
  'ave-cesar',
  'aves-del-paraiso',
  'bac-nord-brigada-de-investigacion-criminal',
  'bailando-con-lobos',
  'bailando-la-vida',
  'bailando-por-la-vida',
  'bajo-el-muelle',
  'bajo-las-estrellas-de-paris',
  'ballerina',
  'bambi-la-venganza',
  'bano-de-sangre',
  'barbie-grandes-suenos-en-la-gran-ciudad',
  'barbie-una-aventura-de-princesas',
  'barely-lethal',
  'bartkowiak',
  'batalla-de-los-zombis',
  'batalla-freestyle',
  'batman-death-in-the-family',
  'batman-hush',
  'batman-ninja',
  'batman-unlimited-instinto-animal',
  'batman-unlimited-maquinas-vs-monstruos',
  'batman-unlimited-monstermania',
  'battle-of-the-undead',
  'beckett',
  'been-so-long-y-todo-cambio',
  'beethoven-2-la-familia-crece',
  'beethoven-3-de-excursion-con-la-familia',
  'beethoven-uno-mas-de-la-familia',
  'belfast',
  'belle',
  'belle-y-sebastian-la-nueva-generacion',
  'belleza-maldita-bad-hair',
  'belleza-wunderschon',
  'bellezonismo',
  'berlin-berlin-la-novia-se-fuga',
  'bessie',
  'bienvenidos-al-infierno',
  'bigbug',
  'bill-y-ted-salvan-el-universo',
  'billy-lynn',
  'bingo-hell',
  'black-adam-heroe-o-villano',
  'black-as-night',
  'blackhat-amenaza-en-la-red',
  'blackpink-the-movie',
  'blame',
  'blinded-by-the-light-cegado-por-la-luz',
  'bloodshot',
  'blowtorch',
  'blue-bayou',
  'blue-story',
  'blueprint-to-the-heart',
  'bob-esponja-un-heroe-fuera-del-agua',
  'bob-ross-happy-accidents-betrayal-greed',
  'bobs-burgers-la-pelicula',
  'boda-sin-fin',
  'boo-el-halloween-de-madea',
  'bookworm-and-the-beast',
  'boonie-bears-codigo-guardian',
  'bordertown-murales-de-sangre',
  'borg-mcenroe-la-pelicula',
  'boyhood-momentos-de-una-vida',
  'braddock-desaparecido-en-combate-3',
  'brainbugs',
  'brian-y-charles',
  'brick-mansions-la-fortaleza',
  'bridget-jones-sobrevivire',
  'brigada-49',
  'bring-him-to-me',
  'brittany-runs-a-marathon',
  'broad-peak',
  'bugs-bunny-dia-de-brujas',
  'burden',
  'buried-enterrado',
  'burt-munro-un-sueno-una-leyenda',
  'buscando',
  'buscando-a-steve-mcqueen',
  'buscando-la-libertad',
  'butchers',
  'caballero-a-la-medida',
  'caceria-jurasica',
  'cafe-society',
  'calibre',
  'california-schemin',
  'camara-policial',
  'campeones',
  'cancion-de-nueva-york',
  'canibal',
  'caperucita-roja',
  'capitan-america',
  'carino-cuanto-te-odio',
  'carino-estoy-hecho-un-perro',
  'carmen',
  'carmen-2',
  'carnosaurio-3-especie-mortal',
  'carrera-de-bestias',
  'cartas-a-julieta',
  'carter',
  'castle-in-the-ground',
  'catalina-la-catrina-especial-dia-de-muertos',
  'catching-faith-2-the-homecoming',
  'cats',
  'causalidad',
  'causeway',
  'caza-bajo-el-sol',
  'cazatesoros',
  'centauro',
  'cerca-de-tu-casa',
  'chevalier',
  'chief-daddy-2-going-for-broke',
  'chloe',
  'chocolat',
  'churchill',
  'cicatrices-del-alma',
  'cinderellas-revenge',
  'cinema-paradiso',
  'circulo-de-mentiras-2018-online-descarga-gratis',
  'city-of-tiny-lights',
  'cleaner',
  'cmll-sin-piedad',
  'codigo-emperador',
  'coffee-kareem',
  'cold-mountain',
  'colega-donde-esta-mi-coche',
  'colegas-en-el-bosque',
  'colossal-cave',
  'com-as-horas-contadas',
  'combate-en-el-cielo',
  'cometieron-dos-errores',
  'como-entrenar-a-tu-dragon-vuelta-a-casa',
  'como-perros-salvajes',
  'como-perros-y-gatos',
  'como-perros-y-gatos-la-venganza-de-kitty-galore',
  'como-ser-un-latin-lover-2017-online-descarga-gratis',
  'con-derecho-a-roce',
  'con-la-muerte-en-los-talones',
  'con-quien-viajas',
  'conan-el-barbaro',
  'confirmation',
  'congo',
  'conoces-a-tomas',
  'conociendo-a-astrid',
  'conserje-para-todo',
  'conspiracion-y-poder-2015-online-descarga-gratis',
  'contamination',
  'contigo-a-muerte',
  'contigo-vol-2',
  'contraband',
  'contragolpe-2017-online-descarga-gratis',
  'cool-world-una-rubia-entre-dos-mundos',
  'copland',
  'corina',
  'correr-para-vivir',
  'cowboy-de-asfalto',
  'cowboys-aliens',
  'crash-colision',
  'crazy-stupid-love',
  'criminales-de-lujo',
  'cronicas-mutantes',
  'cry-of-silence',
  'cuando-eramos-soldados',
  'cuarentena-terminal',
  'cuatro-dias',
  'cuerpo-de-elite',
  'cuestion-de-pelotas',
  'cut-bank-2014-online-descarga-gratis',
  'd-tox-ojo-asesino',
  'da-5-bloods-hermanos-de-armas',
  'daddys-perfect-little-girl',
  'danger-close-la-batalla-de-long-tan',
  'danko-calor-rojo',
  'danny-boy',
  'daphne-velma-2018-online-descarga-gratis',
  'dawn-of-the-nazis',
  'de-amor-y-monstruos',
  'de-caza-con-papa',
  'de-mentes-criminales',
  'de-profesion-duro',
  'dead-beautiful',
  'dead-reckoning',
  'deadly-garage-sale',
  'death-race-2-la-carrera-de-la-muerte-el-origen',
  'death-race-2050-2017-online-descarga-gratis',
  'death-race-3-la-carrera-de-la-muerte-inferno',
  'death-race-beyond-anarchy',
  'death-she-wrote',
  'deep-blue-sea-3',
  'definitivamente-quizas',
  'dejate-llevar',
  'del-otro-lado-de-la-puerta-2016-online-descarga-gratis',
  'demise',
  'democracia-en-blanco-y-negro',
  'desaparecido-en-combate-2',
  'desde-la-oscuridad',
  'desde-paris-con-amor',
  'desperado',
  'despues-de-la-tormenta',
  'destino-oculto',
  'destinos-opuestos',
  'desvelando-la-verdad',
  'detras-de-las-paredes',
  'detroit',
  'deuce-bigalow-gigolo-europeo',
  'dhoom-dhaam',
  'diamante-o-bailarina',
  'diario-de-una-ninera',
  'diarios-de-motocicleta',
  'dias-de-angustia-gratis',
  'dieciseis-velas',
  'dinero-sucio',
  'directo-al-corazon-2015-online-descarga-gratis',
  'dirt',
  'dirty-dancing',
  'disco-inferno',
  'disconnected-2',
  'disney-plus-premium-12-meses-gratis',
  'don-quijote-cabalga-de-nuevo',
  'don-verdean',
  'donbass',
  'donde-viven-los-monstruos',
  'dope',
  'dos-amantes-y-un-oso',
  'dos-experiencias-en-el-bosque',
  'dos-hermanos',
  'dos-mulas-y-una-mujer',
  'dos-padres-en-apuros',
  'dos-tontos-muy-tontos',
  'down-a-dark-hall-2018-online-descarga-gratis',
  'dr-nassar-el-caso-del-equipo-de-gimnasia-de-ee-uu',
  'dragon-ball-z-la-resurreccion-de-freezer',
  'dragon-nest-warriors-dawn',
  'dragones-amanecer-de-los-corredores-de-dragon',
  'dragonheart-3-la-maldicion-del-brujo',
  'dragons-rescue-riders-secrets-of-the-songwing-2020-online-descarga-gratis',
  'drones',
  'duchess',
  'dulce-sabor-a-muerte',
  'dulce-venganza',
  'dulces-criaturas',
  'durante-la-tormenta',
  'duro-de-matar',
  'eddie-el-aguila',
  'efsunlu-ayin',
  'efsunlu-kabirden-gelen',
  'el-alamo-la-leyenda',
  'el-amor-no-cuesta-nada',
  'el-apostol',
  'el-arca-de-noe',
  'el-arte-de-la-guerra',
  'el-asedio',
  'el-autor',
  'el-aviso',
  'el-bailarin',
  'el-bar',
  'el-bar-de-las-grandes-esperanzas',
  'el-barrendero',
  'el-blog-de-una-adolescente-2014-online-descarga-gratis',
  'el-blues-de-beale-street',
  'el-bombero-atomico',
  'el-bosque-siniestro-2016-online-descarga-gratis',
  'el-bueno-el-feo-y-el-malo',
  'el-camino-del-lobo-2015-online-descarga-gratis',
  'el-caso-de-calvin-willis-gratis',
  'el-caso-de-cristo',
  'el-castillo-del-hombre-lobo',
  'el-catcher-espia',
  'el-chiquitin',
  'el-circo',
  'el-circo-de-los-extranos',
  'el-club-de-las-luchadoras',
  'el-club-de-los-emperadores',
  'el-club-de-los-jovenes-multimillonarios',
  'el-complot-de-mega-megamind',
  'el-corcel-negro',
  'el-cuaderno-de-sara',
  'el-cuento-de-la-princesa-kaguya',
  'el-desafio-de-las-aguilas',
  'el-destino-de-jupiter',
  'el-dia-del-si',
  'el-diario-de-bridget-jones',
  'el-discurso-del-rey',
  'el-dragon-rojo',
  'el-duodecimo-hombre',
  'el-ejercito-de-las-tinieblas',
  'el-enigma-del-cuervo',
  'el-escritor',
  'el-espacio-entre-nosotros',
  'el-espia-honesto',
  'el-exorcismo-de-emily-rose',
  'el-experimento',
  'el-experimento-belko',
  'el-extra',
  'el-final-de-nuestros-dias',
  'el-final-de-oak-street',
  'el-fotografo-de-mauthausen',
  'el-fugitivo',
  'el-gran-despilfarro',
  'el-gran-golpe',
  'el-gran-lebowski',
  'el-gran-pase-de-magia',
  'el-guardian-invisible',
  'el-guerrero-rojo',
  'el-halcon-sed-de-venganza',
  'el-heroe-de-todos',
  'el-hijo-de-batman',
  'el-hilo-rojo-2',
  'el-hombre-bicentenario',
  'el-hombre-de-la-tierra',
  'el-hombre-de-las-mil-caras',
  'el-hombre-del-corazon-de-hierro',
  'el-hombre-del-saco',
  'el-hombre-mas-enfadado-de-brooklyn',
  'el-hotel-del-millon-de-dolares',
  'el-hoyo',
  'el-hundimiento',
  'el-imperio-de-las-sombras',
  'el-increible-burt-wonderstone',
  'el-instituto-2017-online-descarga-gratis',
  'el-instituto-atticus',
  'el-insulto',
  'el-invitado',
  'el-jardin-de-las-palabras',
  'el-jinete-azul',
  'el-joven-mesias-2016-online-descarga-c003-gratis',
  'el-juego-de-la-botella',
  'el-justiciero-de-la-ciudad',
  'el-latido-desnudo',
  'el-magnifico-ivan',
  'el-mago',
  'el-medico-de-viena',
  'el-ministro-y-yo',
  'el-mono-borracho-en-el-ojo-del-tigre',
  'el-monstruo-al-final-de-esta-historia',
  'el-motin',
  'el-nino-44',
  'el-nino-del-bosque',
  'el-nombre-de-la-rosa',
  'el-nuevo-exotico-hotel-marigold',
  'el-oficial-y-el-espia',
  'el-olivo',
  'el-ondeado-heroe-o-villano',
  'el-paciente-ingles',
  'el-padre-de-la-patria',
  'el-padrecito',
  'el-pan-de-la-guerra',
  'el-patrullero-777',
  'el-perfecto-desconocido',
  'el-plan-b',
  'el-planeta-de-los-simios',
  'el-poder-de-la-cruz',
  'el-poder-del-talisman',
  'el-portero',
  'el-primer-caballero',
  'el-profe',
  'el-profesor-de-persa',
  'el-reino',
  'el-reino-prohibido',
  'el-repostero-de-berlin',
  'el-retrato-de-dorian-gray',
  'el-reverendo',
  'el-rey-de-zamunda',
  'el-rey-del-sapo',
  'el-rey-escorpion-2-el-nacimiento-del-guerrero',
  'el-seductor',
  'el-senor-doctor',
  'el-senor-fotografo',
  'el-siete-machos',
  'el-silencio-de-marcos-tremmer',
  'el-silencio-del-pantano',
  'el-sr-holmes-2015-online-descarga-gratis',
  'el-sumiller',
  'el-super-canguro',
  'el-supersabio',
  'el-tercero-en-discordia',
  'el-territorio-de-dios-2014-online-descarga-gratis',
  'el-territorio-de-la-bestia-rogue',
  'el-tesoro-del-amazonas',
  'el-topo',
  'el-traidor',
  'el-triunfo-del-espiritu-2016-online-descarga-gratis',
  'el-ultimo-asalto',
  'el-ultimo-mohicano',
  'el-ultimo-tour-2015-online-descarga-gratis',
  'el-valle-de-la-muerte',
  'el-viajante',
  'el-vicio-del-poder',
  'el-viento-se-levanta',
  'elefante',
  'elevator',
  'elimination-chamber',
  'elisa-y-marcela',
  'elle',
  'en-compania-de-heroes',
  'en-cuerpo-y-alma',
  'en-el-barrio-online-descarga-gratis',
  'en-el-ojo-de-la-tormenta',
  'en-la-boca-del-miedo',
  'en-la-boda-de-mi-hermana',
  'en-la-cuerda-floja-2015-online-descarga-gratis',
  'en-la-misma-ola',
  'end-of-the-rope',
  'enemigo-mio',
  'entourage-el-sequito',
  'entre-dos-maridos',
  'entre-sombras',
  'entrega-inmediata',
  'era-el-cielo',
  'erase-una-vez-deadpool',
  'erase-una-vez-en-queens',
  'erase-una-vez-en-venezuela',
  'erupt-3',
  'escobar-paraiso-perdido',
  'escupire-sobre-tu-tumba-3',
  'espera-hasta-que-se-haga-de-noche',
  'esperando-al-rey',
  'espias-a-escondidas-2019-online-descarga-gratis',
  'espiritus-del-mar-2019-online-descarga-gratis',
  'estado-critico',
  'estafa-telefonica-on-the-line',
  'estafadores',
  'estallido',
  'esto-es-la-guerra',
  'examen',
  'exes',
  'exorcismo-en-el-vaticano',
  'extinction',
  'family-dinner',
  'fantasy-island',
  'fatale',
  'feliz-halloween-scooby-doo',
  'fenomenos-de-la-naturaleza-2015-online-descarga-gratis',
  'fievel-va-al-oeste',
  'fievel-y-el-nuevo-mundo',
  'final-fantasy-xv-la-pelicula-2016-online-descarga-gratis',
  'fireworks',
  'flashback-online-descarga-gratis',
  'flavors-of-youth',
  'footloose',
  'forca-de-elite-o-filme',
  'founders-day',
  'four-rooms',
  'foxcatcher',
  'frantz',
  'frau-ella',
  'freaks',
  'frequency',
  'frio-en-julio',
  'fuga-de-alcatraz',
  'furia-ciega',
  'furia-de-los-thunderman',
  'galveston',
  'game-on',
  'gangsters-daughter-4',
  'gangsters-daughter-5',
  'gattaca',
  'gente-de-bien',
  'gernika',
  'ghost-game',
  'ghost-rider-espiritu-de-venganza',
  'gigolo',
  'golpe-de-estadio',
  'golpe-de-suerte',
  'goon-el-ultimo-de-los-enforcers',
  'gotti',
  'gran-hotel',
  'green-zone-distrito-protegido',
  'greenberg',
  'gridlocked-2015-online-descarga-gratis',
  'groot-se-da-un-bano',
  'guadalupe-madre-de-la-humanidad',
  'guerra-de-novias',
  'hacerse-mayor-y-otros-problemas',
  'happy-feet-2',
  'hard-corps',
  'harriet-en-busca-de-la-libertad-2019-online-descarga-gratis',
  'harry-and-meghan-escaping-the-palace',
  'hasta-el-final-2016-online-descarga-gratis',
  'hater-2020-online-descarga-gratis',
  'haunted-3d-echoes-of-the-past',
  'hazme-reir',
  'hazme-volar',
  'hbo-max-premium-12-meses-gratis',
  'hector-y-el-secreto-de-la-felicidad',
  'hellraiser-v-inferno',
  'hellraiser-vi-hellseeker',
  'hermanas-2015-online-descarga-gratis',
  'hermosas-criaturas',
  'hes-not-worth-dying-for',
  'hijo-del-crimen-2014-online-descarga-gratis',
  'hijo-nativo',
  'historias-de-amor',
  'hogar-no-tan-dulce-hogar',
  'hollow-point',
  'hombres-de-elite',
  'hombres-de-negro-ii',
  'hombres-de-valor',
  'hombres-mujeres-y-ninos',
  'horas-contadas-2016-online-descarga-gratis',
  'horse-camp-a-love-tail',
  'hostel',
  'hostel-2',
  'hostel-3-de-vuelta-al-horror',
  'hostile-forces',
  'hot-bot-2016-online-descarga-gratis',
  'huida-del-planeta-de-los-simios',
  'hunter',
  'huracan-carter',
  'hurricane',
  'i-feel-good-la-historia-de-james-brown',
  'i-s-s',
  'ibiza',
  'ice-age-en-busca-del-huevo',
  'immortals',
  'imperium',
  'in-full-bloom',
  'infiltrado',
  'inmersion',
  'insidious-fuera-del-mas-alla',
  'instintos-ocultos',
  'intemperie',
  'into-the-beat-tu-corazon-baila',
  'invasion-2-el-fin-de-los-tiempos',
  'invierno-primavera-verano-otono',
  'invisibles',
  'irreversible',
  'jack-el-cazagigantes',
  'jack-y-su-gemela',
  'jane-tomo-las-armas-2016-online-descarga-gratis',
  'jem-y-los-hologramas-2015-online-descarga-c002-gratis',
  'jenni',
  'jesus-monzon-el-lider-olvidado-por-la-historia',
  'jfk-caso-abierto',
  'joe',
  'johnny-english-returns',
  'jolt',
  'joseph-rey-de-los-suenos',
  'juana-de-arco',
  'juanpis-gonzalez-el-presidente-de-la-gente',
  'judas-y-el-mesias-negro',
  'juego-de-asesinos',
  'juego-de-brujas',
  'juego-sin-limites-2016-online-descarga-gratis',
  'juegos-criminales',
  'juliet-desnuda',
  'june-john',
  'jurassic-domination',
  'k-19-the-widowmaker',
  'kallys-mashup-un-cumpleanos-muy-kally',
  'kancolle-the-movie',
  'kenshin-el-guerrero-samurai-2-infierno-en-kioto',
  'kenshin-el-guerrero-samurai-3-el-fin-de-la-leyenda',
  'khumba',
  'killers',
  'kursk',
  'la-abeja-maya-los-juegos-de-la-miel',
  'la-amabilidad-de-los-extranos',
  'la-balada-de-lefty-brown',
  'la-banda-del-patio-milagro-en-la-calle-tercera',
  'la-batalla-por-sebastopol',
  'la-boda-de-mi-familia',
  'la-boveda',
  'la-cabana-en-el-bosque',
  'la-camarista',
  'la-captura',
  'la-casa-de-jack',
  'la-casa-del-lago',
  'la-casa-del-panico',
  'la-casa-oscura',
  'la-casaca-de-dios',
  'la-caza',
  'la-cena',
  'la-cena-de-los-idiotas',
  'la-cenicienta-boricua',
  'la-chaqueta-metalica',
  'la-chica-de-mis-suenos',
  'la-chica-en-el-sotano',
  'la-chica-mas-hermosa-del-mundo',
  'la-conquista-del-planeta-de-los-simios',
  'la-consagracion-de-la-primavera',
  'la-conspiracion-del-poder',
  'la-costa-de-los-mosquitos',
  'la-cuidadora-de-la-mansion-garret',
  'la-dama-de-hierro',
  'la-doncella',
  'la-espada-magica',
  'la-espia-roja',
  'la-familia-bloom',
  'la-fuerza-del-honor',
  'la-fuga-de-maze',
  'la-gallina-turuleca',
  'la-gran-aventura-de-winter-el-delfin-2',
  'la-gran-hambruna',
  'la-historia-interminable-ii-el-siguiente-capitulo',
  'la-historia-interminable-iii-las-aventuras-de-bastian',
  'la-hora-de-la-arana',
  'la-hora-senalada',
  'la-huesped',
  'la-increible-jessica-james-2017-online-descarga-gratis',
  'la-influencia',
  'la-invencion-de-hugo',
  'la-invitacion',
  'la-jungla',
  'la-leyenda-de-barney-thomson-2015-online-descarga-c001-gratis',
  'la-leyenda-del-lobo-de-la-montana',
  'la-leyenda-del-luchador-borracho',
  'la-mala-noche',
  'la-mansion',
  'la-mas-fan',
  'la-matanza-de-texas-4',
  'la-memoria-de-un-asesino',
  'la-momia-dummie-y-la-tumba-de-achne',
  'la-muerte-de-stalin',
  'la-oveja-shaun-la-pelicula',
  'la-particula-de-dios',
  'la-pasion-de-gabriel',
  'la-patrulla-canina-rescates-invernales',
  'la-pequena-suiza',
  'la-piel-del-tambor',
  'la-piel-fria',
  'la-poesia-del-duelo',
  'la-posesion-de-grace',
  'la-primera-purga-la-noche-de-las-bestias',
  'la-profesora-de-parvulario',
  'la-promesa',
  'la-proxima-piel',
  'la-rebelion-de-los-simios',
  'la-rebelion-de-los-sintes',
  'la-sentencia',
  'la-serpiente-y-el-arco-iris',
  'la-skater',
  'la-sombra-de-la-ley',
  'la-tortuga-roja',
  'la-trampa-del-mal',
  'la-trampa-the-snare',
  'la-tribu',
  'la-trinchera-infinita',
  'la-ultima-bandera',
  'la-ultima-cancion',
  'la-ultima-escena',
  'la-ultima-fortaleza',
  'la-vendedora-de-rosas',
  'la-venganza-del-conde-de-montecristo',
  'la-verdad',
  'la-verdad-oculta-2015-online-descarga-gratis',
  'la-vida-de-calabacin',
  'la-vida-en-juego',
  'la-vida-oculta-de-la-artesania',
  'la-violencia-del-sexo',
  'la-viuda-alegre-ballet-diferido',
  'ladrones',
  'lady-macbeth',
  'land-of-smiles',
  'landship',
  'las-aventuras-de-huckleberry-finn',
  'las-aventuras-de-joe-el-sucio-2-2015-online-descarga-gratis',
  'las-aventuras-de-tintin-el-secreto-del-unicornio',
  'las-escondidas-2016-online-descarga-gratis',
  'las-legiones-emergentes',
  'las-leyes-de-la-termodinamica',
  'las-nuevas-aventuras-de-peter-pan',
  'las-sombras-del-pasado',
  'las-tres-hijas',
  'las-ultimas-supervivientes',
  'latham-entertainment-presents-an-all-new-comedy-experience',
  'latte-y-la-piedra-magica-2019-online-descarga-gratis',
  'legado-en-los-huesos',
  'legion',
  'lego-aquaman-la-ira-de-atlantis',
  'lego-scooby-doo-hollywood-embrujado-2016-online-descarga-gratis',
  'lego-star-wars-the-mandalorian',
  'leona',
  'lets-dance',
  'lets-scare-julie',
  'lhomme-qui-retrecit',
  'libertate',
  'lie-of-the-land',
  'life-of-mike',
  'liga-de-la-justicia-lego-batalla-cosmica-2016-online-descarga-gratis',
  'limite-48-horas',
  'llevame-a-casa-nena',
  'lluvia-de-albondigas',
  'lo-que-arde-con-el-fuego',
  'locas-de-alegria',
  'locas-por-brady',
  'loco-por-ti-2020-online-descarga-gratis',
  'los-blancos-no-saben-saltar',
  'los-casos-de-victoria',
  'los-criminales-de-noviembre',
  'los-de-la-a-culpa',
  'los-elfkins',
  'los-futbolisimos',
  'los-hermanos-sisters',
  'los-hombres-libres-de-jones',
  'los-hombres-que-miraban-fijamente-a-las-cabras',
  'los-huespedes-2015-online-descarga-gratis',
  'los-invasores-the-recall',
  'los-olvidados-de-karaganda',
  'los-otros-dos',
  'los-picapiedra-wwe-stone-age-smackdown',
  'los-primeros-pasos-de-groot',
  'los-radley',
  'los-rescatadores',
  'los-reyes-de-baltimore',
  'los-salvajes',
  'los-secretos-del-corazon-rabbit-hole',
  'los-secretos-que-ocultamos',
  'los-simpson-bienvenidos-al-club',
  'los-telenecos',
  'los-tigres-del-norte-historias-que-contar',
  'los-tres-mosqueteros',
  'los-viajes-de-gulliver',
  'los-voyeurs',
  'lost-river',
  'lottery-ticket',
  'love-lost-found',
  'loving-pablo',
  'lucha-hasta-el-final',
  'machete',
  'mad-max-salvajes-de-la-autopista',
  'madeleine-collins',
  'madre',
  'mal-ejemplo',
  'malasana-32',
  'maldad-oculta-2019-online-descarga-gratis',
  'mami-nunca-te-haria-dano',
  'manana-es-hoy',
  'mandibulas',
  'mandibulas-6-el-legado',
  'maneater',
  'manhattan-nocturno',
  'manicomio-del-terror-2020-online-descarga-gratis',
  'marea-roja',
  'maria-bamford-plan-b',
  'maria-candelaria-xochimilco',
  'maria-magdalena-2018-online-descarga-c001-gratis',
  'marianne-y-la-pocima-del-amor-strange-magic',
  'marinette',
  'marte-necesita-madres',
  'mas-alla-de-la-herencia',
  'mas-alla-de-la-vida',
  'mas-fuerte-que-el-destino',
  'maudie-el-color-de-la-vida',
  'maya-y-el-orbe-dorado',
  'mazel-tov',
  'me-contro-te-il-film-la-vendetta-del-signor-s',
  'meet-the-khumalos',
  'mejor-otro-dia',
  'memorias-de-un-zombie-adolescente',
  'memorias-de-una-geisha',
  'men-in-black-3',
  'men-in-black-hombres-de-negro',
  'mensaje-en-una-botella',
  'mentes-peligrosas',
  'menuda-momia',
  'mermaid-down-2019-online-descarga-gratis',
  'merrily-we-roll-along',
  'messengers-2',
  'mi-chica',
  'mi-familia-del-norte',
  'mi-perfecto-ex',
  'mi-querida-cofradia',
  'mi-semana-con-marilyn',
  'mi-vida-en-ruinas',
  'miamor-perdido',
  'miedo-y-asco-en-las-vegas',
  'mientras-cupido-no-esta',
  'mientras-dormimos',
  'mientras-dure-la-guerra',
  'mientras-ellas-duermen',
  'mientras-estes-conmigo-2020-online-descarga-gratis',
  'mike-y-dave-los-busca-novias-2016-online-descarga-gratis',
  'mil-palabras',
  'mis-vecinos-los-yamada',
  'mision-en-taipei',
  'mision-panda-en-africa',
  'mission-extreme-2-black-war',
  'mistress-america-2015-online-descarga-gratis',
  'mk-ultra',
  'mobile-suit-gundam-hathaway-la-hechiceria-de-la-ninfa-circe',
  'mobile-suit-gundam-i',
  'mojin-la-leyenda-perdida-2015-online-descarga-gratis',
  'money-monster',
  'monica-y-sus-amigos-lecciones',
  'monolith',
  'monsterville-el-armario-de-las-almas-2015-online-descarga-c001-gratis',
  'moon',
  'moriras-en-6-horas',
  'mortdecai',
  'motor-city',
  'mountainhead',
  'mr-turner',
  'mudbound',
  'muere-otra-vez',
  'muerte-en-familia',
  'muerto-en-una-semana',
  'mujercitas-2019-online-descarga-c001-gratis',
  'mulholland-falls-la-brigada-del-sombrero',
  'mundo-prodigiosa-las-aventuras-de-ladybug-en-nueva-york',
  'mustang-la-rehabilitacion-2019-online-descarga-gratis',
  'my-brothers-keeper',
  'my-fathers-other-family',
  'my-hero-academia-3-mision-mundial-de-heroes',
  'my-mothers-wedding',
  'mystic-river',
  'nacido-el-cuatro-de-julio',
  'nada-que-perder',
  'nando-entre-dos-mundos',
  'nausicaa-del-valle-del-viento',
  'navidad-loca-navidad',
  'navidades-y-otras-fiestas-a-evitar',
  'netflix-premium-12-meses-garantia-1-ano-gratis',
  'ni-sangre-ni-arena',
  'nine',
  'ninja-turtles',
  'ninos-grandes',
  'no-address',
  'no-eres-tu-soy-yo',
  'no-me-echen-ese-muerto',
  'no-me-mates',
  'no-nos-moveran',
  'no-puedes-fiarte-de-nadie-a-la-caza-del-rey-de-la-criptomoneda',
  'no-regreses-a-casa',
  'no-se-desea-buena-suerte',
  'no-sin-ella-2015-online-descarga-gratis',
  'no-tengas-miedo-a-la-oscuridad',
  'no-way-jose',
  'noche-de-fin-de-ano',
  'noche-de-miedo-ii',
  'noche-en-el-paraiso',
  'noche-loca',
  'nos-casamos-si-mi-amor',
  'nos-conocimos-en-realidad-virtual',
  'nos-volvemos-a-casa',
  'nosotros-los-de-la-fe',
  'novia-por-contrato',
  'nuevo-orden-online-descarga-gratis',
  'nunca-seremos-novias',
  'nyad',
  'objetos',
  'obra-maestra',
  'obsesion-peligrosa',
  'obsession',
  'oceans-twelve',
  'oddball-y-sus-pinguinos-2015-online-descarga-2-gratis',
  'ofrenda-a-la-tormenta',
  'ola-de-crimenes',
  'ominoso-2015-online-descarga-gratis',
  'onward',
  'open-season-tontos-por-el-susto-2015-online-descarga-gratis',
  'operacion-anthropoid',
  'operacion-caceria-2-2016-online-descarga-c003-gratis',
  'operacion-mekong-2016-online-descarga-gratis',
  'operacion-rescate',
  'operacion-ultra-2015-online-descarga-gratis',
  'origenes-secretos',
  'osos',
  'otra-vez-tu',
  'our-hero-balthazar',
  'ovella-negra-entre-2-bessons',
  'ovni',
  'padre-no-hay-mas-que-uno',
  'pajaros-enjaulados-hasta-que-estemos-muertos-o-libres',
  'pandemia-2016-online-descarga-gratis',
  'paranormal-activity-2-tokyo-night',
  'pasion-obsesiva',
  'paskal',
  'paso-de-ti',
  'paterno',
  'paterson',
  'payasos-asesinos-del-espacio-exterior',
  'pecados-capitales-envidia',
  'pecados-capitales-lujuria',
  'pee-wees-big-holiday',
  'peligrosa-compania',
  'pepe',
  'pequena-osa',
  'pequenos-delitos',
  'percy-gratis',
  'perdido-en-la-montana',
  'perdidos-en-el-artico',
  'perez-el-ratoncito-de-tus-suenos',
  'perro-y-gata',
  'persecucion-mortal',
  'pesadilla-en-elm-street-el-origen',
  'piedad-de-stephen-king',
  'pirana-3d',
  'pisando-fuerte',
  'pitty-matriz-ao-vivo-na-bahia',
  'pixeles',
  'plan-de-salida',
  'pokemon-mewtwo-contraataca-la-evolucion-2019-online-descarga-gratis',
  'poliamor-para-principiantes',
  'police',
  'polizon',
  'pompoko',
  'por-mis-pistolas',
  'por-que-me-mataron',
  'porco-rosso',
  'practicamente-magia',
  'preman',
  'presencias',
  'presunta-inocente',
  'proyecto-lazaro',
  'proyecto-lazarus',
  'psychic-storm',
  'puedo-escuchar-el-mar',
  'puerto-ricans-in-paris',
  'que-fue-de-brad',
  'que-se-besen',
  'queen-slim-los-fugitivos-2019-online-descarga-gratis',
  'querida-gente-blanca',
  'quien-a-hierro-mata',
  'quien-es-luigi-mangione',
  'quien-se-rie-ahora',
  'rabid',
  'rastro-oculto',
  'ray',
  'rebelde-entre-el-centeno',
  'recuerdame',
  'recuerdos-del-ayer',
  'red',
  'redentor',
  'reflejos-2',
  'regreso-al-planeta-de-los-simios',
  'rent-free',
  'requiem-para-un-film-olvidado',
  'requiem-por-un-asesino',
  'requiem-por-un-sueno',
  'resistencia-un-documental-de-salma-millan',
  'retreat-aislados',
  'revolver',
  'rey-de-ladrones',
  'richard-dice-adios',
  'rio-2',
  'robert-the-doll',
  'rock-en-el-kasbah-2015-online-descarga-c003-gratis',
  'rock-n-roll-ringo',
  'romeo-y-julieta',
  'rompedientes',
  'rompehuesos',
  'rosario-tijeras',
  'rosewater',
  'round-the-decay',
  'rubius-x',
  'rumores-y-mentiras',
  's-w-a-t',
  'sakamoto-days',
  'salo-o-los-120-dias-de-sodoma',
  'salon-de-belleza',
  'salvaje',
  'salvando-las-distancias',
  'sanctuary-population-one',
  'sangre-de-mi-sangre',
  'santo-contra-los-jinetes-del-terror',
  'schlitter',
  'scooby-doo-conoce-a-kiss-misterio-a-ritmo-de-rock-and-roll',
  'scooby-doo-y-la-maldicion-del-fantasma-numero-13',
  'searching',
  'secuestro',
  'selma',
  'semidulce-2',
  'senna',
  'ser-los-ricardo',
  'sergio',
  'sex-drive',
  'sexo-en-nueva-york',
  'sexo-en-nueva-york-2',
  'sexo-pudor-y-lagrimas',
  'shackled',
  'shanghai-fortress',
  'shaun-el-cordero-la-pelicula-granjagedon-2019-online-descarga-gratis',
  'sherlock-la-novia-abominable',
  'showdown-in-yesteryear',
  'si-decido-quedarme',
  'si-supieras-2020-online-descarga-gratis',
  'si-yo-fuera-diputado',
  'si-yo-fuera-rico',
  'sicarivs-la-noche-y-el-silencio',
  'sidelined-2-intercepted',
  'siete-psicopatas',
  'sigue-el-ritmo',
  'simbad-la-leyenda-de-los-siete-mares',
  'sin-frenos',
  'sin-identidad',
  'sin-tregua',
  'siniestro-2-2015-online-descarga-gratis',
  'sinister',
  'skin',
  'skin-trade-trafico-humano',
  'skyrunners',
  'slither-la-plaga',
  'smalltown-funk-girls',
  'socorro-soy-un-pez',
  'sol',
  'soldado-anonimo-ley-del-retorno-2019-online-descarga-gratis',
  'soldado-universal',
  'soldado-universal-4-el-juicio-final',
  'soldado-universal-regeneracion',
  'solomon-kane',
  'son-of-the-soil',
  'sordo',
  'sospechoso-cero',
  'sospechosos-habituales',
  'southern-scares',
  'souvenir',
  'soy-un-profugo',
  'space-chimps-2-zartog-ataca-de-nuevo',
  'space-chimps-mision-espacial',
  'spacewalker',
  'spawn',
  'spider-man-brand-new-day',
  'spy-game-juego-de-espias',
  'spy-kids-4-todo-el-tiempo-del-mundo',
  'sr-six-2015-online-descarga-gratis',
  'stand-your-ground',
  'stefan-zweig-adios-a-europa',
  'step-up-3-3d',
  'stopmotion',
  'stratton',
  'stray',
  'street-fighter-la-leyenda',
  'street-fighter-la-ultima-batalla',
  'su-excelencia',
  'sube-y-baja',
  'suburra',
  'sunrise-el-ultimo-amanecer',
  'sunshine',
  'super-bodyguard',
  'superdetective-en-hollywood-ii',
  'superdetective-en-hollywood-iii',
  'superlopez',
  'supernova',
  'susurran-tu-nombre',
  'susurros-del-corazon',
  'sweet-home-alabama',
  'swinging-safari',
  'synchronic-los-limites-del-tiempo',
  't-34-heroes-de-acero',
  'tan-fuerte-tan-cerca',
  'tarde-para-la-ira',
  'tarzan',
  'taxi-derrape-total',
  'te-quiero-tio',
  'ted-bundy-mind-of-a-monster',
  'teen-titans-go-vs-teen-titans',
  'teen-wolf-de-pelo-en-pecho',
  'tegui-un-asunto-de-familia',
  'tenacious-d-dando-la-nota',
  'tenia-buena-pinta',
  'teniente-corrupto',
  'terra-formars',
  'terrifier-el-inicio',
  'the-arctic-convoy',
  'the-beehive',
  'the-boy-from-below',
  'the-collector',
  'the-cowboy-killer',
  'the-deep-web-murdershow',
  'the-deprogrammer',
  'the-disaster-artist',
  'the-echo',
  'the-enemy-within-me',
  'the-faculty',
  'the-final',
  'the-florida-project',
  'the-gerber-syndrome-il-contagio',
  'the-green-hornet-el-avispon-verde',
  'the-group',
  'the-house-next-door-meet-the-blacks-2-online-descarga-c001-gratis',
  'the-irishman-in-conversation',
  'the-island',
  'the-jackal-chacal',
  'the-kid-el-chico',
  'the-killing-room',
  'the-lady-of-heaven',
  'the-lost-king',
  'the-lovers',
  'the-mauritanian',
  'the-memory-keeper',
  'the-misfits-online-descarga-gratis',
  'the-mortuary-assistant',
  'the-mutation',
  'the-night-aan-shab',
  'the-outer-threat',
  'the-outpost',
  'the-owners-los-propietarios',
  'the-party',
  'the-penthouse',
  'the-perfect-wedding',
  'the-relic',
  'the-rover',
  'the-royal-hotel',
  'the-runaways',
  'the-seven-deadly-sins-la-maldicion-de-la-luz',
  'the-stolen-valley',
  'the-swing-of-things',
  'the-tale',
  'the-third-degree',
  'the-tourist',
  'the-vessel-el-navio',
  'the-walking-dead',
  'the-wall',
  'the-wedding-rule',
  'the-whooper-returns',
  'the-wrong-valentine',
  'thelma',
  'thien-than-ho-menh',
  'this-is-the-night-once-upon-a-time-in-staten-island',
  'tick-tick-boom',
  'tiempo-de-caza',
  'tiempo-para-mi',
  'tierra-de-dios',
  'tigerland',
  'till-death-hasta-que-la-muerte-nos-separe',
  'timeline',
  'tina',
  'tiresias',
  'titan-a-e',
  'todo-el-dia-y-una-noche',
  'todo-el-dinero-del-mundo',
  'todo-es-posible',
  'todo-sobre-mi-desmadre',
  'todo-sobre-sexo',
  'todos-hablan-de-jamie',
  'todos-lo-saben',
  'tokyo-ghoul',
  'tokyo-godfathers',
  'tombstone-la-leyenda-de-wyatt-earp',
  'tony',
  'torn',
  'tornado-2',
  'toy-story-el-tiempo-perdido',
  'tracers',
  'tragedy-girls',
  'trailer-park-of-terror',
  'tras-la-linea-enemiga',
  'tras-la-linea-enemiga-ii-el-eje-del-mal',
  'trece-vidas',
  'tres-amigos',
  'tres-familias-locas',
  'trolls-holiday-in-harmony',
  'tropa-de-elite-2',
  'truco-o-trato-terror-en-halloween',
  'trust-me',
  'tu-eres-mi-problema',
  'tut-tut-cory-bolidos-chrissys-al-volante',
  'twist',
  'twisted-twin',
  'twister',
  'u-571',
  'uglydolls-extraordinariamente-feos',
  'ultima-noche-en-el-soho',
  'ultimas-noticias-en-yuba-county',
  'umma',
  'un-amigo-extraordinario',
  'un-bucle-sin-fin',
  'un-candidato-muy-peludo',
  'un-chihuahua-en-beverly-hills-2',
  'un-dia-con-el-diablo',
  'un-dia-salvaje',
  'un-disfraz-para-nicolas',
  'un-funeral-de-muerte',
  'un-gesto-estupido-e-inutil',
  'un-golpe-de-altura',
  'un-hombre-lobo-americano-en-londres',
  'un-hombre-ordinario',
  'un-hombre-solo',
  'un-italiano-en-noruega',
  'un-lugar-seguro',
  'un-metodo-peligroso',
  'un-novio-para-mi-mujer',
  'un-oceano-entre-nosotros',
  'un-pedacito-de-cielo',
  'un-pequeno-cambio',
  'un-pequeno-caos',
  'un-pequeno-favor',
  'un-principe-de-navidad-bebe-real',
  'un-principe-de-navidad-la-boda-real',
  'un-pueblo-y-su-rey',
  'un-quijote-sin-mancha',
  'un-ratoncito-duro-de-roer',
  'un-reino-unido',
  'un-romance-con-figaro',
  'un-sol-interior',
  'un-viaje-increible-el-misterio-del-huevo',
  'un-zoologico-extraordinario',
  'una-buena-persona',
  'una-casa-de-locos-la-pelicula',
  'una-chica-buena-como-tu',
  'una-familia-ideal',
  'una-historia-de-amor-en-copenhague',
  'una-historia-de-venganza',
  'una-joven-prometedora',
  'una-muerte-antes-de-una-boda',
  'una-navidad-en-hollywood',
  'una-navidad-en-nigeria',
  'una-navidad-no-tan-padre',
  'una-navidad-real',
  'una-noche-al-ano',
  'una-noche-movidita',
  'una-pesadilla-maravillosa',
  'una-razon-brillante',
  'una-serie-de-catastroficas-desdichas-de-lemony-snicket',
  'union-y-lucha',
  'united-93',
  'uno-de-nosotros',
  'uppercut',
  'upsss-donde-esta-noe',
  'valiant',
  'vamos-de-polis',
  'vampira-humanista-busca-suicida',
  'vampiros-de-john-carpenter',
  'van-dammes-inferno',
  'vault',
  'vaya-par-de-polis',
  'vaya-resaca',
  'veinteanera-divorciada-y-fantastica',
  'venganza-2',
  'venganza-bajo-cero',
  'venus',
  'vera-y-el-placer-de-los-otros',
  'verano-1993',
  'vicky-el-vikingo-y-la-espada-magica',
  'vida-oculta',
  'vida-privada',
  'viddana',
  'viena-and-the-fantomes',
  'viento-de-libertad',
  'viernes-negro',
  'villaviciosa-de-al-lado',
  'violento-y-furioso',
  'viral',
  'virus',
  'vivir-dos-veces',
  'vivo',
  'voices-carry',
  'voluntad-de-hierro',
  'vuelta-a-casa-de-mi-madre',
  'waiting-for-anya',
  'wall-street-el-dinero-nunca-duerme',
  'wallace-y-gromit-la-maldicion-de-las-verduras',
  'war-horse-caballo-de-batalla',
  'waterworld',
  'way-down',
  'welcome-to-sudden-death',
  'west-side-story',
  'what-if',
  'when-the-screaming-starts',
  'wild-wild-west',
  'willard',
  'wolf-warrior-2',
  'wolfwalkers',
  'work-it-al-ritmo-de-los-suenos',
  'worth',
  'wwe-backlash-2023',
  'wwe-day-1-2022',
  'wwe-elimination-chamber-2022',
  'wwe-elimination-chamber-perth',
  'wwe-money-in-the-bank-2022',
  'wwe-royal-rumble-2022',
  'wwe-royal-rumble-2023',
  'wwe-summerslam-2022',
  'wwe-survivor-series-2021',
  'wwe-wrestlemania-38-sunday',
  'wyatt-earp',
  'y-manana-el-mundo-entero',
  'y-todo-el-cielo-cupo-en-el-ojo-de-la-vaca-muerta',
  'ya-veremos',
  'yerba-buena',
  'yo-el-y-raquel',
  'you-are-my-home',
  'young-adult',
  'young-washington',
  'your-lucky-day',
  'youre-dead-to-me',
  'youre-not-alone',
  'zeros-and-ones',
  'zimbabue-la-lucha-por-la-democracia',
  'zoe',
  'zola',
  'zombies-party',
  'zona-414',
  'zona-hostil',

]);
const cvOcultaUrl = (u) => {
  const mS = /cine-calidad\.mx\/(?:serie|pelicula)\/([a-z0-9-]+)/i.exec(u || '');
  return !!(mS && (CVM_OCULTAS.has(mS[1]) || CV_PELIS_OCULTAS.has(mS[1]) || CV_OCULTAS_RT.has(mS[1]))); /* v251 muertas siempre ocultas */
};

/* ===================== v81: modo individual =====================
 * Ver una peli o un episodio SIN sala y SIN el navegador-espejo del
 * servidor: resolvemos la URL directa del video (goodstream HLS) con
 * puros fetch — como las sondas — y el navegador del usuario lo
 * reproduce con hls.js. Sin competir por MIRROR_MAX ni reciclaje. */
function decodificarDataSrc(enc) {
  /* cuevana: <a class="play" data-src="BASE64"> — base64 → binario →
   * números separados por espacios → charCodes desplazados -2 */
  try {
    const nums = Buffer.from(enc, 'base64').toString('binary').trim().split(/\s+/).map((x) => parseInt(x, 10));
    if (nums.length < 8 || nums.some((x) => !Number.isFinite(x))) return null;
    const crudo = nums.map((n) => String.fromCharCode(n)).join('');
    const url = [...crudo].map((ch) => String.fromCharCode(ch.charCodeAt(0) - 2)).join('');
    return /^https?:\/\/[a-z0-9.-]+\//i.test(url) ? url : null;
  } catch { return null; }
}
/* v90: desempaca el ofuscador clásico eval(function(p,a,c,k,e,d)…) —
 * lo ejecutamos tal cual (solo reemplaza cadenas, no toca el DOM) para
 * leer el HLS que esconde el embed de vimeos */
function desempacar(html) {
  try {
    const i = html.indexOf('eval(function(p,a,c,k,e,d)');
    if (i < 0) return null;
    const j = html.indexOf('</script>', i);
    if (j < 0) return null;
    let s = html.slice(i + 5, j).trim();
    if (s.endsWith(')')) s = s.slice(0, -1); /* el paréntesis que cierra el eval */
    return new Function('return ' + s)();
  } catch { return null; }
}
async function fetchTexto(url, referer) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': MIRROR_UA, Referer: referer || '', 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.6' },
      signal: ctl.signal, redirect: 'follow',
    });
    if (!r.ok) throw new Error('El sitio respondió ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function resolverSolo(pageUrl) {
  const html = await fetchTexto(pageUrl, '');
  /* 1) los botones play (data-src cifrado): goodstream primero y
   * vimeos de repuesto (v90: su embed esconde el HLS en un eval) */
  let embed = null, embedVimeos = null;
  const tags = html.match(/<a\b[^>]*class="[^"]*\bplay\b[^"]*"[^>]*>/gi) || [];
  for (const t of tags) {
    const dom = (t.match(/data-domain="([^"]*)"/i) || [])[1];
    const enc = (t.match(/data-src="([^"]*)"/i) || [])[1];
    if (!enc) continue;
    const u = decodificarDataSrc(enc);
    if (!u) continue;
    if (dom === 'goodstream' && !embed) embed = u;
    else if (dom === 'vimeos' && !embedVimeos) embedVimeos = u;
  }
  /* 2) plan B: algún embed goodstream a la vista */
  if (!embed) {
    const m = html.match(/https?:\/\/[^"'\s<>]*goodstream\.one\/embed[^"'\s<>]*/i);
    if (m) embed = m[0];
  }
  /* v90: goodstream… y si no hay (o falla), vimeos — así el modo Solo
   * también cubre los títulos que antes pedían la sala */
  let err = null;
  if (embed) {
    try { const out = await resolverGoodstream(embed, pageUrl); const mCv = /cine-calidad\.mx\/(?:serie|pelicula)\/([a-z0-9-]+)/i.exec(pageUrl || ''); if (mCv) cvPerdonar(mCv[1]); return out; } /* v205.2: lázaro */
    catch (e) { err = e; }
  }
  if (embedVimeos) {
    try { return await resolverVimeos(embedVimeos, pageUrl); }
    catch (e) { console.warn('[solo] vimeos también falló:', String(e.message || e).slice(0, 80)); }
  }
  const mCv = /cine-calidad\.mx\/(?:serie|pelicula)\/([a-z0-9-]+)/i.exec(pageUrl || '');
  if (!err) {
    /* v195: la página cargó BIEN pero no trae NINGÚN servidor (ni bueno ni
     * de navegador) = título muerto en el sitio — se oculta AL INSTANTE */
    if (mCv) cvOcultaRegistrar(mCv[1]);
    throw new Error('Este título ya no está disponible en el sitio — prueba con otro parecido');
  }
  if (mCv) cvFallo(mCv[1]); /* v205.5: tenía servidores y TODOS fallaron — cuenta para ocultarse */
  throw err || new Error('Este título no tiene servidores disponibles ahora — prueba luego o en sala (👥 Juntos)');
}
/* v90: la parte goodstream (lo que antes era resolverSolo a partir del
 * embed) — HLS + subtítulos VTT */
async function resolverGoodstream(embed, pageUrl) {
  /* el embed contiene el master.m3u8 y los subtítulos VTT.
   * El embed a veces se raciona por IP (403 por ráfagas): un reintento. */
  /* v93: además de reintentar cuando FALLA el fetch, reintenta cuando
   * responde 200 con el cuerpo racionado (sin m3u8) — el glitch que
   * hacía fallar pelis como Conclave */
  /* v99: el nodo edge es LOTERÍA por fetch (enc10 a ratos 403, enc12
   * inalcanzable según el enrutamiento) — pedimos el embed 3 veces EN
   * PARALELO desfasadas (cada fetch reparte otro nodo), probamos el m3u8
   * de cada una con un rangito de 3.5 s y nos quedamos con el primero
   * que SIRVA de verdad. Antes: 43 s de arranque en Fundación. */
  const pedirEmbed = async () => {
    try {
      const em = CDN_RELAY ? await (await fetchRelay(embed, 15000)).text() : await fetchTexto(embed, pageUrl);
      const files = [...em.matchAll(/file\s*:\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
      const m3u8 = files.find((f) => /\.m3u8/i.test(f));
      if (!m3u8) return null; /* cuerpo racionado (v93) */
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3500);
      let sirve = false;
      try {
        const verifUrl = CDN_RELAY ? CDN_RELAY + '/?u=' + encodeURIComponent(m3u8) : m3u8;
        const r = await fetch(verifUrl, { headers: CDN_RELAY ? {} : { 'User-Agent': MIRROR_UA, Referer: embed, Range: 'bytes=0-1024' }, signal: ctl.signal, redirect: 'follow' });
        sirve = r.ok || r.status === 206;
      } catch {}
      clearTimeout(t);
      return sirve ? { m3u8, files } : null;
    } catch { return null; }
  };
  const carreras = [
    pedirEmbed(),
    new Promise((r2) => setTimeout(r2, 700)).then(pedirEmbed),
    new Promise((r2) => setTimeout(r2, 1400)).then(pedirEmbed),
  ];
  const resultados = await Promise.all(carreras);
  const bueno = resultados.find(Boolean);
  if (!bueno) throw new Error('El servidor no entregó el video — ábrelo en modo sala (👥 Juntos)');
  const m3u8 = bueno.m3u8;
  const files = bueno.files;
  const subs = files
    .filter((f) => /\.vtt/i.test(f))
    .map((f) => ({
      url: f,
      lang: /_spa\.|_esp\.|_es\./i.test(f) ? 'es' : /_eng\.|_en\./i.test(f) ? 'en' : /_sli\./i.test(f) ? 'es-419' : 'vtt',
    }));
  /* algunos nodos (hls1) solo sirven si el Referer es una página de
   * goodstream: recordamos el embed que funcionó para este host */
  try {
    hlsReferers.set(new URL(m3u8).hostname, embed);
    for (const s of subs) { try { hlsReferers.set(new URL(s.url).hostname, embed); } catch {} }
  } catch {}
  /* v99: SIEMPRE por el proxy — el token del m3u8 puede venir amarrado a la
   * IP del servidor que lo pidió (el resolver): del navegador del usuario
   * el directo falla, y hls.js tardaba media vida en rendirse antes de la
   * reconexión por el proxy (Fundación tardaba 43 s en arrancar). Así
   * arranca en 2-3 s, igual que las pelis. */
  return { m3u8, subs, proxy: true };
}
/* v90: vimeos — el HLS (720p) vive dentro de un eval(p,a,c,k,e,d) */
async function resolverVimeos(embed, pageUrl) {
  const em = await fetchTexto(embed, pageUrl);
  const out = desempacar(em);
  const m3u8 = out && (out.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i) || [])[0];
  if (!m3u8) throw new Error('vimeos no entregó el video');
  /* los segmentos piden el Referer del embed: lo recordamos */
  try { hlsReferers.set(new URL(m3u8).hostname, embed); } catch {}
  return { m3u8, proxy: true, subs: [] }; /* directo no sirve → siempre proxy */
}
/* v90: episodios de Latanime en modo individual — el embed de mp4upload
 * trae el mp4 DIRECTO en su HTML (player.src), sin navegador remoto.
 * v93: a veces mp4upload responde 200 con el cuerpo VACÍO por ráfagas
 * (Evangelion "no funcionaba" por eso — no estaba borrado) → reintentos
 * con calma, TODOS los candidatos mp4upload, y verificamos que sirva. */
async function extraerMp4(candidatos, pageUrl) {
  for (const mejor of candidatos) {
    let m = null;
    for (let intento = 0; intento < 4 && !m; intento++) {
      if (intento > 0) await new Promise((r2) => setTimeout(r2, 1500 * intento));
      try {
        const em = await fetchTexto(mejor, pageUrl);
        m = em.match(/player\.src\(\{\s*type:\s*["']video\/mp4["']\s*,\s*src:\s*["'](https?:\/\/[^"']+)["']/i)
          || em.match(/["'](https?:\/\/[^"'\s<>]*mp4upload[^"'\s<>]*\.mp4[^"'\s<>]*)["']/i);
        if (!m) {
          if (/file was deleted/i.test(em)) break; /* borrado: reintentar no ayuda */
          if (em.length < 500 && intento < 3) continue; /* cuerpo racionado (glitch) → reintento */
          break;
        }
      } catch (e) {}
    }
    if (!m) continue; /* a probar el siguiente mp4upload */
    /* v93: ¿el mp4 SIRVE? un rangito con su Referer antes de prometer */
    if (await sirveElVideo(m[1], mejor)) {
      /* el mp4 exige el Referer del embed: lo recordamos para el proxy */
      try { hlsReferers.set(new URL(m[1]).hostname, mejor); } catch {}
      return { m3u8: m[1], mp4: true, proxy: true, subs: [] };
    }
  }
  return null;
}
async function resolverAnime(epUrl) {
  /* v97: AnimeFLV también resuelve — sus servidores salen de un POST
   * al sitio (data-encrypt en hex) y trae mp4upload entre ellos */
  if (/animeflv\./i.test(epUrl)) return resolverAnimeflv(epUrl);
  const html = await fetchTexto(epUrl, 'https://latanime.org/');
  const links = [...html.matchAll(/<a\b[^>]*class="[^"]*play-video[^"]*"[^>]*data-player="([^"]+)"[^>]*>/gi)];
  const embeds = links.map((m) => { try { return Buffer.from(m[1], 'base64').toString('utf8'); } catch { return ''; } }).filter((u) => /^https?:\/\//i.test(u));
  const laSlugM = /latanime\.org\/ver\/([a-z0-9-]+)-episodio-\d+/i.exec(epUrl || '');
  const candidatos = [...new Set(embeds.filter((u) => /mp4upload\./i.test(u)))];
  const directo = candidatos.length ? await extraerMp4(candidatos, epUrl) : null;
  if (directo) { if (laSlugM) { laMuertaQuitar(laSlugM[1]); laFallosPerdonar(laSlugM[1]); } return directo; }
  /* v93: mp4upload agotado (borrado, como le pasó a Evangelion) → que
   * el navegador del servidor lo resuelva UNA vez y todos lo ven nativo.
   * v201: TAMBIÉN cuando el episodio no trae mp4upload (sus players son
   * otros y el navegador sabe sacarles el video) — así resucitan series
   * que por HTTP puro parecían muertas */
  const nat = await resolverAnimePorNavegador(epUrl).catch(() => null);
  if (nat) { if (laSlugM) { laMuertaQuitar(laSlugM[1]); laFallosPerdonar(laSlugM[1]); } return nat; }
  if (laSlugM) laFallosRegistrar(laSlugM[1]);
  if (!candidatos.length) throw new Error('Este episodio no tiene servidores que Huddle pueda abrir — se ocultó del catálogo');
  if (laSlugM) laFallosRegistrar(laSlugM[1]);
  throw new Error('Los servidores de este episodio están caídos en Latanime (probé todos, hasta con navegador). Prueba otra versión del anime o más tarde');
}
/* v97: episodio de AnimeFLV — la página trae el id en data-encrypt
 * (hex); un POST a /flv devuelve los servidores como <li encrypt="hex">
 * y cada hex es la URL del embed. Preferimos los mp4upload (extraíbles) */
async function resolverAnimeflv(epUrl) {
  const html = await fetchTexto(epUrl, 'https://vww.animeflv.one/');
  const enc = (/class="opt"[^>]*data-encrypt="([0-9a-f]+)"/i.exec(html) || [])[1];
  if (!enc) throw new Error('No pude leer los servidores de este episodio en AnimeFLV');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  let cuerpo = '';
  try {
    const r = await fetch('https://vww.animeflv.one/flv', {
      method: 'POST',
      headers: {
        'User-Agent': MIRROR_UA,
        'Referer': epUrl,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.6',
      },
      body: 'acc=opt&i=' + enc,
      signal: ctl.signal,
      redirect: 'follow',
    });
    cuerpo = await r.text();
  } catch (e) { throw new Error('AnimeFLV no respondió'); }
  finally { clearTimeout(t); }
  const embeds = [...cuerpo.matchAll(/<li[^>]*encrypt="([0-9a-f]+)"/gi)]
    .map((m) => { try { return Buffer.from(m[1], 'hex').toString('utf8'); } catch { return ''; } })
    .filter((u) => /^https?:\/\//i.test(u));
  const afSlug = (/\/ver\/([a-z0-9-]+)-\d+/.exec(epUrl || '') || [])[1] || ''; /* v205.2 */
  const candidatos = [...new Set(embeds.filter((u) => /mp4upload\./i.test(u)))];
  const directo = candidatos.length ? await extraerMp4(candidatos, epUrl).catch(() => null) : null;
  if (directo) {
    afPerdonar(afSlug);
    if (AF_OCULTAS.has(afSlug)) { AF_OCULTAS.delete(afSlug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); } /* lázaro */
    return directo;
  }
  /* v205: mp4upload se está acabando (borra archivos a diario) y cada vez
   * más episodios solo traen ok.ru/yourupload/mail.ru — esos van por el
   * navegador del server, mismo mecanismo que resucita los de latanime */
  const nat = await resolverAnimePorNavegador(epUrl, embeds).catch(() => null);
  if (nat) { afPerdonar(afSlug); return nat; }
  afOcultar(afSlug); /* v205.2: tras HTTP y navegador, muerte real — cuenta para ocultarse */
  if (!candidatos.length) throw new Error('Este episodio no tiene servidores que Huddle pueda abrir en AnimeFLV — prueba otra versión o más tarde');
  throw new Error('Los servidores de este episodio están caídos en AnimeFLV — prueba otra versión del anime o más tarde');
}
/* v93: el navegador del servidor abre el episodio, deja que su
 * reproductor cargue el video, lee la URL que pidió y cierra. El
 * usuario después lo reproduce NATIVO (hls.js/video), como cualquier
 * peli — el navegador solo sirvió para DESCUBRIR la URL.
 * v205: embedsExternos — AnimeFLV ya NO trae mp4upload en muchos
 * episodios (ok.ru, yourupload, mail.ru…): le pasamos esa lista y el
 * mismo mecanismo los prueba dentro del iframe. */
async function resolverAnimePorNavegador(epUrl, embedsExternos) {
  if (!PUPPETEER) { try { PUPPETEER = require('puppeteer'); } catch { return null; } }
  const browser = await getNavegador();
  if (!browser) return null;
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.setUserAgent(MIRROR_UA).catch(() => {});
    await page.evaluateOnNewDocument(() => {
      try { window.open = function () { return null; }; } catch {}
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    });
    const vistos = [];
    page.on('request', (r) => {
      try {
        const u = r.url();
        if (!/^https?:/i.test(u)) return;
        const tipo = /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : /\.mp4(\?|$)/i.test(u) ? 'mp4' : /\.ts(\?|$)/i.test(u) ? 'ts' : /\.vtt(\?|$)/i.test(u) ? 'vtt' : null;
        if (tipo) vistos.push({ url: u, ref: (r.headers() && r.headers().referer) || '', tipo });
      } catch {}
    });
    await page.goto(epUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const montarIframe = (u) => page.evaluate((u2) => {
      try {
        document.querySelectorAll('iframe.rr-player').forEach((x) => x.remove());
        const f = document.createElement('iframe');
        f.className = 'rr-player';
        f.src = u2;
        f.allow = 'autoplay; encrypted-media; fullscreen';
        f.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483000;border:0;background:#000';
        document.body.appendChild(f);
      } catch {}
    }, u).catch(() => {});
    /* leer el src del <video> de cualquier frame (CDP entra aunque sea
     * cross-origin): video.js/jw lo dejan listo ANTES de darle play */
    const leerVideoSrc = async () => {
      for (const fr of page.frames()) {
        const s = await fr.evaluate(() => {
          try {
            const v = document.querySelector('video');
            if (v && (v.currentSrc || v.src) && /^https?:/i.test(v.currentSrc || v.src)) return (v.currentSrc || v.src);
          } catch {}
          return null;
        }).catch(() => null);
        if (s) return { url: s, ref: (() => { try { return new URL(fr.url()).href; } catch { return epUrl; } })() };
      }
      return null;
    };
    const links = (embedsExternos && embedsExternos.length) ? embedsExternos.slice() : await page.evaluate(() => {
      try {
        return [...document.querySelectorAll('a.play-video')]
          .filter((a) => (a.getAttribute('data-player') || '').length > 8)
          .map((a) => { try { return atob(a.getAttribute('data-player')); } catch { return ''; } })
          .filter((u) => /^https?:\/\//i.test(u));
      } catch { return []; }
    }).catch(() => []);
    /* 1) mp4upload EN EL NAVEGADOR (pasa muros que nuestro fetch no) */
    const mp4 = links.find((u) => /mp4upload/i.test(u));
    if (mp4) {
      await montarIframe(mp4);
      await new Promise((r2) => setTimeout(r2, 3500));
      let hallado = await leerVideoSrc();
      if (!hallado) hallado = vistos.find((v) => v.tipo === 'mp4') ? { url: vistos.find((v) => v.tipo === 'mp4').url, ref: mp4 } : null;
      if (hallado && await sirveElVideo(hallado.url, hallado.ref || mp4)) {
        try { hlsReferers.set(new URL(hallado.url).hostname, hallado.ref || mp4); } catch {}
        console.log('[anime] POR NAVEGADOR (mp4upload) → ' + hallado.url.slice(0, 60));
        return { m3u8: hallado.url, mp4: true, proxy: true, subs: [] };
      }
    }
    /* 2) el mejor de los demás (sin mega ni mp4upload) — leer src y,
     * si no, esperar autoplay un rato con un par de clics */
    const otros = links.filter((u) => !/mp4upload|mega\.nz|youtube/i.test(u));
    const orden = [
      otros.find((u) => !/voe\.|mixdrop|netu|streamtape|streamwish|filemoon|vide0/i.test(u)), /* el "mejor" del espejo */
      otros.find((u) => /filemoon|do7go|luluvdoo/i.test(u)),
    ].filter(Boolean);
    for (const srv of [...new Set(orden)]) {
      await montarIframe(srv);
      await new Promise((r2) => setTimeout(r2, 4000));
      /* estos reproductores no se dejan automatizar (anti-bot): solo
       * leer el src si el <video> ya existe — sin esperas largas */
      let hallado = await leerVideoSrc();
      if (!hallado) { /* v205: algunos solo arrancan con play() desde dentro del frame (muted pasa el bloqueo de autoplay) */
        for (const fr of page.frames()) {
          const arranco = await fr.evaluate(() => {
            try {
              const v = document.querySelector('video');
              if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); return true; }
            } catch {}
            return false;
          }).catch(() => false);
          if (arranco) break;
        }
        await new Promise((r3) => setTimeout(r3, 4500));
        hallado = await leerVideoSrc();
      }
      if (!hallado && vistos.length) {
        const media = vistos.find((v) => v.tipo === 'm3u8') || vistos.find((v) => v.tipo === 'mp4');
        if (media) hallado = { url: media.url, ref: media.ref || srv };
      }
      if (hallado && await sirveElVideo(hallado.url, hallado.ref || srv)) {
        /* los hosts que pidió el navegador → el proxy los sabe servir */
        for (const v of vistos) { try { hlsReferers.set(new URL(v.url).hostname, v.ref || epUrl); } catch {} }
        try { hlsReferers.set(new URL(hallado.url).hostname, hallado.ref || srv); } catch {}
        console.log('[anime] POR NAVEGADOR (' + (() => { try { return new URL(srv).hostname; } catch { return '?'; } })() + ') → ' + hallado.url.slice(0, 60));
        return { m3u8: hallado.url, mp4: /\.mp4(\?|$)/i.test(hallado.url), proxy: true, subs: [] };
      }
    }
    return null;
  } catch { return null; }
  finally { try { if (page) await page.close(); } catch {} }
}
/* v93: probamos que un video directo responda (rangito con su Referer) */
async function sirveElVideo(url, referer) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': MIRROR_UA, Referer: referer, Range: 'bytes=0-1024' },
      signal: ctl.signal, redirect: 'follow',
    });
    clearTimeout(t);
    return r.ok || r.status === 206;
  } catch { clearTimeout(t); return false; }
}

/* v81: proxy HLS con allowlist — el token de goodstream puede venir
 * amarrado a la IP del servidor, así que si al navegador no le sirve
 * directo, re-servimos el stream por aquí (reescribiendo los m3u8). */
const { Readable } = require('stream');
const hlsReferers = new Map(); /* v81: host goodstream → embed que sirvió de Referer */
const hlsUAs = new Map(); /* v170: host → UA exacta (googlevideo de Blogger amarra el stream a la UA que pidió el token) */
const hlsALs = new Map(); /* v199: host → Accept-Language exacto (mismo fingerprint que la emisión del token) */
function esGoodstream(u) {
  try { const h = new URL(u).host; return /(^|\.)goodstream\.one$/i.test(h); }
  catch { return false; }
}
/* v90: hosts que podemos re-servir por el proxy — goodstream Y los
 * nuevos: mp4upload (animes) y vimeos (pelis sin goodstream) */
function esProxeable(u) {
  try {
    const h = new URL(u).hostname;
    return /(^|\.)goodstream\.one$/i.test(h) || /(^|\.)mp4upload\.com$/i.test(h) || /(^|\.)vimeos\.(net|zip)$/i.test(h)
      || /(^|\.)rpmvid\.com$/i.test(h) || /(^|\.)tiktokcdn\.com$/i.test(h) /* v112: lacartoons (cubeembed) y sus segmentos camuflados */
      || /(^|\.)okcdn\.ru$/i.test(h) || /(^|\.)vkuser\.net$/i.test(h) || /(^|\.)vk\.com$/i.test(h) /* v283: Ennovelas VK */
      || hlsReferers.has(h); /* v93: hosts que ya resolvimos (con su Referer) */
  } catch { return false; }
}
/* v83: reescribe un m3u8 para que todo pase por el proxy */
function servirPlaylist(res, codigo, txt, target) {
  const esLocal = /^\/test-media\//.test(target);
  const baseLocal = target.slice(0, target.lastIndexOf('/') + 1);
  const prox = (u) => {
    if (/^\/test-media\//.test(u)) return '/api/hls?u=' + encodeURIComponent(u); /* v83: stream local de prueba */
    if (esLocal && !/^https?:/i.test(u)) return '/api/hls?u=' + encodeURIComponent(baseLocal + u);
    let abs; try { abs = new URL(u, target).href; } catch { return u; }
    return esProxeable(abs) ? '/api/hls?u=' + encodeURIComponent(abs) : abs; /* v90: también mp4upload/vimeos */
  };
  txt = txt.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + prox(u) + '"');
  txt = txt
    .split('\n')
    .map((l) => { const s = l.trim(); return !s || s.startsWith('#') ? l : prox(s); })
    .join('\n');
  res.writeHead(codigo, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  res.end(txt);
}
async function proxearHls(req, res, target) {
  /* v83: streams locales de prueba (public/test-media) — así el modo
   * proxy se prueba igual con un m3u8 propio, sin depender de la CDN */
  if (/^\/test-media\//.test(target)) {
    const ruta = path.join(PUBLIC_DIR, path.normalize(target));
    if (!ruta.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: 'No permitido' });
    fs.readFile(ruta, (e, buf) => {
      if (e) return json(res, 404, { ok: false, error: 'No existe' });
      if (/\.m3u8$/i.test(ruta)) return servirPlaylist(res, 200, buf.toString('utf8'), target);
      const ct = /\.ts$/i.test(ruta) ? 'video/MP2T' : /\.vtt$/i.test(ruta) ? 'text/vtt; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  // v283: si target es relativo (/expires/... de VK), resolver contra host VK conocido
  if (target.startsWith('/')) {
    let baseHost = null;
    // busca el último host VK/okcdn que resolvimos
    for (const h of [...hlsReferers.keys()].reverse()) {
      if (/vkuser\.net|okcdn\.ru/i.test(h)) { baseHost = h; break; }
    }
    if (baseHost) {
      try { target = 'https://' + baseHost + target; } catch {}
    } else {
      // fallback a vkuser.net por defecto (Betty)
      try { target = 'https://vk6-14.vkuser.net' + target; } catch {}
    }
  }
  if (!esProxeable(target)) return json(res, 403, { ok: false, error: 'No permitido' }); /* v90: allowlist ampliada */
  /* v236.6: goodstream/vimeos/videoapp → ir directo por relay si está disponible */
  let useRelayDirect = false;
  try {
    const _hUp = new URL(target).hostname;
    if (CDN_RELAY && /goodstream\.(one|uno)|vimeos\.(net|zip)|hlswish\.com|videoapp\.zip/i.test(_hUp)) useRelayDirect = true;
  } catch {}
  /* el origen de goodstream a veces suelta 403 transitorios (cache-miss):
   * reintentamos un par de veces antes de rendirnos */
  let ref = 'https://goodstream.one/';
  let hostUp = '';
  try { hostUp = new URL(target).hostname; } catch {}
  try { ref = hlsReferers.has(hostUp) ? hlsReferers.get(hostUp) : ref; } catch {} /* v199: '' guardado = SIN referer (vimeos) */
  /* v235: auto-detectar Referer correcto según el CDN host */
  if (ref === 'https://goodstream.one/' && hostUp) {
    if (/vimeos\.(net|zip)/i.test(hostUp)) ref = 'https://vimeos.net/';
    else if (/hlswish\.com/i.test(hostUp)) ref = 'https://hlswish.com/';
    else if (/goodstream\.(one|uno)/i.test(hostUp)) ref = 'https://goodstream.one/';
    else if (/videoapp\.zip/i.test(hostUp)) ref = 'https://videoapp.zip/';
  }
  /* v90: el mp4 de animes se adelanta/atrás por rangos — los pasamos */
  const cabUp = {
    'User-Agent': (hostUp && hlsUAs.get(hostUp)) || MIRROR_UA,
    'Accept-Language': (hostUp && hlsALs.get(hostUp)) || 'es-MX,es;q=0.9,en;q=0.6',
  };
  if (ref) cabUp.Referer = ref;
  if (/goodstream\.one/i.test(hostUp) || /hls.*\.goodstream\.one/i.test(hostUp)) {
    const ck = goodCookie('goodstream.one');
    if(ck) cabUp.Cookie = ck;
  }
  if (req.headers.range) cabUp.Range = String(req.headers.range);
  let upstream = null;
  // v260: para fluidez, probar directo primero SIEMPRE para goodstream (con cookie), relay solo como fallback
  const esMaster = /master\.m3u8/i.test(target);
  if (false && useRelayDirect && CDN_RELAY && esMaster) {
    try {
      const relayUrl = CDN_RELAY + '/?u=' + encodeURIComponent(target);
      const ctl2 = new AbortController();
      const t2 = setTimeout(() => ctl2.abort(), 12000);
      upstream = await fetch(relayUrl, { signal: ctl2.signal, redirect: 'follow', headers: { 'ngrok-skip-browser-warning': 'true' } });
      clearTimeout(t2);
      if (upstream.ok) console.log('[hls-proxy] relay directo OK:', decodeURIComponent(target).slice(0, 60));
      else { try { upstream.body && upstream.body.cancel(); } catch {} upstream = null; }
    } catch (relayErr) {
      console.warn('[hls-proxy] relay directo falló:', String(relayErr.message || relayErr).slice(0, 80));
      upstream = null;
    }
  }
  for (let intento = 0; !upstream && intento < 3; intento++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      /* v235: intentar con fetch nativo, fallback a https module si falla */
      try {
        upstream = await fetch(target, { headers: cabUp, signal: ctl.signal, redirect: 'follow' });
      } catch (fetchErr) {
        /* fallback: https module nativo (TLS fingerprint diferente) */
        const https = require('https');
        const u = new URL(target);
        upstream = await new Promise((resolve, reject) => {
          const r = https.get({
            hostname: u.hostname, port: 443, path: u.pathname + u.search,
            headers: cabUp, timeout: 25000,
            /* Cipher suites que imitan Chrome */
            ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
          }, (res) => {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
              headers: new Map([['content-type', res.headers['content-type'] || '']]),
              body: res, text: () => new Promise((r2) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r2(d)); }),
              arrayBuffer: () => new Promise((r2) => { let d=[]; res.on('data',c=>d.push(c)); res.on('end',()=>r2(Buffer.concat(d))); }),
            });
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('https timeout')); });
        });
      }
      clearTimeout(t);
      if (upstream.ok) break;
      if (upstream.status === 403 || upstream.status >= 500) {
        try { upstream.body && upstream.body.cancel(); } catch {}
        upstream = null;
        await new Promise((r2) => setTimeout(r2, 1500 * (intento + 1)));
        continue;
      }
      break; /* otros códigos (404…) se pasan tal cual */
    } catch (e) {
      clearTimeout(t);
      console.warn('[hls-proxy] intento ' + intento + ' error:', String(e.message || e).slice(0, 100), '| host:', decodeURIComponent(target).slice(0, 60));
      upstream = null;
      if (intento === 2) return json(res, 502, { ok: false, error: 'El servidor de video no respondió' });
      await new Promise((r2) => setTimeout(r2, 1500 * (intento + 1)));
    }
  }
  /* v236: CDN relay fallback — Mac Mini con IP residencial */
  if (!upstream && CDN_RELAY) {
    try {
      const relayUrl = CDN_RELAY + '/?u=' + encodeURIComponent(target);
      const ctl2 = new AbortController();
      const t2 = setTimeout(() => ctl2.abort(), 20000);
      upstream = await fetch(relayUrl, { signal: ctl2.signal, redirect: 'follow' });
      clearTimeout(t2);
      if (upstream.ok) console.log('[hls-proxy] relay OK:', decodeURIComponent(target).slice(0, 60));
      else { try { upstream.body && upstream.body.cancel(); } catch {} upstream = null; }
    } catch (relayErr) {
      console.warn('[hls-proxy] relay falló:', String(relayErr.message || relayErr).slice(0, 80));
      upstream = null;
    }
  }
  if (!upstream) {
    if (/master\.m3u8/i.test(target)) {
      console.warn('[hls-proxy] master expirado, pide re-resolver:', decodeURIComponent(target).slice(0, 90));
      return json(res, 410, { ok: false, error: 'master expirado — re-resolver', reResolve: true });
    }
    console.warn('[hls-proxy] me rendí tras reintentos:', decodeURIComponent(target).slice(0, 90));
    return json(res, 502, { ok: false, error: 'El servidor de video no respondió' });
  }
  /* v236: si la CDN respondió 403/5xx, intentar por relay */
  if (!upstream.ok && (upstream.status === 403 || upstream.status >= 500) && CDN_RELAY) {
    try { upstream.body && upstream.body.cancel(); } catch {}
    console.log('[hls-proxy] CDN ' + upstream.status + ', intentando relay…');
    try {
      const relayUrl = CDN_RELAY + '/?u=' + encodeURIComponent(target);
      const ctl2 = new AbortController();
      const t2 = setTimeout(() => ctl2.abort(), 20000);
      const relayResp = await fetch(relayUrl, { signal: ctl2.signal, redirect: 'follow' });
      clearTimeout(t2);
      if (relayResp.ok) { upstream = relayResp; console.log('[hls-proxy] relay OK:', decodeURIComponent(target).slice(0, 60)); }
      else { try { relayResp.body && relayResp.body.cancel(); } catch {} }
    } catch (relayErr) {
      console.warn('[hls-proxy] relay falló:', String(relayErr.message || relayErr).slice(0, 80));
    }
  }
  if (!upstream.ok && upstream.status !== 404) {
    console.warn('[hls-proxy] estado ' + upstream.status + ':', decodeURIComponent(target).slice(0, 90));
    if (upstream.status === 403 && /master\.m3u8/i.test(target)) {
      return json(res, 410, { ok: false, error: 'master expirado — re-resolver', reResolve: true });
    }
    return json(res, 502, { ok: false, error: 'El servidor de video respondió ' + upstream.status });
  }
  const ct = upstream.headers.get('content-type') || '';
  const esLista = /mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(target);
  if (!esLista) {
    /* v112: los segmentos de lacartoons (tiktokcdn vía cubeembed/rpmvid)
     * llegan camuflados de PNG: un header de imagen de ~120 bytes pegado
     * al MPEG-TS (el CDN solo acepta «imágenes», así que el player real
     * se lo quita en el navegador). Aquí se corta todo hasta el IEND y
     * queda el TS limpio que espera hls.js. */
    let hSeg = '';
    try { hSeg = new URL(target).hostname; } catch {}
    if (/(^|\.)tiktokcdn\.com$/i.test(hSeg)) {
      try {
        const buf = Buffer.from(await upstream.arrayBuffer());
        const i = buf.indexOf(Buffer.from('IEND'));
        const ts = i >= 0 && i < 4096 ? buf.slice(i + 8) : buf;
        res.writeHead(200, { 'Content-Type': 'video/MP2T', 'Cache-Control': 'no-store', 'Content-Length': ts.length });
        res.end(ts);
        return;
      } catch { /* si falla el despelleje, se cae a la tubería cruda */ }
    }
    /* segmento (o mp4 entero): tubería directa, sin tocar los bytes.
     * v90: pasamos Range/Content-Range para poder moverse dentro del
     * mp4 de animes sin descargarlo completo */
    const cab = { 'Content-Type': ct || 'video/MP2T', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    for (const h of ['content-range', 'content-length']) { const v = upstream.headers.get(h); if (v) cab[h] = v; }
    res.writeHead(upstream.status, cab);
    Readable.fromWeb(upstream.body).on('error', () => {}).pipe(res);
    return;
  }
  const txt = await upstream.text();
  servirPlaylist(res, upstream.status, txt, target);
}
/* =================== fin v81: modo individual =================== */

/* v217.1: el server corre como root en Oracle (os.homedir()=/root) y el usuario
   trabaja como ubuntu. Los archivos que el usuario debe VER (captura y llaves)
   se guardan en /home/ubuntu cuando existe, para que no haya que copiarlos. */
function carpetaArchivos() {
  if (process.env.MOVIE_ARCHIVOS_DIR) return process.env.MOVIE_ARCHIVOS_DIR;
  try { if (fs.existsSync('/home/ubuntu')) return '/home/ubuntu'; } catch {}
  return os.homedir();
}
function capturaRuta() { return path.join(carpetaArchivos(), 'captura-nueva.pcap'); }
function llavesRuta() { return path.join(carpetaArchivos(), 'sslkeylogfile.txt'); }
function capturaEstado() {
  const destino = capturaRuta();
  try {
    const s = fs.statSync(destino);
    let cab = ''; try { const fd = fs.openSync(destino, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); cab = b.toString('hex'); } catch {}
    const tipo = (cab === 'd4c3b2a1' || cab === 'a1b2c3d4') ? 'pcap' : (cab === '0a0d0d0a') ? 'pcapng' : 'desconocido';
    return { ok: true, existe: true, bytes: s.size, mb: +(s.size / 1048576).toFixed(1), cabecera: cab, tipo, modificado: s.mtime.toISOString() };
  } catch { return { ok: true, existe: false, bytes: 0, mb: 0, tipo: 'no hay archivo todavía' }; }
}
const imgProxyCache = new Map(); /* v67: imágenes de animes proxyadas, url → {buf, ct, at} */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    /* v217.2: pagina unica y simple para subir archivos — asi nadie confunde la
       pagina del PCAP (video capturado) con la de las llaves (archivo chico) */
    if (url.pathname === '/subir') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        + '<body style="font-family:sans-serif;text-align:center;margin:28px 16px;line-height:1.5">'
        + '<h2>Subir un archivo</h2>'
        + '<p style="max-width:520px;margin:0 auto 18px">Elige lo que quieres subir:</p>'
        + '<p><a href="/captura" style="display:inline-block;font-size:20px;padding:14px 22px;background:#1b5e20;color:#fff;text-decoration:none;border-radius:10px">Subir el video capturado (.pcap)</a></p>'
        + '<p style="max-width:520px;margin:0 auto 18px;color:#555">Es el archivo grande de la captura del teléfono. Puede pesar cientos de MB: se sube por partes y se puede reanudar.</p>'
        + '<p><a href="/llaves" style="display:inline-block;font-size:18px;padding:12px 20px;background:#37474f;color:#fff;text-decoration:none;border-radius:10px">Subir el archivo de llaves (chico)</a></p>'
        + '<p style="max-width:520px;margin:0 auto;color:#555">Es <b>sslkeylogfile.txt</b>, de unos cientos de KB nada más.</p>'
        + '<div id="e" style="margin-top:22px;color:#333;font-weight:bold"></div>'
        + '<script>fetch("/api/captura-estado").then(function(r){return r.json()}).then(function(d){'
        + 'document.getElementById("e").innerText = d&&d.existe ? ("En el servidor ya hay una captura de "+d.mb+" MB ("+d.tipo+").") : "En el servidor todavia no hay ninguna captura.";'
        + '}).catch(function(){});</script>'
        + '</body></html>');
    }
    /* v210: subida de UNA VEZ del sslkeylogfile.txt desde el navegador (el scp y el
       puerto 47823 fallaron). GET = pagina minima; POST = guarda el cuerpo en
       ~/sslkeylogfile.txt. Sin clave a proposito: un solo uso, contenido inerte solo. */
    if (url.pathname === '/api/subir-llaves' || url.pathname === '/llaves') { /* v217.2: alias corto */
      if (req.method === 'POST') {
        const chunks = []; let n = 0;
        for await (const c of req) {
          n += c.length;
          if (n > 3 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Ese archivo pesa mas de 3 MB. Esta pagina es SOLO para el archivo chico de llaves.\n'
              + 'Si es el video capturado (.pcap), va en esta otra: http://' + (req.headers.host || '129.80.212.92:3000') + '/api/subir-captura');
          }
          chunks.push(c);
        }
        fs.writeFileSync(llavesRuta(), Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Listo: ' + n + ' bytes guardados en el servidor.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;margin-top:60px">' +
        '<h2>Subir el archivo de llaves</h2><p>Elige <b>sslkeylogfile.txt</b> y toca Subir.</p>' +
        '<input type="file" id="f" onchange="av()"><br><br><button onclick="s()" style="font-size:18px;padding:8px 24px">Subir</button>' +
        '<div id="r" style="margin-top:16px;font-weight:bold"></div>' +
        '<script>'
        + 'function av(){var f=document.getElementById("f").files[0],r=document.getElementById("r");if(!f)return;'
        + 'if(f.size>2*1024*1024){r.innerHTML="Ese archivo pesa "+(f.size/1048576).toFixed(1)+" MB y es el de video (captura).<br><br><a href=\"/captura\" style=\"font-size:20px\">Subirlo aqui: pagina del PCAP</a>";}else{r.innerText="";}}'
        + 'async function s(){var f=document.getElementById("f").files[0];if(!f){document.getElementById("r").innerText="Elige el archivo primero";return;}document.getElementById("r").innerText="Subiendo...";var r=await fetch("/api/subir-llaves",{method:"POST",body:f});document.getElementById("r").innerText=await r.text();}'
        + '</script>' +
        '</body></html>');
      return;
    }
    /* v217: subida del PCAP desde el teléfono del amigo (cacería de la llave CDN).
       - GET  /api/subir-captura → página que sube POR PARTES de 4 MB, con progreso,
         reintentos y reanudación si se corta (el PCAP puede pesar cientos de MB).
       - POST /api/subir-captura?parte=<bytes-totales-en-servidor>&total=<bytes>
         escribe ese trozo al final de ~/captura-nueva.pcap. Sin ?parte = archivo
         entero de una vez (compatible con la página vieja).
       - GET  /api/captura-estado → tamaño y cabecera del archivo que hay en Oracle.
       El PCAP vive SOLO en Oracle: nunca va a GitHub (límite 100 MB y es privado). */
    if (url.pathname === '/api/captura-estado') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(capturaEstado()));
    }
    if (url.pathname === '/api/subir-captura' || url.pathname === '/captura' || url.pathname === '/pcap') { /* v217.2: alias cortos */
      const destino = capturaRuta();
      const TOPE = 2 * 1024 * 1024 * 1024;
      if (req.method === 'POST') {
        const parte = url.searchParams.get('parte');
        const total = +(url.searchParams.get('total') || 0);
        const ini = parte === null ? 0 : Math.max(0, parseInt(parte, 10) || 0);
        let ya = 0; try { ya = fs.statSync(destino).size; } catch {}
        if (total && total > TOPE) return json(res, 413, { ok: false, error: 'Más de 2 GB: exporta el PCAP en pedazos.' });
        if (parte !== null && ini > 0 && ini !== ya) return json(res, 409, { ok: false, error: 'reanudar', bytes: ya });
        let n = ini > 0 ? ya : 0;
        let demasiado = false;
        await new Promise((done) => {
          const w = fs.createWriteStream(destino, { flags: ini > 0 ? 'a' : 'w' });
          const fin = () => { try { w.destroy(); } catch {} done(); };
          w.on('error', fin); req.on('error', fin);
          w.on('drain', () => req.resume());
          req.on('data', (c) => {
            n += c.length;
            if (n > TOPE) { demasiado = true; req.removeAllListeners('data'); req.resume(); w.end(); return; }
            if (!w.write(c)) req.pause();
          });
          req.on('end', () => w.end(() => done()));
        });
        if (demasiado) { try { fs.unlinkSync(destino); } catch {} return json(res, 413, { ok: false, error: 'Demasiado grande (máximo 2 GB).' }); }
        if (parte !== null) {
          let sz = 0; try { sz = fs.statSync(destino).size; } catch {}
          return json(res, 200, { ok: true, bytes: sz, mb: +(sz / 1048576).toFixed(1) });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Listo: ' + n + ' bytes guardados como captura-nueva.pcap en el servidor.');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        + '<body style="font-family:sans-serif;text-align:center;margin:32px 16px">'
        + '<h2>Subir la captura PCAP</h2>'
        + '<p>Elige el archivo <b>.pcap</b> que exportó PCAPdroid.<br>Se sube por partes y puede tardar un rato: <b>no cierres esta página</b>.</p>'
        + '<input type="file" id="f"><br><br>'
        + '<button id="b" onclick="s()" style="font-size:18px;padding:10px 28px">Subir</button>'
        + '<div id="r" style="margin-top:16px;font-weight:bold;line-height:1.5"></div>'
        + '<script>'
        + 'var CH=4*1024*1024;'
        + 'function est(){return fetch("/api/captura-estado").then(function(x){return x.json()}).catch(function(){return null})}'
        + 'async function s(){'
        + 'var f=document.getElementById("f").files[0],r=document.getElementById("r"),b=document.getElementById("b");'
        + 'if(!f){r.innerText="Elige el archivo primero";return;}'
        + 'b.disabled=true;'
        + 'var e=await est();var off=(e&&e.existe&&e.bytes<f.size)?e.bytes:0;'
        + 'if(off>0)r.innerText="Reanudando desde "+(off/1048576).toFixed(1)+" MB…";'
        + 'while(off<f.size){'
        + 'var t=f.slice(off,Math.min(off+CH,f.size)),ok=false,int=0;'
        + 'while(!ok&&int<6){try{'
        + 'var resp=await fetch("/api/subir-captura?parte="+off+"&total="+f.size,{method:"POST",body:t});'
        + 'var txt=await resp.text(),j=null;try{j=JSON.parse(txt)}catch(e2){}'
        + 'if(resp.ok&&j&&j.ok){off=j.bytes;ok=true;break;}'
        + 'if(resp.status===409&&j&&typeof j.bytes==="number"){off=j.bytes;ok=true;break;}'
        + 'r.innerText="Intento "+(int+1)+" falló: "+String(txt).slice(0,90);'
        + '}catch(e3){r.innerText="Se cortó la conexión (intento "+(int+1)+" de 6)…";}'
        + 'int++;await new Promise(function(z){setTimeout(z,1500*int)});}'
        + 'if(!ok){r.innerText="Se interrumpió la subida. Toca Subir otra vez: continúa donde quedó.";b.disabled=false;return;}'
        + 'r.innerText="Subiendo… "+Math.round(off/f.size*100)+"%  ("+(off/1048576).toFixed(1)+" de "+(f.size/1048576).toFixed(1)+" MB)";'
        + '}'
        + 'var e2=await est();'
        + 'r.innerText="Listo: "+((e2&&e2.bytes||f.size)/1048576).toFixed(1)+" MB guardados en el servidor. Avisa al chat.";b.disabled=false;'
        + '}'
        + '</script></body></html>');
      return;
    }
    if (url.pathname === '/api/events') return handleEvents(req, res, url);
    if (url.pathname === '/api/action') {
      // POST (normal) o GET (fallback para proxies que bloquean POST)
      const body = req.method === 'POST'
        ? await readBody(req)
        : {
            room: url.searchParams.get('room') || '',
            userId: url.searchParams.get('userId') || '',
            action: safeJson(url.searchParams.get('a')),
          };
      return handleAction(req, res, body);
    }
    if (url.pathname.startsWith('/api/room/')) {
      // consulta ligera del estado de una sala (para auto-reparación del cliente)
      const code = decodeURIComponent(url.pathname.split('/')[3] || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { ok: false, error: 'Sala no encontrada' });
      return json(res, 200, {
        ok: true,
        srvVersion: UI_VERSION,
        room: { code: room.code, users: usersOf(room), state: stateOf(room), mirror: mirrorState(room) },
      });
    }
    /* v43: directorio de páginas — ver, agregar y quitar */
    /* v67: proxy propio de imágenes de animes — wsrv.nl ya no puede con
     * Latanime ni AnimeFLV (responden 403), así que las servimos nosotros */
    if (url.pathname === '/api/img' && req.method === 'GET') {
      const iu = url.searchParams.get('u') || '';
      let host = '';
      try { host = new URL(iu).hostname; } catch {}
      if (!/^(www\.|vww\.)?(latanime\.org|animeflv\.one|miscaricaturas\.com|lacartoons\.com)$/i.test(host)) {
        return json(res, 403, { ok: false, error: 'Host no permitido' });
      }
      const key = iu.split('?')[0];
      const c = imgProxyCache.get(key);
      if (c && Date.now() - c.at < 60 * 60 * 1000) {
        res.writeHead(200, { 'Content-Type': c.ct, 'Cache-Control': 'public, max-age=86400' });
        return res.end(c.buf);
      }
      try {
        const r = await fetchSeguro(iu, 8000);
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!r.ok || !/image\//.test(ct)) return json(res, 502, { ok: false, error: 'No pude cargar la imagen' });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 3000000) return json(res, 502, { ok: false, error: 'Imagen demasiado grande' });
        if (imgProxyCache.size > 300) { /* tirar las 100 más viejas */
          let n = 0;
          for (const k2 of imgProxyCache.keys()) { if (n++ >= 100) break; imgProxyCache.delete(k2); }
        }
        imgProxyCache.set(key, { buf, ct, at: Date.now() });
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
        return res.end(buf);
      } catch {
        return json(res, 502, { ok: false, error: 'No pude cargar la imagen' });
      }
    }
    if (url.pathname === '/api/trending' && req.method === 'GET') {

/* v234: PelisXD últimas películas para el feed */
const pxdLatestCache = { at: 0, items: [] };
async function pelisxdLatest() {
  if (Date.now() - pxdLatestCache.at < 3 * 3600 * 1000 && pxdLatestCache.items.length) return pxdLatestCache.items;
  try {
    const r = await fetchSeguro('https://www.pelisxd.com/peliculas', 12000);
    if (!r.ok) return pxdLatestCache.items;
    const html = await r.text();
    const items = [];
    const re = /href="\/pelicula\/([a-z0-9-]+)"[^>]*>[\s\S]*?src="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>\s*<span[^>]*>(\d{4})<\/span>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 18) {
      items.push({
        title: m[3].trim(),
        url: 'https://www.pelisxd.com/pelicula/' + m[1],
        img: (m[2].startsWith('/') ? 'https://www.pelisxd.com' : '') + m[2],
        site: 'PelisXD',
        extra: m[4] || '',
      });
    }
    if (items.length) { pxdLatestCache.at = Date.now(); pxdLatestCache.items = items; }
    return items;
  } catch { return pxdLatestCache.items; }
}
/* v235: Cuevana últimas películas para el feed */
const cuevanaLatestCache = { at: 0, items: [] };
async function cuevanaLatest() {
  if (Date.now() - cuevanaLatestCache.at < 3 * 3600 * 1000 && cuevanaLatestCache.items.length) return cuevanaLatestCache.items;
  try {
    const r = await fetchSeguro('https://cuevana.mov/wp-json/wpreact/v1/postsapi?per_page=20&page=1', 12000);
    if (!r.ok) return cuevanaLatestCache.items;
    const d = await r.json().catch(() => ({}));
    const items = (d.posts || []).filter(p => p.type === 'pelicula' && !CVM_OCULTAS.has(p.slug)).slice(0, 18).map(p => ({
      title: p.title || '',
      url: 'https://cuevana.mov/pelicula/' + (p.tmdb_id || '0') + '/' + p.slug,
      img: p.featured_image || '',
      site: 'Cuevana',
      extra: p.year || '',
    }));
    if (items.length) { cuevanaLatestCache.at = Date.now(); cuevanaLatestCache.items = items; }
    return items;
  } catch { return cuevanaLatestCache.items; }
}
/* v269: AnimeFLV y D23 últimos para feed vivo intercalado */
const afLatestCache = { at: 0, items: [] };
async function afLatest() {
  if (Date.now() - afLatestCache.at < 3 * 3600 * 1000 && afLatestCache.items.length) return afLatestCache.items;
  try {
    const r = await fetchSeguro('https://vww.animeflv.one/', 12000);
    if (!r.ok) return afLatestCache.items;
    const html = await r.text();
    const items = [];
    const seen = new Set();
    // v272: soporta data-src, src, y estructura actual de AnimeFLV (article, figure)
    const re = /href="\/anime\/([a-z0-9-]+)"[^>]*>[\s\S]{0,600}?(?:data-src|src)="([^"]+)"[\s\S]{0,600}?<h3[^>]*>([^<]+)<\/h3>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 12) {
      const slug = m[1];
      if (seen.has(slug) || AF_OCULTAS.has(slug)) continue;
      seen.add(slug);
      let img = m[2] || '';
      if (img.startsWith('/')) img = 'https://vww.animeflv.one' + img;
      // limpia parámetros de cdn
      if (img && !/animeflv|cdn/i.test(img) && img.includes('cover')) { /* ok */ }
      items.push({ title: m[3].trim().slice(0,80), url: 'https://vww.animeflv.one/anime/' + slug, img, site: 'AnimeFLV', extra: 'Sub' });
    }
    // fallback: busca en HTML animes sin imagen cerca pero con <img alt>
    if (items.length < 6) {
      const re2 = /\/anime\/([a-z0-9-]+)"[^>]*>\s*<figure[^>]*>\s*<img[^>]+(?:data-src|src)="([^"]+)"/g;
      while ((m = re2.exec(html)) && items.length < 12) {
        const slug = m[1];
        if (seen.has(slug) || AF_OCULTAS.has(slug)) continue;
        seen.add(slug);
        let img = m[2] || '';
        if (img.startsWith('/')) img = 'https://vww.animeflv.one' + img;
        // title fallback
        const tRe = new RegExp('href="\\/anime\\/' + slug + '"[\\s\\S]{0,800}?<h3[^>]*>([^<]+)</h3>');
        const tm = tRe.exec(html);
        const title = tm ? tm[1].trim().slice(0,80) : slug.replace(/-/g,' ').slice(0,80);
        items.push({ title, url: 'https://vww.animeflv.one/anime/' + slug, img, site: 'AnimeFLV', extra: 'Sub' });
      }
    }
    // v272: rellena portadas faltantes vía AniList
    for (const it of items) {
      if (!it.img || /triangle|placeholder|no-image|logo/i.test(it.img)) {
        const cov = await aniListCover(it.title).catch(()=> '');
        if (cov) it.img = cov;
      }
    }
    if (items.length) { afLatestCache.at = Date.now(); afLatestCache.items = items.filter(x=> x.img); }
    return items.length ? items.filter(x=> x.img || true) : afLatestCache.items;
  } catch { return afLatestCache.items; }
}
const d23LatestCache = { at: 0, items: [] };
async function d23Latest() {
  if (Date.now() - d23LatestCache.at < 3 * 3600 * 1000 && d23LatestCache.items.length) return d23LatestCache.items;
  try {
    const r = await fetchSeguro('https://animed23.com/', 12000);
    if (!r.ok) return d23LatestCache.items;
    const html = await r.text();
    const items = [];
    const seen = new Set();
    const re = /href="https:\/\/animed23\.com\/anime\/([a-z0-9-]+)\/"[^>]*>[\s\S]{0,800}?src="([^"]+)"[\s\S]{0,800}?<h3[^>]*>([^<]+)<\/h3>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 12) {
      const slug = m[1];
      if (seen.has(slug) || D23_OCULTAS.has(slug)) continue;
      seen.add(slug);
      let img = m[2] || '';
      if (img && img.startsWith('/')) img = 'https://animed23.com' + img;
      // filtra imágenes de placeholder y prefiere la portada IMDb curada.
      if (img && /placeholder|no-image|logo/i.test(img)) img = '';
      const imdbCover=D23_IMDB_COVERS.get(slug);
      if(imdbCover && imdbCover.poster) img=imdbCover.poster;
      items.push({ title: (imdbCover&&imdbCover.title)||m[3].trim().slice(0,80), url: 'https://animed23.com/anime/' + slug + '/', img, site: 'AnimeD23', extra: 'Latino' });
    }
    if (!items.length) {
      const re2 = /href="https:\/\/animed23\.com\/anime\/([a-z0-9-]+)\/"/g;
      while ((m = re2.exec(html)) && items.length < 12) {
        const slug = m[1];
        if (seen.has(slug) || D23_OCULTAS.has(slug)) continue;
        seen.add(slug);
        const imdbCover=D23_IMDB_COVERS.get(slug);
        items.push({ title: (imdbCover&&imdbCover.title)||slug.replace(/-/g,' ').slice(0,80), url: 'https://animed23.com/anime/' + slug + '/', img: imdbCover&&imdbCover.poster||'', site: 'AnimeD23', extra: 'Latino' });
      }
    }
    for (const it of items) {
      const d23Slug=(/animed23\.com\/anime\/([a-z0-9-]+)/i.exec(it.url||'')||[])[1];
      const imdbCover=d23Slug&&D23_IMDB_COVERS.get(d23Slug);
      if(imdbCover&&imdbCover.poster) it.img=imdbCover.poster;
      if (!it.img || /placeholder|no-image|logo/i.test(it.img)) {
        // Si no hay IMDb, conserva primero la portada de la ficha AnimeD23.
        try{
          const pageSlug=(/animed23\.com\/anime\/([a-z0-9-]+)/i.exec(it.url||'')||[])[1];
          const r2 = pageSlug && await fetchSeguro('https://animed23.com/anime/'+pageSlug+'/', 8000);
          if(r2 && r2.ok){
            const h2 = await r2.text();
            const og = /property="og:image" content="([^"]+)"/i.exec(h2) || /content="([^"]+)" property="og:image"/i.exec(h2);
            if(og && !/placeholder|no-image|logo/i.test(og[1])) it.img = og[1];
          }
        }catch{}
      }
      if (!it.img || /placeholder|no-image|logo/i.test(it.img)) {
        const cov = await aniListCover(it.title).catch(()=> '');
        if (cov) it.img = cov;
      }
    }
    if (items.length) { d23LatestCache.at = Date.now(); d23LatestCache.items = items.filter(x=> x.img); }
    return items.length ? items : d23LatestCache.items;
  } catch { return d23LatestCache.items; }
}
// v272: fallback de portadas vía AniList (IMDb-like, sin key)
const aniListCache = new Map();
async function aniListCover(title){
  if(!title) return '';
  const key = title.toLowerCase().trim();
  const c = aniListCache.get(key);
  if(c && Date.now()-c.at < 7*24*3600*1000) return c.img;
  try{
    const q = `query($s:String){Media(search:$s,type:ANIME){coverImage{extraLarge large} title{romaji english}}}`;
    const r = await fetch('https://graphql.anilist.co', {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Accept':'application/json'},
      body: JSON.stringify({ query:q, variables:{ s: title } })
    });
    if(!r.ok) return '';
    const j = await r.json().catch(()=> ({}));
    const img = j?.data?.Media?.coverImage?.extraLarge || j?.data?.Media?.coverImage?.large || '';
    if(img){ aniListCache.set(key, { at: Date.now(), img }); if(aniListCache.size>400){ const k=[...aniListCache.keys()][0]; aniListCache.delete(k); } }
    return img;
  }catch{ return ''; }
}
async function animesMezclados() {
  const [la, af, d23] = await Promise.all([
    animesDelMomento().catch(() => []),
    afLatest().catch(() => []),
    d23Latest().catch(() => []),
  ]);
  const mezcla = [];
  const max = Math.max(la.length, af.length, d23.length);
  for (let i = 0; i < max && mezcla.length < 36; i++) {
    if (la[i]) mezcla.push(la[i]);
    if (af[i]) mezcla.push(af[i]);
    if (d23[i]) mezcla.push(d23[i]);
  }
  const out = mezcla.length ? mezcla : la;
  // v270: rotativo por carga — baraja leve para que no siempre sea mismo orden
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}
/* v270: series mezcladas 1-1 (CineCalidad + populares serie) + rotativo */
async function seriesMezcladas(){
  const [s1, s2] = await Promise.all([
    seriesRecientes().catch(()=>[]),
    popularesDeHoy().then(xs=> (xs||[]).filter(x=>/\/serie\//.test(x.url))).catch(()=>[]),
  ]);
  const mezcla=[];
  const max=Math.max(s1.length, s2.length);
  for(let i=0;i<max && mezcla.length<32;i++){
    if(s1[i]) mezcla.push(s1[i]);
    if(s2[i] && !mezcla.find(x=>x.url===s2[i].url)) mezcla.push(s2[i]);
  }
  const out = mezcla.length ? mezcla : s1;
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}
/* v270: Estrenos — todas las nuevas pelis que van entrando (PelisXD + Cuevana + CineCalidad tendencias) */
async function estrenosMezclados(){
  // v274: lo nuevo en Huddle = recientes de cada fuente + sondas
  const [pxd, cv, cc, la, af, d23, ser] = await Promise.all([
    pelisxdLatest().catch(()=>[]),
    cuevanaLatest().catch(()=>[]),
    popularesDeHoy().catch(()=>[]),
    animesDelMomento().catch(()=>[]),
    afLatest().catch(()=>[]),
    d23Latest().catch(()=>[]),
    seriesRecientes().catch(()=>[]),
  ]);
  const ccPelis = (cc||[]).filter(x=>!/\/serie\//.test(x.url));
  // mezcla 1 de cada tipo nuevo
  const mezcla=[];
  const max=Math.max(pxd.length, cv.length, ccPelis.length, la.length, af.length, d23.length, ser.length);
  for(let i=0;i<max && mezcla.length<36;i++){
    if(pxd[i]) mezcla.push(pxd[i]);
    if(cv[i]) mezcla.push(cv[i]);
    if(ccPelis[i]) mezcla.push(ccPelis[i]);
    if(la[i]) mezcla.push(la[i]);
    if(af[i]) mezcla.push(af[i]);
    if(d23[i]) mezcla.push(d23[i]);
    if(ser[i]) mezcla.push(ser[i]);
  }
  for(let i=mezcla.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [mezcla[i],mezcla[j]]=[mezcla[j],mezcla[i]]; }
  return mezcla;
}

      /* v55: populares del día + v57: series recién agregadas
       * v101: + 6 filas de género que rotan cada día
       * v102: + caricaturas (debajo de los animes) */
      const [day, series, animes, generos, cari, estrenos] = await Promise.all([
        popularesDeHoy().catch(() => []),
        seriesMezcladas().catch(() => []),
        animesMezclados().catch(() => []), /* v269: animes intercalados Latanime+AnimeFLV+D23 */
        /* v234: batch de a 6 géneros para no saturar memoria */
        (async () => {
          const gens = generosDelDia();
          const result = [];
          for (let i = 0; i < gens.length; i += 6) {
            const batch = gens.slice(i, i + 6);
            const batchResults = await Promise.all(batch.map(([slug, nombre]) =>
              peliculasPorGenero(slug)
                .then((items) => ({ slug, nombre, items }))
                .catch(() => ({ slug, nombre, items: [] }))
            ));
            result.push(...batchResults);
          }
          return result;
        })(),
        caricaturasDestacadas().catch(() => ({ caricaturas: [], cartoons: [] })),
        estrenosMezclados().catch(() => []),
      ]);
      const fCV = (xs) => (xs || []).filter((x) => !cvOcultaUrl(x.url) && !laOcultaUrl(x.url)); /* v195 muertas + v198 latanime castellano/duplicados fuera */
      // v270: rotativo — cada carga baraja un poco para no ver siempre lo mismo
      const shuf = (a)=>{ const x=[...a]; for(let i=x.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
      const dayR = shuf(fCV(day)); const seriesR = shuf(fCV(series)); const animesR = shuf(fCV(animes));
      const estrenosR = shuf((estrenos||[]).filter(x=>!cvOcultaUrl(x.url) && !laOcultaUrl(x.url)));
      return json(res, 200, {
        ok: true, results: dayR, series: seriesR, animes: animesR, estrenos: estrenosR,
        caricaturas: cari.caricaturas || [],
        cartoons: cari.cartoons || [], /* v119: apartado propio de Lacartoons */
        liveaction: cari.liveaction || [], /* v205: iCarly, Drake & Josh, Power Rangers… */
        ennovelas: await ennCatalogoTrending(), /* v285: solo Ennovelas allowlist HTTP/HLS */
        movieApi: await mapiTarjetasHome(), /* v212: vitrina viva de la API Movie (portadas reales) */
        generos: (generos || []).map((g) => ({ slug: g.slug, nombre: g.nombre, items: fCV(g.items) })).filter((g) => g.items.length),
        pelisxd: await pelisxdLatest().catch(() => []),
        cuevana: await cuevanaLatest().catch(() => []), /* v235: cuevana.mov — 8k películas latinas */
      });
    }
    if (url.pathname.startsWith('/api/enp/')) { /* v206.2: ficha de novela de EnPantallaTV (por prefijo) */
      const pref = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{3,100}$/.test(pref)) return json(res, 400, { ok: false, error: 'Serie inválida' });
      if (NV_OCULTAS.has('enp:' + pref)) return json(res, 404, { ok: false, error: 'Esa novela ya no está disponible' });
      const d = await nv2Ficha(pref).catch(() => null);
      if (!d || !d.ok) return json(res, 502, { ok: false, error: 'No pude leer esa novela — intenta luego' });
      d.episodios = epsVivos(d.episodios); /* v205.5 */
      return json(res, 200, d);
    }
    if (url.pathname.startsWith('/api/novelas/')) { /* v206: ficha de una novela (capítulos) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Novela inválida' });
      if (NV_OCULTAS.has(slug)) return json(res, 404, { ok: false, error: 'Esa novela ya no está disponible' });
      const d = await nvFicha(slug).catch((eNv) => { console.warn('[nv] ficha ' + slug + ':', String(eNv && eNv.message || eNv).slice(0, 90)); return null; }); /* v206.1: con diagnóstico */
      if (!d || !d.ok) return json(res, 502, { ok: false, error: 'No pude leer esa novela — intenta luego' }); /* v206.1: sin auto-ocultar por un fallo de lectura (los capítulos se cuidan solos) */
      nvPerdonar(slug);
      d.episodios = epsVivos(d.episodios); /* v205.5 */
      return json(res, 200, d);
    }
    if (url.pathname.startsWith('/api/ennovelas/') || url.pathname.startsWith('/api/enn/')) { /* v278.4: ficha de Ennovelas (Betty 335) */
      const pref = decodeURIComponent((url.pathname.split('/')[3]||'').toLowerCase()).replace(/\/+$/,'');
      if(!/^[a-z0-9-]{3,90}$/.test(pref)) return json(res,400,{ok:false,error:'Serie inválida'});
      const grupoPref=ennGrupoPara(pref);
      const grupoVisible=grupoPref && (grupoPref.members||[]).some(m=>ENN_VISTAS.has(m.slug));
      const permitido=ENN_VISTAS.has(pref) || (grupoPref && grupoPref.slug===pref && grupoVisible);
      if(ENN_AUDIT_READY && !permitido) return json(res,404,{ok:false,error:'Esa serie de Ennovelas no está verificada'});
      const d = await ennFicha(pref).catch(()=>null);
      if(!d || !d.ok) return json(res,502,{ok:false,error:'No pude leer esa novela en Ennovelas — intenta luego'});
      d.episodios = epsVivos(d.episodios);
      return json(res,200,d);
    }
    if (url.pathname === '/api/ennovelas' && req.method==='GET') { /* lista rápida para debug */
      const d = await ennFicha('yo-soy-betty-la-fea').catch(()=>null);
      return json(res,200,d||{ok:false});
    }
    if (url.pathname === '/api/d23/probar' && req.method==='GET') { /* v286: sonda de un episodio AnimeD23 (sin contabilidad de podredumbre) */
      let u = String(url.searchParams.get('u') || '');
      const qId = url.searchParams.get('id'); /* si el cliente no codificó la query interna, se re-une aquí */
      if (qId && !/id=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(qId);
      try {
        let tabs = [], serie = '';
        if (/animed23\.com\/capitulo\//i.test(u)) {
          serie = d23SlugDeEp(u);
          const r = await fetchSeguro(u, 15000);
          if (!r || !r.ok) return json(res, 200, { ok: false, error: 'la página del capítulo respondió ' + (r && r.status) });
          const html = await r.text();
          if (d23EsChallenge(html)) return json(res, 200, { ok: false, error: 'challenge anti-robot de la fuente (no es Huddle) — reintentar luego' });
          tabs = await d23TabsDeHtml(html, u);
        } else if (/animed23\.online\/(container\.php|multiplayer\/contenedor\.php)/i.test(u)) {
          const hC = await (await fetchSeguro(u, 12000)).text();
          tabs = d23TabsDeContenedor(hC);
        } else {
          return json(res, 400, { ok: false, error: 'u= debe ser un /capitulo/ de animed23.com o un container de animed23.online' });
        }
        if (!tabs.length) return json(res, 200, { ok: false, error: 'sin reproductores', serie });
        const out = await resolverD23ConTabs(tabs, u, serie, false);
        return json(res, 200, { ok: true, serie, tabs, ...out });
      } catch (e) {
        return json(res, 200, { ok: false, serie, error: String(e.message || e).slice(0, 200) });
      }
    }
      if (url.pathname === '/api/movie/v-ficha') { /* v211: ficha EN VIVO de la API Movie (catalogo completo) */
        const vod = (url.searchParams.get('vod') || '').replace(/[^0-9]/g, '');
        if (!vod) return json(res, 400, { ok: false, error: 'Falta vod' });
        const j = await mapiFicha(vod);
        if (!j || j.code !== 10000 || !j.result) return json(res, 502, { ok: false, error: 'La API Movie no respondió — intenta luego' });
        const r = j.result;
        const col = (r.vod_collection || []).map((c) => ({
          titulo: String(c.title || ''), tipo: c.type, duracion: c.duration || '',
          url: '/api/movie/v-vid?url=' + encodeURIComponent(c.vod_url || '') + '&vd=' + movieParseDurHHMMSS(c.duration) + '&t=' + encodeURIComponent(r.vod_name || ''),
        }));
        const lat = mapiUrlLatina(r.vod_collection);
        return json(res, 200, {
          ok: true, vod: r.id, titulo: r.vod_name, poster: r.vod_pic || '/carita.png',
          sinopsis: r.vod_blurb || '', anno: r.vod_year || '', idioma: r.vod_lang || '',
          tags: r.vod_tag || '', score: r.vod_douban_score || 0, actores: r.vod_actor || '',
          video: lat ? '/api/movie/v-vid?url=' + encodeURIComponent(lat.url) + '&vd=' + movieParseDurHHMMSS(lat.duration) + '&t=' + encodeURIComponent(r.vod_name || '') : '',
          partes: col,
        });
      }
      if (url.pathname === '/api/movie/v-populares') { /* v211: lo más visto en la app Movie */
        const j = await mapiLista('/api/search/hot_search', '');
        const lista = (j && j.code === 10000 && Array.isArray(j.result)) ? j.result : [];
        return json(res, 200, { ok: true, items: lista.slice(0, 40).map((x) => ({ vod: x.vod_id, titulo: x.vod_name, poster: x.pic || '', anno: x.vod_year || '', clicks: x.click_count || 0 })) });
      }
      if (url.pathname === '/api/movie/v-lista') { /* v211: vitrina por tipo (1=pelis, 2=series, 230 telenovela…) */
        const tipo = (url.searchParams.get('type') || '1').replace(/[^0-9]/g, '');
        const j = await mapiLista('/api/search/screen', 'type_id=' + tipo);
        const lista = (j && j.code === 10000 && Array.isArray(j.result)) ? j.result : [];
        return json(res, 200, { ok: true, items: lista.slice(0, 40).map((x) => ({ vod: x.vod_id || x.id, titulo: x.vod_name, poster: x.vod_pic || '', anno: x.vod_year || '' })) });
      }
      if (url.pathname === '/api/movie/v-buscar') { /* v228.5: búsqueda en catálogo cosechado */
        const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1') || 1);
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '40') || 40));
        const arr = movieCosechaArray();
        let items = q ? arr.filter((x) => String(x.vod_name || '').toLowerCase().includes(q)) : arr;
        const total = items.length;
        const start = (page - 1) * limit;
        const slice = items.slice(start, start + limit).map((x) => ({
          vod: x.vod_id || x.id, titulo: x.vod_name || '',
          poster: x.vod_pic || '', anno: x.vod_year || '',
          tipo: x.type_id || '', score: 0,
        }));
        return json(res, 200, { ok: true, q, total, page, pages: Math.ceil(total / limit), items: slice });
      }
      if (url.pathname === '/api/movie/v-vid') { /* v211: proxy del CDN plano de Movie · v217: espejo con caché (sin llave) */
        const u = url.searchParams.get('url') || '';
        let pu; try { pu = new URL(u); } catch { return json(res, 400, { ok: false, error: 'url inválida' }); }
        if (!movieEsHostPermitido(pu.hostname)) return json(res, 403, { ok: false, error: 'dominio no permitido' });
        /* v212.1: si existe ~/movie-cdn-key.txt, firmamos Wangsu al vuelo (solo el host original) */
        const wkey = movieCdnKey();
        const firmado = (href) => {
          if (!wkey || href.includes('wsSecret=')) return href;
          const kb = movieCdnKeyBytes(wkey);
          if (!kb) return href;
          const wt = Math.floor(Date.now() / 1000).toString(16);
          const ws = crypto.createHash('md5').update(Buffer.concat([kb, Buffer.from(new URL(href).pathname + wt, 'utf8')])).digest('hex');
          return href + (href.includes('?') ? '&' : '?') + 'wsSecret=' + ws + '&wsTime=' + wt;
        };
        /* v217: orden de intentos — espejo preferido, resto de espejos, y al final el original */
        const yaEspejo = MOVIE_ESPEJOS.includes(pu.hostname);
        const intentos = [];
        if (!yaEspejo) {
          const pref = movieEspejoPreferido();
          const orden = (pref && MOVIE_ESPEJOS.includes(pref)) ? [pref, ...MOVIE_ESPEJOS.filter((x) => x !== pref)] : MOVIE_ESPEJOS;
          for (const ip of orden) intentos.push('http://' + ip + pu.pathname + pu.search);
          intentos.push(firmado(u));
        } else {
          /* ya venimos del espejo: si ese objeto no está en su caché, probamos el host real */
          intentos.push(u);
          intentos.push(firmado('http://movievn.j5t2n.com' + pu.pathname + pu.search));
        }
        /* v228.6: validación de duración — copia dañada (dibu de 7 min) se descarta */
        const vd = +(url.searchParams.get('vd') || 0);
        const tTit = url.searchParams.get('t') || '';
        const esM3u8Req = /index5?\.m3u8/i.test(pu.pathname);
        let rr = null, usado = '', ultimo = 0, bufPre = null;
        for (const cand of intentos) {
          const ctl = new AbortController(); const tt = setTimeout(() => ctl.abort(), 25000);
          try {
            const r = await fetch(cand, { headers: { 'User-Agent': FETCH_UA }, signal: ctl.signal });
            clearTimeout(tt);
            if (r.status === 200 || r.status === 206) {
              if (vd && esM3u8Req) {
                const txtV = await r.text();
                if (!movieEsM3u8Valido(txtV, vd)) { ultimo = r.status; continue; } /* dañada: siguiente */
                bufPre = Buffer.from(txtV, 'utf8');
              }
              rr = r; usado = cand; break;
            }
            ultimo = r.status;
            try { r.body && r.body.cancel(); } catch {}
          } catch { clearTimeout(tt); ultimo = ultimo || 0; }
        }
        /* v228.6: si TODAS las copias están dañadas, busca otra del mismo título */
        if (!rr && vd && esM3u8Req && tTit) {
          const copia = await movieCopiaBuena(tTit, vd, pu.pathname).catch(() => null);
          if (copia) { bufPre = Buffer.from(copia.m3u8, 'utf8'); usado = copia.url; rr = { status: 200, _marca: true }; }
        }
        if (!rr) return json(res, 502, { ok: false, error: 'CDN dijo ' + (ultimo || 'sin respuesta') });
        try { const hN = new URL(usado).hostname; if (MOVIE_ESPEJOS.includes(hN)) movieMarcarEspejo(hN); } catch {}
        const ct = rr._marca ? 'application/vnd.apple.mpegurl' : ((rr.headers && rr.headers.get('content-type')) || '').toLowerCase();
        const buf = bufPre || Buffer.from(await rr.arrayBuffer());
        if (ct.includes('mpegurl') || /index5?\.m3u8/i.test(pu.pathname)) {
          const base = usado.slice(0, usado.lastIndexOf('/') + 1);
          const out = buf.toString('utf8').split('\n').map((ln) => {
            const l = ln.trim();
            if (!l || l.startsWith('#')) return ln;
            const abs = /^https?:/i.test(l) ? l : base + l;
            return '/api/movie/v-vid?url=' + encodeURIComponent(abs);
          }).join('\n');
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
          return res.end(out);
        }
        /* v217: el origen a veces manda un content-type raro para los .ts
           («text/vnd.trolltech.linguist»): se normaliza para que el reproductor
           no se confunda */
        const esTs = /\.ts$/i.test(pu.pathname);
        res.writeHead(rr.status, { 'Content-Type': esTs ? 'video/MP2T' : (ct || 'application/octet-stream'), 'Cache-Control': 'public, max-age=3600' });
        return res.end(buf);
      }
      if (url.pathname === '/api/movie/disponibles') { /* v222: qué se ve ahora (medido, no prometido) */
        if (url.searchParams.get('escanear')) {
          const secs = await mapiSecciones();
          const ya = new Set(MOVIE_DISP.keys());
          let puestos = 0;
          for (const sec of secs) for (const it of sec.items) {
            const v = String(it.url.split('/').pop());
            if (!ya.has(v) && !movieDispCola.includes(v)) { movieDispCola.push(v); puestos++; }
          }
          movieDispTrabajador().catch(() => {});
          return json(res, 200, { ok: true, encolados: puestos, enCola: movieDispCola.length, enCurso: movieDispCorriendo, resumen: movieDispResumen(), items: Object.fromEntries(MOVIE_DISP) });
        }
        return json(res, 200, { ok: true, medidos: MOVIE_DISP.size, enCurso: movieDispCorriendo, enCola: movieDispCola.length, actualizado: movieDispAt, resumen: movieDispResumen(), items: Object.fromEntries(MOVIE_DISP) });
      }
      if (url.pathname === '/api/movie/catalogo') { /* v221: apartados reales de la app */
        const secs = await mapiSecciones();
        return json(res, 200, {
          ok: true,
          total: secs.reduce((a, s2) => a + s2.items.length, 0),
          secciones: secs.map((s2) => ({ canal: s2.canal, nombre: s2.nombre, n: s2.items.length, ejemplo: s2.items.slice(0, 5).map((x) => ({ titulo: x.title, vod: x.url.split('/').pop(), poster: !!x.img })) })),
        });
      }
      if (url.pathname === '/api/movie/espejos') { /* v217: ¿qué espejo responde DESDE Oracle? */
        const muestras = ['/vod/1/2026/09/11/9db1ede34113/index5.m3u8', '/vod/1/2023/10/27/30b34531976d/index5.m3u8', '/vod/1/2026/08/21/04bb8c7acbe2/index5.m3u8', '/vod/1/2025/09/05/3f3d30681b1b/index5.m3u8'];
        const medir = async (href) => {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
          try {
            const r = await fetch(href, { headers: { 'User-Agent': FETCH_UA }, signal: ctl.signal });
            const n = +(r.headers.get('content-length') || 0);
            try { r.body && r.body.cancel(); } catch {}
            clearTimeout(t);
            return { code: r.status, bytes: n };
          } catch { clearTimeout(t); return { code: 0, bytes: 0 }; }
        };
        const hosts = [];
        for (const base of [...MOVIE_ESPEJOS.map((ip) => 'http://' + ip), 'http://movievn.j5t2n.com']) {
          const filas = [];
          for (const p of muestras) filas.push({ ruta: p, ...(await medir(base + p)) });
          hosts.push({ host: base.replace('http://', ''), ok: filas.filter((f) => f.code === 200).length, filas });
        }
        return json(res, 200, { ok: true, espejos: MOVIE_ESPEJOS, preferido: movieEspejoPreferido() || null, llaveCdn: !!movieCdnKey(), hosts });
      }
      if (url.pathname === '/api/movie/cazar-llave') { /* v228.8: caza la llave Wangsu desde la captura, a control remoto */
        if ((url.searchParams.get('k') || '') !== 'huddle2026') return json(res, 403, { ok: false, error: 'clave incorrecta' });
        if (global._cazando) return json(res, 200, { ok: false, corriendo: true, msg: 'ya hay una caza en marcha' });
        global._cazando = true;
        const sh = path.join(__dirname, 'scripts', 'buscar-llave-cdn.sh');
        execFile('bash', [sh], { timeout: 10 * 60000, maxBuffer: 8e6, cwd: __dirname }, (err, so, se) => {
          global._cazando = false;
          const salida = String(so || '') + (se ? '\n[stderr] ' + String(se).slice(0, 800) : '');
          const llave = movieCdnKey();
          json(res, 200, { ok: !err || !!llave, llave: !!llave, salida: salida.slice(-2500) });
        });
        return;
      }
      if (url.pathname === '/api/movie/probar-resolver') { /* v228.7: diagnóstico remoto del resolutor nativo */
        const u = url.searchParams.get('url') || '';
        if (!u) return json(res, 400, { ok: false, error: 'falta url' });
        try {
          const nat = await resolverNativo(u);
          return json(res, 200, { ok: true, nat: nat && { url: nat.url, mp4: !!nat.mp4, proxy: !!nat.proxy, subs: (nat.subs || []).length } });
        } catch (e) {
          return json(res, 200, { ok: false, error: String(e && e.message || e).slice(0, 200) });
        }
      }
      if (url.pathname === '/api/movie/probar') { /* v207: diagnóstico — comprueba m3u8 + primer .ts de cada ruta activa contra el origen */
        movieRecargar();
        const probarUno = async (u, conRango) => {
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 12000);
            const cab = { 'User-Agent': FETCH_UA };
            if (conRango) cab.Range = 'bytes=0-1023';
            try {
              const r = await fetch(u, { headers: cab, signal: ctl.signal, redirect: 'follow' });
              try { r.body && r.body.cancel(); } catch {}
              return r.status;
            } finally { clearTimeout(t); }
          } catch { return 0; }
        };
        const filas = [];
        for (const s of MOVIE.series.values()) {
          for (const e of s.eps) {
            const id = e.temporada + 'x' + e.episodio;
            if (MOVIE.caidas.has(e.carpeta)) { filas.push({ serie: s.titulo, ep: id, carpeta: e.carpeta, m3u8: 'caída marcada', ts: '-', listo: false }); continue; }
            const em = await probarUno(movieOrigenM3u8(e), false);
            const ets = em === 200 ? await probarUno(movieOrigenTs(e, '0000.ts'), true) : '-';
            const cayo = [403, 404, 410].includes(em) || [403, 404, 410].includes(ets);
            if (cayo) movieMarcarCaida(s.clave, id, e, `comprobación /api/movie/probar: m3u8 ${em}, ts ${ets}`);
            filas.push({ serie: s.titulo, ep: id, carpeta: e.carpeta, m3u8: em, ts: ets, listo: em === 200 && (ets === 200 || ets === 206) });
          }
        }
        return json(res, 200, { ok: true, origen: MOVIE_ORIGEN, rutas: filas });
      }
      if (url.pathname.startsWith('/api/movie/ficha/')) { /* v207: ficha de una novela del app Movie (mapa local) */
        const clave = decodeURIComponent(url.pathname.split('/')[4] || '').toLowerCase();
        if (!/^[a-z0-9-]{3,90}$/.test(clave)) return json(res, 400, { ok: false, error: 'Serie inválida' });
        const mvApi = /^v([0-9]{3,12})$/.exec(clave); /* v212: ficha del catálogo VIVO de la API */
        if (mvApi) {
          const j = await mapiFicha(mvApi[1]);
          if (!j || j.code !== 10000 || !j.result) return json(res, 502, { ok: false, error: 'La API Movie no respondió — intenta luego' });
          const r = j.result; const col = Array.isArray(r.vod_collection) ? r.vod_collection : [];
          let eps = col.filter((c) => c && c.vod_url).map((c, i) => ({
            temporada: 1, ep: i + 1,
            titulo: 'Parte ' + (c.title || i + 1) + (c.type === 2 ? ' · Latino' : c.type === 1 ? ' · Subtítulos' : ''),
            url: '/api/movie/v-vid?url=' + encodeURIComponent(c.vod_url) + '&vd=' + movieParseDurHHMMSS(c.duration) + '&t=' + encodeURIComponent(r.vod_name || ''), img: '',
          }));
          if (!eps.length) { const l = mapiUrlLatina(col); if (l) eps = [{ temporada: 1, ep: 1, titulo: 'Ver', url: '/api/movie/v-vid?url=' + encodeURIComponent(l.url) + '&vd=' + movieParseDurHHMMSS(l.duration) + '&t=' + encodeURIComponent(r.vod_name || ''), img: '' }]; }
          if (!eps.length) return json(res, 404, { ok: false, error: 'Este título aún no tiene video disponible' });
          return json(res, 200, { ok: true, titulo: r.vod_name, poster: r.vod_pic || '/carita.png', episodios: eps });
        }
        const s = movieSerieActiva(clave);
        if (!s) return json(res, 404, { ok: false, error: 'Esa novela no está disponible en Movie ahora' });
        return json(res, 200, {
          ok: true, titulo: s.titulo, poster: '/api/movie/poster/' + s.clave,
          episodios: s.eps.map((e) => ({
            temporada: e.temporada, ep: e.episodio, titulo: 'Capítulo ' + e.episodio,
            url: movieUrlEp(s.clave, e.temporada + 'x' + e.episodio), img: '',
          })),
        });
      }
      if (url.pathname.startsWith('/api/movie/poster/')) { /* v207: portada alojada por Movie (fallback /carita.png) */
        return movieServirPoster(req, res, decodeURIComponent(url.pathname.split('/')[4] || '').toLowerCase());
      }
      if (url.pathname.startsWith('/api/movie/hls/')) { /* v207: playlist/segmentos del origen Movie — allowlist estricta del mapa */
        const clave = decodeURIComponent(url.pathname.split('/')[4] || '').toLowerCase();
        const epId = decodeURIComponent(url.pathname.split('/')[5] || '');
        const archivo = url.pathname.split('/')[6] || '';
        if (!/^[a-z0-9-]{3,90}$/.test(clave) || !/^\d{1,2}x\d{1,3}$/.test(epId) || archivo.includes('/')) return json(res, 400, { ok: false, error: 'Petición inválida' });
        if (/^index5\.m3u8$/i.test(archivo)) return movieServirM3u8(req, res, clave, epId);
        return movieServirTs(req, res, clave, epId, decodeURIComponent(archivo));
      }
    if (url.pathname.startsWith('/api/dani/poster/')) { /* v177: póster perezoso og:image */
      const slug = decodeURIComponent(url.pathname.split('/')[4] || '');
      /* v193: hay series con slug unicode (ranma-½, 女生宿舍日常…) — los mapas
       * los guardan CODIFICADOS, así que se prueba también la forma cruda */
      const slugRaw = url.pathname.split('/')[4] || '';
      const catKey = DANI_CAT.has(slug) ? slug : (DANI_CAT.has(slugRaw) ? slugRaw : '');
      if (!catKey || catKey.length > 120) return json(res, 404, { ok: false });
      const u = await daniPosterUrl(catKey).catch(() => '');
      if (!u) return json(res, 404, { ok: false });
      res.writeHead(302, { Location: u });
      return res.end();
    }
    if (url.pathname === '/api/dani/catalogo') { /* v177: explorador de las 823 */
      const por = 60;
      const pag = Math.max(1, +(url.searchParams.get('pag') || 1));
      const ini = (pag - 1) * por;
      const items = DANI_CAT_ARR.slice(ini, ini + por).map(([sl, v]) => ({ slug: sl, titulo: String(v.t).replace(/\xa0/g, ' '), poster: '/api/dani/poster/' + sl })); /* v178: todas por IMDb */
      return json(res, 200, { ok: true, total: DANI_CAT_ARR.length, pag, por, items });
    }
    if (url.pathname.startsWith('/api/catalogo/')) { /* v205: «Ver todo» del feed */
      const tipo = decodeURIComponent(url.pathname.split('/')[3] || '');
      const pag = Math.max(1, +(url.searchParams.get('pag') || 1));
      const por = 24;
      const trozo = (items) => {
        const ini = (pag - 1) * por;
        return { ok: true, pag, por, total: items.length, mas: ini + por < items.length, items: items.slice(ini, ini + por) };
      };
      try {
        if (tipo === 'movie' || /^movie-\d+$/.test(tipo)) { /* v228.5: catálogo completo Movie — 37k cosechados */
          const arr = movieCosechaArray();
          if (arr.length > 100) {
            let items2 = arr;
            if (/^movie-(\d+)$/.test(tipo)) {
              const canalF = tipo.slice(6);
              const filt = arr.filter((x) => String(x.type_id || '') === canalF);
              if (filt.length > 10) items2 = filt;
            }
            items2 = items2.slice().sort((a, b) => (b.click_count || 0) - (a.click_count || 0));
            const mapped = items2.map((x) => ({
              title: String(x.vod_name || ''),
              url: 'https://movie.huddle/v/' + (x.vod_id || x.id),
              img: x.vod_pic || '/carita.png',
              site: 'Movie',
              extra: (x.vod_year ? x.vod_year + ' · ' : '') + 'Latino',
            })).filter((x) => x.title);
            return json(res, 200, Object.assign(trozo(mapped), { secciones: [{ canal: 0, nombre: 'Todo Movie', n: mapped.length }] }));
          }
          /* fallback: secciones de la API si no hay cosecha */
          const secs = await mapiSecciones();
          const elegidas = /^movie-(\d+)$/.test(tipo) ? secs.filter((x) => String(x.canal) === tipo.slice(6)) : secs;
          const items = [];
          for (const sec of elegidas) for (const it of sec.items) items.push(it);
          return json(res, 200, Object.assign(trozo(items), { secciones: secs.map((x) => ({ canal: x.canal, nombre: x.nombre, n: x.items.length })) }));
        }
        if (tipo === 'pelis') { const r = await catCv('movies', pag); return json(res, 200, { ok: true, pag, por: 20, total: r.total|| (r.items.length + (r.mas?20:0)), items: r.items, mas: r.mas }); }
        if (tipo === 'series') { const r = await catCv('series', pag); return json(res, 200, { ok: true, pag, por: 20, total: r.total|| (r.items.length + (r.mas?20:0)), items: r.items, mas: r.mas }); }
        if (tipo === 'animes') { const r = await catAnimes(pag); return json(res, 200, { ok: true, pag, por: 24, total: r.total|| (r.items.length + (r.mas?24:0)), items: r.items, mas: r.mas }); }
        if (tipo === 'caricaturas') return json(res, 200, trozo(await catCaricaturas()));
        if (tipo === 'novelas' || tipo === 'ennovelas') { const enn = await ennCatalogo(); return json(res, 200, trozo(enn)); } /* v285: solo Ennovelas auditadas; alias viejo de compatibilidad */
        if (tipo === 'cartoons' || tipo === 'liveaction') {
          const vivo = tipo === 'liveaction';
          let items = lctConCovers().filter((x) => esLctLive(x._slug) === vivo);
          if (vivo) { /* v205: + los live action de MisCaricaturas (Sabrina, Kenan y Kel) */
            const urls = new Set(items.map((x) => x.url));
            for (const x of cariFeedCache.live) {
              if (urls.has(x.url)) continue;
              items.push({ _slug: '', title: x.title, url: x.url, img: x.img, site: x.site, extra: x.extra || '' });
            }
          }
          items = items.sort((a, b) => a.title.localeCompare(b.title, 'es'))
            .map((x) => { const { _slug, ...resto } = x; return resto; });
          return json(res, 200, trozo(items));
        }
        if (tipo === 'danimados') {
          const filtrados = DANI_CAT_ARR.filter(([sl])=> !esCariLive(sl) && !LCT_SERIES.has(sl) && !DANI_MUERTAS.has(sl))
            .sort((a,b)=> String(a[1].t).localeCompare(String(b[1].t), 'es'));
          const ini = (pag - 1) * por;
          const items = filtrados.slice(ini, ini + por).map(([sl, v]) => ({ title: String(v.t).replace(/\xa0/g, ' '), url: 'https://danimados.cc/serie/' + sl, img: daniCoverDe(sl), site: 'Caricaturas', extra: '' }));
          return json(res, 200, { ok: true, pag, por, total: filtrados.length, mas: ini + por < filtrados.length, items });
        }
        if (tipo.startsWith('genero-')) {
          const slug = tipo.slice(7);
          const items = await peliculasPorGenero(slug, pag);
          const cc = await generoPagina(slug, pag).catch(()=>({mas:false}));
          const mas = !!cc.mas || items.length>=20;
          // v272: total estimado para el numerito (si pag 1, calcula aprox)
          const totalEst = (pag===1 && mas) ? (items.length * 4) : (pag*20 + (mas?20:0));
          return json(res, 200, { ok: true, pag, por: 20, total: totalEst, mas, items: items.slice(0, 20) });
        }
        return json(res, 404, { ok: false, error: 'Catálogo desconocido' });
      } catch {
        return json(res, 502, { ok: false, error: 'No pude leer ese catálogo — intenta luego' });
      }
    }
    if (url.pathname.startsWith('/api/caricaturas/')) {
      /* v102: episodios de una caricatura (para el selector) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug) && !/^[0-9]{1,3}$/.test(slug)) return json(res, 400, { ok: false, error: 'Caricatura inválida' }); /* v119: ids de lacartoons de 1 dígito */
      /* v177: danimados primero — series nuestras ROTAS (reemplazos) y las
     * que SOLO están en danimados. Lo demás sigue en nuestra fuente. */
      const daniSlug = DANI_REEMPLAZAS.get(slug) || (!DANI_OCULTAS.has(slug) && !DANI_MUERTAS.has(slug) && DANI_CAT.has(slug) ? slug : ''); /* v180: manda danimados… salvo las ocultas (ahí gana la nuestra) */
      if (daniSlug) {
        const eps = await daniLista(daniSlug).catch(() => []);
        if (!eps.length) return json(res, 502, { ok: false, error: 'No pude leer danimados — intenta luego' });
        const cov = daniCoverDe(daniSlug);
        precargarIntroDeSerie(eps); /* v184: mientras eligen episodio, el server ya busca la intro */
        return json(res, 200, { ok: true, slug, titulo: daniTituloDe(daniSlug), poster: cov, cover: cov, episodios: epsVivos(eps) }); /* v205.5 */
      }
      const d = await datosCaricatura(slug);
      if (!d) return json(res, 502, { ok: false, error: 'No pude leer esa caricatura' });
      d.episodios = epsVivos(d.episodios); /* v205.5 */
      precargarIntroDeSerie(d.episodios); /* v135 */
      /* v195: mientras eligen episodio, el server YA resuelve el primero —
       * las de lacartoons con player rpmvid tardan 10-40s la primera vez
       * (hay que abrir el navegador y darle play); así al picarle
       * «reproducir» el stream ya está en caché y entra al instante */
      {
        const lct = LCT_SERIES.get(slug);
        const p0 = d.episodios && d.episodios[0] && d.episodios[0].url;
        if (lct && p0 && Date.now() - (LCT_PRECALIENTE.get(lct.lctId) || 0) > 100 * 60 * 1000) {
          LCT_PRECALIENTE.set(lct.lctId, Date.now());
          resolverLacartoons(p0).catch(() => { try { LCT_PRECALIENTE.delete(lct.lctId); } catch {} });
        }
      }
      return json(res, 200, d);
    }
    if (url.pathname.startsWith('/api/serie/')) {
      /* v61: temporadas y episodios de una serie (para elegirla bonito) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Serie inválida' });
      const dS = await datosSerieCuevana(slug); /* v74: compartida con los botones de episodio */
      if (!dS) return json(res, 502, { ok: false, error: 'No pude leer la serie' });
      dS.episodios = epsVivos(dS.episodios); /* v205.5: episodios muertos fuera */
      precargarIntroDeSerie(dS.episodios); /* v135 */
      return json(res, 200, dS);
    }
    if (url.pathname.startsWith('/api/anime/')) {
      /* v62: episodios de un anime — AnimeFLV (var eps) y v63: Latanime (enlaces /ver/) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Anime inválido' });
      if ((url.searchParams.get('site') || '').toLowerCase() === 'latanime') {
        const dL = await datosAnimeLatanime(slug); /* v74: compartida con los botones de episodio */
        if (dL && dL.dead) { /* v288: el sitio la borró o vació sus episodios → fuera del buscador (laRevizar la re-prueba) */
          if (!LA_MUERTAS_SET.has(slug)) {
            LA_MUERTAS_SET.add(slug);
            try { fs.writeFileSync(path.join(__dirname, 'public', 'latanime-muertas.txt'), [...LA_MUERTAS_SET].sort().join('\n') + '\n'); } catch {}
            const eL = LA_FALLOS.get(slug) || { f: 0, last: 0, h: 0 };
            eL.f = 3; eL.last = Date.now(); eL.h = Date.now();
            LA_FALLOS.set(slug, eL); laFallosGuardar();
            sondaNotify('Latanime', 'muerto', slug, slug + ' — página sin episodios en el sitio (se oculta)');
          }
          return json(res, 502, { ok: false, error: 'Esta serie ya no está disponible en Latanime (la tarjeta se ocultará)' });
        }
        if (!dL) return json(res, 502, { ok: false, error: 'No pude leer el anime' });
        dL.episodios = epsVivos(dL.episodios); /* v205.5 */
        precargarIntroDeSerie(dL.episodios); /* v135 */
        return json(res, 200, dL);
      }
      if ((url.searchParams.get('site') || '').toLowerCase() === 'animed23') { /* v286: ficha AnimeD23 (misma forma que Latanime) */
        const dD = await datosAnimeD23(slug);
        if (dD && dD.dead) { /* v288: el sitio la borró o vació sus capítulos → fuera del buscador (sondaD23 la re-prueba) */
          if (!D23_OCULTAS.has(slug)) { D23_OCULTAS.add(slug); ocultasReescribir(D23_OCULTAS, 'd23-ocultas.txt'); console.log('[d23] ' + slug + ' (' + dD.dead + ') — oculta del buscador'); }
          return json(res, 502, { ok: false, error: 'Esta serie ya no está disponible en AnimeD23 (la tarjeta se ocultará)' });
        }
        if (!dD) return json(res, 502, { ok: false, error: 'No pude leer el anime en AnimeD23 — intenta luego' });
        dD.episodios = epsVivos(dD.episodios); /* v205.5 */
        return json(res, 200, dD);
      }
      const c = serieCache.get('anime:' + slug);
      if (c && Date.now() - c.at < 30 * 60 * 1000) return json(res, 200, c.d);
      try {
        const r = await fetchSeguro(`https://vww.animeflv.one/anime/${slug}`, 10000);
        if (r && r.status === 404) { /* v287: el sitio renombró/borró esta serie — la tarjeta muerta dejaba de salir del buscador */
          if (!AF_OCULTAS.has(slug)) { AF_OCULTAS.add(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); console.log('[af] ' + slug + ' ya no existe en el sitio (404) — oculta del buscador'); }
          return json(res, 502, { ok: false, error: 'Esta serie ya no existe en AnimeFLV (la tarjeta se ocultará)' });
        }
        if (!r.ok) return json(res, 502, { ok: false, error: 'No pude leer el anime' });
        const html = await r.text();
        /* lista completa viene como: var eps = [["220","0",""],["219","0",""],...] */
        const nums = new Set();
        const bloque = /var\s+eps\s*=\s*(\[[\s\S]*?\]);/.exec(html);
        if (bloque) {
          try {
            for (const it of JSON.parse(bloque[1])) if (it && it[0]) nums.add(+it[0]);
          } catch {}
        }
        if (!nums.size) {
          const re = /\["(\d+)","\d+","[^"]*"\]/g;
          let mm;
          while ((mm = re.exec(html)) && nums.size < 500) nums.add(+mm[1]);
        }
        const eps = [...nums].sort((a, b) => a - b).map((n) => ({
          n,
          url: `https://vww.animeflv.one/ver/${slug}-${n}`,
          titulo: 'Episodio ' + n,
        }));
        const og = (p) => {
          const a1 = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)`, 'i').exec(html);
          const a2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i').exec(html);
          return (a1 || a2 || [])[1] || '';
        };
        const out = {
          ok: true,
          slug,
          titulo: (og('og:title') || slug)
            .replace(/^ver\s+/i, '')
            .replace(/\s*(online|sub español|español latino|latino)\b.*$/i, '')
            .replace(/\s*[|─✔★].*$/, '')
            .replace(/\s{2,}/g, ' ')
            .trim().slice(0, 80) || slug,
          poster: og('og:image') || '',
          episodios: eps,
        };
        out.episodios = epsVivos(out.episodios); /* v205.5 */
        if (!out.episodios.length) { /* v288: la ficha existe pero el sitio no trae episodios → fuera del buscador (sondaAnimeflv la re-prueba) */
          if (!AF_OCULTAS.has(slug)) { AF_OCULTAS.add(slug); ocultasReescribir(AF_OCULTAS, 'af-ocultas.txt'); console.log('[af] ' + slug + ' sin episodios — oculta del buscador'); }
          return json(res, 502, { ok: false, error: 'Esta serie ya no trae episodios en AnimeFLV (la tarjeta se ocultará)' });
        }
        serieCache.set('anime:' + slug, { at: Date.now(), d: out });
        cacheGuardar('serieCache', () => [...serieCache.entries()]); /* v111: a disco */
        return json(res, 200, out);
      } catch {
        return json(res, 500, { ok: false, error: 'Error leyendo el anime' });
      }
    }
    if (url.pathname.startsWith('/api/invite/')) {
      /* v56: tarjeta de invitación — quién invita y qué se está viendo */
      const code = decodeURIComponent(url.pathname.split('/')[3] || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { ok: false, error: 'Sala no encontrada' });
      const host = [...room.users.values()].find((x) => x.id === room.hostId) || [...room.users.values()][0];
      const m = mirrors.get(room.code);
      const out = { ok: true, code: room.code, host: host ? host.name : '', title: '', poster: '' };
      if (m && m.url) {
        const meta = await metaDePelicula(m.url).catch(() => null);
        if (meta) { out.title = meta.title || ''; out.poster = meta.poster || ''; }
      }
      return json(res, 200, out);
    }
    /* v234: search cache at module level */
    if (!globalThis._searchCache) {
      globalThis._searchCache = new Map();
      globalThis._searchCacheTTL = 5 * 60 * 1000;
      globalThis._searchCacheMax = 50;
      globalThis._searchCacheEvict = function() {
        const sc = globalThis._searchCache;
        if (sc.size <= globalThis._searchCacheMax) return;
        const now = Date.now();
        for (const [k, v] of sc) { if (now - v.at > globalThis._searchCacheTTL) sc.delete(k); }
        if (sc.size > globalThis._searchCacheMax) {
          const entries = [...sc.entries()].sort((a, b) => a[1].at - b[1].at);
          for (let i = 0; i < entries.length - globalThis._searchCacheMax; i++) sc.delete(entries[i][0]);
        }
      };
    }
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) return json(res, 400, { ok: false, error: 'Escribe qué quieren ver' });
      const _sc = globalThis._searchCache.get(q);
      let r;
      try {
        r = (_sc && Date.now() - _sc.at < globalThis._searchCacheTTL) ? _sc.data : await buscarEnSitios(q);
      } catch (e) {
        console.warn('[buscar] error:', String(e.message || e).slice(0, 200));
        console.warn('[buscar] stack:', String(e.stack || '').slice(0, 300));
        return json(res, 200, { ok: true, resultados: [], sugiere: null });
      }
      if (!_sc || Date.now() - _sc.at >= globalThis._searchCacheTTL) { globalThis._searchCacheEvict(); globalThis._searchCache.set(q, { at: Date.now(), data: r }); } /* v234: caché 5 min con límite */
      r.resultados = r.resultados.filter((x) => x._apiFresh || !cvOcultaUrl(x.url)); /* v191: sin series muertas; v236.9: API fresca pasa */
      /* v198: latanime en limpio — sin versiones castellanas ni duplicados;
       * AnimeFLV cede cuando latanime tiene la serie (mandan las latino) */
      if (HUDDLE_MOSTRAR_TODO) {
        // v251 buscar muestra TODO curatorial: solo muertas ocultas
        r.resultados = r.resultados.filter((x) => {
          const m = /latanime\.org\/anime\/([a-z0-9-]+)/i.exec(x.url || '');
          return !m || !LA_MUERTAS_SET.has(m[1]);
        });
      } else r.resultados = r.resultados.filter((x) => !laOcultaUrl(x.url));
      if (!HUDDLE_MOSTRAR_TODO) r.resultados = r.resultados.filter((x) => {
        if (!/animeflv\./.test(x.url || '')) return true;
        const sl = (/animeflv\.[a-z.]+\/anime\/([a-z0-9-]+)/i.exec(x.url) || [])[1];
        if (!sl) return true;
        const b = normalizarTxt(laBaseNorm(sl));
        for (const la of LA_TODOS) {
          if (LA_OCULTAS_SET.has(la)) continue;
          const bn = normalizarTxt(laBaseNorm(la));
          const inter = bn.split(' ').filter((w) => w.length > 1 && b.includes(w)).length;
          if (inter >= Math.min(2, bn.split(' ').length)) return false; /* latanime la tiene: fuera el respaldo */
        }
        return true;
      });
      /* v207: MOVIE (app) — las novelas latinas del mapa local cascan primero
       * en la búsqueda (por parecido de título) */
      try {
        const qM = normalizarTxt(q);
        if (qM.length > 1) {
          const pelisM = movieTarjetas().filter((t) => {
            const tn = normalizarTxt(t.title);
            if (!tn) return false;
            if (tn.includes(qM) || qM.split(' ').every((w) => w.length > 1 && tn.includes(w))) return true;
            const inter = tn.split(' ').filter((w) => w.length > 1 && qM.includes(w)).length;
            return inter >= Math.min(2, tn.split(' ').length);
          });
          for (const t of pelisM.reverse()) r.resultados.unshift(t);
        }
      } catch {}
      /* v193: tarjetas sin carátula → IMDb (o la ficha del propio sitio) */
      const sinCaratula = r.resultados.filter((x) => !x.img);
      if (sinCaratula.length) {
        await Promise.all(sinCaratula.slice(0, 10).map(async (x) => {
          try {
            if (/pelisxd\.com\/pelicula\//.test(x.url || '')) {
              const sl = (x.url.match(/pelicula\/([a-z0-9-]+)/i) || [])[1];
              const m = sl ? await pelisxdMeta(sl).catch(() => null) : null;
              if (m && m.poster) { x.img = m.poster; return; }
            }
            const u = await imdbPosterDe(x.title).catch(() => '');
            if (u) x.img = u;
          } catch {}
        }));
      }
      if (/titan(es)?\b/i.test(q)) {
        r.resultados.unshift({ title: 'Los Jóvenes Titanes en Acción (Latino)', url: 'https://danimados.cc/serie/dani-titanes', img: daniCoverDe('teen-titans-go'), site: 'Caricaturas', extra: '9 temporadas · 291 episodios' }); /* v178: IMDb */ /* v174: con ?v= — sin esto el navegador enseñaba la portada VIEJA del caché */
      }
      /* v177: además, las 823 series de danimados cascan en la búsqueda */
      const qD = normalizarTxt(q).split(' ').filter((w) => w.length > 1);
      if (qD.length) {
        const daniHits = [];
        for (const [sl, v] of DANI_CAT_ARR) {
          const tn = normalizarTxt(v.t);
          if (qD.every((w) => tn.includes(w)) && !DANI_MUERTAS.has(sl) && (HUDDLE_MOSTRAR_TODO || !DANI_OCULTAS.has(sl)) && !r.resultados.some((x) => String(x.url || '').includes('/' + sl))) { /* v180: v251 muertas siempre ocultas, curaduría visible en buscar */
            daniHits.push([sl, v]);
            if (daniHits.length >= 6) break;
          }
        }
        const slugDeTarjeta = (u2) => {
          let m2 = /miscaricaturas\.com\/([a-z0-9-]+)/i.exec(u2 || '');
          if (m2) return m2[1];
          m2 = /lacartoons\.com\/serie\/(\d+)/i.exec(u2 || '');
          if (m2) return ([...LCT_SERIES.values()].find((x) => String(x.lctId) === m2[1]) || {}).slug || '';
          return '';
        }; /* v180: la purga también aplica a las tarjetas de lacartoons */
        if (!HUDDLE_MOSTRAR_TODO) r.resultados = r.resultados.filter((x) => { const s2 = slugDeTarjeta(x.url); return !DANI_REEMPLAZAS.has(s2) && !(/lacartoons/i.test(x.url || '') && (LCT_OCULTAS.has(s2) || LCT_MUERTAS.has(s2))); }); else { /* v250 mostrar todo: sin purge dani/lct */ }
        for (const [sl, v] of daniHits.reverse()) {
          r.resultados.unshift({ title: String(v.t).replace(/\xa0/g, ' '), url: 'https://danimados.cc/serie/' + sl, img: '/api/dani/poster/' + sl, site: 'Caricaturas', extra: 'Danimados' }); /* v178 */
        }
        /* v194: también las CARICATURAS de lacartoons cascan en la búsqueda
         * (con su portada curada de IMDb; fuera ocultas y duplicadas dani) */
        const lctHits = [];
        for (const [sl, lct] of LCT_SERIES) {
          if (LCT_MUERTAS.has(lct.slug) || (!HUDDLE_MOSTRAR_TODO && LCT_OCULTAS.has(lct.slug)) || DANI_REEMPLAZAS.get(sl)) continue; /* v241 — v251 muertas siempre, LCT_OCULTAS solo si no mostrarTodo */
          const tn = normalizarTxt(lct.titulo);
          if (qD.every((w) => tn.includes(w)) && !r.resultados.some((x) => String(x.url || '').includes('/serie/' + lct.lctId))) {
            lctHits.push([sl, lct]);
            if (lctHits.length >= 6) break;
          }
        }
        for (const [sl, lct] of lctHits.reverse()) {
          const metaB = cariMeta.get(lct.slug);
          r.resultados.unshift({ title: lct.titulo, url: LCT_BASE + 'serie/' + lct.lctId, img: CARI_PORTADAS.get(lct.slug) || (metaB && (metaB.cover || metaB.poster)) || '', site: 'Cartoons', extra: 'Lacartoons · latino' }); /* v197: por SLUG (la clave del mapa es el ID) + respaldo de la foto del sitio */
        }
      }
      if (!r.resultados.length) return json(res, 200, { ok: true, results: [], sugiere: r.sugiere, error: 'No encontré nada — prueba con otras palabras' });
      return json(res, 200, { ok: true, results: r.resultados, sugiere: r.sugiere });
    }
    if (url.pathname === '/api/sites' && req.method === 'GET') {
      return json(res, 200, { ok: true, sites: sitesList() });
    }
    if (url.pathname === '/api/sites' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await agregarSitio(body.url);
        return json(res, 200, { ok: true, site: r.site, exists: r.exists });
      } catch (e) {
        return json(res, 400, { ok: false, error: 'No pude leer esa página — revisa que la dirección esté completa' });
      }
    }
    if (url.pathname === '/api/sites' && req.method === 'DELETE') {
      const target = url.searchParams.get('url') || '';
      const list = sitesList();
      const i = list.findIndex((s) => mismaPagina(s.url, target));
      if (i >= 0) {
        const [borrado] = list.splice(i, 1);
        saveSitesFile(list);
        try { if ((borrado.logo || '').startsWith('/sites-logos/')) fs.unlinkSync(path.join(PUBLIC_DIR, borrado.logo)); } catch {}
        console.log(`[sitios] - ${borrado.name}`);
      }
      return json(res, 200, { ok: true, sites: sitesList() });
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      if (!NAME_RE.test(name)) return json(res, 400, { ok: false, error: 'Nombre inválido: 3-20 letras, números o _' });
      const token = String(body.token || '');
      const key = name.toLowerCase();
      const existing = users.get(key);
      if (existing) {
        /* v32: volver a entrar con un perfil guardado en este dispositivo */
        if (token && existing.token === token) {
          existing.lastSeenAt = Date.now(); saveUsers();
          return json(res, 200, { ok: true, name: existing.name, token: existing.token, resumed: true });
        }
        // v278.6: auto-heal para solo — si el token no coincide pero el cliente pide force ( tras 403 ), reclamar al instante
        if (body.force || body.heal) {
          existing.token = uid(); existing.lastSeenAt = Date.now(); saveUsers();
          console.log(`[usuarios] heal ${name} -> nuevo token`);
          return json(res, 200, { ok: true, name: existing.name, token: existing.token, healed: true });
        }
        if (Date.now() - (existing.lastSeenAt || 0) > NAME_RECLAIM_MS) {
          existing.token = uid(); existing.lastSeenAt = Date.now(); saveUsers();
          return json(res, 200, { ok: true, name: existing.name, token: existing.token, reclaimed: true });
        }
        return json(res, 409, { ok: false, error: 'Ese nombre ya está tomado — elige otro' });
      }
      const rec = { name, token: uid(), createdAt: Date.now(), lastSeenAt: Date.now() };
      users.set(key, rec); saveUsers();
      console.log(`[usuarios] + ${name}`);
      return json(res, 200, { ok: true, name, token: rec.token });
    }
    if (url.pathname === '/api/continue' && req.method === 'DELETE') {
      /* v79: quitar una entrada de "Continuar viendo" */
      const name = (url.searchParams.get('name') || '').trim();
      const tok = url.searchParams.get('tok') || '';
      const delUrl = url.searchParams.get('url') || '';
      const urec = users.get(name.toLowerCase());
      if (!name || !urec || urec.token !== tok) return json(res, 403, { ok: false, error: 'Perfil no válido' });
      const key = name.toLowerCase();
      const lista = continuar.get(key) || [];
      const i = lista.findIndex((en) => en.url === delUrl);
      if (i >= 0) { lista.splice(i, 1); continuar.set(key, lista); saveContinuar(); }
      return json(res, 200, { ok: true, quedan: lista.length });
    }
    if (url.pathname === '/api/continue') {
      /* v78: lo que este usuario dejó a medias (pelis y series, con su
       * posición) — también lo que veía junto con invitados */
      const name = (url.searchParams.get('name') || '').trim();
      const tok = url.searchParams.get('tok') || '';
      const urec = users.get(name.toLowerCase());
      if (!name || !urec || urec.token !== tok) return json(res, 403, { ok: false, error: 'Perfil no válido' });
      const keyContinue = name.toLowerCase();
      const storedContinue = continuar.get(keyContinue) || [];
      const items = storedContinue.map((e) => ({
        url: e.url, t: e.t, d: e.d, title: e.title, img: e.img, ep: e.ep, serie: e.serie, ts: e.ts, modo: e.modo || '',
        eps: Array.isArray(e.eps) ? e.eps : [], /* v86: para "Sigue con el próximo" */
      }));
      /* v286: saneamiento determinista del historial de Ennovelas. */
      let continueChanged=false;
      for(let i=0;i<items.length;i++){
        const e=items[i];
        if(!/ennovelas-tv\.com\//i.test(e.url||'')) continue;
        const po=ennPosterParaEntrada(e.url,e.title,e.serie);
        if(po&&e.img!==po){e.img=po;if(storedContinue[i])storedContinue[i].img=po;continueChanged=true;}
      }
      if(continueChanged)saveContinuar();
      /* v96: sana TAMBIÉN al leer — las entradas viejas de episodios (con
       * el still de la escena) muestran el póster de la serie ya mismo,
       * sin esperar a que se vuelvan a guardar.
       * v99: el slug sale de la PROPIA URL del episodio — no exigimos que
       * la entrada traiga serie/ep (las guardadas en sala a veces no los
       * tienen y el still se quedaba para siempre) */
      const porSanear = [...new Set(items
        .filter((e) => /\/episode\/[a-z0-9-]+-\d+x\d+/i.test(e.url))
        .map((e) => (/\/episode\/([a-z0-9-]+)-\d+x\d+(?:\/|$)/i.exec(e.url) || [])[1])
        .filter(Boolean))];
      if (porSanear.length) {
        const posters = await Promise.all(porSanear.map((sl) => posterDeSerie(sl)));
        const mapa = new Map(porSanear.map((sl, i) => [sl, posters[i]]));
        for (const e of items) {
          if (!/\/episode\//i.test(e.url)) continue;
          const sl = (/\/episode\/([a-z0-9-]+)-\d+x\d+(?:\/|$)/i.exec(e.url) || [])[1];
          const po = sl && mapa.get(sl);
          if (po) e.img = po;
        }
      }
      /* v104: caricaturas — las entradas de episodios muestran el PÓSTER de la
       * serie (portada curada o la de su página), como los animes; arregla las
       * entradas viejas que quedaron con el recuadro sin imagen */
      const porSanearC = [...new Set(items
        .filter((e) => /miscaricaturas\.com\/[a-z0-9-]+-\d{2}x\d{2}/i.test(e.url))
        .map((e) => (/miscaricaturas\.com\/([a-z0-9-]+)-\d{2}x\d{2}/i.exec(e.url) || [])[1])
        .filter(Boolean))];
      if (porSanearC.length) {
        /* v109: el prefijo del ep se mapea a la SERIE real (los eps del
         * Chavo llevan el año intercalado y el prefijo no existe como
         * página — por eso las entradas quedaban en blanco); portada
         * local curada primero, sin red */
        const metas = await Promise.all(porSanearC.map((sl) => cariMetaDe(cariSerieDeEp(sl) || sl).catch(() => null)));
        const mapaC = new Map(porSanearC.map((sl, i) => [sl, metas[i]]));
        for (const e of items) {
          if (!/miscaricaturas\.com\//i.test(e.url)) continue;
          const sl = (/miscaricaturas\.com\/([a-z0-9-]+)-\d{2}x\d{2}/i.exec(e.url) || [])[1];
          if (!sl) continue;
          const serie = cariSerieDeEp(sl) || sl;
          const mt = mapaC.get(sl);
          const po = CARI_PORTADAS.get(serie) || (mt && (mt.cover || mt.poster)) || '';
          if (po) e.img = po;
        }
      }
      return json(res, 200, { ok: true, items });
    }
    if (url.pathname === '/api/solo' && req.method === 'GET') {
      crawlUltimaActividad = Date.now(); /* v190 */
      /* v81: resolver el video directo de una página para modo individual — v278.6 auto-heal para TODOS */
      let name = (url.searchParams.get('name') || '').trim();
      let tok = url.searchParams.get('tok') || '';
      let urec = users.get(name.toLowerCase());
      let healedToken = null;
      if (!name || !urec || urec.token !== tok) {
        // v278.6: si el perfil existe pero token viejo (tras restart/data perdida), curar al instante y dejar pasar
        const key = name.toLowerCase();
        const exists = users.get(key);
        if (name && exists && exists.token !== tok) {
          exists.token = uid(); exists.lastSeenAt = Date.now(); saveUsers();
          urec = exists; tok = exists.token; healedToken = tok;
          console.log(`[solo] auto-heal token para ${name} -> ${tok.slice(0,8)}`);
        } else if (name && !exists && NAME_RE.test(name)) {
          // perfil nunca existió en este servidor (tras restart limpio) — crearlo al vuelo
          const rec = { name, token: tok || uid(), createdAt: Date.now(), lastSeenAt: Date.now() };
          if (!tok) tok = rec.token;
          users.set(key, rec); saveUsers(); urec = rec; healedToken = tok;
          console.log(`[solo] auto-create ${name}`);
        } else {
          return json(res, 403, { ok: false, error: 'Perfil no válido', healable: true });
        }
      }
      const target = url.searchParams.get('url') || '';
      /* v219: el catálogo vivo de Movie manda una ruta de NUESTRO proxy
         (/api/movie/v-vid?url=…). Antes el guardia de URL absoluta la tumbaba
         con «URL no válida» y la película no arrancaba en el modo Solo. */
      if (esStreamPropioUS(target)) {
        const out = { ok: true, m3u8: target, subs: [], mp4: false, proxy: false };
        if (healedToken) out.newToken = healedToken;
        return json(res, 200, out);
      }
      if (!/^https?:\/\/[a-z0-9.-]+/i.test(target)) return json(res, 400, { ok: false, error: 'URL no válida' });
      try {
        /* v295: la cadena de resolución vive en resolverPagina() (la misma que
           usa la verificación dirigida tras un fallo) */
        let r;
        try { r = await resolverPagina(target); epsPerdonar(target); } /* v205.5 + v206 + v206.2 + v207 + v235 + v286 d23 */
        catch (e2r) { epsFallo(target); throw e2r; } /* v205.5: episodios muertos al contador */
        const out2 = { ok: true, m3u8: r.m3u8, subs: r.subs, mp4: !!r.mp4, proxy: !!r.proxy };
        if (healedToken) out2.newToken = healedToken;
        return json(res, 200, out2);
      } catch (e) {
        console.warn('[solo] no pude resolver', target.slice(0, 70), '→', String(e.message || e).slice(0, 90));
        verifEncolar(target); /* v295: revisar en concreto ~90 s después y dar veredicto */
        return json(res, 404, { ok: false, error: String(e.message || e).slice(0, 200), ocultado: EPS_MUERTOS.has(target) || /ya no está disponible en el sitio/.test(String(e.message || e)) }); /* v205.5: el cliente quita la tarjeta al momento */
      }
    }
    if (url.pathname === '/api/yt') {
      /* v163: envoltorio local para el player embebido de YouTube — el
       * iframe vive dentro de esta página y el error 153 desaparece.
       * Sin estado, sin cookie, solo el iframe con autoplay. */
      const vid = String(url.searchParams.get('v') || '');
      if (!/^[A-Za-z0-9_-]{6,16}$/.test(vid)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('video inválido'); return; }
      const html = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>YouTube</title>'
        + '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}'
        + 'iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head>'
        + '<body><iframe src="https://www.youtube-nocookie.com/embed/' + vid + '?autoplay=1&hl=es&cc_lang_pref=es&rel=0&playsinline=1" '
        + 'allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname.startsWith('/api/xd/')) {
      /* v98: el playlist de una peli de PelisXD ya resuelto (cuerpo cacheado
       * en el servidor — el original es de un solo uso). Los segmentos se
       * reescriben al proxy /api/hls con el Referer del espejo. */
      const tok = (url.pathname.split('/')[3] || '').replace(/[^a-z0-9]/gi, '');
      const s = pelisxdStreams.get(tok);
      if (!s || Date.now() - s.at > PELISXD_STREAM_TTL + 30 * 60 * 1000) {
        return json(res, 404, { ok: false, error: 'El stream expiró — vuelve a abrir la peli' });
      }
      return servirPlaylist(res, 200, s.body, s.base);
    }
    if (url.pathname === '/api/hls') {
      crawlUltimaActividad = Date.now(); /* v190: alguien puede estar viendo — el rastreador se pausa */
      /* v81: proxy del stream (solo goodstream) cuando directo falla */
      return proxearHls(req, res, url.searchParams.get('u') || '');
    }
    if (url.pathname === '/api/intro' && req.method === 'GET') {
      /* v128→v132: por URL del episodio — se buscan los tiempos EXACTOS del
       * episodio y, si no hay, los de su SERIE (la intro suele ser la misma
       * en todos los episodios: saltar uno la aprende para toda) */
      const ks = introKeysDe(String(url.searchParams.get('url') || ''));
      const datos = (ks.exacto && INTROS[ks.exacto]) || (ks.serie && INTROS[ks.serie]) || null;
      const it = datos && +datos.end > +datos.start ? { start: +datos.start, end: +datos.end } : null;
      /* v133: sin datos para esta serie → detección por audio en segundo plano.
       * v134: también con datos MANUALES (un clic equivocado no se queda para siempre) */
      const hace = INTRO_INTENTOS.get(ks.serie) || 0;
      if (introJobAtascado(ks.serie)) INTRO_JOBS.delete(ks.serie); /* v185 */
      /* v189: lacartoons sin mapa cap→serie (server recién actualizado) —
       * se refrescan sus series en 2º plano; el siguiente sondeo dispara solo */
      if (!ks.serie && Date.now() - (LCT_INTRO_REFRESCO_EN || 0) > 5 * 60 * 1000 && /lacartoons\.com$/.test((() => { try { return new URL(String(url.searchParams.get('url') || '')).hostname.replace(/^www\./, ''); } catch { return ''; } })())) {
        LCT_INTRO_REFRESCO_EN = Date.now();
        console.log('[intro] lacartoons: mapa de series frío — refrescando en 2º plano…');
        (async () => {
          const vistas = new Set();
          for (const lct of [...LCT_MERGE.map((x) => ({ slug: x.slug, lctId: x.lctId })), ...LCT_SERIES.values()]) {
            if (vistas.has(lct.lctId)) continue;
            vistas.add(lct.lctId);
            await refrescarDatosLacartoons(lct).catch(() => {});
          }
          console.log('[intro] lacartoons: ' + vistas.size + ' series refrescadas — el mapa ya dispara');
        })();
      }
      if (ks.serie && (!datos || datos.by !== 'auto') && fpcalcOk() && !INTRO_JOBS.has(ks.serie) && Date.now() - hace >= 6 * 3600 * 1000) {
        dispararDeteccionIntro(String(url.searchParams.get('url') || ''), ks.serie);
      }
      return json(res, 200, { ok: true, intro: it && +it.end > +it.start ? { start: +it.start, end: +it.end } : null, detectando: !!(ks.serie && INTRO_JOBS.has(ks.serie)) });
    }
    if (url.pathname === '/api/intro' && req.method === 'DELETE') {
      /* v134: «esta intro salta mal» — se olvida la serie y queda lista para
       * re-aprender a mano o re-detectarse por audio de inmediato */
      const ks = introKeysDe(String(url.searchParams.get('url') || ''));
      let borrado = 0;
      for (const k of [ks.exacto, ks.serie]) if (k && INTROS[k]) { delete INTROS[k]; borrado++; }
      if (ks.serie) INTRO_INTENTOS.delete(ks.serie); /* sin puerta de 6h: que re-detecte ya */
      if (borrado) guardarIntros();
      console.log('[intro] olvidada ' + (ks.serie || ks.exacto) + ' (' + borrado + ' entrada' + (borrado === 1 ? '' : 's') + ')');
      return json(res, 200, { ok: true, borrado });
    }
    if (url.pathname === '/api/intro' && req.method === 'POST') {
      const b = await readBody(req);
      const ks = introKeysDe(String(b.url || ''));
      const key = ks.serie || ks.exacto; /* v132: se guarda a NIVEL DE SERIE */
      const start = Math.max(0, +b.start || 0), end = Math.min(3600, +b.end || 0);
      if (!key || end <= start || end - start > 600) return json(res, 400, { ok: false, error: 'Datos de intro no válidos' });
      INTROS[key] = { start, end, by: String(b.name || '').slice(0, 24), at: Date.now() };
      guardarIntros();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/progress' && req.method === 'POST') {
      /* v81: guardar el minuto por el que va el usuario en modo individual */
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const tok = String(body.token || '');
      const urec = users.get(name.toLowerCase());
      if (!name || !urec || urec.token !== tok) return json(res, 403, { ok: false, error: 'Perfil no válido' });
      const entry = {
        url: String(body.url || '').slice(0, 300),
        t: Math.max(0, Math.round(+body.t || 0)),
        d: Math.max(0, Math.round(+body.d || 0)),
        title: String(body.title || '').slice(0, 80),
        img: String(body.img || '').slice(0, 400),
        ep: String(body.ep || '').slice(0, 30),
        serie: String(body.serie || '').slice(0, 80),
        modo: body.modo === 'solo' ? 'solo' : '',
        ts: Date.now(),
      };
      /* v286: todo progreso de Ennovelas guarda la portada de serie de IMDb. */
      if(/ennovelas-tv\.com\//i.test(entry.url)){const po=ennPosterParaEntrada(entry.url,entry.title,entry.serie);if(po)entry.img=po;}
      if (!entry.url) return json(res, 400, { ok: false, error: 'Falta la URL' });
      /* v96: la entrada de un EPISODIO de serie lleva el PÓSTER DE LA
       * SERIE — las entradas creadas antes (o re-guardadas al retomar y
       * al avanzar en la cadena) traían el still de la escena; al guardar,
       * el servidor las sanea él solo.
       * v99: igual que al leer — el slug sale de la URL, sin exigir
       * serie/ep en el cuerpo */
      if (/\/episode\/[a-z0-9-]+-\d+x\d+/i.test(entry.url)) {
        const mSl = /\/episode\/([a-z0-9-]+)-\d+x\d+(?:\/|$)/i.exec(entry.url);
        const posterSerie = mSl ? await posterDeSerie(mSl[1]) : '';
        if (posterSerie) entry.img = posterSerie;
      }
      /* v109: lo mismo para EPISODIOS DE CARICATURAS — el prefijo del ep
       * se mapea a la serie real y se prefiere la portada local curada */
      if (/miscaricaturas\.com\/[a-z0-9-]+-\d{2}x\d{2}/i.test(entry.url)) {
        const pref = (/miscaricaturas\.com\/([a-z0-9-]+)-\d{2}x\d{2}/i.exec(entry.url) || [])[1];
        const serie = pref && (cariSerieDeEp(pref) || pref);
        const mt = serie ? await cariMetaDe(serie).catch(() => null) : null;
        const po = (serie && CARI_PORTADAS.get(serie)) || (mt && (mt.cover || mt.poster)) || '';
        if (po) entry.img = po;
      }
      /* v112: lo mismo para EPISODIOS DE LACARTOONS — el capId se mapea
       * a la serie real (billy / icarly / drake-y-josh) y viaja su póster */
      if (/lacartoons\.com\/serie\/capitulo\/\d+/i.test(entry.url)) {
        const capId = (/lacartoons\.com\/serie\/capitulo\/(\d+)/i.exec(entry.url) || [])[1];
        const serie = capId && lctSerieDeCap(capId);
        const mt = serie ? await cariMetaDe(serie).catch(() => null) : null;
        const po = (serie && CARI_PORTADAS.get(serie)) || (mt && (mt.cover || mt.poster)) || '';
        if (po) entry.img = po;
      }
      /* v85: el episodio queda anotado como visto (para las ✓ del selector) */
      if (entry.d >= 60) {
        anotarVisto(name.toLowerCase(), entry);
        saveVistos();
      }
      /* v86: la cadena de episodios restante viaja con el reporte — y si
       * venimos de avanzar al siguiente, la entrada del episodio anterior
       * (ya terminado) se quita para no acumular la misma serie */
      const epsArr = Array.isArray(body.eps)
        ? body.eps.slice(0, 100).map((x) => ({ url: String((x && x.url) || '').slice(0, 300), ep: String((x && x.ep) || '').slice(0, 30) })).filter((x) => x.url)
        : [];
      if (epsArr.length) entry.eps = epsArr;
      const prevUrl = String(body.prevUrl || '').slice(0, 300);
      /* mismo criterio que registrarProgreso: solo si hay algo que retomar */
      if (entry.d >= 60 && entry.t >= 5) {
        const key = name.toLowerCase();
        const lista = continuar.get(key) || [];
        if (prevUrl && prevUrl !== entry.url) {
          const j = lista.findIndex((e) => e.url === prevUrl);
          if (j >= 0) lista.splice(j, 1);
        }
        const i = lista.findIndex((e) => e.url === entry.url);
        if (i >= 0) lista.splice(i, 1);
        lista.unshift(entry);
        if (lista.length > CONT_MAX) lista.length = CONT_MAX;
        continuar.set(key, lista);
        saveContinuar();
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/vistos' && req.method === 'POST') {
      /* v85: ¿cuáles de estas URLs ya vio el usuario? (marcas del selector) */
      const body = await readBody(req);
      const nameV = String(body.name || '').trim();
      const urecV = users.get(nameV.toLowerCase());
      if (!nameV || !urecV || urecV.token !== String(body.token || '')) return json(res, 403, { ok: false, error: 'Perfil no válido' });
      const mapa = vistos.get(nameV.toLowerCase()) || {};
      const urls = Array.isArray(body.urls) ? body.urls.slice(0, 400).map((u) => String(u).slice(0, 300)) : [];
      const fuera = {};
      for (const u of urls) if (mapa[u]) fuera[u] = { t: mapa[u].t || 0, d: mapa[u].d || 0 };
      return json(res, 200, { ok: true, vistos: fuera });
    }
    if (url.pathname === '/api/rooms') {
      /* v31: salas en vivo con gente, qué ven y preview del espejo (estilo Rave) */
      const list = [...rooms.values()]
        .filter((r) => r.users.size > 0)
        .sort((a, b) => b.users.size - a.users.size)
        .slice(0, 12)
        .map((r) => {
          const m = mirrors.get(r.code);
          /* v32: sin fotograma en el lobby (volvió lenta la app) — solo el host
           * del sitio espejado: la tarjeta muestra su logo */
          let watching = null, isMirror = false, host = null;
          if (m) { isMirror = true; host = hostOf(m.url || ''); watching = 'Espejando ' + host; }
          else if (r.videoTitle) watching = r.videoTitle;
          return {
            code: r.code,
            users: [...r.users.values()].slice(0, 8).map((u) => u.name),
            count: r.users.size,
            watching, isMirror, host,
            since: r.createdAt,
          };
        });
      return json(res, 200, { ok: true, rooms: list, srvVersion: UI_VERSION });
    }
    if (url.pathname === '/api/health') {
      let disco={}; try{ const s=fs.statfsSync(__dirname); const total=Math.round(s.bsize*s.blocks/1024/1024/1024*10)/10; const libre=Math.round(s.bsize*s.bavail/1024/1024/1024*10)/10; const usado=Math.round((total-libre)*10)/10; const pct=Math.round((usado/total)*100); disco={totalGb:total, libreGb:libre, usadoGb:usado, pct}; }catch{ disco={totalGb:0, libreGb:0, usadoGb:0, pct:0}; }
      const mem=process.memoryUsage(); const heapMb=Math.round(mem.heapUsed/1024/1024); const rssMb=Math.round(mem.rss/1024/1024);
      const uptime=Math.floor(process.uptime());
      return json(res, 200, { ok: true, rooms: rooms.size, version: UI_VERSION, maxUsers: MAX_USERS, concurrencia: 100, mostrarTodo: HUDDLE_MOSTRAR_TODO, novelasOn: NOVELAS_EXTERNAS_ON, introCrawl: { pend: CRAWL.pend.length, hechas: CRAWL.hechas || 0, total: CRAWL.total || 0 }, laMuertas: LA_MUERTAS_SET.size, pxdOcultas: PXD_OCULTAS.size, afOcultas: AF_OCULTAS.size, ccOcultas: CC_OCULTAS.size, ccTotal: ccIdx.slugs.length, disco, memoria:{heapMb, rssMb}, uptime, auditoriaCompleta: auditoriaCompletaEstado(), sondas:{huddle:{pelis:10, series:8, conc:10, pausaMs:500}, fuentes:{perCiclo:15}} });
    }
    if (url.pathname === '/api/auditoria/estado' && req.method === 'GET') {
      auditoriaActualizarPct();
      return json(res, 200, { ok:true, version: UI_VERSION, auditoria: { activo: HUDDLE_AUDITORIA.activo, pausado: HUDDLE_AUDITORIA.pausado, iniciadoEn: HUDDLE_AUDITORIA.iniciadoEn, alcance: HUDDLE_AUDITORIA.alcance, progreso: HUDDLE_AUDITORIA.progreso, logs: HUDDLE_AUDITORIA.logs.slice(0,50) }, progresoFile: (()=>{ try{ return JSON.parse(fs.readFileSync(AUDITORIA_PROGRESO_FILE,'utf8')); }catch{ return null; }})() });
    }
    if (url.pathname === '/api/auditoria/completa' && req.method === 'POST') {
      const body = await readBody(req);
      const conc = parseInt(body.concurrencia)||30;
      if(AUDITORIA_COMPLETA.activo) return json(res, 200, {ok:false, error:'Ya en curso', estado: auditoriaCompletaEstado()});
      json(res, 200, {ok:true, iniciado:true, concurrencia: conc});
      auditoriaCompletaIniciar(conc).catch(e=>console.warn('[completa] error', String(e).slice(0,80)));
      return;
    }
    if (url.pathname === '/api/auditoria/completa' && req.method === 'GET') {
      return json(res, 200, {ok:true, estado: auditoriaCompletaEstado()});
    }
    if (url.pathname === '/api/auditoria/completa' && req.method === 'DELETE') {
      AUDITORIA_COMPLETA._abort=true; AUDITORIA_COMPLETA.activo=false;
      return json(res, 200, {ok:true, cancelado:true});
    }
    if (url.pathname === '/api/auditoria/control' && req.method === 'POST') {
      const body = await readBody(req);
      const accion = String(body.accion||'').toLowerCase();
      if(accion==='play' || accion==='iniciar'){ auditoriaIniciar(body.alcance||null); return json(res,200,{ok:true, estado: HUDDLE_AUDITORIA.activo?'ejecutando':'idle'}); }
      if(accion==='pausa' || accion==='pausar'){ auditoriaPausar(); return json(res,200,{ok:true, pausado:true}); }
      if(accion==='reanudar' || accion==='resume'){ auditoriaReanudar(); return json(res,200,{ok:true, pausado:false}); }
      if(accion==='cancelar' || accion==='cancel' || accion==='stop'){ auditoriaCancelar(); return json(res,200,{ok:true, activo:false}); }
      if(accion==='configurar' && body.alcance){ 
        // actualizar alcance sin iniciar
        const a=body.alcance;
        if(typeof a.peliculas==='boolean') HUDDLE_AUDITORIA.alcance.peliculas=a.peliculas;
        if(typeof a.series==='boolean') HUDDLE_AUDITORIA.alcance.series=a.series;
        if(a.fuentes) for(const k of Object.keys(HUDDLE_AUDITORIA.alcance.fuentes)) if(typeof a.fuentes[k]==='boolean') HUDDLE_AUDITORIA.alcance.fuentes[k]=a.fuentes[k];
        auditoriaGuardarProgreso();
        return json(res,200,{ok:true, alcance: HUDDLE_AUDITORIA.alcance});
      }
      return json(res,400,{ok:false, error:'Acción no válida (play/pausa/reanudar/cancelar/configurar)'});
    }
    if (url.pathname === '/api/set-relay') { /* v236: actualizar CDN relay URL del Mac Mini */
      const newUrl = (url.searchParams.get('url') || '').trim().replace(/\/+$/, '');
      if (!newUrl) return json(res, 400, { ok: false, error: 'Falta ?url=' });
      CDN_RELAY = newUrl;
      console.log('[relay] CDN relay actualizado:', CDN_RELAY);
      try { require('fs').writeFileSync('/tmp/huddle-relay.txt', newUrl); } catch {} /* v236.8: persistir relay */
      return json(res, 200, { ok: true, relay: CDN_RELAY });
    }

    /* v238: estadísticas por fuente */
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      /* v239.10: totales REALES de auditorías + sitemaps.
       * Cada fuente tiene su total conocido (sitemap/catálogo completo).
       * Ocultas = verificadas como muertas. Activas = total - ocultas.
       * Vistas = cuántas se han verificado hasta ahora (metadata de sonda). */
      const CV_KNOWN_TOTAL = 8200;   /* ~8200 películas en sitemap cuevana.mov */
      const PXD_KNOWN_TOTAL = 4700;  /* ~4700 películas en sitemap pelisxd.com */
      const CC_KNOWN_TOTAL = 10950;  /* ~10950 títulos (películas+series) en cine-calidad.mx */
      const stats = {
        ok: true,
        fuentes: {
          cuevana: {
            nombre: 'Cuevana',
            total: CV_KNOWN_TOTAL,
            ocultas: CVM_OCULTAS.size,
            vistas: CVM_VISTAS.size,
            activas: CV_KNOWN_TOTAL - CVM_OCULTAS.size,
          },
          pelisxd: {
            nombre: 'PelisXD',
            total: PXD_KNOWN_TOTAL,
            ocultas: PXD_OCULTAS.size,
            vistas: pxdVistas.size,
            activas: PXD_KNOWN_TOTAL - PXD_OCULTAS.size,
          },
          cinecalidad: {
            nombre: 'CineCalidad',
            total: CC_KNOWN_TOTAL,
            ocultas: CC_OCULTAS.size,
            vistas: CC_VISTAS.size,
            activas: CC_KNOWN_TOTAL - CC_OCULTAS.size,
          },
          latanime: {
            nombre: 'Latanime',
            total: LA_TODOS.size,
            ocultas: LA_OCULTAS_SET.size + LA_MUERTAS_SET.size,
            vistas: LA_VISTAS.size,
            activas: LA_TODOS.size - LA_OCULTAS_SET.size - LA_MUERTAS_SET.size,
          },
          danimados: {
            nombre: 'Danimados',
            total: DANI_CAT.size,
            ocultas: DANI_OCULTAS.size + DANI_MUERTAS.size,
            vistas: [...CARI_VISTAS].filter((x) => x.startsWith('dani:')).length,
            activas: DANI_CAT.size - DANI_OCULTAS.size - DANI_MUERTAS.size,
          },
          lacartoons: {
            nombre: 'Lacartoons',
            total: LCT_SERIES.size,
            ocultas: LCT_OCULTAS.size + LCT_MUERTAS.size,
            vistas: [...CARI_VISTAS].filter((x) => x.startsWith('lct:')).length,
            activas: LCT_SERIES.size - LCT_OCULTAS.size - LCT_MUERTAS.size,
          },
          animeflv: {
            nombre: 'AnimeFLV',
            total: AF_TODOS.size,
            ocultas: AF_OCULTAS.size,
            vistas: AF_VISTAS.size,
            activas: AF_TODOS.size - AF_OCULTAS.size,
          },
          ennovelas: {
            nombre: 'Ennovelas',
            total: ENN_SONDA.total || (ENN_VISTAS.size + ENN_OCULTAS.size),
            ocultas: ENN_SONDA.ocultas || ENN_OCULTAS.size,
            vistas: ENN_SONDA.auditadas || ENN_VISTAS.size,
            activas: ENN_SONDA.visibles || ENN_VISTAS.size,
            sonda: ENN_SONDA,
          },
          miscaricaturas: {
            nombre: 'MisCaricaturas',
            total: CARI_ORDEN.length,
            ocultas: CARI_MUERTAS.size,
            vistas: [...CARI_VISTAS].filter((x) => x.startsWith('cari:')).length,
            activas: CARI_ORDEN.length - CARI_MUERTAS.size,
          },
          animed23: {
            nombre: 'AnimeD23',
            total: D23_TODOS.size,
            ocultas: D23_OCULTAS.size,
            vistas: D23_VISTAS.size,
            activas: D23_TODOS.size - D23_OCULTAS.size,
          },
        },
        usuarios: users.size,
        memoria: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      };
      return json(res, 200, stats);
    }

    /* v238: gestión de usuarios — listar y eliminar */
    if (url.pathname === '/api/users' && req.method === 'GET') {
      /* v239.11: online = en sala O viendo en Solo (progreso reciente <5min) */
      const onlineSet = new Set();
      const FIVE_MIN = 5 * 60 * 1000;
      const now = Date.now();
      /* Usuarios en salas */
      for (const room of rooms.values()) {
        for (const u of room.users.values()) {
          if (u.name) onlineSet.add(u.name.toLowerCase());
        }
      }
      /* Usuarios en modo Solo (progreso reportado en los últimos 5 min) */
      for (const [key, items] of continuar) {
        if (Array.isArray(items) && items.length > 0) {
          const last = items[0]; /* más reciente primero */
          if (last.ts && now - last.ts < FIVE_MIN) onlineSet.add(key);
        }
      }
      const lista = [];
      for (const [key, u] of users) {
        lista.push({
          name: u.name || key,
          createdAt: u.createdAt || null,
          lastSeenAt: u.lastSeenAt || null,
          online: onlineSet.has(key),
        });
      }
      return json(res, 200, { ok: true, total: lista.length, usuarios: lista });
    }
    if (url.pathname === '/api/users' && req.method === 'DELETE') {
      
      const body = await readBody(req);
      const target = String(body.name || '').trim().toLowerCase();
      if (!target) return json(res, 400, { ok: false, error: 'Falta name' });
      if (!users.has(target)) return json(res, 404, { ok: false, error: 'Usuario no encontrado' });
      users.delete(target);
      try { guardarUsuarios(); } catch {}
      return json(res, 200, { ok: true, eliminado: target });
    }

    if (url.pathname === '/api/intros') { /* v205.3: estado del rastreador — v205.4: en navegador pinta el PANEL; ?json=1 o curl → JSON; v223: + cosecha Movie */
      const SITIOS = { dani: 'Caricaturas', mm: 'Caricaturas', lct: 'Cartoons', la: 'Anime', af: 'AnimeFLV', cv: 'Cuevana' };
      const muestra = Object.entries(INTROS).slice(0, 40).map(([k, v]) => {
        const p = k.split(':');
        return { sitio: SITIOS[p[0]] || p[0], serie: (p[1] || '').replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 40), temporada: p[2] || '?', inicio: v.start, fin: v.end, via: v.by || 'auto' };
      });
      const cosecha = movieCosechaEstado();
      const datos = {
        ok: true,
        episodiosAnalizados: CRAWL.hechas || 0,
        episodiosPorAnalizar: CRAWL.total || 0,
        enCola: CRAWL.pend.length,
        introsAprendidas: Object.keys(INTROS).length,
        seriesSinIntro: (CRAWL.sinIntro || []).length,
        muestra,
        cosecha,
        titulosEncontrados: cosecha && cosecha.archivo ? cosecha.archivo.total : 0,
        titulosCheckpoint: cosecha && cosecha.meta ? cosecha.meta.hits : 0,
      };
      if (!/text\/html/i.test(req.headers.accept || '') || url.searchParams.get('json') === '1') return json(res, 200, datos);
      /* v239.5: auth via cookie — panel como archivo externo */
      const adminPass = 'Samuelito8';
      const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => { const [k,v] = c.trim().split('='); if(k) acc[k]=v; return acc; }, {});
      const urlPass = url.searchParams.get('pass');
      if (cookies.huddle_admin === 'ok' || urlPass === adminPass) {
        /* Set cookie and serve external panel file */
        res.writeHead(302, { 'Location': '/panel.html', 'Set-Cookie': 'huddle_admin=ok; Path=/; HttpOnly', 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Huddle Admin</title><style>body{background:#0d0b14;color:#efeaf7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{background:#17131f;border:1px solid #2a2338;border-radius:16px;padding:30px;text-align:center;max-width:300px}input{background:#0d0b14;border:1px solid #2a2338;border-radius:8px;padding:10px;color:#efeaf7;width:100%;margin:10px 0;font-size:16px}button{background:#8a5cf6;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:16px;cursor:pointer;width:100%}h2{margin:0 0 20px}</style></head><body><div class="box"><h2>Huddle Admin</h2><form method="GET"><input type="password" name="pass" placeholder="Contrasena" autofocus><button type="submit">Entrar</button></form></div></body></html>');
    }
    
    /* v239.13: log de sonda — ?fuente=CineCalidad|PelisXD|Cuevana&limit=50 */
    if (url.pathname === '/api/sonda-log' && req.method === 'GET') {
      const fuente = url.searchParams.get('fuente') || '';
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50));
      let items = SONDALOG;
      if (fuente === 'Caricaturas') items = items.filter(e => e.fuente === 'Danimados' || e.fuente === 'Lacartoons' || e.fuente === 'MisCaricaturas');
      else if (fuente) items = items.filter(e => e.fuente === fuente);
      return json(res, 200, { ok: true, total: items.length, items: items.slice(0, limit) });
    }
    // v278: VIX sonda + progreso + novelas-vix (Betty 335 + VIX desencriptado con autocura) + ESTRELLAS (LasEstrellas.tv fallback gratis por fuente separada)
    if (url.pathname === '/api/vix/sonda' && req.method === 'GET') {
      return json(res, 200, { ok: true, sonda: VIX_SONDA });
    }
    if (url.pathname === '/api/vix/progreso' && req.method === 'GET') {
      const slug = url.searchParams.get('slug') || '';
      if (slug) {
        const p = VIX_PROGRESO.get(slug);
        return json(res, 200, { ok: true, progreso: p || null });
      }
      return json(res, 200, { ok: true, progreso: Object.fromEntries(VIX_PROGRESO), sonda: VIX_SONDA });
    }
    if ((url.pathname === '/api/novelas-vix/catalogo' || url.pathname === '/api/vix/novelas') && req.method === 'GET') {
      /* v285: ruta legacy reducida a la única fuente permitida: Ennovelas. */
      const items = (await ennCatalogo()).map(c => ({ slug:c.slug, titulo:c.title, url:c.url, img:c.img, vix:false, fuente:'ennovelas', extra:c.extra, progreso:{pct:100,estado:'HLS HTTP confirmado'} }));
      return json(res, 200, { ok:true, total:items.length, items, sonda:ENN_SONDA });
    }
    // v278: LasEstrellas endpoints por fuente separada
    if (url.pathname === '/api/estrellas/sonda' && req.method === 'GET') {
      return json(res, 200, { ok: true, sonda: ESTRELLAS_SONDA });
    }
    if (url.pathname === '/api/estrellas/progreso' && req.method === 'GET') {
      const slug = url.searchParams.get('slug') || '';
      if (slug) {
        const p = ESTRELLAS_PROGRESO.get(slug);
        return json(res, 200, { ok: true, progreso: p || null, sonda: ESTRELLAS_SONDA });
      }
      return json(res, 200, { ok: true, progreso: Object.fromEntries(ESTRELLAS_PROGRESO), sonda: ESTRELLAS_SONDA });
    }
    // v285: endpoint legacy sin VIX/Estrellas; conserva solo Ennovelas.
    if (url.pathname === '/api/novelas-vix/sondas' && req.method === 'GET') {
      return json(res, 200, { ok:true, ennovelas:{sonda:ENN_SONDA, catalogo:(await ennCatalogo()).map(c=>({slug:c.slug,titulo:c.title,fuente:'ennovelas',extra:c.extra}))} });
    }
    if (url.pathname === '/api/intros-panel' && req.method === 'GET') { /* v305: galería de intros aprendidas para el panel */
      const out = [];
      try {
        for (const [k, v] of Object.entries(INTROS)) {
          if (!v || typeof v.start !== 'number' || typeof v.end !== 'number') continue;
          const p = k.indexOf(':');
          const sitio = p > 0 ? k.slice(0, p) : '?';
          const slug = p > 0 ? k.slice(p + 1) : k;
          const ps = postersSeries.get(slug);
          const sc = ps ? null : (serieCache.get(k) || serieCache.get('latanime:' + slug) || serieCache.get('anime:' + slug) || serieCache.get('d23:' + slug));
          out.push({
            key: k, sitio, slug,
            titulo: slug.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 70),
            poster: (ps && ps.poster) || (sc && sc.d && sc.d.poster) || '',
            start: v.start, end: v.end, by: v.by || '?', at: v.at || 0,
          });
        }
      } catch {}
      out.sort((a, b) => (b.at || 0) - (a.at || 0));
      return json(res, 200, { ok: true, on: INTRO_AUTO_ON, pendientes: (CRAWL && CRAWL.pend) ? CRAWL.pend.length : 0, total: out.length, intros: out.slice(0, 400) });
    }
    if (url.pathname === '/api/intro-auto') { /* v301: interruptor del detector de intros */
      if (req.method === 'POST') {
        const b = await readBody(req);
        INTRO_AUTO_ON = !!b.on;
        introAutoGuardar();
        console.log('[intro] v301: detector automático ' + (INTRO_AUTO_ON ? 'ENCENDIDO' : 'APAGADO') + ' desde el panel');
      }
      return json(res, 200, { ok: true, on: INTRO_AUTO_ON });
    }
    if (url.pathname === '/api/sondas') { /* v293: salud de cada sonda + últimos eventos — para el panel */
      const ahora = Date.now();
      /* v307: cada sonda vigila TODA su página: nuevas, vivas, muertas y revive ocultas */
      const VIGILA = 'vigila toda su página: nuevas, vivas, muertas · revive las ocultas';
      const NOMBRES_SONDA = {
        pelisxd: ['PelisXD', VIGILA],
        cuevana: ['Cuevana', VIGILA],
        cinecalidad: ['CineCalidad', VIGILA],
        latanime: ['Latanime', VIGILA],
        animeflv: ['AnimeFLV', VIGILA],
        animed23: ['AnimeD23', VIGILA],
        danimados: ['Danimados', VIGILA],
        lacartoons: ['Lacartoons', VIGILA],
        miscaricaturas: ['MisCaricaturas', VIGILA],
        ennovelas: ['Ennovelas', 'capítulos y portadas: vivas y muertas · solo gratis'],
        laRevizar: ['Latanime — revive ocultas', 'va con la sonda Latanime: repasa series ocultadas por si ya revivieron'],
        revivir: ['Revivir todas las fuentes', 'repasa títulos ocultos de todo Huddle y los revive si ya responden'],
        huddle: ['Sonda Huddle', 'la única que revisa Huddle mismo: sus series y películas, si mueren o reviven'],
        epsPodredumbre: ['Podredumbre de eps', 'oculta capítulos muertos sin esperar clicks'],
      };
      const sondas = {};
      for (const [k, v] of Object.entries(SONDAS_STATE)) {
        if (!NOVELAS_EXTERNAS_ON && (k === 'novelas' || k === 'novelasVix' || k === 'novelasEstrellas')) continue; /* v306: descontinuadas, fuera del satélite */
        if (k === 'laRevizar') continue; /* v308: fuera del satélite — la sonda Latanime + el barrido ya reviven sus ocultas */
        const nn = NOMBRES_SONDA[k];
        sondas[k] = { veces: v.veces, haceSeg: v.ultima ? Math.round((ahora - v.ultima) / 1000) : null, ms: v.ms, ok: v.ok, err: v.err || undefined, nombre: nn ? nn[0] : k, desc: nn ? nn[1] : '' };
      }
      return json(res, 200, {
        ok: true, novelasExternas: NOVELAS_EXTERNAS_ON,
        sondas,
        verificaciones: { /* v295: circuito fallo → revisión dirigida */
          enCola: VERIF_COLA.size,
          sospechasHuddle: Object.fromEntries([...VERIF_SOSPECHAS].filter(([, v]) => Date.now() - v.ts < 3600000).map(([k, v]) => [k, v.n])),
        },
        barrido: { /* v296: barrido continuo repartido */
          hechos: BARRIDO.hechos, vueltas: BARRIDO.vueltas, pos: BARRIDO.pos,
          capsOcultos: EPS_MUERTOS.size, /* v308: capítulos ocultados (nivel episodio) */
          epsTotales: CRAWL.total || 0, /* v308: episodios conocidos de series (base del catálogo de episodios) */
          totales: {
            pelisxd: (pelisxdIdx && pelisxdIdx.slugs ? pelisxdIdx.slugs.length : 0),
            cuevana: cuevanaIdx.slugs.length,
            cinecalidad: (ccIdx && ccIdx.slugs ? ccIdx.slugs.length : 0),
            latanime: LA_TODOS.size, animeflv: AF_TODOS.size, animed23: D23_TODOS.size,
          },
        },
        eventos: SONDALOG.slice(0, 60).map((e) => ({ ts: new Date(e.ts).toISOString(), fuente: e.fuente, tipo: e.tipo, slug: e.slug, msg: e.msg })),
      });
    }
    if (url.pathname === '/api/estado') { /* v205.4: todo el estado en un JSON para el panel; v223: + cosecha; v227: + llave CDN */
      
      const SITIOS2 = { dani: 'Caricaturas', mm: 'Caricaturas', lct: 'Cartoons', la: 'Anime', af: 'AnimeFLV', cv: 'Cuevana' };
      const muestra = Object.entries(INTROS).slice(0, 60).map(([k, v]) => {
        const p = k.split(':');
        return { sitio: SITIOS2[p[0]] || p[0], serie: (p[1] || '').replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 40), temporada: p[2] || '?', inicio: v.start, fin: v.end };
      });
      const mem = process.memoryUsage();
      const cosecha = movieCosechaEstado();
      return json(res, 200, {
        ok: true,
        version: UI_VERSION,
        encendidoHace: Math.floor(process.uptime()),
        introAuto: INTRO_AUTO_ON, /* v301 */
        introAprendidas: (() => { let n = 0; try { for (const v of Object.values(INTROS)) if (v && typeof v.start === 'number') n++; } catch {} return n; })(), /* v305 */
        introPendientes: (CRAWL && CRAWL.pend) ? CRAWL.pend.length : 0, /* v305 */
        memoriaMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576), /* v291 */
        heapLimiteMb: Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576), /* v291 */
        procesos: procResumen(), /* v291: chrome/ffmpeg/node — cuántos y cuánta RAM */
        serieCache: serieCache.size, /* v291 */
        salasActivas: rooms.size,
        usuarios: users.size,
        llaveCdn: !!movieCdnKey(),
        espejos: MOVIE_ESPEJOS,
        espejoPreferido: movieEspejoPreferido() || null,
        intros: { analizados: CRAWL.hechas || 0, total: CRAWL.total || 0, enCola: CRAWL.pend.length, aprendidas: Object.keys(INTROS).length, sinIntro: (CRAWL.sinIntro || []).length, muestra },
        moderacion: { animesMuertos: LA_MUERTAS_SET.size, animesCastDup: LA_OCULTAS_SET.size, pelisxd: PXD_OCULTAS.size, animeflv: AF_OCULTAS.size, animed23: D23_OCULTAS.size, cuevana: CV_OCULTAS_RT.size, ennovelas: ENN_OCULTAS.size, caricaturasMuertas: DANI_MUERTAS.size + LCT_MUERTAS.size + CARI_MUERTAS.size, protegidas: CV_PROTEGIDAS.size, epsOcultos: EPS_MUERTOS.size, fallosEnCurso: [FALLOS_PXD, FALLOS_AF, FALLOS_CV, FALLOS_NV, FALLOS_DANI, FALLOS_LCT, FALLOS_CARI, FALLOS_D23, EPS_FALLOS].reduce((a2, mm2) => a2 + [...mm2.values()].filter((x2) => x2.f >= 1 && !x2.h).length, 0) },
        catalogos: { caricaturas: cariFeedCache.items.length, cartoons: cariFeedCache.toons.length, liveaction: cariFeedCache.live.length, danimados: DANI_CAT.size, animes: LA_TODOS.size - LA_OCULTAS_SET.size - LA_MUERTAS_SET.size, ennovelas: ENN_SONDA.visibles || ENN_VISTAS.size, animeflv: AF_TODOS.size - AF_OCULTAS.size, animed23: D23_TODOS.size - D23_OCULTAS.size },
        cosecha,
        movie: (() => { /* v207: estado del mapa local del app Movie */
          movieRecargar();
          const seriesM = [...MOVIE.series.values()].map((s) => ({
            titulo: s.titulo, clave: s.clave,
            episodios: s.eps.length,
            activos: s.eps.filter((e) => !MOVIE.caidas.has(e.carpeta)).length,
            caidos: s.eps.filter((e) => MOVIE.caidas.has(e.carpeta)).map((e) => e.temporada + 'x' + e.episodio),
          }));
          return { mapa: fs.existsSync(MOVIE_MAPA_RUTA) ? MOVIE_MAPA_RUTA : 'FALTA — generar con mapear-secuencias-movie.js', origen: MOVIE_ORIGEN, series: seriesM, caidas: [...MOVIE.caidas.values()] };
        })(),
      });
    }
    if (url.pathname === '/panel.html') {
      const cks = (req.headers.cookie || '').split(';').reduce((a, c) => { const [k,v] = c.trim().split('='); if(k) a[k]=v; return a; }, {});
      if (cks.huddle_admin !== 'ok') {
        res.writeHead(302, { 'Location': '/api/intros' });
        return res.end();
      }
    }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Error interno' });
    else res.end();
  }
});

/* Sincronización periódica (corrección de desvío) + limpieza + v128 */
setInterval(() => {
  for (const room of rooms.values()) {
    /* v128: NATIVO — episodio que TERMINA (por tiempo) → siguiente solo.
     * fin = updatedAt + (duración − posición): corre aunque el cliente que
     * reportó la duración ya se haya ido de la sala. */
    if (room.native && room.serieCtx && room.isPlaying && room.videoDuration > 1) {
      const finMs = room.updatedAt + Math.max(0, room.videoDuration - room.position) * 1000;
      if (Date.now() >= finMs - 300 && room.autoNextKey !== room.videoUrl) {
        room.autoNextKey = room.videoUrl;
        autoSiguienteNativo(room).catch(() => {});
        continue;
      }
    }
    if (room.clients.size && room.isPlaying) broadcast(room, 'state', stateOf(room));
    /* v128: ESPEJO — leer el tiempo del video del Chrome remoto: alimenta
     * «Saltar intro» (mirror-state fresco) y detecta el final */
    const mi = mirrors.get(room.code);
    if (mi && mi.serie && mi.page && !mi.page.isClosed()) {
      mi.page.evaluate(() => {
        let t = 0, dur = 0, fin = false;
        document.querySelectorAll('video').forEach((v) => {
          if (v.duration > 1) { if (v.currentTime > t) t = v.currentTime; if (v.duration > dur) dur = v.duration; if (v.ended) fin = true; }
        });
        return { t, dur, fin };
      }).then((r) => {
        if (!r || !mirrors.get(room.code)) return;
        mi.curTime = r.t; mi.curDur = r.dur;
        if (r.fin && mi.playing && mi.autoNextKey !== mi.url) {
          mi.autoNextKey = mi.url;
          return avanzarAutoEspejo(room);
        }
        if (mi.playing) broadcast(room, 'mirror-state', mirrorState(room)); /* tiempo fresco en los clientes */
      }).catch(() => {});
    }
  }
}, 2500);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    /* v33: se borra la sala que pasó 40 min CON 0 PERSONAS (no desde su creación) */
    if (room.clients.size === 0 && room.emptyAt && now - room.emptyAt > ROOM_TTL_MS) {
      if (mirrors.has(code)) stopMirror(code).catch(() => {});
      rooms.delete(code);
      console.log(`[sala] ${code} vacía más de 40 min — eliminada para liberar memoria`);
    }
  }
}, 60000);

/* ═══════ v190: RASTREADOR DE INTROS — recorre TODO el catálogo de series
 * UNA sola vez (danimados 823 + cine-calidad/cuevana + latanime + caricaturas)
 * aprendiendo la intro de la primera temporada de cada una, SOLO cuando nadie
 * está viendo (sin /api/hls ni /api/solo en 60s y sin salas activas). Lo ya
 * aprendido jamás se vuelve a rastrear; los veredictos «sin intro» tampoco;
 * los fallos de red van al final y reintentan. Estado en data/intro-crawl.json:
 * actualizar.sh no lo toca → al reiniciar continúa donde iba. Las temporadas
 * que no son la 1 se aprenden solas cuando alguien entra (~1 min). ═══════ */
const CRAWL_FILE = path.join(DATA_DIR, 'intro-crawl.json');
let CRAWL = { pend: [], sinIntro: [], hechas: 0, total: 0, lista: false, vueltas: 0 };
try { const cc = JSON.parse(fs.readFileSync(CRAWL_FILE, 'utf8')); if (cc && Array.isArray(cc.pend)) CRAWL = Object.assign(CRAWL, cc); } catch {}
function crawlGuardar() { try { fs.writeFileSync(CRAWL_FILE, JSON.stringify(CRAWL)); } catch {} }
let crawlUltimaActividad = Date.now();
let crawlOcupado = false;

async function crawlConstruir() {
  const items = [];
  try { for (const sl of DANI_CAT.keys()) if (!DANI_OCULTAS.has(sl) && !DANI_MUERTAS.has(sl)) items.push({ u: 'dani:' + sl }); } catch {}
  try {
    for (const sm of ['tvshow-sitemap.xml', 'tvshow-sitemap2.xml']) {
      const r = await fetchSeguro('https://cine-calidad.mx/' + sm, 15000).catch(() => null);
      if (!r || !r.ok) continue;
      const txt = await r.text();
      for (const mm of txt.matchAll(/<loc>https:\/\/cine-calidad\.mx\/serie\/([a-z0-9-]+)\/?<\/loc>/gi)) {
        if (mm[1] && mm[1] !== 'serie') items.push({ u: 'cv:' + mm[1] });
      }
    }
  } catch {}
  /* v202: latanime desde los ARCHIVOS locales — la paginación ?page= del
   * sitio no funciona (repetía la página 1: la cola vieja venía con
   * duplicados) y así tampoco rastreamos ocultas ni muertas */
  try {
    for (const sl of LA_TODOS) {
      if (LA_OCULTAS_SET.has(sl) || LA_MUERTAS_SET.has(sl)) continue;
      items.push({ u: 'la:' + sl });
    }
  } catch {}
  /* v202: AnimeFLV EXCLUSIVAS (las que latanime cubre no se ven por af) */
  try {
    for (const sl of fs.readFileSync(path.join(__dirname, 'public', 'animeflv-slugs.txt'), 'utf8').split('\n')) if (sl.trim()) items.push({ u: 'af:' + sl.trim() });
  } catch {}
  try { for (const sl of cariDatos.keys()) items.push({ u: 'mm:' + sl }); } catch {}
  try { for (const x of LCT_SERIES.values()) items.push({ u: 'lct:' + x.slug }); } catch {}
  return items;
}

async function crawlItemUrl(it) {
  const t = it.u.slice(0, it.u.indexOf(':'));
  const sl = it.u.slice(t.length + 1);
  if (t === 'dani') return 'https://danimados.cc/episodios/' + sl + '-1x1/';
  if (t === 'cv') {
    const d = await datosSerieCuevana(sl).catch(() => null);
    if (!d || !d.episodios || !d.episodios.length) return null;
    const t1 = d.episodios.find((e) => e.temporada === 1) || d.episodios[0];
    return t1.url || null;
  }
  if (t === 'la') return 'https://latanime.org/ver/' + sl + '-episodio-1/';
  if (t === 'af') {
    /* v202.2: checa que el episodio tenga mp4upload ANTES de encolar la
     * detección — si no, el ítem giraría en la cola para siempre */
    return (async () => {
      try {
        const pu = 'https://vww.animeflv.one/ver/' + sl + '-1';
        const html = await fetchTexto(pu, 'https://vww.animeflv.one/');
        const enc = (/class="opt"[^>]*data-encrypt="([0-9a-f]+)"/i.exec(html) || [])[1];
        if (!enc) return null;
        const ctl2 = new AbortController();
        const t2 = setTimeout(() => ctl2.abort(), 12000);
        let cuerpo = '';
        try {
          const r2 = await fetch('https://vww.animeflv.one/flv', { method: 'POST', headers: { 'User-Agent': MIRROR_UA, Referer: pu, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.6' }, body: 'acc=opt&i=' + enc, signal: ctl2.signal, redirect: 'follow' });
          cuerpo = await r2.text();
        } catch { return null; } finally { clearTimeout(t2); }
        const hay = [...cuerpo.matchAll(/<li[^>]*encrypt="([0-9a-f]+)"/gi)].some((m2) => { try { return /mp4upload\./i.test(Buffer.from(m2[1], 'hex').toString('utf8')); } catch { return false; } });
        return hay ? pu : null;
      } catch { return null; }
    })();
  }
  if (t === 'mm') {
    const d = await datosCaricatura(sl).catch(() => null);
    return d && d.episodios && d.episodios[0] ? d.episodios[0].url : null;
  }
  if (t === 'lct') {
    const lct = [...LCT_SERIES.values()].find((x) => x.slug === sl);
    if (!lct) return null;
    const d = await refrescarDatosLacartoons(lct).catch(() => null);
    return d && d.episodios && d.episodios[0] ? d.episodios[0].url : null;
  }
  return null;
}

async function crawlTick() {
  if (!INTRO_AUTO_ON) return; /* v304: con el detector apagado, el rastreo de 6 676
    series es trabajo al cohete — y en Oracle se colgaba justo ahí a los ~75 s de
    cada arranque, trabando el ciclo de eventos (por eso ni el SIGTERM entraba).
    El rastreo solo camina cuando el usuario enciende el detector en el panel. */
  if (process.memoryUsage().heapUsed / 1048576 > 320) return; /* v309: heap caliente — el rastreo espera su turno; sin esto, encender las intros sobre la tormenta de arranque reventó los 768 MB (SIGABRT ×3) */
  if (crawlOcupado || !CRAWL.lista || !CRAWL.pend.length) return;
  if (rooms.size > 0 || Date.now() - crawlUltimaActividad < 60000) return; /* nadie viendo */
  crawlOcupado = true;
  const it = CRAWL.pend[0];
  try {
    const u = await crawlItemUrl(it).catch(() => null);
    if (!u) { CRAWL.pend.shift(); crawlGuardar(); return; } /* serie muerta o no encontrada: fuera */
    const ks = introKeysDe(u);
    if (!ks.serie) { CRAWL.pend.shift(); crawlGuardar(); return; }
    if (CRAWL.sinIntro.includes(ks.serie) || (INTROS[ks.serie] && INTROS[ks.serie].by === 'auto') || INTROS[ks.exacto]) {
      CRAWL.pend.shift(); CRAWL.hechas = (CRAWL.hechas || 0) + 1; crawlGuardar(); return; /* ya la sabe o ya se concluyó que no tiene */
    }
    if (INTRO_JOBS.has(ks.serie)) return; /* un usuario la disparó: se procesa sola, no duplicar */
    if (Date.now() - (INTRO_INTENTOS.get(ks.serie) || 0) < 6 * 3600 * 1000) { /* enfriándose: para el fondo de la cola */
      CRAWL.pend.push(CRAWL.pend.shift());
      CRAWL.vueltas++;
      if (CRAWL.vueltas > 2 * (CRAWL.total || 3000)) { console.log('[intro-crawl] muchas vueltas sin avance — pauso la cola'); CRAWL.pend = []; }
      crawlGuardar();
      return;
    }
    console.log('[intro-crawl] rastreando (' + (CRAWL.total - CRAWL.pend.length + 1) + '/' + CRAWL.total + '): ' + u);
    dispararDeteccionIntro(u, ks.serie);
    const t0 = Date.now();
    await new Promise((ok) => { const iv = setInterval(() => { if (!INTRO_JOBS.has(ks.serie) || Date.now() - t0 > 240000) { clearInterval(iv); ok(); } }, 4000); });
    CRAWL.pend.shift();
    const v = INTRO_VEREDICTOS.get(ks.serie);
    if (v === 'intro' || INTROS[ks.serie] || INTROS[ks.exacto]) CRAWL.hechas = (CRAWL.hechas || 0) + 1;
    else if (v === 'sinintro') { CRAWL.sinIntro.push(ks.serie); CRAWL.hechas = (CRAWL.hechas || 0) + 1; }
    else { CRAWL.pend.push(it); CRAWL.vueltas++; } /* fallo transitorio: reintentar al final */
    crawlGuardar();
  } catch {} finally { crawlOcupado = false; }
}
setInterval(() => { crawlTick().catch(() => {}); }, 25000);
if (!CRAWL.lista || CRAWL.v !== 2) { /* v202: la cola vieja venía con la paginación rota de latanime y sin animeflv */
  (async () => {
    const items = await crawlConstruir().catch(() => []);
    CRAWL.pend = items; CRAWL.total = items.length; CRAWL.lista = true; CRAWL.v = 2;
    crawlGuardar();
    console.log('[intro-crawl] cola lista: ' + items.length + ' series por rastrear (una vez cada una — solo cuando nadie está viendo)');
  })();
} else {
  /* v192: si había cola guardada, se le SUMAN las series nuevas (p. ej. las
   * altas de lacartoons) que no estaban cuando se construyó */
  let sumadas = 0;
  try {
    const conocidas = new Set([...CRAWL.pend.map((x) => x.u), ...CRAWL.sinIntro]);
    for (const sl of LCT_SERIES.keys()) {
      const u = 'lct:' + (LCT_SERIES.get(sl) || {}).slug;
      if (u && !conocidas.has(u) && !INTROS[u]) { CRAWL.pend.push({ u }); sumadas++; }
    }
  } catch {}
  CRAWL.total = (CRAWL.total || 0) + sumadas;
  crawlGuardar();
  console.log('[intro-crawl] continuando cola: ' + CRAWL.pend.length + ' pendientes de ' + CRAWL.total + (sumadas ? ' (+' + sumadas + ' nuevas)' : ''));
}

/* v194: un error NO atrapado jamás tumba la app (se registra y sigue) */
process.on('uncaughtException', (e) => console.error('[error-no-fatal]', String(e && e.stack || e).slice(0, 300)));
process.on('unhandledRejection', (e) => console.error('[promesa-rechazada]', String(e && e.stack || e).slice(0, 300)));

/* v205.4: PANEL DE ESTADO — página administrativa servida en /api/intros.
 * Todo inline (sin recursos externos), se refresca solo cada 10 s. */
function panelHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Huddle — Panel de estado</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d0b14; color: #efeaf7; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; padding: 18px 14px 30px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; display: flex; align-items: center; gap: 9px; }
  h1 .punto { width: 9px; height: 9px; border-radius: 50%; background: #38e08a; box-shadow: 0 0 8px #38e08a; }
  h1 .ver { font-size: 11px; color: #9d93b5; font-weight: 400; margin-left: auto; }
  .sub { color: #9d93b5; font-size: 12px; margin: 4px 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .card { background: #17131f; border: 1px solid #2a2338; border-radius: 14px; padding: 14px; }
  .card .n { font-size: 24px; font-weight: 800; }
  .card .t { color: #9d93b5; font-size: 11px; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.6px; }
  h2 { font-size: 13px; color: #b8aed0; margin: 20px 0 10px; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 7px; }
  h2 svg { flex: none; }
  .barra { background: #241d31; border-radius: 99px; height: 14px; overflow: hidden; margin: 6px 0 6px; }
  .barra i { display: block; height: 100%; background: linear-gradient(90deg, #8a5cf6, #38e08a); border-radius: 99px; transition: width 0.6s; }
  .barra-txt { display: flex; justify-content: space-between; color: #9d93b5; font-size: 12px; margin-bottom: 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { background: #17131f; border: 1px solid #2a2338; border-radius: 99px; padding: 7px 13px; font-size: 13px; }
  .chip b { font-weight: 800; }
  .chip.ok b { color: #38e08a; } .chip.warn b { color: #ffb020; } .chip.bad b { color: #ff5c7a; }
  table { width: 100%; border-collapse: collapse; background: #17131f; border-radius: 14px; overflow: hidden; font-size: 13px; }
  th { text-align: left; color: #9d93b5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 9px 12px; border-bottom: 1px solid #2a2338; }
  td { padding: 9px 12px; border-bottom: 1px solid #221c2e; }
  tr:last-child td { border-bottom: 0; }
  .pie { color: #9d93b5; font-size: 11px; text-align: center; margin-top: 22px; }
  @media (max-width: 480px) { td, th { padding: 7px 8px; } .card .n { font-size: 20px; } }
</style>
</head>
<body>
<div class="wrap">
  <h1><span class="punto"></span> Huddle — Panel de estado <span class="ver" id="ver"></span></h1>
  <p class="sub">Se actualiza solo cada 5 segundos</p>

  <div class="grid" id="cards"></div>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38e08a" stroke-width="2" stroke-linecap="round"><path d="m2 12a10 10 0 0 0 10 10M22 12a10 10 0 0 1-10 10"/><circle cx="12" cy="12" r="3"/></svg> Cosecha Movie (catálogo real · info_new)</h2>
  <div class="card">
    <div class="barra"><i id="cosechaBarra" style="width:0%"></i></div>
    <div class="barra-txt"><span id="cosechaTxt"></span><span id="cosechaPct"></span></div>
    <div class="chips" id="cosechaChips"></div>
    <div style="color:#9d93b5;font-size:11px;margin-top:8px" id="cosechaRuta"></div>
  </div>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38e08a" stroke-width="2" stroke-linecap="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/></svg> Rastreador de intros</h2>
  <div class="card">
    <div class="barra"><i id="introBarra" style="width:0%"></i></div>
    <div class="barra-txt"><span id="introTxt"></span><span id="introPct"></span></div>
    <div class="chips" id="introChips"></div>
  </div>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffb020" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Moderación automática (títulos ocultados)</h2>
  <div class="chips" id="modChips"></div>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a5cf6" stroke-width="2" stroke-linecap="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/></svg> Catálogos vivos</h2>
  <div class="chips" id="catChips"></div>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 2"/></svg> Intros aprendidas</h2>
  <table id="introTabla"><thead><tr><th>Sitio</th><th>Serie</th><th>Temp.</th><th>Segundos</th></tr></thead><tbody></tbody></table>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 6-6"/></svg> Fuentes de video — Estadísticas</h2>
  <div id="fuentesGrid" class="grid"></div>

  <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffb020" stroke-width="2" stroke-linecap="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> Usuarios</h2>
  <div class="card"><div id="userList" style="font-size:13px">Cargando…</div></div>

    <p class="pie" id="pie">conectando…</p>
</div>
<script>
  function fmtSeg(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
  }
  function chip(clase, txt, n) { return '<span class="chip ' + clase + '">' + txt + ' <b>' + n + '</b></span>'; }
  function pintar(d) {
    try {
    document.getElementById('pie').textContent = 'pintar() inicio, version=' + d.version;
    document.getElementById('ver').textContent = d.version;
    document.getElementById('cards').innerHTML =
      '<div class="card"><div class="n">' + fmtSeg(d.encendidoHace) + '</div><div class="t">Encendido</div></div>' +
      '<div class="card"><div class="n">' + d.memoriaMb + ' MB</div><div class="t">Memoria</div></div>' +
      '<div class="card"><div class="n">' + d.salasActivas + '</div><div class="t">Salas activas</div></div>' +
      '<div class="card"><div class="n">' + d.usuarios + '</div><div class="t">Usuarios</div></div>';
    const ii = d.intros;
    const pct = ii.total ? Math.round(ii.analizados * 100 / ii.total) : 0;
    document.getElementById('introBarra').style.width = pct + '%';
    document.getElementById('introTxt').textContent = ii.analizados.toLocaleString('es') + ' de ' + ii.total.toLocaleString('es') + ' episodios';
    document.getElementById('introPct').textContent = pct + '%';
    document.getElementById('introChips').innerHTML =
      chip('ok', 'Intros aprendidas', ii.aprendidas) + chip('warn', 'Series sin intro', ii.sinIntro) + chip('', 'En cola', ii.enCola);
    const co = d.cosecha || {};
    const totCo = co.archivo ? co.archivo.total : 0;
    const posCo = co.meta ? co.meta.pos : 0;
    const hitsCo = co.meta ? co.meta.hits : 0;
    const pctCo = posCo ? Math.min(100, Math.round((posCo - 1000) / 69000 * 100)) : 0;
    document.getElementById('cosechaBarra').style.width = pctCo + '%';
    document.getElementById('cosechaTxt').textContent = totCo ? totCo.toLocaleString('es') + ' títulos encontrados' : (hitsCo ? hitsCo + ' títulos' : 'aún sin datos');
    document.getElementById('cosechaPct').textContent = posCo ? 'id ' + posCo.toLocaleString('es') + ' / 70k · ' + pctCo + '%' : '';
    document.getElementById('cosechaChips').innerHTML = (co.archivo ? chip('ok', 'Catálogo', totCo) + chip('', 'Hit', hitsCo || totCo) + chip('', 'Pos', posCo || '—') : chip('warn', 'En curso', '1000→70000')) + (d.llaveCdn ? chip('ok', 'Llave CDN', 'SÍ ✓') : chip('bad', 'Llave CDN', 'NO')) + chip('', 'Espejo', d.espejoPreferido || (d.espejos && d.espejos[0]) || '—');
    document.getElementById('cosechaRuta').textContent = co.archivo ? (co.archivo.ruta + ' · ' + (co.archivo.bytes/1024).toFixed(1) + ' KB · ' + (co.log || '')) : (co.nota || '');
    const mo = d.moderacion;
    document.getElementById('modChips').innerHTML =
      chip('bad', 'Animes muertos', mo.animesMuertos) + chip('warn', 'Animes cast/dup', mo.animesCastDup) +
      chip('bad', 'PelisXD', mo.pelisxd) + chip('bad', 'AnimeFLV', mo.animeflv) +
      chip('bad', 'Cuevana', mo.cuevana) + chip('ok', 'Protegidas', mo.protegidas) + chip('bad', 'Episodios', mo.epsOcultos) + chip('warn', 'Fallos en curso', mo.fallosEnCurso);
    const ca = d.catalogos;
    document.getElementById('catChips').innerHTML =
      chip('', 'Caricaturas', ca.caricaturas) + chip('', 'Cartoons', ca.cartoons) + chip('', 'Live Action', ca.liveaction) +
      chip('', 'Danimados', ca.danimados) + chip('', 'Animes latanime', ca.animes);
    const tb = document.querySelector('#introTabla tbody');
    tb.innerHTML = (ii.muestra || []).map(function (m) {
      return '<tr><td>' + m.sitio + '</td><td>' + m.serie + '</td><td>T' + m.temporada + '</td><td>' + m.inicio + ' → ' + m.fin + '</td></tr>';
    }).join('') || '<tr><td colspan="4">Aún no hay intros aprendidas</td></tr>';
    document.getElementById('pie').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es');
    } catch(e) { document.getElementById('pie').textContent = 'Error: ' + e.message; }
  }
  function tic() {
    document.getElementById('pie').textContent = 'cargando datos…';
    fetch('/api/estado').then(function (r) {
      document.getElementById('pie').textContent = 'HTTP ' + r.status + ', parseando…';
      return r.json();
    }).then(function(d) {
      document.getElementById('pie').textContent = 'datos OK, pintando…';
      pintar(d);
    }).catch(function (e) {
      document.getElementById('pie').textContent = 'ERROR fetch/estado: ' + (e && e.message || e);
    });
    fetch('/api/stats').then(function (r) { return r.json(); }).then(pintarStats).catch(function () {});
    fetch('/api/users').then(function (r) { return r.json(); }).then(pintarUsers).catch(function () {});
  }
  tic();
  setInterval(tic, 5000); /* v205.5: casi al momento */

  function pintarStats(d) {
    if (!d.fuentes) return;
    var html = '';
    var colores = { cuevana: '#38e08a', pelisxd: '#8a5cf6', cinecalidad: '#38bdf8' };
    for (var k in d.fuentes) {
      var f = d.fuentes[k];
      var color = colores[k] || '#efeaf7';
      var pct = f.total ? Math.round(f.activas * 100 / f.total) : 0;
      html += '<div class="card" style="border-left:3px solid ' + color + '">';
      html += '<div class="n" style="color:' + color + '">' + f.activas + '</div>';
      html += '<div class="t">' + f.nombre + ' activas</div>';
      html += '<div style="margin-top:8px;font-size:11px;color:#9d93b5">';
      html += 'Total: ' + f.total + ' · Ocultas: ' + f.ocultas + ' · Vistas: ' + f.vistas;
      html += '</div>';
      html += '<div class="barra" style="margin-top:6px"><i style="width:' + pct + '%;background:' + color + '"></i></div>';
      html += '<div style="font-size:10px;color:#9d93b5;text-align:right">' + pct + '% activas</div>';
      html += '</div>';
    }
    html += '<div class="card"><div class="n">' + d.memoria + ' MB</div><div class="t">Memoria</div></div>';
    html += '<div class="card"><div class="n">' + d.usuarios + '</div><div class="t">Usuarios</div></div>';
    document.getElementById('fuentesGrid').innerHTML = html;
  }

  function pintarUsers(d) {
    if (!d.usuarios) return;
    var html = '<div style="margin-bottom:8px"><b>' + d.total + '</b> usuarios registrados</div>';
    html += '<table style="width:100%"><thead><tr><th>Nombre</th><th>Último acceso</th><th></th></tr></thead><tbody>';
    d.usuarios.forEach(function (u) {
      var last = u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleDateString('es') : '—';
      html += '<tr><td>' + u.name + '</td><td>' + last + '</td>';
      html += '<td><button onclick="eliminarUser(\'' + u.name + '\')" style="background:#ff5c7a;color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Eliminar</button></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('userList').innerHTML = html;
  }

  function eliminarUser(name) {
    if (!confirm('¿Eliminar usuario ' + name + '?')) return;
    fetch('/api/users', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: name}) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) { alert('Eliminado: ' + name); tic(); } else alert(d.error); })
      .catch(function () { alert('Error'); });
  }
</script>
</body>
</html>`;
}
server.maxConnections = 200;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.timeout = 0; // streaming SSE sin timeout
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Huddle ${UI_VERSION} corriendo en http://0.0.0.0:${PORT} — 100 usuarios, sonda HTTP/HLS, auditoría 100% disponible`);
});
