'use strict';
/* Huddle — cliente: sincronización de reproducción, chat y presencia. */

const $ = (s) => document.querySelector(s);

const APP_VERSION = 'v24';

/* Íconos SVG reutilizables (sin emojis) */
const ICONS = {
  play: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  bolt: '<svg class="icon icon-12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
  volHigh: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  volLow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  volMute: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none"/><path d="m16 9 6 6M22 9l-6 6"/></svg>',
  crown: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7.5l4.5 3.5L12 4l4.5 7L21 7.5 19.5 18h-15z"/></svg>',
  monitor: '<svg class="icon icon-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};

/* Algunos entornos (iframes de vista previa) bloquean las peticiones POST.
 * Si detectamos un token en la URL de la página, lo reenviamos como header. */
const EXTRA_HEADERS = (() => {
  try {
    const p = new URLSearchParams(location.search);
    for (const [k, val] of p.entries()) {
      if (/token/i.test(k) && val) return { 'e2b-traffic-access-token': val };
    }
  } catch {}
  return {};
})();

const SAMPLES = [
  { title: 'Big Buck Bunny · 10s', url: '/videos/bunny.mp4' },
  { title: 'Sintel · 10s', url: '/videos/sintel.mp4' },
  { title: 'Jellyfish · 10s', url: '/videos/jellyfish.mp4' },
  { title: 'Flower · 20s', url: '/videos/flower.mp4' },
];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SYNC_TOLERANCE = 0.75; // segundos de desvío antes de re-sincronizar

const S = {
  code: null,
  userId: null,
  room: null,
  es: null,
  currentUrl: '',
  hls: null,
  canControl: true,
  playState: false,
  dragging: false,
  lastTarget: 0,
  offset: 0,      // reloj del servidor - reloj local
  samplesReady: false,
  mirror: { active: false, url: '', w: 0, h: 0, gotFrame: false },
  lastActionAt: 0,
  useGet: false,     // se activa si el entorno bloquea POST
  helloSent: false,
};

const v = $('#video');

/* ======================= utilidades ======================= */

function toast(text, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, ms - 400);
  setTimeout(() => el.remove(), ms);
}

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

function guessTitle(url) {
  try {
    const last = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || url;
  } catch { return url; }
}

function hashHue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function showScreen(id) {
  $('#landing').classList.toggle('hidden', id !== 'landing');
  $('#room').classList.toggle('hidden', id !== 'room');
}

/* Si el servidor sirve otra versión de la interfaz, la página se actualiza
 * sola (una vez por pestaña, para no entrar en bucle). */
function maybeReload(srvVersion) {
  const key = 'rr-reloaded-' + srvVersion;
  if (sessionStorage.getItem(key)) {
    toast('Hay una versión nueva (' + srvVersion + ') — recarga la página (F5)', 9000);
    return;
  }
  sessionStorage.setItem(key, '1');
  toast('Nueva versión de la interfaz (' + srvVersion + ') — recargando…', 3000);
  setTimeout(() => location.reload(), 2500);
}

/* ======================= conexión / protocolo ======================= */

function connect(code, nick, opts = {}) {
  S.code = code.toUpperCase();
  const uid = sessionStorage.getItem('rr-uid-' + S.code) || '';
  const extra = opts.mustExist ? '&join=1' : ''; // Unirme: la sala debe existir ya
  const es = new EventSource(`/api/events?room=${S.code}&name=${encodeURIComponent(nick)}&uid=${encodeURIComponent(uid)}&v=${APP_VERSION}${extra}`);
  S.es = es;

  es.addEventListener('noRoom', (e) => {
    try { es.close(); } catch {}
    toast('No encontramos esa sala — revisa el código', 5000);
  });

  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    S.userId = d.userId;
    sessionStorage.setItem('rr-uid-' + S.code, S.userId);
    S.room = d.room;
    localStorage.setItem('rr-nick', nick);

    $('#chatLog').innerHTML = '';
    (d.room.chat || []).forEach(addChat);
    renderUsers(d.room.users);
    $('#roomCodeLbl').textContent = d.room.code;
    history.replaceState(null, '', '#' + d.room.code);
    showScreen('room');
    renderSamples();
    applyMirrorState(d.room.mirror || { active: false, url: '' });
    applyState(d.room.state);

    // ¿el servidor tiene una interfaz más nueva que la mía? → actualizar
    if (d.srvVersion && d.srvVersion !== APP_VERSION) maybeReload(d.srvVersion);

    // verificación del canal de acciones: un mensaje visible que también queda
    // registrado en los logs del servidor (diagnóstico inmediato)
    if (!S.helloSent) {
      S.helloSent = true;
      sendAction({ type: 'chat', text: `Conexión verificada (${APP_VERSION})` });
    }
  });

  es.addEventListener('state', (e) => applyState(JSON.parse(e.data)));
  es.addEventListener('users', (e) => renderUsers(JSON.parse(e.data).users));
  es.addEventListener('chat', (e) => addChat(JSON.parse(e.data).msg));
  es.addEventListener('mirror-state', (e) => applyMirrorState(JSON.parse(e.data)));
  es.addEventListener('mirror-frame', (e) => {
    const f = JSON.parse(e.data);
    S.mirror.w = f.w; S.mirror.h = f.h;
    S.mirror.gotFrame = true;
    $('#mirrorLoading').classList.add('hidden');
    drawMirrorFrame(f.d);
  });
  es.addEventListener('mirror-audio', (e) => {
    const d = JSON.parse(e.data);
    feedMirrorAudio(d.d, d.rate);
  });
  es.addEventListener('full', (e) => {
    const d = JSON.parse(e.data);
    toast(d.error || 'Sala llena');
    es.close();
  });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  // EventSource reintenta la conexión solo; el sondeo de estado la repara si se atasca.
}

function setConn(ok) {
  const b = $('#connBadge');
  if (!b) return;
  $('#connText').textContent = ok ? 'En vivo' : 'Reconectando…';
  b.className = 'conn ' + (ok ? 'ok' : 'bad');
}

async function sendAction(action) {
  if (!S.code || !S.userId) return { ok: false, error: 'sin sala' };
  const isControl = ['play', 'pause', 'seek', 'video', 'mirror'].includes(action.type);
  if (isControl) S.lastActionAt = Date.now();

  const falla = (error) => {
    if (error) {
      toast(error, 6500);
      console.warn('[Huddle] acción rechazada:', action, '→', error);
    }
    return { ok: false, error };
  };

  /* 1er intento: POST (estándar). Si el entorno lo bloquea (proxy que solo
   * permite GET), la respuesta llega sin nuestro formato → probamos con GET. */
  if (!S.useGet) {
    try {
      const r = await fetch('/api/action', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, EXTRA_HEADERS),
        body: JSON.stringify({ room: S.code, userId: S.userId, action }),
      });
      if (r.ok) return { ok: true }; // entregada
      const d = await r.json().catch(() => null);
      if (d && d.error) return falla(d.error); // error de lógica del servidor
      console.warn('[Huddle] POST devolvió HTTP ' + r.status + ' sin formato conocido; probando GET…');
    } catch { /* sin red: igual probamos GET */ }
  }

  /* 2º intento: GET (pasa por casi cualquier proxy) */
  try {
    const qs = new URLSearchParams({
      room: S.code,
      userId: S.userId,
      a: JSON.stringify(action),
    });
    const r2 = await fetch('/api/action?' + qs.toString());
    if (r2.ok) {
      if (!S.useGet) console.log('[Huddle] usando GET para acciones (POST bloqueado)');
      S.useGet = true;
      return { ok: true };
    }
    const d2 = await r2.json().catch(() => null);
    if (d2 && d2.error) return falla(d2.error);
    return falla('No se pudo enviar la acción (HTTP ' + r2.status + ')');
  } catch {
    setConn(false);
    return falla('Sin conexión con el servidor — reintenta en unos segundos');
  }
}

/* ======================= sondeo de auto-reparación =======================
 * Cada 4 s consultamos el estado real de la sala por HTTP. Si algún evento
 * SSE se perdió (conexión atascada), la interfaz se corrige sola. */
async function pollRoom() {
  if (!S.code || !S.userId) return;
  try {
    const r = await fetch('/api/room/' + S.code);
    if (!r.ok) return;
    const d = await r.json();
    setConn(true);
    if (d.srvVersion && d.srvVersion !== APP_VERSION) maybeReload(d.srvVersion);
    const rm = d.room;
    if (!rm) return;

    // espejo: reconciliar si difiere de lo que muestra la interfaz
    const act = !!(rm.mirror && rm.mirror.active);
    if (act !== S.mirror.active) applyMirrorState(rm.mirror);
    else if (act && rm.mirror.url && document.activeElement !== $('#mirrorUrlBar')) {
      $('#mirrorUrlBar').value = rm.mirror.url;
    }

    // usuarios: si el servidor ya no nos tiene, nuestra conexión murió → reconectar
    if (rm.users && !rm.users.some((u) => u.id === S.userId)) {
      console.warn('[Huddle] desconectado de la sala; reconectando…');
      try { if (S.es) S.es.close(); } catch {}
      connect(S.code, localStorage.getItem('rr-nick') || 'Anónimo');
      return;
    }

    // reproducción: reconciliar solo si difiere de verdad y no acabamos de actuar
    if (Date.now() - S.lastActionAt > 3000 && rm.state) {
      const st = rm.state;
      const playing = !!st.isPlaying;
      const target = playing ? st.position + (Date.now() + S.offset - st.updatedAt) / 1000 : st.position;
      const differs =
        playing !== S.playState ||
        (st.videoUrl || '') !== S.currentUrl ||
        (st.videoUrl && isFinite(target) && Math.abs(v.currentTime - target) > 2.5);
      if (differs) applyState(st);
    }
  } catch { /* sin respuesta: el badge de conexión lo reflejará el SSE */ }
}
setInterval(pollRoom, 4000);

/* ======================= sincronización ======================= */

function applyState(st) {
  if (!st) return;
  S.offset = st.serverNow - Date.now();
  S.playState = !!st.isPlaying;
  if (S.room) S.room.anyoneCanControl = !!st.anyoneCanControl;

  // cambio de video
  if (st.videoUrl && st.videoUrl !== S.currentUrl) {
    S.currentUrl = st.videoUrl;
    loadVideo(st.videoUrl, st.videoTitle);
    $('#videoEmpty').classList.add('hidden');
  } else if (st.videoUrl && S.currentUrl && S.mirror.active) {
    // el video se cargó mientras el espejo estaba activo: el espejo ya se apagó
    $('#videoEmpty').classList.add('hidden');
  } else if (!st.videoUrl && S.currentUrl) {
    S.currentUrl = '';
    destroyHls();
    v.removeAttribute('src');
    v.load();
    $('#videoTitle').classList.add('hidden');
    $('#videoEmpty').classList.remove('hidden'); // v18: al detener, vuelve la pantalla de inicio de sala
  } else if (!st.videoUrl && !S.currentUrl && !S.mirror.active) {
    $('#videoEmpty').classList.remove('hidden');
  }

  S.canControl = !!st.anyoneCanControl || (S.room && S.room.hostId === S.userId);
  updateControlUi();

  if (st.videoUrl) {
    const nowServidor = Date.now() + S.offset;
    const target = st.isPlaying
      ? st.position + (nowServidor - st.updatedAt) / 1000
      : st.position;
    S.lastTarget = target;

    if (!S.dragging && isFinite(target) && Math.abs(v.currentTime - target) > SYNC_TOLERANCE) {
      try { v.currentTime = target; } catch {}
    }
    if (st.isPlaying) tryPlay();
    else if (!v.paused) v.pause();
  }

  $('#btnPlay').innerHTML = st.isPlaying ? ICONS.pause : ICONS.play;
  updateBadge();
}

function loadVideo(url, title) {
  destroyHls();
  v.removeAttribute('src');
  v.load();
  $('#videoEmpty').classList.add('hidden');

  const isHls = /\.m3u8($|\?)/i.test(url);
  if (isHls && window.Hls && Hls.isSupported()) {
    S.hls = new Hls();
    S.hls.loadSource(url);
    S.hls.attachMedia(v);
    S.hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data && data.fatal) toast('Error al cargar el stream HLS (revisa la URL o el CORS del servidor)');
    });
  } else if (isHls && !window.Hls) {
    v.src = url; // Safari lo reproduce nativo; otros navegadores sin hls.js fallarán
    v.load();
  } else {
    v.src = url;
    v.load();
  }

  const t = title || guessTitle(url);
  const el = $('#videoTitle');
  el.textContent = t;
  el.classList.toggle('hidden', !t);
}

function destroyHls() {
  if (S.hls) { try { S.hls.destroy(); } catch {} S.hls = null; }
}

async function tryPlay() {
  if (!v.paused) return;
  try { await v.play(); }
  catch {
    // Política de autoplay: reintentamos silenciado y ofrecemos activar sonido.
    v.muted = true;
    try {
      await v.play();
      $('#unmuteChip').classList.remove('hidden');
    } catch {}
  }
}

function updateBadge() {
  const b = $('#syncBadge');
  if (!S.currentUrl || S.mirror.active) { b.innerHTML = ICONS.monitor + '<span>espejo</span>'; b.className = 'badge'; return; }
  if (!S.playState) { b.innerHTML = ICONS.pause + '<span>en pausa</span>'; b.className = 'badge'; return; }
  const drift = Math.abs(v.currentTime - S.lastTarget);
  b.innerHTML = ICONS.bolt + `<span>sync ±${drift.toFixed(1)}s</span>`;
  b.className = 'badge ' + (drift < 0.6 ? 'ok' : 'warn');
}

/* ======================= modo espejo (navegador remoto) ======================= */

function applyMirrorState(ms) {
  if (!ms) return;
  S.mirror.active = !!ms.active;
  S.mirror.url = ms.url || '';
  document.body.classList.toggle('mirroring', !!ms.active);
  $('#mirrorLayer').classList.toggle('hidden', !S.mirror.active);
  $('#video').classList.toggle('hidden', S.mirror.active);
  $('#videoEmpty').classList.toggle('hidden', S.mirror.active || !!S.currentUrl);
  if (S.mirror.active) {
    $('#mirrorUrlBar').value = S.mirror.url;
    AU.needAudio = !!ms.audio; // el servidor indica si hay audio disponible
    // si el audio quedó suspendido de una sesión anterior, reactivarlo
    if (AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume().catch(() => {});
    // pantalla de carga hasta que llegue el primer frame
    if (!S.mirror.gotFrame) $('#mirrorLoading').classList.remove('hidden');
  } else {
    S.mirror.gotFrame = false;
    AU.needAudio = false;
    S.frameSeq++;
    try { const c = $('#mirrorImg'); c.getContext('2d').clearRect(0, 0, c.width, c.height); } catch {}
    $('#mirrorLoading').classList.add('hidden');
    stopMirrorAudio();
  }
  updateControlUi();
  updateBadge();
}

/* Dibujo del espejo en canvas (anti-parpadeo): el frame anterior queda
 * en pantalla hasta que el nuevo está decodificado y listo. */
S.frameSeq = 0;
function drawMirrorFrame(dataUrl) {
  const c = $('#mirrorImg');
  if (!c || !c.getContext) return;
  S.frameSeq++;
  const seq = S.frameSeq;
  const paint = (source, w, h) => {
    if (seq !== S.frameSeq) return; // llegó un frame más nuevo: ignorar
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.getContext('2d').drawImage(source, 0, 0);
  };
  if (window.createImageBitmap) {
    fetch(dataUrl)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bmp) => { paint(bmp, bmp.width, bmp.height); bmp.close(); })
      .catch(() => { imgFallback(); });
  } else {
    imgFallback();
  }
  function imgFallback() {
    const img = new Image();
    img.onload = () => paint(img, img.width, img.height);
    img.src = dataUrl;
  }
}

/* ======================= audio del espejo =======================
 * Llega PCM (s16le mono, ~24 kHz) por SSE en trozos de 100 ms.
 * Se reproduce con AudioWorklet y un colchón anti-jitter de 250 ms. */

const AU = { ctx: null, node: null, rate: 24000 };

const WORKLET_CODE = `
class MirrorPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.qn = 0;
    this.off = 0;
    this.pre = Math.round(0.25 * sampleRate); // colchón antes de empezar
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data.clear) { this.q = []; this.qn = 0; this.off = 0; this.on = false; }
      else if (e.data.pcm) { this.q.push(e.data.pcm); this.qn += e.data.pcm.length; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.on && this.qn >= this.pre) this.on = true;
    if (!this.on) { out.fill(0); return true; }
    let i = 0;
    while (i < out.length && this.q.length) {
      const c = this.q[0];
      const take = Math.min(c.length - this.off, out.length - i);
      out.set(c.subarray(this.off, this.off + take), i);
      i += take;
      this.off += take;
      if (this.off >= c.length) { this.q.shift(); this.qn -= c.length; this.off = 0; }
    }
    if (i < out.length) out.fill(0, i);
    if (!this.q.length) this.on = false; // se vació → re-almacenar colchón
    return true;
  }
}
registerProcessor('mirror-player', MirrorPlayer);
`;

/* alternativa sin AudioWorklet: AudioWorklet solo existe en HTTPS,
   asi que en HTTP usamos ScriptProcessor (funciona en todos los navegadores) */
function makeFallbackNode(ctx) {
  if (!ctx.createScriptProcessor) return null;
  const q = []; let qn = 0, off = 0, on = false;
  const pre = Math.round(0.25 * ctx.sampleRate); // mismo colchón anti-jitter
  const node = ctx.createScriptProcessor(4096, 0, 1);
  const stats = { llamadas: 0, muestras: 0 };
  const port = {
    onmessage: null,
    postMessage(msg) {
      if (msg.clear) { q.length = 0; qn = 0; off = 0; on = false; }
      else if (msg.pcm) { q.push(msg.pcm); qn += msg.pcm.length; }
    }
  };
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    stats.llamadas++;
    if (!on && qn >= pre) on = true;
    if (!on) { out.fill(0); return; }
    let i = 0;
    while (i < out.length && q.length) {
      const c = q[0];
      const take = Math.min(c.length - off, out.length - i);
      out.set(c.subarray(off, off + take), i);
      i += take; off += take;
      if (off >= c.length) { q.shift(); qn -= c.length; off = 0; }
    }
    if (i < out.length) out.fill(0, i);
    stats.muestras += i;
    if (!q.length) on = false; // se vació → re-almacenar colchón
  };
  node.connect(ctx.destination);
  node._stats = stats;
  return { node, port, fallback: true };
}

async function ensureAudioCtx() {
  if (AU.ctx) return AU.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { AU.ctx = new AC({ sampleRate: AU.rate }); }
  catch { AU.ctx = new AC(); }
  try {
    if (!AU.ctx.audioWorklet) throw new Error('AudioWorklet no disponible (HTTP)');
    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'text/javascript' }));
    await AU.ctx.audioWorklet.addModule(url);
    AU.node = new AudioWorkletNode(AU.ctx, 'mirror-player', { outputChannelCount: [1] });
    AU.node.connect(AU.ctx.destination);
  } catch (e) {
    console.warn('[Huddle] AudioWorklet no disponible, usando alternativa', e);
    AU.node = makeFallbackNode(AU.ctx);
  }
  return AU.ctx;
}

async function feedMirrorAudio(b64, rate) {
  if (!S.mirror.active || !AU.needAudio) return;
  const ctx = await ensureAudioCtx();
  if (!ctx || !AU.node) return;
  if (ctx.state === 'suspended') { $('#audioChip').classList.remove('hidden'); return; }
  // decodificar base64 → Int16 → Float32 (con remuestreo si hace falta)
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const srcRate = rate || AU.rate;
  const ratio = ctx.sampleRate / srcRate;
  let f32;
  if (Math.abs(ratio - 1) < 0.001) {
    f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  } else {
    const outLen = Math.floor(i16.length * ratio);
    f32 = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const j = i / ratio;
      const j0 = Math.min(Math.floor(j), i16.length - 1);
      const j1 = Math.min(j0 + 1, i16.length - 1);
      const t = j - j0;
      f32[i] = (i16[j0] * (1 - t) + i16[j1] * t) / 32768;
    }
  }
  AU.node.port.postMessage({ pcm: f32 });
}

function stopMirrorAudio() {
  if (AU.node) { try { AU.node.port.postMessage({ clear: true }); } catch {} }
  if (AU.ctx && AU.ctx.state === 'running') { try { AU.ctx.suspend(); } catch {} }
  $('#audioChip').classList.add('hidden');
}

/* el chip de audio aparece cuando el navegador bloquea el sonido (autoplay) */
$('#audioChip').addEventListener('click', async () => {
  const ctx = await ensureAudioCtx();
  if (ctx) { try { await ctx.resume(); } catch {} }
  $('#audioChip').classList.add('hidden');
});

/* ---------- v21: resync automático al volver a la app ----------
 * cuando la app pasa al fondo (cambias de app, bloqueas el celular), iOS congela
 * la página: el flujo de audio y frames del espejo se sigue generando en el
 * servidor y llega viejo. Al volver, el cliente reproducía todo ese pasado
 * atrasado → audio desfazado. Solución: si estuve fuera más de 2.5 s,
 * reconecto el flujo (llega TODO fresco: estado, frames y audio desde AHORA)
 * y limpio el colchón de audio viejo que quedó en el worklet. */
let rrHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { rrHiddenAt = Date.now(); return; }
  const gap = rrHiddenAt ? Date.now() - rrHiddenAt : 0;
  rrHiddenAt = 0;
  if (S.code && S.es && gap > 2500) {
    try { if (AU.node) AU.node.port.postMessage({ clear: true }); } catch {} // fuera audio viejo
    try { S.es.close(); } catch {}
    connect(S.code, localStorage.getItem('rr-nick') || 'Anónimo', {}); // mismo uid → sin duplicados
  } else if (S.mirror.active && AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') {
    AU.ctx.resume().catch(() => {}); // ausencia corta: solo reactivar el audio
  }
});
/* al volver desde el bfcache ( Safari "atrás" ) el estado puede ser fossils: recargar */
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

/* clic sobre la página espejada → coordenadas de la página real */
$('#mirrorImg').addEventListener('click', (e) => {
  // cualquier clic es un gesto de usuario: desbloquea el audio si estaba pendiente
  if (S.mirror.active && AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') {
    AU.ctx.resume().catch(() => {});
    $('#audioChip').classList.add('hidden');
  }
  if (!S.mirror.active) return;
  if (!S.canControl) { toast('Solo el anfitrión controla el espejo'); return; }
  const img = e.target;
  const rect = img.getBoundingClientRect();
  // la imagen usa object-fit: contain → calculamos el área realmente visible
  const scale = Math.min(rect.width / S.mirror.w, rect.height / S.mirror.h);
  const drawW = S.mirror.w * scale, drawH = S.mirror.h * scale;
  const offX = (rect.width - drawW) / 2, offY = (rect.height - drawH) / 2;
  const px = e.clientX - rect.left - offX, py = e.clientY - rect.top - offY;
  if (px < 0 || py < 0 || px > drawW || py > drawH) return; // clic en el borde negro
  const x = Math.round(px / scale), y = Math.round(py / scale);
  sendAction({ type: 'mirror', op: 'click', x, y });
});

/* teclado → se reenvía a la página espejada */
$('#mirrorLayer').addEventListener('keydown', (e) => {
  if (!S.mirror.active || !S.canControl) return;
  const k = e.key;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // atajos del navegador se respetan
  if (k === 'F5' || k === 'F12') return;
  e.preventDefault();
  if (k.length === 1) sendAction({ type: 'mirror', op: 'type', text: k });
  else if (['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(k)) {
    sendAction({ type: 'mirror', op: 'press', key: k === ' ' ? 'Space' : k });
  }
});

/* rueda del mouse → scroll en la página espejada */
let lastWheel = 0;
$('#mirrorLayer').addEventListener('wheel', (e) => {
  if (!S.mirror.active || !S.canControl) return;
  e.preventDefault();
  const now = Date.now();
  if (now - lastWheel < 80) return; // no saturar el servidor
  lastWheel = now;
  sendAction({ type: 'mirror', op: 'scroll', deltaY: Math.round(e.deltaY) });
}, { passive: false });

/* barra de URL del espejo */
function mirrorNav() {
  if (!S.canControl) { toast('Solo el anfitrión controla el espejo'); return; }
  const url = $('#mirrorUrlBar').value.trim();
  if (url) sendAction({ type: 'mirror', op: 'nav', url });
  $('#mirrorLayer').focus();
}
$('#btnMirrorGo').addEventListener('click', mirrorNav);
$('#mirrorUrlBar').addEventListener('keydown', (e) => { if (e.key === 'Enter') mirrorNav(); });
$('#btnMirrorStop').addEventListener('click', () => {
  if (S.canControl) sendAction({ type: 'mirror', op: 'stop' });
  else toast('Solo el anfitrión controla el espejo');
});
/* v19: en móvil la barra del espejo se oculta; este botón (en las opciones) la reemplaza */
$('#btnMirrorStop2').addEventListener('click', () => {
  if (S.canControl) sendAction({ type: 'mirror', op: 'stop' });
  else toast('Solo el anfitrión controla el espejo');
});

/* detener el video en curso: devuelve las opciones de cargar/espejar */
$('#btnStopVideo').addEventListener('click', () => {
  if (!S.canControl) { toast('Solo el anfitrión controla la reproducción'); return; }
  sendAction({ type: 'video', url: '' });
});

/* iniciar espejo desde el selector */
function startMirrorFromPicker() {
  if (!S.canControl) { toast('Solo el anfitrión puede espejar'); return; }
  const url = $('#mirrorUrl').value.trim();
  if (!url) { toast('Escribe la URL de la página a espejar'); return; }
  // feedback inmediato: mostramos la capa del espejo con spinner mientras abre Chrome
  S.mirror.gotFrame = false;
  applyMirrorState({ active: true, url, audio: true });
  // aprovechamos el clic (gesto del usuario) para desbloquear el audio
  ensureAudioCtx().then((ctx) => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); });
  sendAction({ type: 'mirror', op: 'start', url }).then((r) => {
    // si falló (RAM, URL mala, etc.) volvemos a la pantalla normal al instante
    if (r && r.ok === false) applyMirrorState({ active: false, url: '' });
  });
  $('#mirrorUrl').value = '';
}
$('#btnMirror').addEventListener('click', startMirrorFromPicker);
$('#mirrorUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') startMirrorFromPicker(); });

function updateControlUi() {
  const isHost = S.room && S.room.hostId === S.userId;
  const mirrorOn = S.mirror.active;
  /* con un video en curso, las opciones de cargar/espejar se esconden:
   * vuelven cuando el usuario detiene el video (igual que el espejo) */
  const videoOn = !!S.currentUrl && !mirrorOn;
  document.body.classList.toggle('playing', videoOn);
  $('#stopRow').classList.toggle('hidden', !videoOn);
  $('#btnStopVideo').disabled = !S.canControl;
  $('#btnMirrorStop2').disabled = !S.canControl;
  $('#btnPlay').disabled = !S.canControl || !S.currentUrl || mirrorOn;
  $('#seek').disabled = !S.canControl || !S.currentUrl || mirrorOn;
  $('#btnLoad').disabled = !S.canControl || mirrorOn;
  $('#videoUrl').disabled = !S.canControl || mirrorOn;
  $('#btnMirror').disabled = !S.canControl;
  $('#mirrorUrl').disabled = !S.canControl || mirrorOn;
  $('#btnMirrorGo').disabled = !S.canControl;
  $('#btnMirrorStop').disabled = !S.canControl;
  $('#chkControl').checked = !!(S.room && S.room.anyoneCanControl);
  $('#chkControl').disabled = !isHost;
  $('#lockHint').textContent = S.canControl ? '' : 'Solo el anfitrión controla la reproducción';
  $('#mirrorLayer').classList.toggle('locked', !S.canControl);
}

/* ======================= presencia y chat ======================= */

function renderUsers(users) {
  if (S.room && Array.isArray(users)) {
    const host = users.find((u) => u.isHost);
    if (host) S.room.hostId = host.id;
  }
  const list = $('#userList');
  list.innerHTML = '';
  (users || []).forEach((u) => {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.setProperty('--h', hashHue(u.name));
    av.textContent = (u.name[0] || '?').toUpperCase();
    const nm = document.createElement('span');
    nm.className = 'uname';
    nm.textContent = u.name + (u.id === S.userId ? ' (tú)' : '');
    li.appendChild(av); li.appendChild(nm);
    if (u.isHost) { const c = document.createElement('span'); c.className = 'crown'; c.title = 'Anfitrión'; c.innerHTML = ICONS.crown; li.appendChild(c); }
    list.appendChild(li);
  });
  $('#userCount').textContent = users ? users.length : 0;
  updateControlUi();
}

function addChat(msg) {
  const log = $('#chatLog');
  const div = document.createElement('div');
  if (msg.system) {
    div.className = 'msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'msg' + (msg.userId === S.userId ? ' mine' : '');
    const b = document.createElement('b');
    b.className = 'cname';
    b.style.setProperty('--h', hashHue(msg.name || ''));
    b.textContent = msg.name || '?';
    const sp = document.createElement('span');
    sp.textContent = ' ' + msg.text;
    div.appendChild(b); div.appendChild(sp);
  }
  log.appendChild(div);
  /* v24: no acumular mensajes viejos en pantalla (el servidor igual guarda 100) */
  while (log.children.length > 80) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

/* ======================= controles ======================= */

function togglePlay() {
  if (!S.currentUrl) { toast('Primero carga un video'); return; }
  if (!S.canControl) { toast('Solo el anfitrión controla la reproducción'); return; }
  if (v.paused) { tryPlay(); sendAction({ type: 'play' }); }
  else { v.pause(); sendAction({ type: 'pause' }); }
}

$('#btnPlay').addEventListener('click', togglePlay);
v.addEventListener('click', togglePlay);
v.addEventListener('dblclick', toggleFullscreen);

const seek = $('#seek');
seek.addEventListener('pointerdown', () => { S.dragging = true; });
seek.addEventListener('input', () => {
  if (isFinite(v.duration)) $('#timeLbl').textContent = `${fmt((seek.value / 1000) * v.duration)} / ${fmt(v.duration)}`;
});
seek.addEventListener('change', () => {
  S.dragging = false;
  if (!S.canControl || !isFinite(v.duration)) return;
  const pos = (seek.value / 1000) * v.duration;
  try { v.currentTime = pos; } catch {}
  sendAction({ type: 'seek', position: pos });
});

v.addEventListener('timeupdate', () => {
  if (!S.dragging && isFinite(v.duration) && v.duration > 0) {
    seek.value = String(Math.round((v.currentTime / v.duration) * 1000));
  }
  $('#timeLbl').textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
  updateBadge();
});

v.addEventListener('loadedmetadata', () => {
  if (S.lastTarget > 0 && Math.abs(v.currentTime - S.lastTarget) > SYNC_TOLERANCE) {
    try { v.currentTime = S.lastTarget; } catch {}
  }
});
v.addEventListener('canplay', () => { if (S.playState) tryPlay(); });
v.addEventListener('ended', () => { if (S.currentUrl && S.userId) sendAction({ type: 'ended', position: v.duration || 0 }); });
v.addEventListener('error', () => {
  if (S.currentUrl && !S.hls) toast('No se pudo cargar el video (enlace caído, CORS o formato no soportado)');
});
v.addEventListener('volumechange', () => {
  $('#btnMute').innerHTML = (v.muted || v.volume === 0) ? ICONS.volMute : (v.volume < 0.5 ? ICONS.volLow : ICONS.volHigh);
});

$('#volume').addEventListener('input', (e) => { v.volume = Number(e.target.value); v.muted = Number(e.target.value) === 0; });
$('#btnMute').addEventListener('click', () => { v.muted = !v.muted; });

/* pantalla completa: en modo video se maximiza el propio <video> (el navegador
 * lo ajusta con bandas negras, nunca se recorta); en modo espejo, el contenedor.
 * iPhones no soportan la API de pantalla completa en divs (solo en <video>),
 * así que al espejar usamos una pantalla completa simulada: el reproductor
 * se fija cubriendo toda la ventana, con botón ✕ para salir. */
const videoShellEl = $('#videoShell');
function fsActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement ||
    videoShellEl.classList.contains('pseudo-fs'));
}
function exitFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    const xf = d.exitFullscreen || d.webkitExitFullscreen;
    if (xf) { try { xf.call(d); } catch {} }
  }
  videoShellEl.classList.remove('pseudo-fs');
  document.body.classList.remove('fs-lock');
  videoShellEl.classList.remove('fit-cover');
  $('#fitToggleTxt').textContent = 'Llenar';
}
function enterPseudoFs() {
  videoShellEl.classList.add('pseudo-fs');
  document.body.classList.add('fs-lock');
}
/* v20: al entrar a pantalla completa, el ajuste ideal depende de la orientación:
 * horizontal → llenar la pantalla (sin barras laterales); vertical → ver todo */
function applyDefaultFsFit() {
  const landscape = window.matchMedia('(orientation: landscape)').matches;
  videoShellEl.classList.toggle('fit-cover', landscape);
  $('#fitToggleTxt').textContent = landscape ? 'Ver todo' : 'Llenar';
}
window.addEventListener('orientationchange', () => {
  if (fsActive()) setTimeout(applyDefaultFsFit, 200); // al girar, reajustar
});
function toggleFullscreen() {
  if (fsActive()) return exitFullscreen();
  applyDefaultFsFit();
  const rf = videoShellEl.requestFullscreen || videoShellEl.webkitRequestFullscreen;
  if (rf) {
    const p = rf.call(videoShellEl);
    if (p && p.catch) p.catch(() => enterPseudoFs()); // si el navegador la rechaza, simulada
  } else if (!S.mirror.active && v.webkitEnterFullscreen && v.currentSrc) {
    v.webkitEnterFullscreen(); // iPhone con video: reproductor nativo
  } else {
    enterPseudoFs(); // iPhone espejando (o navegador sin la API): simulada
  }
}
$('#btnFs').addEventListener('click', toggleFullscreen);
$('#fsExit').addEventListener('click', exitFullscreen);

/* botón «Llenar / Ver todo»: solo visible en pantalla completa */
$('#fitToggle').addEventListener('click', () => {
  const shell = $('#videoShell');
  const cover = shell.classList.toggle('fit-cover');
  $('#fitToggleTxt').textContent = cover ? 'Ver todo' : 'Llenar';
});
const _fsReset = () => {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    $('#videoShell').classList.remove('fit-cover');
    $('#fitToggleTxt').textContent = 'Llenar';
  }
};
document.addEventListener('fullscreenchange', _fsReset);
document.addEventListener('webkitfullscreenchange', _fsReset);
$('#unmuteChip').addEventListener('click', () => { v.muted = false; $('#unmuteChip').classList.add('hidden'); });

$('#chkControl').addEventListener('change', (e) => {
  sendAction({ type: 'mode', anyoneCanControl: e.target.checked });
});

/* ======================= selector de video ======================= */

function renderSamples() {
  if (S.samplesReady) return;
  S.samplesReady = true;
  const box = $('#samples');
  SAMPLES.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'sample-btn';
    b.textContent = s.title;
    b.addEventListener('click', () => loadVideoFor(s.url, s.title));
    box.appendChild(b);
  });
}

function loadVideoFor(url, title) {
  if (!S.canControl) { toast('Solo el anfitrión puede cambiar el video'); return; }
  sendAction({ type: 'video', url, title });
}

$('#btnLoad').addEventListener('click', () => {
  const url = $('#videoUrl').value.trim();
  if (!/^https?:\/\/.+/i.test(url) && !url.startsWith('/')) {
    toast('Pega una URL válida (http/https)');
    return;
  }
  loadVideoFor(url, guessTitle(url));
  $('#videoUrl').value = '';
});
$('#videoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnLoad').click(); });

/* ======================= chat ======================= */

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (text) { sendAction({ type: 'chat', text }); input.value = ''; }
});

/* ======================= topbar ======================= */

$('#btnCopy').addEventListener('click', async () => {
  const link = location.origin + '/#' + S.code;
  /* v22: mensaje listo para pegar — el link SOLO en su línea hace que
   * WhatsApp lo reconozca como link (dominio + https, ver GUIA-HTTPS.md) */
  const msg = `¡Únete a mi sala en Huddle! 🎬\n${link}`;
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = msg;
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    ok = document.execCommand('copy');
    ta.remove();
  } catch {}
  if (!ok) { try { await navigator.clipboard.writeText(msg); ok = true; } catch {} }
  toast(ok ? 'Invitación copiada — pégala en WhatsApp o donde quieras' : 'Tu invitación: ' + link, ok ? 3600 : 8000);
});

$('#btnLeave').addEventListener('click', () => {
  if (S.es) S.es.close();
  location.href = location.pathname;
  location.reload();
});

/* ======================= pantalla de inicio ======================= */

function getNick() {
  return $('#nick').value.trim() || 'Invitado' + Math.floor(100 + Math.random() * 900);
}

$('#btnCreate').addEventListener('click', () => {
  const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  connect(code, getNick());
});

function joinFromInput() {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) { toast('Código inválido (4-8 letras/números)'); return; }
  connect(code, getNick(), { mustExist: true });
}
$('#btnJoin').addEventListener('click', joinFromInput);
$('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });

/* estado inicial */
$('#nick').value = localStorage.getItem('rr-nick') || '';
const hashMatch = /^#([A-Za-z0-9]{4,8})$/.exec(location.hash);
if (hashMatch) {
  $('#joinCode').value = hashMatch[1].toUpperCase();
  $('#nick').focus();
}
