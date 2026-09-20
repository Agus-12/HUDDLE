/**
 * modulo-espejo.js — Obtiene URLs de video del API y las sirve vía espejo abierto.
 * NO necesita wsSecret. El espejo 147.124.216.142 sirve todo sin firma.
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const HOST = 'https://surfclick.vd7au6.com';
const DEV = 'huddle_oracle_001';
const SEC = 'Zox882LYjEn4Rqpa';
const HDR_KEY = '47Q8tBqO4YqrMHf4';
const AES_KEY = Buffer.from('0123456789123456');
const AES_IV = Buffer.from('2015030120123456');
const ESPEJO = '147.124.216.142';

function descifrar(txt) {
  const raw = Buffer.from(txt, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
  let d = decipher.update(raw);
  d = Buffer.concat([d, decipher.final()]);
  return JSON.parse(d.toString('utf-8'));
}

function pedir(ruta, body, token = '') {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const sign = crypto.createHash('md5').update(HDR_KEY + DEV + ts).digest('hex').toUpperCase();
    const url = new URL(HOST + ruta);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'app_id': 'movievn', 'version': '40000', 'sys_platform': '2',
        'device_id': DEV, 'channel_code': 'movievn_sh_1000',
        'cur_time': String(ts), 'sign': sign, 'token': token,
        'user-agent': 'okhttp/4.12.0',
        'content-type': 'application/x-www-form-urlencoded'
      },
      rejectUnauthorized: false
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function obtenerToken() {
  const resp = await pedir('/api/public/init', `device_id=${DEV}&channel_code=movievn_sh_1000`);
  const j = descifrar(resp);
  return j.result.user_info.token;
}

async function obtenerVideo(vodId, token) {
  const ts = Date.now();
  const sign = crypto.createHash('md5').update(SEC + DEV + vodId + ts).digest('hex').toUpperCase();
  const body = `vod_id=${vodId}&cur_time=${ts}&sign=${sign}&audio_type=0`;
  const resp = await pedir('/api/vod/info_new', body, token);
  return descifrar(resp).result || {};
}

function urlEspejo(url) {
  return url ? url.replace('movievn.j5t2n.com', ESPEJO) : '';
}

async function playlistCompleta(vodId) {
  const token = await obtenerToken();
  const result = await obtenerVideo(vodId, token);
  const col = result.vod_collection || [];
  return {
    nombre: result.vod_name || '',
    year: result.vod_year || '',
    episodios: col.map(c => ({
      titulo: c.title || '',
      tipo: c.type,
      duracion: c.duration || 0,
      url: urlEspejo(c.vod_url),
      url_original: c.vod_url || ''
    })).filter(e => e.url)
  };
}

module.exports = { obtenerToken, obtenerVideo, urlEspejo, playlistCompleta, descifrar, pedir };

// CLI
if (require.main === module) {
  const id = process.argv[2] || '98331';
  playlistCompleta(id).then(p => {
    console.log(`Título: ${p.nombre} (${p.year})`);
    console.log(`Episodios: ${p.episodios.length}`);
    p.episodios.slice(0, 5).forEach((e, i) => {
      console.log(`  [${e.titulo}] ${e.url}`);
    });
    if (p.episodios.length > 5) console.log(`  ... y ${p.episodios.length - 5} más`);
  }).catch(e => console.error('Error:', e.message));
}
