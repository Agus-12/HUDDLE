#!/usr/bin/env python3
"""Descifra el .text de libjiagu_sdk_pp_hlsProtected.so (el cargador con el
servidor de control 127.0.0.1).

El algoritmo sale de su DT_INIT (0x2bc8, en claro):
  tabla   = base_carga + 0  (reloc RELATIVE con addend 0 → el linker escribe
            la base; la "tabla" resulta ser el propio encabezado ELF)
  inicio  = *(u32*)(base+0x30)   (= 0x33d0, va de .text)
  largo   = *(u64*)(base+0x18)   (= 0x1bf48, tamaño de .text)
  semilla = (inicio + largo) & 0xff
  cifrado: XOR encadenado HACIA ATRÁS sobre el byte YA descifrado:
      b'[N-1] = b[N-1] ^ semilla ;  b'[k-1] = b[k-1] ^ b'[k]
Verificación: tras descifrar, el 100% de las palabras de .text decodifican
como ARM64 y los exports arrancan con sub sp / stp estándar.
"""
import sys

RUTA = 'auditorias/apk/lib/arm64-v8a/libjiagu_sdk_pp_hlsProtected.so'
BASE, N = 0x33d0, 0x1bf48

def main():
    raw = open(sys.argv[1] if len(sys.argv) > 1 else RUTA, 'rb').read()
    buf = bytearray(raw)
    prev = (BASE + N) & 0xff
    for k in range(N - 1, -1, -1):
        nuevo = buf[BASE + k] ^ prev
        buf[BASE + k] = nuevo
        prev = nuevo
    out = sys.argv[2] if len(sys.argv) > 2 else 'auditorias/crack/jiagu_descifrada.so'
    open(out, 'wb').write(buf)
    print('escrito', out)

if __name__ == '__main__':
    main()
