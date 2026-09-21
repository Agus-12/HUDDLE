// Relay server para Mac Mini — sirve CDNs de video desde IP residencial
// v2: sigue redirects, mejor manejo de errores
// Instalar: copiar a ~/relay.js en el Mac Mini
// Ejecutar: node ~/relay.js
// Configurar: curl 'http://ORACLE:3000/api/set-relay?url=http://TAILSCALE_IP:3128'

const http = require('http');
const https = require('https');

function proxyRequest(target, reqHeaders, res, maxRedirects) {
  if (maxRedirects <= 0) { res.writeHead(502); return res.end('too many redirects'); }
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
  };
  if (reqHeaders.range) headers.Range = reqHeaders.range;
  
  // Auto-detectar Referer según el CDN
  try {
    const h = new URL(target).hostname;
    if (/goodstream/i.test(h)) headers.Referer = 'https://goodstream.one/';
    else if (/vimeos/i.test(h)) headers.Referer = 'https://vimeos.net/';
    else if (/hlswish/i.test(h)) headers.Referer = 'https://hlswish.com/';
    else if (/videoapp/i.test(h)) headers.Referer = 'https://videoapp.zip/';
    else if (/latanime/i.test(h)) headers.Referer = 'https://latanime.org/';
    else if (/uqload/i.test(h)) headers.Referer = 'https://latanime.org/';
    else if (/doodstream/i.test(h)) headers.Referer = 'https://latanime.org/';
    else if (/filemoon/i.test(h)) headers.Referer = 'https://latanime.org/';
    else if (/fembed/i.test(h)) headers.Referer = 'https://latanime.org/';
    else if (/voe/i.test(h)) headers.Referer = 'https://latanime.org/';
  } catch {}
  
  const mod = target.startsWith('https') ? https : http;
  const opts = {
    headers,
    timeout: 25000,
    rejectUnauthorized: false, // ignorar errores SSL (fembed, etc.)
  };
  
  const proxyReq = mod.get(target, opts, (upstream) => {
    // Seguir redirects (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      let newUrl = upstream.headers.location;
      if (newUrl.startsWith('/')) {
        const u = new URL(target);
        newUrl = u.origin + newUrl;
      }
      return proxyRequest(newUrl, reqHeaders, res, maxRedirects - 1);
    }
    
    const h = {
      'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    for (const k of ['content-range', 'content-length']) if (upstream.headers[k]) h[k] = upstream.headers[k];
    res.writeHead(upstream.statusCode, h);
    upstream.pipe(res);
  });
  
  proxyReq.on('error', e => {
    if (!res.headersSent) { res.writeHead(502); res.end(e.message); }
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) { res.writeHead(504); res.end('timeout'); }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('u');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('OK'); }
  if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('Missing ?u='); }
  
  proxyRequest(target, req.headers, res, 5); // max5 redirects
});

// Escuchar en 0.0.0.0 para que Tailscale/ngrok pueda llegar
server.listen(3128, '0.0.0.0', () => console.log('Relay v2 en puerto 3128 (0.0.0.0)'));
