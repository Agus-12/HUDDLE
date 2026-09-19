#!/usr/bin/env python3
"""Caza la llave Wangsu (16 bytes) probando TODAS las ventanas del tráfico capturado.

Soporta los formatos que exporta PCAPdroid: PCAP clásico con enlace **Ethernet (1)**
y, sobre todo, **IP cruda (101)** — que es el que usa PCAPdroid y el que hizo que la
primera versión de este cazador no viera ni un paquete.

Fases (de barato a caro):
  1) paquetes UDP del rastreador P2P (47.253.51.203), ventanas de 16 bytes;
  2) todo el UDP;
  3) barrido exhaustivo de TODO el archivo (cubre TCP, TLS, cualquier protocolo).
Solo canta victoria si la MISMA ventana reproduce TODAS las ternas firmadas reales
sacadas de la propia captura. Nunca subas la captura ni la llave a GitHub.
Uso:  python3 scripts/cazar-llave-bytes.py /ruta/captura.pcap [salida.txt]
"""
import hashlib
import ipaddress
import re
import struct
import sys

RE_WS = re.compile(rb'wsSecret=([0-9a-fA-F]{32})')
RE_T = re.compile(rb'wsTime=([0-9a-fA-F]{1,8})')
RE_RUTA = re.compile(rb'(?:GET|POST|HEAD) (?:https?://[^/\s]{3,90})?(/\S{3,300}?)\?')
TRACKER = ipaddress.ip_address('47.253.51.203')

# tipos de enlace que sabemos leer: 1 Ethernet, 101/12/14 IP cruda, 228 IPv4,
# 113/276 Linux "cooked"
LINK_ETH = {1}
LINK_RAW = {101, 12, 14, 228}
LINK_SLL = {113, 276}


def iter_paquetes(ruta):
    """Devuelve (linktype, bytes) de cada paquete. PCAP clásico, ambas endianness."""
    with open(ruta, 'rb') as f:
        cab = f.read(24)
        if len(cab) < 24:
            return
        magic = cab[:4]
        if magic == b'\xd4\xc3\xb2\xa1':
            fin = '<'
        elif magic == b'\xa1\xb2\xc3\xd4':
            fin = '>'
        elif magic == b'\x4d\x3c\xb2\xa1':
            fin = '<'
        elif magic == b'\xa1\xb2\x3c\x4d':
            fin = '>'
        elif magic == b'\x0a\x0d\x0d\x0a':
            print('AVISO: la captura es PCAPNG, no PCAP clásico.')
            print('En PCAPdroid: Ajustes > Volcado PCAP > formato "PCAP" (no pcapng).')
            return
        else:
            print('AVISO: formato de captura desconocido (magic ' + magic.hex() + ')')
            return
        link = struct.unpack(fin + 'I', cab[20:24])[0]
        print('captura: enlace tipo', link, '(1=Ethernet, 101=IP cruda de PCAPdroid)')
        while True:
            h = f.read(16)
            if len(h) < 16:
                return
            _, _, incl, _ = struct.unpack(fin + 'IIII', h)
            datos = f.read(incl)
            if len(datos) < incl:
                return
            yield link, datos


def l3_de(link, datos):
    """Devuelve (src, dst, sport, dport, payload_udp) si es UDP; None si no."""
    ip = None
    # 1) saltar cabecera de enlace
    if link in LINK_ETH:
        if len(datos) < 14 or datos[12:14] != b'\x08\x00':
            return None
        ip = datos[14:]
    elif link in LINK_RAW:
        ip = datos
    elif link in LINK_SLL:
        if len(datos) < 16 or datos[14:16] != b'\x08\x00':
            return None
        ip = datos[16:]
    else:
        # tipo desconocido: olfatear (0x45 = IPv4, IHL 5) al inicio y con 14 de salto
        if len(datos) > 20 and (datos[0] >> 4) == 4:
            ip = datos
        elif len(datos) > 34 and datos[12:14] == b'\x08\x00' and (datos[14] >> 4) == 4:
            ip = datos[14:]
        else:
            return None
    if len(ip) < 20 or (ip[0] >> 4) != 4:
        return None
    ihl = (ip[0] & 0x0f) * 4
    if ip[9] != 17 or len(ip) < ihl + 8:
        return None
    udp = ip[ihl:ihl + 8]
    sport, dport, largo = struct.unpack('>HHH', udp[:6])
    payload = ip[ihl + 8:ihl + 8 + max(0, largo - 8)]
    return (ipaddress.ip_address(ip[12:16]), ipaddress.ip_address(ip[16:20]), sport, dport, payload)


def ternas(ruta):
    """Ternas reales (ruta, wsSecret, wsTime) sacadas de la propia captura."""
    fuera = {}
    for _, buf in iter_paquetes(ruta):
        for m in RE_WS.finditer(buf):
            ws = m.group(1).decode()
            ini = max(0, m.start() - 600)
            ventana = buf[ini:m.end() + 300]
            mt = RE_T.search(ventana)
            if not mt:
                continue
            corte = m.start() - ini
            mr = None
            for cand in RE_RUTA.finditer(ventana):
                if cand.end() <= corte:
                    mr = cand
                else:
                    break
            if not mr:
                continue
            fuera[(mr.group(1).decode('latin1'), ws, mt.group(1).decode().lower())] = True
    return list(fuera.keys())


def guardar(cand, salida):
    try:
        txt = cand.decode('ascii')
        limpio = all(32 <= ord(c) < 127 for c in txt) and len(txt) == 16
    except UnicodeDecodeError:
        limpio = False
    if limpio:
        open(salida, 'w').write(txt + '\n')
        forma = 'texto: ' + txt
    else:
        open(salida, 'w').write('hex:' + cand.hex() + '\n')
        forma = '16 bytes crudos (hex ' + cand.hex() + ')'
    return forma


def main():
    if len(sys.argv) < 2:
        print('uso: python3 scripts/cazar-llave-bytes.py captura.pcap [salida]')
        return 2
    captura = sys.argv[1]
    salida = sys.argv[2] if len(sys.argv) > 2 else '/home/ubuntu/movie-cdn-key.txt'

    T = ternas(captura)[:4]
    print('ternas firmadas reales en la captura:', len(T))
    if not T:
        print('sin llave (la captura no trae peticiones firmadas al CDN)')
        return 3

    r0, ws0, w0 = T[0]
    r0b, w0b = r0.encode(), w0.encode()
    restantes = T[1:]
    probadas = 0

    def vale(cand):
        if hashlib.md5(cand + r0b + w0b).hexdigest() != ws0:
            return False
        for r, ws, w in restantes:
            if hashlib.md5(cand + r.encode() + w.encode()).hexdigest() != ws:
                return False
        return True

    # fase 1: UDP del rastreador primero; después, el resto del UDP
    tracker, otros_udp = [], []
    for _, datos in iter_paquetes(captura):
        pass  # (iter_paquetes ya se consumió arriba para las ternas; se vuelve a abrir)
    for link, datos in iter_paquetes(captura):
        info = l3_de(link, datos)
        if not info:
            continue
        src, dst, sport, dport, payload = info
        if not payload:
            continue
        if src == TRACKER or dst == TRACKER:
            tracker.append(payload)
        elif len(payload) <= 2000:
            otros_udp.append(payload)
    print('paquetes UDP: rastreador', len(tracker), '| otros', len(otros_udp))

    for grupo, nombre in ((tracker, 'rastreador'), (otros_udp, 'resto del UDP')):
        for payload in grupo:
            for i in range(0, len(payload) - 15):
                probadas += 1
                cand = payload[i:i + 16]
                if vale(cand):
                    forma = guardar(cand, salida)
                    print('LLAVE ENCONTRADA Y GUARDADA en', salida)
                    print('   forma:', forma, '| via', nombre)
                    return 0
        print('   agotado', nombre, '— ventanas probadas:', probadas)

    # fase 3: barrido exhaustivo de TODO el archivo (cubre TCP, TLS, lo que sea)
    print('barrido exhaustivo de todo el archivo (puede tardar 1-3 minutos)…')
    previo = b''
    with open(captura, 'rb') as f:
        while True:
            buf = f.read(8 * 1024 * 1024)
            if not buf:
                break
            datos = previo + buf
            tope = len(datos) - 15
            for i in range(0, max(0, tope)):
                probadas += 1
                if probadas % 10000000 == 0:
                    print('   ...', probadas, 'ventanas probadas (sigue)')
                if vale(datos[i:i + 16]):
                    forma = guardar(datos[i:i + 16], salida)
                    print('LLAVE ENCONTRADA Y GUARDADA en', salida)
                    print('   forma:', forma, '| via barrido completo del archivo')
                    return 0
            previo = datos[-(16):]

    print('ventanas probadas en total:', probadas)
    print('sin llave en esta captura')
    return 1


if __name__ == '__main__':
    sys.exit(main())
