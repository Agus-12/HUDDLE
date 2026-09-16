const crypto = require('crypto');
const KEY = Buffer.from('0123456789123456');
const IV  = Buffer.from('2015030120123456');
const DEVICE = crypto.createHash('md5').update('1111111').digest('hex');
function dec(txt) {
  try {
    let b64 = String(txt).trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 100)) || b64.length < 40) return '(plano) ' + String(txt).slice(0, 200);
    b64 += '='.repeat((-b64.length) % 4);
    const d = Buffer.from(b64, 'base64');
    const c = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
    return Buffer.concat([c.update(d), c.final()]).toString('utf8');
  } catch { return '(no dec) ' + String(txt).slice(0, 120); }
}
function headers(post) {
  const t = Date.now();
  const sign = crypto.createHash('md5').update('ppcineweb123' + DEVICE + t).digest('hex').toUpperCase();
  const h = {
    'app_id': 'ppcinewebes', 'channel_code': 'ppcinewebb_1000', 'device_id': DEVICE,
    'cur_time': String(t), 'sign': sign, 'token': '', 'version': '30006', 'sys_platform': '3',
    'mobmodel': '', 'sysrelease': '', 'mob_mfr': '', 'app_language': 'es',
    'domain': 'escc.k5ca.com', 'en_al': '1',
    'user-agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile',
    'origin': 'https://escc.k5ca.com', 'referer': 'https://escc.k5ca.com/',
  };
  if (post) h['Content-Type'] = 'application/x-www-form-urlencoded';
  return h;
}
async function req(path, query, body) {
  const opt = { method: body ? 'POST' : 'GET', headers: headers(!!body), signal: AbortSignal.timeout(20000) };
  if (body) opt.body = body;
  const r = await fetch(`https://albd.h4c5.com/api/${path}${query ? '?' + query : ''}`, opt);
  return { status: r.status, body: dec(await r.text()) };
}
(async () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const fecha = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${Math.floor(d.getUTCMinutes() / 10)}`;

  let r = await req('type/get_list', null, '');
  console.log('=== type/get_list (web) →', r.status);
  console.log(r.body.slice(0, 500));

  r = await req('search/screen', null, 'type_id=2&page=1');
  console.log('\n=== search/screen web type_id=2 →', r.status);
  console.log(r.body.slice(0, 1600));
  let idSerie = null;
  try {
    const j = JSON.parse(r.body);
    const lista = Array.isArray(j.result) ? j.result : (j.result?.list || []);
    if (lista.length) idSerie = lista.find((x) => (x.type_pid || x.type_id) === 2)?.id || lista[0].id;
  } catch {}
  console.log('\n[id serie web]', idSerie);

  r = await req('vod/info_web_get', 'vod_id=1997114400&audio_type=es&date=' + fecha);
  console.log('\n=== info_web_get PELÍCULA Coyote →', r.status);
  console.log(r.body.slice(0, 2000));

  if (idSerie) {
    r = await req('vod/info_web_get', `vod_id=${idSerie}&audio_type=es&date=${fecha}`);
    console.log('\n=== info_web_get SERIE web-id', idSerie, '→', r.status);
    console.log(r.body.slice(0, 2500));
  }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
