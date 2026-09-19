#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
descifrar-shok.py (v231) — ataca el envoltorio SHOK de get_sys_conf.

Lo que ya sabemos (19-sep, captura-sign.pcap):
  - La app manda POST /api/public/get_sys_conf con cuerpo:
    conf_key=<nombre>SHOK<bloque1>SHOK<bloque2>
  - bloque1 (84 b64 -> 61 bytes) ES EL MISMO en todas las peticiones de la
    sesión (conf_key1 y p2p_config lo comparten). No es múltiplo de 16 => no es AES puro.
  - bloque2 solo aparece en algunas claves (p2p_config largo, conf_key1 lo repite).
  - El envoltorio NO está en el APK ni en el módulo: lo arma el SDK nativo con su tabla
    de textos cifrada (jiagu). Por eso hay que atacarlo como DATO, no como strings.

Este script prueba a descifrar bloque2 con las llaves que ya tenemos:
  - AES-128-CBC con las 4 llaves conocidas (012345..., 201503..., Zox..., 47Q8...)
  - RC4 jiagu (sbox rc4_sbox_1.bin) con i0=3 j0=5
  - XOR simple, zlib, base64 anidado
  - La clave RSA privada del módulo (si está) como posible envoltorio

Uso:
  python3 auditorias/crack/descifrar-shok.py --b1 5119... --b2 5119...
  python3 auditorias/crack/descifrar-shok.py --envia "p2p_configSHOK...SHOK..."
  python3 auditorias/crack/descifrar-shok.py --archivo /tmp/shok_full.txt
"""
import argparse, base64, hashlib, sys, pathlib, re, os, json, struct

AQUI = pathlib.Path(__file__).resolve().parent
LLAVES_AES = [
    b"0123456789123456", b"2015030120123456",
    b"Zox882LYjEn4Rqpa", b"47Q8tBqO4YqrMHf4",
    b"QwEr12TyUi!@Op34", b"AsDf#$GhJk56L%^Z",
]
# ck recortado a 16 (32 bytes hex -> 16 bytes bin)
CK_HEX = "92b991dfcf878f362f6044f3d6e013255c0726617e4d178588890ecdab1d291c"
try:
    LLAVES_AES.append(bytes.fromhex(CK_HEX[:32]))
    LLAVES_AES.append(bytes.fromhex(CK_HEX[32:64]))
except: pass
IVS = [b"2015030120123456", b"0123456789123456", b"\x00"*16]

def try_base64(s):
    # limpia y completa padding
    s = re.sub(r'[^A-Za-z0-9+/=]', '', s)
    pad = (-len(s)) % 4
    if pad: s += "="*pad
    try: return base64.b64decode(s)
    except: return None

def try_aes(raw, key, iv, mode):
    from Crypto.Cipher import AES
    if len(raw) % 16 != 0: return None
    try:
        c = AES.new(key, mode, iv) if mode==AES.MODE_CBC else AES.new(key, mode)
        pt = c.decrypt(raw)
        # quitar PKCS7 si parece
        pad = pt[-1]
        if 1 <= pad <= 16 and pt[-pad:] == bytes([pad])*pad:
            pt2 = pt[:-pad]
        else:
            pt2 = pt
        # es texto?
        ratio = sum(1 for b in pt2 if 32<=b<127 or b in (10,13)) / max(1,len(pt2))
        if ratio > 0.65 and len(pt2)>=4:
            return pt2
        # también si parece JSON o lista
        if pt2.startswith(b"{") or pt2.startswith(b"[") or b"p2p" in pt2[:40].lower():
            return pt2
    except: pass
    return None

def descifrar_bloque(b64, nombre="bloque"):
    print(f"\\n=== {nombre} b64 len {len(b64)} ===")
    raw = try_base64(b64)
    if not raw:
        print("  no es base64 válido")
        return
    print(f"  raw len {len(raw)} hex {raw.hex()[:80]}...")
    print(f"  entropía alta? imprimibles {sum(1 for b in raw if 32<=b<127)}/{len(raw)}")
    # probar zlib/gzip
    import zlib, gzip
    for fn, lab in [(zlib.decompress,"zlib"),(gzip.decompress,"gzip")]:
        try:
            out = fn(raw)
            print(f"  {lab} OK -> {out[:120]!r}")
        except: pass
    # AES
    from Crypto.Cipher import AES
    for k in LLAVES_AES:
        for iv in IVS:
            for mode, mlab in [(AES.MODE_CBC,"CBC"),(AES.MODE_ECB,"ECB")]:
                out = try_aes(raw, k, iv, mode) if len(raw)%16==0 else None
                if out:
                    print(f"  AES-{mlab} OK key {k!r} iv {iv.hex()[:8]} -> {out[:120]!r}")
                # probar también recortando a múltiplo de 16 (si 61 -> 48)
                if len(raw)%16!=0 and len(raw)>=48:
                    out2 = try_aes(raw[:48], k, iv, mode)
                    if out2:
                        print(f"  AES-{mlab} recortado48 OK key {k!r} -> {out2[:100]!r}")
    # RC4 jiagu
    sbox_p = AQUI / "rc4_sbox_1.bin"
    if sbox_p.exists():
        sbox = sbox_p.read_bytes()
        def rc4(data, sbox, i0=3, j0=5):
            b=bytearray(sbox); i,j=i0,j0; out=bytearray()
            for byte in data:
                i=(i+2)&0xff; j=(b[i]+j+1)&0xff; a,c=b[i],b[j]; b[i],b[j]=c,a; out.append(byte ^ b[(a+c)&0xff])
            return bytes(out)
        for i0,j0 in [(3,5),(0,0),(1,1)]:
            pt = rc4(raw, sbox, i0,j0)
            ratio = sum(1 for b in pt if 32<=b<127)/len(pt)
            if ratio>0.55:
                print(f"  RC4 jiagu i0={i0} j0={j0} OK -> {pt[:100]!r}")
    # XOR 1 byte
    for kk in [0x5A,0x12,0xFF]:
        pt = bytes(b^kk for b in raw)
        if sum(1 for b in pt if 32<=b<127)/len(pt)>0.6:
            print(f"  XOR {hex(kk)} -> {pt[:80]!r}")

def main():
    ap = argparse.ArgumentParser(description="Descifra envoltorio SHOK")
    ap.add_argument("--b1", help="bloque1 b64")
    ap.add_argument("--b2", help="bloque2 b64")
    ap.add_argument("--envia", help="cuerpo completo conf_key...SHOK...SHOK...")
    ap.add_argument("--archivo", help="archivo con líneas ENVIA completas")
    args = ap.parse_args()
    if args.archivo:
        txt = pathlib.Path(args.archivo).read_text()
        for line in txt.splitlines():
            if "SHOK" in line:
                # extraer todos los bloques SHOK de la línea
                partes = re.split(r"SHOK", line)
                # partes[0] es prefijo conf_key, resto son bloques
                for i, b in enumerate(partes[1:],1):
                    b=b.strip()
                    # quitar posible prefijo conf_key= y sufijos
                    b=re.sub(r"^[^A-Za-z0-9+/=]+", "", b)
                    b=re.split(r"[^A-Za-z0-9+/=]", b)[0]
                    if len(b)>=20:
                        descifrar_bloque(b, f"archivo línea bloque{i}")
        return
    if args.envia:
        s=args.envia
        # separar por SHOK
        seps = s.split("SHOK")
        print(f"ENVIA tiene {len(seps)-1} separadores SHOK")
        for i, part in enumerate(seps):
            print(f"  parte {i} len {len(part)} head {part[:60]!r}")
        for i, b in enumerate(seps[1:],1):
            b=b.strip()
            if b:
                descifrar_bloque(b, f"ENVIA bloque{i}")
        return
    if args.b1: descifrar_bloque(args.b1, "b1")
    if args.b2: descifrar_bloque(args.b2, "b2")
    if not any([args.b1,args.b2,args.envia,args.archivo]):
        ap.print_help()

if __name__=="__main__":
    main()
