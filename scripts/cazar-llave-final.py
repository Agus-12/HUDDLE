#!/usr/bin/env python3
"""Caza la llave Wangsu — versión final (v229). Cubre los huecos reales que los
extractores anteriores NO probaban:

  * wsTime firmado en DECIMAL (los anteriores solo probaban el hex de la URL);
  * variantes de RUTA (sin '/' inicial, o URL completa con host) — si el 'path'
    firmado no era exactamente el reconstruido, ninguna llave encajaba;
  * llaves de 16 y 32 bytes BINARIAS de verdad (el barrido mejorado solo miraba
    ventanas con primer byte imprimible; el de 16 bytes solo probaba una fórmula).

Fase 0 (rápida): llaves derivadas y tokens legibles, con TODAS las variantes.
Fase 1: barrido binario de 16 bytes  x {3 rutas} x {hex,dec}.
Fase 2: barrido binario de 32 bytes  x {3 rutas} x {hex,dec}.
Solo canta victoria si la MISMA llave reproduce las 7 ternas reales. Early-exit.

Uso:  python3 scripts/cazar-llave-final.py /ruta/captura.pcap [salida.txt]
"""
import hashlib, re, sys

HOST = b'http://movievn.j5t2n.com'
RE_WS = re.compile(rb'wsSecret=([0-9a-fA-F]{32})')
RE_T = re.compile(rb'wsTime=([0-9a-fA-F]{1,8})')
RE_RUTA = re.compile(rb'(?:GET|POST|HEAD) (?:https?://[^/\s]{3,90})?(/\S{3,300}?)\?')
RE_LINEA = re.compile(rb'(/vod/[0-9A-Za-z._/\-]{4,300})')
RE_PRINT = re.compile(rb'[A-Za-z0-9_\-]{6,48}')

def bloques(ruta, tam=8*1024*1024, solape=8192):
    with open(ruta, 'rb') as f:
        prev = b''
        while True:
            b = f.read(tam)
            if not b: break
            yield prev + b
            prev = b[-solape:]
        if prev: yield prev

def extraer_ternas(ruta):
    T = {}
    for buf in bloques(ruta):
        for m in RE_WS.finditer(buf):
            ws = m.group(1).decode().lower()
            win = buf[max(0, m.start()-500):m.end()+300]
            mt = RE_T.search(win)
            if not mt: continue
            wt = mt.group(1).decode().lower()
            mr = RE_RUTA.search(win) or RE_LINEA.search(win)
            if not mr: continue
            p = mr.group(1).decode('latin1')
            if p.endswith(('.m3u8', '.ts')) or '/vod/' in p:
                T[(p, wt)] = ws
    return [(p, ws, wt) for (p, wt), ws in T.items()]

def variantes(path, wt):
    """Genera (ruta_bytes, tiempo_bytes) posibles para firmar."""
    ps = {path.encode('latin1'),
          path.lstrip('/').encode('latin1'),
          HOST + path.encode('latin1')}
    ts = {wt.encode(), str(int(wt, 16)).encode()}
    return [(p, t) for p in ps for t in ts]

def md5(b): return hashlib.md5(b).hexdigest()

def coincide(kb, path, ws, wt):
    for p, t in variantes(path, wt):
        if md5(kb + p + t) == ws:      # orden key + ruta + tiempo
            return True
        if md5(kb + t + p) == ws:      # orden key + tiempo + ruta
            return True
    return False

def vale_todas(kb, ternas):
    return all(coincide(kb, p, ws, wt) for (p, ws, wt) in ternas)

def guardar(kb, out):
    txt = kb.decode('latin1') if all(32 <= c < 127 for c in kb) else 'hex:' + kb.hex()
    open(out, 'w').write(txt)
    print('*** LLAVE GUARDADA en', out, '->', repr(txt), '***')

def fasederivadas_print(ternas, ruta, out):
    DEV, CK = '687564646c653031', '92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7'
    S1, S2 = 'Zox882LYjEn4Rqpa', '47Q8tBqO4YqrMHf4'
    sem = {'dev': DEV, 'ck': CK, 'ck16': CK[:16], 'ck32': CK[:32], 's1': S1, 's2': S2,
           'app': 'movievn', 'chan': 'movievn_sh_1000', 'dev+ck': DEV+CK, 'ck+dev': CK+DEV}
    cand = {'dev_bytes': bytes.fromhex(DEV), 'ck_hexbytes': bytes.fromhex(CK)}
    for n, s in sem.items():
        cand[n] = s.encode()
        cand[f'md5({n})hex'] = hashlib.md5(s.encode()).hexdigest().encode()
        cand[f'md5({n})raw'] = hashlib.md5(s.encode()).digest()
    print(f'Fase 0: derivadas {len(cand)} + tokens legibles')
    for n, kb in cand.items():
        if vale_todas(kb, ternas):
            print(f'*** LLAVE DERIVADA: {n} ***'); guardar(kb, out); return True
    vistos = set()
    for buf in bloques(ruta):
        for m in RE_PRINT.finditer(buf):
            tok = m.group(0)
            if tok in vistos: continue
            vistos.add(tok)
            if vale_todas(tok, ternas):
                print('*** LLAVE LEGIBLE:', tok, '***'); guardar(tok, out); return True
    print(f'   tokens legibles probados: {len(vistos)} (ninguna)')
    return False

def fase_binaria(ternas, ruta, out, L):
    print(f'Fase binaria {L} bytes: {{3 rutas}} x {{hex,dec}} (early-exit, ~min)')
    (p0, ws0, wt0) = ternas[0]
    var0 = variantes(p0, wt0)
    prob = 0
    for buf in bloques(ruta, tam=4*1024*1024, solape=96):
        n = len(buf)
        for i in range(0, n - L + 1):
            kb = buf[i:i+L]
            prob += 1
            hit = False
            for (pp, tt) in var0:
                if md5(kb + pp + tt) == ws0 or md5(kb + tt + pp) == ws0:
                    hit = True; break
            if hit and vale_todas(kb, ternas):
                print(f'*** ¡LLAVE {L} bytes BINARIA! ***'); guardar(kb, out); return True
        if prob % 30000000 < len(buf):
            print(f'   ... {prob} ventanas probadas (sigue)')
    print(f'   ventanas probadas: {prob} (ninguna)')
    return False

def main():
    if len(sys.argv) < 2:
        print('uso: cazar-llave-final.py captura.pcap [salida.txt]'); return 1
    pcap = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else '/home/ubuntu/movie-cdn-key.txt'
    ternas = extraer_ternas(pcap)
    print(f'ternas reales: {len(ternas)}')
    if not ternas:
        print('sin ternas'); return 1
    for p, ws, wt in ternas:
        print(f'   {p}  t={wt}  ws={ws[:12]}...')
    if fasederivadas_print(ternas, pcap, out): return 0
    if fase_binaria(ternas, pcap, out, 16): return 0
    if fase_binaria(ternas, pcap, out, 32): return 0
    print('\n== sin llave tras cubrir wsTime decimal + variantes de ruta + binarias 16/32 ==')
    return 1

if __name__ == '__main__':
    sys.exit(main())
