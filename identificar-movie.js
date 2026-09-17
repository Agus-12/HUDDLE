#!/usr/bin/env node
'use strict';

/*
 * Huddle — identifica episodios Movie por duración.
 *
 * Entrada: reporte creado por cosechar-movie.js (movie-cosecha.json).
 * Consulta la ficha web de las novelas, suma la muestra local con la vitrina
 * pública actual de Telenovela, construye/actualiza una caché local de
 * episodios y compara vod_duration contra la duración EXTINF de cada playlist
 * válida. No descarga segmentos ni guarda URLs con tokens.
 *
 * Uso en Oracle:
 *   node identificar-movie.js ~/movie-cosecha.json
 *
 * Salidas junto a la entrada:
 *   ~/movie-episodios-cache.json   (caché reutilizable)
 *   ~/movie-coincidencias.json
 *   ~/movie-coincidencias.txt
 *
 * Opcionales:
 *   MOVIE_MATCH_TOLERANCE=15       tolerancia en segundos (12 por defecto)
 *   MOVIE_CONCURRENCY=3            fichas simultáneas (2 por defecto)
 *   MOVIE_FORCE=1                  vuelve a pedir todas las fichas
 *   MOVIE_WEB_API=https://...      solo para cambiar el API si rota
 *   MOVIE_NOVELAS_CATALOG=/ruta/catalogo.json  solo para pruebas/migración
 *   MOVIE_VITRINA=0                no suma los títulos actuales de Telenovela
 *   MOVIE_VITRINA_URL=https://...  URL de vitrina alternativa (pruebas/rotación)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const API_RAW = process.env.MOVIE_WEB_API || 'https://albd.h4c5.com';
const CATALOGO = path.resolve(process.env.MOVIE_NOVELAS_CATALOG || path.join(__dirname, 'auditorias', 'novelas-app-catalogo.json'));
const USAR_VITRINA = !/^(0|false|no)$/i.test(String(process.env.MOVIE_VITRINA || '1'));
const VITRINA_RAW = process.env.MOVIE_VITRINA_URL || 'https://escc.k5ca.com/?channel_id=230';
const CONCURRENCIA = numeroSeguro(process.env.MOVIE_CONCURRENCY, 2, 1, 6);
const TOLERANCIA = numeroDecimalSeguro(process.env.MOVIE_MATCH_TOLERANCE, 12, 0, 120);
const CACHE_HORAS = numeroSeguro(process.env.MOVIE_CACHE_HOURS, 24, 0, 720);
const FORZAR = /^(1|true|si|sí)$/i.test(String(process.env.MOVIE_FORCE || ''));
const KEY = Buffer.from('0123456789123456');
const IV = Buffer.from('2015030120123456');
const DEVICE = crypto.createHash('md5').update('1111111').digest('hex');

function numeroSeguro(raw, porDefecto, min, max) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : porDefecto;
}
function numeroDecimalSeguro(raw, porDefecto, min, max) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : porDefecto;
}
function dormir(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function salir(mensaje) {
  console.error(`Error: ${mensaje}`);
  console.error('Uso: node identificar-movie.js ~/movie-cosecha.json');
  process.exit(1);
}

let API;
try {
  API = new URL(API_RAW);
  if (!['http:', 'https:'].includes(API.protocol)) throw new Error('protocolo');
} catch {
  salir('MOVIE_WEB_API no es una URL http(s) válida');
}
let VITRINA;
if (USAR_VITRINA) {
  try {
    VITRINA = new URL(VITRINA_RAW);
    if (!['http:', 'https:'].includes(VITRINA.protocol)) throw new Error('protocolo');
  } catch {
    salir('MOVIE_VITRINA_URL no es una URL http(s) válida');
  }
}

const entradaArg = process.argv[2];
if (!entradaArg || entradaArg === '--help' || entradaArg === '-h') {
  console.log('Uso: node identificar-movie.js ~/movie-cosecha.json');
  process.exit(entradaArg ? 0 : 1);
}
const ENTRADA = path.resolve(entradaArg);
const SALIDA_DIR = path.dirname(ENTRADA);
const ARCHIVO_CACHE = path.join(SALIDA_DIR, 'movie-episodios-cache.json');
const ARCHIVO_JSON = path.join(SALIDA_DIR, 'movie-coincidencias.json');
const ARCHIVO_TEXTO = path.join(SALIDA_DIR, 'movie-coincidencias.txt');

function fechaApi() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${Math.floor(d.getUTCMinutes() / 10)}`;
}

function encabezados() {
  const tiempo = Date.now();
  const sign = crypto.createHash('md5').update(`ppcineweb123${DEVICE}${tiempo}`).digest('hex').toUpperCase();
  return {
    'app_id': 'ppcinewebes',
    'channel_code': 'ppcinewebb_1000',
    'device_id': DEVICE,
    'cur_time': String(tiempo),
    'sign': sign,
    'token': '',
    'version': '30006',
    'sys_platform': '3',
    'mobmodel': '',
    'sysrelease': '',
    'mob_mfr': '',
    'app_language': 'es',
    'domain': 'escc.k5ca.com',
    'en_al': '1',
    'user-agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile',
    'origin': 'https://escc.k5ca.com',
    'referer': 'https://escc.k5ca.com/',
  };
}

function descifrar(texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) throw new Error('respuesta API vacía');
  if (limpio.startsWith('{') || limpio.startsWith('[')) return JSON.parse(limpio);
  if (!/^[A-Za-z0-9+/=]+$/.test(limpio.slice(0, 100)) || limpio.length < 40) {
    throw new Error(`respuesta API inesperada: ${limpio.slice(0, 100)}`);
  }
  const b64 = limpio + '='.repeat((-limpio.length) % 4);
  const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
  const plano = Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plano);
}

async function pedirFicha(webId) {
  const u = new URL('/api/vod/info_web_get', API);
  u.searchParams.set('vod_id', String(webId));
  u.searchParams.set('audio_type', 'es');
  u.searchParams.set('date', fechaApi());
  const respuesta = await fetch(u, { headers: encabezados(), signal: AbortSignal.timeout(20_000) });
  const texto = await respuesta.text();
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
  const cuerpo = descifrar(texto);
  if (Number(cuerpo.code) !== 10000) throw new Error(cuerpo.message || `código API ${cuerpo.code}`);
  return cuerpo.result || {};
}

function segundosDeHora(valor) {
  const s = String(valor || '').trim();
  if (!s) return 0;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const trozos = s.split(':').map(Number);
  if (trozos.some((n) => !Number.isFinite(n))) return 0;
  if (trozos.length === 3) return trozos[0] * 3600 + trozos[1] * 60 + trozos[2];
  if (trozos.length === 2) return trozos[0] * 60 + trozos[1];
  return 0;
}

function formatoDuracion(segundos) {
  if (!Number.isFinite(segundos) || segundos < 0) return '';
  const t = Math.round(segundos * 1000);
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const ms = t % 1000;
  const sinHoras = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${h ? `${h}:` : ''}${sinHoras}.${String(ms).padStart(3, '0')}`;
}

function simplificarFicha(item, ficha) {
  const episodios = Array.isArray(ficha.vod_collection) ? ficha.vod_collection : [];
  return {
    webId: Number(item.id),
    appId: Number(item.pianwei || 0),
    titulo: String(ficha.vod_name || item.vod_name || ''),
    poster: String(ficha.vod_pic || item.vod_pic || ''),
    totalCatalogo: Number(item.vod_total || 0),
    fetchedAt: new Date().toISOString(),
    episodios: episodios.map((ep) => {
      const duracionSegundos = Number(ep.vod_duration) || segundosDeHora(ep.duration);
      return {
        webEpisodeId: Number(ep.id || 0),
        collection: Number(ep.collection || ep.title || 0),
        titulo: String(ep.title || ep.collection || ''),
        duracionSegundos,
        duracion: formatoDuracion(duracionSegundos),
      };
    }).filter((ep) => ep.duracionSegundos > 0),
  };
}

function cargarJsonSeguro(archivo, defecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}

/* La portada SSR de /?channel_id=230 entrega las fichas que muestra la
 * vitrina pública. No es el catálogo entero, pero amplía la lista local rota
 * sin requerir una captura nueva ni descargar video. */
async function descubrirVitrina() {
  if (!USAR_VITRINA) return [];
  const respuesta = await fetch(VITRINA, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; HuddleMovieMatcher/1.0)', accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!respuesta.ok) throw new Error(`vitrina HTTP ${respuesta.status}`);
  const html = await respuesta.text();
  const encontrado = html.match(/<script\b[^>]*\bid=["']vite-plugin-ssr_pageContext["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!encontrado) throw new Error('vitrina sin pageContext SSR');
  let contexto;
  try { contexto = JSON.parse(encontrado[1]); } catch { throw new Error('pageContext SSR inválido'); }

  const porId = new Map();
  const recorrer = (valor) => {
    if (!valor || typeof valor !== 'object') return;
    if (Array.isArray(valor)) { valor.forEach(recorrer); return; }
    const id = Number(valor.id);
    /* channel 230 es Telenovela; conservar solo series para no disparar
     * cientos de fichas de películas de una página que cambie de canal. */
    if (Number.isFinite(id) && id > 0 && typeof valor.vod_name === 'string' && Number(valor.type_pid) === 2) {
      if (!porId.has(id)) porId.set(id, valor);
    }
    Object.values(valor).forEach(recorrer);
  };
  recorrer(contexto.pageProps);
  if (!porId.size) throw new Error('vitrina sin fichas de series');
  return [...porId.values()];
}

function cargarCache() {
  const cache = cargarJsonSeguro(ARCHIVO_CACHE, null);
  if (!cache || cache.version !== 1 || !cache.series || typeof cache.series !== 'object') {
    return { version: 1, creadoEn: new Date().toISOString(), series: {} };
  }
  return cache;
}

function guardarAtomico(archivo, valor) {
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(valor, null, 2)}\n`);
  fs.renameSync(tmp, archivo);
}

function cacheVigente(serie) {
  if (FORZAR || !serie || !serie.fetchedAt || !Array.isArray(serie.episodios) || !serie.episodios.length) return false;
  const edad = Date.now() - Date.parse(serie.fetchedAt);
  return Number.isFinite(edad) && edad >= 0 && edad < CACHE_HORAS * 3600 * 1000;
}

async function workers(items, limite, trabajo) {
  let siguiente = 0;
  const corredores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (true) {
      const i = siguiente++;
      if (i >= items.length) return;
      await trabajo(items[i], i);
    }
  });
  await Promise.all(corredores);
}

async function fichaConReintento(webId) {
  let ultimo;
  for (let intento = 0; intento < 3; intento++) {
    try { return await pedirFicha(webId); } catch (err) {
      ultimo = err;
      if (intento < 2) await dormir(700 * (intento + 1));
    }
  }
  throw ultimo;
}

function coincidir(capturas, series) {
  const episodios = [];
  for (const serie of Object.values(series)) {
    for (const ep of serie.episodios || []) episodios.push({
      webId: serie.webId,
      appId: serie.appId,
      serie: serie.titulo,
      poster: serie.poster,
      ...ep,
    });
  }

  return capturas.map((captura) => {
    const duracion = Number(captura.duracionSegundos || 0);
    const candidatos = episodios
      .map((ep) => ({ ...ep, diferenciaSegundos: Number((duracion - ep.duracionSegundos).toFixed(3)) }))
      .filter((ep) => Math.abs(ep.diferenciaSegundos) <= TOLERANCIA)
      .sort((a, b) => Math.abs(a.diferenciaSegundos) - Math.abs(b.diferenciaSegundos)
        || a.serie.localeCompare(b.serie, 'es') || a.collection - b.collection);
    return {
      carpeta: captura.carpeta,
      ruta: captura.ruta,
      fecha: captura.fecha,
      duracionSegundos: duracion,
      duracion: captura.duracion || formatoDuracion(duracion),
      segmentos: Number(captura.segmentos || 0),
      candidatos,
    };
  });
}

function resumenPorSerie(coincidencias) {
  const mapa = new Map();
  for (const c of coincidencias) {
    const vistosEnEstaRuta = new Set();
    for (const ep of c.candidatos) {
      const clave = String(ep.webId);
      if (vistosEnEstaRuta.has(clave)) continue;
      vistosEnEstaRuta.add(clave);
      const x = mapa.get(clave) || { webId: ep.webId, appId: ep.appId, serie: ep.serie, rutas: [], mejorDiferencia: Infinity };
      x.rutas.push(c.carpeta);
      x.mejorDiferencia = Math.min(x.mejorDiferencia, Math.abs(ep.diferenciaSegundos));
      mapa.set(clave, x);
    }
  }
  return [...mapa.values()]
    .sort((a, b) => b.rutas.length - a.rutas.length || a.mejorDiferencia - b.mejorDiferencia || a.serie.localeCompare(b.serie, 'es'));
}

function textoReporte(reporte) {
  const salida = [];
  salida.push(`RUTAS VÁLIDAS: ${reporte.coincidencias.length}`);
  salida.push(`TOLERANCIA: ±${reporte.toleranciaSegundos} s`);
  salida.push(`CATÁLOGO: ${reporte.catalogoLocalesUnicos} local(es) único(s), ${reporte.vitrina.fichasDescubiertas} de vitrina, ${reporte.catalogoSeriesUnicas} total`);
  salida.push(`EPISODIOS INDEXADOS: ${reporte.episodiosIndexados}`);
  salida.push('');

  for (const c of reporte.coincidencias) {
    salida.push(`${c.carpeta} · ${c.duracion} · ${c.segmentos} segmentos · ${c.ruta}`);
    if (!c.candidatos.length) {
      salida.push('  SIN COINCIDENCIAS por duración');
      salida.push('');
      continue;
    }
    for (const ep of c.candidatos.slice(0, 15)) {
      const signo = ep.diferenciaSegundos > 0 ? '+' : '';
      salida.push(`  ${ep.serie} · Ep. ${ep.collection} · ${ep.duracion} · diferencia ${signo}${ep.diferenciaSegundos.toFixed(3)} s · web ${ep.webId}`);
    }
    if (c.candidatos.length > 15) salida.push(`  … ${c.candidatos.length - 15} coincidencia(s) más en el JSON`);
    salida.push('');
  }

  const fuertes = reporte.seriesConMasCoincidencias.filter((x) => x.rutas.length >= 2);
  if (fuertes.length) {
    salida.push('SERIES QUE COINCIDEN CON 2+ RUTAS:');
    for (const s of fuertes.slice(0, 20)) {
      salida.push(`  ${s.serie} · ${s.rutas.length} ruta(s) · mejor diferencia ${s.mejorDiferencia.toFixed(3)} s · web ${s.webId}`);
    }
  }
  return `${salida.join('\n')}\n`;
}

(async () => {
  const cosecha = cargarJsonSeguro(ENTRADA, null);
  if (!cosecha || !Array.isArray(cosecha.resultados)) salir(`no pude leer un reporte válido en ${ENTRADA}`);
  const capturas = cosecha.resultados.filter((r) => r && r.ok && Number(r.duracionSegundos) > 0);
  if (!capturas.length) salir('el reporte no contiene playlists válidas con duración');

  const catalogoCrudo = cargarJsonSeguro(CATALOGO, null);
  if (!Array.isArray(catalogoCrudo) || !catalogoCrudo.length) salir(`no pude leer el catálogo de novelas: ${CATALOGO}`);
  /* El scrape histórico tiene páginas repetidas. Una ficha por webId basta y
   * evita pedir la misma serie muchas veces en la primera corrida. */
  const porWebId = new Map();
  for (const item of catalogoCrudo) {
    const id = Number(item && item.id);
    if (Number.isFinite(id) && id > 0 && !porWebId.has(id)) porWebId.set(id, item);
  }
  const localesUnicas = porWebId.size;

  let vitrina = [];
  if (USAR_VITRINA) {
    try {
      vitrina = await descubrirVitrina();
      for (const item of vitrina) {
        const id = Number(item.id);
        /* La lista local ya conserva pianwei cuando lo conocemos; la vitrina
         * solo llena huecos con títulos que no estaban en el scrape roto. */
        if (!porWebId.has(id)) porWebId.set(id, item);
      }
    } catch (err) {
      console.error(`Aviso: no pude ampliar desde la vitrina (${String(err.message || err)}); sigo con el catálogo local.`);
    }
  }
  const catalogo = [...porWebId.values()];
  if (!catalogo.length) salir(`el catálogo no contiene IDs web válidos: ${CATALOGO}`);

  const cache = cargarCache();
  const pendientes = catalogo.filter((item) => !cacheVigente(cache.series[String(item.id)]));
  let hechas = 0;
  let nuevas = 0;
  let fallidas = 0;
  console.log(`Rutas válidas: ${capturas.length}. Catálogo local: ${localesUnicas} únicas (${catalogoCrudo.length} filas).`);
  console.log(`Vitrina Telenovela: ${vitrina.length} fichas; total único para comparar: ${catalogo.length}.`);
  console.log(`Caché vigente: ${catalogo.length - pendientes.length}. Consultando: ${pendientes.length}…`);

  await workers(pendientes, CONCURRENCIA, async (item) => {
    try {
      const ficha = await fichaConReintento(item.id);
      const limpia = simplificarFicha(item, ficha);
      cache.series[String(item.id)] = limpia;
      nuevas++;
      process.stderr.write(`[${++hechas}/${pendientes.length}] OK  ${limpia.titulo || item.vod_name} · ${limpia.episodios.length} episodios\n`);
    } catch (err) {
      fallidas++;
      process.stderr.write(`[${++hechas}/${pendientes.length}] ERR ${item.vod_name} · ${String(err.message || err)}\n`);
    } finally {
      cache.actualizadoEn = new Date().toISOString();
      guardarAtomico(ARCHIVO_CACHE, cache);
    }
  });

  const coincidencias = coincidir(capturas, cache.series);
  const episodiosIndexados = Object.values(cache.series).reduce((n, s) => n + (s.episodios || []).length, 0);
  const reporte = {
    generadoEn: new Date().toISOString(),
    archivoCosecha: ENTRADA,
    catalogo: CATALOGO,
    api: API.origin,
    toleranciaSegundos: TOLERANCIA,
    rutasValidas: capturas.length,
    catalogoFilas: catalogoCrudo.length,
    catalogoLocalesUnicos: localesUnicas,
    vitrina: { activada: USAR_VITRINA, url: USAR_VITRINA ? VITRINA.toString() : '', fichasDescubiertas: vitrina.length },
    catalogoSeriesUnicas: catalogo.length,
    episodiosIndexados,
    consulta: { cacheVigente: catalogo.length - pendientes.length, nuevas, fallidas, totalSeries: Object.keys(cache.series).length },
    coincidencias,
    seriesConMasCoincidencias: resumenPorSerie(coincidencias),
  };
  await fsp.writeFile(ARCHIVO_JSON, `${JSON.stringify(reporte, null, 2)}\n`);
  await fsp.writeFile(ARCHIVO_TEXTO, textoReporte(reporte));

  const sinCoincidencias = coincidencias.filter((x) => !x.candidatos.length).length;
  console.log(`\nListo. Episodios indexados: ${episodiosIndexados}. Rutas sin candidato: ${sinCoincidencias}.`);
  console.log(`Caché: ${ARCHIVO_CACHE}`);
  console.log(`Reporte: ${ARCHIVO_JSON}`);
  console.log(`Resumen para pegar: ${ARCHIVO_TEXTO}`);
})().catch((err) => {
  console.error(`Error inesperado: ${err.stack || err.message || err}`);
  process.exit(1);
});
