#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
descifrar-shok.py (v232) — SHOK descifrado.

Hallazgo 22:30 UTC 19-sep-2026 (captura-sign.pcap):
  - SHOK no es magia: es AES-128-CBC con la misma llave de la API: 0123456789123456
  - Estructura:  raw = base64_decode(bloque SHOK)
                 header = raw[:H]  (H = 45 para p2p_config de 285 B, 29 para conf_key1 de 61 B)
                 payload = raw[H:]  (múltiplo de 16)
                 iv = header[-16:]  (los últimos 16 del header)
                 pt = AES_CBC_decrypt(payload, key=012345..., iv)
                 pt contiene el JSON del result de get_sys_conf, con padding PKCS7
  - Probado en vivo con tu captura:
    * conf_key1 (61 B, H=29) -> 'e9xito", "result": []}'  (el p2p_config vacío, solo el final del JSON)
      con H=45 -> '": []}' (mismo pero más corto)
    * p2p_config (285 B, H=45) -> '": "[BASE]^backup_domain=http://147.124.216.142^sec_domain=null^ck_t=1^ck_tt=1^ck_p=0^ck=92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7^[P2P]^p2p_tracker_addr=47.253.51.203:7202^p2p_stunserver_addr=stun.l.google.com^"}'
      que es EXACTAMENTE el p2p_config que el servidor manda (lo puedes verificar con ver_sysconf.py).

Eso confirma que SHOK es el *envoltorio de la respuesta* que el cliente manda ya cifrado
(el servidor solo lo valida). No es la llave del CDN, pero ya no es una caja negra.

Uso:
  python3 auditorias/crack/descifrar-shok.py --b64 <bloque>
  python3 auditorias/crack/descifrar-shok.py --envia "p2p_configSHOK...SHOK..."
  python3 auditorias/crack/descifrar-shok.py --archivo /tmp/shok_full.txt
  python3 auditorias/crack/descifrar-shok.py --captura ~/captura-sign.pcap  (usa ver-llamadas)
"""
import argparse, base64, pathlib, re, sys
from Crypto.Cipher import AES

KEY = b"0123456789123456"
IVS = [b"2015030120123456", b"\x00"*16]

def try_decrypt(raw):
    # probar H = 45, 29, 61, 32, 16
    for h in [45, 29, 61, 32, 16, 0]:
        if h > len(raw) or h < 0:
            continue
        header = raw[:h]
        payload = raw[h:]
        if len(payload)==0 or len(payload)%16!=0:
            # recortar al múltiplo de 16 más cercano
            payload = payload[:len(payload)//16*16]
            if len(payload)==0:
                continue
        iv_cands = []
        if h>=16:
            iv_cands.append(header[-16:])
            iv_cands.append(raw[h-16:h])
        iv_cands.extend(IVS)
        for iv in iv_cands:
            if len(iv)!=16:
                continue
            try:
                c=AES.new(KEY, AES.MODE_CBC, iv)
                pt=c.decrypt(payload)
                # quitar PKCS7
                pad=pt[-1]
                if 1<=pad<=16 and pt[-pad:]==bytes([pad])*pad:
                    pt2=pt[:-pad]
                else:
                    pt2=pt
                # buscar señales
                if b"backup_domain" in pt2 or b"result" in pt2 or b"[BASE]" in pt2 or b"p2p_tracker" in pt2 or pt2.startswith(b'":'):
                    return h, iv, pt2, payload
                # también si es imprimible alto
                if sum(1 for b in pt2 if 32<=b<127 or b in (10,13)) / max(1,len(pt2)) > 0.7 and len(pt2)>=10:
                    return h, iv, pt2, payload
            except Exception:
                pass
    return None

def descifrar_b64(b64, nombre="bloque"):
    raw=None
    try:
        # limpiar
        b64 = re.sub(r'[^A-Za-z0-9+/=]', '', b64)
        # padding
        b64 += "=" * (-len(b64)%4)
        raw = base64.b64decode(b64)
    except Exception as e:
        print(f"  {nombre}: base64 inválido {e}")
        return
    print(f"\n=== {nombre} b64 {len(b64)} raw {len(raw)} mod16 {len(raw)%16} ===")
    print(f"  raw head {raw.hex()[:60]}...")
    res = try_decrypt(raw)
    if res:
        h, iv, pt2, payload = res
        print(f"  -> DESCIFRADO con H={h} iv={iv.hex()[:16]}... payload {len(payload)}")
        print(f"  pt len {len(pt2)}: {pt2[:300]!r}")
        if len(pt2)>300:
            print(f"  pt tail: {pt2[300:500]!r}")
        # mostrar bonito si es JSON fragmento
        if b"[BASE]" in pt2:
            # es p2p_config
            print(f"  *** p2p_config descifrado ***")
    else:
        print(f"  no se pudo descifrar (probadas H=45,29,61)")

def main():
    ap=argparse.ArgumentParser(description="Descifra SHOK")
    ap.add_argument("--b64", help="bloque base64")
    ap.add_argument("--envia", help="cuerpo completo conf_key...SHOK...SHOK...")
    ap.add_argument("--archivo", help="archivo con líneas ENVIA")
    ap.add_argument("--captura", help="pcap para extraer SHOK (usa extraer-shok-completo)")
    args=ap.parse_args()
    if args.b64:
        descifrar_b64(args.b64, "b64")
    if args.envia:
        parts=args.envia.split("SHOK")
        print(f"ENVIA tiene {len(parts)-1} SHOKs, parte0={parts[0][:40]!r}")
        for i,b in enumerate(parts[1:],1):
            descifrar_b64(b, f"envia bloque{i}")
    if args.archivo:
        for line in pathlib.Path(args.archivo).read_text().splitlines():
            if "SHOK" in line:
                parts=line.strip().split("SHOK")
                for i,b in enumerate(parts[1:],1):
                    descifrar_b64(b, f"archivo bloque{i} ({parts[0][:20]})")
    if args.captura:
        # usar extraer-shok-completo logic
        import subprocess, binascii, os, pathlib
        cap=args.captura
        kl=str(pathlib.Path.home()/"sslkeylogfile.txt")
        # llamar al otro script
        print(f"Extrayendo de {cap}...")
        import sys
        sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent/"scripts"))
        # fallback: llamar al script
        import subprocess as sp
        out=sp.run([sys.executable, str(pathlib.Path(__file__).parent.parent.parent/"scripts"/"extraer-shok-completo.py"), cap], capture_output=True, text=True, timeout=60)
        print(out.stdout[-2000:])
    if not any([args.b64, args.envia, args.archivo, args.captura]):
        ap.print_help()

if __name__=="__main__":
    main()
