#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
xrefs-modulo-hls.py (v228.4 / v229) — ¿QUIÉN usa cada texto del módulo del SDK?

Sirve para dos cosas:

1. **Comprobar si el módulo inflado es código.** Resultado (19-sep-2026): NO lo es.
   En 3,4 MB solo hay **2 pares ADRP+ADD** (y apuntan a páginas basura), frente a
   ~19.000 cadenas: el módulo es el **programa/datos de la VM** del SDK. Por eso la
   firma no se puede leer desensamblando este módulo: hay que instrumentar el
   intérprete (`0xeff80–0xf2300` del `.text` de `libpp_hls.so`).

2. **Buscar referencias** a un texto o dirección dentro del volcado (por si en el
   futuro se infla otra cosa que sí sea código).

Uso:
  python3 xrefs-modulo-hls.py                 # objetivos por defecto (plantillas de firma)
  python3 xrefs-modulo-hls.py 0x27f319 0x27f311
  python3 xrefs-modulo-hls.py --texto "wsSecret=%s&wsTime=%x"
  python3 xrefs-modulo-hls.py --regiones      # mapa de regiones (código/datos)
"""
import re
import struct
import sys
from pathlib import Path

import capstone

AQUI = Path(__file__).resolve().parent


def primer_existente(*rutas):
    for r in rutas:
        if r and Path(r).exists():
            return Path(r)
    return Path(rutas[0])


MODULO = primer_existente(AQUI / 'pphls_inflado.bin', AQUI / 'v4hls__inflado.bin')


def mapa_regiones(d):
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_LITTLE_ENDIAN)
    print('regiones de 64 KB — % de palabras que Capstone decodifica como ARM64:')
    for off in range(0, len(d), 0x10000):
        trozo = d[off:off + 0x10000]
        n = sum(1 for _ in md.disasm(trozo, off))
        tot = len(trozo) // 4
        print('  %08x  %5.1f%%  %s' % (off, 100.0 * n / max(tot, 1),
                                       'CÓDIGO' if n / max(tot, 1) > 0.55 else 'datos'))


def xrefs(d, objetivos, contexto=24):
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_LITTLE_ENDIAN)
    adrp, hits = {}, {t: [] for t in objetivos}
    for off in range(0, len(d) - 4, 4):
        ins = next(md.disasm(d[off:off + 4], off), None)
        if ins is None:
            adrp.clear()
            continue
        ops = ins.op_str
        if ins.mnemonic == 'adrp':
            try:
                reg, val = ops.split(', ')
                adrp[reg] = int(val, 16)
            except Exception:
                pass
            continue
        if ins.mnemonic in ('add', 'ldr') and ',' in ops:
            p = [x.strip() for x in ops.split(',')]
            if len(p) >= 2 and p[1] in adrp:
                m = re.search(r'#(0x[0-9a-f]+|\d+)',
                              p[2] if ins.mnemonic == 'add' else ops.split('[', 1)[-1])
                if m:
                    inm = int(m.group(1), 16) if m.group(1).startswith('0x') else int(m.group(1))
                    for t in objetivos:
                        if adrp[p[1]] + inm == t:
                            hits[t].append(off)
        if ins.mnemonic in ('br', 'ret', 'b') or ins.mnemonic.startswith('b.'):
            adrp.clear()
    # además: ¿hay punteros de 8 bytes a esos sitios? (tablas del programa)
    for t in objetivos:
        ptr = [o for o in range(0, len(d) - 8, 8) if struct.unpack_from('<Q', d, o)[0] == t]
        hits[t] += [('ptr', o) for o in ptr[:6]]
    for t, offs in hits.items():
        print('\n=== referencias a %#x: %d' % (t, len(offs)))
        for o in offs:
            if isinstance(o, tuple):
                print('   puntero en %#x' % o[1])
                continue
            ini = max(0, o - 4 * contexto)
            for i in md.disasm(d[ini:o + 8], ini):
                print('  %08x  %-8s %s%s' % (i.address, i.mnemonic, i.op_str,
                                             '  <<<' if i.address == o else ''))
    return hits


def main():
    d = open(MODULO, 'rb').read()
    print('módulo: %s (%d B)' % (MODULO.name, len(d)))
    args = sys.argv[1:]
    if '--regiones' in args:
        mapa_regiones(d)
        return
    objetivos = []
    if '--texto' in args:
        txt = args[args.index('--texto') + 1].encode()
        off = d.find(txt)
        if off < 0:
            sys.exit('no está el texto %r' % txt)
        print('el texto %r está en %#x' % (txt, off))
        objetivos.append(off)
    for a in args:
        if a.startswith('0x'):
            objetivos.append(int(a, 16))
    if not objetivos:
        for txt in (b'wsSecret=%s&wsTime=%x', b'%s%s%x', b'%s?c=getts'):
            i = d.find(txt)
            if i >= 0:
                print('plantilla %-24r -> %#x' % (txt, i))
                objetivos.append(i)
    objetivos = sorted(set(objetivos))
    if not objetivos:
        sys.exit('sin objetivos')
    xrefs(d, objetivos)


if __name__ == '__main__':
    main()
