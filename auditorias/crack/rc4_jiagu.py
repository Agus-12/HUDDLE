#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rc4_jiagu.py — reproduce el cifrado de jiagu y descifra la sección `.mips`.

CÓMO SE VERIFICÓ (no es teoría, está comprobado):
  * El S-box se captura del emulador (`emu_jiagu.py` pone un hook de bloque en
    JBASE+0x64bc y vuelca `rc4_sbox_N.bin` con los 256 bytes de estado).
  * La PRGA es NO estándar (leída de 0x64bc..0x6540):
        i = (i + 2) & 0xff            # ¡+2, no +1!
        j = (S[i] + j + 1) & 0xff     # ¡+1 extra!
        a, b = S[i], S[j]             # valores ANTES del swap
        S[i], S[j] = b, a
        ks = S[(a + b) & 0xff]
    estado: [0x000..0x0ff] = S-box, [0x100] = i, [0x101] = j.
  * Prueba de corrección: el blob descifrado empieza con 4 bytes = tamaño
    descomprimido en little-endian, y `zlib.decompress(blob[4:])` devuelve
    EXACTAMENTE ese número de bytes. Con el S-box capturado:
        header 0x0014fd81 = 1.375.617  y  zlib dio 1.375.617 B  ✔

Uso:
  python3 rc4_jiagu.py                          # jiagu_descifrada.so
  python3 rc4_jiagu.py otra.so rc4_sbox_1.bin prefijo_salida
"""
import sys
import zlib
import struct
from elftools.elf.elffile import ELFFile

SO = sys.argv[1] if len(sys.argv) > 1 else 'jiagu_descifrada.so'
SBOX = sys.argv[2] if len(sys.argv) > 2 else 'rc4_sbox_1.bin'
PREF = sys.argv[3] if len(sys.argv) > 3 else 'mips'
I0, J0 = 3, 5          # leídos del estado en el momento de la llamada


def prga(sbox, i, j, n):
    """Genera n bytes de keystream con la PRGA no estándar de jiagu."""
    out = bytearray()
    i &= 0xff
    j &= 0xff
    for _ in range(n):
        i = (i + 2) & 0xff
        j = (sbox[i] + j + 1) & 0xff
        a = sbox[i]
        b = sbox[j]
        sbox[i], sbox[j] = b, a
        out.append(sbox[(a + b) & 0xff])
    return bytes(out)


def main():
    data = open(SO, 'rb').read()
    elf = ELFFile(open(SO, 'rb'))
    sec = [s for s in elf.iter_sections() if s.name == '.mips']
    if not sec:
        print('sin sección .mips')
        return 1
    sec = sec[0]
    ct = data[sec['sh_offset']:sec['sh_offset'] + sec['sh_size']]
    sbox = bytearray(open(SBOX, 'rb').read())
    assert len(sbox) == 256, 'el S-box debe tener 256 bytes'
    assert sorted(sbox) == list(range(256)), 'el S-box no es una permutación'

    print('.mips: %d B (cifrado, cabeza %s)' % (len(ct), ct[:8].hex()))
    pt = bytes(c ^ k for c, k in zip(ct, prga(sbox, I0, J0, len(ct))))
    open(PREF + '_descifrado.bin', 'wb').write(pt)
    print('descifrado: cabeza %s  → %s_descifrado.bin' % (pt[:8].hex(), PREF))

    declarado = struct.unpack('<I', pt[:4])[0]
    print('header LE = %d bytes declarados' % declarado)
    try:
        out = zlib.decompress(pt[4:])
    except zlib.error as e:
        print('zlib FALLÓ: %s  ← el S-box o la PRGA no corresponden' % e)
        return 1
    ok = 'COINCIDE ✔' if len(out) == declarado else 'NO COINCIDE ✘'
    print('zlib dio %d B — %s' % (len(out), ok))
    open(PREF + '_inflado.bin', 'wb').write(out)
    print('→ %s_inflado.bin' % PREF)
    return 0 if len(out) == declarado else 1


if __name__ == '__main__':
    sys.exit(main())
