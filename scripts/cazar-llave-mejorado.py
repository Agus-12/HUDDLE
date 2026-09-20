#!/usr/bin/env python3
"""Caza la llave Wangsu — versión ampliada (v228.9).

El extractor original solo probaba llaves de EXACTAMENTE 16 bytes y solo cadenas
legibles sueltas. Este amplía:
  A) llaves DERIVADAS (md5/sha de device_id, ck, secretos API, token…) — INSTANTÁNEO;
  B) varias fórmulas de firma (orden de factores, wsTime hex vs decimal);
  C) respaldo: barrido de ventanas de 16 y 32 bytes (la original solo hacía 16).
Solo canta victoria si la MISMA llave reproduce TODAS las ternas reales.

Uso:  python3 scripts/cazar-llave-mejorado.py /ruta/captura.pcap [salida.txt]
"""
import hashlib, re, sys

RE_WS = re.compile(rb'wsSecret=([0-9a-fA-F]{32})')
RE_T = re.compile(rb'wsTime=([0-9a-fA-F]{1,8})')
RE_RUTA = re.compile(rb'(?:GET|POST|HEAD) (?:https?://[^/\s]{3,90})?(/\S{3,300}?)\?')
RE_LINEA = re.compile(rb'(/vod/[0-9A-Za-z._/\-]{4,300})')

def bloques(ruta, tam=8*1024*1024, solape=8192):
    with open(ruta, 'rb') as f:
        previo = b''
        while True:
            b = f.read(tam)
            if not b: break
            yield previo + b
            previo = b[-solape:]
        if previo: yield previo

def extraer_ternas(ruta):
    T = {}
    for buf in bloques(ruta):
        for m in RE_WS.finditer(buf):
            ws = m.group(1).decode().lower()
            win = buf[max(0, m.start()-400):m.end()+400]
            mt = RE_T.search(win)
            if not mt: continue
            wt = mt.group(1).decode().lower()
            mr = RE_RUTA.search(win) or RE_LINEA.search(win)
            if not mr: continue
            rp = mr.group(1).decode('latin1')
            if rp.endswith(('.m3u8', '.ts')) or '/vod/' in rp:
                T[(rp, wt)] = ws
    return list(T.items())

# fórmulas: (nombre, func(llave_bytes, ruta_str, wsTime_str)->hex)
def formulas():
    F = []
    for tn, tc in [('hex', lambda w: w), ('dec', lambda w: str(int(w, 16)))]:
        F.append((f'md5(k+ruta+t{tn})', lambda k, r, w, c=tc: hashlib.md5(k + r.encode() + c(w).encode()).hexdigest()))
        F.append((f'md5(k+t{tn}+ruta)', lambda k, r, w, c=tc: hashlib.md5(k + c(w).encode() + r.encode()).hexdigest()))
        F.append((f'md5(ruta+k+t{tn})', lambda k, r, w, c=tc: hashlib.md5(r.encode() + k + c(w).encode()).hexdigest()))
    return F

def probar(kb, ternas, FL):
    for fnom, ff in FL:
        if all(ff(kb, r, w) == s for (r, w), s in ternas):
            return fnom
    return None

def guardar(kb, out):
    txt = kb.decode('latin1') if all(32 <= c < 127 for c in kb) else 'hex:' + kb.hex()
    open(out, 'w').write(txt)
    print('*** LLAVE GUARDADA en', out, '***')

def main():
    if len(sys.argv) < 2:
        print('uso: cazar-llave-mejorado.py captura.pcap [salida.txt]'); return 1
    pcap = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else '/home/ubuntu/movie-cdn-key.txt'
    ternas = extraer_ternas(pcap)
    print(f'ternas reales: {len(ternas)}')
    if not ternas:
        print('sin ternas'); return 1
    for (r, w), s in ternas[:8]:
        print(f'   {r}  t={w}  ws={s}')
    FL = formulas()

    # ===== A) llaves derivadas (instantáneo) =====
    DEV, CK = '687564646c653031', '92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7'
    SEC1, SEC2 = 'Zox882LYjEn4Rqpa', '47Q8tBqO4YqrMHf4'
    semillas = {'dev': DEV, 'ck': CK, 'ck16': CK[:16], 'ck32': CK[:32], 'sec1': SEC1,
                'sec2': SEC2, 'app': 'movievn', 'chan': 'movievn_sh_1000', 'ver': '40000',
                'dev+ck': DEV+CK, 'ck+dev': CK+DEV, 'sec1+dev': SEC1+DEV, 'dev+sec1': DEV+SEC1}
    der = {}
    der['dev_bytes'] = bytes.fromhex(DEV)
    der['ck_hexbytes'] = bytes.fromhex(CK)
    for nom, sem in semillas.items():
        der[f'{nom}_utf8'] = sem.encode()
        der[f'md5({nom})hex'] = hashlib.md5(sem.encode()).hexdigest().encode()
        der[f'md5({nom})raw'] = hashlib.md5(sem.encode()).digest()
        der[f'sha256({nom})hex16'] = hashlib.sha256(sem.encode()).hexdigest()[:16].encode()
        der[f'sha256({nom})raw16'] = hashlib.sha256(sem.encode()).digest()[:16]
    print(f'\n== A) derivadas: {len(der)} candidatas ==')
    for nom, kb in der.items():
        f = probar(kb, ternas, FL)
        if f:
            print(f'*** ¡LLAVE DERIVADA! {nom} = {kb!r} fórmula {f} ***')
            guardar(kb, out); return 0
    print('   ninguna derivada funcionó')

    # ===== B) barrido 16 y 32 bytes, fórmula primaria, solo ventanas razonables =====
    print('\n== B) barrido ventanas 16/32 bytes (fórmula primaria) ==')
    prim = FL[0][1]  # md5(k+ruta+thex)
    Tb = [((r, w), s) for (r, w), s in ternas]
    probadas = 0
    for buf in bloques(pcap, tam=4*1024*1024, solape=96):
        n = len(buf)
        for L in (16, 32):
            for i in range(0, n - L + 1):
                kb = buf[i:i+L]
                probadas += 1
                # filtro: primer byte imprimible (llave tipo contraseña) o todo-hex
                if not (32 <= kb[0] < 127):
                    continue
                if all(prim(kb, r, w) == s for (r, w), s in Tb):
                    print(f'*** ¡LLAVE! {L} bytes: {kb!r} ***')
                    guardar(kb, out); return 0
        if probadas % 20000000 < len(buf)*2:
            print(f'   ... {probadas} ventanas (sigue)')
    print(f'   ventanas probadas: {probadas}')
    print('\n== sin llave ==')
    return 1

if __name__ == '__main__':
    sys.exit(main())
