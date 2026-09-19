#!/usr/bin/env python3
"""Caza la llave Wangsu probando TODAS las ventanas de 16 bytes del tráfico UDP.

Si la llave no es texto legible (los 'strings' no la ven), podría viajar como 16
bytes crudos dentro de un mensaje del rastreador P2P (UDP 47.253.51.203) o de la
config del app. Este script parte la captura en peticiones UDP (y las ventanas de
16 bytes de cada una) y prueba cada ventana contra las ternas firmadas reales que
saque de la propia captura.

Solo canta victoria si la MISMA llave reproduce TODAS las ternas.
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


def iter_paquetes(ruta):
    with open(ruta, 'rb') as f:
        cab = f.read(24)
        if len(cab) < 24:
            return
        magic = cab[:4]
        if magic == b'\xd4\xc3\xb2\xa1':
            fin, maj = '<', 2
        elif magic == b'\xa1\xb2\xc3\xd4':
            fin, maj = '>', 2
        elif magic == b'\x4d\x3c\xb2\xa1':
            fin, maj = '<', 2
        elif magic == b'\xa1\xb2\x3c\x4d':
            fin, maj = '>', 2
        else:
            print('No es un PCAP clásico (¿pcapng?). Este cazador necesita .pcap')
            return
        while True:
            h = f.read(16)
            if len(h) < 16:
                return
            _, _, incl, _ = struct.unpack(fin + 'IIII', h)
            datos = f.read(incl)
            if len(datos) < incl:
                return
            yield datos


def udp_payload(eth):
    """Capa 2 (Ethernet) → IPv4 → UDP. Devuelve (src, dst, sport, dport, payload)."""
    if len(eth) < 34:
        return None
    if eth[12:14] != b'\x08\x00':            # solo IPv4 (sin VLAN)
        return None
    ihl = (eth[14] & 0x0f) * 4
    if ihl < 20 or len(eth) < 14 + ihl + 8:
        return None
    if eth[14 + 9] != 17:                    # protocolo UDP
        return None
    ip = eth[14:14 + ihl]
    src = ipaddress.ip_address(ip[12:16])
    dst = ipaddress.ip_address(ip[16:20])
    udp = eth[14 + ihl:14 + ihl + 8]
    sport, dport, largo = struct.unpack('>HHH', udp[:6])
    payload = eth[14 + ihl + 8:14 + ihl + 8 + max(0, largo - 8)]
    return src, dst, sport, dport, payload


def ternas(ruta):
    """Ternas reales (ruta, wsSecret, wsTime) sacadas de la propia captura."""
    fuera = {}
    for buf in iter_paquetes(ruta):
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


def main():
    if len(sys.argv) < 2:
        print('uso: python3 scripts/cazar-llave-bytes.py captura.pcap [salida]')
        return 2
    captura = sys.argv[1]
    salida = sys.argv[2] if len(sys.argv) > 2 else '/home/ubuntu/movie-cdn-key.txt'

    T = ternas(captura)[:4]
    print('ternas firmadas reales en la captura:', len(T))
    if not T:
        print('sin llave (la captura no trae peticiones firmadas)')
        return 3

    # 1) paquetes del rastreador primero; después, todo el UDP pequeño
    tracker, resto = [], []
    for eth in iter_paquetes(captura):
        info = udp_payload(eth)
        if not info:
            continue
        src, dst, sport, dport, payload = info
        if not payload:
            continue
        if src == TRACKER or dst == TRACKER:
            tracker.append(payload)
        elif len(payload) <= 1400:
            resto.append(payload)
    print('paquetes UDP del rastreador:', len(tracker), '| UDP pequeño (resto):', len(resto))

    from hashlib import md5 as _md5
    r0, ws0, w0 = T[0]
    r0b, w0b = r0.encode(), w0.encode()
    resto = T[1:]
    probadas = 0
    for grupo, nombre in ((tracker, 'rastreador'), (resto, 'resto del UDP')):
        for payload in grupo:
            n = len(payload) - 15
            for i in range(0, max(0, n)):
                cand = payload[i:i + 16]
                probadas += 1
                if probadas % 5000000 == 0:
                    print('   ...', probadas, 'ventanas probadas (sigue)')
                # filtro rápido con la primera terna; solo si pasa se comprueban las demás
                if _md5(cand + r0b + w0b).hexdigest() != ws0:
                    continue
                if not resto or _reproduce_todas(cand, resto):
                    try:
                        txt = cand.decode('ascii')
                        limpio = all(32 <= ord(c) < 127 for c in txt)
                    except UnicodeDecodeError:
                        limpio = False
                    if limpio and ' ' not in txt:
                        open(salida, 'w').write(txt + '\n')
                        forma = 'texto: ' + txt
                    else:
                        open(salida, 'w').write('hex:' + cand.hex() + '\n')
                        forma = '16 bytes crudos (hex ' + cand.hex() + ')'
                    print('LLAVE ENCONTRADA Y GUARDADA en', salida)
                    print('   forma:', forma, '| via', nombre)
                    return 0
        print('   agotado', nombre, '— ventanas probadas:', probadas)
    print('ventanas probadas en total:', probadas)
    print('sin llave en esta captura')
    return 1


def _reproduce_todas(cand, T):
    for ruta, ws, wst in T:
        if hashlib.md5(cand + ruta.encode() + wst.encode()).hexdigest() != ws:
            return False
    return True


if __name__ == '__main__':
    sys.exit(main())
