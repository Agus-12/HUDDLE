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
 * Requiere tcpdump (ya usado para extraer las rutas originales). El filtro
 * BPF deja pasar solo paquetes cuyo payload empieza por GET o POST, para no
 * recorrer/imprimir los cientos de MB de segmentos MPEG-TS.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

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

function sinQuery(valor) {
  const limpio = String(valor || '').split('?')[0].split('#')[0];
  /* Algunos clientes mandan URI absoluta en vez de una ruta relativa. */
  try {
    if (/^https?:\/\//i.test(limpio)) return new URL(limpio).pathname || '/';
  } catch { /* conservar la ruta original saneada */ }
  return limpio;
}

function carpetaDeRuta(ruta) {
  const m = String(ruta).match(/\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/([0-9a-f]{12})\/index5\.m3u8$/i);
  return m ? m[1].toLowerCase() : '';
}

function fechaPaquete(cabecera) {
  const m = String(cabecera).match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?:IP|IP6)\s+(.+?)(?::\s*)?$/);
  return m ? { tiempo: m[1], conexion: m[2] } : null;
}

function peticionDePaquete(cabecera, lineas) {
  const meta = fechaPaquete(cabecera);
  if (!meta) return null;
  const texto = lineas.join('\n');
  const inicio = texto.match(/(?:^|\n)\s*(GET|POST)\s+([^\s]+)\s+HTTP\/\d(?:\.\d)?/i);
  if (!inicio) return null;
  const host = (texto.match(/(?:^|\n)\s*Host:\s*([^\s\r\n]+)/i) || [])[1] || '';
  const referer = (texto.match(/(?:^|\n)\s*Referer:\s*([^\s\r\n]+)/i) || [])[1] || '';
  return {
    tiempo: meta.tiempo,
    conexion: meta.conexion,
    metodo: inicio[1].toUpperCase(),
    ruta: sinQuery(inicio[2]),
    host: host.trim(),
    /* Referer normalmente está vacío en el app. Si existe, se guarda solo el
       origen/ruta sin query para no llevar tokens a los reportes locales. */
    referer: sinQuery(referer.trim()),
  };
}

/* tcpdump con este BPF solo emite el paquete que comienza con GET/POST.
 * Si algún dispositivo divide las primeras cuatro letras entre paquetes,
 * el resumen avisará que no encontró solicitudes y conserva el PCAP intacto. */
const BPF = 'tcp[((tcp[12] & 0xf0) >> 2):4] = 0x47455420 or tcp[((tcp[12] & 0xf0) >> 2):4] = 0x504f5354';

function leerPeticiones() {
  return new Promise((resolve, reject) => {
    const hijo = spawn('tcpdump', ['-tttt', '-nn', '-A', '-s', '0', '-r', PCAP, BPF], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let parcial = '';
    let cabecera = '';
    let lineas = [];
    const peticiones = [];

    const vaciar = () => {
      if (!cabecera) return;
      const peticion = peticionDePaquete(cabecera, lineas);
      if (peticion) peticiones.push(peticion);
      cabecera = '';
      lineas = [];
    };
    const procesarLinea = (linea) => {
      if (fechaPaquete(linea)) {
        vaciar();
        cabecera = linea;
      } else if (cabecera) {
        lineas.push(linea);
      }
    };

    hijo.stdout.setEncoding('utf8');
    hijo.stdout.on('data', (trozo) => {
      parcial += trozo;
      let corte;
      while ((corte = parcial.indexOf('\n')) >= 0) {
        const linea = parcial.slice(0, corte).replace(/\r$/, '');
        parcial = parcial.slice(corte + 1);
        procesarLinea(linea);
      }
    });
    hijo.stderr.setEncoding('utf8');
    hijo.stderr.on('data', (trozo) => { stderr += trozo; });
    hijo.on('error', (err) => {
      if (err.code === 'ENOENT') reject(new Error('no encuentro tcpdump; instala tcpdump y vuelve a correr el mismo comando'));
      else reject(err);
    });
    hijo.on('close', (codigo) => {
      if (parcial) procesarLinea(parcial.replace(/\r$/, ''));
      vaciar();
      if (codigo !== 0 && !peticiones.length) reject(new Error(`tcpdump terminó con código ${codigo}: ${stderr.trim().slice(-300)}`));
      else resolve(peticiones);
    });
  });
}

function esM3u8Movie(peticion) {
  return peticion.metodo === 'GET' && /^\/vod\/1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{12}\/index5\.m3u8$/i.test(peticion.ruta);
}

function esContextoUtil(peticion) {
  return /\/(?:img\/vod_pic|api\/(?:vod|search|topic|user_history)|vod\/)/i.test(peticion.ruta);
}

function formatoEstado(meta) {
  if (!meta) return 'sin validar en cosecha';
  if (meta.ok) return `HLS válido · ${meta.duracion} · ${meta.segmentos} segmentos`;
  return `HTTP ${meta.estado || '?'}${meta.error ? ` · ${meta.error}` : ''}`;
}

function textoReporte(reporte) {
  const lineas = [];
  lineas.push(`PCAP: ${reporte.pcap}`);
  lineas.push(`GET M3U8 Movie en orden: ${reporte.manifests.length}`);
  lineas.push(`Rutas únicas: ${reporte.resumen.rutasUnicas}`);
  lineas.push('');
  lineas.push('ORDEN TEMPORAL DE MANIFESTS:');
  if (!reporte.manifests.length) {
    lineas.push('  No se detectó ningún GET /vod/.../index5.m3u8 con el filtro rápido.');
    lineas.push('  Esto no altera el PCAP; puede significar que el GET fue dividido entre paquetes.');
  }
  for (const x of reporte.manifests) {
    lineas.push(`  ${x.tiempo} · ${x.carpeta} · ${formatoEstado(x.cosecha)}`);
    lineas.push(`    ${x.host || '(sin Host)'} · ${x.ruta}`);
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
  console.log('Leyendo solo paquetes HTTP GET/POST del PCAP; no se descargan segmentos…');
  const peticiones = await leerPeticiones();
  const conteoRuta = new Map();
  const manifests = peticiones.filter(esM3u8Movie).map((x) => {
    const ruta = sinQuery(x.ruta);
    const numero = (conteoRuta.get(ruta) || 0) + 1;
    conteoRuta.set(ruta, numero);
    return {
      ...x,
      carpeta: carpetaDeRuta(ruta),
      ocurrencia: numero,
      cosecha: cosecha.get(ruta) || null,
    };
  });
  const contextosHttp = peticiones
    .filter((x) => !esM3u8Movie(x) && esContextoUtil(x))
    .slice(0, 500);
  const reporte = {
    version: 1,
    generadoEn: new Date().toISOString(),
    pcap: PCAP,
    cosecha: COSECHA || '',
    filtro: 'solo paquetes cuyo payload inicia con GET o POST; rutas y queries saneadas',
    manifests,
    contextosHttp,
    resumen: {
      peticionesHttpDetectadas: peticiones.length,
      manifestsDetectados: manifests.length,
      rutasUnicas: conteoRuta.size,
      contextosHttp: contextosHttp.length,
    },
  };
  await fsp.writeFile(SALIDA_JSON, `${JSON.stringify(reporte, null, 2)}\n`);
  await fsp.writeFile(SALIDA_TEXTO, textoReporte(reporte));
  console.log(`Listo. ${manifests.length} GET de manifest (${conteoRuta.size} rutas únicas).`);
  console.log(`Orden: ${SALIDA_TEXTO}`);
  console.log(`Datos: ${SALIDA_JSON}`);
})().catch((err) => salir(err.stack || err.message || String(err)));
