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
const UI_VERSION = 'v144'; // versión de la interfaz que sirve este servidor
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_USERS = 30;
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
  const p = resolverNativoInterno(url).finally(() => RESOLVIENDO.delete(k));
  RESOLVIENDO.set(k, p);
  return p;
}
/* v144: título legible de episodio: «Hora de aventura — T.1 EP.3» */
function tituloBonitoEp(titulo, num) {
  const t = String(titulo || '').trim().replace(/\s+/g, ' ');
  const s = String(num || '');
  let m = /(\d{1,2})x(\d{1,3})/.exec(s);
  if (m) return `${t} — T.${+m[1]} EP.${+m[2]}`.slice(0, 90);
  m = /episodio\s*(\d+)/i.exec(s);
  if (m) return `${t} — EP.${+m[1]}`.slice(0, 90);
  return `${t}${s ? ' — ' + s : ''}`.slice(0, 90);
}
/* v144: ¿qué episodio es esta URL? (de la ruta o del índice en la serie) */
function epNumDeUrl(url, sc) {
  const u = String(url || '');
  let m = /-(\d{2})x(\d{2})([ab])?(?:-|$)/i.exec(u);
  if (m) return +m[1] + 'x' + +m[2];
  m = /-episodio-(\d+)/i.exec(u);
  if (m) return '1x' + (+m[1]);
  try {
    const i = ((sc && sc.eps) || []).findIndex((e) => e.url === u);
    if (i >= 0) return '1x' + (i + 1);
  } catch {}
  return '';
}
async function resolverNativoInterno(url) {
  if (/latanime\.org\/ver\//i.test(url)) return resolverAnime(url);
  if (/pelisxd\.com\/pelicula\//i.test(url)) return resolverPelisxd(url); /* v98 */
  if (/miscaricaturas\.com\//i.test(url)) return resolverCaricatura(url); /* v102 */
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
const mirrors = new Map(); // roomCode -> mirror

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
    if (!epsL.length) return null;
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
    let m = /\/ver\/([a-z0-9-]+)-episodio-(\d+)/i.exec(url.pathname);
    if (m && host.endsWith('latanime.org')) {
      const d = await datosAnimeLatanime(m[1]);
      if (!d || !d.episodios || !d.episodios.length) return null;
      const idx = d.episodios.findIndex((e) => e.n === +m[2]);
      if (idx < 0) return null;
      return { tipo: 'latanime', titulo: d.titulo, poster: d.poster, idx, eps: d.episodios.map((e) => ({ url: e.url, num: 'Episodio ' + e.n })) };
    }
    m = /\/episode\/([a-z0-9-]+)-(\d+)x(\d+)/i.exec(url.pathname);
    if (m && /(cine-calidad\.mx|cuevana\.)$/.test(host)) {
      const d = await datosSerieCuevana(m[1]);
      if (!d || !d.episodios || !d.episodios.length) return null;
      const idx = d.episodios.findIndex((e) => e.temporada === +m[2] && e.ep === +m[3]);
      if (idx < 0) return null;
      return { tipo: 'cuevana', titulo: d.titulo, poster: d.poster, idx, eps: d.episodios.map((e) => ({ url: e.url, num: e.temporada + 'x' + e.ep })) };
    }
    /* v118: caricaturas de MisCaricaturas — el slug del episodio
     * («hora-de-aventura-01x02-…») se mapea a su serie y de ahí sale
     * la cadena completa (incluye lo fusionado de Lacartoons: Billy
     * T1-5, Ben 10 T3+) para los botones de siguiente/anterior. */
    if (host.endsWith('miscaricaturas.com')) {
      const slugEp = cariSlugDe(u);
      const mE = /^(.+)-(\d{2})x(\d{2})([ab])?(?:-|$)/.exec(slugEp);
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
    if (/miscaricaturas\.com$/.test(host)) {
      const base = cariSlugDe(url).replace(/-\d{2}x\d{2}[ab]?(-.*)?$/, '');
      if (base) serie = 'mm:' + base;
    } else if (/lacartoons\.com$/.test(host)) {
      const capId = +((/\/serie\/capitulo\/(\d+)/.exec(new URL(url).pathname) || [])[1] || 0);
      const slug = capId ? lctSerieDeCap(capId) : '';
      if (slug) serie = 'lct:' + slug;
    } else if (/latanime\.org$/.test(host)) {
      const m = /\/ver\/([a-z0-9-]+)-episodio-\d+/.exec(new URL(url).pathname);
      if (m) serie = 'la:' + m[1];
    } else if (/animeflv\./.test(host)) {
      const m = /\/ver\/([a-z0-9-]+)-episodio-\d+/.exec(new URL(url).pathname);
      if (m) serie = 'af:' + m[1];
    } else if (/(cine-calidad\.mx|cuevana\.)/.test(host)) {
      const m = /\/episode\/([a-z0-9-]+)-\d+x\d+/.exec(new URL(url).pathname);
      if (m) serie = 'cv:' + m[1];
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
    execFile('fpcalc', ['-raw', '-length', String(segs || 280), '-json', archivo], { timeout: 50000, maxBuffer: 8e6 }, (err, so) => {
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
      /* mp4/webm directo — solo el primer cacho */
      const r2 = await pedir(pl, 60000, 'bytes=0-36700160');
      if (!r2) return null;
      const ab = await r2.arrayBuffer();
      if (!ab || ab.byteLength < 3e5) return null;
      fs.writeFileSync(archivo, Buffer.from(ab));
      return archivo;
    }
    const segs = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((s) => { try { return new URL(s, pl).href; } catch { return null; } }).filter(Boolean).slice(0, 70);
    if (!segs.length) return null;
    const out = fs.createWriteStream(archivo);
    let bytes = 0;
    for (const s of segs) {
      const r2 = await pedir(s, 20000);
      if (!r2) break;
      const ab = await r2.arrayBuffer();
      if (!ab || !ab.byteLength) break;
      bytes += ab.byteLength;
      out.write(Buffer.from(ab));
      if (bytes > 45e6) break;
    }
    await new Promise((r3) => out.end(r3));
    if (bytes < 3e5) { try { fs.unlinkSync(archivo); } catch {} return null; }
    return archivo;
  }
  return null;
}
const INTRO_JOBS = new Set(), INTRO_INTENTOS = new Map();
/* v137: penalización por resultado — fallo de infra (navegador ocupado, red)
 * retrasa el reintento solo 15 min; «no hay intro común» sí espera 6h */
function penalizarIntro(serieKey, ms) {
  INTRO_INTENTOS.set(serieKey, Date.now() + 6 * 3600 * 1000 - ms);
}
async function detectarIntroSerie(serieKey, urls) {
  /* v134: correr también cuando lo guardado es aprendido-a-mano (pudo salir de
   * un clic equivocado) — la huella de audio es la prueba fuerte; lo único que
   * NO se re-analiza es lo que ya vino de la huella misma */
  if (!fpcalcOk() || !serieKey || (INTROS[serieKey] && INTROS[serieKey].by === 'auto') || INTRO_JOBS.has(serieKey)) return;
  if (Date.now() - (INTRO_INTENTOS.get(serieKey) || 0) < 6 * 3600 * 1000) return;
  INTRO_JOBS.add(serieKey);
  console.log('[intro] detectando intro de ' + serieKey + ' (comparando el audio de 2 episodios)…');
  try {
    const listos = [];
    for (const u of urls.slice(0, 3)) {
      try {
        const r = await resolverNativo(u);
        if (r && r.m3u8) listos.push(r.m3u8.startsWith('/') ? 'http://127.0.0.1:' + PORT + r.m3u8 : r.m3u8); /* el proxy propio (/api/xd) sirve el playlist con los headers correctos */
      } catch (e) { console.log('[intro] un episodio no se dejó resolver: ' + String(e && e.message || e).slice(0, 90)); }
      if (listos.length >= 2) break;
    }
    if (listos.length < 2) { penalizarIntro(serieKey, 15 * 60 * 1000); return console.log('[intro] no pude resolver 2 episodios de ' + serieKey + ' — reintento en 15 min'); }
    const f0 = await descargarInicioEp(listos[0]);
    const f1 = f0 && await descargarInicioEp(listos[1]);
    if (!f0 || !f1) { penalizarIntro(serieKey, 15 * 60 * 1000); return console.log('[intro] descargas incompletas para ' + serieKey + ' — reintento en 15 min'); }
    try {
      const [ha, hb] = await Promise.all([fpcalcArchivo(f0), fpcalcArchivo(f1)]);
      if (ha && hb && ha.length > 130 && hb.length > 130) {
        const hit = compararHuellas(ha, hb);
        if (hit && hit.dur >= 45 && hit.fin <= 420 && hit.ini <= 240) {
          const finSeg = Math.max(Math.round(hit.fin) - 2, Math.round(hit.ini) + 30); /* 2s antes: jamás comerse contenido */
          const iniSeg = Math.round(hit.ini);
          const anterior = INTROS[serieKey];
          if (anterior && anterior.by === 'manual' && Math.abs(anterior.start - iniSeg) <= 20 && Math.abs(anterior.end - finSeg) <= 20) {
            console.log(`[intro] ${serieKey}: la huella CONFIRMA la intro aprendida a mano (${iniSeg}→${finSeg}s) — se respeta lo aprendido`);
          } else {
            INTROS[serieKey] = { start: iniSeg, end: finSeg, by: 'auto', at: Date.now() };
            penalizarIntro(serieKey, 6 * 3600 * 1000);
            guardarIntros();
            if (anterior && anterior.by === 'manual') console.log(`[intro] ✅ ${serieKey}: la huella CORRIGE la aprendida a mano (estaba ${anterior.start}→${anterior.end}s, verdad del audio: ${iniSeg}→${finSeg}s)`);
            else console.log(`[intro] ✅ ${serieKey}: intro detectada ${iniSeg}s→${finSeg}s`);
          }
        } else {
          penalizarIntro(serieKey, 6 * 3600 * 1000); /* conclusión real: sin intro común — 6h */
          console.log(`[intro] ${serieKey}: los episodios no comparten intro al inicio — no se guarda nada`);
        }
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
    if (urls.length < 2) return;
    const ks = introKeysDe(urls[0]);
    if (!ks.serie || (INTROS[ks.serie] && INTROS[ks.serie].by === 'auto')) return;
    if (!fpcalcOk() || INTRO_JOBS.has(ks.serie)) return;
    if (Date.now() - (INTRO_INTENTOS.get(ks.serie) || 0) < 6 * 3600 * 1000) return;
    detectarIntroSerie(ks.serie, urls.slice(0, 3));
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

async function startMirror(room, rawUrl, userId) {
  const url = normalizeWebUrl(rawUrl);
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
  const browser = await PUPPETEER.launch({
    headless: !useXvfb,
    // CHROME_PATH (opcional): usar un Chromium del sistema, p.ej. en ARM
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
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

  const m = { browser, page, cdp, url, frame: null, dirty: false, timer: null, emptySince: null, ownerId: userId, startedAt: Date.now(), serie: null };
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
  const esPagCine = () => /\/(wp-)?pelicula\/[a-z0-9-]+|\/episode\/|\/ver\//i.test(m.url || '');
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
    if (videoListo && !m.ready) {
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
    /* v25: si la página murió, reabrir sola (sin esperar que un clic falle) */
    if (m.page.isClosed()) { recoverMirror(room.code, 'página cerrada (watchdog)').catch(() => {}); return; }
    if (m.dirty && m.frame) {
      m.dirty = false;
      broadcast(room, 'mirror-frame', m.frame);
      m.stats.frames++;
      m.stats.bytes += Math.floor(m.frame.d.length * 0.75);
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
        const urlNat = String(action.url || '').trim();
        if (/^https?:\/\//i.test(urlNat)) {
          let errNat = '';
          const nat = await resolverNativo(urlNat).catch((e) => {
            errNat = String(e.message || e).slice(0, 140);
            console.log('[sala] nativo no pudo (' + errNat.slice(0, 60) + ')');
            return null;
          });
          if (nat) {
            if (mirrors.has(room.code)) stopMirror(room).catch(() => {});
            room.videoUrl = urlNat; programarPrefetchEp(room);
            room.videoTitle = String(action.title || guessTitle(urlNat)).slice(0, 80);
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
              return json(res, 200, { ok: false, error: /reintenta/i.test(errN) ? errN : errN + ' — reintenta' });
            }
            console.log('[sala] episodio caído (' + cand.num + '), sigo al próximo');
            saltados.push(cand.num);
          }
          if (!elegido) {
            return json(res, 200, { ok: false, error: errN || 'No pude resolver el episodio siguiente — prueba del selector' });
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
        await stopMirror(room);
        await startMirror(room, target.url, userId);
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
  /* v65: Latanime primero (predeterminado) — v68: fuera GoPelis y AnimeFLV
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
      /* v68/v70: fuera GoPelis y AnimeD23 — v97: AnimeFLV REGRESA
       * (trae mp4upload entre sus servidores y sirve de respaldo) */
      const antes = l.length;
      l = l.filter((s) => !/gopelis\.|animed23\./i.test(s.url || ''));
      if (l.length !== antes) { cambio = true; console.log('[sitios] - GoPelis y AnimeD23'); }
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
async function fetchSeguro(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, {
      signal: c.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' },
    });
  } finally { clearTimeout(t); }
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

/* v45: búsqueda en las páginas del directorio — v46: Cuevana y GoPelis por sus
 * APIs internas (con póster); resultados listos para crear la sala */
async function buscarCuevana(q) {
  const r = await fetchSeguro(`https://cine-calidad.mx/wp-json/mycustom/v1/search/?s=${encodeURIComponent(q)}&page=1`, 9000);
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return (d.posts || []).slice(0, 12).map((p) => ({
    title: String(p.title || ''),
    url: (p.type === 'movies') ? `https://cine-calidad.mx/pelicula/${p.slug}/` : `https://cine-calidad.mx/serie/${p.slug}`, /* v87: cuevana.mov ya responde 404 — las pelis viven en cine-calidad */
    img: String(p.featured_image || '').replace('/w780/', '/w342/'),
    site: 'Cuevana',
    extra: [p.year, p.duration ? `${p.duration} min` : ''].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.url);
}

/* v70: fuera las búsquedas de GoPelis y AnimeFLV (código retirado) */
const metaCache = new Map();
const serieCache = new Map();
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
    } else if (/gopelis\./.test(dom)) {
      try {
        const r = await fetchSeguro(`https://gopelis.com/api/search?q=${encodeURIComponent(slug.replace(/-/g, ' '))}`, 8000);
        if (r.ok) {
          const dd = await r.json().catch(() => ({}));
          const p = (dd.results || []).find((x) => x.slug === slug) || (dd.results || [])[0];
          if (p) d = { title: p.title, poster: p.posterPath ? `https://image.tmdb.org/t/p/w342${p.posterPath}` : '' };
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
    site: 'Cuevana',
    extra: [p.year, p.duration ? `${p.duration} min` : ''].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.url);
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
    site: 'Cuevana',
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
  /* rotación diaria determinista: 6 géneros barajados por la fecha —
   * mañana el feed se ve distinto sin tocar nada */
  const dia = Math.floor(Date.now() / 864e5);
  return GENEROS_ES
    .map((g, i) => ({ g, k: ((i * 2654435761 + dia * 40503) >>> 0) % 9973 }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 6)
    .map((x) => x.g);
}
async function peliculasPorGenero(slug) {
  const c = generosCache.get(slug);
  if (c && Date.now() - c.at < 60 * 60 * 1000 && c.items.length) return c.items;
  const r = await fetchSeguro(`https://cine-calidad.mx/wp-json/mycustom/v1/list-posts?category=${slug}&page=1`, 10000);
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  const items = (d.posts || []).slice(0, 18).map((p) => ({
    title: String(p.title || ''),
    url: p.type === 'serie' ? `https://cine-calidad.mx/serie/${p.slug}` : `https://cine-calidad.mx/pelicula/${p.slug}/`,
    img: String(p.featured_image || '').replace('/w780/', '/w342/'),
    site: 'Cuevana',
    extra: [
      String(p.date || '').slice(0, 4),
      p.rating ? `★ ${(+p.rating).toFixed(1)}` : '',
    ].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.img);
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
      return { title: title || slug, poster: og('og:image') || '', year, alive: />Opción 1<\/button>/.test(html) };
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
    .filter((x) => x.m && x.m.alive)
    .slice(0, 6)
    .map((x) => ({
      title: x.m.title,
      url: 'https://www.pelisxd.com/pelicula/' + x.c.s,
      img: x.m.poster,
      site: 'PelisXD',
      extra: [x.m.year, 'HD'].filter(Boolean).join(' · '),
    }));
}

/* v98: abre la peli en un navegador del servidor, clic en "Opción 1",
 * insiste en darle play (el gate de captcha se abre solo) y captura el
 * CUERPO del playlist variante que pide el player. Verificado con pelis
 * de duración completa (113.6, 113.8 y 101.3 min — nada de teasers). */
async function extraerStreamwishPeli(pageUrl) {
  if (!PUPPETEER) { try { PUPPETEER = require('puppeteer'); } catch { throw new Error('El navegador del servidor no está disponible'); } }
  const browser = await PUPPETEER.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  }).catch(() => null);
  if (!browser) throw new Error('No pude abrir el navegador del servidor');
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(MIRROR_UA).catch(() => {});
    await page.evaluateOnNewDocument(() => {
      try { window.open = function () { return null; }; } catch {}
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    });
    let cap = null;
    page.on('response', async (r) => {
      try {
        const u = r.url();
        /* v106: también cfglobalcdn — los episodios detrás del reproductor
         * propio del sitio (player.miscaricaturas.com) usan ese CDN */
        if (cap || !/\.m3u8(\?|$)/i.test(u) || !/hls2|sprintcdn|cfglobalcdn/i.test(u)) return;
        const body = await r.text();
        if (/#EXTINF/.test(body) && /\.ts/i.test(body)) {
          cap = { body, url: u, ref: (r.request().headers() || {}).referer || '' };
        }
      } catch {}
    });
    page.on('dialog', async (d) => { try { await d.dismiss(); } catch {} });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r2) => setTimeout(r2, 4000));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /opción 1/i.test(x.textContent || ''));
      if (b) b.click();
    }).catch(() => {});
    /* hasta ~60 s: el challenge se resuelve solo mientras el player cree que hay un usuario */
    for (let i = 0; i < 20 && !cap; i++) {
      await new Promise((r2) => setTimeout(r2, 3000));
      for (const fr of page.frames()) {
        const fu = fr.url();
        if (/pelisxd\.|facebook\.|google\.|^about:/i.test(fu)) continue;
        try {
          await fr.evaluate(() => {
            const b = document.querySelector('.captcha-gate__play, .jw-icon-display, button[class*="play"], [class*="play"] button');
            if (b) b.click();
            const v = document.querySelector('video');
            if (v) { v.muted = true; v.play().catch(() => {}); }
          });
        } catch {}
      }
    }
    if (!cap) throw new Error('El servidor de la peli no entregó el video (intenté con el navegador)');
    return cap;
  } finally {
    try { await browser.close(); } catch {}
  }
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
  if (m && !m.alive) throw new Error('Esta peli tiene los enlaces caídos en PelisXD');
  /* 2) el navegador resuelve el challenge y captura el playlist (~20 s la primera vez) */
  const cap = await extraerStreamwishPeli('https://www.pelisxd.com/pelicula/' + slug);
  const tok = Math.random().toString(36).slice(2, 10) + ahora.toString(36);
  pelisxdStreams.set(tok, { body: cap.body, base: cap.url, ref: cap.ref || 'https://f7hyg4q.org/', slug, at: ahora });
  /* los segmentos pasan por el proxy con el Referer del espejo que sirvió */
  try {
    hlsReferers.set(new URL(cap.url).hostname, cap.ref || 'https://f7hyg4q.org/'); /* v106: host del playlist (segmentos relativos) */
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
const cariFeedCache = { at: 0, items: [], toons: [] }; /* 1 h — v119: items=MisCaricaturas, toons=Lacartoons (Cartoons) */
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
  for (const [k, v] of cacheLeer('postersSeries') || []) postersSeries.set(k, v);
  const ch = cacheLeer('cariHome');
  if (ch && ch.at) { cariHome.at = ch.at; for (const [k, v] of (ch.items || [])) cariHome.items.set(k, v); }
  const cf = cacheLeer('cariFeed');
  if (cf && cf.at) { cariFeedCache.at = cf.at; cariFeedCache.items = Array.isArray(cf.items) ? cf.items : []; cariFeedCache.toons = Array.isArray(cf.toons) ? cf.toons : []; }
  const nCari = cariDatos.size, nSerie = serieCache.size;
  if (nCari || nSerie) console.log('[cache] del disco: ' + nCari + ' caricaturas, ' + nSerie + ' series/animes, ' + cariMeta.size + ' metas' + (cariFeedCache.items.length ? ', feed listo' : ''));
} catch {}
function cariSlugDe(u) { return ((/miscaricaturas\.com\/([a-z0-9-]+)/i.exec(u || '') || [])[1] || '').toLowerCase(); }
function cariEsSerie(slug) { return !!slug && !/temporada/i.test(slug) && !/\d{2}x\d{2}/i.test(slug); }
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
      if (!cariEsSerie(slug) || vistos.has(slug)) continue;
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
  'gallo-claudio-capitulos-completos', 'la-vaca-y-el-pollito-capitulos-completos', 'los-chicos-del-barrio-capitulos-completos',
  'megas-xlr-capitulos-completos', 'monstruos-de-verdad-latino', 'soy-la-comadreja-latino',
];
async function caricaturasDestacadas() {
  const listo = () => ({ caricaturas: cariFeedCache.items, cartoons: cariFeedCache.toons });
  if (Date.now() - cariFeedCache.at < 60 * 60 * 1000 && (cariFeedCache.items.length || cariFeedCache.toons.length)) return listo();
  if (cariFeedCache.items.length || cariFeedCache.toons.length) { refrescarCariFeed().catch(() => {}); return listo(); } /* v111: vencido → se sirve y se refresca por detrás */
  return await refrescarCariFeed();
}
async function refrescarCariFeed() {
  const home = await cariHomeImgs();
  if (!home.size) return cariFeedCache.items;
  const enHome = [...home.keys()];
  const slugs = [
    ...CARI_ORDEN.filter((s) => home.has(s)),
    ...enHome.filter((s) => !CARI_ORDEN.includes(s) && cariEsSerie(s)),
  ].slice(0, 18); /* v107: 18 — entran Sabrina y Kenan y Kel */
  if (!slugs.length) return cariFeedCache.items;
  const items = (await Promise.all(slugs.map(async (slug) => {
    const meta = await cariMetaDe(slug).catch(() => null);
    const h = home.get(slug) || {};
    const img = (meta && (meta.cover || meta.poster)) || h.img || '';
    return {
      title: (meta && meta.titulo) || cariLimpia(h.alt || cariBonito(slug)),
      url: CARI_BASE + slug + '/', img, site: 'Caricaturas',
    };
  }))).filter((x) => x.title && x.img);
  /* v119: apartado propio — las de LACARTOONS ya no se mezclan con las
   * de MisCaricaturas: van a "Cartoons". Son ~79 series, así que se bajan
   * en bloques de 16 en vez de todas a la vez (que no nos racione el
   * sitio por ráfaga); el arranque en frío tarda unos segundos más pero
   * queda en cache 1 h y después se sirve al instante. */
  const lctLista = [...LCT_SERIES.values()];
  const toons = [];
  for (let i = 0; i < lctLista.length; i += 16) {
    const parte = await Promise.all(lctLista.slice(i, i + 16).map(async (lct) => {
      try {
        const d = await datosCaricatura(String(lct.lctId));
        if (d && d.poster && d.episodios && d.episodios.length) {
          return { title: d.titulo, url: LCT_BASE + 'serie/' + lct.lctId, img: d.cover || d.poster, site: 'Cartoons' }; /* v120: portada de IMDb primero */
        }
      } catch {}
      return null;
    }));
    for (const it of parte) if (it) toons.push(it);
  }
  if (items.length || toons.length) {
    cariFeedCache.at = Date.now();
    cariFeedCache.items = items;
    cariFeedCache.toons = toons;
    cacheGuardar('cariFeed', () => ({ at: cariFeedCache.at, items: cariFeedCache.items, toons: cariFeedCache.toons }));
  } /* v111: a disco */
  return { caricaturas: items, cartoons: toons };
}

/* episodios de una caricatura — la tabla de la página de la serie.
 * v103: las temporadas viejas viven en posts aparte («serie-temporada-N»)
 * enlazados desde la propia página — se bajan EN PARALELO y se fusionan
 * (Bob Esponja pasa de 4 temporadas a las ~13 de verdad) */
async function cariEpsDeHtml(html) {
  const eps = [];
  const vistosEp = new Set();
  for (const m of html.matchAll(/<a href="(https:\/\/miscaricaturas\.com\/([a-z0-9-]+?)-(\d{2})x(\d{2})([ab])?(?:-[a-z0-9-]*)?\/?)"[^>]*>\s*([^<]+?)\s*<\/a>/gi)) {
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
    return out;
  } catch { return null; }
}

/* capítulo → playlist: mismo navegador del servidor que PelisXD (el
 * embed es de la misma familia streamwish y sirve sprintcdn) */
async function resolverCaricatura(epUrl) {
  const slug = cariSlugDe(epUrl);
  if (!slug) throw new Error('Capítulo de caricatura no válido');
  /* v109/v110: capítulos o temporadas ocultas por estar solo en inglés — mensaje claro */
  {
    const mE = /^([a-z0-9-]+?)-(\d{2})x(\d{2})([ab])?(?:-|$)/i.exec(slug);
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
    cap = await extraerStreamwishPeli(CARI_BASE + slug + '/');
  } catch (e) {
    try {
      const rPre = await fetchSeguro(CARI_BASE + slug + '/', 8000);
      if (rPre && rPre.ok && /<iframe[^>]+src="https?:\/\/[^"]*mega\.nz/i.test(await rPre.text())) {
        throw new Error('Ese capítulo solo está en MEGA — prueba otro capítulo');
      }
    } catch (e2) { if (/MEGA/.test(String(e2.message))) throw e2; }
    throw e;
  }
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

/* v112: LACARTOONS — capítulo → playlist. El player cubeembed.rpmvid
 * guarda el m3u8 detrás de una API cifrada que solo él sabe descifrar:
 * el navegador del servidor abre el capítulo, CLICA el play (botón en
 * shadow DOM de vidstack + clic físico sobre el iframe, que los clics
 * sintéticos no le bastan) y captura el master «hlsmod». Los segmentos
 * son TS camuflados de PNG en tiktokcdn — el proxy /api/hls los
 * despelleja al servirlos. */
async function extraerRpmvid(pageUrl) {
  if (!PUPPETEER) { try { PUPPETEER = require('puppeteer'); } catch { throw new Error('El navegador del servidor no está disponible'); } }
  const browser = await PUPPETEER.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  }).catch(() => null);
  if (!browser) throw new Error('No pude abrir el navegador del servidor');
  try {
    const page = await browser.newPage();
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
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
  } finally { try { await browser.close(); } catch {} }
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

async function buscarEnSitios(q) {
  const nq = normalizarTxt(q);
  const [cuevana, latanime, animeflv, pelisxd, cari, catalogo] = await Promise.all([
    buscarCuevana(q).catch(() => []),
    buscarLatanime(q).catch(() => []),
    buscarAnimeflv(q).catch(() => []), /* v97 */
    buscarPelisxd(q).catch(() => []), /* v98: el catálogo grande de pelis */
    buscarMiscaricaturas(q).catch(() => []), /* v102: caricaturas nick/CN */
    catalogoLocal().catch(() => []), /* v121 */
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
    return { title: r.title, url: r.url, img: r.img || '', site: r.site, extra: r.extra || '', _score: similitud(nq, normalizarTxt(r.title)) };
  }).filter(Boolean);
  const lctHits = puntuar(catalogo.filter((x) => x.site === 'Cartoons')).filter((r) => r._score >= 0.5);
  const todos = [
    ...lctHits,
    ...puntuar(cuevana),
    ...puntuar(pelisxd),
    ...puntuar(latanime),
    ...puntuar(animeflv),
    ...puntuar(cari),
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
    try { return await resolverGoodstream(embed, pageUrl); }
    catch (e) { err = e; }
  }
  if (embedVimeos) {
    try { return await resolverVimeos(embedVimeos, pageUrl); }
    catch (e) { console.warn('[solo] vimeos también falló:', String(e.message || e).slice(0, 80)); }
  }
  throw err || new Error('Este título no tiene servidor goodstream — se ve en modo sala (👥 Juntos)');
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
      const em = await fetchTexto(embed, pageUrl);
      const files = [...em.matchAll(/file\s*:\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
      const m3u8 = files.find((f) => /\.m3u8/i.test(f));
      if (!m3u8) return null; /* cuerpo racionado (v93) */
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3500);
      let sirve = false;
      try {
        const r = await fetch(m3u8, { headers: { 'User-Agent': MIRROR_UA, Referer: embed, Range: 'bytes=0-1024' }, signal: ctl.signal, redirect: 'follow' });
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
  const candidatos = [...new Set(embeds.filter((u) => /mp4upload\./i.test(u)))];
  if (!candidatos.length) throw new Error('Este episodio no tiene servidor mp4upload — se ve en modo sala (👥 Juntos)');
  const directo = await extraerMp4(candidatos, epUrl);
  if (directo) return directo;
  /* v93: mp4upload agotado (borrado, como le pasó a Evangelion) → que
   * el navegador del servidor lo resuelva UNA vez y todos lo ven nativo */
  const nat = await resolverAnimePorNavegador(epUrl).catch(() => null);
  if (nat) return nat;
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
  const candidatos = [...new Set(embeds.filter((u) => /mp4upload\./i.test(u)))];
  if (!candidatos.length) throw new Error('Este episodio no tiene servidor mp4upload en AnimeFLV — sus otros servidores no se dejen extraer');
  const directo = await extraerMp4(candidatos, epUrl);
  if (directo) return directo;
  throw new Error('Los servidores mp4upload de este episodio están caídos en AnimeFLV — prueba otra versión del anime o más tarde');
}
/* v93: el navegador del servidor abre el episodio, deja que su
 * reproductor cargue el video, lee la URL que pidió y cierra. El
 * usuario después lo reproduce NATIVO (hls.js/video), como cualquier
 * peli — el navegador solo sirvió para DESCUBRIR la URL. */
async function resolverAnimePorNavegador(epUrl) {
  if (!PUPPETEER) { try { PUPPETEER = require('puppeteer'); } catch { return null; } }
  const browser = await PUPPETEER.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  }).catch(() => null);
  if (!browser) return null;
  try {
    const page = await browser.newPage();
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
    const links = await page.evaluate(() => {
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
  finally { try { await browser.close(); } catch {} }
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
      || /(^|\.)okcdn\.ru$/i.test(h) /* v119: videos MP4 de ok.ru (Lacartoons) */
      || hlsReferers.has(h); /* v93: hosts que ya resolvimos (con su Referer) */
  } catch { return false; }
}
/* v83: reescribe un m3u8 para que todo pase por el proxy */
function servirPlaylist(res, codigo, txt, target) {
  const esLocal = /^\/test-media\//.test(target);
  const baseLocal = target.slice(0, target.lastIndexOf('/') + 1);
  const prox = (u) => {
    if (/^\/[^/]/.test(u)) return '/api/hls?u=' + encodeURIComponent(u); /* v83: stream local de prueba */
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
  if (!esProxeable(target)) return json(res, 403, { ok: false, error: 'No permitido' }); /* v90: allowlist ampliada */
  /* el origen de goodstream a veces suelta 403 transitorios (cache-miss):
   * reintentamos un par de veces antes de rendirnos */
  let ref = 'https://goodstream.one/';
  try { ref = hlsReferers.get(new URL(target).hostname) || ref; } catch {}
  /* v90: el mp4 de animes se adelanta/atrás por rangos — los pasamos */
  const cabUp = {
    'User-Agent': MIRROR_UA,
    Referer: ref,
    'Accept-Language': 'es-MX,es;q=0.9,en;q=0.6', /* igual que fetchTexto: hls1 amarra el token al fingerprint */
  };
  if (req.headers.range) cabUp.Range = String(req.headers.range);
  let upstream = null;
  for (let intento = 0; intento < 3; intento++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      upstream = await fetch(target, {
        headers: cabUp,
        signal: ctl.signal, redirect: 'follow',
      });
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
      upstream = null;
      if (intento === 2) return json(res, 502, { ok: false, error: 'El servidor de video no respondió' });
      await new Promise((r2) => setTimeout(r2, 1500 * (intento + 1)));
    }
  }
  if (!upstream) {
    console.warn('[hls-proxy] me rendí tras reintentos:', decodeURIComponent(target).slice(0, 90));
    return json(res, 502, { ok: false, error: 'El servidor de video no respondió' });
  }
  if (!upstream.ok && upstream.status !== 404) {
    console.warn('[hls-proxy] estado ' + upstream.status + ':', decodeURIComponent(target).slice(0, 90));
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

const imgProxyCache = new Map(); /* v67: imágenes de animes proxyadas, url → {buf, ct, at} */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
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
      /* v55: populares del día + v57: series recién agregadas
       * v101: + 6 filas de género que rotan cada día
       * v102: + caricaturas (debajo de los animes) */
      const [day, series, animes, generos, cari] = await Promise.all([
        popularesDeHoy().catch(() => []),
        seriesRecientes().catch(() => []),
        animesDelMomento().catch(() => []), /* v67: animes del momento (Latanime) */
        Promise.all(generosDelDia().map(([slug, nombre]) =>
          peliculasPorGenero(slug)
            .then((items) => ({ slug, nombre, items }))
            .catch(() => ({ slug, nombre, items: [] }))
        )),
        caricaturasDestacadas().catch(() => ({ caricaturas: [], cartoons: [] })),
      ]);
      return json(res, 200, {
        ok: true, results: day, series, animes,
        caricaturas: cari.caricaturas || [],
        cartoons: cari.cartoons || [], /* v119: apartado propio de Lacartoons */
        generos: (generos || []).filter((g) => g.items && g.items.length),
      });
    }
    if (url.pathname.startsWith('/api/caricaturas/')) {
      /* v102: episodios de una caricatura (para el selector) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug) && !/^[0-9]{1,3}$/.test(slug)) return json(res, 400, { ok: false, error: 'Caricatura inválida' }); /* v119: ids de lacartoons de 1 dígito */
      const d = await datosCaricatura(slug);
      if (!d) return json(res, 502, { ok: false, error: 'No pude leer esa caricatura' });
      precargarIntroDeSerie(d.episodios); /* v135 */
      return json(res, 200, d);
    }
    if (url.pathname.startsWith('/api/serie/')) {
      /* v61: temporadas y episodios de una serie (para elegirla bonito) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Serie inválida' });
      const dS = await datosSerieCuevana(slug); /* v74: compartida con los botones de episodio */
      if (!dS) return json(res, 502, { ok: false, error: 'No pude leer la serie' });
      precargarIntroDeSerie(dS.episodios); /* v135 */
      return json(res, 200, dS);
    }
    if (url.pathname.startsWith('/api/anime/')) {
      /* v62: episodios de un anime — AnimeFLV (var eps) y v63: Latanime (enlaces /ver/) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Anime inválido' });
      if ((url.searchParams.get('site') || '').toLowerCase() === 'latanime') {
        const dL = await datosAnimeLatanime(slug); /* v74: compartida con los botones de episodio */
        if (!dL) return json(res, 502, { ok: false, error: 'No pude leer el anime' });
        precargarIntroDeSerie(dL.episodios); /* v135 */
        return json(res, 200, dL);
      }
      const c = serieCache.get('anime:' + slug);
      if (c && Date.now() - c.at < 30 * 60 * 1000) return json(res, 200, c.d);
      try {
        const r = await fetchSeguro(`https://vww.animeflv.one/anime/${slug}`, 10000);
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
        if (!eps.length) return json(res, 404, { ok: false, error: 'Sin episodios' });
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
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) return json(res, 400, { ok: false, error: 'Escribe qué quieren ver' });
      const r = await buscarEnSitios(q); /* v121: global + fuzzy + sugiere */
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
      const items = (continuar.get(name.toLowerCase()) || []).map((e) => ({
        url: e.url, t: e.t, d: e.d, title: e.title, img: e.img, ep: e.ep, serie: e.serie, ts: e.ts, modo: e.modo || '',
        eps: Array.isArray(e.eps) ? e.eps : [], /* v86: para "Sigue con el próximo" */
      }));
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
      /* v81: resolver el video directo de una página para modo individual */
      const name = (url.searchParams.get('name') || '').trim();
      const tok = url.searchParams.get('tok') || '';
      const urec = users.get(name.toLowerCase());
      if (!name || !urec || urec.token !== tok) return json(res, 403, { ok: false, error: 'Perfil no válido' });
      const target = url.searchParams.get('url') || '';
      if (!/^https?:\/\/[a-z0-9.-]+/i.test(target)) return json(res, 400, { ok: false, error: 'URL no válida' });
      try {
        /* v90: episodio de Latanime → resolver de animes (mp4 directo) */
        const esEpAnime = /latanime\.org\/ver\/|animeflv\.one\/ver\//i.test(target); /* v97: también AnimeFLV */
        const esPeliXd = /pelisxd\.com\/pelicula\//i.test(target); /* v98 */
        const esCari = /miscaricaturas\.com\//i.test(target); /* v102: caricaturas */
        const esLct = /lacartoons\.com\/serie\/capitulo\//i.test(target); /* v112: lacartoons */
        const r = await (esEpAnime ? resolverAnime(target) : esPeliXd ? resolverPelisxd(target) : esCari ? resolverCaricatura(target) : esLct ? resolverLacartoons(target) : resolverSolo(target));
        return json(res, 200, { ok: true, m3u8: r.m3u8, subs: r.subs, mp4: !!r.mp4, proxy: !!r.proxy });
      } catch (e) {
        console.warn('[solo] no pude resolver', target.slice(0, 70), '→', String(e.message || e).slice(0, 90));
        return json(res, 404, { ok: false, error: String(e.message || e).slice(0, 200) });
      }
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
      if (ks.serie && (!datos || datos.by !== 'auto') && fpcalcOk() && !INTRO_JOBS.has(ks.serie) && Date.now() - hace >= 6 * 3600 * 1000) {
        serieCtxFromUrl(String(url.searchParams.get('url') || '')).then((sc) => {
          if (sc && sc.eps && sc.eps.length > 1) detectarIntroSerie(ks.serie, sc.eps.slice(0, 3).map((e) => e.url));
        }).catch(() => {});
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
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size, version: UI_VERSION }); /* v122 */
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Huddle corriendo en http://0.0.0.0:${PORT}`);
});
