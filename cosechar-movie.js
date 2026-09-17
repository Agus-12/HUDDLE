#!/usr/bin/env node
'use strict';

/*
 * Huddle — reporte de rutas Movie cosechadas desde un PCAP.
 *
 * Lee rutas como:
 *   /vod/1/2026/09/16/3ef6df82f48f/index5.m3u8
 *
 * Las consulta UNA vez contra el origen configurado, valida que sean playlists
 * HLS y guarda un reporte pequeño con estado HTTP, duración y segmentos.
 * No descarga segmentos de vídeo ni guarda tokens.
 *
 * Uso normal en Oracle:
 *   node cosechar-movie.js ~/movie-m3u8.txt
 *
 * Salidas junto al archivo de entrada:
 *   ~/movie-cosecha.json
 *   ~/movie-cosecha.txt
 *
 * Opcionales:
 *   MOVIE_CDN_ORIGIN=http://127.0.0.1:18080 node cosechar-movie.js rutas.txt
 *   MOVIE_CONCURRENCY=3 MOVIE_TIMEOUT_MS=20000 node cosechar-movie.js rutas.txt
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');

const ORIGIN_RAW = process.env.MOVIE_CDN_ORIGIN || 'http://147.124.216.142';
const TIMEOUT_MS = numeroSeguro(process.env.MOVIE_TIMEOUT_MS, 20_000, 1_000, 120_000);
const CONCURRENCIA = numeroSeguro(process.env.MOVIE_CONCURRENCY, 4, 1, 12);
const MAX_PLAYLIST_BYTES = numeroSeguro(process.env.MOVIE_MAX_PLAYLIST_BYTES, 2 * 1024 * 1024, 16 * 1024, 16 * 1024 * 1024);
const RUTA_RE = /^\/vod\/1\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{12})\/index5\.m3u8$/i;

function numeroSeguro(raw, porDefecto, min, max) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : porDefecto;
}

function salir(mensaje) {
  console.error(`Error: ${mensaje}`);
  console.error('Uso: node cosechar-movie.js /ruta/a/movie-m3u8.txt');
  process.exit(1);
}

let ORIGIN;
try {
  ORIGIN = new URL(ORIGIN_RAW);
  if (!['http:', 'https:'].includes(ORIGIN.protocol)) throw new Error('protocolo no permitido');
} catch {
  salir('MOVIE_CDN_ORIGIN no es una URL http(s) válida');
}

const entrada = process.argv[2];
if (!entrada || entrada === '--help' || entrada === '-h') {
  console.log('Uso: node cosechar-movie.js ~/movie-m3u8.txt');
  process.exit(entrada ? 0 : 1);
}
const archivoEntrada = path.resolve(entrada);
const carpetaSalida = path.dirname(archivoEntrada);
const archivoJson = path.join(carpetaSalida, 'movie-cosecha.json');
const archivoTexto = path.join(carpetaSalida, 'movie-cosecha.txt');

function rutaNormalizada(linea) {
  let valor = String(linea || '').trim();
  if (!valor || valor.startsWith('#')) return '';
  try {
    if (/^https?:\/\//i.test(valor)) valor = new URL(valor).pathname;
  } catch {
    return '';
  }
  valor = valor.split('?')[0].replace(/\/+$/, '');
  return RUTA_RE.test(valor) ? valor : '';
}

function datosDeRuta(ruta) {
  const m = RUTA_RE.exec(ruta);
  return {
    ruta,
    fecha: m ? `${m[1]}-${m[2]}-${m[3]}` : '',
    carpeta: m ? m[4].toLowerCase() : '',
  };
}

function formatoBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatoDuracion(segundos) {
  if (!Number.isFinite(segundos) || segundos < 0) return '';
  const totalMs = Math.round(segundos * 1000);
  const horas = Math.floor(totalMs / 3_600_000);
  const minutos = Math.floor((totalMs % 3_600_000) / 60_000);
  const seg = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const base = `${String(minutos).padStart(2, '0')}:${String(seg).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  return horas ? `${horas}:${base}` : base;
}

function analizarPlaylist(texto) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n').map((x) => x.trim());
  const esHls = lineas.some((x) => x === '#EXTM3U');
  let pendiente = null;
  let segmentos = 0;
  let duracion = 0;
  let discontinuidades = 0;
  let primero = '';
  let ultimo = '';

  for (const linea of lineas) {
    if (!linea) continue;
    if (linea === '#EXT-X-DISCONTINUITY') discontinuidades++;
    const extinf = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)/i.exec(linea);
    if (extinf) {
      pendiente = Number(extinf[1]);
      continue;
    }
    if (!linea.startsWith('#') && pendiente !== null) {
      segmentos++;
      duracion += pendiente;
      if (!primero) primero = linea;
      ultimo = linea;
      pendiente = null;
    }
  }

  return {
    esHls,
    segmentos,
    duracionSegundos: Number(duracion.toFixed(3)),
    duracion: formatoDuracion(duracion),
    discontinuidades,
    primerSegmento: primero,
    ultimoSegmento: ultimo,
  };
}

function pedirPlaylist(ruta) {
  const destino = new URL(ruta, ORIGIN);
  const cliente = destino.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let terminado = false;
    const fin = (fn, valor) => {
      if (terminado) return;
      terminado = true;
      fn(valor);
    };

    const req = cliente.get(destino, {
      headers: {
        'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
        'User-Agent': 'Huddle-cosecha/1.0',
        'Connection': 'close',
      },
    }, (res) => {
      const status = Number(res.statusCode || 0);
      const tipo = String(res.headers['content-type'] || '');
      const declarado = Number(res.headers['content-length'] || 0);
      if (Number.isFinite(declarado) && declarado > MAX_PLAYLIST_BYTES) {
        res.resume();
        fin(reject, new Error(`Playlist demasiado grande (${formatoBytes(declarado)})`));
        return;
      }
      if (status !== 200) {
        res.resume();
        fin(resolve, { status, tipo, bytes: 0, texto: '' });
        return;
      }

      const trozos = [];
      let bytes = 0;
      res.on('data', (trozo) => {
        bytes += trozo.length;
        if (bytes > MAX_PLAYLIST_BYTES) {
          req.destroy(new Error(`Playlist supera ${formatoBytes(MAX_PLAYLIST_BYTES)}`));
          return;
        }
        trozos.push(trozo);
      });
      res.once('error', (err) => fin(reject, err));
      res.once('end', () => fin(resolve, {
        status,
        tipo,
        bytes,
        texto: Buffer.concat(trozos).toString('utf8'),
      }));
    });

    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Tiempo agotado (${TIMEOUT_MS} ms)`)));
    req.once('error', (err) => fin(reject, err));
  });
}

async function revisarRuta(ruta) {
  const inicio = Date.now();
  const base = datosDeRuta(ruta);
  try {
    const respuesta = await pedirPlaylist(ruta);
    const ms = Date.now() - inicio;
    if (respuesta.status !== 200) {
      return { ...base, ok: false, httpStatus: respuesta.status, error: `HTTP ${respuesta.status}`, ms, tipo: respuesta.tipo };
    }
    const playlist = analizarPlaylist(respuesta.texto);
    if (!playlist.esHls || !playlist.segmentos) {
      return {
        ...base,
        ok: false,
        httpStatus: respuesta.status,
        error: !playlist.esHls ? 'La respuesta no parece M3U8' : 'M3U8 sin segmentos EXTINF',
        ms,
        tipo: respuesta.tipo,
        playlistBytes: respuesta.bytes,
        ...playlist,
      };
    }
    return {
      ...base,
      ok: true,
      httpStatus: respuesta.status,
      ms,
      tipo: respuesta.tipo,
      playlistBytes: respuesta.bytes,
      ...playlist,
    };
  } catch (err) {
    return { ...base, ok: false, httpStatus: 0, error: String(err.message || err), ms: Date.now() - inicio };
  }
}

async function mapaEnParalelo(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  let hechos = 0;
  async function trabajador() {
    while (true) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await fn(items[i]);
      hechos++;
      const r = resultados[i];
      process.stderr.write(`[${hechos}/${items.length}] ${r.ok ? 'OK ' : 'ERR'} ${r.ruta}${r.ok ? ` · ${r.duracion}` : ` · ${r.error}`}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador));
  return resultados;
}

function reporteTexto(reporte) {
  const lineas = [
    '# estado\thttp\tduracion\tsegmentos\tfecha\tcarpeta\truta\terror',
  ];
  for (const r of reporte.resultados) {
    lineas.push([
      r.ok ? 'OK' : 'ERROR',
      r.httpStatus || '',
      r.duracion || '',
      r.segmentos || '',
      r.fecha || '',
      r.carpeta || '',
      r.ruta || '',
      (r.error || '').replace(/[\t\r\n]+/g, ' '),
    ].join('\t'));
  }
  return `${lineas.join('\n')}\n`;
}

(async () => {
  let texto;
  try {
    texto = await fsp.readFile(archivoEntrada, 'utf8');
  } catch (err) {
    salir(`no pude leer ${archivoEntrada}: ${err.message}`);
  }

  const lineas = texto.split(/\r?\n/);
  const invalidas = [];
  const rutas = [];
  const vistas = new Set();
  for (const linea of lineas) {
    const ruta = rutaNormalizada(linea);
    if (!ruta) {
      if (String(linea).trim() && !String(linea).trim().startsWith('#')) invalidas.push(String(linea).trim().slice(0, 240));
      continue;
    }
    if (!vistas.has(ruta)) {
      vistas.add(ruta);
      rutas.push(ruta);
    }
  }
  if (!rutas.length) salir('no encontré rutas /vod/1/.../index5.m3u8 válidas');

  console.log(`Revisando ${rutas.length} ruta(s) contra ${ORIGIN.origin}…`);
  const resultados = await mapaEnParalelo(rutas, CONCURRENCIA, revisarRuta);
  const ok = resultados.filter((r) => r.ok);
  const errores = resultados.filter((r) => !r.ok);
  const reporte = {
    generadoEn: new Date().toISOString(),
    origen: ORIGIN.origin,
    archivoEntrada,
    lineasLeidas: lineas.length,
    rutasUnicas: rutas.length,
    configuracion: { concurrencia: CONCURRENCIA, timeoutMs: TIMEOUT_MS, maxPlaylistBytes: MAX_PLAYLIST_BYTES },
    resumen: {
      correctas: ok.length,
      conError: errores.length,
      duracionTotalSegundos: Number(ok.reduce((n, r) => n + (r.duracionSegundos || 0), 0).toFixed(3)),
      duracionTotal: formatoDuracion(ok.reduce((n, r) => n + (r.duracionSegundos || 0), 0)),
    },
    lineasInvalidas: invalidas,
    resultados,
  };

  await fsp.writeFile(archivoJson, `${JSON.stringify(reporte, null, 2)}\n`);
  await fsp.writeFile(archivoTexto, reporteTexto(reporte));
  console.log(`\nListo: ${ok.length} correctas, ${errores.length} con error.`);
  console.log(`Duración total: ${reporte.resumen.duracionTotal || '0:00.000'}`);
  console.log(`Reporte: ${archivoJson}`);
  console.log(`Resumen: ${archivoTexto}`);
  if (errores.length) console.log('El reporte conserva los errores para revisar solo esas rutas después.');
})().catch((err) => {
  console.error(`Error inesperado: ${err.stack || err.message || err}`);
  process.exit(1);
});
