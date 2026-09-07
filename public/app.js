'use strict';
/* Huddle — cliente: sincronización de reproducción, chat y presencia. */

const $ = (s) => document.querySelector(s);

const APP_VERSION = 'v52';

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

    /* v43: si vienen del menú con página elegida, el espejo arranca solo */
    if (S.pendingStart) {
      const ps = S.pendingStart;
      S.pendingStart = null;
      if (ps.url && !S.mirror.active) {
        setTimeout(() => {
          if (S.canControl && !S.mirror.active) {
            $('#mirrorUrl').value = ps.url;
            startMirrorFromPicker();
            toast(`Preparando ${ps.name || 'la página'}…`);
          }
        }, 700);
      }
    }

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
    pedirPantallaActiva(); // v42: mientras se mira, la pantalla no se apaga
    /* v43: recordar la última página espejada para el menú de crear sala */
    try {
      const ms2 = SITES.find((x) => S.mirror.url && S.mirror.url.startsWith(x.url.replace(/\/$/, '')));
      let nm = ms2 ? ms2.name : '';
      if (!nm) { try { nm = new URL(S.mirror.url).hostname.replace(/^www\./, ''); } catch {} }
      localStorage.setItem('rr-lastMirror', JSON.stringify({ url: S.mirror.url, name: nm, logo: ms2 ? ms2.logo : '' }));
    } catch {}
    // si el audio quedó suspendido de una sesión anterior, reactivarlo
    if (AU.needAudio && AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume().catch(() => {});
    if (AU.needAudio && AU.outEl && AU.outEl.paused) AU.outEl.play().catch(() => {}); // v44
    // pantalla de carga hasta que llegue el primer frame
    if (!S.mirror.gotFrame) $('#mirrorLoading').classList.remove('hidden');
  } else {
    /* v36: al detener NO se resetea el botón — la página elegida se queda
       mostrada, lista para volver a espejar con un toque */
    S.mirror.gotFrame = false;
    soltarPantallaActiva(); // v42: sin espejo, la pantalla puede apagarse normal
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
  node._stats = stats;
  return { node, port, fallback: true }; // v44: la conexión la hace conectarSalidaAudio
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
  } catch (e) {
    console.warn('[Huddle] AudioWorklet no disponible, usando alternativa', e);
    AU.node = makeFallbackNode(AU.ctx);
  }
  conectarSalidaAudio(AU.ctx, AU.node);
  return AU.ctx;
}

/* v44: LA SALIDA DEL AUDIO VA POR UN ELEMENTO <audio>.
 * Desde iOS 16.3 el audio directo de Web Audio se calla con el switch de
 * silencio del iPhone, pero los elementos de audio/video NO (el sistema los
 * trata como reproducción). Sacamos la MISMA señal del worklet por un
 * MediaStream a un <audio> oculto: mismo sonido, misma latencia, y suena
 * aunque el teléfono esté silenciado. Si el navegador no lo permite,
 * caemos a la salida directa de siempre. */
function conectarSalidaAudio(ctx, node) {
  try {
    AU.streamDest = ctx.createMediaStreamDestination();
    node.connect(AU.streamDest);
    if (!AU.outEl) {
      AU.outEl = document.createElement('audio');
      AU.outEl.setAttribute('playsinline', '');
      AU.outEl.style.display = 'none';
      document.body.appendChild(AU.outEl);
    }
    AU.outEl.srcObject = AU.streamDest.stream;
    const pr = AU.outEl.play();
    if (pr && pr.then) {
      pr.then(() => { AU.salidaElemento = true; }).catch(() => salidaDirecta(ctx, node));
    } else {
      AU.salidaElemento = true; // API vieja: asumimos que sonó
    }
  } catch { salidaDirecta(ctx, node); }
}
function salidaDirecta(ctx, node) {
  AU.salidaElemento = false;
  try { node.disconnect(AU.streamDest); } catch {}
  try { node.connect(ctx.destination); } catch {}
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
  if (AU.outEl) { try { AU.outEl.pause(); } catch {} } // v44: soltar la sesión de audio
  $('#audioChip').classList.add('hidden');
}

/* el chip de audio aparece cuando el navegador bloquea el sonido (autoplay) */
$('#audioChip').addEventListener('click', async () => {
  const ctx = await ensureAudioCtx();
  if (ctx) { try { await ctx.resume(); } catch {} }
  if (AU.outEl) { try { await AU.outEl.play(); AU.salidaElemento = true; } catch {} }
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
/* v43: el directorio de páginas ya no está clavado — parte de estos 4 y se
 * actualiza con lo que guarda el servidor (data/sites.json) */
let SITES = [
  { name: 'Cuevana', full: 'Cuevana — películas y series', url: 'https://cuevana.mov/', logo: '/sites/cuevana.png' },
  { name: 'GoPelis', full: 'GoPelis — películas', url: 'https://gopelis.com/', logo: '/sites/gopelis.png' },
  { name: 'AnimeD23', full: 'AnimeD23 — animes', url: 'https://animed23.com/', logo: '/sites/animed23.png' },
  { name: 'AnimeFLV', full: 'AnimeFLV — animes sub y latino', url: 'https://vww.animeflv.one/', logo: 'https://www.google.com/s2/favicons?domain=animeflv.one&sz=128' },
  { name: 'YouTube', full: 'YouTube — videos', url: 'https://www.youtube.com/', logo: '/sites/youtube.png' },
];
function renderPageDrop() {
  const drop = $('#pageDrop');
  if (!drop) return;
  drop.innerHTML = '';
  /* v48: al principio de la lista — buscar series o películas */
  const buscar = document.createElement('div');
  buscar.className = 'pd-search';
  buscar.innerHTML = `
    <input id="pdSearch" class="input" placeholder="Buscar series o películas…" autocomplete="off" spellcheck="false" autocapitalize="none" autocorrect="off">
    <button id="pdGo" class="btn primary small" type="button">Buscar</button>`;
  drop.appendChild(buscar);
  const pdRes = document.createElement('div');
  pdRes.id = 'pdResults';
  pdRes.className = 'pd-results';
  drop.appendChild(pdRes);
  SITES.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'page-opt';
    b.type = 'button';
    b.dataset.url = s.url;
    b.dataset.logo = s.logo;
    b.dataset.name = s.name;
    const im = document.createElement('img');
    im.src = s.logo; im.className = 'site-logo'; im.alt = '';
    const sp = document.createElement('span');
    sp.textContent = s.full || s.name;
    b.append(im, sp);
    drop.appendChild(b);
  });
  const otra = document.createElement('button');
  otra.className = 'page-opt';
  otra.type = 'button';
  otra.dataset.url = '';
  otra.dataset.name = 'otra';
  otra.innerHTML = '<svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span>Otra página (escribe la URL)…</span>';
  drop.appendChild(otra);
}
(function montarPaginas() {
  const btn = $('#pagePickBtn');
  const drop = $('#pageDrop');
  if (!btn || !drop) return;

  const setBtn = (logo, texto) => {
    const im = $('#pagePickLogo');
    if (logo) { im.src = logo; im.hidden = false; } else { im.hidden = true; im.removeAttribute('src'); }
    $('#pagePickName').textContent = texto;
  };

  renderPageDrop();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.classList.toggle('hidden');
  });
  /* v48: Enter en la caja de búsqueda del desplegable */
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'pdSearch') { e.preventDefault(); buscarEnPicker(); }
  });
  drop.addEventListener('click', (e) => {
    if (e.target.closest('#pdGo')) { buscarEnPicker(); return; }
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

  /* mientras se espeja, el botón muestra el sitio en pantalla;
     si es una URL propia, muestra su nombre de dominio */
  window.__setPagePick = (url) => {
    const s = SITES.find((x) => url && url.startsWith(x.url.replace(/\/$/, '')));
    if (s) setBtn(s.logo, s.name);
    else if (url) {
      let host = 'Página actual';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
      setBtn('', host);
    }
    else setBtn('', 'Elige una página…');
  };
})();

/* v43: cargar el directorio real del servidor (crece al pegar URLs) */
async function cargarSitios() {
  try {
    const r = await fetch('/api/sites');
    const d = await r.json();
    if (d.ok && Array.isArray(d.sites) && d.sites.length) {
      SITES = d.sites.map((s) => ({ ...s, full: s.desc ? `${s.name} — ${s.desc}` : s.name }));
      renderPageDrop();
      renderSetupGrid();
      renderLastCard();
    }
  } catch { /* sin directorio: seguimos con los 4 de siempre */ }
}
cargarSitios();

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
  /* v42: aviso sonoro suave cuando ENTRA alguien nuevo
     (la primera lista no suena — es el estado inicial de la sala) */
  if (Array.isArray(users)) {
    const nombres = users.map((u) => u.name);
    if (prevUsers && nombres.some((n) => !prevUsers.includes(n))) sonidoEntrada();
    prevUsers = nombres;
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
    sp.appendChild(document.createTextNode(' '));
    sp.appendChild(adornarEmojis(msg.text)); /* v52: emojis animados dentro del mensaje */
    div.appendChild(b); div.appendChild(sp);
  }
  log.appendChild(div);
  /* v24: no acumular mensajes viejos en pantalla (el servidor igual guarda 100) */
  while (log.children.length > 80) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  /* v51: mensaje de puros emojis → se ve GRANDE con animación y vuela
   * sobre la película (estilo sticker) */
  const emo = msg.system ? '' : emojisDelMensaje(msg.text);
  if (emo) {
    div.classList.add('solo-emojis');
    div.textContent = '';
    div.appendChild(adornarEmojis(emo));
  }
  /* v50: si están escribiendo con el teclado abierto, la mini-vista de
     arriba de la caja también se actualiza */
  if (document.body.classList.contains('escribiendo-chat')) actualizarChatMini();
  /* v28: en pantalla completa no se ve el chat → tira deslizante abajo (estilo Rave) */
  if (fsActive()) ticker.push(msg);
}

/* v51: ¿el mensaje es solo emojis (1-3)? → devuelve el emoji para mostrarlo grande */
function emojisDelMensaje(texto) {
  const t = String(texto || '').trim();
  if (!t || t.length > 24) return '';
  let clusters = [...t];
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      clusters = [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(t)].map((s) => s.segment);
    }
  } catch {}
  const partes = clusters.filter((c) => c.trim());
  const esEmoji = (c) => { try { return /\p{Extended_Pictographic}/u.test(c); } catch { return false; } };
  if (partes.length && partes.length <= 3 && partes.every(esEmoji)) return partes.join('');
  return '';
}

/* v52: cada emoji del mensaje va envuelto en un span con SU animación
 * (llorar llora, corazón late, fuego parpadea…) como los chats modernos */
function claseDeEmoji(c) {
  if (c.includes('😂') || c.includes('🤣')) return 'e-risa';
  if (c.includes('😭') || c.includes('😢')) return 'e-llanto';
  if (/[❤💗💖💕💘💝]/u.test(c)) return 'e-corazon';
  if (c.includes('🔥')) return 'e-fuego';
  if (c.includes('😍') || c.includes('🥰')) return 'e-enamorado';
  if (c.includes('😡') || c.includes('😠')) return 'e-enojo';
  if (c.includes('👍') || c.includes('👎')) return 'e-pulgar';
  if (c.includes('😱') || c.includes('😲')) return 'e-sorpresa';
  if (/[😀😃😄🙂😊😎🤗]/u.test(c)) return 'e-risa';
  return 'e-generico';
}

function adornarEmojis(texto) {
  const frag = document.createDocumentFragment();
  const t = String(texto || '');
  let clusters = [...t];
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      clusters = [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(t)].map((s) => s.segment);
    }
  } catch {}
  clusters.forEach((c) => {
    let esEmoji = false;
    try { esEmoji = /\p{Extended_Pictographic}/u.test(c); } catch {}
    if (esEmoji) {
      const sp = document.createElement('span');
      sp.className = 'emoji-anim ' + claseDeEmoji(c);
      sp.textContent = c;
      frag.appendChild(sp);
    } else {
      frag.appendChild(document.createTextNode(c));
    }
  });
  return frag;
}

/* v50: mini-vista de los últimos mensajes, visible al escribir en el chat */
function actualizarChatMini() {
  const mini = $('#chatMini');
  const log = $('#chatLog');
  if (!mini || !log) return;
  mini.innerHTML = '';
  const ultimos = [...log.children].slice(-2);
  if (!ultimos.length) {
    const v = document.createElement('div');
    v.className = 'cm-vacio';
    v.textContent = 'Aún no hay mensajes';
    mini.appendChild(v);
    return;
  }
  ultimos.forEach((m) => mini.appendChild(m.cloneNode(true)));
  mini.scrollTop = mini.scrollHeight;
}

/* v28: la tira de mensajes de pantalla completa — cada mensaje entra por la
 * derecha con el nombre en color y sale por la izquierda; uno a la vez */
const ticker = {
  q: [], busy: false,
  push(msg) {
    const nombre = msg.system ? '' : (msg.name || '');
    const texto = String(msg.system ? (msg.text || '') : (msg.text || '')).slice(0, 220);
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
  const msg = `¡Únete a mi sala en Huddle!\n${link}`;
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
  /* v44: con sesión, el inicio es una pantalla completa estilo app;
   * sin sesión, la tarjetita de "elige tu nombre" */
  $('#profileBox').classList.toggle('hidden', tiene);
  document.querySelector('.landing-card').classList.toggle('hidden', tiene);
  $('#homeFull').classList.toggle('hidden', !tiene);
  $('#landing').classList.toggle('home-mode', tiene);
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
    toast(d.resumed ? `¡De vuelta, ${d.name}!` : (d.reclaimed ? `¡Bienvenido de vuelta, ${d.name}!` : `¡Listo, ${d.name}! Ese nombre es tuyo`), 4200);
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
        : '<span class="room-emoji">' + (rm.isMirror
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>'
            : (rm.watching
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>')) + '</span>';
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
  abrirSetup(); // v43: antes de entrar, eliges con qué página arrancar
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

/* v50: el teclado flotante SOLO es para la bandeja de mensajes — las
 * búsquedas y demás cajas se comportan normal. Al escribir en el chat:
 * la película no se mueve, la caja sube pegada al teclado y encima de la
 * caja va una mini-vista con los últimos mensajes (para ver lo que escriben). */
if (window.visualViewport) {
  const vv = window.visualViewport;
  let raf = 0;
  const acomodarTeclado = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const f = document.querySelector('#chatForm');
      if (!f) return;
      const foco = document.activeElement;
      const enCaja = !!(foco && foco.id === 'chatInput');
      document.body.classList.toggle('escribiendo-chat', enCaja);
      if (enCaja) actualizarChatMini();
      const kb = enCaja ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      document.body.style.setProperty('--kb', kb > 40 ? kb + 'px' : '0px');
      if (enCaja && window.scrollY) window.scrollTo(0, 0);
      if (enCaja && kb > 40) {
        /* caja pegada arriba del teclado: posición calculada con la vista real */
        const top = Math.round(vv.offsetTop + vv.height - f.offsetHeight - 8);
        f.style.top = top + 'px';
        f.style.bottom = 'auto';
      } else {
        f.style.top = '';
        f.style.bottom = '';
      }
    });
  };
  vv.addEventListener('resize', acomodarTeclado);
  vv.addEventListener('scroll', acomodarTeclado);
  document.addEventListener('focusin', acomodarTeclado);
  document.addEventListener('focusout', () => setTimeout(acomodarTeclado, 80));
  acomodarTeclado();
  /* v52: auto-reparación — iOS a veces se traga los avisos; re-chequeamos
   * seguido mientras estás en la sala para que la burbuja NUNCA falle */
  setInterval(() => {
    const room = document.querySelector('#room');
    if (room && !room.classList.contains('hidden')) acomodarTeclado();
  }, 400);
}
/* v51: la mini-vista debe aparecer SIEMPRE que se toca la caja del chat —
 * listeners directos además de los de arriba, para que no falle nunca */
(function() {
  const ci = document.querySelector('#chatInput');
  if (!ci) return;
  ci.addEventListener('focus', () => {
    document.body.classList.add('escribiendo-chat');
    actualizarChatMini();
  });
  ci.addEventListener('blur', () => setTimeout(() => {
    if (!(document.activeElement && document.activeElement.id === 'chatInput')) {
      document.body.classList.remove('escribiendo-chat');
    }
  }, 60));
})();

/* ======================= v42: pantalla activa + aviso de entrada ======================= */

/* mientras se mira el espejo, la pantalla del celular no se apaga
   (Wake Lock — necesita HTTPS, que ya tenemos con el dominio) */
function pedirPantallaActiva() {
  try {
    if ('wakeLock' in navigator && !S.wakeLock && document.visibilityState === 'visible') {
      navigator.wakeLock.request('screen').then((wl) => {
        S.wakeLock = wl;
        wl.addEventListener('release', () => { S.wakeLock = null; });
      }).catch(() => {});
    }
  } catch {}
}
function soltarPantallaActiva() {
  try { if (S.wakeLock) S.wakeLock.release().catch(() => {}); } catch {}
  S.wakeLock = null;
}
/* si el celular se sale y vuelve a la app, re-pedir el bloqueo */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.mirror.active) pedirPantallaActiva();
});

/* "pop" suave de dos notitas cuando entra alguien a la sala */
let popCtx = null;
function sonidoEntrada() {
  try {
    popCtx = popCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (popCtx.state === 'suspended') popCtx.resume().catch(() => {});
    const t = popCtx.currentTime;
    const o = popCtx.createOscillator();
    const g = popCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(587, t);
    o.frequency.setValueAtTime(784, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(popCtx.destination);
    o.start(t);
    o.stop(t + 0.3);
  } catch {}
}
let prevUsers = null;

/* ======================= v43: preparar la sala antes de entrar ======================= */
S.setupUrl = '';
S.setupName = '';
S.pendingStart = null;

function setupMsg(t, ok) {
  const el = $('#setupMsg');
  el.textContent = t || '';
  el.classList.toggle('hidden', !t);
  el.classList.toggle('okmsg', !!ok);
}

function crearCardSitio(s, removable) {
  const card = document.createElement('div');
  card.className = 'setup-card' + (S.setupUrl === s.url ? ' sel' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.innerHTML = `
    <span class="sc-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
    <img class="sc-logo" src="${s.logo || ''}" alt="">
    <span class="sc-name"></span>
    <span class="sc-desc"></span>`;
  card.querySelector('.sc-name').textContent = s.name;
  card.querySelector('.sc-desc').textContent = s.desc || '';
  if (!s.logo) {
    card.querySelector('.sc-logo').outerHTML = '<svg class="sc-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  }
  if (removable) {
    const x = document.createElement('button');
    x.className = 'sc-x';
    x.type = 'button';
    x.title = 'Quitar del directorio';
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    card.appendChild(x);
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('.sc-x')) { quitarSitio(s); return; }
    elegirSetup(s.url, s.name);
  });
  return card;
}

function renderSetupGrid() {
  const grid = $('#setupGrid');
  if (!grid) return;
  grid.innerHTML = '';
  /* v44: sin botón de borrar — las opciones solo se eligen */
  SITES.forEach((s) => grid.appendChild(crearCardSitio(s, false)));
}

function renderLastCard() {
  const box = $('#lastCard');
  if (!box) return;
  box.innerHTML = '';
  let last = null;
  try { last = JSON.parse(localStorage.getItem('rr-lastMirror') || 'null'); } catch {}
  if (!last || !last.url) return;
  const lbl = document.createElement('div');
  lbl.className = 'setup-label';
  lbl.textContent = 'Continuar donde se quedaron';
  const card = crearCardSitio({ name: last.name || 'Última página', desc: last.url, url: last.url, logo: last.logo || '' }, false);
  box.append(lbl, card);
}

function elegirSetup(url, name) {
  if (S.setupUrl === url) { S.setupUrl = ''; S.setupName = ''; }
  else { S.setupUrl = url; S.setupName = name || ''; }
  renderSetupGrid();
  renderLastCard();
  /* v47: títulos largos (de la búsqueda) se recortan en el botón para que no rompa */
  const corto = S.setupName.length > 26 ? S.setupName.slice(0, 26).trim() + '…' : S.setupName;
  $('#btnCreateGo').textContent = S.setupUrl ? `Crear y espejar ${corto}` : 'Crear la sala';
}

function abrirSetup() {
  S.setupUrl = '';
  S.setupName = '';
  $('#setupBox').classList.remove('hidden');
  $('#homeMain').classList.add('hidden');
  setupMsg('');
  $('#setupSearch').value = '';
  $('#setupResults').classList.add('hidden');
  $('#setupResults').innerHTML = '';
  $('#btnCreateGo').textContent = 'Crear la sala';
  renderSetupGrid();
  renderLastCard();
  window.scrollTo(0, 0);
}

function cerrarSetup() {
  $('#setupBox').classList.add('hidden');
  $('#homeMain').classList.remove('hidden');
  pollRooms();
}

async function quitarSitio(s) {
  try {
    const r = await fetch('/api/sites?url=' + encodeURIComponent(s.url), { method: 'DELETE' });
    const d = await r.json();
    if (d.ok && Array.isArray(d.sites)) {
      SITES = d.sites.map((x) => ({ ...x, full: x.desc ? `${x.name} — ${x.desc}` : x.name }));
      renderPageDrop();
      renderSetupGrid();
      if (S.setupUrl === s.url) { S.setupUrl = ''; S.setupName = ''; $('#btnCreateGo').textContent = 'Crear la sala'; }
    }
  } catch { toast('No pude quitar la página'); }
}

async function agregarSitioSetup() {
  const inp = $('#newSiteUrl');
  const raw = inp.value.trim();
  if (!raw) { toast('Pega la dirección de la página'); return; }
  const btn = $('#btnAddSite');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  setupMsg('');
  try {
    const r = await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: raw }) });
    const d = await r.json();
    if (!d.ok) { setupMsg(d.error || 'No pude leer esa página'); return; }
    const s = d.site;
    if (!SITES.some((x) => x.url === s.url)) SITES = [{ ...s, full: s.desc ? `${s.name} — ${s.desc}` : s.name }, ...SITES];
    renderPageDrop();
    renderSetupGrid();
    elegirSetup(s.url, s.name);
    inp.value = '';
    setupMsg(d.exists ? `Ya estaba en el directorio: ${s.name}` : `Agregada: ${s.name}`, true);
  } catch { setupMsg('Sin conexión con el servidor'); }
  finally { btn.disabled = false; btn.textContent = 'Agregar'; }
}

$('#setupBack').addEventListener('click', cerrarSetup);
$('#btnAddSite').addEventListener('click', agregarSitioSetup);
$('#newSiteUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') agregarSitioSetup(); });
$('#btnCreateGo').addEventListener('click', () => {
  S.pendingStart = S.setupUrl ? { url: S.setupUrl, name: S.setupName } : null;
  const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  connect(code);
});

/* v45: buscador — busca en la web (DuckDuckGo/Bing vía el server) y muestra
 * resultados listos para crear la sala o navegar el espejo */
/* v50: resultados como cartelera — filas horizontales deslizables por página,
 * carátula grande, nombre abajo y el logo de la página en la esquina */
function logoDeSitio(nombre) {
  const s = (typeof SITES !== 'undefined' ? SITES : []).find((x) => x.name === nombre);
  if (s && s.logo) return s.logo;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(String(nombre).toLowerCase())}&sz=64`;
}

function renderResultados(box, results, alElegir, conAnime) {
  box.innerHTML = '';
  const porSitio = new Map();
  results.forEach((r) => {
    if (!porSitio.has(r.site)) porSitio.set(r.site, []);
    porSitio.get(r.site).push(r);
  });
  const crearTarjeta = (res) => {
    const card = document.createElement('button');
    card.className = 'sr-card';
    card.type = 'button';
    card.innerHTML = `
      <span class="sr-badge"><img src="${logoDeSitio(res.site)}" alt=""></span>
      ${res.img
        ? `<img class="sr-cover" src="${res.img}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="sr-cover sr-cover-anime"><img src="${logoDeSitio(res.site)}" alt=""></span>`}
      <span class="sr-nombre"></span>
      ${res.extra ? '<span class="sr-extra"></span>' : ''}`;
    card.querySelector('.sr-nombre').textContent = res.title;
    const ex = card.querySelector('.sr-extra');
    if (ex) ex.textContent = res.extra || '';
    card.addEventListener('click', () => alElegir(res, card));
    return card;
  };
  const crearSeccion = (sitio) => {
    const sec = document.createElement('div');
    sec.className = 'sr-sec';
    const t = document.createElement('div');
    t.className = 'sr-sec-titulo';
    t.innerHTML = `<img src="${logoDeSitio(sitio)}" alt="">`;
    const tt = document.createElement('span');
    tt.textContent = sitio;
    t.appendChild(tt);
    const fila = document.createElement('div');
    fila.className = 'sr-fila';
    sec.append(t, fila);
    box.appendChild(sec);
    return fila;
  };
  porSitio.forEach((items, sitio) => {
    const fila = crearSeccion(sitio);
    items.forEach((res) => fila.appendChild(crearTarjeta(res)));
  });
  /* respaldo de anime: si AnimeFLV no tuvo resultados, la tarjeta abre
   * AnimeD23 para buscar adentro con el teclado del espejo */
  if (conAnime && !porSitio.has('AnimeFLV') && !porSitio.has('AnimeD23')) {
    const fila = crearSeccion('AnimeD23');
    fila.appendChild(crearTarjeta({ url: 'https://animed23.com/', title: 'Buscar dentro de AnimeD23', site: 'AnimeD23', extra: 'la búsqueda de anime va dentro de su página', img: '' }));
  }
}

async function buscarEnServer(q) {
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  return r.json();
}

async function buscarInicio() {
  const q = $('#homeSearch').value.trim();
  const box = $('#searchResults');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="sr-info"><div class="spinner"></div> Buscando…</div>';
  try {
    const d = await buscarEnServer(q);
    if (!d.ok || !d.results || !d.results.length) {
      box.innerHTML = `<div class="sr-info">${(d && d.error) || 'No encontré nada — prueba con otras palabras'}</div>`;
      return;
    }
    renderResultados(box, d.results, (res) => {
      S.pendingStart = { url: res.url, name: res.site };
      const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      connect(code);
    }, true);
  } catch {
    box.innerHTML = '<div class="sr-info">Sin conexión con el servidor</div>';
  }
}
$('#btnHomeSearch').addEventListener('click', buscarInicio);
$('#homeSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarInicio(); } });

/* v47: buscador también al preparar la sala — el resultado se ELIGE (como las
 * tarjetas) y el botón grande queda listo con "Crear y espejar …" */
async function buscarSetup() {
  const q = $('#setupSearch').value.trim();
  const box = $('#setupResults');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="sr-info"><div class="spinner"></div> Buscando…</div>';
  try {
    const d = await buscarEnServer(q);
    if (!d.ok || !d.results || !d.results.length) {
      box.innerHTML = `<div class="sr-info">${(d && d.error) || 'No encontré nada — prueba con otras palabras'}</div>`;
      return;
    }
    renderResultados(box, d.results, (res, card) => {
      elegirSetup(res.url, res.title);
      const elegida = S.setupUrl === res.url;
      box.querySelectorAll('.sr-card').forEach((c) => c.classList.remove('sel'));
      if (elegida) {
        card.classList.add('sel');
        $('#btnCreateGo').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, true);
  } catch {
    box.innerHTML = '<div class="sr-info">Sin conexión con el servidor</div>';
  }
}
$('#btnSetupSearch').addEventListener('click', buscarSetup);
$('#setupSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarSetup(); } });

/* v45: buscar otra página SIN salir de la sala (mientras se espeja) */
function cerrarBuscarSala() {
  $('#msBar').classList.add('hidden');
  $('#msResults').classList.add('hidden');
}
async function buscarEnSala() {
  const q = $('#msInput').value.trim();
  const box = $('#msResults');
  if (!q) { cerrarBuscarSala(); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="sr-info"><div class="spinner"></div> Buscando…</div>';
  try {
    const d = await buscarEnServer(q);
    if (!d.ok || !d.results || !d.results.length) {
      box.innerHTML = `<div class="sr-info">${(d && d.error) || 'No encontré nada — prueba con otras palabras'}</div>`;
      return;
    }
    renderResultados(box, d.results, (res) => {
      cerrarBuscarSala();
      if (!S.canControl) { toast('Solo el anfitrión puede cambiar de página'); return; }
      toast(`Abriendo ${res.site}…`);
      $('#mirrorUrl').value = res.url;
      startMirrorFromPicker();
    }, true);
  } catch {
    box.innerHTML = '<div class="sr-info">Sin conexión con el servidor</div>';
  }
}
$('#btnMSearch').addEventListener('click', () => {
  const bar = $('#msBar');
  if (bar.classList.contains('hidden')) {
    bar.classList.remove('hidden');
    $('#msInput').focus();
  } else cerrarBuscarSala();
});
$('#msGo').addEventListener('click', buscarEnSala);
$('#msClose').addEventListener('click', cerrarBuscarSala);
$('#msInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarEnSala(); } });

/* v48: buscar desde el desplegable de páginas (en la sala) */
async function buscarEnPicker() {
  const inp = $('#pdSearch');
  const box = $('#pdResults');
  if (!inp || !box) return;
  const q = inp.value.trim();
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="sr-info"><div class="spinner"></div> Buscando…</div>';
  try {
    const d = await buscarEnServer(q);
    if (!d.ok || !d.results || !d.results.length) {
      box.innerHTML = `<div class="sr-info">${(d && d.error) || 'No encontré nada — prueba con otras palabras'}</div>`;
      return;
    }
    renderResultados(box, d.results, (res) => {
      $('#pageDrop').classList.add('hidden');
      if (!S.canControl) { toast('Solo el anfitrión puede cambiar de página'); return; }
      toast(`Abriendo ${res.site}…`);
      $('#mirrorUrl').value = res.url;
      startMirrorFromPicker();
    }, true);
  } catch {
    box.innerHTML = '<div class="sr-info">Sin conexión con el servidor</div>';
  }
}
