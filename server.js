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
const UI_VERSION = 'v13'; // versión de la interfaz que sirve este servidor
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_USERS = 30;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // salas vacías se borran a las 2 h
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
  };
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
const MIRROR_MAX = +(process.env.MIRROR_MAX || 2); // espejos simultáneos (RAM; en Oracle MIRROR_MAX=8)
const MIRROR_SEND_MS = 45;          // máx. ~20 fps hacia los clientes
const MIRROR_IDLE_MS = 90 * 1000; // se cierra si la sala queda vacía 90 s
const MIRROR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function mirrorState(room) {
  const m = mirrors.get(room.code);
  return m
    ? { active: true, url: m.url || '', audio: AUDIO_READY }
    : { active: false, url: '', audio: false };
}

async function startMirror(room, rawUrl, userId) {
  const url = normalizeWebUrl(rawUrl);
  if (mirrors.has(room.code)) {
    const m = mirrors.get(room.code);
    m.url = url;
    m.ownerId = userId;
    await m.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    broadcast(room, 'mirror-state', mirrorState(room));
    return;
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
    ].concat(useXvfb ? ['--window-size=1280,800', '--no-first-run', '--disable-infobars', '--start-maximized'] : []),
    env: Object.assign({}, process.env, AUDIO_READY ? { PULSE_SERVER, DISPLAY: ':99' } : {}),
  }).catch((e) => { throw new Error('no se pudo lanzar Chrome: ' + e.message); });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.setUserAgent(MIRROR_UA).catch(() => {});
  const cdp = await page.createCDPSession();

  const m = { browser, page, cdp, url, frame: null, dirty: false, timer: null, emptySince: null, ownerId: userId, startedAt: Date.now() };
  mirrors.set(room.code, m);

  cdp.on('Page.screencastFrame', async (ev) => {
    m.frame = {
      d: 'data:image/jpeg;base64,' + ev.data,
      w: (ev.metadata && ev.metadata.deviceWidth) || 1280,
      h: (ev.metadata && ev.metadata.deviceHeight) || 800,
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
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: m.quality, maxWidth: 1200, maxHeight: 750, everyNthFrame: 1 });

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
  const name = (url.searchParams.get('name') || '').trim().slice(0, 20) || 'Anónimo';

  if (!/^[A-Z0-9]{4,8}$/.test(code)) { res.writeHead(400); res.end('código de sala inválido'); return; }

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
  if (isNew) room.users.set(userId, { id: userId, name, joinedAt: Date.now() });
  else room.users.get(userId).name = name;

  if (!room.hostId || !room.users.has(room.hostId)) room.hostId = userId;

  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(':ok\n\n');
  res.rrUserId = userId;
  room.clients.add(res);

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
        await startMirror(room, action.url, userId);
        // si se estaba reproduciendo un video, se pausa: la sala pasa a modo espejo
        if (room.isPlaying) {
          room.position = currentPosition(room);
          room.isPlaying = false;
          room.updatedAt = Date.now();
          broadcast(room, 'state', stateOf(room));
        }
        return json(res, 200, { ok: true });
      }
      if (op === 'stop') { await stopMirror(room); return json(res, 200, { ok: true }); }

      const m = mirrors.get(room.code);
      if (!m) return json(res, 404, { ok: false, error: 'El espejo no está activo' });

      if (op === 'click') await m.page.mouse.click(Math.max(0, +action.x || 0), Math.max(0, +action.y || 0));
      else if (op === 'type') await m.page.keyboard.type(String(action.text || '').slice(0, 60));
      else if (op === 'press') await m.page.keyboard.press(String(action.key || 'Enter').slice(0, 20));
      else if (op === 'scroll') await m.page.mouse.wheel({ deltaY: +action.deltaY || 0 });
      else return json(res, 400, { ok: false, error: 'Operación de espejo desconocida' });

      return json(res, 200, { ok: true });
    } catch (e) {
      console.error(`[acción] 💥 error de espejo en ${code}:`, e.message || e);
      return json(res, 500, { ok: false, error: 'No se pudo espejar: ' + (e.message || e) });
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

/* ---------------------- servidor ---------------------- */

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
    if (room.clients.size === 0 && now - room.createdAt > ROOM_TTL_MS) {
      if (mirrors.has(code)) stopMirror(room).catch(() => {});
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Huddle corriendo en http://0.0.0.0:${PORT}`);
});
