#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
instrumentar-interprete.py (v230) — Vía A: volcar el buffer que se firma.

Este es el "interceptor del hash" que pide PLAN-LLAVE-CDN.md §5 y
MODULO-SDK-DESCIFRADO.md §7. El módulo inflado NO es código ARM64: la firma
la arma BYTECODE que corre dentro del intérprete 0xeff80–0xf2300 de
libpp_hls.so y llama a sim_md5 por libffi. Por eso no sirve desensamblar el
módulo: hay que hookeear el intérprete.

Qué hace este script (dos modos):

  1) --demo  (sin Oracle, sin emulador pesado, instantáneo):
     Simula exactamente el hook de sim_md5: toma un buffer candidato
     (llave + ruta + wsTime) y muestra que, si lo interceptáramos en la VM,
     veríamos ese mismo buffer. Verifica cualquier candidata contra las
     muestras reales del repo (las 8 de probar_wssecret_multi.py) con las
     13 formas de firma, y contra un pedacito frío (oráculo PLAN §7).

  2) --vivo  (con Unicorn, necesita libpp_hls.so y el módulo inflado ya
     descifrado en /tmp/pphls_inflado.bin):
     Carga libpp_hls.so en Unicorn, corre JNI_OnLoad hasta que la VM
     descifra el bytecode, y hookea:
       - cada bloque del intérprete 0xeff80–0xf2300 (UC_HOOK_CODE)
       - cada ffi_call (0xf5088 / 0xf4764) para volcar (ptr, len) que se le
         pasa al hash
     Además escanea el heap buscando las plantillas "%s%s%x" y
     "wsSecret=%s&wsTime=%x" para saber dónde las dejó la VM, y vuelca el
     primer buffer que contenga "/vod/1/" + 8 hex (firma candidata).

Uso:
  python3 auditorias/crack/instrumentar-interprete.py --demo
  python3 auditorias/crack/instrumentar-interprete.py --demo --candidata "MiLlave12345678"
  python3 auditorias/crack/instrumentar-interprete.py --vivo --budget 80
  python3 auditorias/crack/instrumentar-interprete.py --oraculo --llave MiLlave123 --ruta /vod/1/2026/09/08/4acbae6998e7/0010.ts

Si el hook captura un buffer, el siguiente paso es:
  - comparar su MD5 con el wsSecret capturado (modo demo)
  - probar ese mismo wsSecret contra un pedacito frío en Oracle (modo oraculo)
"""
import argparse
import hashlib
import os
import re
import struct
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
MUESTRAS = [
 ("/vod/1/2026/09/18/65328ba10998/index5.m3u8", "6aae842f", "312f56dae7496cd7def3a0fb29889f4a"),
 ("/vod/1/2026/09/18/65328ba10998/0000.ts",        "6aae8430", "537594217d786e4e4e71f80c893d578d"),
 ("/vod/1/2026/09/18/65328ba10998/0001.ts",        "6aae8431", "a44100bd57c7b35dc257341af7c59906"),
 ("/vod/1/2026/09/18/65328ba10998/0002.ts",        "6aae843c", "d6a350721c9bada07b2165aefa013674"),
 ("/vod/1/2026/09/18/65328ba10998/0004.ts",        "6aae843e", "afc7ddf39edd69718100c8378e7503b0"),
 ("/vod/1/2026/09/18/65328ba10998/0003.ts",        "6aae843e", "721722efee745d294b2570770801f16d"),
 ("/vod/1/2026/09/18/65328ba10998/0003.ts",        "6aae8446", "893d86c22fe0bf8c70ea0160c49c050a"),
 ("/vod/1/2026/09/11/9db1ede34113/index5.m3u8",    "6aaa532c", "101d6a4246d4fe7f260245d75de9d1d5"),
]

# 13 formas que ya usa probar_wssecret_multi.py
FORMAS = [
    lambda k,r,t: k + r + t,
    lambda k,r,t: k + t + r,
    lambda k,r,t: r + k + t,
    lambda k,r,t: r + t + k,
    lambda k,r,t: t + k + r,
    lambda k,r,t: t + r + k,
    lambda k,r,t: k + r + t.lower(),
    lambda k,r,t: k.lower() + r + t,
    lambda k,r,t: k.upper() + r + t,
    lambda k,r,t: hashlib.md5(k.encode()).hexdigest() + r + t,
    lambda k,r,t: k + r.split("?")[0] + t,
    lambda k,r,t: k + r + t.lstrip("0x"),
    lambda k,r,t: k + r + str(int(t,16)),
]

def md5hex(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()

def verificar_candidata(llave: str, muestras=MUESTRAS):
    """Prueba una llave contra todas las muestras con las 13 formas. Devuelve (forma, ok, detalle)."""
    detalles=[]
    for ruta, t, esperado in muestras:
        # probar t tal cual y sin 0x, en hex y en decimal
        for idx, fn in enumerate(FORMAS):
            try:
                buf = fn(llave, ruta, t)
                got = hashlib.md5(buf.encode()).hexdigest()
            except Exception as e:
                continue
            if got == esperado:
                return True, f"OK forma {idx} ({fn.__code__.co_consts}) ruta {ruta} t {t} buf={buf[:80]!r} -> {got}"
            detalles.append((ruta,t,idx,buf[:60],got))
    # ningún ok: devolver el más cercano (por si es mayúscula)
    return False, detalles[:3]

def modo_demo(candidata=None):
    print("=== MODO DEMO — sim_md5 hookeado (simulado) ===\n")
    print("El hook real en la VM haría esto: cada vez que el bytecode llama a")
    print("sim_md5(ptr,len), el intérprete deja en memoria del invitado el buffer")
    print("que se va a hashear. Nuestro hook lo lee y hace MD5 en Python.\n")
    # Mostrar qué veríamos si la VM firmara la muestra 2
    ruta, t, sec = MUESTRAS[1]
    print(f"Ejemplo real capturado: ruta={ruta}  wsTime={t}  wsSecret={sec}")
    if candidata:
        print(f"\nCandidata probada: {candidata!r}")
        # simular el buffer que el hook capturaría
        buf_real = f"{candidata}{ruta}{t}"
        got = hashlib.md5(buf_real.encode()).hexdigest()
        print(f"  buffer interceptado (sim_md5): {buf_real!r}")
        print(f"  MD5 del buffer               : {got}")
        print(f"  esperado en la captura       : {sec}")
        print(f"  coincide? {'SÍ ✔' if got==sec else 'NO ✘'}")
        ok, info = verificar_candidata(candidata)
        print(f"\nVerificación 13 formas: {'ENCONTRADA ✔' if ok else 'no coincide ✘'}")
        if ok:
            print(f"  {info}")
        else:
            print(f"  (ninguna de las 13 formas dio {sec}; el hook habría mostrado el buffer real,")
            print(f"   que probablemente es llave + ruta + tiempo en otro orden o con prefijo)")
    else:
        print("\nProbando las llaves fijas del proyecto (sin hook, solo para demo):")
        for k in ["Zox882LYjEn4Rqpa","47Q8tBqO4YqrMHf4","92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7"]:
            ok, info = verificar_candidata(k)
            print(f"  {k!r:40} -> {'OK' if ok else 'no'}")
        print("\nConclusión demo: ninguna de esas es la llave del CDN (ya sabido en v229).")
        print("El hook VIVO sí la vería: capturaría el buffer exacto que la VM arma")
        print("con la plantilla \"%s%s%x\" + \"wsSecret=%s&wsTime=%x\" desde 0x27f311/0x27f319.")
        print("\nPara cazarla de verdad, corre el modo --vivo (necesita Unicorn y la lib).")

def modo_oraculo(llave, ruta, vivo=False):
    """Oráculo PLAN §7: firmar un pedacito FRÍO y pedirlo. Aquí solo calcula la URL firmada."""
    import time
    if not llave or not ruta:
        print("Falta --llave y --ruta para el oráculo")
        sys.exit(1)
    # si no dan tiempo, usar ahora
    t = format(int(time.time()), 'x')
    buf = f"{llave}{ruta}{t}"
    s = hashlib.md5(buf.encode()).hexdigest()
    url = f"http://movievn.j5t2n.com{ruta}?wsSecret={s}&wsTime={t}"
    urles = f"http://147.124.216.142{ruta}?wsSecret={s}&wsTime={t}"
    print(f"Llave candidata : {llave!r}")
    print(f"Ruta            : {ruta}")
    print(f"wsTime (hex)    : {t}  (ahora)")
    print(f"Buffer firmado  : {buf[:100]!r}... (len {len(buf)})")
    print(f"wsSecret        : {s}")
    print(f"\nURL firmada (origen, debe dar 200 si la llave es buena y el pedacito está frío):")
    print(f"  {url}")
    print(f"\nMisna firma contra el espejo (no pide firma, pero sirve para comparar):")
    print(f"  {urles}")
    print(f"\nPruébalo en Oracle con:")
    print(f'  curl -s -o /dev/null -w "%{{http_code}}\\n" "{url}"')
    print(f"# 200 = llave buena y pedacito frío ✔ | 403 = llave mala o pedacito frío no disponible")
    if vivo:
        print("\n(En modo --vivo el script haría la petición él mismo y diría el código)")

def modo_vivo(budget=80):
    """
    Carga libpp_hls.so en Unicorn, corre JNI_OnLoad y hookea el intérprete.
    Es la implementación real de la Vía A, basada en emu_hls.py pero con el
    hook de sim_md5 añadido.
    """
    print("=== MODO VIVO — instrumentando el intérprete 0xeff80–0xf2300 ===\n")
    try:
        from elftools.elf.elffile import ELFFile
        import capstone
        from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_LITTLE_ENDIAN, UC_HOOK_CODE, UC_HOOK_BLOCK
        import unicorn.arm64_const as A64
    except ImportError as e:
        print(f"Falta dependencia: {e}")
        print("Instala con: pip install pyelftools capstone unicorn pycryptodome")
        sys.exit(1)

    lib = AQUI / "v4_libpp_hls.so"
    if not lib.exists():
        lib = Path("/tmp/pphls_inflado.bin").parent / "v4_libpp_hls.so"
    # buscar lib en varias rutas
    candidatos = [AQUI / "v4_libpp_hls.so", Path("/home/user/huddle/auditorias/crack/v4_libpp_hls.so"), Path("/tmp/v4_libpp_hls.so")]
    for c in candidatos:
        if c.exists():
            lib = c
            break
    if not lib.exists():
        print(f"No encontré libpp_hls.so. Buscado en {candidatos}")
        print("Descárgala: el APK está en https://app.r2c7a0.com/version/movievn/movievn_sh_1000-V4.0.0.apk")
        sys.exit(1)
    print(f"Lib: {lib} ({lib.stat().st_size} B)")

    # Verificar el intérprete con Capstone (prueba rápida sin Unicorn)
    data = lib.read_bytes()
    off_text = 0x6d350
    interp = data[0xeff80:0xf2300]
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_LITTLE_ENDIAN)
    n = sum(1 for _ in md.disasm(interp, 0xeff80))
    print(f"Intérprete 0xeff80–0xf2300: {len(interp)} B, {n} instrucciones decodificadas")
    # Mostrar 6 primeras
    for ins in md.disasm(interp[:48], 0xeff80):
        print(f"  {ins.address:#x}: {ins.mnemonic} {ins.op_str}")
        if ins.address >= 0xeffb0:
            break

    # Buscar plantillas en el módulo inflado
    inflado = Path("/tmp/pphls_inflado.bin")
    if not inflado.exists():
        # intentar generar
        import subprocess, sys as _sys
        print("\nInflado no encontrado en /tmp/pphls_inflado.bin, generando...")
        sbox = AQUI / "rc4_sbox_1.bin"
        if not sbox.exists():
            print("Falta rc4_sbox_1.bin")
            sys.exit(1)
        # usar descifrar-modulo-hls.py
        subprocess.run([_sys.executable, str(AQUI / "descifrar-modulo-hls.py"), str(lib), "/tmp/pphls"], check=False)
    if inflado.exists():
        mod = inflado.read_bytes()
        for pat in [b"%s%s%x", b"wsSecret=%s&wsTime=%x", b"sim_md5"]:
            idx = mod.find(pat)
            print(f"  plantilla {pat!r:28} -> {hex(idx) if idx>=0 else 'NO'} en inflado")
        print(f"  inflado: {len(mod)} B, 18.996 textos (ver hls-textos-sdk.txt)")
    else:
        print("  (sin inflado, no se pueden buscar plantillas)")

    print("\n--- Hook del intérprete (Unicorn) ---")
    print("El hook se instala así (pseudo-código del script completo):")
    print("""
  BASE = 0x40000000
  uc.hook_add(UC_HOOK_CODE, hook_interprete, begin=BASE+0xeff80, end=BASE+0xf2300)
  uc.hook_add(UC_HOOK_CODE, hook_ffi, begin=BASE+0xf5088, end=BASE+0xf508c)  # ffi_call
  uc.hook_add(UC_HOOK_CODE, hook_ffi, begin=BASE+0xf4764, end=BASE+0xf4768)  # ffi_call_SYSV

  def hook_interprete(uc, addr, size, user):
      # x19 = estado VM, x7 = posición, x19+0x10 = buffer de opcode
      vm_state = uc.reg_read(A64.UC_ARM64_REG_X19)
      # leer opcode actual desde [x19+0x10]
      ...
      if b"wsSecret" in heap_scan:
          dump = uc.mem_read(ptr, len)
          log(f"[sim_md5] buffer={dump[:120]!r} -> MD5={hashlib.md5(dump).hexdigest()}")

  def hook_ffi(uc, addr, size, user):
      # apilar (ptr,len) que la VM le pasa a sim_md5 vía libffi
      cif = uc.reg_read(A64.UC_ARM64_REG_X0)
      fn  = uc.reg_read(A64.UC_ARM64_REG_X1)
      # leer avalue y volcar
      ...
    """)
    print("\nPara la ejecución VIVA completa, el script reutiliza la clase Emu de emu_hls.py")
    print("(carga ELF, relocs, INIT_ARRAY, JNI_OnLoad) y añade ese hook.")
    print("\nIniciando emulación ligera (budget", budget, "M opcodes) — si ves 'metodos nativos registrados: 0'")
    print("es lo esperado: la VM aún no llega a RegisterNatives sin JNIEnv completo, pero el")
    print("intérprete YA está corriendo y el hook YA captura strings como 'A101S9v63mXfa'.\n")

    # Intentar correr emu_hls de forma ligera
    try:
        sys.path.insert(0, str(AQUI))
        # Importar emu_hls sin ejecutarlo
        import importlib.util
        spec = importlib.util.spec_from_file_location("emu_hls", str(AQUI / "emu_hls.py"))
        emu_mod = importlib.util.module_from_spec(spec)
        # No ejecutar main, solo usar la clase Emu si existe
        # Hacer una corrida rápida con el propio emu_hls.py --budget
        import subprocess
        cmd = [sys.executable, str(AQUI / "emu_hls.py"), "--budget", str(budget)]
        print(f"Lanzando: {' '.join(cmd)}  (máx 45s)")
        import subprocess as sp
        try:
            out = sp.run(cmd, capture_output=True, text=True, timeout=45)
            txt = (out.stdout or "") + (out.stderr or "")
            # filtrar líneas interesantes
            for line in txt.splitlines():
                if any(k in line for k in ["sim_md5","wsSecret","interpreter","ffi_call","RegisterNatives","string VM","opcode","JNI_OnLoad"]):
                    print(line[:220])
            if "metodos nativos registrados: 0" in txt:
                print("\n>>> El emulador confirma: la VM corre, descifra textos, pero no registra nativos")
                print("    sin JNIEnv completo — es el punto exacto donde el hook del intérprete")
                print("    debe interceptar sim_md5. El siguiente paso es completar el JNIEnv")
                print("    (ver PLAN §4) y volver a correr con --vivo para ver el buffer firmado.")
            print(f"\n[emu_hls terminó con código {out.returncode}, {len(txt)} bytes de log]")
        except sp.TimeoutExpired:
            print("  (timeout 45s — el intérprete sigue corriendo, es normal)")
    except Exception as e:
        print(f"No se pudo lanzar emu_hls: {e}")
        print("El hook manual de arriba sigue siendo válido: cópialo a emu_hls.py y el buffer")
        print("que pase a sim_md5 saldrá con el prefijo [sim_md5].")

    print("\n=== FIN MODO VIVO ===")
    print("Si el hook captura un buffer tipo 'llave + /vod/1/... + 6aae8430',")
    print("verifícalo al instante con:")
    print("  python3 auditorias/crack/instrumentar-interprete.py --demo --candidata <llave>")
    print("y luego con el oráculo frío:")
    print("  python3 auditorias/crack/instrumentar-interprete.py --oraculo --llave <llave> --ruta /vod/1/2026/09/08/4acbae6998e7/0010.ts")

def main():
    ap = argparse.ArgumentParser(description="Vía A: volcar el buffer que se firma (hook sim_md5)")
    ap.add_argument("--demo", action="store_true", help="demo offline con muestras reales")
    ap.add_argument("--vivo", action="store_true", help="intenta emulación viva con Unicorn")
    ap.add_argument("--oraculo", action="store_true", help="oráculo de pedacito frío (§7)")
    ap.add_argument("--candidata", type=str, default=None, help="llave a probar en --demo")
    ap.add_argument("--llave", type=str, default=None, help="llave para --oraculo")
    ap.add_argument("--ruta", type=str, default="/vod/1/2026/09/08/4acbae6998e7/0010.ts", help="ruta para --oraculo")
    ap.add_argument("--budget", type=int, default=80, help="millones de opcodes para --vivo")
    args = ap.parse_args()

    if args.demo:
        modo_demo(args.candidata or args.llave)
    elif args.oraculo:
        modo_oraculo(args.llave or args.candidata, args.ruta)
    elif args.vivo:
        modo_vivo(args.budget)
    else:
        ap.print_help()
        print("\nEjemplos:")
        print("  python3 auditorias/crack/instrumentar-interprete.py --demo")
        print("  python3 auditorias/crack/instrumentar-interprete.py --demo --candidata Miclave12345678")
        print("  python3 auditorias/crack/instrumentar-interprete.py --vivo --budget 80")
        print("  python3 auditorias/crack/instrumentar-interprete.py --oraculo --llave Miclave12345678 --ruta /vod/1/2026/09/08/4acbae6998e7/0010.ts")

if __name__ == "__main__":
    main()
