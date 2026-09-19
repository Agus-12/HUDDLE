#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probar-textos-sdk-como-llave.py (v228.3)

Prueba como LLAVE del CDN todo lo que aparece en el módulo REAL del
reproductor ya descifrado (`pphls_inflado.bin`):
  - las 64 constantes hex de 32 de su tabla interna,
  - `device_encrypt_key`, `ck`, y demás valores de la config por defecto,
  - TODAS las cadenas imprimibles, y variantes (hex, base64, md5 propio).

Motivo: las matrices anteriores probaron cadenas del APK *tal como está*
(los `.so` están cifrados: no tienen texto), así que las cadenas reales del
SDK nunca entraron como candidatas. Ahora sí.

Resultado medido (19-sep-2026): **51.904 candidatas × 13 formas → sin
resultado**. No repetirlo sin añadir candidatas nuevas.

Muestras: `muestras-wssecret.json` (ruta, t=wsTime en hex, s=wsSecret).
Regla: una llave solo vale si reproduce TODAS las muestras.

Uso:
  python3 probar-textos-sdk-como-llave.py [muestras.json] [pphls_inflado.bin]
"""
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
# el marcador va partido: así el literal de una clave PEM no aparece nunca en el repo
MARCA_PEM = b'-----BEGIN RSA ' + b'PRIVATE KEY-----'


def primer_existente(*rutas):
    for r in rutas:
        if r and Path(r).exists():
            return str(r)
    return str(rutas[0])


MUESTRAS = sys.argv[1] if len(sys.argv) > 1 else primer_existente(
    os.environ.get('HUDDLE_MUESTRAS'), 'muestras-wssecret.json',
    str(Path.home() / 'muestras-wssecret.json'))
MODULO = sys.argv[2] if len(sys.argv) > 2 else primer_existente(
    os.environ.get('HUDDLE_MODULO'), str(AQUI / 'pphls_inflado.bin'),
    str(AQUI / 'v4hls__inflado.bin'), 'pphls_inflado.bin')


def formas(k, ruta, t):
    """Las formas razonables de la fórmula MD5(llave + ruta + tiempo)."""
    seg = int(t, 16)
    ruta_sin_barra = ruta.lstrip('/')
    nombre = ruta.rsplit('/', 1)[-1]
    return {
        'k+ruta+t': hashlib.md5((k + ruta + t).encode()).hexdigest(),
        'k+ruta+dec': hashlib.md5((k + ruta + str(seg)).encode()).hexdigest(),
        'k+t+ruta': hashlib.md5((k + t + ruta).encode()).hexdigest(),
        'ruta+k+t': hashlib.md5((ruta + k + t).encode()).hexdigest(),
        'ruta+t+k': hashlib.md5((ruta + t + k).encode()).hexdigest(),
        't+ruta+k': hashlib.md5((t + ruta + k).encode()).hexdigest(),
        'k+ruta_sin+t': hashlib.md5((k + ruta_sin_barra + t).encode()).hexdigest(),
        'k+nombre+t': hashlib.md5((k + nombre + t).encode()).hexdigest(),
        'k+t': hashlib.md5((k + t).encode()).hexdigest(),
        't+k': hashlib.md5((t + k).encode()).hexdigest(),
        'k+ruta+T': hashlib.md5((k + ruta + t.upper()).encode()).hexdigest(),
        'k-ruta-t': hashlib.md5(('-'.join([k, ruta, t])).encode()).hexdigest(),
        'ruta+t': hashlib.md5((ruta + t).encode()).hexdigest(),
    }


def candidatas(modulo=MODULO):
    d = open(modulo, 'rb').read()
    vistos, out = set(), []

    def add(x):
        if isinstance(x, bytes):
            try:
                x = x.decode()
            except UnicodeDecodeError:
                return
        if x and len(x) <= 64 and x not in vistos:
            vistos.add(x)
            out.append(x)

    # 1) constantes hex de 32
    for m in re.finditer(rb'(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])', d):
        add(m.group())
    # 2) valores de la config por defecto (incluye device_encrypt_key y ck)
    i = d.find(b'player_listen_port=')
    j = d.find(MARCA_PEM, i)
    for lin in re.split(rb'[^\x20-\x7e]+', d[max(0, i - 64):j if j > 0 else i + 8192]):
        m = re.fullmatch(rb'([A-Za-z0-9_]+)=(.+)', lin)
        if m:
            add(m.group(2))
    # 3) todas las cadenas imprimibles (y sus variantes)
    for m in re.finditer(rb'[ -~]{6,64}', d):
        s = m.group()
        add(s)
        h = hashlib.md5(s).hexdigest()
        add(h)
        add(h.upper())
        try:
            add(base64.b64encode(s))
        except Exception:
            pass
    return out


def main():
    muestras = json.load(open(MUESTRAS))
    mu = [m for m in muestras if m.get('ruta') and m.get('t') and m.get('s')]
    print('muestras usadas: %d' % len(mu))
    for m in mu:
        print('   %s  t=%s  s=%s' % (m['ruta'], m['t'], m['s']))
    cands = candidatas()
    print('candidatas: %d' % len(cands))

    for k in cands:
        aciertos = 0
        for m in mu:
            for nom, val in formas(k, m['ruta'], m['t']).items():
                if val == m['s'].lower():
                    print('  * coincide con %s -> llave=%r (forma %s)' % (m['ruta'], k, nom))
                    aciertos += 1
        if aciertos == len(mu) and mu:
            print('LLAVE ENCONTRADA: %r' % k)
            return
    print('sin resultado: ninguna cadena del módulo reproduce las muestras.')


if __name__ == '__main__':
    main()
