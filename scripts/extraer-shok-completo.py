#!/usr/bin/env python3
# extraer-shok-completo.py — saca el ENVIA completo de get_sys_conf SIN recortar
# Uso en Oracle: python3 scripts/extraer-shok-completo.py ~/captura-sign.pcap
# Guarda en /tmp/shok_full.txt el cuerpo crudo exacto que manda la app
import subprocess, pathlib, re, binascii, sys, os
cap = sys.argv[1] if len(sys.argv)>1 else str(pathlib.Path.home()/"captura-sign.pcap")
kl = str(pathlib.Path.home()/"sslkeylogfile.txt")
print(f"cap {cap} keylog {kl}")
# usar tshark si está
try:
    p = subprocess.run(["tshark","-r",cap,"-o",f"tls.keylog_file:{kl}","-Y","http2.headers.path contains get_sys_conf","-T","fields","-e","http2.data.data"], capture_output=True, text=True, timeout=60)
    datas = [l.strip() for l in p.stdout.splitlines() if l.strip()]
    print(f"tshark encontró {len(datas)} data.data")
    out=[]
    for hexs in datas:
        hexs=hexs.replace(":","")
        try:
            txt=binascii.unhexlify(hexs).decode(errors="replace")
            out.append(txt)
            print(f"  ENVIA FULL len {len(txt)}: {txt[:200]!r}...")
            # también guardar bloques SHOK separados
            if "SHOK" in txt:
                parts=txt.split("SHOK")
                for i,b in enumerate(parts[1:],1):
                    print(f"    bloque{i} b64 len {len(b.strip())}: {b.strip()[:90]!r}...")
        except Exception as e:
            print(f"  decode error {e}")
    pathlib.Path("/tmp/shok_full.txt").write_text("\n".join(out))
    print(f"\\nGuardado en /tmp/shok_full.txt ({len(out)} líneas)")
    print("Pega el contenido de /tmp/shok_full.txt aquí o súbelo")
except Exception as e:
    print(f"Error {e}")
    print("Alternativa: python3 scripts/ver-llamadas-app.py ~/captura-sign.pcap --paths=get_sys_conf | cat")
