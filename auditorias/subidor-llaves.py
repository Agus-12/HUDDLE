#!/usr/bin/env python3
"""Subidor de una sola vez: pagina web minima en el puerto 47823 para que el usuario
suba desde su navegador (su Mac) el archivo sslkeylogfile.txt sin usar scp.
Guarda lo recibido en ~/sslkeylogfile.txt. Sin clave a proposito: es de un solo uso,
el contenido (llaves de sesiones TLS ya terminadas) no permite nada por si solo, y lo
unico que puede pasar es que un bot suba basura, lo cual se nota al instante."""
import http.server
import socketserver
import os

HOME = os.path.expanduser('~')
DEST = os.path.join(HOME, 'sslkeylogfile.txt')

PAGE = b'''<html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;text-align:center;margin-top:60px">
<h2>Subir el archivo de llaves</h2>
<p>Elige el archivo <b>sslkeylogfile.txt</b> que descargaste y toca Subir.</p>
<input type="file" id="f"><br><br>
<button onclick="subir()" style="font-size:18px;padding:8px 24px">Subir</button>
<div id="r" style="margin-top:16px;font-weight:bold"></div>
<script>
async function subir(){
  const f = document.getElementById('f').files[0];
  if(!f){ document.getElementById('r').innerText = 'Elige el archivo primero'; return; }
  document.getElementById('r').innerText = 'Subiendo...';
  const r = await fetch('/subir', {method:'POST', body:f});
  document.getElementById('r').innerText = await r.text();
}
</script></body></html>'''


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(PAGE)

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        with open(DEST, 'wb') as fh:
            fh.write(data)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(('Listo: %d bytes guardados.' % len(data)).encode())

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(('0.0.0.0', 47823), H)
    srv.daemon_threads = True
    print('subidor listo en 0.0.0.0:47823, guarda en %s' % DEST)
    srv.serve_forever()
