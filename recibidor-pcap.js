#!/usr/bin/env node
'use strict';

/*
 * Recibidor de capturas PCAP de PCAPdroid.
 *
 * MODO RECOMENDADO (predeterminado): TCP Exporter / pcap-over-IP
 *   En Oracle:
 *     PCAP_MODE=tcp nohup node recibidor-pcap.js > ~/recibidor.log 2>&1 &
 *   En PCAPdroid:
 *     Volcado PCAP → TCP Exporter → IP del servidor + puerto 8080
 *
 * PCAPdroid "HTTP Server" NO manda el archivo al servidor: convierte al
 * TELÉFONO en servidor para descargarlo desde la misma red. Por eso no sirve
 * para enviar una captura hacia Oracle. Usa TCP Exporter o el modo http de
 * abajo para subir un archivo PCAP ya guardado en el teléfono.
 *
 * MODO ALTERNATIVO: página web de carga de un PCAP ya guardado
 *   PCAP_MODE=http PCAP_TOKEN='una-clave-larga' \
 *   nohup node recibidor-pcap.js > ~/recibidor.log 2>&1 &
 *   Luego abrir http://IP-DEL-SERVIDOR:8080/ en el navegador del teléfono,
 *   elegir el archivo y escribir la misma clave.
 *
 * Variables opcionales:
 *   PCAP_MODE=tcp|http       (tcp por defecto)
 *   PCAP_OUT=/home/ubuntu/captura-movie.pcap
 *   PCAP_PORT=8080
 *   PCAP_MAX_MB=1024
 *   PCAP_IDLE_SECONDS=900    (solo TCP)
 *   PCAP_TOKEN=...           (solo HTTP; muy recomendable)
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

/*
 * Libera el puerto antes de escuchar.
 * Motivo: en el servidor quedaron procesos mitmdump colgados de sesiones anteriores que
 * `pkill -f mitmdump` no alcanzaba, y el recibidor moría con EADDRINUSE sin dar pista.
 * Con --matar-puerto el recibidor mata él mismo lo que ocupe su puerto.
 */
function matarLoQueOcupaElPuerto(puerto) {
  const { execSync } = require('child_process');
  let pids = [];
  try {
    const out = execSync(`ss -tlnpH 'sport = :${puerto}' 2>/dev/null || true`, { encoding: 'utf8' });
    pids = [...out.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
  } catch { /* sin ss: se intenta fuser igual */ }
  if (pids.length) {
    log(`Puerto ${puerto} ocupado por pid ${[...new Set(pids)].join(', ')} — matándolo`);
    for (const pid of new Set(pids)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch {}
    }
  } else {
    try { execSync(`fuser -k ${puerto}/tcp 2>/dev/null || true`); } catch {}
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    try {
      const out = execSync(`ss -tlnH 'sport = :${puerto}' 2>/dev/null || true`, { encoding: 'utf8' });
      if (!out.trim()) break;
    } catch { break; }
    const { execSync: e2 } = require('child_process');
    e2('sleep 0.3');
  }
}

const MODE = String(process.env.PCAP_MODE || 'tcp').trim().toLowerCase();
const ARCHIVO = path.resolve(process.env.PCAP_OUT || '/home/ubuntu/captura-movie.pcap');
const STATUS_FILE = path.resolve(process.env.PCAP_STATUS_OUT || `${ARCHIVO}.status.json`);
const PORT = Number(process.env.PCAP_PORT || 8080);
const MATAR_PUERTO = process.argv.includes('--matar-puerto') || String(process.env.PCAP_KILL_PORT || '') === '1';
/* IP(s) permitidas, separadas por coma. Vacío = aceptar de cualquiera (solo conviene con
 * un puerto raro). Con esto puesto, los bots de internet ni se registran en el log. */
const PERMITIDAS = String(process.env.PCAP_ALLOW_IP || '')
  .split(',').map((x) => x.trim()).filter(Boolean).map(normalizarIp);

function normalizarIp(direcc) {
  const d = String(direcc || '');
  return d.startsWith('::ffff:') ? d.slice(7) : d;
}
const TOKEN = String(process.env.PCAP_TOKEN || '');
const maxMbRaw = Number(process.env.PCAP_MAX_MB || 1024);
const MAX_BYTES = Number.isFinite(maxMbRaw) && maxMbRaw > 0
  ? Math.floor(maxMbRaw * 1024 * 1024)
  : 1024 * 1024 * 1024;
const idleRaw = Number(process.env.PCAP_IDLE_SECONDS || 900);
const IDLE_MS = Number.isFinite(idleRaw) && idleRaw > 0 ? Math.floor(idleRaw * 1000) : 15 * 60 * 1000;

if (!['tcp', 'http'].includes(MODE)) {
  console.error(`PCAP_MODE no válido: ${MODE}. Usa tcp o http.`);
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`PCAP_PORT no válido: ${process.env.PCAP_PORT || ''}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
const iniciado = new Date().toISOString();
let recibiendo = false;
let bytesGuardados = 0;
try { bytesGuardados = fs.statSync(ARCHIVO).size; } catch {}
let bytesEnCurso = 0;
let cargas = 0;
let ultimoError = '';
let servidor = null;

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function estado(extra = {}) {
  const visibles = recibiendo ? bytesEnCurso : bytesGuardados;
  return {
    ok: true,
    mode: MODE,
    receiving: recibiendo,
    uploads: cargas,
    bytes: visibles,
    size: bytes(visibles),
    storedBytes: bytesGuardados,
    storedSize: bytes(bytesGuardados),
    maxUpload: MAX_BYTES,
    maxUploadSize: bytes(MAX_BYTES),
    protected: MODE === 'http' && !!TOKEN,
    startedAt: iniciado,
    lastError: ultimoError || undefined,
    ...extra,
  };
}

function guardarEstado(extra) {
  /* Un archivo pequeño para poder comprobar el receptor por la consola de
   * Oracle, incluso en el modo TCP que no usa HTTP. No contiene la clave. */
  const temporal = `${STATUS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporal, JSON.stringify(estado(extra), null, 2));
    fs.renameSync(temporal, STATUS_FILE);
  } catch (err) {
    console.warn(`No pude guardar estado: ${err.message}`);
  }
}

function archivoTemporal() {
  return path.join(path.dirname(ARCHIVO), `.${path.basename(ARCHIVO)}.${process.pid}.${Date.now()}.part`);
}

function log(mensaje) {
  console.log(`[${new Date().toISOString()}] ${mensaje}`);
}

function esPcap(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const magic = buffer.subarray(0, 4).toString('hex');
  return [
    'd4c3b2a1', // pcap little-endian, microseconds
    'a1b2c3d4', // pcap big-endian, microseconds
    '4d3cb2a1', // pcap little-endian, nanoseconds
    'a1b23c4d', // pcap big-endian, nanoseconds
    '0a0d0d0a', // pcapng
  ].includes(magic);
}

function tokenDe(req, url) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return String(url.searchParams.get('token') || req.headers['x-pcap-token'] || bearer || '');
}

function tokenValido(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function limitar(max) {
  let recibidos = 0;
  return {
    stream: new Transform({
      transform(chunk, _enc, done) {
        recibidos += chunk.length;
        if (recibidos > max) {
          const err = new Error(`La carga supera el límite de ${bytes(max)}`);
          err.code = 'LIMIT';
          done(err);
          return;
        }
        done(null, chunk);
      },
    }),
    size: () => recibidos,
  };
}

function validarPcap() {
  let inicio = Buffer.alloc(0);
  let validado = false;
  const invalido = () => {
    const err = new Error('El archivo no empieza como PCAP o PCAPNG');
    err.code = 'PCAP_INVALIDO';
    return err;
  };
  return new Transform({
    transform(chunk, _enc, done) {
      if (!validado) {
        const faltan = 4 - inicio.length;
        if (faltan > 0) inicio = Buffer.concat([inicio, chunk.subarray(0, faltan)]);
        if (inicio.length >= 4) {
          if (!esPcap(inicio)) { done(invalido()); return; }
          validado = true;
        }
      }
      done(null, chunk);
    },
    flush(done) {
      if (!validado) { done(invalido()); return; }
      done();
    },
  });
}

async function reemplazarCon(temporal) {
  /* El resultado se publica al final, para nunca dejar un PCAP con dos
   * cabeceras pegadas ni un archivo final a medias. */
  await fsp.rename(temporal, ARCHIVO);
}

function responder(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function paginaCarga() {
  const requiereClave = TOKEN ? 'Sí, escribe la clave del servidor.' : 'No (configura PCAP_TOKEN para proteger esta página).';
  return `<!doctype html>
<html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subir PCAP</title>
<style>
  body{margin:0;background:#0a0713;color:#f5f2ff;font:16px system-ui,-apple-system,sans-serif;display:grid;min-height:100vh;place-items:center;padding:20px;box-sizing:border-box}
  main{width:min(100%,480px);background:#171121;border:1px solid #302546;border-radius:18px;padding:24px;box-sizing:border-box;box-shadow:0 18px 60px #0008}
  h1{font-size:22px;margin:0 0 8px}p{color:#c9bedb;line-height:1.45}label{display:block;margin:17px 0 6px;color:#e9ddff;font-weight:600}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #51406c;border-radius:10px;background:#0d0915;color:#fff;font:inherit}button{margin-top:20px;width:100%;border:0;border-radius:10px;padding:13px;background:#9a6cff;color:#fff;font:700 16px system-ui;cursor:pointer}button:disabled{opacity:.55}#estado{min-height:24px;margin:16px 0 0;color:#c9bedb;white-space:pre-wrap}.ok{color:#84e8bd}.err{color:#ff9b9b}.nota{font-size:13px}
</style>
<main><h1>Subir una captura PCAP</h1><p>Elige el archivo guardado por PCAPdroid. Se reemplaza la captura anterior cuando termine de subir.</p>
<label for="archivo">Archivo .pcap o .pcapng</label><input id="archivo" type="file" accept=".pcap,.pcapng,application/vnd.tcpdump.pcap,application/octet-stream">
<label for="clave">Clave de carga</label><input id="clave" type="password" autocomplete="off" placeholder="${TOKEN ? 'Escribe la clave' : 'No hace falta clave'}">
<p class="nota">¿Clave requerida? ${requiereClave}<br>Límite: ${bytes(MAX_BYTES)}</p><button id="subir" type="button">Subir captura</button><p id="estado"></p></main>
<script>
  const $=s=>document.querySelector(s), estado=$('#estado'), boton=$('#subir');
  const deUrl=new URLSearchParams(location.search).get('token'); if(deUrl) $('#clave').value=deUrl;
  boton.onclick=async()=>{
    const f=$('#archivo').files[0], clave=$('#clave').value;
    if(!f){estado.className='err';estado.textContent='Elige el archivo primero.';return}
    boton.disabled=true;estado.className='';estado.textContent='Subiendo '+f.name+'… no cierres esta página.';
    try{
      const u='/upload'+(clave?'?token='+encodeURIComponent(clave):'');
      const r=await fetch(u,{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok)throw new Error(d.error||'Error '+r.status);
      estado.className='ok';estado.textContent='Listo: '+(d.totalSize||f.size+' bytes')+'.';
    }catch(e){estado.className='err';estado.textContent='No se pudo subir: '+e.message}
    boton.disabled=false;
  };
</script></html>`;
}

function iniciarHttp() {
  servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-PCAP-Token',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      responder(res, 200, estado());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(paginaCarga());
      return;
    }
    if (!['/upload', '/'].includes(url.pathname) || (req.method !== 'POST' && req.method !== 'PUT')) {
      responder(res, 404, { ok: false, error: 'Usa GET / para subir un archivo o POST /upload' });
      return;
    }
    if (TOKEN && !tokenValido(tokenDe(req, url), TOKEN)) {
      responder(res, 401, { ok: false, error: 'Falta o no coincide la clave de carga' });
      return;
    }

    const largo = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(largo) && largo > MAX_BYTES) {
      responder(res, 413, { ok: false, error: `La carga supera el límite de ${bytes(MAX_BYTES)}` });
      return;
    }
    if (recibiendo) {
      responder(res, 429, { ok: false, error: 'Ya hay una carga en curso; intenta de nuevo al terminar' });
      return;
    }

    recibiendo = true;
    bytesEnCurso = 0;
    ultimoError = '';
    const temporal = archivoTemporal();
    const limite = limitar(MAX_BYTES);
    const pcap = validarPcap();
    guardarEstado({ temp: true });
    try {
      await pipeline(req, limite.stream, pcap, fs.createWriteStream(temporal, { flags: 'wx' }));
      const tam = limite.size();
      if (!tam) throw new Error('La carga llegó vacía');
      await reemplazarCon(temporal);
      bytesGuardados = tam;
      bytesEnCurso = 0;
      cargas++;
      log(`HTTP ${req.method} ${url.pathname} — ${bytes(tam)} guardados`);
      responder(res, 200, { ok: true, received: tam, receivedSize: bytes(tam), total: tam, totalSize: bytes(tam) });
    } catch (err) {
      bytesEnCurso = 0;
      ultimoError = (err && err.message) || 'No pude guardar la carga';
      const code = err && err.code === 'LIMIT' ? 413 : 400;
      log(`Carga HTTP rechazada: ${ultimoError}`);
      if (!res.headersSent && !res.writableEnded) responder(res, code, { ok: false, error: ultimoError });
      await fsp.unlink(temporal).catch(() => {});
    } finally {
      recibiendo = false;
      guardarEstado();
    }
  });

  servidor.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  if (MATAR_PUERTO) matarLoQueOcupaElPuerto(PORT);
  servidor.listen(PORT, '0.0.0.0', () => {
    log(`Recibidor HTTP escuchando en 0.0.0.0:${PORT}`);
    log(`Abre http://IP-DEL-SERVIDOR:${PORT}/ para subir un PCAP · clave: ${TOKEN ? 'activada' : 'NO configurada'}`);
    guardarEstado();
  });
}

function iniciarTcp() {
  let activo = null;

  servidor = net.createServer((socket) => {
    const remoto = `${socket.remoteAddress || '?'}:${socket.remotePort || '?'}`;
    if (PERMITIDAS.length && !PERMITIDAS.includes(normalizarIp(socket.remoteAddress))) {
      socket.destroy(); /* ni se registra: no hay que llenar el log con bots */
      return;
    }
    if (activo) {
      log(`TCP rechazado de ${remoto}: ya hay una captura en curso`);
      socket.destroy();
      return;
    }

    let salida = null;
    let temporal = '';
    let tam = 0;
    let terminando = false;
    let cerrado = false;
    let proximoAviso = 5 * 1024 * 1024;
    let ultimoEstadoEn = 0;

    const terminarConError = (motivo) => {
      if (cerrado) return;
      cerrado = true;
      ultimoError = motivo;
      recibiendo = false;
      bytesEnCurso = 0;
      activo = null;
      if (salida) salida.destroy();
      if (!socket.destroyed) socket.destroy();
      if (temporal) fsp.unlink(temporal).catch(() => {});
      guardarEstado();
      log(`TCP cancelado (${remoto}): ${motivo}`);
    };

    const finalizar = () => {
      if (cerrado || terminando || !salida) return;
      terminando = true;
      salida.end();
    };

    const escribir = (chunk) => {
      if (cerrado || !salida) return;
      if (tam + chunk.length > MAX_BYTES) {
        terminarConError(`La captura supera el límite de ${bytes(MAX_BYTES)}`);
        return;
      }
      tam += chunk.length;
      bytesEnCurso = tam;
      /* La prueba corta también debe mostrar bytes: actualiza el archivo de
       * estado al primer dato y luego como máximo una vez por 750 ms. */
      const ahora = Date.now();
      if (ahora - ultimoEstadoEn >= 750) {
        ultimoEstadoEn = ahora;
        guardarEstado({ peer: remoto, temp: true });
      }
      if (tam >= proximoAviso) {
        log(`TCP recibiendo de ${remoto}: ${bytes(tam)}`);
        proximoAviso += 5 * 1024 * 1024;
      }
      if (!salida.write(chunk)) {
        socket.pause();
        salida.once('drain', () => { if (!cerrado) socket.resume(); });
      }
    };

    let esperandoCabecera = true;
    socket.setNoDelay(true);
    /* Un escáner público no puede reservar el receptor 15 min mandando solo
     * un byte; PCAPdroid manda la cabecera de inmediato al conectarse. */
    socket.setTimeout(Math.min(IDLE_MS, 15_000));
    socket.once('timeout', () => terminarConError(esperandoCabecera
      ? 'No llegó una cabecera PCAP en 15 segundos'
      : `Sin datos durante ${Math.round(IDLE_MS / 1000)} segundos`));
    socket.once('error', (err) => terminarConError(`Conexión TCP: ${err.message}`));
    socket.once('close', () => {
      /* Un cierre limpio siempre viene después de «end», que ya marcó
       * terminando. Si llega antes, no dejes ocupado el recibidor. */
      if (!cerrado && !terminando) terminarConError('La conexión TCP se cerró antes de terminar');
    });

    /* TCP puede partir los primeros cuatro bytes en paquetes separados.
     * Acumulamos solo esa cabecera antes de decidir si es PCAP válido. */
    let inicio = Buffer.alloc(0);
    /* IMPORTANTE: `activo` se asigna SOLO después de validar la cabecera PCAP.
     * Antes se asignaba aquí, y con el puerto expuesto a internet decenas de bots por
     * segundo lo mantenían ocupado permanentemente: cualquier conexión legítima caía en
     * «ya hay una captura en curso». Fue exactamente el bloqueo del 19-sep.
     * Las conexiones que todavía están leyendo sus primeros 4 bytes se cuentan aparte
     * (`leyendoCabecera`) y no bloquean a nadie. */
    const recibirInicio = (chunk) => {
      inicio = inicio.length ? Buffer.concat([inicio, chunk]) : chunk;
      if (inicio.length < 4) return;
      socket.removeListener('data', recibirInicio);
      if (!esPcap(inicio)) {
        cerrado = true;
        log(`TCP rechazado de ${remoto}: no empieza como PCAP/PCAPNG`);
        socket.destroy();
        return;
      }
      activo = socket;

      esperandoCabecera = false;
      socket.setTimeout(IDLE_MS);
      temporal = archivoTemporal();
      salida = fs.createWriteStream(temporal, { flags: 'wx' });
      recibiendo = true;
      bytesEnCurso = 0;
      ultimoError = '';
      guardarEstado({ peer: remoto, temp: true });
      log(`TCP conectado desde ${remoto}; guardando captura…`);

      salida.once('error', (err) => terminarConError(`Disco: ${err.message}`));
      salida.once('finish', async () => {
        if (cerrado) return;
        try {
          await reemplazarCon(temporal);
          bytesGuardados = tam;
          bytesEnCurso = 0;
          cargas++;
          recibiendo = false;
          activo = null;
          cerrado = true;
          guardarEstado({ completedAt: new Date().toISOString() });
          log(`TCP terminado: ${bytes(tam)} guardados en ${ARCHIVO}`);
        } catch (err) {
          terminarConError(`No pude publicar la captura: ${err.message}`);
        }
      });

      escribir(inicio);
      socket.on('data', escribir);
      socket.once('end', finalizar);
    };
    socket.on('data', recibirInicio);
    socket.once('end', () => {
      if (!salida) {
        activo = null;
        cerrado = true;
        log(`TCP rechazado de ${remoto}: cerró antes de enviar una cabecera PCAP`);
        return;
      }
      finalizar();
    });
  });

  servidor.on('error', (err) => {
    console.error(`Error del recibidor TCP: ${err.message}`);
    process.exitCode = 1;
  });
  if (MATAR_PUERTO) matarLoQueOcupaElPuerto(PORT);
  servidor.listen(PORT, '0.0.0.0', () => {
    log(`Recibidor TCP (pcap-over-IP) escuchando en 0.0.0.0:${PORT}`);
    log(`En PCAPdroid usa "TCP Exporter", IP del servidor y puerto ${PORT}.`);
    log(`Límite: ${bytes(MAX_BYTES)} · inactividad: ${Math.round(IDLE_MS / 1000)} s · no hay clave en TCP.`);
    guardarEstado();
  });
}

function cerrar(signal) {
  log(`${signal}: cerrando recibidor PCAP…`);
  if (servidor) servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => cerrar('SIGINT'));
process.on('SIGTERM', () => cerrar('SIGTERM'));

if (MODE === 'tcp') iniciarTcp();
else iniciarHttp();
