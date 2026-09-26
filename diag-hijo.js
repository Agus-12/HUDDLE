/* v356.3: diag-hijo — guardián que atrapa al bucle congelador.
 * Vigila el CPU del padre (huddle). Si lleva 15 s quemando ~100% de un núcleo
 * (firmemente atascado), activa el inspector del padre con SIGUSR1, se conecta
 * por CDP (WebSocket pelado, sin dependencias), pausa el debugger y VOLCA LA
 * PILA JS exacta (función + archivo + línea) a /home/ubuntu/huddle-diag-pila.log
 * — después mata al padre para que systemd lo releve al instante. */
const PPID = Number(process.argv[2]);
if (!PPID || PPID < 2) process.exit(1);
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

const path = require('path');
const LOG = process.env.HUDDLE_DIAG_LOG || (fs.existsSync('/home/ubuntu') ? '/home/ubuntu/huddle-diag-pila.log' : path.join(__dirname, 'data', 'diag-pila.log'));
function log(s) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n'); } catch {} try { console.log('[diag-hijo] ' + s); } catch {} }

function ticks() {
  try {
    const st = fs.readFileSync('/proc/' + PPID + '/stat', 'utf8');
    const p = st.slice(st.lastIndexOf(')') + 2).split(' ');
    return Number(p[11]) + Number(p[12]); /* utime + stime */
  } catch { return -1; }
}

let prev = ticks();
let calienteDesde = 0;
let volcando = false;

setInterval(() => {
  if (volcando) return;
  const t = ticks();
  if (t < 0) process.exit(0); /* el padre ya no existe */
  const d = t - prev; prev = t;
  /* 3 s de ventana a 100 ticks/s: >=240 ticks = ~80%+ de un núcleo */
  if (d >= 240) {
    if (!calienteDesde) calienteDesde = Date.now();
    else if (Date.now() - calienteDesde >= 15000) { volcando = true; log('padre a ~100% CPU por 15 s — volcando pila…'); volcar(); }
  } else calienteDesde = 0;
}, 3000); /* sin unref: el hijo vive para vigilar (muere solo cuando el padre no exista) */

function volcar() {
  try { process.kill(PPID, 'SIGUSR1'); } catch (e) { log('SIGUSR1 falló: ' + e.message); terminar(); return; }
  let intentos = 0;
  const iv = setInterval(() => {
    intentos++;
    pedirJson((info) => {
      clearInterval(iv);
      const target = (Array.isArray(info) ? info : []).find((t) => t.webSocketDebuggerUrl && !/node\.(js|internal)/i.test(t.url || '')) || (Array.isArray(info) ? info[0] : null);
      if (!target || !target.webSocketDebuggerUrl) { log('inspector sin target: ' + JSON.stringify(info).slice(0, 200)); terminar(); return; }
      cdp(target.webSocketDebuggerUrl);
    });
    if (intentos > 10) { clearInterval(iv); log('inspector nunca abrió 9229 — mato al padre sin pila'); terminar(); }
  }, 1000);
}

function pedirJson(cb) {
  const rq = http_get('http://127.0.0.1:9229/json/list', (err, body) => {
    if (err) return cb(null);
    try { cb(JSON.parse(body)); } catch { cb(null); }
  });
  rq.setTimeout(2000, () => rq.destroy(new Error('timeout')));
}
const http = require('http');
function http_get(u, cb) {
  try { const r = http.get(u, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => cb(null, d)); }); r.on('error', (e) => cb(e)); return r; }
  catch (e) { cb(e); return { setTimeout() {} }; }
}

/* ── WebSocket pelado (suficiente para CDP: texto, sin fragmentación asumida) ── */
function cdp(wsUrl) {
  const u = new URL(wsUrl);
  const sock = net.connect(9229, '127.0.0.1');
  const key = crypto.randomBytes(16).toString('base64');
  let buf = Buffer.alloc(0);
  let fase = 0; /* 0=handshake, 1=frames */
  let idc = 10;
  const pendientes = new Map();

  const enviar = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const mascara = crypto.randomBytes(4);
    let cab;
    if (payload.length < 126) cab = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) { cab = Buffer.alloc(4); cab[0] = 0x81; cab[1] = 0x80 | 126; cab.writeUInt16BE(payload.length, 2); }
    else { cab = Buffer.alloc(10); cab[0] = 0x81; cab[1] = 0x80 | 127; cab.writeBigUInt64BE(BigInt(payload.length), 2); }
    const enm = Buffer.from(payload.map((b, i) => b ^ mascara[i % 4]));
    sock.write(Buffer.concat([cab, mascara, enm]));
  };
  const mandar = (method, params) => new Promise((ok) => { const id = ++idc; pendientes.set(id, ok); enviar({ id, method, params: params || {} }); });

  sock.on('connect', () => {
    sock.write('GET ' + (u.pathname || '/') + ' HTTP/1.1\r\nHost: 127.0.0.1:9229\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (fase === 0) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      buf = buf.slice(i + 4); fase = 1;
      arranque();
    }
    while (fase === 1 && buf.length >= 2) {
      const b1 = buf[0], b2 = buf[1];
      const op = b1 & 0x0f;
      let lon = b2 & 0x7f, ini = 2;
      if (lon === 126) { if (buf.length < 4) return; lon = buf.readUInt16BE(2); ini = 4; }
      else if (lon === 127) { if (buf.length < 10) return; lon = Number(buf.readBigUInt64BE(2)); ini = 10; }
      if (buf.length < ini + lon) return;
      const payload = buf.slice(ini, ini + lon);
      buf = buf.slice(ini + lon);
      if (op === 1) { try { mensaje(JSON.parse(payload.toString('utf8'))); } catch {} }
      else if (op === 8) { try { sock.end(); } catch {} }
      /* ping(9): el CDP rara vez pincha en sesiones cortas; ignoro */
    }
  });
  sock.on('error', (e) => { log('ws error: ' + e.message); terminar(); });

  async function arranque() {
    await mandar('Debugger.enable');
    await mandar('Runtime.enable');
    await new Promise((r) => setTimeout(r, 300));
    await mandar('Debugger.pause');
    setTimeout(() => { log('paused nunca llegó — mato sin pila'); terminar(); }, 10000).unref();
  }
  let pila = '';
  function mensaje(m) {
    if (m.id && pendientes.has(m.id)) { pendientes.get(m.id)(m.result); pendientes.delete(m.id); }
    if (m.method === 'Debugger.paused') {
      const fs2 = (m.params && m.params.callFrames) || [];
      pila = fs2.slice(0, 20).map((f, i) => '#' + i + ' ' + (f.functionName || '(anónima)') + ' @ ' + (f.url || '?').replace(/^file:\/\//, '') + ':' + (f.location ? f.location.lineNumber + ':' + f.location.columnNumber : '?')).join('\n');
      log('PILA CONGELADA:\n' + pila);
      mandar('Debugger.resume').then(() => setTimeout(terminar, 500));
    }
  }
}
function terminar() { try { process.kill(PPID, 'SIGKILL'); } catch {} try { log('padre reiniciado (SIGKILL) — systemd lo releva'); } catch {} setTimeout(() => process.exit(0), 300); }
