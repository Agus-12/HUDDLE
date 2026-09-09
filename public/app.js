'use strict';
/* Huddle — cliente: sincronización de reproducción, chat y presencia. */

const $ = (s) => document.querySelector(s);

const APP_VERSION = 'v94';

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
  mirror: { active: false, url: '', w: 0, h: 0, gotFrame: false, ready: false, playing: false },
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
  sincronizarSalaGirada(); /* v78: la sala siempre vertical en el celular */
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
    /* v56: recordamos la sala para ofrecer "¿volver a tu sala?" */
    try { localStorage.setItem('huddle_lastRoom', JSON.stringify({ code: d.room.code, at: Date.now() })); } catch {}
    showScreen('room');
    applyMirrorState(d.room.mirror || { active: false, url: '' });
    applyState(d.room.state);

    /* v43: si vienen del menú con página elegida, el espejo arranca solo */
    if (S.pendingStart) {
      const ps = S.pendingStart;
      S.pendingStart = null;
S.mirrorInfo = null; /* v59: título+carátula de lo que se está abriendo */
S.mirrorTime = null; /* v61: posición de la peli para la barrita */
      if (ps.url && !S.mirror.active) {
        setTimeout(() => {
          if (S.canControl && !S.mirror.active) {
            /* v59: carátula + ruedita mientras prepara todo */
            S.mirrorInfo = { title: ps.name || '', img: ps.img || '', url: ps.url, sub: 'Cargando tu sala…' };
            $('#mirrorUrl').value = ps.url;
            startMirrorFromPicker();
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
  es.addEventListener('mirror-time', (e) => {
    /* v61: posición de la peli para la barrita */
    try {
      const d = JSON.parse(e.data);
      if (d && d.d > 1) {
        S.mirrorTime = { t: d.t, d: d.d }; pintarSeekBar();
        /* v78: al retomar algo de "Continuar viendo", saltamos a donde
         * se quedaron (una sola vez, y solo si es esa misma peli) */
        if (S.resumeAt && S.resumeAt.t > 0 && S.resumeAt.url === S.mirror.url) {
          const t = S.resumeAt.t;
          S.resumeAt = null;
          sendAction({ type: 'mirror', op: 'seekTo', time: t }).then(() => {
            if (S.mirrorTime) { S.mirrorTime.t = t; pintarSeekBar(); }
            toast('Seguimos donde se quedaron: ' + fmtTiempo(t), 4000);
          }).catch(() => {});
        }
      }
    } catch {}
  });
  es.addEventListener('mirror-frame', (e) => {
    const f = JSON.parse(e.data);
    S.mirror.w = f.w; S.mirror.h = f.h;
    S.mirror.gotFrame = true;
    $('#mirrorLoading').classList.add('hidden');
    drawMirrorFrame(f.d);
    /* v60: en SERIES la página renderizada ya es útil (eliges episodio);
     * v61: los EPISODIOS se preparan como pelis — se espera al botón de play */
    const pl = $('#peliLoading');
    if (pl && !pl.classList.contains('hidden') && /\/serie\//.test(S.mirror.url || '') && !/\/episode\//.test(S.mirror.url || '')) ocultarPeliLoading();
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
  /* v92: sala nativa — video directo (como el modo Solo) sincronizado
   * por el reloj del servidor; sin nativo, se apaga */
  if (st.videoUrl && st.native) activarNativo(st);
  else if (S.nativo) desactivarNativo();
  updateControlUi();
  updateBadge();
}

/* ======================= v92: sala nativa (video directo) =======================
 * El servidor resolvió la peli como en el modo Solo (goodstream, vimeos,
 * mp4upload) y todos la reproducimos en nuestro navegador, sincronizados
 * por el reloj de la sala (position + updatedAt + serverNow). */
S.nativo = null; /* { url, m3u8, mp4, proxy, subs, isPlaying, position, updatedAt, hls } */
function posEsperada() {
  if (!S.nativo) return 0;
  return S.nativo.isPlaying
    ? S.nativo.position + Math.max(0, (Date.now() + (S.offset || 0) - S.nativo.updatedAt) / 1000)
    : S.nativo.position;
}
function activarNativo(st) {
  const primero = !S.nativo || S.nativo.url !== st.videoUrl;
  if (primero) {
    if (S.nativo) desmontarNativo();
    S.nativo = {
      url: st.videoUrl, m3u8: st.native.m3u8, mp4: !!st.native.mp4,
      proxy: !!st.native.proxy, subs: st.native.subs || [],
      isPlaying: !!st.isPlaying, position: +st.position || 0,
      updatedAt: +st.updatedAt || Date.now(), hls: null,
    };
    /* la capa del espejo nos sirve de marco: canvas fuera, video dentro */
    S.mirror.active = false; S.mirror.ready = false; S.mirror.playing = false; S.mirror.gotFrame = true;
    $('#mirrorImg').classList.add('hidden');
    $('#roomVideo').classList.remove('hidden');
    $('#mirrorLayer').classList.remove('hidden');
    $('#mirrorLoading').classList.add('hidden');
    $('#videoEmpty').classList.add('hidden');
    $('#seekWrap').classList.add('hidden'); /* hasta saber la duración */
    S.mirrorTime = null;
    document.body.classList.add('mirroring');
    document.body.classList.add('cine-listo');
    ocultarPlayBtn();
    montarNativo();
  } else {
    Object.assign(S.nativo, { isPlaying: !!st.isPlaying, position: +st.position || 0, updatedAt: +st.updatedAt || Date.now() });
    sincronizarNativo();
  }
}
/* v94: los masters de goodstream traen el audio inglés marcado como
 * DEFAULT (por eso las series "venían en inglés") — cuando el stream
 * tiene pista de audio en español (latino/castellano), la elegimos */
function prefiereEspanol(video, hls) {
  const esPista = (t) => /^es/i.test(String((t && t.lang) || '')) || /espa/i.test(String((t && t.name) || ''));
  if (hls) {
    const elegir = () => {
      try {
        const pistas = hls.audioTracks || [];
        const at = pistas.find(esPista);
        const idx = at ? pistas.indexOf(at) : -1;
        if (idx >= 0 && hls.audioTrack !== idx) hls.audioTrack = idx;
      } catch {}
    };
    try { hls.on(window.Hls.Events.MANIFEST_PARSED, elegir); hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, elegir); } catch {}
  } else if (video) {
    /* Safari / HLS nativo / mp4: AudioTrackList si el navegador lo tiene */
    video.addEventListener('loadedmetadata', () => {
      try {
        const ts = video.audioTracks;
        if (!ts || !ts.length) return;
        for (let i = 0; i < ts.length; i++) {
          if (esPista({ lang: ts[i].language, name: ts[i].label || ts[i].id })) ts[i].enabled = true;
        }
      } catch {}
    }, { once: true });
  }
}
function montarNativo(porProxy) {
  const v = $('#roomVideo');
  const usaProxy = !!porProxy || !!S.nativo.proxy;
  const src = usaProxy ? '/api/hls?u=' + encodeURIComponent(S.nativo.m3u8) : S.nativo.m3u8;
  /* montaje limpio (puede ser un remount por el proxy) */
  if (S.nativo.hls) { try { S.nativo.hls.destroy(); } catch {} S.nativo.hls = null; }
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  /* v92: la pantalla de carga se va cuando DE VERDAD suena — y dura
   * mínimo 5 segundos, como debe ser (carga rapidísima ahora) */
  v.addEventListener('playing', () => {
    if (!S.nativo) return;
    ocultarPeliLoadingSuave();
    ocultarPlayBtn();
  }, { once: true });
  cargarHlsJs((okHls) => {
    if (!S.nativo) return;
    const hlsOk = !S.nativo.mp4 && okHls && window.Hls && window.Hls.isSupported();
    if (hlsOk) {
      const hls = new window.Hls({ maxBufferLength: 30 });
      S.nativo.hls = hls;
      prefiereEspanol(v, hls); /* v94: audio español si lo hay */
      /* v92: si el directo no sirve (CORS del origen), re-servimos por
       * el proxy — igual que el modo Solo */
      hls.on(window.Hls.Events.ERROR, (ev, data) => {
        if (!S.nativo || !data || !data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !usaProxy) {
          toast('Conectando por el servidor…');
          montarNativo(true);
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch {}
        }
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      v.src = src; /* mp4 directo, o Safari con HLS nativo */
      prefiereEspanol(v, null);
    }
    const alListo = () => {
      if (!S.nativo) return;
      let t = posEsperada();
      /* v78: retomar donde iba (continuar-viendo de la sala) */
      if (S.resumeAt && S.resumeAt.url === S.nativo.url && S.resumeAt.t > 5) { t = S.resumeAt.t; S.resumeAt = null; }
      try { if (t > 5 && isFinite(v.duration) && t < v.duration - 5) v.currentTime = t; } catch {}
      if (S.nativo.isPlaying) v.play().catch(() => { mostrarPlayBtn(); });
    };
    v.addEventListener('loadedmetadata', alListo, { once: true });
    v.addEventListener('loadeddata', alListo, { once: true });
    setTimeout(alListo, 1500);
  });
}
function sincronizarNativo() {
  const v = $('#roomVideo');
  if (!v || !S.nativo) return;
  const esp = posEsperada();
  if (S.nativo.isPlaying) {
    if (Math.abs(v.currentTime - esp) > 2 && isFinite(v.duration) && esp < v.duration - 1) { try { v.currentTime = esp; } catch {} }
    if (v.paused) v.play().catch(() => { mostrarPlayBtn(); });
  } else {
    if (!v.paused) { try { v.pause(); } catch {} }
    if (Math.abs(v.currentTime - esp) > 1) { try { v.currentTime = esp; } catch {} }
  }
}
function desmontarNativo() {
  const v = $('#roomVideo');
  if (S.nativo && S.nativo.hls) { try { S.nativo.hls.destroy(); } catch {} }
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  S.nativo = null;
}
function desactivarNativo() {
  desmontarNativo();
  $('#roomVideo').classList.add('hidden');
  $('#mirrorImg').classList.remove('hidden');
  $('#mirrorLayer').classList.add('hidden');
  $('#videoEmpty').classList.remove('hidden');
  document.body.classList.remove('mirroring', 'cine-listo');
  ocultarPeliLoading(); ocultarPlayBtn(); ocultarCtrls();
  $('#seekWrap').classList.add('hidden');
  S.mirrorTime = null;
  S.mirrorInfo = null;
}
/* reloj propio: barrita al día + resincronización suave cada 3s */
setInterval(() => {
  if (!S.nativo) return;
  const v = $('#roomVideo');
  if (v && isFinite(v.duration) && v.duration > 0) { S.mirrorTime = { t: v.currentTime, d: v.duration }; pintarSeekBar(); }
  sincronizarNativo();
}, 3000);
$('#roomVideo').addEventListener('click', tocarPantallaCine);

/* v33: la app ya no reproduce videos por URL — solo espeja páginas.
 * El badge de sync vivía en la barra del reproductor, que ya no existe. */
function updateBadge() {}

/* ======================= modo espejo (navegador remoto) ======================= */

function applyMirrorState(ms) {
  if (!ms) return;
  S.mirror.active = !!ms.active;
  S.mirror.url = ms.url || '';
  S.mirror.ready = !!(ms.active && ms.ready);
  S.mirror.playing = !!ms.playing;
  S.mirror.serie = ms.serie || null; /* v74: episodio de serie actual */
  /* v62: en modo cine los controles viven escondidos abajo */
  document.body.classList.toggle('cine-listo', S.mirror.ready);
  if (ms.playing || !ms.active) ocultarCtrls();
  /* v59/v61: la peli sonando → fuera la espera y el botón de play.
   * lista en pausa → mostrar el botón de play grande. */
  if (ms.playing) { ocultarPeliLoading(); ocultarPlayBtn(); }
  else if (ms.active && ms.ready) { ocultarPeliLoading(); mostrarPlayBtn(); }
  /* v74: mientras se abre un episodio, TODA la sala ve la pantalla de
   * espera con la carátula de la serie y el episodio que se prepara */
  else if (ms.active && !ms.ready && ms.serie && !S.pendingStart) {
    S.mirrorInfo = { title: ms.serie.titulo, img: (ms.serie.poster ? proxyAnimeImg(ms.serie.poster, 400) : ''), url: ms.url, sub: 'Abriendo en el espejo…', epNum: ms.serie.num };
    mostrarPeliLoading();
  }
  updateEpNav();
  /* v61: ojo — si la sala aún va a arrancar el espejo (pendingStart),
   * NO quitamos la pantalla de espera (era el destello de la sala) */
  if (!ms.active && !S.pendingStart) { ocultarPeliLoading(); ocultarPlayBtn(); S.mirrorInfo = null; }
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
    /* v55: gobernador de latencia — si el iPhone pausó el audio por dentro,
     * los chunks viejos se acumulan (sonido "atrasado"). Si hay más de 1 s
     * acumulado, tiramos lo viejo y nos quedamos con ~0.3 s fresco */
    const maxQ = Math.round(1.0 * sampleRate);
    if (this.qn > maxQ) {
      let objetivo = Math.round(0.3 * sampleRate);
      while (this.q.length > 1 && this.qn - this.q[0].length >= objetivo) { this.qn -= this.q[0].length; this.q.shift(); }
      this.off = 0;
    }
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
    /* v55: mismo gobernador de latencia que el worklet (ver arriba) */
    const maxQ = Math.round(1.0 * ctx.sampleRate);
    if (qn > maxQ) {
      let objetivo = Math.round(0.3 * ctx.sampleRate);
      while (q.length > 1 && qn - q[0].length >= objetivo) { qn -= q[0].length; q.shift(); }
      off = 0;
    }
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

/* v55: vigilante del audio — cada 4 s revisa que el sonido siga vivo.
 * Cuando el iPhone pausa el audio por dentro (cambio de app, bloqueo),
 * antes se quedaba mudo hasta reiniciar la app; ahora se reactiva solo,
 * y si el navegador exige un toque, aparece el chip para reactivarlo. */
setInterval(() => {
  if (!S.mirror.active || !AU.needAudio || !AU.ctx) return;
  if (AU.ctx.state === 'suspended') {
    AU.ctx.resume()
      .then(() => { if (AU.ctx.state === 'suspended') $('#audioChip').classList.remove('hidden'); })
      .catch(() => { $('#audioChip').classList.remove('hidden'); });
  }
  if (AU.outEl && AU.outEl.paused) { AU.outEl.play().then(() => { AU.salidaElemento = true; }).catch(() => {}); }
}, 4000);

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
    let rect = img.getBoundingClientRect();
    /* v77/v78: con la vista GIRADA (pantalla completa en vertical, o la
     * sala girada en horizontal), el rectángulo visual está volteado —
     * lo transponemos para que los toques caigan donde se ven */
    if (vistaGirada()) {
      const rc = videoShellEl.getBoundingClientRect();
      const cX = rc.left + rc.width / 2, cY = rc.top + rc.height / 2;
      const W = rc.height, H = rc.width; /* tamaño sin girar */
      /* v80: el lienzo SIN girar, en coordenadas de CONTENIDO (origen 0,0) —
       * los toques transpuestos caen ahí, no en la posición visual */
      rect = { left: 0, top: 0, width: W, height: H };
      /* v80: el sentido depende de hacia qué lado esté acostado el teléfono */
      let nx, ny;
      if (dirGiro() < 0) { nx = W / 2 - (cy - cY); ny = H / 2 + (cx - cX); }
      else { nx = W / 2 + (cy - cY); ny = H / 2 - (cx - cX); }
      cx = nx; cy = ny;
    }
    const scale = Math.min(rect.width / S.mirror.w, rect.height / S.mirror.h);
    const drawW = S.mirror.w * scale, drawH = S.mirror.h * scale;
    const offX = (rect.width - drawW) / 2, offY = (rect.height - drawH) / 2;
    const px = cx - rect.left - offX, py = cy - rect.top - offY;
    if (px < 0 || py < 0 || px > drawW || py > drawH) return null; // borde negro
    return { x: Math.round(px / scale), y: Math.round(py / scale), scale };
  };
  try { window.__toPage = toPage; } catch {} /* v80: para pruebas */

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
    /* v78: con la vista girada el rect visual está volteado — se compara
     * cruzado para que la velocidad del scroll sea la correcta */
    const g = dirGiro();
    const scale = (S.mirror.w && S.mirror.h)
      ? (g ? Math.min(rect.height / S.mirror.w, rect.width / S.mirror.h)
           : Math.min(rect.width / S.mirror.w, rect.height / S.mirror.h))
      : 1;
    /* v77/v80: con la vista girada, arrastrar a los lados (en pantalla) es
     * arrastrar arriba/abajo en la página — el eje se intercambia y el
     * SENTIDO depende de hacia qué lado esté acostado el teléfono */
    if (g) accDy += (g < 0 ? 1 : -1) * (e.clientX - last.x) / scale;
    else accDy += -(e.clientY - last.y) / scale;
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
    /* v62: con la película lista el toque ya no viaja a la página:
     * 1er toque saca los controles 5 segundos; si ya se veían, pausa o sigue */
    if (S.mirror.ready) { tocarPantallaCine(); return; }
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
  if (S.canControl) {
    /* v92: sala nativa — se suelta con la acción de video */
    if (S.nativo) sendAction({ type: 'video', url: '' });
    else sendAction({ type: 'mirror', op: 'stop' });
  } else toast('Solo el anfitrión controla la sala');
});

/* v33: navegar el espejo como un navegador normal — atrás / adelante */
/* v61: barrita con tiempo — pintar y arrastrar para moverte en la peli */
function fmtTiempo(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function pintarSeekBar(previewT) {
  const wrap = $('#seekWrap');
  if (!wrap) return;
  const mt = S.mirrorTime;
  if (!mt || !mt.d) { wrap.classList.add('hidden'); return; }
  const t = (previewT !== undefined) ? previewT : mt.t;
  const pct = Math.max(0, Math.min(100, (t / mt.d) * 100));
  $('#seekFill').style.width = pct + '%';
  $('#seekDot').style.left = pct + '%';
  $('#seekCur').textContent = fmtTiempo(t);
  $('#seekDur').textContent = fmtTiempo(mt.d);
  wrap.classList.remove('hidden');
}
(function() {
  const bar = document.querySelector('#seekBar');
  if (!bar) return;
  let arrastrando = false;
  const tDe = (ev) => {
    const r = bar.getBoundingClientRect();
    let pct;
    if (dirGiro()) {
      /* v78/v80: con la vista girada la barra se ve VERTICAL — se recorre
       * con el dedo arriba/abajo; el INICIO queda arriba o abajo según
       * hacia qué lado esté acostado el teléfono */
      const largo = r.height; /* largo real de la barra sin girar */
      const cY = r.top + r.height / 2;
      const u = (dirGiro() < 0) ? (largo / 2 - (ev.clientY - cY)) : (largo / 2 + (ev.clientY - cY));
      pct = Math.max(0, Math.min(1, u / largo));
    } else {
      pct = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    }
    return pct * (S.mirrorTime ? S.mirrorTime.d : 0);
  };
  bar.addEventListener('pointerdown', (ev) => {
    if (!S.mirrorTime || !S.mirrorTime.d) return;
    arrastrando = true;
    try { bar.setPointerCapture(ev.pointerId); } catch {}
    pintarSeekBar(tDe(ev));
  });
  bar.addEventListener('pointermove', (ev) => { if (arrastrando) pintarSeekBar(tDe(ev)); });
  const soltar = (ev) => {
    if (!arrastrando) return;
    arrastrando = false;
    const t = Math.round(tDe(ev));
    if (S.mirrorTime) S.mirrorTime.t = t;
    /* v92: sala nativa — mover por el reloj de la sala */
    if (S.nativo) {
      S.nativo.position = t; S.nativo.updatedAt = Date.now() + (S.offset || 0); S.nativo.isPlaying = true;
      sendAction({ type: 'seek', position: t }).catch(() => {});
    } else sendAction({ type: 'mirror', op: 'seekTo', time: t }).catch(() => {});
  };
  bar.addEventListener('pointerup', soltar);
  bar.addEventListener('pointercancel', soltar);
})();

/* v60: adelantar / atrasar la película (mueve el video del espejo) */
function moverPelicula(delta) {
  /* v92: sala nativa — ±N segundos por el reloj de la sala */
  if (S.nativo) {
    const v = $('#roomVideo');
    const base = (v && isFinite(v.duration)) ? v.currentTime : posEsperada();
    const t = Math.max(0, Math.round(base + delta));
    S.nativo.position = t; S.nativo.updatedAt = Date.now() + (S.offset || 0); S.nativo.isPlaying = true;
    if (v) { try { v.currentTime = t; } catch {} }
    sendAction({ type: 'seek', position: t }).catch(() => {});
    return;
  }
  if (!S.mirror.active) { toast('Primero pon una película'); return; }
  sendAction({ type: 'mirror', op: 'seek', delta }).then((r) => {
    if (r && r.ok === false) toast(r.error || 'No se pudo mover');
    else if (r && r.movio === false) toast('Todavía no hay video que mover');
  }).catch(() => {});
}
$('#btnSeekBack').addEventListener('click', () => moverPelicula(-10));
$('#btnSeekFwd').addEventListener('click', () => moverPelicula(30));

/* iniciar espejo desde el selector (o cambiar de página sin detener) */
/* v59: pantalla de espera con carátula mientras el servidor prepara todo */
function mostrarPeliLoading() {
  const info = S.mirrorInfo;
  const box = $('#peliLoading');
  if (!box) return;
  S.peliLoadingAt = Date.now(); /* v92: la sala carga rapidísimo ahora — la pantalla dura mínimo 5s */
  if (info) {
    const po = $('#peliPoster');
    if (info.img) {
      po.classList.remove('hidden');
      po.onerror = () => po.classList.add('hidden');
      po.src = info.img;
    } else po.classList.add('hidden');
    $('#peliNombre').textContent = info.title || '';
    /* v74: para episodios: "Preparando Episodio 3…" junto al nombre de la serie */
    if (info.epNum) $('#peliEstado').textContent = `Preparando ${info.epNum}…`;
    else {
      const esSerie = /\/serie\/|\/episode\//.test(info.url || S.mirror.url || '');
      $('#peliEstado').textContent = esSerie ? 'Preparando tu serie…' : 'Preparando tu peli…';
    }
    $('#peliSub').textContent = info.sub || 'Abriendo en el espejo…';
  }
  box.classList.remove('hidden');
  arrancarTimerPeli();
}
function ocultarPeliLoading() {
  const b = $('#peliLoading');
  if (b && !b.classList.contains('hidden')) {
    b.classList.add('hidden');
    if (S.peliTimer) { clearTimeout(S.peliTimer); S.peliTimer = null; }
  }
}
/* v92: la sala nativa carga rapidísimo — la pantalla de carga se queda
 * un mínimo de 5 segundos (que no sea un destello) */
function ocultarPeliLoadingSuave() {
  const falta = 5000 - (Date.now() - (S.peliLoadingAt || 0));
  if (falta <= 0) return ocultarPeliLoading();
  setTimeout(() => ocultarPeliLoading(), falta);
}
$('#peliLoading').addEventListener('click', () => ocultarPeliLoading());
/* v61: selector de temporadas y episodios para series */
let spDatos = null; /* lo que devolvió /api/serie */
/* v62→v67: imágenes de AnimeFLV y Latanime pasan por NUESTRO proxy —
 * wsrv.nl ya no puede con ellas (las bloquean con 403) */
function proxyAnimeImg(src, w) {
  if (src && src.startsWith('/api/img')) return src; /* v91: ya proxieada */
  if (src && /animeflv\.|latanime\./i.test(src)) {
    return '/api/img?u=' + encodeURIComponent(src);
  }
  return src || '';
}
/* v91: normaliza CUALQUIER carátula de anime al proxy — si la URL ya
 * viene proxieada (/api/img?u=…) la dejamos tal cual. Antes se
 * proxieaba DOS veces (el regex veía "latanime" dentro de la URL ya
 * codificada) y la imagen no cargaba: el recuadro azul con "?" en
 * continuar-viendo. */
function imgPorProxy(src) {
  if (!src) return '';
  if (src.startsWith('/api/img')) return src;
  if (/animeflv\.|latanime\./i.test(src)) return '/api/img?u=' + encodeURIComponent(src);
  return src;
}
function abrirSeriePicker(res, enSala, esAnime) {
  const slugM = /(?:serie|anime)\/([a-z0-9-]+)/i.exec(res.url || '');
  if (!slugM) { toast('No pude leer esa serie'); return; }
  const slug = slugM[1];
  const esLat = /latanime\./i.test(res.url || ''); /* v63: anime de Latanime */
  const pk = $('#seriePicker');
  pk.classList.remove('hidden');
  $('#spTitle').textContent = res.title || '';
  $('#spMeta').textContent = esAnime ? 'Cargando episodios…' : 'Cargando temporadas…';
  const po = $('#spPoster');
  const poster0 = proxyAnimeImg(res.img, 400);
  if (poster0) { po.src = poster0; po.style.display = ''; } else po.style.display = 'none';
  $('#spTemporadas').innerHTML = '';
  $('#spEpisodios').innerHTML = '<div class="sp-meta" style="padding:20px 0;text-align:center">Buscando episodios…</div>';
  fetch((esAnime ? ('/api/anime/' + slug + (esLat ? '?site=latanime' : '')) : '/api/serie/' + slug)).then((r) => r.json()).then((d) => {
    /* v62: animes → una sola lista de episodios, sin miniaturas */
    const eps = esAnime
      ? (d.episodios || []).map((e) => ({ temporada: 1, ep: e.n, url: e.url, titulo: e.titulo || ('Episodio ' + e.n), img: '' }))
      : (d.episodios || []);
    if (!d.ok || !eps.length) {
      $('#spEpisodios').innerHTML = '<div class="sp-meta" style="padding:20px 0;text-align:center">No encontré episodios de esta ' + (esAnime ? 'serie' : 'serie') + '</div>';
      $('#spMeta').textContent = '';
      return;
    }
    spDatos = { ...d, esAnime: !!esAnime, episodios: eps, enSala: !!enSala, posterBase: proxyAnimeImg(d.poster || res.img, 400) };
    $('#spTitle').textContent = d.titulo || res.title || '';
    $('#spMeta').textContent = eps.length + ' episodios';
    if (spDatos.posterBase) { po.src = spDatos.posterBase; po.style.display = ''; }
    const temps = [...new Set(eps.map((x) => x.temporada))].sort((a, b) => a - b);
    const tBox = $('#spTemporadas');
    tBox.innerHTML = '';
    if (temps.length > 1) {
      temps.forEach((T, i) => {
        const b = document.createElement('button');
        b.className = 'sp-temp-btn' + (i === 0 ? ' activa' : '');
        b.textContent = 'Temporada ' + T;
        b.addEventListener('click', () => {
          tBox.querySelectorAll('.sp-temp-btn').forEach((x) => x.classList.remove('activa'));
          b.classList.add('activa');
          pintarEpisodios(T);
        });
        tBox.appendChild(b);
      });
    }
    pintarEpisodios(temps[0]);
  }).catch(() => {
    $('#spEpisodios').innerHTML = '<div class="sp-meta" style="padding:20px 0;text-align:center">Sin conexión — inténtalo de nuevo</div>';
  });
}
function pintarEpisodios(temporada) {
  const box = $('#spEpisodios');
  box.innerHTML = '';
  const eps = (spDatos.episodios || []).filter((x) => x.temporada === temporada);
  eps.forEach((ep) => {
    const b = document.createElement('button');
    const esAn = !!spDatos.esAnime;
    b.className = 'sp-ep' + (esAn ? ' sin-img' : '');
    b.innerHTML = (esAn ? '' : `<img src="${ep.img || spDatos.posterBase}" alt="" loading="lazy" referrerpolicy="no-referrer">`)
      + `<span><span class="sp-ep-num">${esAn ? 'Episodio ' + (ep.ep || '·') : temporada + 'x' + (ep.ep || '·')}</span>
      <span class="sp-ep-tit"></span></span>`;
    b.querySelector('.sp-ep-tit').textContent = esAn ? (spDatos.titulo || ep.titulo) : ep.titulo;
    b.dataset.url = ep.url || ''; /* v85: para marcar los vistos */
    b.addEventListener('click', () => {
      /* elegiste episodio → igual que una peli: carátula, sala, pausa y play */
      cerrarSeriePicker();
      const nombre = esAn ? `${spDatos.titulo} — Episodio ${ep.ep || ''}`.trim() : `${spDatos.titulo} ${temporada}x${ep.ep || ''}`.trim();
      const imgEp = ep.img || spDatos.posterBase;
      if (S.modoSolo) {
        /* v90: los animes TAMBIÉN se ven en Solo — el servidor saca el
         * mp4 directo de mp4upload (antes pedían la sala con navegador) */
        const idx = eps.indexOf(ep);
        const cadena = idx >= 0 ? eps.slice(idx) : [ep];
        abrirSolo(ep.url, {
          title: spDatos.titulo || '', ep: esAn ? String(ep.ep || '') : `${temporada}x${ep.ep || ''}`,
          serie: spDatos.titulo || '', img: imgEp,
          eps: cadena.map((x) => ({ url: x.url, ep: esAn ? String(x.ep || '') : `${x.temporada}x${x.ep || ''}`, nombre: x.titulo || '' })),
        });
        return;
      }
      if (spDatos.enSala) {
        S.mirrorInfo = { title: nombre, img: imgEp, url: ep.url, sub: 'Abriendo en el espejo…' };
        $('#mirrorUrl').value = ep.url;
        startMirrorFromPicker();
      } else {
        S.pendingStart = { url: ep.url, name: nombre, img: imgEp };
        S.mirrorInfo = { title: nombre, img: imgEp, url: ep.url, sub: 'Cargando tu sala…' };
        mostrarPeliLoading();
        const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
        connect(code);
      }
    });
    box.appendChild(b);
  });
  marcarVistos(eps); /* v85: ✓ en lo ya visto */
}

/* v85: pregunta al servidor cuáles de estos episodios ya vio el usuario */
async function marcarVistos(eps) {
  if (!S.profile || !eps.length) return;
  try {
    const r = await fetch('/api/vistos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: S.profile.name, token: S.profile.token, urls: eps.map((x) => x.url) }),
    });
    const d = await r.json();
    if (!d || !d.ok || !d.vistos) return;
    eps.forEach((ep) => {
      const v = d.vistos[ep.url];
      if (!v) return;
      const b = document.querySelector('.sp-ep[data-url="' + CSS.escape(ep.url) + '"]');
      if (!b) return;
      const completa = v.t >= 60 || (v.d && v.t >= v.d * 0.9);
      if (completa) {
        b.classList.add('vista');
        const c = document.createElement('span');
        c.className = 'visto-chip ok';
        c.textContent = '✓';
        c.title = 'Ya la viste';
        b.appendChild(c);
      } else if (v.t >= 10) {
        b.classList.add('parcial');
        const c = document.createElement('span');
        c.className = 'visto-chip medio';
        c.textContent = '◐';
        c.title = 'Quedaste en ' + fmtTiempo(v.t);
        b.appendChild(c);
      }
    });
  } catch {}
}
function cerrarSeriePicker() { $('#seriePicker').classList.add('hidden'); }
$('#spClose').addEventListener('click', cerrarSeriePicker);
$('#seriePicker').addEventListener('click', (e) => { if (e.target === e.currentTarget) cerrarSeriePicker(); });

/* v61: ¿es una serie? → abrir el selector en vez del espejo directo */
function elegirTitulo(res, enSala) {
  if (/\/serie\//i.test(res.url || '')) { abrirSeriePicker(res, enSala, false); return true; }
  if (/\/anime\//i.test(res.url || '')) { abrirSeriePicker(res, enSala, true); return true; }
  return false;
}

/* v62: capa de controles de abajo — escondida en modo cine,
 * un toque la muestra 5 segundos y otro toque pausa o reanuda */
let ctrlTimer = null;
function mostrarCtrls5s() {
  $('#ctrlLayer').classList.add('visible');
  document.body.classList.add('ctrls-vis'); /* v65: sube la tira de mensajes para no taparla */
  if (ctrlTimer) clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => { $('#ctrlLayer').classList.remove('visible'); document.body.classList.remove('ctrls-vis'); ctrlTimer = null; }, 5000);
}
function ocultarCtrls() {
  if (ctrlTimer) { clearTimeout(ctrlTimer); ctrlTimer = null; }
  $('#ctrlLayer').classList.remove('visible');
  document.body.classList.remove('ctrls-vis');
}
function tocarPantallaCine() {
  if ($('#ctrlLayer').classList.contains('visible')) {
    ocultarCtrls();
    /* v92: en sala nativa el play/pausa va por el reloj de la sala */
    if (S.nativo) sendAction({ type: S.nativo.isPlaying ? 'pause' : 'play' }).catch(() => {});
    else sendAction({ type: 'mirror', op: S.mirror.playing ? 'pause' : 'play' }).catch(() => {});
  } else mostrarCtrls5s();
}

/* v61: botón grande de play — la peli quedó lista en pausa */
function mostrarPlayBtn() {
  const b = $('#playBtn');
  if (b) b.classList.remove('hidden');
}
function ocultarPlayBtn() {
  const b = $('#playBtn');
  if (b && !b.classList.contains('hidden')) b.classList.add('hidden');
}
$('#playBtn').addEventListener('click', () => {
  ocultarPlayBtn();
  /* v92: sala nativa — play por el reloj de la sala */
  if (S.nativo) sendAction({ type: 'play' }).catch(() => {});
  else sendAction({ type: 'mirror', op: 'play' }).catch(() => {});
});

/* v60: si la peli tarda demasiado, te dejamos entrar igual (sin quedarte atascado) */
function arrancarTimerPeli() {
  if (S.peliTimer) clearTimeout(S.peliTimer);
  S.peliTimer = setTimeout(() => {
    if (!$('#peliLoading').classList.contains('hidden')) {
      ocultarPeliLoading();
      toast('Ya estás en la sala — la película sigue preparándose');
    }
  }, 100000);
}

function startMirrorFromPicker() {
  if (!S.canControl) { toast('Solo el anfitrión puede espejar'); return; }
  const url = $('#mirrorUrl').value.trim();
  if (!url) { toast('Escribe la URL de la página a espejar'); return; }
  // feedback inmediato: mostramos la capa del espejo con spinner mientras abre Chrome
  S.mirror.gotFrame = false;
  S.mirrorTime = null; /* v61: barrita nueva para la peli nueva */
  ocultarPlayBtn();
  $('#seekWrap').classList.add('hidden');
  applyMirrorState({ active: true, url, audio: true });
  /* v59: si venimos de elegir una peli/serie, su carátula mientras carga */
  if (S.mirrorInfo) mostrarPeliLoading();
  // aprovechamos el clic (gesto del usuario) para desbloquear el audio
  ensureAudioCtx().then((ctx) => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); });
  sendAction({ type: 'mirror', op: 'start', url, title: (S.mirrorInfo && S.mirrorInfo.title) || '', img: (S.mirrorInfo && S.mirrorInfo.img) || '' }).then((r) => {
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
  /* v65: Latanime primero (predeterminado) + logos propios en /sites/
   * v68: fuera GoPelis y AnimeFLV — v70: fuera AnimeD23 también */
  { name: 'Latanime', full: 'Latanime — animes con audio latino', url: 'https://latanime.org/', logo: '/sites/latanime.png' },
  { name: 'Cuevana', full: 'Cuevana — películas y series', url: 'https://cuevana.mov/', logo: '/sites/cuevana.png' },
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

  renderPageDrop();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.classList.toggle('hidden');
    /* v70: al abrirse, la caja de buscar queda lista para escribir
     * (como en el inicio) — solo la ve quien la abrió, en su pantalla */
    if (!drop.classList.contains('hidden')) setTimeout(() => { try { $('#pdSearch').focus(); } catch {} }, 60);
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
      return;
    }
    $('#customRow').classList.add('hidden');
    if (!S.canControl) { toast('Solo el anfitrión puede espejar'); return; }
    $('#mirrorUrl').value = opt.dataset.url;
    startMirrorFromPicker();
  });
  document.addEventListener('click', (e) => {
    if (!drop.classList.contains('hidden') && !e.target.closest('#pagePick')) drop.classList.add('hidden');
  });

  /* v68: mientras se espeja, el logo y nombre de la página que se está
   * viendo vive junto al indicador "En vivo" de la barra de arriba */
  window.__setPagePick = (url) => {
    const chip = $('#liveSite'), im = $('#liveSiteImg'), nm = $('#liveSiteName');
    if (!chip) return;
    const s = SITES.find((x) => url && url.startsWith(x.url.replace(/\/$/, '')));
    if (s) {
      im.src = s.logo; im.hidden = false;
      nm.textContent = s.name;
      chip.hidden = false;
    } else if (url) {
      let host = 'Página actual';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
      im.hidden = true; im.removeAttribute('src');
      nm.textContent = host;
      chip.hidden = false;
    } else chip.hidden = true;
  };
})();

/* v74/v75: botones de episodio anterior/siguiente en la barra de
 * abajo, DEBAJO de "Ampliar" (fuera de la película) — solo cuando
 * la sala ve una serie y solo para quien puede controlar. En el
 * último episodio, el botón de "siguiente" se vuelve "Buscar películas" */
function updateEpNav() {
  const nav = $('#epNav');
  if (!nav) return;
  const sc = S.mirror && S.mirror.serie;
  const puede = !!(sc && S.mirror.active && S.canControl);
  nav.classList.toggle('hidden', !puede);
  if (!puede) return;
  $('#epPrevBtn').classList.toggle('hidden', !sc.hayPrev);
  $('#epNextBtn').classList.toggle('hidden', !sc.hayNext);
  $('#epSearchBtn').classList.toggle('hidden', !!sc.hayNext);
}
(function montarEpNav() {
  const prev = $('#epPrevBtn'), next = $('#epNextBtn'), buscar = $('#epSearchBtn');
  if (!prev || !next || !buscar) return;
  prev.addEventListener('click', () => { toast('Abriendo el episodio anterior…'); sendAction({ type: 'mirror', op: 'epPrev' }); });
  next.addEventListener('click', () => { toast('Abriendo el episodio siguiente…'); sendAction({ type: 'mirror', op: 'epNext' }); });
  buscar.addEventListener('click', () => { try { $('#pagePickBtn').click(); } catch {} });
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
  updateEpNav(); /* v74: botones de episodio según permisos */
  const isHost = S.room && S.room.hostId === S.userId;
  $('#pagePickBtn').disabled = !S.canControl;
  $('#btnMirror').disabled = !S.canControl;
  $('#mirrorUrl').disabled = !S.canControl;
  $('#btnStopMirrorTop').disabled = !S.canControl;
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
  /* v50: si están escribiendo con el teclado abierto, la mini-vista de
     arriba de la caja también se actualiza */
  if (document.body.classList.contains('escribiendo-chat')) actualizarChatMini();
  /* v28: en pantalla completa no se ve el chat → tira deslizante abajo (estilo Rave) */
  if (fsActive()) ticker.push(msg);
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
  videoShellEl.classList.remove('fs-girado'); /* v77 */
  $('#fitToggleTxt').textContent = 'Llenar';
  sincronizarSalaGirada(); /* v78: al salir, la sala vuelve a verse vertical */
}
function enterPseudoFs() {
  videoShellEl.classList.add('pseudo-fs');
  document.body.classList.add('fs-lock');
  sincronizarGiros(); /* v77/v78: vista girada + sala vertical */
}
document.addEventListener('fullscreenchange', () => sincronizarGiros()); /* v77/v78 */
document.addEventListener('webkitfullscreenchange', () => sincronizarGiros()); /* v77/v78 */
/* v20: al entrar a pantalla completa, el ajuste ideal depende de la orientación:
 * horizontal → llenar la pantalla (sin barras laterales); vertical → ver todo */
function applyDefaultFsFit() {
  const landscape = window.matchMedia('(orientation: landscape)').matches;
  videoShellEl.classList.toggle('fit-cover', landscape);
  $('#fitToggleTxt').textContent = landscape ? 'Ver todo' : 'Llenar';
  sincronizarGiros(); /* v77/v78: vista girada + sala vertical */
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

/* v76: al VOLTEAR el celular (horizontal) se amplía solo, y al
 * levantarlo (vertical) se regresa al modo sala — como YouTube.
 * Solo dentro de la sala, con algo reproduciéndose en el espejo,
 * y solo en pantallas de celular (con toque). */
const mqOrient = window.matchMedia('(orientation: landscape)');
function esCelular() {
  return window.innerWidth <= 980 && (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
}
/* v77: la pantalla completa siempre se ve HORIZONTAL — si amplías con
 * el celular vertical, la vista se gira (voltea el teléfono para
 * verla derecha); al voltearlo se endereza sola */
function sincronizarFsGirado() {
  try { videoShellEl.classList.toggle('fs-girado', fsActive() && !mqOrient.matches && esCelular()); } catch {}
}
/* v78: la sala SIEMPRE se ve VERTICAL — con el celular horizontal (por
 * ejemplo al cerrar la pantalla completa con la X) la sala se gira
 * completa para que se siga viendo derecha al poner el teléfono vertical */
function sincronizarSalaGirada() {
  try {
    const room = document.querySelector('#room');
    const girar = !!room && !room.classList.contains('hidden') && !fsActive() && mqOrient.matches && esCelular();
    document.body.classList.toggle('sala-girada', girar);
  } catch {}
}
function sincronizarGiros() {
  sincronizarFsGirado();
  sincronizarSalaGirada();
  /* v79: con el celular horizontal (y sin ampliar), TODO se ve vertical —
   * login/invitación, pantalla de espera y selector de episodios */
  try { document.body.classList.toggle('movil-horizontal', mqOrient.matches && esCelular() && !fsActive()); } catch {}
  /* v88: el reproductor individual SIEMPRE se ve horizontal — con el
   * celular vertical se gira (voltea el teléfono para verla derecha),
   * como la pantalla completa de la sala desde v77 */
  try {
    const sp = document.querySelector('#soloPlayer');
    document.body.classList.toggle('solo-girado',
      !!sp && !sp.classList.contains('hidden') && !mqOrient.matches && esCelular());
  } catch {}
  /* v80: ¿hacia qué lado está acostado el teléfono? La vista girada debe
   * quedar con su parte de ARRIBA hacia la parte de arriba del teléfono,
   * pa' que se lea derecho — no al revés */
  try { document.body.classList.toggle('giro-ccw', telefonoTopIzquierda()); } catch {}
}
/* v78: ¿la vista está girada 90°? (pantalla completa en vertical, o la
 * sala con el celular horizontal) — los toques y la barrita se transponen */
function vistaGirada() {
  return videoShellEl.classList.contains('fs-girado') || document.body.classList.contains('sala-girada');
}
/* v80: ¿hacia qué lado está acostado el teléfono? true = su parte de
 * arriba quedó a la IZQUIERDA (el agarre más común). Se detecta con la
 * orientación de pantalla que reporta el navegador. */
function telefonoTopIzquierda() {
  try {
    const so = screen.orientation;
    if (so) {
      if (typeof so.angle === 'number' && (so.angle === 90 || so.angle === 270)) return so.angle === 90;
      if (so.type && /landscape/.test(so.type)) return /primary/.test(so.type);
    }
  } catch {}
  try { if (typeof window.orientation === 'number' && window.orientation !== 0) return window.orientation > 0; } catch {}
  return true; /* sin API: el agarre más común (arriba del teléfono a la izquierda) */
}
/* v80: sentido del giro de la vista: 1 = horario (como v77/v78),
 * -1 = antihorario (teléfono acostado al otro lado), 0 = sin giro.
 * La ampliada en vertical SIEMPRE gira igual (v77); la sala y las demás
 * pantallas siguen el lado al que está acostado el teléfono. */
function dirGiro() {
  if (videoShellEl.classList.contains('fs-girado')) return 1;
  if (document.body.classList.contains('sala-girada')) return document.body.classList.contains('giro-ccw') ? -1 : 1;
  return 0;
}
function autoFsPorOrientacion(landscape) {
  try {
    /* v82: modo individual — el celular acostado se amplía solo (como
     * v76 en la sala); vertical se regresa. Aquí no hay giros: el video
     * se acomoda solo con object-fit. */
    const sp = document.querySelector('#soloPlayer');
    if (sp && !sp.classList.contains('hidden') && typeof SOLO !== 'undefined' && SOLO && esCelular()) {
      const rf = sp.requestFullscreen || sp.webkitRequestFullscreen;
      if (landscape && !document.fullscreenElement && !document.webkitFullscreenElement && rf) {
        const pr = rf.call(sp);
        if (pr && pr.catch) pr.catch(() => {});
      } else if (!landscape && (document.fullscreenElement || document.webkitFullscreenElement)) {
        const xf = document.exitFullscreen || document.webkitExitFullscreen;
        if (xf) { try { xf.call(document); } catch {} }
      }
      sincronizarGiros(); /* v89: el giro del reproductor SIGUE al teléfono (acostado↔enderezado) */
      return; /* en modo individual no aplica la lógica de la sala */
    }
    /* v78: el volteo solo amplía con la sala abierta y algo en el espejo;
     * los giros de la vista se sincronizan SIEMPRE (la sala es vertical
     * aunque no haya nada reproduciéndose) */
    if (S.room && !document.querySelector('#room').classList.contains('hidden') &&
        document.body.classList.contains('mirroring') && esCelular()) {
      if (landscape && !fsActive()) toggleFullscreen();
      else if (!landscape && fsActive()) exitFullscreen();
    }
  } catch {}
  sincronizarGiros();
}
if (mqOrient.addEventListener) mqOrient.addEventListener('change', (e) => autoFsPorOrientacion(e.matches));
else if (mqOrient.addListener) mqOrient.addListener((e) => autoFsPorOrientacion(e.matches)); /* iOS viejo */
/* v77: al volver de la pantalla apagada (o de otra app), la sala se
 * acomoda a como traigas el celular: vertical → modo sala */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  setTimeout(() => { autoFsPorOrientacion(mqOrient.matches); sincronizarGiros(); }, 250);
});
sincronizarGiros(); /* v79: al abrir la página ya acomoda las vistas (invitación incluida) */

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
  /* v56: saliste a propósito — ya no ofrecemos volver a esta sala.
   * replace() sin hash: si dejáramos el #codigo, el auto-ingreso
   * de invitación te metería de vuelta a la sala que acabas de cerrar */
  try { localStorage.removeItem('huddle_lastRoom'); } catch {}
  location.replace(location.pathname);
});

/* ======================= pantalla de inicio (v31) =======================
 * identidad: nombre de usuario único recordado por dispositivo */

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('rr-profile') || 'null') || null; } catch { return null; }
}

/* v56: ¿qué sala había dejado abierta este dispositivo? (máx. 3 h) */
function leerLastRoom() {
  try {
    const d = JSON.parse(localStorage.getItem('huddle_lastRoom') || 'null');
    if (d && d.code && Date.now() - (d.at || 0) < 3 * 60 * 60 * 1000) return d.code;
  } catch {}
  return null;
}

/* v56: tarjeta de invitación — "X te invita a ver…" con el póster de fondo */
async function cargarInvitacion(code) {
  try {
    const r = await fetch('/api/invite/' + code);
    if (!r.ok) {
      toast('Esa sala ya no existe');
      history.replaceState(null, '', location.pathname);
      return;
    }
    const d = await r.json().catch(() => ({}));
    if (!d.ok || !d.host) return;
    $('#inviteHost').textContent = d.host;
    const tit = $('#inviteTitle');
    if (d.title) {
      $('#inviteVer').textContent = ' te invita a ver';
      tit.textContent = d.title;
      tit.style.display = '';
    } else { /* sin película en curso: sala vacía */
      $('#inviteVer').textContent = ' te invita a su sala';
      tit.style.display = 'none';
    }
    $('#joinCode').value = code; /* por si algo falla, el código queda listo */
    if (d.poster) {
      const bg = $('#inviteBg'), po = $('#invitePoster');
      po.src = d.poster;
      po.onerror = () => { po.style.display = 'none'; };
      bg.onload = () => bg.classList.remove('hidden');
      bg.src = d.poster;
    } else {
      $('#invitePoster').style.display = 'none';
    }
    $('#inviteHero').classList.remove('hidden');
    document.title = d.host + ' te invita — Huddle';
  } catch {}
}

/* v56: banner "¿Volver a tu sala?" en el inicio */
async function cargarVolver() {
  const code = leerLastRoom();
  if (!code) return;
  const box = $('#volverBox');
  box.classList.add('hidden');
  try {
    const r = await fetch('/api/invite/' + code);
    if (!r.ok) { /* la sala ya murió — dejamos de insistir */
      localStorage.removeItem('huddle_lastRoom');
      return;
    }
    const d = await r.json().catch(() => ({}));
    if (!d.ok) return;
    $('#volverTitle').textContent = d.title || 'Tu sala';
    $('#volverCode').textContent = 'Sala ' + code;
    const po = $('#volverPoster');
    po.style.display = '';
    if (d.poster) {
      po.src = d.poster;
      po.onerror = () => { po.style.display = 'none'; };
    } else {
      po.removeAttribute('src');
      po.style.display = 'none';
    }
    box.classList.remove('hidden');
  } catch {}
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
  const hM = /^#([A-Za-z0-9]{4,8})$/.exec(location.hash); /* v56: link de invitación */
  if (tiene) {
    $('#profileName').textContent = S.profile.name;
    const av = $('#profileAvatar');
    av.textContent = (S.profile.name[0] || '?').toUpperCase();
    av.style.setProperty('--h', hashHue(S.profile.name));
    pollRooms();
    cargarPopulares(); /* v55: fila de populares del día */
    cargarContinuar(); /* v78: seguir viendo donde te quedaste */
    if (hM) {
      /* v56: ya tienes sesión y te invitaron — directo a la sala */
      const code = hM[1].toUpperCase();
      fetch('/api/room/' + code).then((r) => {
        if (r.ok) connect(code);
        else { toast('Esa sala ya no existe'); history.replaceState(null, '', location.pathname); }
      }).catch(() => {});
    } else {
      cargarVolver(); /* v56: ¿volver a tu sala? */
    }
  } else {
    const inpU = $('#userNick');
    inpU.value = ''; // v32: sin el nombre viejo pegado tras "cambiar"
    try { inpU.focus(); } catch {}
    if (hM) cargarInvitacion(hM[1].toUpperCase()); /* v56: "X te invita a ver…" */
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
  'cine-calidad.mx': '/sites/cuevana.png',
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

/* v87: ya no hay botón "Crear sala" — al elegir una peli o serie en
 * Juntos la sala se crea sola (S.pendingStart + connect). */

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
S.resumeAt = null; /* v78: {url,t} para retomar donde se quedaron */
S.modoSolo = false; /* v81: modo individual — se pinta en el arranque */

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

function crearTarjetaResultado(res, alElegir) {
    const card = document.createElement('button');
    card.className = 'sr-card';
    card.type = 'button';
    /* v53: las carátulas de AnimeFLV van por un proxy de imágenes porque
     * en algunos teléfonos/compañías la página bloquea la imagen directa */
    const srcImg = imgPorProxy(res.img || ''); /* v91: nunca dos veces */
    card.innerHTML = `
      <span class="sr-badge"><img src="${logoDeSitio(res.site)}" alt=""></span>
      ${srcImg
        ? `<img class="sr-cover" src="${srcImg}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="sr-cover sr-cover-anime"><img src="${logoDeSitio(res.site)}" alt=""></span>`}
      <span class="sr-nombre"></span>
      ${res.extra ? '<span class="sr-extra"></span>' : ''}`;
    card.querySelector('.sr-nombre').textContent = res.title;
    const ex = card.querySelector('.sr-extra');
    if (ex) ex.textContent = res.extra || '';
    /* si una carátula no carga, se reintenta por el proxy */
    const im = card.querySelector('img.sr-cover');
    if (im && res.img) {
      im.addEventListener('error', () => {
        const respaldo = /^\/api\/img/.test(res.img || '')
          ? res.img /* v91: ya va por el proxy — reintento tal cual */
          : /animeflv\.|latanime\./i.test(res.img)
            ? imgPorProxy(res.img) /* v67: proxy propio */
            : 'https://wsrv.nl/?url=' + res.img.replace(/^https?:\/\//, '').split('?')[0] + '&w=240';
        if (im.src !== respaldo) im.src = respaldo;
      }, { once: true });
    }
  card.addEventListener('click', () => alElegir(res, card));
  return card;
}

function renderResultados(box, results, alElegir, conAnime) {
  box.innerHTML = '';
  const porSitio = new Map();
  results.forEach((r) => {
    if (!porSitio.has(r.site)) porSitio.set(r.site, []);
    porSitio.get(r.site).push(r);
  });
  const crearTarjeta = (res) => crearTarjetaResultado(res, (r, c) => alElegir(r, c));
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
  /* v70: solo Cuevana y Latanime, siempre en ese orden y con su sección
   * (si alguno no tiene resultados para lo que buscaste, lo dice) */
  const ordenFijo = ['Cuevana', 'Latanime'];
  const extras = [...porSitio.keys()].filter((s) => !ordenFijo.includes(s));
  for (const sitio of [...ordenFijo, ...extras]) {
    const items = porSitio.get(sitio) || [];
    if (!items.length && !ordenFijo.includes(sitio)) continue;
    const fila = crearSeccion(sitio);
    items.forEach((res) => fila.appendChild(crearTarjeta(res)));
    if (!items.length) {
      const v = document.createElement('div');
      v.className = 'sr-vacio-sec';
      v.textContent = sitio === 'Latanime' ? 'Sin resultados de anime para esta búsqueda' : 'Sin resultados para esta búsqueda';
      fila.appendChild(v);
    }
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
      if (elegirTitulo(res)) return; /* v61: series → temporadas y episodios */
      /* v91: en la pestaña Solo, lo que buscas se reproduce individual —
       * antes la búsqueda SIEMPRE armaba una sala (pantalla de "Cargando
       * tu sala…" aunque estuvieras en Solo) */
      if (S.modoSolo) { abrirSolo(res.url, { title: res.title || '', img: res.img || '' }); return; }
      S.pendingStart = { url: res.url, name: res.title || res.site, img: res.img || '' };
      /* v60: pantalla completa de espera desde el toque */
      S.mirrorInfo = { title: res.title || '', img: res.img || '', url: res.url, sub: 'Cargando tu sala…' };
      mostrarPeliLoading();
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

/* ======================= v78: Continuar viendo ======================= */
/* fila en el inicio con lo que dejaste a medias — la entrada también le
 * aparece a tu invitado (la estaban viendo juntos): cualquiera retoma */
async function cargarContinuar() {
  const box = document.querySelector('#continueBox');
  const fila = document.querySelector('#continueRow');
  if (!box || !fila || !S.profile) return;
  try {
    const r = await fetch('/api/continue?name=' + encodeURIComponent(S.profile.name) + '&tok=' + encodeURIComponent(S.profile.token));
    const d = await r.json();
    fila.innerHTML = '';
    /* v88: cada pestaña ve lo suyo — lo de la sala en Juntos, lo individual en Solo */
    const items = (d.items || []).filter((e) => (e.modo === 'solo') === (S.tab === 'solo'));
    if (!d.ok || !items.length) { box.classList.add('hidden'); return; }
    items.slice(0, 10).forEach((e) => fila.appendChild(crearTarjetaContinuar(e)));
    box.classList.remove('hidden');
  } catch {}
}
function crearTarjetaContinuar(e) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'sr-card cont-card';
  const srcImg = imgPorProxy(e.img || ''); /* v91: nunca dos veces */
  const pct = (e.d > 0) ? Math.max(4, Math.min(100, Math.round((e.t / e.d) * 100))) : 0;
  card.innerHTML = `
    ${srcImg
      ? `<img class="sr-cover" src="${srcImg}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="sr-cover sr-cover-anime"><svg class="icon icon-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg></span>`}
    <span class="sr-nombre"></span>
    ${e.ep ? '<span class="cont-ep"></span>' : ''}
    <span class="cont-barra"><i style="width:${pct}%"></i></span>
    <span class="cont-tiempo"></span>
    ${e.modo === 'solo' ? '<span class="cont-modo">solo</span>' : ''}`;
  card.querySelector('.sr-nombre').textContent = e.title || e.serie || 'Película';
  if (e.ep) card.querySelector('.cont-ep').textContent = e.ep;
  /* v86: episodio terminado con siguiente en la cadena → invita al próximo */
  const proximo = e.eps && e.eps.length > 1 && e.d > 0 && (+e.t >= e.d - 20 || (+e.t / e.d) >= 0.9);
  const tEl = card.querySelector('.cont-tiempo');
  if (proximo) {
    tEl.textContent = `Sigue con ${e.eps[1].ep || 'el próximo'} ▸`;
    tEl.classList.add('proximo');
  } else {
    tEl.textContent = `Quedaste en ${fmtTiempo(e.t)} de ${fmtTiempo(e.d)}`;
  }
  /* v79: X para quitar la entrada de la lista */
  const x = document.createElement('span');
  x.className = 'cont-x';
  x.title = 'Quitar de la lista';
  x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  x.addEventListener('click', (ev) => {
    ev.stopPropagation(); /* que no abra la peli */
    card.remove();
    const f = document.querySelector('#continueRow');
    const b = document.querySelector('#continueBox');
    if (f && !f.children.length && b) b.classList.add('hidden');
    if (S.profile) {
      fetch('/api/continue?name=' + encodeURIComponent(S.profile.name) + '&tok=' + encodeURIComponent(S.profile.token) + '&url=' + encodeURIComponent(e.url), { method: 'DELETE' }).catch(() => {});
    }
  });
  card.appendChild(x);
  const im = card.querySelector('img.sr-cover');
  if (im && e.img) {
    im.addEventListener('error', () => {
      const respaldo = /^\/api\/img/.test(e.img || '')
        ? e.img /* v91: ya va por el proxy — reintento tal cual */
        : /animeflv\.|latanime\./i.test(e.img)
          ? imgPorProxy(e.img)
          : 'https://wsrv.nl/?url=' + e.img.replace(/^https?:\/\//, '').split('?')[0] + '&w=240';
      if (im.src !== respaldo) im.src = respaldo;
    }, { once: true });
  }
  card.addEventListener('click', () => retomar(e));
  return card;
}
function retomar(e) {
  /* como tocar una tarjeta del inicio, pero recordando la posición */
  const t = Math.floor(+e.t || 0);
  const reanudar = !!(e.d && t > 10 && t < e.d - 20); /* si casi terminó, desde el inicio */
  if (e.modo === 'solo') {
    /* v86: terminó este episodio y hay siguiente → sigue con el próximo */
    const terminada = !!(e.d && (+e.t >= e.d - 20 || (+e.t / e.d) >= 0.9));
    const nxt = (e.eps && e.eps.length > 1) ? e.eps[1] : null;
    if (terminada && nxt && nxt.url) {
      abrirSolo(nxt.url, {
        title: e.serie || e.title || '', ep: nxt.ep || '',
        serie: e.serie || e.title || '', img: e.img || '',
        eps: e.eps.slice(1),
      });
      return;
    }
    /* v81: se estaba viendo en modo individual → vuelve al reproductor */
    abrirSolo(e.url, { title: e.title || '', ep: e.ep || '', serie: e.serie || '', img: e.img || '', eps: e.eps || [] }, { startAt: reanudar ? t : 0 });
    return;
  }
  S.resumeAt = reanudar ? { url: e.url, t } : null;
  S.pendingStart = { url: e.url, name: e.title || '', img: e.img || '' };
  S.mirrorInfo = { title: e.title || '', img: e.img || '', url: e.url, sub: 'Cargando tu sala…' };
  mostrarPeliLoading();
  const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  connect(code);
}

/* ======================= v81: modo individual ======================= */
/* Ver pelis y series directo en tu dispositivo, SIN sala y SIN el
 * navegador-espejo del servidor: /api/solo resuelve el m3u8 (goodstream)
 * con puros fetch y hls.js lo reproduce aquí. Si al navegador no le
 * sirve directo (el token puede venir amarrado a la IP del servidor),
 * re-servimos el stream por /api/hls. Los animes (filemoon) se quedan
 * en modo sala — no tienen extracción directa. */
/* v87: tres pestañas — Salas / Juntos / Solo (con iconos, sin emojis) */
try {
  let guardada = localStorage.getItem('huddle_tab');
  if (['salas', 'juntos', 'solo'].indexOf(guardada) < 0) guardada = null;
  if (guardada) S.tab = guardada;
  else {
    const viejo = localStorage.getItem('huddle_modo_solo');
    S.tab = viejo === '1' ? 'solo' : 'juntos'; /* migración desde el toggle viejo */
    if (viejo !== null) { try { localStorage.setItem('huddle_tab', S.tab); } catch {} } /* se consume una sola vez */
  }
} catch { S.tab = 'juntos'; }
const TAB_TEXTOS = {
  salas: ['Salas', 'Entra con el código de tu sala o únete a una que esté en vivo.'],
  juntos: ['¿Qué van a ver hoy?', 'Elige una película o serie y la sala se crea sola — comparte el link y míralo juntos.'],
  solo: ['¿Qué vas a ver hoy?', 'Mira películas y series sin ningún compañero — a tu ritmo.'],
};
function pintarTabs() {
  const t = TAB_TEXTOS[S.tab] ? S.tab : 'juntos';
  $('#tabSalas').classList.toggle('activa', t === 'salas');
  $('#tabJuntos').classList.toggle('activa', t === 'juntos');
  $('#tabSolo').classList.toggle('activa', t === 'solo');
  const main = $('#homeMain');
  if (main) main.classList.toggle('tab-salas', t === 'salas');
  const tt = TAB_TEXTOS[t];
  $('#heroTitle').textContent = tt[0];
  $('#heroSub').textContent = tt[1];
}
function setTab(tab, avisar) {
  if (!TAB_TEXTOS[tab]) tab = 'juntos';
  S.tab = tab;
  S.modoSolo = tab === 'solo';
  try {
    localStorage.setItem('huddle_tab', tab);
    localStorage.setItem('huddle_modo_solo', tab === 'solo' ? '1' : '0'); /* compatibilidad */
  } catch {}
  pintarTabs();
  if (avisar && tab === 'solo') toast('Modo individual — lo que abras se reproduce aquí mismo');
  cargarContinuar(); /* v88: la fila de "Continuar viendo" cambia con la pestaña */
}
$('#tabSalas').addEventListener('click', () => setTab('salas'));
$('#tabJuntos').addEventListener('click', () => setTab('juntos'));
$('#tabSolo').addEventListener('click', () => setTab('solo', true));
/* al arrancar solo se pinta — nada de escribir: así la migración desde el
 * toggle viejo (huddle_modo_solo) sigue funcionando en dispositivos viejos */
S.modoSolo = S.tab === 'solo';
pintarTabs();

let SOLO = null; /* { url, info, res, hls, viaProxy, startAt, seekHecho, timer, subsOn, cerrado } */
function cargarHlsJs(cb) {
  if (window.Hls) return cb(true);
  const s = document.createElement('script');
  s.src = '/hls.min.js';
  s.onload = () => cb(!!window.Hls);
  s.onerror = () => cb(false);
  document.head.appendChild(s);
}
async function abrirSolo(pageUrl, info, opts) {
  info = info || {}; opts = opts || {};
  if (!S.profile) { toast('Entra con tu perfil primero'); return; }
  if (SOLO) cerrarSolo();
  $('#soloTitle').textContent = info.title || info.serie || 'Reproduciendo';
  $('#soloEp').textContent = info.ep ? 'Episodio ' + info.ep : '';
  $('#soloCargando').classList.remove('hidden');
  $('#soloCtrls').classList.add('oculto');
  $('#soloTop').classList.remove('oculto'); /* v82: visible mientras carga, se esconde al reproducir */
  $('#soloBar').value = 0;
  $('#soloTime').textContent = '0:00 / 0:00';
  $('#soloCC').classList.remove('activa');
  const video = $('#soloVideo');
  video.removeAttribute('src');
  video.querySelectorAll('track').forEach((t) => t.remove());
  try { video.load(); } catch {}
  $('#soloPlayer').classList.remove('hidden');
  try { sincronizarGiros(); } catch {} /* v88: ¿celular vertical? → girado */
  /* v89: en el celular, el reproductor NACE a pantalla completa — con el
   * mismo toque con el que abriste la peli (el navegador solo permite
   * pantalla completa con un gesto del usuario). Así, al voltear el
   * teléfono, ya no hay que volver a pedirla: SE QUEDA ACOSTADO. */
  if (esCelular()) {
    try {
      const spEl = $('#soloPlayer');
      const rf = spEl.requestFullscreen || spEl.webkitRequestFullscreen;
      if (rf && !document.fullscreenElement && !document.webkitFullscreenElement) {
        const pr = rf.call(spEl);
        if (pr && pr.catch) pr.catch(() => {});
      }
    } catch {}
  }
  let rateInicial = 1;
  try { rateInicial = Math.min(2, Math.max(0.5, parseFloat(localStorage.getItem('huddle_rate')) || 1)); } catch {}
  SOLO = {
    url: pageUrl, info,
    startAt: Math.max(0, Math.floor(+opts.startAt || 0)),
    seekHecho: false, subsOn: false, viaProxy: false, cerrado: false,
    res: null, hls: null, timer: null, lastT: 0, reintentos: 0, tReconexion: 0, mountN: 0,
    rate: rateInicial,
    prevUrl: (opts && opts.prevUrl) || (info && info.prevUrl) || '', /* v86: de dónde venimos (avance de episodio) */
  };
  $('#soloRate').textContent = (rateInicial === 1 ? '1' : String(rateInicial)) + 'x'; /* v84 */
  $('#soloNext').classList.toggle('hidden', !(info && info.eps && info.eps.length > 1)); /* v84 */
  if (SOLO.startAt > 10) toast('Reanudando en ' + fmtTiempo(SOLO.startAt)); /* v82 */
  pararCuentaSiguiente(); /* v84 */
  if (/^\/test-media\//.test(pageUrl)) {
    /* v83: stream local de prueba — directo, sin resolver nada */
    SOLO.res = { m3u8: pageUrl, subs: [{ url: '/test-media/es.vtt', lang: 'es' }] };
    montarSolo(SOLO.res, false);
    return;
  }
  try {
    const r = await fetch('/api/solo?name=' + encodeURIComponent(S.profile.name) + '&tok=' + encodeURIComponent(S.profile.token) + '&url=' + encodeURIComponent(pageUrl));
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'No pude resolver el video');
    if (!SOLO || SOLO.url !== pageUrl || SOLO.cerrado) return; /* cerraron mientras buscaba */
    SOLO.res = d;
    montarSolo(d, !!d.proxy); /* v90: animes (mp4upload) y vimeos exigen proxy desde el inicio */
  } catch (e) {
    if (SOLO && SOLO.url === pageUrl && !SOLO.cerrado) {
      toast(String(e.message || e).slice(0, 120) + ' — ábrelo en la pestaña Juntos');
      cerrarSolo();
    }
  }
}
function montarSolo(d, viaProxy) {
  const video = $('#soloVideo');
  const src = viaProxy ? '/api/hls?u=' + encodeURIComponent(d.m3u8) : d.m3u8;
  if (SOLO.hls) { try { SOLO.hls.destroy(); } catch {} SOLO.hls = null; }
  /* v83: reset del elemento — al reusar un <video> cuyo MediaSource se
   * destruyó a medias, el attach nuevo a veces nunca pega (readyState 0
   * con play() pendiente por siempre). load() lo deja como nuevo. */
  try { video.pause(); } catch {}
  try { video.removeAttribute('src'); video.load(); } catch {}
  SOLO.viaProxy = viaProxy;
  cerrarMenusSolo(); /* v84 */
  try { $('#soloNext').classList.toggle('hidden', !(SOLO.info && SOLO.info.eps && SOLO.info.eps.length > 1)); } catch {}
  try { $('#soloQ').classList.add('hidden'); } catch {}
  /* v82: si esto es una RE-conexión (cayó el directo y seguimos por el
   * proxy), volvemos al minuto donde iba y no desde el inicio.
   * Ojo: hay que congelarlo AQUÍ — al remontar, un timeupdate con t=0
   * pisa SOLO.lastT antes de que llegue el loadedmetadata. v83: si el
   * remount ANTERIOR falló, lastT ya quedó en 0 → recordamos el último
   * minuto sano en tReconexion y lo reutilizamos. */
  const reT = SOLO.seekHecho ? Math.max(SOLO.lastT || 0, SOLO.tReconexion || 0) : 0;
  SOLO.tReconexion = reT;
  const reSeek = () => {
    if (!SOLO || SOLO.cerrado) return;
    if (SOLO.seekHecho && reT > 5 && isFinite(video.duration) && reT < video.duration - 10) {
      try { video.currentTime = reT; } catch {}
    }
  };
  video.addEventListener('loadedmetadata', reSeek, { once: true });
  setTimeout(reSeek, 1200);
  /* v83: perro guardián — si tras 25s no llegó ni un byte (readyState 0
   * con el play colgado), remontamos por el proxy como si hubiera error */
  const token = ++SOLO.mountN;
  setTimeout(() => {
    if (!SOLO || SOLO.cerrado || SOLO.mountN !== token) return;
    const v = $('#soloVideo');
    if (v.readyState === 0 && !v.paused && SOLO.res) {
      SOLO.reintentos = (SOLO.reintentos || 0) + 1;
      if (SOLO.reintentos <= 2) {
        toast('Reconectando… (' + SOLO.reintentos + ' de 2)');
        montarSolo(SOLO.res, true);
      } else { toast('Se cortó el video — vuelve a abrirlo'); cerrarSolo(); }
    }
  }, 25000);
  cargarHlsJs((okHls) => {
    if (!SOLO || SOLO.cerrado) return;
    ponerSubsSolo(d.subs || []);
    const hlsOk = okHls && window.Hls && window.Hls.isSupported();
    if (d.mp4) {
      /* v90: mp4 directo (animes de mp4upload) — el <video> nativo,
       * sin hls.js; el proxy ya manda el Referer por nosotros */
      video.src = src;
      video.addEventListener('error', () => {
        if (SOLO && !SOLO.cerrado) { toast('Se cortó el video — vuelve a abrirlo'); cerrarSolo(); }
      }, { once: true });
    } else if (hlsOk) {
      const hls = new window.Hls({ maxBufferLength: 30 });
      SOLO.hls = hls;
      prefiereEspanol(video, hls); /* v94: audio español si lo hay */
      /* v83: cuando llega el manifest sabemos qué calidades hay */
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        try { $('#soloQ').textContent = 'Auto'; cerrarQMenuSolo(); pintarQMenuSolo(); } catch {}
      });
      hls.on(window.Hls.Events.ERROR, (ev, data) => {
        if (!SOLO || !data || !data.fatal) return;
        if (!SOLO.viaProxy && data.type === window.Hls.ErrorTypes.NETWORK_ERROR && SOLO.res) {
          /* el token puede venir amarrado a la IP del servidor → proxy */
          toast('Conectando por el servidor…');
          montarSolo(SOLO.res, true);
        } else {
          try { hls.destroy(); } catch {}
          if (!SOLO.cerrado) {
            /* v83: goodstream a veces suelta 403 por ráfagas — reintentamos
             * un par de veces (volviendo al minuto, gracias a v82) */
            SOLO.reintentos = (SOLO.reintentos || 0) + 1;
            if (SOLO.reintentos <= 2) {
              toast('Reconectando… (' + SOLO.reintentos + ' de 2)');
              setTimeout(() => {
                if (SOLO && !SOLO.cerrado && SOLO.res) montarSolo(SOLO.res, true);
              }, 2500);
            } else { toast('Se cortó el video — vuelve a abrirlo'); cerrarSolo(); }
          }
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      /* Safari / iPhone: HLS nativo, sin hls.js */
      video.src = src;
      prefiereEspanol(video, null);
    } else {
      toast('Tu navegador no reproduce este video — ábrelo en la pestaña Juntos');
      cerrarSolo();
      return;
    }
    /* v83: tras un remount, el primer play() puede quedarse colgado en el
     * MediaSource destruido — arrancamos de nuevo cuando haya medios */
    const arrancar = () => {
      if (!SOLO || SOLO.cerrado) return;
      try { $('#soloVideo').playbackRate = SOLO.rate || 1; } catch {} /* v84: el remount la devuelve a 1x */
      if ($('#soloVideo').paused) $('#soloVideo').play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', arrancar, { once: true });
    video.addEventListener('loadeddata', arrancar, { once: true });
    setTimeout(arrancar, 1500);
    setTimeout(arrancar, 4000);
    video.play().catch(() => {});
  });
}
function ponerSubsSolo(subs) {
  const video = $('#soloVideo');
  const esp = subs.find((s) => s.lang === 'es') || subs.find((s) => s.lang === 'es-419') || subs[0];
  if (!esp) { $('#soloCC').classList.add('hidden'); return; }
  $('#soloCC').classList.remove('hidden');
  const tr = document.createElement('track');
  tr.kind = 'subtitles';
  tr.src = '/api/hls?u=' + encodeURIComponent(esp.url); /* por el proxy: algunos nodos piden Referer de goodstream */
  tr.srclang = esp.lang === 'en' ? 'en' : 'es';
  tr.label = esp.lang === 'es-419' ? 'Latino' : esp.lang === 'en' ? 'English' : 'Español';
  video.appendChild(tr);
  const activar = () => {
    const tt = video.textTracks && video.textTracks[0];
    if (tt) tt.mode = SOLO.subsOn ? 'showing' : 'hidden';
  };
  setTimeout(activar, 500);
  video.addEventListener('loadedmetadata', activar, { once: true });
}
function soloReportar() {
  if (!SOLO || !S.profile || !SOLO.url) return;
  const video = $('#soloVideo');
  const t = video ? Math.floor(video.currentTime || 0) : 0;
  const d = (video && isFinite(video.duration)) ? Math.floor(video.duration) : 0;
  if (!d) return;
  fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: S.profile.name, token: S.profile.token, url: SOLO.url, t, d,
      title: SOLO.info.title || '', img: SOLO.info.img || '',
      ep: String(SOLO.info.ep || ''), serie: SOLO.info.serie || '', modo: 'solo',
      prevUrl: SOLO.prevUrl || '', /* v86 */
      eps: (SOLO.info.eps || []).slice(0, 100).map((x) => ({ url: x.url, ep: String(x.ep || '') })), /* v86 */
    }),
  }).catch(() => {});
}
function soloSetPlayIco(playing) {
  $('#soloPlayIco').innerHTML = playing
    ? '<path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.6z"/>'
    : '<path d="M8 5.5v13l11-6.5z"/>';
}
let soloCtrlTimer = null;
function mostrarSoloCtrls5s() {
  const c = $('#soloCtrls');
  const t = $('#soloTop'); /* v82: la barra de arriba también se va con los controles */
  if (!c) return;
  c.classList.remove('oculto');
  if (t) t.classList.remove('oculto');
  if (soloCtrlTimer) clearTimeout(soloCtrlTimer);
  soloCtrlTimer = setTimeout(() => {
    c.classList.add('oculto');
    if (t) t.classList.add('oculto');
    cerrarMenusSolo(); /* v84: ningún menú queda flotando solo */
    soloCtrlTimer = null;
  }, 5000);
}
function cerrarSolo() {
  if (soloCtrlTimer) { clearTimeout(soloCtrlTimer); soloCtrlTimer = null; }
  try { /* v89: si el reproductor estaba a pantalla completa, se suelta */
    if ((document.fullscreenElement || document.webkitFullscreenElement) === $('#soloPlayer')) {
      const xf = document.exitFullscreen || document.webkitExitFullscreen;
      if (xf) xf.call(document);
    }
  } catch {}
  cerrarMenusSolo();
  pararCuentaSiguiente(); /* v84 */
  if (SOLO) {
    SOLO.cerrado = true;
    try { soloReportar(); } catch {}
    if (SOLO.timer) { clearInterval(SOLO.timer); SOLO.timer = null; }
    if (SOLO.hls) { try { SOLO.hls.destroy(); } catch {} }
  }
  const video = $('#soloVideo');
  try { video.pause(); } catch {}
  try { document.body.classList.remove('solo-girado'); } catch {} /* v88 */
  video.removeAttribute('src');
  video.querySelectorAll('track').forEach((t) => t.remove());
  try { video.load(); } catch {}
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
  $('#soloPlayer').classList.add('hidden');
  SOLO = null;
  cargarContinuar(); /* refresca la fila de "Continuar viendo" */
}
$('#soloBack').addEventListener('click', cerrarSolo);
/* v83: toque simple = controles o play/pausa; DOBLE toque a los lados
 * adelanta/atrasa 10s (como YouTube) y al centro pausa; en escritorio
 * el doble clic amplía a pantalla completa */
const soloTap = { t: 0, x: -1, tipo: '', timer: null };
function soloFlashSeek(delta) {
  const f = $('#soloFlash');
  if (!f) return;
  /* v88: iconos SVG — nada de emojis */
  f.innerHTML = (delta < 0
    ? '<svg class="icon icon-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 3v5h5"/><path d="m13 9-3 3 3 3"/></svg>'
    : '<svg class="icon icon-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v5h-5"/><path d="m11 9 3 3-3 3"/></svg>')
    + '<b>' + Math.abs(delta) + ' s</b>';
  f.classList.toggle('izq', delta < 0);
  f.classList.remove('anim');
  void f.offsetWidth; /* reinicia la animación */
  f.classList.add('anim');
}
$('#soloVideo').addEventListener('pointerdown', (ev) => {
  if (!$('#soloCargando').classList.contains('hidden')) return; /* aún cargando */
  cerrarMenusSolo();
  const tipo = ev.pointerType || 'mouse';
  const rect = $('#soloPlayer').getBoundingClientRect();
  const x = (ev.clientX || 0) - rect.left;
  const ahora = Date.now();
  if (ahora - soloTap.t < 330 && soloTap.tipo === tipo && Math.abs(x - soloTap.x) < 90) {
    /* doble toque */
    if (soloTap.timer) { clearTimeout(soloTap.timer); soloTap.timer = null; }
    soloTap.t = 0;
    const v = $('#soloVideo');
    const w = rect.width || 1;
    if (tipo === 'mouse') soloToggleFs(); /* escritorio: doble clic = ampliar */
    else if (x < w * 0.35) { try { v.currentTime = Math.max(0, v.currentTime - 10); } catch {} soloFlashSeek(-10); }
    else if (x > w * 0.65) { try { v.currentTime = Math.min(Math.max(0, (v.duration || 1e9) - 2), v.currentTime + 10); } catch {} soloFlashSeek(10); }
    else if (v.paused) v.play().catch(() => {}); else v.pause();
    mostrarSoloCtrls5s();
    return;
  }
  soloTap.t = ahora; soloTap.x = x; soloTap.tipo = tipo;
  if (soloTap.timer) clearTimeout(soloTap.timer);
  soloTap.timer = setTimeout(() => {
    soloTap.timer = null;
    if ($('#soloCtrls').classList.contains('oculto')) { mostrarSoloCtrls5s(); return; }
    const video = $('#soloVideo');
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }, 300);
});
$('#soloPlay').addEventListener('click', () => {
  const video = $('#soloVideo');
  if (video.paused) video.play().catch(() => {}); else video.pause();
});
$('#soloBar').addEventListener('input', () => {
  mostrarSoloCtrls5s(); /* v82: mientras arrastras, los controles no se esconden */
  const video = $('#soloVideo');
  if (isFinite(video.duration) && video.duration > 0) {
    $('#soloTime').textContent = fmtTiempo((+$('#soloBar').value / 1000) * video.duration) + ' / ' + fmtTiempo(video.duration);
  }
});
$('#soloBar').addEventListener('change', () => {
  const video = $('#soloVideo');
  if (isFinite(video.duration) && video.duration > 0) {
    video.currentTime = (+$('#soloBar').value / 1000) * video.duration;
  }
});
$('#soloCC').addEventListener('click', () => {
  const video = $('#soloVideo');
  const tt = video.textTracks && video.textTracks[0];
  if (!tt) { toast('Este video no trae subtítulos'); return; }
  SOLO.subsOn = !SOLO.subsOn;
  tt.mode = SOLO.subsOn ? 'showing' : 'hidden';
  $('#soloCC').classList.toggle('activa', SOLO.subsOn);
});
function soloToggleFs() {
  const el = $('#soloPlayer');
  try {
    if (document.fullscreenElement) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); }
    else if (el.requestFullscreen) { const p = el.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    else if ($('#soloVideo').webkitEnterFullscreen) $('#soloVideo').webkitEnterFullscreen(); /* iOS */
  } catch {}
}
$('#soloFs').addEventListener('click', soloToggleFs);
/* v83: calidad — los niveles del hls.js (Auto / 480p / 360p…) para
 * cuidar los datos móviles; en HLS nativo (Safari) no se puede → oculto */
function cerrarQMenuSolo() { const m = $('#soloQMenu'); if (m) m.classList.add('hidden'); }
function cerrarMenusSolo() { /* v84: calidad y velocidad juntas */
  cerrarQMenuSolo();
  const m = $('#soloRateMenu');
  if (m) m.classList.add('hidden');
}
function pintarQMenuSolo() {
  const btn = $('#soloQ');
  const menu = $('#soloQMenu');
  if (!btn || !menu) return;
  const niveles = [];
  if (SOLO && SOLO.hls && SOLO.hls.levels) {
    SOLO.hls.levels.forEach((l, i) => { if (l && (l.height || l.bitrate)) niveles.push({ i, h: l.height || 0 }); });
  }
  niveles.sort((a, b) => b.h - a.h);
  if (!niveles.length) { btn.classList.add('hidden'); menu.innerHTML = ''; cerrarQMenuSolo(); return; }
  btn.classList.remove('hidden');
  menu.innerHTML = '';
  const items = [{ i: -1, txt: 'Auto' }].concat(niveles.map((n) => ({ i: n.i, txt: n.h ? n.h + 'p' : 'Nivel ' + (n.i + 1) })));
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    const auto = SOLO.hls.autoLevelEnabled;
    b.className = 'solo-qitem' + ((it.i === -1 && auto) || (it.i >= 0 && !auto && SOLO.hls.currentLevel === it.i) ? ' activa' : '');
    b.textContent = it.txt;
    b.addEventListener('click', () => {
      if (SOLO && SOLO.hls) {
        SOLO.hls.nextLevel = it.i; /* -1 = automática */
        btn.textContent = it.i === -1 ? 'Auto' : it.txt;
        toast(it.i === -1 ? 'Calidad: autom\u00e1tica' : 'Calidad: ' + it.txt);
      }
      cerrarQMenuSolo();
      mostrarSoloCtrls5s();
    });
    menu.appendChild(b);
  });
}
$('#soloQ').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const m = $('#soloQMenu');
  const abierto = !m.classList.contains('hidden');
  cerrarMenusSolo(); /* v84: abre uno, cierra el otro */
  if (!abierto) { pintarQMenuSolo(); m.classList.remove('hidden'); }
  mostrarSoloCtrls5s();
});

/* v84: velocidad de reproducción — 0.5x a 2x, se recuerda por perfil */
const SOLO_RATES = [0.5, 1, 1.25, 1.5, 2];
function soloSetRate(r, avisar) {
  r = SOLO_RATES.includes(r) ? r : 1;
  if (SOLO) SOLO.rate = r;
  try { $('#soloVideo').playbackRate = r; } catch {}
  $('#soloRate').textContent = (r === 1 ? '1' : String(r)) + 'x';
  try { localStorage.setItem('huddle_rate', String(r)); } catch {}
  if (avisar) toast(r === 1 ? 'Velocidad normal' : 'Velocidad ' + r + 'x');
}
function pintarRateMenuSolo() {
  const menu = $('#soloRateMenu');
  if (!menu) return;
  menu.innerHTML = '';
  const actual = (SOLO && SOLO.rate) || 1;
  SOLO_RATES.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'solo-qitem' + (r === actual ? ' activa' : '');
    b.textContent = (r === 1 ? '1' : String(r)) + 'x' + (r === 1 ? ' (normal)' : '');
    b.addEventListener('click', () => { soloSetRate(r, true); cerrarMenusSolo(); mostrarSoloCtrls5s(); });
    menu.appendChild(b);
  });
}
$('#soloRate').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const m = $('#soloRateMenu');
  const abierto = !m.classList.contains('hidden');
  cerrarMenusSolo(); /* v84: abre uno, cierra el otro */
  if (!abierto) { pintarRateMenuSolo(); m.classList.remove('hidden'); }
  mostrarSoloCtrls5s();
});

/* v84: siguiente episodio — la cadena viaja en info.eps (desde el actual) */
function soloSiguiente() {
  if (!SOLO || !SOLO.info || !SOLO.info.eps || SOLO.info.eps.length < 2) return;
  const lista = SOLO.info.eps.slice(1);
  const nxt = lista[0];
  abrirSolo(nxt.url, {
    title: SOLO.info.serie || SOLO.info.title || '',
    ep: nxt.ep || '',
    serie: SOLO.info.serie || SOLO.info.title || '',
    img: SOLO.info.img || '',
    eps: lista,
    prevUrl: SOLO.url, /* v86: que la entrada anterior no se acumule */
  });
}
$('#soloNext').addEventListener('click', soloSiguiente);
let cuentaTimer = null;
function pararCuentaSiguiente() {
  if (cuentaTimer) { clearInterval(cuentaTimer); cuentaTimer = null; }
  const e = $('#soloEnd');
  if (e) e.classList.add('hidden');
}
function iniciarCuentaSiguiente() {
  const nxt = SOLO.info.eps[1];
  $('#soloEndEp').textContent = nxt.ep ? 'Episodio ' + nxt.ep : (nxt.nombre || 'Siguiente');
  $('#soloEnd').classList.remove('hidden');
  let n = 5;
  $('#soloEndCuenta').textContent = 'En 5…';
  if (cuentaTimer) clearInterval(cuentaTimer);
  cuentaTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) { pararCuentaSiguiente(); soloSiguiente(); return; }
    $('#soloEndCuenta').textContent = 'En ' + n + '…';
  }, 1000);
}
$('#soloEndAhora').addEventListener('click', () => { pararCuentaSiguiente(); soloSiguiente(); });
$('#soloEndCancelar').addEventListener('click', pararCuentaSiguiente);

(() => {
  const video = $('#soloVideo');
  video.addEventListener('timeupdate', () => {
    if (!SOLO) return;
    SOLO.lastT = video.currentTime; /* v82: por si hay que reconectar en medio */
    if (!SOLO.seekHecho && isFinite(video.duration) && video.duration > 0) {
      /* retomar donde se quedó (o desde el inicio si ya casi la termina) */
      if (SOLO.startAt > 0 && SOLO.startAt < video.duration - 5) {
        try { video.currentTime = SOLO.startAt; } catch {}
      }
      SOLO.seekHecho = true;
      SOLO.d = video.duration;
      if (!SOLO.timer) {
        SOLO.timer = setInterval(() => {
          const v = $('#soloVideo');
          if (SOLO && v && !v.paused && !v.ended) soloReportar();
        }, 10000);
      }
    }
    if (isFinite(video.duration) && video.duration > 0) {
      $('#soloBar').value = String(Math.round((video.currentTime / video.duration) * 1000));
      $('#soloTime').textContent = fmtTiempo(video.currentTime) + ' / ' + fmtTiempo(video.duration);
    }
  });
  video.addEventListener('playing', () => {
    $('#soloCargando').classList.add('hidden');
    soloSetPlayIco(true);
    if (SOLO) SOLO.reintentos = 0; /* v83: ya está corriendo de nuevo */
    mostrarSoloCtrls5s();
  });
  video.addEventListener('pause', () => { soloSetPlayIco(false); mostrarSoloCtrls5s(); });
  video.addEventListener('ended', () => {
    soloReportar();
    mostrarSoloCtrls5s();
    /* v84: si hay episodio siguiente → cuenta regresiva y avanza solo */
    if (SOLO && !SOLO.cerrado && SOLO.info && SOLO.info.eps && SOLO.info.eps.length > 1) iniciarCuentaSiguiente();
  });
  video.addEventListener('error', () => {
    if (SOLO && !SOLO.cerrado && !SOLO.hls && !SOLO.viaProxy && SOLO.res) {
      /* HLS nativo que no arrancó directo → por el proxy */
      toast('Conectando por el servidor…');
      montarSolo(SOLO.res, true);
    }
  });
  $('#soloPlayer').addEventListener('pointermove', () => {
    if (!$('#soloCargando').classList.contains('hidden')) return;
    mostrarSoloCtrls5s();
  });
})();
/* =================== fin v81: modo individual =================== */

/* v55: populares del día — fila en el inicio, un toque crea la sala */
async function cargarPopulares() {
  const wrap = document.querySelector('#trendingBox');
  const fila = document.querySelector('#trendingRow');
  const wrapS = document.querySelector('#seriesBox'); /* v57: series recién agregadas */
  const filaS = document.querySelector('#seriesRow');
  const wrapA = document.querySelector('#animesBox'); /* v67: animes del momento */
  const filaA = document.querySelector('#animesRow');
  if (!wrap || !fila || wrap.dataset.cargado) return;
  wrap.dataset.cargado = '1';
  try {
    const r = await fetch('/api/trending');
    const d = await r.json();
    /* v69: cada sección se muestra con lo que llegue — los animes (arriba)
     * no dependen de que las películas hayan cargado */
    const hayAlgo = (d.results && d.results.length) || (d.series && d.series.length) || (d.animes && d.animes.length);
    if (!d.ok || !hayAlgo) { delete wrap.dataset.cargado; return; }
    const alTocar = (res) => () => {
      if (elegirTitulo(res)) return; /* v61: series → temporadas y episodios */
      if (S.modoSolo) { /* v81: sin sala — directo en tu dispositivo */
        abrirSolo(res.url, { title: res.title || '', img: res.img || '' });
        return;
      }
      S.pendingStart = { url: res.url, name: res.title, img: res.img || '' };
      /* v60: carátula a pantalla completa desde YA — la sala carga por detrás */
      S.mirrorInfo = { title: res.title || '', img: res.img || '', url: res.url, sub: 'Cargando tu sala…' };
      mostrarPeliLoading();
      const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      connect(code);
    };
    if (d.results && d.results.length) {
      d.results.slice(0, 16).forEach((res) => fila.appendChild(crearTarjetaResultado(res, alTocar(res))));
      wrap.classList.remove('hidden');
    }
    /* v57: segunda fila — series recién agregadas */
    if (wrapS && filaS && d.series && d.series.length) {
      d.series.slice(0, 16).forEach((res) => filaS.appendChild(crearTarjetaResultado(res, alTocar(res))));
      wrapS.classList.remove('hidden');
    }
    /* v67: tercera fila — animes del momento (Latanime); un toque abre
     * el selector de episodios, igual que cualquier anime */
    if (wrapA && filaA && d.animes && d.animes.length) {
      d.animes.slice(0, 16).forEach((res) => filaA.appendChild(crearTarjetaResultado(res, alTocar(res))));
      wrapA.classList.remove('hidden');
    }
  } catch {
    delete wrap.dataset.cargado; /* si falló, se reintenta la próxima vez */
  }
}
$('#btnVolver').addEventListener('click', () => {
  const code = leerLastRoom();
  if (code) connect(code);
});

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
      if (elegirTitulo(res, true)) return; /* v61: series → temporadas y episodios */
      /* v59: carátula de lo elegido mientras abre en el espejo */
      S.mirrorInfo = { title: res.title || '', img: res.img || '', url: res.url, sub: 'Abriendo en el espejo…' };
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
