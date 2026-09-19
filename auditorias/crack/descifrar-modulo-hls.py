#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
descifrar-modulo-hls.py (v228.3) — DE CERO A TEXTOS DEL SDK EN UN COMANDO.

Qué hace (cadena completa, comprobada):
  1. Toma `libpp_hls.so` del APK (sección `.mips`, cifrada).
  2. La descifra con la RC4 no estándar de jiagu (`rc4_sbox_1.bin`, PRGA +2/+1).
  3. Descomprime el zlib → el **módulo real del reproductor** (~3,39 MB).
  4. Vuelca sus textos (`<salida>-textos.txt`) y señala los hallazgos:
     la config por defecto `[BASE]`/`[P2P]`, la tabla de 64 hashes, la lista
     de nombres de API, las plantillas de firma y (si está) la clave RSA.

Por qué importa: los `.so` del APK no tienen texto legible (todo lo que
importa vive cifrado en `.mips`). Sin este paso, buscar la llave del CDN con
`strings` sobre el APK es buscar en el sitio equivocado.

OJO (v229): el módulo resultante **no es código ARM64** — es el programa/datos
de la VM del SDK. Para la firma hay que instrumentar el intérprete del `.text`.

Uso:
  python3 descifrar-modulo-hls.py [libpp_hls.so] [salida_prefix]
        por defecto: ../apk/lib/arm64-v8a/libpp_hls.so  y  pphls
"""
import re
import struct
import sys
import zlib
from pathlib import Path

from elftools.elf.elffile import ELFFile

AQUI = Path(__file__).resolve().parent
# el marcador va partido: así el literal de una clave PEM no aparece nunca en el repo
MARCA_PEM = b'-----BEGIN RSA ' + b'PRIVATE KEY-----'
PEM_INI = MARCA_PEM
PEM_FIN = b'-----END RSA PRIVATE KEY-----'


def main():
    so = sys.argv[1] if len(sys.argv) > 1 else str(AQUI / '../apk/lib/arm64-v8a/libpp_hls.so')
    pref = sys.argv[2] if len(sys.argv) > 2 else 'pphls'
    sbox = bytearray((AQUI / 'rc4_sbox_1.bin').read_bytes())
    i0, j0 = 3, 5          # estado inicial capturado del emulador (ver rc4_jiagu.py)

    data = open(so, 'rb').read()
    elf = ELFFile(open(so, 'rb'))
    secs = [s for s in elf.iter_sections() if s.name == '.mips']
    if not secs:
        sys.exit('este .so no trae sección .mips (¿es el del APK?)')
    sec = secs[0]
    ct = data[sec['sh_offset']:sec['sh_offset'] + sec['sh_size']]
    assert len(sbox) == 256 and sorted(sbox) == list(range(256)), 'S-box inválido'
    print('.mips: offset %#x  tamaño %d B (cifrado)' % (sec['sh_offset'], len(ct)))

    def prga(b, i, j, n):
        out = bytearray()
        for _ in range(n):
            i = (i + 2) & 0xff
            j = (b[i] + j + 1) & 0xff
            a, c = b[i], b[j]
            b[i], b[j] = c, a
            out.append(b[(a + c) & 0xff])
        return bytes(out)

    pt = bytes(c ^ k for c, k in zip(ct, prga(sbox, i0, j0, len(ct))))
    Path(pref + '_descifrado.bin').write_bytes(pt)
    declarado = struct.unpack('<I', pt[:4])[0]
    out = zlib.decompress(pt[4:])
    if len(out) != declarado:
        sys.exit('zlib dio %d B y el header decía %d — S-box/PRGA no corresponden'
                 % (len(out), declarado))
    Path(pref + '_inflado.bin').write_bytes(out)
    print('módulo real: %d B -> %s_inflado.bin' % (len(out), pref))

    # --- volcado de textos + hallazgos (SIN la clave privada) ---
    txt = sorted({m.group().decode('latin1') for m in re.finditer(rb'[ -~]{4,200}', out)})
    limpio = []
    for t in txt:
        if MARCA_PEM.decode()[5:25] in t:
            limpio.append('[[clave privada RSA del SDK — NO se guarda; está en el binario '
                          'en %#x, 1.670 B]]' % out.find(PEM_INI))
        else:
            limpio.append(t)
    Path(pref + '-textos.txt').write_text('\n'.join(limpio))
    print('textos: %d cadenas -> %s-textos.txt (sin la clave privada)' % (len(limpio), pref))

    def off(pat):
        i = out.find(pat)
        return hex(i) if i >= 0 else 'NO'

    print('\n--- puntos de interés dentro del módulo ---')
    print('  config [BASE]         :', off(b'[BASE]'))
    print('  config [P2P]          :', off(b'[P2P]'))
    print('  plantilla de firma    :', off(b'wsSecret=%s&wsTime=%x'))
    print('  plantilla de URL      :', off(b'%s%s%x'))
    print('  medida de ts (sz=,m8=):', off(b'sz='), off(b'm8='))
    print('  nombre del MD5        :', off(b'sim_md5'))
    rsa = out.find(PEM_INI)
    if rsa >= 0:
        fin = out.find(PEM_FIN, rsa)
        print('  CLAVE RSA privada     : %s (%d B, NO copiar al repo)' % (hex(rsa), fin + 25 - rsa))
    i = out.find(b'player_listen_port=')
    if i >= 0:
        j = out.find(b'-----BEGIN RSA', i)
        bloque = re.sub(rb'[^\x20-\x7e]', b'\n', out[i:j if j > 0 else i + 8192]).decode('latin1')
        nombres = [m.group(1) for m in re.finditer(r'^([A-Za-z0-9_]+)=', bloque, re.M)]
        print('  nombres de config     : %d (probar_conf_nombres.py los prueba en vivo)' % len(nombres))


if __name__ == '__main__':
    main()
