// Relay server para Mac Mini — sirve CDNs de video desde IP residencial
// Instalar: copiar a ~/relay.js en el Mac Mini
// Ejecutar: node ~/relay.js
// Configurar: curl 'http://ORACLE:3000/api/set-relay?url=http://TAILSCALE_IP:3128'

const http = require('http');
const https = require('https');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('u');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('OK'); }
  if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('Missing ?u='); }
  
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;
  
  // Auto-detectar Referer según el CDN
  try {
    const h = new URL(target).hostname;
    if (/goodstream/i.test(h)) headers.Referer = 'https://goodstream.one/';
    else if (/vimeos/i.test(h)) headers.Referer = 'https://vimeos.net/';
    else if (/hlswish/i.test(h)) headers.Referer = 'https://hlswish.com/';
    else if (/videoapp/i.test(h)) headers.Referer = 'https://videoapp.zip/';
  } catch {}
  
  const mod = target.startsWith('https') ? https : http;
  const proxyReq = mod.get(target, { headers, timeout: 20000 }, (upstream) => {
    const h = { 
      'Content-Type': upstream.headers['content-type'] || 'application/octet-stream', 
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    for (const k of ['content-range', 'content-length']) if (upstream.headers[k]) h[k] = upstream.headers[k];
    res.writeHead(upstream.statusCode, h);
    upstream.pipe(res);
  });
  proxyReq.on('error', e => { if (!res.headersSent) { res.writeHead(502); res.end(e.message); } });
  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('timeout'); } });
});

// Escuchar en 0.0.0.0 para que Tailscale pueda llegar
server.listen(3128, '0.0.0.0', () => console.log('Relay en puerto 3128 (0.0.0.0)'));