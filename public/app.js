'use strict';
/* Huddle — cliente: sincronización de reproducción, chat y presencia. */

const $ = (s) => document.querySelector(s);

const APP_VERSION = 'v35';

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

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SYNC_TOLERANCE = 0.75; // segundos de desvío antes de re-sincronizar

const S = {
  code: null,
  profile: null,
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
  mirror: { active: false, url: '', w: 0, h: 0, gotFrame: false },
  lastActionAt: 0,
  useGet: false,     // se activa si el entorno bloquea POST
  helloSent: false,
};

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

function connect(code, opts = {}) {
  if (!S.profile) { showScreen('landing'); initLanding(); toast('Primero elige tu nombre de usuario'); return; }
  S.code = code.toUpperCase();
  const uid = sessionStorage.getItem('rr-uid-' + S.code) || '';
  const extra = opts.mustExist ? '&join=1' : ''; // Unirme: la sala debe existir ya
  const es = new EventSource(`/api/events?room=${S.code}&name=${encodeURIComponent(S.profile.name)}&tok=${encodeURIComponent(S.profile.token)}&uid=${encodeURIComponent(uid)}&v=${APP_VERSION}${extra}`);
  S.es = es;

  es.addEventListener('noRoom', (e) => {
    try { es.close(); } catch {}
    toast('No encontramos esa sala — revisa el código', 5000);
  });

  es.addEventListener('badName', (e) => { // v31: el nombre dejó de ser válido
    try { es.close(); } catch {}
    S.profile = null;
    localStorage.removeItem('rr-profile');
    initLanding();
    toast('Tu nombre de usuario ya no es válido — elige otro', 6000);
  });

  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    S.userId = d.userId;
    sessionStorage.setItem('rr-uid-' + S.code, S.userId);
    S.room = d.room;

    $('#chatLog').innerHTML = '';
    (d.room.chat || []).forEach(addChat);
    renderUsers(d.room.users);
    /* v33: el numero de sala ya no se muestra (la invitacion basta) */
    history.replaceState(null, '', '#' + d.room.code);
    showScreen('room');
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
      if (r.ok) {
        /* v29: devolver el cuerpo completo (trae datos como typing del espejo) */
        const d = await r.json().catch(() => null);
        return (d && typeof d === 'object') ? d : { ok: true };
      }
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
      const d2 = await r2.json().catch(() => null);
      return (d2 && typeof d2 === 'object') ? d2 : { ok: true };
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

    // usuarios: si el servidor ya no nos tiene, nuestra conexión murió → reconectar
    if (rm.users && !rm.users.some((u) => u.id === S.userId)) {
      console.warn('[Huddle] desconectado de la sala; reconectando…');
      try { if (S.es) S.es.close(); } catch {}
      connect(S.code);
      return;
    }
  } catch { /* sin respuesta: el badge de conexión lo reflejará el SSE */ }
}
setInterval(pollRoom, 4000);

/* ======================= sincronización ======================= */

function applyState(st) {
  if (!st) return;
  S.offset = st.serverNow - Date.now();
  if (S.room) S.room.anyoneCanControl = !!st.anyoneCanControl;
  S.canControl = !!st.anyoneCanControl || (S.room && S.room.hostId === S.userId);
  updateControlUi();
  updateBadge();
}

/* v33: la app ya no reproduce videos por URL — solo espeja páginas.
 * El badge de sync vivía en la barra del reproductor, que ya no existe. */
function updateBadge() {}

/* ======================= modo espejo (navegador remoto) ======================= */

function applyMirrorState(ms) {
  if (!ms) return;
  S.mirror.active = !!ms.active;
  S.mirror.url = ms.url || '';
  document.body.classList.toggle('mirroring', !!ms.active);
  $('#mirrorLayer').classList.toggle('hidden', !S.mirror.active);
  $('#videoEmpty').classList.toggle('hidden', S.mirror.active);
  if (S.mirror.active) {
    AU.needAudio = !!ms.audio; // el servidor indica si hay audio disponible
    if (window.__setPagePick) window.__setPagePick(S.mirror.url);
    // si el audio quedó suspendido de una sesión anterior, reactivarlo
    if (AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume().catch(() => {});
    // pantalla de carga hasta que llegue el primer frame
    if (!S.mirror.gotFrame) $('#mirrorLoading').classList.remove('hidden');
  } else {
    if (window.__setPagePick && !S.mirror.url) window.__setPagePick(''); // v34: al detener, vuelve a "elige una pagina"
    S.mirror.gotFrame = false;
    AU.needAudio = false;
    S.frameSeq++;
    try { const c = $('#mirrorImg'); c.getContext('2d').clearRect(0, 0, c.width, c.height); } catch {}
    $('#mirrorLoading').classList.add('hidden');
    stopMirrorAudio();
    cerrarTecladoEspejo(); // v29: sin espejo no hay teclado abierto
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
    connect(S.code, {}); // mismo uid → sin duplicados
  } else if (S.mirror.active && AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') {
    AU.ctx.resume().catch(() => {}); // ausencia corta: solo reactivar el audio
  }
});
/* al volver desde el bfcache ( Safari "atrás" ) el estado puede ser fossils: recargar */
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

/* v27: navegación del espejo unificada — TOCAR = clic, ARRASTRAR = desplazarse
 * (antes solo había clic y rueda del mouse: en celular era imposible moverse) */
(function () {
  const img = $('#mirrorImg');
  let pStart = null, last = null, dragging = false, accDy = 0, lastSent = 0, pid = null;

  const unlockAudio = () => {
    if (S.mirror.active && AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') {
      AU.ctx.resume().catch(() => {});
      $('#audioChip').classList.add('hidden');
    }
  };
  const toPage = (cx, cy) => {
    if (!S.mirror.w || !S.mirror.h) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / S.mirror.w, rect.height / S.mirror.h);
    const drawW = S.mirror.w * scale, drawH = S.mirror.h * scale;
    const offX = (rect.width - drawW) / 2, offY = (rect.height - drawH) / 2;
    const px = cx - rect.left - offX, py = cy - rect.top - offY;
    if (px < 0 || py < 0 || px > drawW || py > drawH) return null; // borde negro
    return { x: Math.round(px / scale), y: Math.round(py / scale), scale };
  };

  img.addEventListener('pointerdown', (e) => {
    if (!S.mirror.active) return;
    pid = e.pointerId;
    pStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    last = { x: e.clientX, y: e.clientY };
    dragging = false; accDy = 0; lastSent = 0;
  });

  img.addEventListener('pointermove', (e) => {
    if (pStart === null || e.pointerId !== pid) return;
    if (!dragging && Math.hypot(e.clientX - pStart.x, e.clientY - pStart.y) > 12) {
      dragging = true;
      try { img.setPointerCapture(pid); } catch {}
    }
    if (!dragging) return;
    const rect = img.getBoundingClientRect();
    const scale = (S.mirror.w && S.mirror.h) ? Math.min(rect.width / S.mirror.w, rect.height / S.mirror.h) : 1;
    accDy += -(e.clientY - last.y) / scale; // dedo arriba → página baja (scroll natural)
    last = { x: e.clientX, y: e.clientY };
    const now = Date.now();
    if (now - lastSent > 90 && Math.abs(accDy) >= 10) {
      sendAction({ type: 'mirror', op: 'scroll', deltaY: Math.round(accDy) });
      accDy = 0; lastSent = now;
    }
  });

  const soltar = (e) => {
    if (pStart === null || e.pointerId !== pid) return;
    const fueArrastre = dragging;
    const t = Date.now() - pStart.t;
    pStart = null; last = null; pid = null;
    if (fueArrastre) {
      if (Math.abs(accDy) >= 10 && S.canControl) sendAction({ type: 'mirror', op: 'scroll', deltaY: Math.round(accDy) });
      accDy = 0;
      return; // fue desplazamiento, no clic
    }
    unlockAudio();
    if (!S.mirror.active) return;
    if (t > 600) return; // presión larga sin mover: ignorar
    if (!S.canControl) { toast('Solo el anfitrión controla el espejo'); return; }
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    /* v29: el servidor contesta si el toque dejó el foco en un cuadro de
     * texto de la página → abrimos (o cerramos) el teclado automáticamente */
    sendAction({ type: 'mirror', op: 'click', x: p.x, y: p.y })
      .then((r) => {
        if (!r || typeof r.typing !== 'boolean') return;
        if (r.typing) abrirTecladoEspejo();
        else cerrarTecladoEspejo();
      })
      .catch(() => {});
  };
  img.addEventListener('pointerup', soltar);
  img.addEventListener('pointercancel', () => { pStart = null; last = null; pid = null; dragging = false; accDy = 0; });
})();

/* v29: teclado inteligente — sin botón: se abre solo cuando el toque cayó en
 * un cuadro de texto de la página espejada y se cierra al tocar otra cosa */
let mkPrevio = '';
function abrirTecladoEspejo() {
  /* en escritorio manda el teclado físico directo: nada que abrir */
  if (!window.matchMedia('(pointer: coarse)').matches && window.innerWidth > 980) return;
  const inp = $('#mirrorKeys');
  $('#mkBar').classList.remove('hidden');
  inp.value = ''; mkPrevio = '';
  inp.focus(); // si el navegador lo permite, el teclado del celular sube solo
}
function cerrarTecladoEspejo() {
  $('#mkBar').classList.add('hidden');
  $('#mirrorKeys').blur();
}
$('#mkDone').addEventListener('click', cerrarTecladoEspejo);
(function () {
  const inp = $('#mirrorKeys');
  inp.addEventListener('input', () => {
    if (!S.mirror.active || !S.canControl) return;
    const v = inp.value;
    if (v.length > mkPrevio.length) {
      for (const ch of v.slice(mkPrevio.length)) sendAction({ type: 'mirror', op: 'type', text: ch });
    } else {
      for (let i = v.length; i < mkPrevio.length; i++) sendAction({ type: 'mirror', op: 'press', key: 'Backspace' });
    }
    mkPrevio = v;
    if (v.length > 40) { inp.value = ''; mkPrevio = ''; } // que no crezca sin fin
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.mirror.active && S.canControl) sendAction({ type: 'mirror', op: 'press', key: 'Enter' });
    }
  });
})();

/* teclado → se reenvía a la página espejada */
$('#mirrorLayer').addEventListener('keydown', (e) => {
  if (!S.mirror.active || !S.canControl) return;
  /* v27: si se está escribiendo en el input del teclado móvil, no reenviar dos veces */
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
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

/* v33: detener el espejo vive en la barra de arriba, junto a Salir */
$('#btnStopMirrorTop').addEventListener('click', () => {
  if (S.canControl) sendAction({ type: 'mirror', op: 'stop' });
  else toast('Solo el anfitrión controla el espejo');
});

/* v33: navegar el espejo como un navegador normal — atrás / adelante */
$('#btnMBack').addEventListener('click', () => {
  if (!S.mirror.active) return;
  if (!S.canControl) { toast('Solo el anfitrión controla el espejo'); return; }
  sendAction({ type: 'mirror', op: 'back' });
});
$('#btnMFwd').addEventListener('click', () => {
  if (!S.mirror.active) return;
  if (!S.canControl) { toast('Solo el anfitrión controla el espejo'); return; }
  sendAction({ type: 'mirror', op: 'fwd' });
});

/* iniciar espejo desde el selector (o cambiar de página sin detener) */
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
  $('#customRow').classList.add('hidden'); // la fila de URL solo se usa al escribirla
}
$('#btnMirror').addEventListener('click', startMirrorFromPicker);
$('#mirrorUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') startMirrorFromPicker(); });

/* v34: páginas recomendadas en desplegable propio CON LOGOS — un toque y a ver;
   la fila de URL solo aparece al elegir "Otra página" */
const SITES = [
  { name: 'Cuevana', full: 'Cuevana — películas y series', url: 'https://cuevana.mov/inicio', logo: '/sites/cuevana.png' },
  { name: 'GoPelis', full: 'GoPelis — películas', url: 'https://gopelis.com/', logo: '/sites/gopelis.png' },
  { name: 'AnimeD23', full: 'AnimeD23 — animes', url: 'https://animed23.com/', logo: '/sites/animed23.png' },
  { name: 'YouTube', full: 'YouTube — videos', url: 'https://www.youtube.com/', logo: '/sites/youtube.png' },
];
(function montarPaginas() {
  const btn = $('#pagePickBtn');
  const drop = $('#pageDrop');
  if (!btn || !drop) return;

  const setBtn = (logo, texto) => {
    const im = $('#pagePickLogo');
    if (logo) { im.src = logo; im.hidden = false; } else { im.hidden = true; im.removeAttribute('src'); }
    $('#pagePickName').textContent = texto;
  };

  const opciones = SITES.map((s) =>
    `<button class="page-opt" type="button" data-url="${s.url}" data-logo="${s.logo}" data-name="${s.name}">
      <img src="${s.logo}" class="site-logo" alt=""><span>${s.full}</span>
    </button>`
  ).join('') +
  `<button class="page-opt" type="button" data-url="" data-name="otra">
     <svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
     <span>Otra página (escribe la URL)…</span>
   </button>`;
  drop.innerHTML = opciones;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.classList.toggle('hidden');
  });
  drop.addEventListener('click', (e) => {
    const opt = e.target.closest('.page-opt');
    if (!opt) return;
    drop.classList.add('hidden');
    if (!opt.dataset.url) {
      /* "otra página": mostramos la fila de URL para escribir la dirección */
      $('#customRow').classList.remove('hidden');
      $('#mirrorUrl').value = '';
      $('#mirrorUrl').focus();
      setBtn('', 'Otra página…');
      return;
    }
    $('#customRow').classList.add('hidden');
    if (!S.canControl) { toast('Solo el anfitrión puede espejar'); return; }
    setBtn(opt.dataset.logo, opt.dataset.name);
    $('#mirrorUrl').value = opt.dataset.url;
    startMirrorFromPicker();
  });
  document.addEventListener('click', (e) => {
    if (!drop.classList.contains('hidden') && !e.target.closest('#pagePick')) drop.classList.add('hidden');
  });

  /* mientras se espeja, el botón muestra el sitio en pantalla */
  window.__setPagePick = (url) => {
    const s = SITES.find((x) => url && url.startsWith(x.url.replace(/\/$/, '')));
    if (s) setBtn(s.logo, s.name);
    else if (url) setBtn('', 'Página actual');
    else setBtn('', 'Elige una página…');
  };
})();

function updateControlUi() {
  const isHost = S.room && S.room.hostId === S.userId;
  $('#pagePickBtn').disabled = !S.canControl;
  $('#btnMirror').disabled = !S.canControl;
  $('#mirrorUrl').disabled = !S.canControl;
  $('#btnStopMirrorTop').disabled = !S.canControl;
  $('#btnMBack').disabled = !S.canControl;
  $('#btnMFwd').disabled = !S.canControl;
  $('#chkControl').checked = !!(S.room && S.room.anyoneCanControl);
  $('#chkControl').disabled = !isHost;
  $('#lockHint').textContent = S.canControl ? '' : 'Solo el anfitrión controla el espejo';
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
  $('#userCountTop').textContent = users ? users.length : 0;
  updateControlUi();
}

/* v33: la lista de gente se despliega desde el chip de la barra de arriba */
$('#btnUsers').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#usersDrop').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  const drop = $('#usersDrop');
  if (!drop.classList.contains('hidden') && !drop.contains(e.target) && e.target.id !== 'btnUsers') {
    drop.classList.add('hidden');
  }
});

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
  /* v28: en pantalla completa no se ve el chat → tira deslizante abajo (estilo Rave) */
  if (fsActive()) ticker.push(msg);
}

/* v28: la tira de mensajes de pantalla completa — cada mensaje entra por la
 * derecha con el nombre en color y sale por la izquierda; uno a la vez */
const ticker = {
  q: [], busy: false,
  push(msg) {
    const nombre = msg.system ? '' : (msg.name || '');
    const texto = String(msg.system ? '⚡ ' + (msg.text || '') : (msg.text || '')).slice(0, 220);
    this.q.push({ nombre, texto });
    if (this.q.length > 5) this.q = this.q.slice(-5); // sin acumular atrasos
    this.run();
  },
  async run() {
    if (this.busy) return;
    this.busy = true;
    const strip = $('#msgTicker'), inner = $('#msgTickerInner');
    while (this.q.length) {
      const { nombre, texto } = this.q.shift();
      $('#msgTickerName').textContent = nombre ? nombre + ':' : '';
      $('#msgTickerBody').textContent = ' ' + texto;
      strip.classList.add('run');
      // medir cuánto debe viajar: ancho de la tira + ancho del texto
      const dist = strip.clientWidth + inner.offsetWidth + 12;
      const dur = Math.max(5000, (dist / 80) * 1000); // ~80 px/s: lectura cómoda
      const anim = inner.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${dist}px)` }],
        { duration: dur, easing: 'linear' }
      );
      await anim.finished.catch(() => {});
      try { anim.cancel(); } catch {}
    }
    strip.classList.remove('run');
    this.busy = false;
  },
};

/* ======================= controles ======================= */

/* v33: sin video propio — la pausa y el avance se hacen sobre la página espejada */

/* pantalla completa (v33: solo espejo — sin video propio): el contenedor se
 * maximiza. iPhones no soportan la API de pantalla completa en divs, así que
 * usamos una pantalla completa simulada: el reproductor se fija cubriendo
 * toda la ventana, con botón para salir. */
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
  } else {
    enterPseudoFs(); // iPhone (o navegador sin la API): pantalla completa simulada
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
$('#chkControl').addEventListener('change', (e) => {
  sendAction({ type: 'mode', anyoneCanControl: e.target.checked });
});

/* ======================= chat ======================= */

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (text) { sendAction({ type: 'chat', text }); input.value = ''; }
  /* v33: en celular, al enviar con Enter el teclado se cierra para que
   * la película vuelva a ocupar la pantalla; se reabre al tocar el cuadro */
  if (text && window.matchMedia && matchMedia('(pointer: coarse)').matches) {
    try { input.blur(); } catch {}
  }
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

/* ======================= pantalla de inicio (v31) =======================
 * identidad: nombre de usuario único recordado por dispositivo */

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('rr-profile') || 'null') || null; } catch { return null; }
}

function initLanding() {
  S.profile = loadProfile();
  const tiene = !!S.profile;
  $('#profileBox').classList.toggle('hidden', tiene);
  $('#homeBox').classList.toggle('hidden', !tiene);
  if (tiene) {
    $('#profileName').textContent = S.profile.name;
    const av = $('#profileAvatar');
    av.textContent = (S.profile.name[0] || '?').toUpperCase();
    av.style.setProperty('--h', hashHue(S.profile.name));
    pollRooms();
  } else {
    const inpU = $('#userNick');
    inpU.value = ''; // v32: sin el nombre viejo pegado tras "cambiar"
    try { inpU.focus(); } catch {}
  }
}

async function loginNombre() {
  const name = $('#userNick').value.trim().replace(/\s+/g, ' ');
  if (name.length < 3) { toast('El nombre necesita al menos 3 letras'); return; }
  /* v32: si este dispositivo ya tuvo ese nombre, mandamos su token para
   * volver a entrar sin que diga "ya está tomado" (tras usar "cambiar") */
  let savedTok = '';
  try {
    const all = JSON.parse(localStorage.getItem('rr-profiles') || '{}');
    savedTok = (all[name.toLowerCase()] || {}).token || '';
  } catch {}
  $('#btnLogin').disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token: savedTok }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || 'No se pudo registrar el nombre'); return; }
    S.profile = { name: d.name, token: d.token };
    localStorage.setItem('rr-profile', JSON.stringify(S.profile));
    try {
      const all = JSON.parse(localStorage.getItem('rr-profiles') || '{}');
      all[d.name.toLowerCase()] = { name: d.name, token: d.token };
      localStorage.setItem('rr-profiles', JSON.stringify(all));
    } catch {}
    initLanding();
    toast(d.resumed ? `¡De vuelta, ${d.name}!` : (d.reclaimed ? `¡Bienvenido de vuelta, ${d.name}!` : `¡Listo, ${d.name}! Ese nombre es tuyo 🎉`), 4200);
  } catch { toast('Sin conexión con el servidor'); }
  finally { $('#btnLogin').disabled = false; }
}
$('#btnLogin').addEventListener('click', loginNombre);
$('#userNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginNombre(); });
$('#btnSwitch').addEventListener('click', () => {
  S.profile = null;
  localStorage.removeItem('rr-profile');
  initLanding();
});

/* ---- salas en vivo con preview (estilo Rave) ---- */
/* v32: logo del sitio espejado para la tarjeta (o null si no lo tenemos) */
const SITE_LOGOS = {
  'cuevana.mov': '/sites/cuevana.png',
  'gopelis.com': '/sites/gopelis.png',
  'youtube.com': '/sites/youtube.png',
  'animed23.com': '/sites/animed23.png',
};
function siteLogoFor(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (SITE_LOGOS[h]) return SITE_LOGOS[h];
  for (const k of Object.keys(SITE_LOGOS)) if (h.endsWith('.' + k)) return SITE_LOGOS[k];
  return null;
}
let roomsTimer = null;
async function pollRooms() {
  const landing = $('#landing');
  if (!landing || landing.classList.contains('hidden')) return;
  try {
    const r = await fetch('/api/rooms');
    const d = await r.json();
    if (!d.ok) return;
    const box = $('#liveRooms');
    box.innerHTML = '';
    $('#noRooms').classList.toggle('hidden', (d.rooms || []).length > 0);
    (d.rooms || []).forEach((rm) => {
      const card = document.createElement('button');
      card.className = 'room-card';
      /* v32: preview ligera — el logo del sitio donde están (sin fotogramas) */
      const logo = rm.isMirror ? siteLogoFor(rm.host) : null;
      const prev = logo
        ? '<img src="' + logo + '" class="site-logo-big" alt="">'
        : '<span class="room-emoji">' + (rm.isMirror ? '🪞' : (rm.watching ? '🎬' : '💬')) + '</span>';
      card.innerHTML =
        '<div class="room-prev">' + prev + '<span class="room-live"><span class="live-dot"></span>' + rm.count + '</span></div>' +
        '<div class="room-info">' +
          '<div class="room-watch">' + (rm.watching ? escapeHtml(rm.watching) : 'Solo charlando') + '</div>' +
          '<div class="room-users">' + rm.users.map(escapeHtml).join(' · ') + '</div>' +
        '</div>';
      card.addEventListener('click', () => connect(rm.code, { mustExist: true }));
      box.appendChild(card);
    });
  } catch {}
}
roomsTimer = setInterval(pollRooms, 5000);

$('#btnCreate').addEventListener('click', () => {
  if (!S.profile) { toast('Primero elige tu nombre de usuario'); initLanding(); return; }
  const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  connect(code);
});

function joinFromInput() {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) { toast('Código inválido (4-8 letras/números)'); return; }
  connect(code, { mustExist: true });
}
$('#btnJoin').addEventListener('click', joinFromInput);
$('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });

/* estado inicial */
initLanding();
const hashMatch = /^#([A-Za-z0-9]{4,8})$/.exec(location.hash);
if (hashMatch) $('#joinCode').value = hashMatch[1].toUpperCase();

/* v35: sin zoom con los dedos — en iPhone el meta viewport se ignora,
   hay que cancelar el gesto de pellizco a mano */
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
});
