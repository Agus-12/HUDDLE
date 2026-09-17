#!/usr/bin/env node
'use strict';

/*
 * Huddle — recupera manifests HLS YA capturados en un PCAP clásico.
 *
 * A diferencia de cosechar-movie.js, no vuelve a consultar el CDN: reconstruye
 * respuestas HTTP de los flujos TCP existentes en la captura y suma EXTINF.
 * Esto permite revisar rutas que hoy dan 403 sin afirmar que sigan disponibles.
 * No guarda bodies, queries, tokens, device IDs ni segmentos TS.
 *
 * Uso:
 *   node cosechar-pcap-movie.js ~/captura-movie.pcap [~/movie-cosecha.json]
 *
 * Salidas junto al PCAP:
 *   ~/movie-cosecha-pcap.json
 *   ~/movie-cosecha-pcap.txt
 *
 * Soporta el formato PCAP clásico que produjo la captura #1. Link types
 * habituales: RAW/IP de PCAPdroid, Ethernet/VLAN y Linux cooked.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const TAM_BLOQUE = 4 * 1024 * 1024;
const MAX_PAQUETE = 32 * 1024 * 1024;
const MAX_CABECERA_HTTP = 128 * 1024;
const MAX_MANIFEST = 512 * 1024;
const GET = Buffer.from('GET ', 'ascii');
const HTTP = Buffer.from('HTTP/1.', 'ascii');
const PREFIJO_VOD = Buffer.from('/vod/1/', 'ascii');

function salir(mensaje, codigo = 1) {
  console.error(`Error: ${mensaje}`);
  console.error('Uso: node cosechar-pcap-movie.js ~/captura-movie.pcap [~/movie-cosecha.json]');
  process.exit(codigo);
}

const argv = process.argv.slice(2);
if (!argv[0] || argv[0] === '--help' || argv[0] === '-h') {
  if (argv[0]) {
    console.log('Uso: node cosechar-pcap-movie.js ~/captura-movie.pcap [~/movie-cosecha.json]');
    console.log('Reconstruye manifests desde respuestas HTTP ya contenidas en el PCAP.');
  } else {
    salir('falta el PCAP');
  }
  process.exit(argv[0] ? 0 : 1);
}

const PCAP = path.resolve(argv[0]);
const COSECHA_ACTUAL = argv[1] ? path.resolve(argv[1]) : path.join(path.dirname(PCAP), 'movie-cosecha.json');
const SALIDA_DIR = path.dirname(PCAP);
const SALIDA_JSON = path.join(SALIDA_DIR, 'movie-cosecha-pcap.json');
const SALIDA_TEXTO = path.join(SALIDA_DIR, 'movie-cosecha-pcap.txt');
if (!fs.existsSync(PCAP)) salir(`no existe el PCAP: ${PCAP}`);

class LectorBinario {
  constructor(archivo) {
    this.fd = fs.openSync(archivo, 'r');
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.terminado = false;
  }
  cerrar() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
  asegurar(n) {
    const disponibles = this.buffer.length - this.offset;
    if (disponibles >= n) return true;
    if (this.terminado) return false;
    const conservar = this.buffer.subarray(this.offset);
    const capacidad = Math.max(TAM_BLOQUE, conservar.length + n);
    const nuevo = Buffer.allocUnsafe(capacidad);
    conservar.copy(nuevo);
    let escritos = conservar.length;
    while (escritos < n || escritos < TAM_BLOQUE) {
      const leidos = fs.readSync(this.fd, nuevo, escritos, nuevo.length - escritos, null);
      if (!leidos) { this.terminado = true; break; }
      escritos += leidos;
      if (escritos === nuevo.length) break;
    }
    this.buffer = nuevo.subarray(0, escritos);
    this.offset = 0;
    return this.buffer.length >= n;
  }
  tomar(n) {
    if (!this.asegurar(n)) return null;
    const dato = this.buffer.subarray(this.offset, this.offset + n);
    this.offset += n;
    return dato;
  }
}

function u16be(b, o) { return b.readUInt16BE(o); }
function u32be(b, o) { return b.readUInt32BE(o); }
function u32(b, o, little) { return little ? b.readUInt32LE(o) : b.readUInt32BE(o); }
function fechaUtc(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; }
function sinQuery(valor) {
  const limpio = String(valor || '').split('?')[0].split('#')[0];
  try { if (/^https?:\/\//i.test(limpio)) return new URL(limpio).pathname || '/'; } catch { /* ruta saneada */ }
  return limpio;
}
function carpetaDeRuta(ruta) {
  const m = String(ruta).match(/\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/([0-9a-f]{12})\/index5\.m3u8$/i);
  return m ? m[1].toLowerCase() : '';
}
function esManifestMovie(ruta) {
  return /^\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{12}\/index5\.m3u8$/i.test(ruta);
}
function cargarJson(archivo, defecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}

function mapaCosechaActual() {
  const datos = cargarJson(COSECHA_ACTUAL, null);
  const mapa = new Map();
  for (const r of datos && Array.isArray(datos.resultados) ? datos.resultados : []) {
    if (!r || !r.ruta) continue;
    mapa.set(sinQuery(r.ruta), {
      ok: Boolean(r.ok), estado: Number(r.estado || 0), duracion: String(r.duracion || ''),
      segmentos: Number(r.segmentos || 0), error: r.ok ? '' : String(r.error || ''),
    });
  }
  return { encontrado: Boolean(datos), mapa };
}

function ip4(b, o) { return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`; }
function ip6(b, o) {
  const grupos = [];
  for (let i = 0; i < 16; i += 2) grupos.push(b.readUInt16BE(o + i).toString(16));
  return grupos.join(':');
}

function inicioIp(trama, linkType) {
  const tipo = linkType & 0x0fffffff;
  if (tipo === 101 || tipo === 228 || tipo === 229) return 0; // RAW, IPv4, IPv6
  if (tipo === 0 || tipo === 108) return 4; // NULL / LOOP
  if (tipo === 113) return 16; // Linux cooked v1
  if (tipo === 276) return 20; // Linux cooked v2
  if (tipo === 1) { // Ethernet, con VLAN opcional
    if (trama.length < 14) return -1;
    let o = 14;
    let eth = u16be(trama, 12);
    while ((eth === 0x8100 || eth === 0x88a8 || eth === 0x9100) && o + 4 <= trama.length) {
      eth = u16be(trama, o + 2);
      o += 4;
    }
    return eth === 0x0800 || eth === 0x86dd ? o : -1;
  }
  /* Fallback prudente para un link type desconocido: solo acepta un header IP
   * perfectamente formado dentro de los primeros 64 bytes. */
  for (let o = 0; o < Math.min(64, trama.length - 40); o++) {
    const v = trama[o] >> 4;
    if (v === 4 && (trama[o] & 15) >= 5 && trama[o + 9] === 6) return o;
    if (v === 6 && trama[o + 6] === 6) return o;
  }
  return -1;
}

function tcpDeTrama(trama, linkType) {
  const o = inicioIp(trama, linkType);
  if (o < 0 || o >= trama.length) return null;
  const version = trama[o] >> 4;
  let tcp; let finIp; let origen; let destino;
  if (version === 4) {
    const ihl = (trama[o] & 15) * 4;
    if (ihl < 20 || o + ihl + 20 > trama.length || trama[o + 9] !== 6) return null;
    const total = u16be(trama, o + 2);
    if (total < ihl + 20) return null;
    tcp = o + ihl;
    finIp = Math.min(trama.length, o + total);
    origen = ip4(trama, o + 12); destino = ip4(trama, o + 16);
  } else if (version === 6) {
    if (o + 40 + 20 > trama.length || trama[o + 6] !== 6) return null; // sin extensiones
    tcp = o + 40;
    finIp = Math.min(trama.length, o + 40 + u16be(trama, o + 4));
    origen = ip6(trama, o + 8); destino = ip6(trama, o + 24);
  } else return null;
  const dataOffset = (trama[tcp + 12] >> 4) * 4;
  if (dataOffset < 20 || tcp + dataOffset > finIp) return null;
  return {
    origen, destino,
    puertoOrigen: u16be(trama, tcp), puertoDestino: u16be(trama, tcp + 2),
    seq: u32be(trama, tcp + 4),
    datos: trama.subarray(tcp + dataOffset, finIp),
  };
}

function extremo(ip, puerto) { return `${ip}:${puerto}`; }
function claveFlujo(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function extraerRutaManifest(datos) {
  let desde = 0;
  while (desde < datos.length) {
    const p = datos.indexOf(PREFIJO_VOD, desde);
    if (p < 0) return '';
    const ventana = datos.subarray(p, Math.min(datos.length, p + 160)).toString('latin1');
    const m = ventana.match(/^(\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{12}\/index5\.m3u8)(?:[?\s\r\n]|$)/i);
    if (m) return sinQuery(m[1]);
    desde = p + PREFIJO_VOD.length;
  }
  return '';
}

function leerPcap(archivo, porPaquete) {
  const lector = new LectorBinario(archivo);
  try {
    const global = lector.tomar(24);
    if (!global) throw new Error('cabecera PCAP incompleta');
    const magic = global.subarray(0, 4).toString('hex');
    const formatos = {
      d4c3b2a1: { little: true, nano: false }, a1b2c3d4: { little: false, nano: false },
      '4d3cb2a1': { little: true, nano: true }, a1b23c4d: { little: false, nano: true },
    };
    const formato = formatos[magic];
    if (!formato) throw new Error(`este recuperador necesita PCAP clásico; magic recibido: ${magic}`);
    const linkType = u32(global, 20, formato.little);
    let paquetes = 0; let truncados = 0;
    while (true) {
      const cab = lector.tomar(16);
      if (!cab) break;
      const sec = u32(cab, 0, formato.little);
      const frac = u32(cab, 4, formato.little);
      const largo = u32(cab, 8, formato.little);
      if (largo > MAX_PAQUETE) throw new Error(`paquete demasiado grande: ${largo}`);
      const datos = lector.tomar(largo);
      if (!datos) { truncados++; break; }
      paquetes++;
      const ms = sec * 1000 + (formato.nano ? frac / 1e6 : frac / 1000);
      porPaquete(datos, ms, linkType);
    }
    return { formato: formato.nano ? 'PCAP (nanosegundos)' : 'PCAP (microsegundos)', linkType: linkType & 0x0fffffff, paquetes, truncados };
  } finally { lector.cerrar(); }
}

/* Ordena bytes TCP sin guardar respuestas grandes. Capturas normales llegan en
 * orden; el pequeño mapa cubre reordenamiento/retransmisiones. */
class ReensambladorTcp {
  constructor(alRecibir) {
    this.alRecibir = alRecibir;
    this.base = null;
    this.siguiente = 0;
    this.pendientes = new Map();
  }
  relativo(seq) {
    return (seq - this.base + 0x1_0000_0000) % 0x1_0000_0000;
  }
  meter(seq, datos, ms) {
    if (!datos.length) return;
    if (this.base === null) this.base = seq;
    let rel = this.relativo(seq);
    let parte = datos;
    if (rel < this.siguiente) {
      const fin = rel + parte.length;
      if (fin <= this.siguiente) return; // retransmisión completa
      parte = parte.subarray(this.siguiente - rel);
      rel = this.siguiente;
    }
    if (rel === this.siguiente) {
      this.emitir(parte, ms);
      while (this.pendientes.has(this.siguiente)) {
        const x = this.pendientes.get(this.siguiente);
        this.pendientes.delete(this.siguiente);
        this.emitir(x.datos, x.ms);
      }
    } else if (!this.pendientes.has(rel) && this.pendientes.size < 1024) {
      this.pendientes.set(rel, { datos: Buffer.from(parte), ms });
    }
  }
  emitir(datos, ms) {
    this.siguiente += datos.length;
    this.alRecibir(datos, ms);
  }
}

function encabezadoCompleto(buffer) {
  const p = buffer.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
  return p < 0 ? -1 : p + 4;
}

class ParserSolicitudes {
  constructor(alSolicitud) { this.buffer = Buffer.alloc(0); this.alSolicitud = alSolicitud; }
  recibir(datos, ms) {
    this.buffer = Buffer.concat([this.buffer, datos]);
    while (this.buffer.length) {
      let inicio = this.buffer.indexOf(GET);
      if (inicio < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
        return;
      }
      if (inicio > 0) this.buffer = this.buffer.subarray(inicio);
      const fin = encabezadoCompleto(this.buffer);
      if (fin < 0) {
        if (this.buffer.length > MAX_CABECERA_HTTP) this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
        return;
      }
      const texto = this.buffer.subarray(0, fin).toString('latin1');
      this.buffer = this.buffer.subarray(fin);
      const primera = texto.match(/^GET\s+([^\s]+)\s+HTTP\/\d(?:\.\d)?/i);
      if (!primera) continue;
      const ruta = sinQuery(primera[1]);
      this.alSolicitud({ ruta, objetivo: esManifestMovie(ruta), tiempo: fechaUtc(ms) });
    }
  }
}

class ParserRespuestas {
  constructor(obtenerSolicitud, alRespuesta) {
    this.buffer = Buffer.alloc(0);
    this.actual = null;
    this.obtenerSolicitud = obtenerSolicitud;
    this.alRespuesta = alRespuesta;
  }
  recibir(datos, ms) {
    this.buffer = Buffer.concat([this.buffer, datos]);
    while (true) {
      if (!this.actual) {
        const inicio = this.buffer.indexOf(HTTP);
        if (inicio < 0) {
          this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 7));
          return;
        }
        if (inicio > 0) this.buffer = this.buffer.subarray(inicio);
        const fin = encabezadoCompleto(this.buffer);
        if (fin < 0) {
          if (this.buffer.length > MAX_CABECERA_HTTP) this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 7));
          return;
        }
        const texto = this.buffer.subarray(0, fin).toString('latin1');
        this.buffer = this.buffer.subarray(fin);
        const estado = Number((texto.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i) || [])[1] || 0);
        const largo = Number((texto.match(/\r?\ncontent-length:\s*(\d+)/i) || [])[1]);
        const solicitud = this.obtenerSolicitud();
        if (!Number.isFinite(largo) || largo < 0) {
          /* La fuente usa Content-Length para manifests. No adivinar el fin de
           * una respuesta chunked/indefinida evita asociar datos erróneos. */
          if (solicitud && solicitud.objetivo) this.alRespuesta({ solicitud, estado, error: 'respuesta sin Content-Length recuperable', cuerpo: Buffer.alloc(0), bytes: 0 });
          this.actual = { restante: 0, descartarHastaHttp: true };
          continue;
        }
        this.actual = { solicitud, estado, restante: largo, partes: [], bytes: 0 };
        if (largo === 0) { this.finalizar(); continue; }
      }
      if (this.actual.descartarHastaHttp) {
        const p = this.buffer.indexOf(HTTP);
        if (p < 0) { this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 7)); return; }
        this.buffer = this.buffer.subarray(p);
        this.actual = null;
        continue;
      }
      if (!this.buffer.length) return;
      const tomar = Math.min(this.actual.restante, this.buffer.length);
      const parte = this.buffer.subarray(0, tomar);
      this.buffer = this.buffer.subarray(tomar);
      if (this.actual.solicitud && this.actual.solicitud.objetivo && this.actual.bytes < MAX_MANIFEST) {
        const queda = MAX_MANIFEST - this.actual.bytes;
        this.actual.partes.push(Buffer.from(parte.subarray(0, queda)));
      }
      this.actual.bytes += tomar;
      this.actual.restante -= tomar;
      if (this.actual.restante === 0) this.finalizar();
    }
  }
  finalizar() {
    const x = this.actual;
    this.actual = null;
    if (x.solicitud && x.solicitud.objetivo) {
      this.alRespuesta({ solicitud: x.solicitud, estado: x.estado, cuerpo: Buffer.concat(x.partes), bytes: x.bytes, error: x.bytes > MAX_MANIFEST ? 'manifest excede límite local' : '' });
    }
  }
}

function analizarM3u8(cuerpo) {
  const texto = cuerpo.toString('utf8');
  if (!texto.startsWith('#EXTM3U')) return { ok: false, error: 'body capturado no parece M3U8' };
  const duraciones = [...texto.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm)].map((m) => Number(m[1]));
  if (!duraciones.length || duraciones.some((n) => !Number.isFinite(n))) return { ok: false, error: 'M3U8 sin EXTINF' };
  const duracionSegundos = Number(duraciones.reduce((a, b) => a + b, 0).toFixed(3));
  return { ok: true, duracionSegundos, duracion: formatoDuracion(duracionSegundos), segmentos: duraciones.length };
}
function formatoDuracion(segundos) {
  const msTotales = Math.round(segundos * 1000);
  const h = Math.floor(msTotales / 3600000);
  const m = Math.floor((msTotales % 3600000) / 60000);
  const s = Math.floor((msTotales % 60000) / 1000);
  const ms = msTotales % 1000;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function primeraPasada() {
  const flujos = new Map();
  const orden = [];
  const info = leerPcap(PCAP, (trama, ms, linkType) => {
    const tcp = tcpDeTrama(trama, linkType);
    if (!tcp || !tcp.datos.length) return;
    const ruta = extraerRutaManifest(tcp.datos);
    if (!ruta) return;
    const cliente = extremo(tcp.origen, tcp.puertoOrigen);
    const servidor = extremo(tcp.destino, tcp.puertoDestino);
    const clave = claveFlujo(cliente, servidor);
    let flujo = flujos.get(clave);
    if (!flujo) {
      flujo = { clave, cliente, servidor, rutas: new Set() };
      flujos.set(clave, flujo);
    }
    flujo.rutas.add(ruta);
    orden.push({ ruta, tiempo: fechaUtc(ms), flujo: clave });
  });
  return { ...info, flujos, orden };
}

function segundaPasada(flujos) {
  const estados = new Map();
  const respuestas = [];
  for (const flujo of flujos.values()) {
    const cola = [];
    estados.set(flujo.clave, {
      flujo, cola,
      solicitud: new ParserSolicitudes((x) => cola.push(x)),
      respuesta: null,
      reCliente: null,
      reServidor: null,
    });
  }
  for (const estado of estados.values()) {
    estado.respuesta = new ParserRespuestas(() => estado.cola.shift() || null, (x) => respuestas.push(x));
    estado.reCliente = new ReensambladorTcp((datos, ms) => estado.solicitud.recibir(datos, ms));
    estado.reServidor = new ReensambladorTcp((datos, ms) => estado.respuesta.recibir(datos, ms));
  }
  const info = leerPcap(PCAP, (trama, ms, linkType) => {
    const tcp = tcpDeTrama(trama, linkType);
    if (!tcp || !tcp.datos.length) return;
    const origen = extremo(tcp.origen, tcp.puertoOrigen);
    const destino = extremo(tcp.destino, tcp.puertoDestino);
    const estado = estados.get(claveFlujo(origen, destino));
    if (!estado) return;
    if (origen === estado.flujo.cliente && destino === estado.flujo.servidor) estado.reCliente.meter(tcp.seq, tcp.datos, ms);
    else if (origen === estado.flujo.servidor && destino === estado.flujo.cliente) estado.reServidor.meter(tcp.seq, tcp.datos, ms);
  });
  return { ...info, respuestas };
}

function textoReporte(reporte) {
  const lineas = [];
  lineas.push(`PCAP: ${reporte.pcap}`);
  lineas.push(`Formato: ${reporte.formato} · link type ${reporte.linkType}`);
  lineas.push(`RUTAS EN PETICIONES: ${reporte.resultados.length}`);
  lineas.push(`MANIFESTS RECUPERADOS: ${reporte.resumen.hlsValidosCapturados}`);
  lineas.push('');
  lineas.push('RESULTADOS DESDE LA CAPTURA (no son una prueba de disponibilidad actual):');
  for (const r of reporte.resultados) {
    const captura = r.okCapturado
      ? `HTTP capturado ${r.estadoCapturado} · ${r.duracion} · ${r.segmentos} segmentos`
      : `HTTP capturado ${r.estadoCapturado || '?'} · ${r.errorCaptura || 'sin body HLS recuperable'}`;
    const actual = r.actual
      ? (r.actual.ok ? ` · comprobación actual: HLS válido ${r.actual.duracion}` : ` · comprobación actual: HTTP ${r.actual.estado || '?'}`)
      : '';
    lineas.push(`${r.tiempoSolicitud || '(hora no disponible)'} · ${r.carpeta} · ${captura}${actual}`);
    lineas.push(`  ${r.ruta}`);
  }
  lineas.push('');
  lineas.push('NOTA: Se analizaron respuestas HTTP guardadas en el PCAP; no se descargó contenido ni se guardaron tokens/bodies.');
  return `${lineas.join('\n')}\n`;
}

(async () => {
  console.log('Primera pasada: localizando flujos HTTP con manifests Movie…');
  const primera = primeraPasada();
  if (!primera.orden.length) salir('no encontré solicitudes de manifest dentro del PCAP');
  console.log(`Encontré ${primera.orden.length} rutas en ${primera.flujos.size} flujo(s). Segunda pasada: reconstruyendo solo sus respuestas HTTP…`);
  const segunda = segundaPasada(primera.flujos);
  const porRuta = new Map();
  for (const x of segunda.respuestas) {
    const ruta = x.solicitud.ruta;
    if (!porRuta.has(ruta)) porRuta.set(ruta, x);
  }
  const actual = mapaCosechaActual();
  const resultados = primera.orden.map((peticion) => {
    const respuesta = porRuta.get(peticion.ruta);
    const hls = respuesta ? analizarM3u8(respuesta.cuerpo) : { ok: false, error: 'respuesta HTTP no recuperada del flujo' };
    return {
      ruta: peticion.ruta,
      carpeta: carpetaDeRuta(peticion.ruta),
      tiempoSolicitud: peticion.tiempo,
      estadoCapturado: respuesta ? respuesta.estado : 0,
      bytesBodyCapturados: respuesta ? respuesta.bytes : 0,
      okCapturado: Boolean(respuesta && respuesta.estado === 200 && hls.ok),
      duracionSegundos: hls.ok ? hls.duracionSegundos : 0,
      duracion: hls.ok ? hls.duracion : '',
      segmentos: hls.ok ? hls.segmentos : 0,
      errorCaptura: respuesta ? (respuesta.error || hls.error || '') : hls.error,
      actual: actual.mapa.get(peticion.ruta) || null,
    };
  });
  const reporte = {
    version: 1,
    generadoEn: new Date().toISOString(),
    pcap: PCAP,
    cosechaActual: actual.encontrado ? COSECHA_ACTUAL : '',
    formato: primera.formato,
    linkType: primera.linkType,
    advertencia: 'estadoCapturado describe lo que se recibió durante la captura; no implica que el origen siga disponible hoy',
    resultados,
    resumen: {
      paquetesPrimeraPasada: primera.paquetes,
      paquetesSegundaPasada: segunda.paquetes,
      paquetesTruncados: primera.truncados + segunda.truncados,
      flujosConManifest: primera.flujos.size,
      rutasSolicitadas: resultados.length,
      hlsValidosCapturados: resultados.filter((x) => x.okCapturado).length,
      respuestasNoRecuperadas: resultados.filter((x) => !x.okCapturado).length,
    },
  };
  await fsp.writeFile(SALIDA_JSON, `${JSON.stringify(reporte, null, 2)}\n`);
  await fsp.writeFile(SALIDA_TEXTO, textoReporte(reporte));
  console.log(`Listo. ${reporte.resumen.hlsValidosCapturados}/${resultados.length} manifests HLS recuperados desde la captura.`);
  console.log(`Reporte: ${SALIDA_TEXTO}`);
  console.log(`Datos: ${SALIDA_JSON}`);
})().catch((err) => salir(err.stack || err.message || String(err)));
