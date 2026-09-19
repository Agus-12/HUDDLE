#!/usr/bin/env python3
# extraer-shok-completo.py — ENVIA completo de get_sys_conf SIN recortar (v231 fix)
# Uso en Oracle: python3 scripts/extraer-shok-completo.py ~/captura-sign.pcap
# Guarda en /tmp/shok_full.txt el cuerpo crudo exacto que manda la app
import subprocess, pathlib, re, binascii, sys, os, shutil

cap = sys.argv[1] if len(sys.argv)>1 else str(pathlib.Path.home()/"captura-sign.pcap")
kl = str(pathlib.Path.home()/"sslkeylogfile.txt")
if len(sys.argv)>2 and sys.argv[2].startswith("--keylog"):
    kl = sys.argv[2].split("=",1)[1] if "=" in sys.argv[2] else sys.argv[3]

print(f"cap {cap} keylog {kl}")

CAMPOS = ['frame.number','tcp.stream','ip.src','http2.streamid','http2.headers.path','http2.data.data']

def campos_validos():
    try:
        p=subprocess.run(['tshark','-G','fields'], capture_output=True, text=True, timeout=30)
        ok=set()
        for line in p.stdout.splitlines():
            parts=line.split('\t')
            if len(parts)>3 and parts[0]=='F':
                ok.add(parts[2])
        return ok
    except: return None

validos = campos_validos()
campos = [c for c in CAMPOS if validos is None or c in validos]

# Necesitamos agrupar por (tcp.stream, http2.streamid) como hace ver-llamadas-app.py
# Usamos filtro que trae todo lo que tenga path o data
filtro='http2.headers.path or http2.data.data'
cmd=['tshark','-r',cap]
if os.path.exists(kl):
    cmd+=['-o',f'tls.keylog_file:{kl}']
cmd+=['-Y',filtro,'-T','fields']
for c in campos:
    cmd+=['-e',c]

print(f"ejecutando tshark con filtro '{filtro}'...")
try:
    p=subprocess.run(cmd, capture_output=True, text=True, timeout=120)
except Exception as e:
    print(f"error tshark {e}")
    sys.exit(1)

if p.returncode!=0 and not p.stdout.strip():
    print(f"tshark fallo: {p.stderr[:500]}")
    sys.exit(1)

# Agrupar por flujo
flujos={}
for line in p.stdout.splitlines():
    if not line.strip():
        continue
    cols = line.split('\t')
    cols += ['']*(len(campos)-len(cols))
    vals=dict(zip(campos,cols))
    tcp=vals.get('tcp.stream','')
    sid=(vals.get('http2.streamid','0').split(',')[0] or '0').strip()
    path=vals.get('http2.headers.path','')
    data=vals.get('http2.data.data','')
    d=flujos.setdefault((tcp,sid), {'path':'','datas':[]})
    if path:
        d['path']=path
    if data:
        d['datas'].append(data)

print(f"flujos distintos: {len(flujos)}")
out=[]
count=0
for (tcp,sid),d in flujos.items():
    path=d['path']
    if 'get_sys_conf' not in path:
        continue
    # reconstruir ENVIA
    txt=""
    for hexs in d['datas']:
        hexs=hexs.replace(':','').strip()
        if hexs:
            try:
                txt+=binascii.unhexlify(hexs).decode(errors='replace')
            except:
                pass
    # txt ahora es el cuerpo crudo, ej: conf_key=p2p_configSHOK...SHOK...
    if not txt:
        # a veces el body viene en el mismo frame que el path? ya lo tenemos
        continue
    # Si el cuerpo no empieza con conf_key, puede ser que datas esté vacío y el body esté en otro flujo
    # Filtrar solo los que tienen conf_key
    if 'conf_key=' not in txt:
        continue
    count+=1
    print(f"\n== get_sys_conf #{count} stream {tcp},{sid} path {path[:80]} ==")
    print(f"ENVIA FULL len {len(txt)}")
    # imprimir sin recortar, pero separado por SHOK para legibilidad
    # guardar completo
    print(txt)
    print("--- bloques SHOK ---")
    if "SHOK" in txt:
        parts=txt.split("SHOK")
        print(f"  parte0 (nombre): {parts[0][:120]!r}")
        for i,b in enumerate(parts[1:],1):
            b=b.strip()
            print(f"  bloque{i} b64 len {len(b)} : {b[:100]!r}... (full abajo)")
            # verificación base64
            import base64
            try:
                raw=base64.b64decode(b + "===")  # padding tolerante
                print(f"    -> raw len {len(raw)} mod16 {len(raw)%16}")
            except Exception as e:
                print(f"    base64 error {e}")
    else:
        print("  (sin SHOK)")
    out.append(txt)

out_path=pathlib.Path("/tmp/shok_full.txt")
out_path.write_text("\n".join(out))
print(f"\nGuardado en /tmp/shok_full.txt ({len(out)} líneas, {sum(len(x) for x in out)} bytes)")
# también guardar bloques individuales para descifrar-shok.py
for i, txt in enumerate(out,1):
    if "SHOK" in txt:
        # extraer con regex
        m=re.match(r'conf_key=([^S]+)SHOK(.+)SHOK(.+)', txt)
        if m:
            name, b1, b2 = m.groups()
            print(f"\nPara descifrar con descifrar-shok.py #{i}:")
            print(f"  nombre: {name}")
            print(f"  b1 len {len(b1)}")
            print(f"  b2 len {len(b2)}")
print("Pega el contenido de /tmp/shok_full.txt aquí")
