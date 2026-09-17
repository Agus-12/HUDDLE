#!/usr/bin/env python3
"""
dec_stack_strings.py — decodifica las cadenas «de pila» del jiagu EJECUTANDO el
código real en Unicorn, en vez de interpretar los `mov wN, #inm` a mano.

Por qué existe: estas funciones construyen cada cadena byte a byte
(`mov w13,#0x82; strb w13,[sp,#0x272]`) y luego la descifran restando una clave
por byte. Leer los registros a mano es facilísimo de equivocar (los `mov`
re-asignan wN a mitad del bloque). Ejecutar el tramo que arma el arreglo y volcar
la memoria es exacto y reproducible.

Uso:
  python3 dec_stack_strings.py                 # sub_b71c (las 22 rutas)
  python3 dec_stack_strings.py 0xb71c 0xd638 0x298 22
      <entrada> <PC donde parar> <offset del arreglo respecto a SP> <n.º entradas>

Detalle: los saltos a la .plt (0x2d70..0x3400) se parchean con `ret` para que el
código que arma las cadenas corra de corrido; paramos justo en la primera
instrucción del bucle que consume el arreglo.
"""
import sys
from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_LITTLE_ENDIAN, UC_HOOK_CODE
from unicorn.arm64_const import UC_ARM64_REG_SP, UC_ARM64_REG_X0, UC_ARM64_REG_PC

SO = 'jiagu_descifrada.so'
RET = bytes([0xc0, 0x03, 0x5f, 0xd6])


def main():
    entrada = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0xb71c
    parar = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0xd638
    off_arr = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x298
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 22

    d = bytearray(open(SO, 'rb').read())
    for off in range(0x2d70, 0x3400, 16):
        d[off:off + 4] = RET
    d = bytes(d)

    mu = Uc(UC_ARCH_ARM64, UC_MODE_LITTLE_ENDIAN)
    mu.mem_map(0x0, 0x100000)
    mu.mem_write(0x0, d)
    STK, SZ = 0x7f000000, 1 << 20
    mu.mem_map(STK, SZ)
    mu.mem_map(0x40000000, 0x10000)          # JNIEnv falso
    mu.reg_write(UC_ARM64_REG_SP, STK + SZ - 0x800)
    mu.reg_write(UC_ARM64_REG_X0, 0x40000000)

    mu.hook_add(UC_HOOK_CODE, lambda m, a, s, u: m.emu_stop() if a == parar else None)
    mu.emu_start(entrada, 0, count=5000000)

    pc = mu.reg_read(UC_ARM64_REG_PC)
    print('PC final 0x%x (esperado 0x%x) %s' % (pc, parar, 'OK' if pc == parar else '!! NO LLEGÓ'))
    arr = mu.reg_read(UC_ARM64_REG_SP) + off_arr

    salida = []
    for i in range(n):
        p = int.from_bytes(mu.mem_read(arr + 8 * i, 8), 'little')
        if not p:
            salida.append(None)
            print('  [%2d] NULL' % i)
            continue
        s, a = bytearray(), p
        while True:
            b = mu.mem_read(a, 1)[0]
            if b == 0:
                break
            s.append(b)
            a += 1
        salida.append(s.decode('latin1'))
        print('  [%2d] %r' % (i, salida[-1]))
    print('\ndecodificadas: %d/%d' % (sum(1 for x in salida if x), n))
    return salida


if __name__ == '__main__':
    main()
