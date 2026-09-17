#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extraer_elf_interno.py — saca el ELF AArch64 que viene embebido dentro del
módulo descifrado de libpp_hls (`pphls_mips_inflado.bin`) y mapea qué funciones
referencian cada cadena.

Cadena de pasos completa (todo reproducible desde el repo):
    1. python3 emu_jiagu.py --run --budget 120        → genera rc4_sbox_1.bin
    2. python3 rc4_jiagu.py ../apk/lib/arm64-v8a/libpp_hls.so rc4_sbox_1.bin pphls_mips
       → pphls_mips_descifrado.bin + pphls_mips_inflado.bin (3,391,425 B)
    3. python3 extraer_elf_interno.py                 → pphls_elf_interno.so

Por qué hace falta: el módulo inflado NO es un ELF (empieza e1 c0 01 00 00 e0 …,
es bytecode de la VM 360), pero a partir de 0x50429 lleva un ELF AArch64 completo
con el código real del servidor de control. Sus program headers están borrados,
así que para buscar referencias hay que decodificar ADRP/ADD a mano: el `disasm`
lineal de capstone se para en el primer byte no decodificable y este binario
tiene datos intercalados.
"""
import io
import struct
import sys

from elftools.elf.elffile import ELFFile

MOD = sys.argv[1] if len(sys.argv) > 1 else 'pphls_mips_inflado.bin'
SAL = sys.argv[2] if len(sys.argv) > 2 else 'pphls_elf_interno.so'
MAGIC = b'\x7fELF'


def extraer(mod, sal):
    d = open(mod, 'rb').read()
    off = d.find(MAGIC)
    while off >= 0:
        eh = d[off:off + 64]
        if len(eh) == 64 and eh[4] == 2 and eh[5] == 1:
            machine, = struct.unpack('<H', eh[18:20])
            if machine == 183:                     # EM_AARCH64
                e_shoff, = struct.unpack('<Q', eh[0x28:0x30])
                e_shentsize, e_shnum = struct.unpack('<HH', eh[0x3a:0x3e])
                fin = e_shoff + e_shentsize * e_shnum
                blob = d[off:off + fin]
                open(sal, 'wb').write(blob)
                print('ELF interno en 0x%x de %s: %d B → %s'
                      % (off, mod, len(blob), sal))
                return blob
        off = d.find(MAGIC, off + 1)
    print('no se encontró ningún ELF AArch64 embebido')
    return None


def sgn(v, bits):
    return v - (1 << bits) if v >> (bits - 1) else v


def refs_cadenas(b, lo=0x80000, hi=0x1e0000):
    """Devuelve {dirección_de_cadena: [direcciones_de_código]} resolviendo
    ADRP + ADD(inmediato) a mano, palabra por palabra."""
    adrp = {}
    refs = {}
    for i in range(lo, min(hi, len(b) - 4), 4):
        w = int.from_bytes(b[i:i + 4], 'little')
        if (w & 0x9f000000) == 0x90000000:                 # ADRP
            rd = w & 31
            imm = sgn((((w >> 5) & 0x7ffff) << 2) | ((w >> 29) & 3), 21) << 12
            adrp[rd] = (i, (i & ~0xfff) + imm)
        elif (w & 0xff800000) == 0x91000000:               # ADD inmediato 64b
            rd = w & 31
            rn = (w >> 5) & 31
            imm12 = (w >> 10) & 0xfff
            sh = (w >> 22) & 1
            if rn in adrp:
                base, page = adrp[rn]
                if i - base < 0x40:
                    refs.setdefault(page + (imm12 << (12 if sh else 0)),
                                    []).append(i)
    return refs


def cadena(b, o):
    if not 0 <= o < len(b):
        return None
    e = b.find(b'\0', o)
    if e < 0 or e - o > 220:
        return None
    s = b[o:e]
    return s.decode('latin1') if s and all(32 <= c < 127 for c in s) else None


def main():
    b = extraer(MOD, SAL)
    if not b:
        return 1
    f = ELFFile(io.BytesIO(b))
    print('  tipo=%s maquina=%s entry=0x%x' % (f.header.e_type,
                                              f.header.e_machine,
                                              f.header.e_entry))
    refs = refs_cadenas(b)
    con = {t: c for t, c in refs.items() if cadena(b, t)}
    print('  refs ADRP+ADD: %d (%d apuntan a cadena legible)'
          % (len(refs), len(con)))
    print('\n  dónde está el handler del sign (buscar "verify" y "%s%s%s"):')
    for t, cods in sorted(con.items()):
        s = cadena(b, t)
        if s in ('verify', 'up_ck', '%s%s%s', 'device_id', 'msg',
                 'server_port', 'update_ck'):
            print('    str@0x%06x %-14r <- %s'
                  % (t, s, [hex(c) for c in sorted(cods)[:4]]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
