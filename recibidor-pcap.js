// Recibidor de PCAP para PCAPdroid (modo "Servidor HTTP" del volcado PCAP)
// Corre en el Oracle:  nohup node recibidor-pcap.js > ~/recibidor.log 2>&1 &
// En el teléfono:      PCAPdroid → ⋮/☰ Ajustes → "Volcado PCAP" → "Servidor HTTP"
//                      → URL: http://129.80.212.92:8080
// Todo lo que el teléfono capture se va guardando en ~/captura-movie.pcap
const http = require('http');
const fs = require('fs');
const ARCHIVO = process.env.PCAP_OUT || '/home/ubuntu/captura-movie.pcap';
let total = 0, peticiones = 0;
http.createServer((req, res) => {
  peticiones++;
  const chunks = [];
  req.on('data', c => { chunks.push(c); total += c.length; });
  req.on('end', () => {
    fs.appendFileSync(ARCHIVO, Buffer.concat(chunks));
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} — ${chunks.reduce((a, c) => a + c.length, 0)} bytes (total ${total})`);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
  });
}).listen(8080, '0.0.0.0', () => console.log('Recibidor PCAP escuchando en 0.0.0.0:8080 → ' + ARCHIVO));
