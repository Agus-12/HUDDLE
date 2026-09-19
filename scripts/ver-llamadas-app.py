#!/usr/bin/env python3
# v226: saca LO QUE LA APP ENVIO Y RECIBIO en una captura ya descifrable.
# - peticiones HTTP/2: imprime la ruta y el cuerpo enviado (formulario)
# - respuestas: intenta descifrar (base64 -> AES-128-CBC, llaves conocidas de la app)
#   y muestra la ESTRUCTURA y los datos utiles (sin secretos)
# Uso:
#   python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap
#   python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap --paths info_new,screen,channel
import sys, os, re, json, base64, subprocess, shutil, gzip, zlib, binascii

KEY = b'0123456789123456'
IV = b'2015030120123456'
CAMPOS = ['frame.number', 'tcp.stream', 'http2.headers.method', 'http2.headers.path',
          'http2.data.data', 'http2.body.reassembled.data', 'http.headers', 'http.file_data',
          'http.request.uri', 'tcp.dstport']
INTERESANTES = ('vod_url', 'down_url', 'm3u8', 'count', 'total', 'size', 'page', 'cursor',
                'has_more', 'is_more', 'next', 'list', 'vod_name', 'vod_id', 'type', 'duration')


def tapar(t):
    if isinstance(t, bytes):
        t = t.decode('latin1', 'replace')
    t = re.sub(r'([0-9a-fA-F]{32,})', lambda m: m.group(1)[:8] + '...', t)
    t = re.sub(r'(token|sign|password|device_id|secret)=([^&\s]{4})[^&\s]*', r'\1=\2...', t)
    t = re.sub(r'gAAAA[A-Za-z0-9_\-]{10,}', 'gAAAA...', t)
    return t


def correr(cap, kl, filtro, campos):
    cmd = ['tshark', '-r', cap]
    if kl and os.path.exists(kl):
        cmd += ['-o', f'tls.keylog_file:{kl}']
    cmd += ['-Y', filtro, '-T', 'fields']
    for c in campos:
        cmd += ['-e', c]
    try:
        salida = subprocess.run(cmd, capture_output=True, text=True, timeout=1800).stdout
    except Exception as e:
        print('  (error al leer la captura:', str(e)[:80], ')')
        return []
    filas = []
    for linea in salida.splitlines():
        if linea.strip():
            filas.append(linea.split('\t'))
    return filas


def descifrar_respuesta(crudo):
    """La app manda las respuestas en base64 y AES-128-CBC."""
    intentos = []
    datos = crudo
    if isinstance(datos, str):
        txt = datos.strip()
        # primero tal cual (puede ser base64) y despues el hex decodificado
        intentos.append(txt.encode('latin1', 'replace'))
        limpio = txt.replace(':', '')
        if re.fullmatch(r'[0-9a-fA-F]+', limpio) and len(limpio) % 2 == 0:
            try:
                intentos.append(binascii.unhexlify(limpio))
            except Exception:
                pass
        datos = intentos[-1]
    else:
        intentos.append(datos)
    for d in list(intentos):
        # gzip / deflate
        for fn in (gzip.decompress, zlib.decompress):
            try:
                intentos.append(fn(d))
            except Exception:
                pass
        # base64 -> AES
        try:
            b = base64.b64decode(re.sub(rb'[^A-Za-z0-9+/=]', b'', d) + b'===')
            if len(b) % 16 == 0 and len(b) >= 16:
                from Crypto.Cipher import AES
                p = AES.new(KEY, AES.MODE_CBC, IV).decrypt(b)
                if p and 1 <= p[-1] <= 16:
                    p = p[:-p[-1]]
                intentos.append(p)
        except Exception:
            pass
    for d in intentos:
        try:
            t = d.decode('utf-8')
            j = json.loads(t)
            return j
        except Exception:
            continue
    return None


def resumir_json(j, salida):
    """Muestra la estructura y los datos utiles de una respuesta."""
    def recorrer(o, ruta=''):
        if isinstance(o, dict):
            for k, v in o.items():
                kl = k.lower()
                if isinstance(v, (dict, list)):
                    if isinstance(v, list):
                        salida.append(f"      {ruta}{k}: lista de {len(v)}")
                        if v and isinstance(v[0], dict):
                            salida.append(f"        campos: {', '.join(list(v[0].keys())[:14])}")
                            for item in v[:3]:
                                for kk in ('vod_url', 'down_url', 'vod_name', 'title', 'duration',
                                           'id', 'vod_id', 'type', 'collection'):
                                    if kk in item:
                                        salida.append(f"        - {kk}: {tapar(str(item[kk]))[:110]}")
                    else:
                        recorrer(v, ruta + k + '.')
                elif any(x in kl for x in INTERESANTES) and not any(
                        x in kl for x in ('token', 'sign', 'secret', 'password')):
                    salida.append(f"      {ruta}{k}: {tapar(str(v))[:120]}")
        elif isinstance(o, list):
            salida.append(f"      {ruta}: lista de {len(o)}")
    recorrer(j)


def main():
    if len(sys.argv) < 2:
        print(__doc__); return
    cap = sys.argv[1]
    kl = os.path.expanduser('~/sslkeylogfile.txt')
    for i, a in enumerate(sys.argv):
        if a == '--keylog' and i + 1 < len(sys.argv): kl = sys.argv[i + 1]
    filtro_paths = None
    for a in sys.argv:
        if a.startswith('--paths='):
            filtro_paths = [p.strip() for p in a.split('=', 1)[1].split(',') if p.strip()]

    if not shutil.which('tshark'):
        print('Falta tshark: sudo apt-get install -y tshark'); return
    print(f"captura: {cap}  |  llaves: {kl}")

    # 1) HTTP/2: peticiones y respuestas
    filas = correr(cap, kl, 'http2', CAMPOS)
    print(f"\n--- frames HTTP/2: {len(filas)} ---")
    ultimo_path = {}
    mostrados = 0
    pedidos = {}
    for f in filas:
        f += [''] * (len(CAMPOS) - len(f))
        num, stream, metodo, path, data, reens, h1, hdata, uri, puerto = f[:10]
        if path:
            ultimo_path[stream] = (metodo or '?', path)
            clave = path.split('?')[0]
            pedidos[clave] = pedidos.get(clave, 0) + 1
        cuerpo_hex = reens or data
        if not cuerpo_hex:
            continue
        ruta_actual = ultimo_path.get(stream, ('?', '?'))[1]
        if filtro_paths and not any(p in ruta_actual for p in filtro_paths):
            continue
        if mostrados >= 60:
            continue
        j = descifrar_respuesta(cuerpo_hex)
        if j is None:
            # puede ser el cuerpo ENVIADO (texto)
            try:
                raw = binascii.unhexlify(cuerpo_hex.replace(':', ''))
                txt = raw.decode('utf-8', 'replace')
                if all(32 <= ord(c) < 127 or c in '=&' for c in txt[:80]) and len(txt) > 3:
                    print(f"\n  >> ENVIA a {ruta_actual}:")
                    print(f"     {tapar(txt)[:400]}")
                    mostrados += 1
            except Exception:
                pass
            continue
        print(f"\n  << RESPONDE {ruta_actual}:")
        lineas = []
        resumir_json(j, lineas)
        for l in lineas[:22]:
            print(l)
        mostrados += 1

    print("\n--- rutas HTTP/2 vistas (cuantas veces) ---")
    for k, v in sorted(pedidos.items(), key=lambda x: -x[1])[:25]:
        print(f"   {v:4d}  {k}")

    # 2) HTTP/1.1: cuerpos enviados (formularios)
    filas = correr(cap, kl, 'http.request or http.response', ['frame.number', 'http.host',
                   'http.request.method', 'http.request.uri', 'http.file_data'])
    print(f"\n--- cuerpos HTTP/1.1: {len(filas)} frames ---")
    for f in filas[:200]:
        f += [''] * (5 - len(f))
        num, host, metodo, uri, data = f[:5]
        if data:
            try:
                raw = binascii.unhexlify(data.replace(':', ''))
                txt = raw.decode('utf-8', 'replace')
            except Exception:
                continue
            if len(txt) < 3 or sum(1 for c in txt[:60] if 32 <= ord(c) < 127) < len(txt[:60]) * 0.9:
                continue
            print(f"   {host} {metodo} {tapar(uri)[:90]}")
            print(f"      {tapar(txt)[:300]}")

    print("\n########## fin ##########")


if __name__ == '__main__':
    main()
