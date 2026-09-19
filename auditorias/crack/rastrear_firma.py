#!/usr/bin/env python3
"""v223.6: encuentra en el volcado del reproductor el codigo que arma la firma
wsSecret y muestra de donde saca la llave (anota las cadenas que referencia)."""
import capstone, sys

ARCHIVO = sys.argv[1] if len(sys.argv) > 1 else 'pphls_elf_interno.so'
d = open(ARCHIVO, 'rb').read()
print(f"{ARCHIVO}: {len(d)} bytes")

# cadenas de interes y sus offsets en el volcado
INTERES = [b'%s%s%x', b'wsSecret=%s&wsTime=%x', b'%s%s%u', b'wsSecret=%s&wsTime=%u',
           b'%s-%d-%d-%d-%s', b'auth_key=%d-%d-%d-%s', b'source_get_request_uri',
           b'1be0ac56', b'de304f03fe653f329edfea08ea2046c4', b'm3u8_key', b'verify=%u-%s']
offs = {}
for s in INTERES:
    i = d.find(s)
    if i >= 0:
        offs[s] = i
        print(f"  cadena {s.decode(errors='replace')!r} en offset 0x{i:x}")

md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
md.detail = False

def desarmar(desde, hasta):
    return list(md.disasm(d[desde:hasta], desde))

# 1) buscar pares ADRP+ADD que apunten cerca de las cadenas
objetivos = set()
for s, o in offs.items():
    for delta in (0, -4096, 4096, -8192, 8192):
        objetivos.add(o + delta)

hallazgos = []
ins = desarmar(0, len(d) - 8)
pend = None
for a in ins:
    if a.mnemonic == 'adrp':
        pend = a
        continue
    if pend and a.mnemonic in ('add', 'ldr') and a.address - pend.address <= 8:
        try:
            partes = a.op_str.split(',')
            reg_d = partes[0].strip()
            if reg_d != pend.op_str.split(',')[0].strip():
                pend = None; continue
            if a.mnemonic == 'add':
                inm = int(partes[2].strip().lstrip('#'), 0)
            else:  # ldr: [x, #imm]
                inm = int(partes[1].strip().strip('[]').split(',')[1].strip().lstrip('#'), 0)
            base = int(pend.op_str.split(',')[1].strip().lstrip('#'), 0) << 12
            tgt = (pend.address & ~0xfff) + base + inm
            if any(abs(tgt - o) <= 16 for o in objetivos):
                cerca = min(objetivos, key=lambda o: abs(o - tgt))
                cual = next((s.decode(errors='replace') for s, o in offs.items() if abs(o - cerca) <= 16), '?')
                hallazgos.append((a.address, tgt, cual))
        except Exception:
            pass
        pend = None

print(f"\n=== referencias al codigo de firma: {len(hallazgos)} ===")
for addr, tgt, cual in hallazgos[:20]:
    print(f"  codigo en offset 0x{addr:x} -> cadena {cual!r} en 0x{tgt:x}")

# 2) desarmar alrededor de la primera referencia a la plantilla de firma
firma = [h for h in hallazgos if 'wsSecret' in h[2] or '%s%s%' in h[2]]
if firma:
    addr = firma[0][0]
    ini = max(0, addr - 0x180)
    print(f"\n=== desarmado alrededor de 0x{addr:x} (la firma) ===")
    for i in desarmar(ini, addr + 0x120):
        marca = ''
        if i.mnemonic in ('adrp', 'add', 'ldr'):
            for s, o in offs.items():
                if hex(o) in i.op_str or str(o) in i.op_str:
                    marca = f"   <-- {s.decode(errors='replace')!r}"
        print(f"  0x{i.address:x}: {i.mnemonic:8s} {i.op_str}{marca}")
else:
    print("no encontre referencias directas; imprimo candidatos ADRP+ADD con #0xcc6ec-like immediates")
