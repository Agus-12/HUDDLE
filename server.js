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
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const UI_VERSION = 'v92'; // versión de la interfaz que sirve este servidor
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
  };
}
/* v92: ¿esta URL se puede reproducir NATIVA (sin navegador remoto)?
 * El mismo resolver del modo Solo: goodstream/vimeos y animes mp4upload */
async function resolverNativo(url) {
  if (/latanime\.org\/ver\//i.test(url)) return resolverAnime(url);
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
async function datosSerieCuevana(slug) {
  const c = serieCache.get(slug);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.d;
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
      poster: (og('og:image') || (eps[0] ? eps[0].img : '')).replace('/w780/', '/w342/'),
      episodios: eps,
    };
    serieCache.set(slug, { at: Date.now(), d: out });
    return out;
  } catch { return null; }
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
    return outL;
  } catch { return null; }
}

/* v74: si la URL es un episodio de serie, saca la lista completa de
 * episodios para saber cuál sigue y cuál va antes */
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
    return null;
  } catch { return null; }
}

function mirrorState(room) {
  const m = mirrors.get(room.code);
  const out = m
    ? { active: true, url: m.url || '', audio: AUDIO_READY, playing: !!m.playing, ready: !!m.ready }
    : { active: false, url: '', audio: false, playing: false, ready: false };
  /* v74: si están viendo un episodio de serie, la sala sabe cuál es y si
   * hay siguiente/anterior — para los botoncitos de la esquina */
  if (m && m.serie) {
    const sc = m.serie;
    out.serie = {
      titulo: sc.titulo, poster: sc.poster, total: sc.eps.length,
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
            /* v61: en cine NO damos play — queda en pausa esperando el botón */
            if (!cine && v.readyState >= 2) { try { if (v.paused) v.play().catch(() => {}); } catch {} }
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
    if (esPagCine() && videoListo && !m.ready) {
      /* v61: la peli queda LISTA EN PAUSA — el botón de play aparece en la sala
       * y cuando alguien le pica, empieza para todos al mismo tiempo */
      for (const fr of m.page.frames()) {
        await fr.evaluate(() => document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} })).catch(() => {});
      }
      m.ready = true;
      m.playing = false;
      console.log(`[espejo] lista en pausa en sala ${room.code} (${(m.url || '').slice(0, 60)})`);
      pantallaCompleta().catch(() => {});
      broadcast(room, 'mirror-state', mirrorState(room));
      return; /* listo: no seguir reintentando */
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

  if (type === 'ended') { // el video terminó de reproducirse
    room.position = Math.max(0, Number(action.position) || 0);
    room.isPlaying = false;
    room.updatedAt = now;
    broadcast(room, 'state', stateOf(room));
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
          const nat = await resolverNativo(urlNat).catch((e) => {
            console.log('[sala] nativo no pudo (' + String(e.message || e).slice(0, 60) + ') → espejo');
            return null;
          });
          if (nat) {
            if (mirrors.has(room.code)) stopMirror(room).catch(() => {});
            room.videoUrl = urlNat;
            room.videoTitle = String(action.title || guessTitle(urlNat)).slice(0, 80);
            room.videoImg = String(action.img || '').slice(0, 400);
            room.native = { m3u8: nat.m3u8, mp4: !!nat.mp4, proxy: !!nat.proxy, subs: nat.subs || [] };
            room.position = 0;
            room.isPlaying = true; /* arranca sonando; el que no pueda, ve el botón de play */
            room.updatedAt = Date.now();
            sysMsg(room, `${room.users.get(userId).name} puso: ${room.videoTitle}`);
            broadcast(room, 'state', stateOf(room));
            return json(res, 200, { ok: true, nativo: true });
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
        const m = mirrors.get(room.code);
        if (!m || !m.serie) return json(res, 404, { ok: false, error: 'No hay serie en el espejo' });
        let idx = m.serie.eps.findIndex((e) => e.url === (m.url || ''));
        if (idx < 0) idx = m.serie.idx;
        const target = m.serie.eps[idx + (op === 'epNext' ? 1 : -1)];
        if (!target) return json(res, 400, { ok: false, error: op === 'epNext' ? 'Ya estás en el último episodio' : 'Ya estás en el primer episodio' });
        await stopMirror(room);
        await startMirror(room, target.url, userId);
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
      room.videoUrl = url;
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
    const extra = noCache ? { 'Cache-Control': 'no-cache' } : {};
    const range = req.headers.range;

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
      /* v68: fuera AnimeFLV y GoPelis — v70: fuera AnimeD23 también */
      const antes = l.length;
      l = l.filter((s) => !/animeflv\.|gopelis\.|animed23\./i.test(s.url || ''));
      if (l.length !== antes) { cambio = true; console.log('[sitios] - AnimeFLV, GoPelis y AnimeD23'); }
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

async function buscarEnSitios(q) {
  /* v68: fuera GoPelis (poco catálogo) y AnimeFLV — queda Cuevana + Latanime */
  const grupos = await Promise.all([
    buscarCuevana(q).catch(() => []),
    buscarLatanime(q).catch(() => []),
  ]);
  /* v63: intercalados por sitio para que ningún sitio tape a los demás */
  const resultados = [];
  const maximo = Math.max(0, ...grupos.map((g) => g.length));
  for (let i = 0; i < maximo; i++) {
    for (const g of grupos) if (g[i]) resultados.push(g[i]);
  }
  console.log(`[buscar] "${q}" en Cuevana+Latanime → ${resultados.length} resultados`);
  return resultados.slice(0, 24);
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
  let em = null;
  for (let intento = 0; intento < 2; intento++) {
    if (intento > 0) await new Promise((r2) => setTimeout(r2, 2500));
    try { em = await fetchTexto(embed, pageUrl); break; }
    catch (e) { if (intento === 1) throw e; }
  }
  const files = [...em.matchAll(/file\s*:\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  const m3u8 = files.find((f) => /\.m3u8/i.test(f));
  if (!m3u8) throw new Error('El servidor no entregó el video — ábrelo en modo sala (👥 Juntos)');
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
  return { m3u8, subs };
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
 * trae el mp4 DIRECTO en su HTML (player.src), sin navegador remoto */
async function resolverAnime(epUrl) {
  const html = await fetchTexto(epUrl, 'https://latanime.org/');
  const links = [...html.matchAll(/<a\b[^>]*class="[^"]*play-video[^"]*"[^>]*data-player="([^"]+)"[^>]*>/gi)];
  const embeds = links.map((m) => { try { return Buffer.from(m[1], 'base64').toString('utf8'); } catch { return ''; } }).filter((u) => /^https?:\/\//i.test(u));
  const mejor = embeds.find((u) => /mp4upload\./i.test(u));
  if (!mejor) throw new Error('Este episodio no tiene servidor mp4upload — se ve en modo sala (👥 Juntos)');
  let em = '';
  for (let intento = 0; intento < 2; intento++) {
    if (intento > 0) await new Promise((r2) => setTimeout(r2, 2500));
    try { em = await fetchTexto(mejor, epUrl); break; }
    catch (e) { if (intento === 1) throw e; }
  }
  const m = em.match(/player\.src\(\{\s*type:\s*["']video\/mp4["']\s*,\s*src:\s*["'](https?:\/\/[^"']+)["']/i)
    || em.match(/["'](https?:\/\/[^"'\s<>]*mp4upload[^"'\s<>]*\.mp4[^"'\s<>]*)["']/i);
  if (!m) throw new Error('El servidor de anime no entregó el video — ábrelo en modo sala (👥 Juntos)');
  /* el mp4 exige el Referer del embed: lo recordamos para el proxy */
  try { hlsReferers.set(new URL(m[1]).hostname, mejor); } catch {}
  return { m3u8: m[1], mp4: true, proxy: true, subs: [] };
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
    return /(^|\.)goodstream\.one$/i.test(h) || /(^|\.)mp4upload\.com$/i.test(h) || /(^|\.)vimeos\.(net|zip)$/i.test(h);
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
      if (!/^(www\.|vww\.)?(latanime\.org|animeflv\.one)$/i.test(host)) {
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
      /* v55: populares del día + v57: series recién agregadas */
      const [day, series, animes] = await Promise.all([
        popularesDeHoy().catch(() => []),
        seriesRecientes().catch(() => []),
        animesDelMomento().catch(() => []), /* v67: animes del momento (Latanime) */
      ]);
      return json(res, 200, { ok: true, results: day, series, animes });
    }
    if (url.pathname.startsWith('/api/serie/')) {
      /* v61: temporadas y episodios de una serie (para elegirla bonito) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Serie inválida' });
      const dS = await datosSerieCuevana(slug); /* v74: compartida con los botones de episodio */
      if (!dS) return json(res, 502, { ok: false, error: 'No pude leer la serie' });
      return json(res, 200, dS);
    }
    if (url.pathname.startsWith('/api/anime/')) {
      /* v62: episodios de un anime — AnimeFLV (var eps) y v63: Latanime (enlaces /ver/) */
      const slug = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!/^[a-z0-9-]{2,90}$/.test(slug)) return json(res, 400, { ok: false, error: 'Anime inválido' });
      if ((url.searchParams.get('site') || '').toLowerCase() === 'latanime') {
        const dL = await datosAnimeLatanime(slug); /* v74: compartida con los botones de episodio */
        if (!dL) return json(res, 502, { ok: false, error: 'No pude leer el anime' });
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
      const results = await buscarEnSitios(q);
      if (!results.length) return json(res, 200, { ok: true, results: [], error: 'No encontré nada en Cuevana ni GoPelis — prueba con otras palabras' });
      return json(res, 200, { ok: true, results });
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
        const esEpAnime = /latanime\.org\/ver\//i.test(target);
        const r = await (esEpAnime ? resolverAnime(target) : resolverSolo(target));
        return json(res, 200, { ok: true, m3u8: r.m3u8, subs: r.subs, mp4: !!r.mp4, proxy: !!r.proxy });
      } catch (e) {
        console.warn('[solo] no pude resolver', target.slice(0, 70), '→', String(e.message || e).slice(0, 90));
        return json(res, 404, { ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }
    if (url.pathname === '/api/hls') {
      /* v81: proxy del stream (solo goodstream) cuando directo falla */
      return proxearHls(req, res, url.searchParams.get('u') || '');
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
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Error interno' });
    else res.end();
  }
});

/* Sincronización periódica (corrección de desvío) + limpieza */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size && room.isPlaying) broadcast(room, 'state', stateOf(room));
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
