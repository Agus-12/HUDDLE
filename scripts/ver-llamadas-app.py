#!/usr/bin/env python3
# v226.1: saca LO QUE LA APP ENVIO Y RECIBIO en una captura ya descifrable.
#  - Junta por conexion y flujo HTTP/2: ruta, cuerpo enviado y cuerpo recibido.
#  - Descifra las respuestas (base64 -> AES-128-CBC con las llaves de la app) y
#    muestra la ESTRUCTURA y los datos utiles (listas, vod_url, totales), sin secretos.
#  - Funciona con tshark 4.2 y 4.4 (usa solo campos que existen en ambos).
# Uso:
#   python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap
#   python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap --paths=info_new,screen,channel
import sys, os, re, json, base64, subprocess, shutil, gzip, zlib, binascii

KEY = b'0123456789123456'
IV = b'2015030120123456'
CAMPOS = ['frame.number', 'tcp.stream', 'ip.src', 'http2.streamid',
          'http2.headers.method', 'http2.headers.path', 'http2.headers.status',
          'http2.headers.authority', 'http2.data.data']
INTERESANTES = ('vod_url', 'down_url', 'm3u8', 'count', 'total', 'page', 'cursor', 'has_more',
                'is_more', 'next', 'list', 'vod_name', 'vod_id', 'type', 'duration', 'audio')


def tapar(t):
    if isinstance(t, bytes):
        t = t.decode('latin1', 'replace')
    t = re.sub(r'([0-9a-fA-F]{24,})', lambda m: m.group(1)[:8] + '...', t)
    t = re.sub(r'(token|sign|password|device_id|secret)=([^&\s]{4})[^&\s]*', r'\1=\2...', t)
    t = re.sub(r'gAAAA[A-Za-z0-9_\-]{10,}', 'gAAAA...', t)
    return t


def campos_validos():
    """Lista de campos que ESTA version de tshark entiende (evita que falle el comando)."""
    try:
        p = subprocess.run(['tshark', '-G', 'fields'], capture_output=True, text=True, timeout=180)
    except Exception:
        return None
    ok = set()
    for linea in p.stdout.splitlines():
        partes = linea.split('\t')
        if len(partes) > 3 and partes[0] == 'F':
            ok.add(partes[2])
    return ok or None


def correr(cap, kl, filtro, campos, extra=None):
    cmd = ['tshark', '-r', cap]
    if kl and os.path.exists(kl):
        cmd += ['-o', f'tls.keylog_file:{kl}']
    if extra:
        cmd += extra
    cmd += ['-Y', filtro, '-T', 'fields']
    for c in campos:
        cmd += ['-e', c]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    except Exception as e:
        print('  (error al leer la captura:', str(e)[:100], ')')
        return []
    if p.returncode != 0 and not p.stdout.strip():
        err = (p.stderr or '').strip().splitlines()
        print('  (tshark fallo:', err[-1][:140] if err else 'sin detalle', ')')
        return []
    filas = []
    for linea in p.stdout.splitlines():
        if linea.strip():
            filas.append(linea.split('\t'))
    return filas


def descifrar_respuesta(crudo):
    """La app manda las respuestas en base64 y AES-128-CBC (a veces con gzip)."""
    intentos = []
    if isinstance(crudo, str):
        txt = crudo.strip()
        intentos.append(txt.encode('latin1', 'replace'))
        limpio = txt.replace(':', '')
        if re.fullmatch(r'[0-9a-fA-F]+', limpio) and len(limpio) % 2 == 0:
            try:
                intentos.append(binascii.unhexlify(limpio))
            except Exception:
                pass
    else:
        intentos.append(crudo)
    for d in list(intentos):
        for fn in (gzip.decompress, zlib.decompress):
            try:
                intentos.append(fn(d))
            except Exception:
                pass
        try:
            b = base64.b64decode(re.sub(rb'[^A-Za-z0-9+/=]', b'', d) + b'===')
            if len(b) >= 16 and len(b) % 16 == 0:
                from Crypto.Cipher import AES
                p = AES.new(KEY, AES.MODE_CBC, IV).decrypt(b)
                if p and 1 <= p[-1] <= 16:
                    p = p[:-p[-1]]
                intentos.append(p)
        except Exception:
            pass
    for d in intentos:
        for dec in ('utf-8', 'latin1'):
            try:
                j = json.loads(d.decode(dec))
                return j
            except Exception:
                pass
    return None


def resumir_json(j, salida, tope=18):
    def recorrer(o, ruta=''):
        if len(salida) >= tope:
            return
        if isinstance(o, dict):
            for k, v in o.items():
                kl = k.lower()
                if isinstance(v, list):
                    if v and isinstance(v[0], dict):
                        salida.append(f"      {ruta}{k}: lista de {len(v)} | campos: {', '.join(list(v[0].keys())[:14])}")
                        for item in v[:3]:
                            for kk in ('vod_url', 'down_url', 'vod_name', 'title', 'duration',
                                       'id', 'vod_id', 'type', 'collection', 'total', 'count'):
                                if kk in item and len(salida) < tope:
                                    salida.append(f"        - {kk}: {tapar(str(item[kk]))[:110]}")
                    else:
                        salida.append(f"      {ruta}{k}: lista de {len(v)} {tapar(str(v[:6]))[:80]}")
                elif isinstance(v, dict):
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
        if a == '--keylog' and i + 1 < len(sys.argv):
            kl = sys.argv[i + 1]
    filtro_paths = None
    for a in sys.argv:
        if a.startswith('--paths='):
            filtro_paths = [p.strip() for p in a.split('=', 1)[1].split(',') if p.strip()]

    if not shutil.which('tshark'):
        print('Falta tshark: sudo apt-get update && sudo apt-get install -y tshark'); return
    print(f"captura: {cap}  |  llaves: {kl}")

    validos = campos_validos()
    campos = [c for c in CAMPOS if validos is None or c in validos] if validos else CAMPOS
    faltan = [c for c in CAMPOS if c not in campos]
    if faltan:
        print(f"(esta version de tshark no tiene: {', '.join(faltan)})")
    filas = correr(cap, kl, 'http2.headers.path or http2.data.data', campos)
    print(f"\n--- frames HTTP/2 con datos: {len(filas)} ---")

    flujos = {}       # (tcp.stream, streamid) -> dict
    for f in filas:
        f += [''] * (len(campos) - len(f))
        valores = dict(zip(campos, f))
        num = valores.get('frame.number', '')
        tcp = valores.get('tcp.stream', '')
        src = valores.get('ip.src', '')
        sid = valores.get('http2.streamid', '0')
        metodo = valores.get('http2.headers.method', '')
        path = valores.get('http2.headers.path', '')
        estado = valores.get('http2.headers.status', '')
        autor = valores.get('http2.headers.authority', '')
        data = valores.get('http2.data.data', '')
        sid = (sid.split(',')[0] or '0').strip()
        d = flujos.setdefault((tcp, sid),
                              {'path': '', 'metodo': '', 'estado': '', 'dir': 'envia',
                               'envia': [], 'recibe': []})
        if metodo:
            d['dir'] = 'envia'; d['metodo'] = metodo
        if path:
            d['path'] = path
        if estado:
            d['dir'] = 'recibe'; d['estado'] = estado
        if data:
            d[d['dir']].append(data)

    print(f"--- llamadas distintas: {len(flujos)} ---")
    mostrados = 0
    for (tcp, sid), d in flujos.items():
        path = d['path']
        if not path:
            continue
        if filtro_paths and not any(p in path for p in filtro_paths):
            continue
        if mostrados >= 40:
            break
        print(f"\n  == {d['metodo']} {tapar(path)[:120]}  (respuesta {d['estado'] or '?'})")
        if d['envia']:
            try:
                txt = binascii.unhexlify(''.join(d['envia']).replace(':', '')).decode('utf-8', 'replace')
                print(f"     ENVIA: {tapar(txt)[:300]}")
            except Exception:
                pass
        if d['recibe']:
            j = descifrar_respuesta(''.join(d['recibe']))
            if j is not None:
                lineas = []
                resumir_json(j, lineas)
                if not lineas:
                    lineas = [f"      {tapar(json.dumps(j, ensure_ascii=False))[:220]}"]
                print("     RECIBE (descifrado):")
                for l in lineas:
                    print(l)
            else:
                print("     RECIBE: (no se pudo descifrar o no es JSON)")
        mostrados += 1

    # HTTP/1.1 (video y demas)
    campos_h1 = [c for c in ['frame.number', 'http.host', 'http.request.method',
                             'http.request.uri', 'http.file_data']
                 if validos is None or c in validos]
    filas = correr(cap, kl, 'http.request or http.response', campos_h1)
    print(f"\n--- cuerpos HTTP/1.1: {len(filas)} frames ---")
    for f in filas[:80]:
        f += [''] * (len(campos_h1) - len(f))
        v = dict(zip(campos_h1, f))
        host = v.get('http.host', ''); metodo = v.get('http.request.method', '')
        uri = v.get('http.request.uri', ''); data = v.get('http.file_data', '')
        if data:
            try:
                txt = binascii.unhexlify(data.replace(':', '')).decode('utf-8', 'replace')
            except Exception:
                continue
            if len(txt) < 3:
                continue
            print(f"   {host} {metodo} {tapar(uri)[:80]}")
            print(f"      {tapar(txt)[:200]}")

    print("\n########## fin ##########")


if __name__ == '__main__':
    main()
