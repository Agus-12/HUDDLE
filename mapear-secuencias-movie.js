#!/usr/bin/env node
'use strict';

/*
 * Huddle — mapa local de episodios Movie confirmado por SECUENCIA.
 *
 * Lee el reporte de cosechar-pcap-movie.js y contrasta cada grupo de rutas
 * con huellas de duración ya verificadas en fichas públicas de Movie.
 * No pide CDN, no descarga segmentos y no escribe queries/tokens.
 *
 * Uso en Oracle:
 *   node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json
 *
 * Salidas junto al reporte (ignoradas por Git):
 *   ~/movie-mapa-secuencias.json
 *   ~/movie-mapa-secuencias.txt
 *
 * El mapa solo asigna una ruta cuando su propia respuesta M3U8 histórica
 * coincide en el orden completo de una secuencia. Si falta una respuesta,
 * la ruta queda sin episodio aunque sus vecinas formen un patrón.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const HUELLAS = path.join(RAIZ, 'auditorias', 'huellas-secuencias-movie.json');
const MINIMO_COINCIDENCIAS = 4;

function salir(mensaje, codigo = 1) {
  console.error(`Error: ${mensaje}`);
  console.error('Uso: node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json');
  process.exit(codigo);
}

const entradaArg = process.argv[2];
if (!entradaArg || entradaArg === '--help' || entradaArg === '-h') {
  if (entradaArg) {
    console.log('Uso: node mapear-secuencias-movie.js ~/movie-cosecha-pcap.json');
    console.log('Crea un mapa local solo para secuencias confirmadas por duración y orden.');
  } else {
    salir('falta el reporte generado por cosechar-pcap-movie.js');
  }
  process.exit(entradaArg ? 0 : 1);
}

const ENTRADA = path.resolve(entradaArg);
const SALIDA_DIR = path.dirname(ENTRADA);
const SALIDA_JSON = path.join(SALIDA_DIR, 'movie-mapa-secuencias.json');
const SALIDA_TEXTO = path.join(SALIDA_DIR, 'movie-mapa-secuencias.txt');

function leerJson(archivo, defecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}

function guardarAtomico(archivo, valor) {
  const temporal = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(valor, null, 2)}\n`);
  fs.renameSync(temporal, archivo);
}

function rutaMovie(cruda) {
  const ruta = String(cruda || '').split('?')[0].split('#')[0];
  const m = /^\/vod\/1\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{12})\/index5\.m3u8$/i.exec(ruta);
  if (!m) return null;
  return { ruta, fecha: `${m[1]}-${m[2]}-${m[3]}`, carpeta: m[4].toLowerCase() };
}

function numeroFinito(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function formatoDuracion(segundos) {
  const msTotales = Math.round(numeroFinito(segundos) * 1000);
  const h = Math.floor(msTotales / 3600000);
  const m = Math.floor((msTotales % 3600000) / 60000);
  const s = Math.floor((msTotales % 60000) / 1000);
  const ms = msTotales % 1000;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function estadoActualSeguro(actual) {
  if (!actual || typeof actual !== 'object') return null;
  return {
    comprobado: true,
    ok: Boolean(actual.ok),
    estado: Math.max(0, Math.floor(numeroFinito(actual.estado))),
    duracion: actual.ok ? String(actual.duracion || '') : '',
    segmentos: actual.ok ? Math.max(0, Math.floor(numeroFinito(actual.segmentos))) : 0,
  };
}

function prepararCapturas(reporte) {
  if (!reporte || !Array.isArray(reporte.resultados)) salir(`no pude leer resultados válidos en ${ENTRADA}`);
  if (!reporte.resultados.some((x) => x && Object.prototype.hasOwnProperty.call(x, 'okCapturado'))) {
    salir('este no parece el reporte de cosechar-pcap-movie.js; falta okCapturado');
  }

  const vistas = new Set();
  const capturas = [];
  for (const fila of reporte.resultados) {
    const info = rutaMovie(fila && fila.ruta);
    if (!info || vistas.has(info.ruta)) continue;
    vistas.add(info.ruta);
    const duracion = numeroFinito(fila.duracionSegundos);
    const tieneManifest = Boolean(fila.okCapturado) && duracion > 0;
    capturas.push({
      ...info,
      tieneManifest,
      estadoCapturado: Math.max(0, Math.floor(numeroFinito(fila.estadoCapturado))),
      duracionSegundos: tieneManifest ? duracion : 0,
      duracion: tieneManifest ? (String(fila.duracion || '') || formatoDuracion(duracion)) : '',
      segmentos: tieneManifest ? Math.max(0, Math.floor(numeroFinito(fila.segmentos))) : 0,
      errorCaptura: tieneManifest ? '' : String(fila.errorCaptura || 'sin respuesta HTTP/M3U8 recuperable'),
      actual: estadoActualSeguro(fila.actual),
    });
  }
  if (!capturas.length) salir('el reporte no contiene rutas Movie válidas');
  return capturas;
}

function validarHuellas(datos) {
  if (!datos || datos.version !== 1 || !Array.isArray(datos.series) || !datos.series.length) {
    salir(`las huellas no son válidas: ${HUELLAS}`);
  }
  const porClave = new Set();
  for (const h of datos.series) {
    const eps = h && h.secuencia && h.secuencia.episodios;
    if (!h || !h.clave || porClave.has(h.clave) || !/^\d{4}-\d{2}-\d{2}$/.test(String(h.fechaCarpeta || ''))
      || !Array.isArray(eps) || eps.length < MINIMO_COINCIDENCIAS) {
      salir(`huella inválida: ${h && h.clave ? h.clave : '(sin clave)'}`);
    }
    porClave.add(h.clave);
  }
  return datos;
}

/* Una huella se acepta solo si el grupo tiene el mismo número de rutas y
 * TODA ruta que sí tiene manifest histórico coincide con su posición. Una
 * ausencia no se "rellena": simplemente se conserva sin episodio asignado. */
function contrastarHuella(huella, grupo, tolerancia) {
  const esperados = huella.secuencia.episodios || [];
  if (grupo.length !== esperados.length) return null;

  const coincidencias = [];
  const sinManifest = [];
  let errorAbsoluto = 0;
  let maxError = 0;

  for (let i = 0; i < grupo.length; i++) {
    const ruta = grupo[i];
    const esperado = esperados[i];
    if (!ruta.tieneManifest) {
      sinManifest.push(ruta);
      continue;
    }
    const diferencia = Number((ruta.duracionSegundos - numeroFinito(esperado.duracionSegundos)).toFixed(3));
    if (Math.abs(diferencia) > tolerancia) return null;
    errorAbsoluto += Math.abs(diferencia);
    maxError = Math.max(maxError, Math.abs(diferencia));
    coincidencias.push({ ruta, esperado, diferencia });
  }

  if (coincidencias.length < MINIMO_COINCIDENCIAS) return null;
  return {
    coincidencias,
    sinManifest,
    errorAbsoluto: Number(errorAbsoluto.toFixed(3)),
    maxError: Number(maxError.toFixed(3)),
  };
}

function nombrePatron(huella) {
  const eps = huella.secuencia.episodios || [];
  if (!eps.length) return '';
  if (eps.length === 1) return `E${eps[0].numero}`;
  return `E${eps[0].numero}, E${eps[1].numero}, …, E${eps[eps.length - 1].numero}`;
}

function construirGrupo(huella, contraste) {
  const audioLatino = huella.audio && huella.audio.clasificacion === 'latino-inequivoco';
  const episodios = contraste.coincidencias.map(({ ruta, esperado, diferencia }) => ({
    ruta: ruta.ruta,
    carpeta: ruta.carpeta,
    temporada: Number(huella.temporada),
    episodio: Number(esperado.numero),
    duracionCapturadaSegundos: ruta.duracionSegundos,
    duracionCapturada: ruta.duracion,
    segmentosCapturados: ruta.segmentos,
    duracionCatalogoSegundos: numeroFinito(esperado.duracionSegundos),
    diferenciaCatalogoSegundos: diferencia,
    estadoCapturado: ruta.estadoCapturado,
    disponibilidadActual: ruta.actual,
    disponibleParaMovieAhora: Boolean(audioLatino && ruta.actual && ruta.actual.ok),
  }));

  return {
    clave: huella.clave,
    fechaCarpeta: huella.fechaCarpeta,
    titulo: huella.titulo,
    temporada: Number(huella.temporada),
    webId: Number(huella.webId),
    appId: Number(huella.appId),
    poster: String(huella.poster || ''),
    audio: {
      clasificacion: String((huella.audio && huella.audio.clasificacion) || 'pendiente'),
      motivo: String((huella.audio && huella.audio.motivo) || ''),
    },
    evidencia: {
      tipo: 'secuencia-ordenada-de-duraciones',
      patronEsperado: nombrePatron(huella),
      rutasEsperadas: huella.secuencia.episodios.length,
      rutasConManifestCoincidente: episodios.length,
      rutasSinManifestAsignable: contraste.sinManifest.length,
      errorAbsolutoTotalSegundos: contraste.errorAbsoluto,
      errorMaximoSegundos: contraste.maxError,
      toleranciaSegundos: numeroFinito(huella.toleranciaSegundos),
    },
    episodios,
    /* Importante: se guarda la ruta, pero NO un episodio supuesto. */
    sinManifestSinAsignar: contraste.sinManifest.map((ruta) => ({
      ruta: ruta.ruta,
      carpeta: ruta.carpeta,
      motivo: 'No hubo manifest HTTP/M3U8 recuperable en esta ruta; no se infiere episodio por sus vecinas.',
    })),
  };
}

function reporteTexto(mapa) {
  const lineas = [];
  lineas.push('MAPA LOCAL MOVIE — SECUENCIAS CONFIRMADAS');
  lineas.push('Este archivo es local: no subirlo a Git ni publicar las rutas.');
  lineas.push('');
  lineas.push(`Rutas del PCAP: ${mapa.resumen.rutasEntrada}`);
  lineas.push(`Manifests históricos recuperados: ${mapa.resumen.manifestsHistoricos}`);
  lineas.push(`Rutas asignadas por evidencia secuencial: ${mapa.resumen.rutasAsignadas}`);
  lineas.push(`Rutas sin asignar: ${mapa.resumen.rutasSinAsignar}`);
  lineas.push(`Rutas latino reproducibles ahora: ${mapa.resumen.latinoReproducibleAhora}`);
  lineas.push(`Rutas excluidas por audio: ${mapa.resumen.excluidasPorAudio}`);
  lineas.push('');

  for (const grupo of mapa.grupos) {
    lineas.push(`${grupo.titulo} · Temporada ${grupo.temporada} · ${grupo.fechaCarpeta}`);
    lineas.push(`  Patrón ${grupo.evidencia.patronEsperado}; ${grupo.evidencia.rutasConManifestCoincidente}/${grupo.evidencia.rutasEsperadas} coincidencias; error total ${grupo.evidencia.errorAbsolutoTotalSegundos.toFixed(3)} s.`);
    lineas.push(`  Audio: ${grupo.audio.clasificacion} — ${grupo.audio.motivo}`);
    for (const ep of grupo.episodios) {
      const ahora = ep.disponibilidadActual
        ? (ep.disponibilidadActual.ok ? 'disponible ahora' : `HTTP actual ${ep.disponibilidadActual.estado || '?'}`)
        : 'sin comprobación actual';
      const bandera = ep.disponibleParaMovieAhora ? ' · LISTO PARA MOVIE' : '';
      const signo = ep.diferenciaCatalogoSegundos > 0 ? '+' : '';
      lineas.push(`  E${ep.episodio} · ${ep.duracionCapturada} · diferencia ${signo}${ep.diferenciaCatalogoSegundos.toFixed(3)} s · ${ep.carpeta} · ${ahora}${bandera}`);
    }
    for (const x of grupo.sinManifestSinAsignar) lineas.push(`  SIN ASIGNAR · ${x.carpeta} · ${x.motivo}`);
    lineas.push('');
  }

  if (mapa.sinAsignar.length) {
    lineas.push('RUTAS SIN ASIGNACIÓN INDIVIDUAL:');
    for (const x of mapa.sinAsignar) lineas.push(`  ${x.carpeta} · ${x.motivo}`);
  }
  return `${lineas.join('\n')}\n`;
}

(function main() {
  const reporte = leerJson(ENTRADA, null);
  const huellas = validarHuellas(leerJson(HUELLAS, null));
  const capturas = prepararCapturas(reporte);
  const porFecha = new Map();
  for (const captura of capturas) {
    const lista = porFecha.get(captura.fecha) || [];
    lista.push(captura);
    porFecha.set(captura.fecha, lista);
  }

  const usados = new Set();
  const grupos = [];
  const toleranciaBase = numeroFinito(huellas.toleranciaSegundos) || 1;

  for (const huella of huellas.series) {
    const grupo = porFecha.get(huella.fechaCarpeta) || [];
    const contraste = contrastarHuella(huella, grupo, toleranciaBase);
    if (!contraste) continue;
    const salida = construirGrupo({ ...huella, toleranciaSegundos: toleranciaBase }, contraste);
    grupos.push(salida);
    for (const ep of salida.episodios) usados.add(ep.ruta);
  }

  const sinAsignar = capturas
    .filter((x) => !usados.has(x.ruta))
    .map((x) => ({
      ruta: x.ruta,
      carpeta: x.carpeta,
      fechaCarpeta: x.fecha,
      motivo: x.tieneManifest
        ? 'No coincide con una huella secuencial completa aprobada.'
        : 'No hubo manifest HTTP/M3U8 recuperable; no se asigna título ni episodio por vecindad.',
    }));

  const episodios = grupos.flatMap((x) => x.episodios);
  const excluidasPorAudio = grupos
    .filter((x) => x.audio.clasificacion !== 'latino-inequivoco')
    .reduce((n, x) => n + x.episodios.length, 0);
  const mapa = {
    version: 1,
    generadoEn: new Date().toISOString(),
    origen: path.basename(ENTRADA),
    advertencia: 'estadoCapturado describe la respuesta recibida en el PCAP y no prueba disponibilidad actual. Las rutas sin manifest histórico no reciben episodio inferido.',
    fuenteHuellas: path.relative(RAIZ, HUELLAS),
    resumen: {
      rutasEntrada: capturas.length,
      manifestsHistoricos: capturas.filter((x) => x.tieneManifest).length,
      gruposConfirmados: grupos.length,
      rutasAsignadas: episodios.length,
      rutasSinAsignar: sinAsignar.length,
      latinoReproducibleAhora: episodios.filter((x) => x.disponibleParaMovieAhora).length,
      excluidasPorAudio,
    },
    grupos,
    sinAsignar,
  };

  guardarAtomico(SALIDA_JSON, mapa);
  fs.writeFileSync(SALIDA_TEXTO, reporteTexto(mapa));
  console.log(`Listo. ${mapa.resumen.rutasAsignadas}/${mapa.resumen.rutasEntrada} rutas asignadas por secuencia.`);
  console.log(`Latino reproducible ahora: ${mapa.resumen.latinoReproducibleAhora}. Excluidas por audio: ${mapa.resumen.excluidasPorAudio}.`);
  console.log(`Mapa local: ${SALIDA_JSON}`);
  console.log(`Resumen: ${SALIDA_TEXTO}`);
})();
