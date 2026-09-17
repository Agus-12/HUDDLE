#!/usr/bin/env node
'use strict';

/*
 * Huddle — saca el orden temporal de los GET HTTP de Movie ya presentes
 * en un PCAP. Sirve para desambiguar coincidencias por duración sin hacer
 * otra captura. No modifica el PCAP, no descarga video ni guarda headers,
 * bodies, tokens o cookies.
 *
 * Uso:
 *   node ordenar-pcap-movie.js ~/captura-movie.pcap ~/movie-cosecha.json
 *
 * El segundo argumento es opcional. Si se proporciona, marca cada ruta como
 * HLS válida o con el estado que ya obtuvo cosechar-movie.js.
 *
 * Salidas junto al PCAP:
 *   ~/movie-pcap-orden.json
 *   ~/movie-pcap-orden.txt
 *
 * Lee PCAP y PCAPNG directamente, en bloques pequeños. Buscar dentro de cada
 * paquete evita filtros BPF incompatibles con algunas variantes de PCAPdroid
 * y evita imprimir/guardar los cientos de MB de respuestas MPEG-TS.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PREFIJO_VOD = Buffer.from('/vod/1/', 'ascii');
const GET = Buffer.from('GET ', 'ascii');
const POST = Buffer.from('POST ', 'ascii');
const TAM_BLOQUE = 4 * 1024 * 1024;
const MAX_PAQUETE = 32 * 1024 * 1024;

function salir(mensaje, codigo = 1) {
  console.error(`Error: ${mensaje}`);
  console.error('Uso: node ordenar-pcap-movie.js ~/captura-movie.pcap [~/movie-cosecha.json]');
  process.exit(codigo);
}

const args = process.argv.slice(2);
if (!args[0] || args[0] === '--help' || args[0] === '-h') {
  if (args[0]) {
    console.log('Uso: node ordenar-pcap-movie.js ~/captura-movie.pcap [~/movie-cosecha.json]');
    console.log('Extrae el orden temporal de GET/POST HTTP de un PCAP ya capturado.');
  } else {
    salir('falta el PCAP');
  }
  process.exit(args[0] ? 0 : 1);
}

const PCAP = path.resolve(args[0]);
const COSECHA = args[1] ? path.resolve(args[1]) : null;
const SALIDA_DIR = path.dirname(PCAP);
const SALIDA_JSON = path.join(SALIDA_DIR, 'movie-pcap-orden.json');
const SALIDA_TEXTO = path.join(SALIDA_DIR, 'movie-pcap-orden.txt');

if (!fs.existsSync(PCAP)) salir(`no existe el PCAP: ${PCAP}`);
if (COSECHA && !fs.existsSync(COSECHA)) salir(`no existe el reporte de cosecha: ${COSECHA}`);

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
    if (n < 0) throw new Error('lectura binaria inválida');
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

function u16(b, o, le) { return le ? b.readUInt16LE(o) : b.readUInt16BE(o); }
function u32(b, o, le) { return le ? b.readUInt32LE(o) : b.readUInt32BE(o); }
function u64Numero(b, o, le) {
  const alto = u32(b, o + (le ? 4 : 0), le);
  const bajo = u32(b, o + (le ? 0 : 4), le);
  return alto * 0x1_0000_0000 + bajo;
}

function cargarJson(archivo, defecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}

function mapaCosecha() {
  const datos = COSECHA ? cargarJson(COSECHA, null) : null;
  const mapa = new Map();
  for (const r of datos && Array.isArray(datos.resultados) ? datos.resultados : []) {
    if (!r || !r.ruta) continue;
    mapa.set(sinQuery(r.ruta), {
      ok: Boolean(r.ok),
      estado: Number(r.estado || 0),
      duracion: String(r.duracion || ''),
      duracionSegundos: Number(r.duracionSegundos || 0),
      segmentos: Number(r.segmentos || 0),
      error: r.ok ? '' : String(r.error || ''),
    });
  }
  return mapa;
}

/* El identificador deja su caché junto a la cosecha. Aquí solo se toman
 * appId/título/webId: jamás device_id, sign, URL de reproducción o tokens. */
function mapaCachePorAppId() {
  const archivo = path.join(COSECHA ? path.dirname(COSECHA) : SALIDA_DIR, 'movie-episodios-cache.json');
  const cache = cargarJson(archivo, null);
  const mapa = new Map();
  for (const serie of cache && cache.series && typeof cache.series === 'object' ? Object.values(cache.series) : []) {
    const appId = Number(serie && serie.appId);
    if (!Number.isFinite(appId) || appId <= 0 || mapa.has(appId)) continue;
    mapa.set(appId, {
      appId,
      webId: Number(serie.webId || 0),
      titulo: String(serie.titulo || ''),
    });
  }
  return { archivo, mapa };
}

function sinQuery(valor) {
  const limpio = String(valor || '').split('?')[0].split('#')[0];
  try {
    if (/^https?:\/\//i.test(limpio)) return new URL(limpio).pathname || '/';
  } catch { /* conservar la ruta original saneada */ }
  return limpio;
}

function carpetaDeRuta(ruta) {
  const m = String(ruta).match(/\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/([0-9a-f]{12})\/index5\.m3u8$/i);
  return m ? m[1].toLowerCase() : '';
}

function fechaUtc(milisegundos) {
  if (!Number.isFinite(milisegundos) || milisegundos < 0) return '';
  return new Date(milisegundos).toISOString();
}

function extraerSolicitudHttp(datos) {
  const posGet = datos.indexOf(GET);
  const posPost = datos.indexOf(POST);
  let inicio = -1;
  if (posGet >= 0 && (posPost < 0 || posGet <= posPost)) inicio = posGet;
  else if (posPost >= 0) inicio = posPost;
  if (inicio < 0) return null;

  /* Los requests HTTP son pequeños; solo se decodifica desde la palabra GET
   * o POST y hasta 16 KiB, nunca los datos binarios de video. */
  const texto = datos.subarray(inicio, Math.min(datos.length, inicio + 16 * 1024)).toString('latin1');
  const primera = texto.match(/^(GET|POST)\s+([^\s]+)\s+HTTP\/\d(?:\.\d)?/i);
  if (!primera) return null;
  const host = (texto.match(/\r?\nHost:\s*([^\s\r\n]+)/i) || [])[1] || '';
  const referer = (texto.match(/\r?\nReferer:\s*([^\s\r\n]+)/i) || [])[1] || '';
  return {
    metodo: primera[1].toUpperCase(),
    ruta: sinQuery(primera[2]),
    host: host.trim(),
    referer: sinQuery(referer.trim()),
  };
}

/* El proxy local del app pide /control?msg=verify antes de info_new. El
 * parámetro device_id pega 16 caracteres de dispositivo + el vod_id decimal.
 * Extraemos únicamente ese vod_id; el identificador del teléfono se descarta. */
function extraerControlVerify(datos) {
  const posGet = datos.indexOf(GET);
  const posPost = datos.indexOf(POST);
  let inicio = -1;
  if (posGet >= 0 && (posPost < 0 || posGet <= posPost)) inicio = posGet;
  else if (posPost >= 0) inicio = posPost;
  if (inicio < 0) return null;
  const texto = datos.subarray(inicio, Math.min(datos.length, inicio + 16 * 1024)).toString('latin1');
  const primera = texto.match(/^(?:GET|POST)\s+([^\s]+)\s+HTTP\/\d(?:\.\d)?/i);
  if (!primera) return null;
  let url;
  try { url = new URL(primera[1], 'http://proxy.local'); } catch { return null; }
  if (url.pathname !== '/control' || url.searchParams.get('msg') !== 'verify') return null;
  const compuesto = String(url.searchParams.get('device_id') || '');
  const directo = String(url.searchParams.get('vod_id') || '');
  /* No guardar device_id: solo aceptar el sufijo decimal tras sus 16 chars. */
  const sufijo = compuesto.match(/^[a-f0-9]{16}(\d+)$/i);
  const bruto = directo || (sufijo ? sufijo[1] : '');
  const appId = Number(bruto);
  return Number.isFinite(appId) && appId > 0 ? { appId } : null;
}

function rutasM3u8EnPaquete(datos) {
  const rutas = [];
  let desde = 0;
  while (desde < datos.length) {
    const p = datos.indexOf(PREFIJO_VOD, desde);
    if (p < 0) break;
    /* El nombre completo cabe ampliamente en 120 bytes. Se exige el formato
     * exacto para no confundir bytes de video con una URL accidental. */
    const ventana = datos.subarray(p, Math.min(datos.length, p + 140)).toString('latin1');
    const m = ventana.match(/^(\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{12}\/index5\.m3u8)(?:[?\s\r\n]|$)/i);
    if (m) rutas.push(sinQuery(m[1]));
    desde = p + PREFIJO_VOD.length;
  }
  return [...new Set(rutas)];
}

function esContextoUtil(solicitud) {
  return /\/(?:img\/vod_pic|api\/(?:vod|search|topic|user_history)|vod\/)/i.test(solicitud.ruta);
}

function anotarPaquete(estado, datos, milisegundos) {
  estado.paquetesLeidos++;
  const tiempo = fechaUtc(milisegundos);
  const rutas = rutasM3u8EnPaquete(datos);
  const solicitud = extraerSolicitudHttp(datos);
  const control = extraerControlVerify(datos);

  if (control) estado.controles.push({ tiempo, ...control });
  for (const ruta of rutas) {
    /* Una URL de manifest siempre vive en la solicitud. Se permite no haber
     * visto GET si PCAPdroid partió "GET " entre dos paquetes: el patrón de
     * ruta exacta sigue siendo evidencia más fuerte que el filtro anterior. */
    estado.manifests.push({
      tiempo,
      ruta,
      host: solicitud && solicitud.ruta === ruta ? solicitud.host : '',
      referer: solicitud && solicitud.ruta === ruta ? solicitud.referer : '',
    });
  }
  if (solicitud && !rutas.length && esContextoUtil(solicitud)) {
    estado.contextosHttp.push({ tiempo, ...solicitud });
  }
}

function escanearPcap(lector, primeros4, estado) {
  const resto = lector.tomar(20);
  if (!resto) throw new Error('cabecera PCAP incompleta');
  const global = Buffer.concat([primeros4, resto]);
  const magic = global.subarray(0, 4).toString('hex');
  const formatos = {
    d4c3b2a1: { le: true, nano: false },
    a1b2c3d4: { le: false, nano: false },
    '4d3cb2a1': { le: true, nano: true },
    a1b23c4d: { le: false, nano: true },
  };
  const formato = formatos[magic];
  if (!formato) throw new Error(`magic PCAP desconocido: ${magic}`);
  estado.formato = formato.nano ? 'PCAP (nanosegundos)' : 'PCAP (microsegundos)';

  while (true) {
    const cabecera = lector.tomar(16);
    if (!cabecera) break;
    const segundos = u32(cabecera, 0, formato.le);
    const fraccion = u32(cabecera, 4, formato.le);
    const largo = u32(cabecera, 8, formato.le);
    if (largo > MAX_PAQUETE) throw new Error(`paquete PCAP demasiado grande: ${largo} bytes`);
    const datos = lector.tomar(largo);
    if (!datos) { estado.paquetesTruncados++; break; }
    anotarPaquete(estado, datos, segundos * 1000 + (formato.nano ? fraccion / 1e6 : fraccion / 1000));
  }
}

function resolucionOpcionPcapng(opciones, le) {
  let o = 0;
  while (o + 4 <= opciones.length) {
    const tipo = u16(opciones, o, le);
    const largo = u16(opciones, o + 2, le);
    if (tipo === 0) break;
    const valor = opciones.subarray(o + 4, o + 4 + largo);
    if (tipo === 9 && valor.length) {
      const r = valor[0];
      return (r & 0x80) ? 2 ** -(r & 0x7f) : 10 ** -r;
    }
    o += 4 + Math.ceil(largo / 4) * 4;
  }
  return 1e-6; // resolución PCAPNG por defecto
}

function escanearPcapng(lector, primeros4, estado) {
  let le = true;
  let cabeceraInicial = Buffer.concat([primeros4, lector.tomar(8) || Buffer.alloc(0)]);
  if (cabeceraInicial.length < 12) throw new Error('cabecera PCAPNG incompleta');
  const bom = cabeceraInicial.subarray(8, 12).toString('hex');
  if (bom === '4d3c2b1a') le = true;
  else if (bom === '1a2b3c4d') le = false;
  else throw new Error('PCAPNG sin byte-order magic válido');
  let largoInicial = u32(cabeceraInicial, 4, le);
  if (largoInicial < 28 || largoInicial > MAX_PAQUETE) throw new Error(`bloque PCAPNG inválido: ${largoInicial}`);
  const restoInicial = lector.tomar(largoInicial - 12);
  if (!restoInicial) throw new Error('bloque de sección PCAPNG truncado');
  estado.formato = 'PCAPNG';
  const interfaces = [];

  while (true) {
    const cabecera = lector.tomar(8);
    if (!cabecera) break;
    const tipo = u32(cabecera, 0, le);
    let largo = u32(cabecera, 4, le);

    /* Una nueva Section Header Block puede invertir endianess. */
    if (tipo === 0x0a0d0d0a) {
      const bomNuevo = lector.tomar(4);
      if (!bomNuevo) { estado.paquetesTruncados++; break; }
      const hex = bomNuevo.toString('hex');
      if (hex === '4d3c2b1a') le = true;
      else if (hex === '1a2b3c4d') le = false;
      else throw new Error('nueva sección PCAPNG con byte-order magic inválido');
      largo = u32(cabecera, 4, le);
      if (largo < 28 || largo > MAX_PAQUETE) throw new Error(`bloque de sección PCAPNG inválido: ${largo}`);
      const resto = lector.tomar(largo - 12);
      if (!resto) { estado.paquetesTruncados++; break; }
      interfaces.length = 0;
      continue;
    }

    if (largo < 12 || largo > MAX_PAQUETE) throw new Error(`bloque PCAPNG inválido: ${largo}`);
    const cuerpoConCola = lector.tomar(largo - 8);
    if (!cuerpoConCola) { estado.paquetesTruncados++; break; }
    const cuerpo = cuerpoConCola.subarray(0, cuerpoConCola.length - 4);

    if (tipo === 0x00000001 && cuerpo.length >= 8) { // Interface Description Block
      interfaces.push({ resolucion: resolucionOpcionPcapng(cuerpo.subarray(8), le) });
    } else if (tipo === 0x00000006 && cuerpo.length >= 20) { // Enhanced Packet Block
      const interfaz = u32(cuerpo, 0, le);
      const alto = u32(cuerpo, 4, le);
      const bajo = u32(cuerpo, 8, le);
      const capLen = u32(cuerpo, 12, le);
      if (capLen > cuerpo.length - 20 || capLen > MAX_PAQUETE) continue;
      const datos = cuerpo.subarray(20, 20 + capLen);
      const ticks = alto * 0x1_0000_0000 + bajo;
      const resolucion = (interfaces[interfaz] || { resolucion: 1e-6 }).resolucion;
      anotarPaquete(estado, datos, ticks * resolucion * 1000);
    }
  }
}

function escanearArchivo() {
  const lector = new LectorBinario(PCAP);
  const estado = { formato: '', paquetesLeidos: 0, paquetesTruncados: 0, manifests: [], contextosHttp: [], controles: [] };
  try {
    const primeros4 = lector.tomar(4);
    if (!primeros4) throw new Error('PCAP vacío');
    if (primeros4.toString('hex') === '0a0d0d0a') escanearPcapng(lector, primeros4, estado);
    else escanearPcap(lector, primeros4, estado);
    return estado;
  } finally {
    lector.cerrar();
  }
}

function formatoEstado(meta) {
  if (!meta) return 'sin validar en cosecha';
  if (meta.ok) return `HLS válido · ${meta.duracion} · ${meta.segmentos} segmentos`;
  return `HTTP ${meta.estado || '?'}${meta.error ? ` · ${meta.error}` : ''}`;
}

function enlazarControles(controles, manifests, cachePorAppId) {
  return controles.map((control) => {
    const salida = { ...control, ficha: cachePorAppId.get(control.appId) || null, manifestCercano: null };
    const t = Date.parse(control.tiempo);
    let mejor = null;
    for (const manifest of manifests) {
      const diferencia = (Date.parse(manifest.tiempo) - t) / 1000;
      if (!Number.isFinite(diferencia)) continue;
      if (!mejor || Math.abs(diferencia) < Math.abs(mejor.diferenciaSegundos)) {
        mejor = { carpeta: manifest.carpeta, ruta: manifest.ruta, diferenciaSegundos: Number(diferencia.toFixed(3)) };
      }
    }
    /* Más de dos minutos deja de ser una correlación temporal útil. */
    if (mejor && Math.abs(mejor.diferenciaSegundos) <= 120) salida.manifestCercano = mejor;
    return salida;
  });
}

function textoReporte(reporte) {
  const lineas = [];
  lineas.push(`PCAP: ${reporte.pcap}`);
  lineas.push(`Formato: ${reporte.formato}`);
  lineas.push(`GET M3U8 Movie en orden: ${reporte.manifests.length}`);
  lineas.push(`Rutas únicas: ${reporte.resumen.rutasUnicas}`);
  lineas.push('');
  lineas.push('ORDEN TEMPORAL DE MANIFESTS:');
  if (!reporte.manifests.length) {
    lineas.push('  No se detectó una ruta /vod/.../index5.m3u8 completa dentro de un paquete.');
    lineas.push('  El PCAP queda intacto; puede tener el URI dividido entre paquetes TCP.');
  }
  for (const x of reporte.manifests) {
    lineas.push(`  ${x.tiempo} · ${x.carpeta} · ${formatoEstado(x.cosecha)}`);
    lineas.push(`    ${x.host || '(Host no venía en el mismo paquete)'} · ${x.ruta}`);
  }
  lineas.push('');
  lineas.push(`VOD_ID DEL PROXY LOCAL VISIBLES: ${reporte.controles.length}`);
  if (!reporte.controles.length) {
    lineas.push('  Ninguno visible: PCAPdroid puede no incluir tráfico localhost; es normal.');
  }
  for (const x of reporte.controles) {
    const ficha = x.ficha ? `${x.ficha.titulo || '(sin título)'} · web ${x.ficha.webId}` : 'sin ficha en la caché actual';
    const cerca = x.manifestCercano
      ? ` · manifest cercano ${x.manifestCercano.carpeta} (${x.manifestCercano.diferenciaSegundos >= 0 ? '+' : ''}${x.manifestCercano.diferenciaSegundos.toFixed(3)} s)`
      : '';
    lineas.push(`  ${x.tiempo} · app ${x.appId} · ${ficha}${cerca}`);
  }
  lineas.push('');
  lineas.push(`OTRAS PETICIONES HTTP DE CONTEXTO: ${reporte.contextosHttp.length}`);
  if (!reporte.contextosHttp.length) {
    lineas.push('  Ninguna visible (la ficha/portada puede haber viajado por HTTPS; es normal).');
  }
  for (const x of reporte.contextosHttp) {
    lineas.push(`  ${x.tiempo} · ${x.metodo} ${x.host || '(sin Host)'}${x.ruta}`);
  }
  lineas.push('');
  lineas.push('NOTA: El orden ayuda a contrastar lo que el amigo reprodujo; por sí solo no asigna un título.');
  return `${lineas.join('\n')}\n`;
}

(async () => {
  const cosecha = mapaCosecha();
  const cache = mapaCachePorAppId();
  console.log('Leyendo el PCAP directamente en bloques; no se descargan ni imprimen segmentos…');
  const escaneo = escanearArchivo();
  const conteoRuta = new Map();
  const manifests = escaneo.manifests.map((x) => {
    const numero = (conteoRuta.get(x.ruta) || 0) + 1;
    conteoRuta.set(x.ruta, numero);
    return {
      ...x,
      carpeta: carpetaDeRuta(x.ruta),
      ocurrencia: numero,
      cosecha: cosecha.get(x.ruta) || null,
    };
  });
  const controles = enlazarControles(escaneo.controles, manifests, cache.mapa);
  const reporte = {
    version: 3,
    generadoEn: new Date().toISOString(),
    pcap: PCAP,
    cosecha: COSECHA || '',
    cacheEpisodios: cache.archivo,
    formato: escaneo.formato,
    filtro: 'escaneo binario local de rutas exactas /vod/1/.../index5.m3u8 y control verify; queries, device_id y headers no se guardan',
    manifests,
    controles,
    contextosHttp: escaneo.contextosHttp.slice(0, 500),
    resumen: {
      paquetesLeidos: escaneo.paquetesLeidos,
      paquetesTruncados: escaneo.paquetesTruncados,
      manifestsDetectados: manifests.length,
      rutasUnicas: conteoRuta.size,
      controlesVerify: controles.length,
      controlesConFicha: controles.filter((x) => x.ficha).length,
      contextosHttp: Math.min(escaneo.contextosHttp.length, 500),
    },
  };
  await fsp.writeFile(SALIDA_JSON, `${JSON.stringify(reporte, null, 2)}\n`);
  await fsp.writeFile(SALIDA_TEXTO, textoReporte(reporte));
  console.log(`Listo. ${manifests.length} manifest(s) (${conteoRuta.size} rutas únicas), ${escaneo.paquetesLeidos} paquetes leídos.`);
  console.log(`Orden: ${SALIDA_TEXTO}`);
  console.log(`Datos: ${SALIDA_JSON}`);
})().catch((err) => salir(err.stack || err.message || String(err)));
