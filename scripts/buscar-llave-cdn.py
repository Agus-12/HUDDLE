#!/usr/bin/env python3
"""Caza la llave Wangsu (16 caracteres) que firma el CDN Movie.

Idea (verificado en el PCAP del 19-sep): el CDN firma cada petición con
    wsSecret = md5( llave + ruta + wsTime )     wsTime = segundo unix en HEX
La llave NO viaja en las peticiones firmadas, pero SÍ va a viajar en el resto
del tráfico del teléfono (config del tracker/p2p, mensajes de la lib nativa).
Por eso este script:

  1) saca de la MISMA captura todas las ternas reales (ruta, wsSecret, wsTime)
     — así no depende de ternas transcritas a mano;
  2) junta candidatos (cadenas imprimibles, sobre todo de 16 caracteres);
  3) prueba cada candidato contra TODAS las ternas; solo canta victoria si
     reproduce todas (una coincidencia suelta sería casualidad).

No usa tshark ni dependencias: lee el archivo por bloques (pcap o pcapng).
Uso:  python3 scripts/buscar-llave-cdn.py /ruta/captura.pcap [salida.txt]
Nunca subas la captura ni la llave a GitHub: la llave se queda SOLO en Oracle.
"""
import hashlib
import re
import sys

RE_WS = re.compile(rb'wsSecret=([0-9a-fA-F]{32})')
RE_T = re.compile(rb'wsTime=([0-9a-fA-F]{1,8})')
RE_RUTA = re.compile(rb'(?:GET|POST|HEAD) (?:https?://[^/\s]{3,90})?(/\S{3,300}?)\?')
RE_LINEA = re.compile(rb'(/vod/[0-9A-Za-z._/\-]{4,300})')
RE_RESOURCE = re.compile(rb'resource_md5_prefix[=:\s"\']{1,3}([^\s"\'\x00-\x1f]{3,64})')
RE_PRINT = re.compile(rb'[A-Za-z0-9_\-]{8,40}')


def bloques(ruta, tam=8 * 1024 * 1024, solape=8192):
    with open(ruta, 'rb') as f:
        previo = b''
        while True:
            b = f.read(tam)
            if not b:
                break
            yield previo + b
            previo = b[-solape:]
        if previo:
            yield previo


def ternas(ruta):
    """Devuelve [(ruta, wsSecret, wsTime)] únicas, sacadas del propio archivo."""
    fuera = {}
    for buf in bloques(ruta):
        for m in RE_WS.finditer(buf):
            ws = m.group(1).decode()
            ini = max(0, m.start() - 600)
            ventana = buf[ini:m.end() + 300]
            mt = RE_T.search(ventana)
            if not mt:
                continue
            wst = mt.group(1).decode().lower()
            # la ruta es la de ESTA petición: la más cercana por delante del wsSecret
            corte = m.start() - ini
            mr = None
            for cand in RE_RUTA.finditer(ventana):
                if cand.end() <= corte:
                    mr = cand
                else:
                    break
            if not mr:
                mr = RE_RUTA.search(ventana) or RE_LINEA.search(ventana)
            if not mr:
                continue
            r = mr.group(1).decode('latin1')
            if not r.startswith('/'):
                r = '/' + r
            fuera[(r, ws, wst)] = True
    return list(fuera.keys())


def candidatos(ruta, tope=900000, minimo=8):
    """Cadenas imprimibles del archivo (sobre todo de 16 caracteres = llave Wangsu)."""
    vistos = set()
    for buf in bloques(ruta):
        for m in RE_PRINT.finditer(buf):
            vistos.add(m.group(0).decode('latin1'))
            if len(vistos) >= tope:
                return vistos
        for m in RE_RESOURCE.finditer(buf):
            vistos.add(m.group(1).decode('latin1'))
    return vistos


def reproduce(llave, ruta, ws, wst):
    """¿md5(llave + ruta + wsTime) == wsSecret?  (con las variantes del firmador)"""
    variantes = [ruta, ruta[1:]]
    tiempos = [wst]
    try:
        tiempos.append(str(int(wst, 16)))
    except ValueError:
        pass
    for rr in variantes:
        for tt in tiempos:
            if hashlib.md5((llave + rr + tt).encode()).hexdigest() == ws:
                return True
    return False


def main():
    if len(sys.argv) < 2:
        print('uso: python3 scripts/buscar-llave-cdn.py captura.pcap [salida]')
        return 2
    captura = sys.argv[1]
    salida = sys.argv[2] if len(sys.argv) > 2 else '/home/ubuntu/movie-cdn-key.txt'

    T = ternas(captura)
    print('ternas reales (ruta + wsSecret + wsTime) encontradas en la captura:', len(T))
    for r, ws, wst in T[:6]:
        print('   ', r[:70], '->', ws[:12] + '…', 'wsTime=' + wst)
    if not T:
        print('sin ternas: en esta captura el teléfono no pidió nada firmado al CDN')
        print('(no se puede sacar la llave de aquí; hace falta una captura reproduciendo video)')
        print('sin llave')
        return 3

    # se prueban máximo 5 ternas (las distintas) para que sea rápido
    T = T[:5]
    C = candidatos(captura)
    print('candidatos a llave:', len(C))

    orden = sorted(C, key=lambda c: (len(c) != 16, len(c)))
    mejor, mejor_n = None, 0
    for c in orden:
        n = sum(1 for (r, ws, wst) in T if reproduce(c, r, ws, wst))
        if n > mejor_n:
            mejor, mejor_n = c, n
            if n == len(T):
                break
    if mejor_n == len(T):
        with open(salida, 'w') as f:
            f.write(mejor + '\n')
        print('LLAVE ENCONTRADA Y GUARDADA en', salida)
        print('   llave:', mejor)
        return 0
    if mejor_n:
        print('parcial:', repr(mejor), 'reproduce', mejor_n, 'de', len(T), 'ternas (no sirve)')
    print('sin llave en esta captura')
    return 1


if __name__ == '__main__':
    sys.exit(main())
