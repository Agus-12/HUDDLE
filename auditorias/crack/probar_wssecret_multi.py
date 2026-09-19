#!/usr/bin/env python3
"""v223.7: probador OFFLINE de wsSecret con VARIAS muestras reales.
Uso: python3 probar_wssecret_multi.py               (muestras de abajo)
     python3 probar_wssecret_multi.py muestras.json (las minadas de una captura)
     python3 probar_wssecret_multi.py muestras.json --derivadas  (claves sacadas de la propia URL)"""
import hashlib, json, re, sys, glob, os

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

CLAVES_FIJAS = ["87c2cb7ff568d602d5f806c473345600", "92b991dfcf878f362f6044f3d6e013255c0726617e4d178588890ecdab1d291c7",
    "de304f03fe653f329edfea08ea2046c4", "1be0ac56", "c433b213c8398954d54f59210283c0", "Zox882LYjEn4Rqpa",
    "47Q8tBqO4YqrMHf4", "0123456789123456", "2015030120123456", "dsawdf634eebGFHITR5UT9kS0", "ppcineweb123",
    "MxASAkl/yHTGg+/Tw1R7u96nGqkWsOZ2", "3736e27f0823b1ba", "0123456789ES9876543210", "movievn",
    "com.movievn.cinevi", "movievn_sh_1000", "pp_hls", "pp_hlsProtected", "wangsu", "p2p_config", "m3u8_key",
    "8a3f9c2b7e1d4a6f", "1a2b3c4d5e6f7a8b", "0000000000000000"]

def derivadas(ruta):
    """Claves sacadas de la propia direccion (por si la llave se arma con ella)."""
    partes = ruta.strip('/').split('/')
    base = partes[-1].split('.')[0]
    carpeta = partes[-2] if len(partes) > 1 else ''
    fecha = ''.join(partes[-5:-2]) if len(partes) >= 5 else ''
    for s in (carpeta, base, fecha, carpeta + base, base + carpeta,
              carpeta.upper(), base.upper(), os.path.basename(ruta)):
        yield s
        if len(s) >= 16:
            yield s[:16]
            for i in range(len(s) - 15):
                yield s[i:i+16]

def candidatas(usar_derivadas=False):
    vistos = set()
    def ok(s):
        if 6 <= len(s) <= 200 and s not in vistos:
            vistos.add(s); return True
        return False
    for s in CLAVES_FIJAS:
        for c in (s, s[:16], s[-16:], s.lower(), s.upper()):
            if ok(c): yield c
        if len(s) > 16:
            for i in range(len(s) - 15):
                if ok(s[i:i+16]): yield s[i:i+16]
    archivos = []
    aqui = os.path.dirname(os.path.abspath(__file__))
    for pat in ["/home/user/apk-trabajo/apk.apk", "/home/user/apk-trabajo/lib/*",
                aqui + "/*.bin", aqui + "/*.so",
                os.path.expanduser("~/huddle/auditorias/crack/*.bin"),
                os.path.expanduser("~/huddle/auditorias/crack/*.so")]:
        archivos += glob.glob(pat)
    for f in archivos:
        try:
            if f.endswith(".apk"):
                import zipfile
                z = zipfile.ZipFile(f)
                d = b"".join(z.read(n) for n in z.namelist() if z.getinfo(n).file_size < 12_000_000)
            else:
                d = open(f, "rb").read()
        except Exception:
            continue
        for m in re.findall(rb"[ -~]{6,120}", d):
            s = m.decode("latin1")
            if ok(s): yield s
    if usar_derivadas:
        for ruta, t, s in MUESTRAS:
            for c in derivadas(ruta):
                if ok(c): yield c

def formas(k, p, t, ti):
    kb = k.encode("latin1")
    yield ("md5(k+p+t)", hashlib.md5(kb + p.encode() + t.encode()).hexdigest())
    yield ("md5(k+p+t)u", hashlib.md5(kb + p.encode() + t.encode()).hexdigest().upper())
    yield ("md5(p+k+t)", hashlib.md5(p.encode() + kb + t.encode()).hexdigest())
    yield ("md5(k+t+p)", hashlib.md5(kb + t.encode() + p.encode()).hexdigest())
    yield ("md5(t+k+p)", hashlib.md5(t.encode() + kb + p.encode()).hexdigest())
    yield ("md5(p+t+k)", hashlib.md5(p.encode() + t.encode() + kb).hexdigest())
    yield ("md5(k+p+dec)", hashlib.md5(kb + p.encode() + str(ti).encode()).hexdigest())
    yield ("md5(k+p+0-0)", hashlib.md5(kb + p.encode() + t.encode() + b"-0-0").hexdigest())
    yield ("md5(p-t-0-0-k)", hashlib.md5(p.encode() + b"-" + t.encode() + b"-0-0-" + kb).hexdigest())
    yield ("md5(k-p-t)", hashlib.md5(kb + b"-" + p.encode() + b"-" + t.encode()).hexdigest())
    yield ("md5(k+p)", hashlib.md5(kb + p.encode()).hexdigest())
    yield ("md5(p+k)", hashlib.md5(p.encode() + kb).hexdigest())
    yield ("md5(k+p+t+sz)", hashlib.md5(kb + p.encode() + t.encode() + b"0").hexdigest())

def main():
    global MUESTRAS
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tope = 24
    for a in sys.argv:
        if a.startswith("--max="): tope = int(a.split("=")[1])
    usar_derivadas = "--derivadas" in sys.argv
    if args:
        datos = json.load(open(args[0]))
        MUESTRAS = [(m["ruta"], m["t"], m["s"]) if isinstance(m, dict) else tuple(m) for m in datos]
        # si una llave funciona, funciona para todas: basta probar unas cuantas
        vistas = set(); cortas = []
        for m in MUESTRAS:
            if m[0] not in vistas:
                vistas.add(m[0]); cortas.append(m)
        MUESTRAS = cortas[:tope]
        print(f"muestras distintas usadas: {len(MUESTRAS)} (de {len(datos)})")
    variantes = [[r, r[1:], r.split("?")[0]] for r, t, s in MUESTRAS]
    n = 0
    for k in candidatas(usar_derivadas):
        n += 1
        for i, (ruta, t, obj) in enumerate(MUESTRAS):
            ti = int(t, 16)
            for p in variantes[i]:
                for nom, val in formas(k, p, t, ti):
                    if val == obj:
                        print("\n*** LLAVE ENCONTRADA ***")
                        print("  llave:", repr(k), "| forma:", nom, "| muestra:", ruta, t)
                        return
    print(f"probadas {n} candidatas x {len(MUESTRAS)} muestras x 3 rutas x 13 formas -> sin resultado")

main()
