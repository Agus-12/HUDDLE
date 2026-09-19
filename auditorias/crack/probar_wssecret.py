#!/usr/bin/env python3
"""v223.3: probador OFFLINE de la firma wsSecret (Wangsu) con muestras reales.
No usa red: compara md5(candidata + ruta + wsTime) contra un wsSecret verdadero.
Uso: python3 probar_wssecret.py [--ventanas] """
import hashlib, re, sys, glob, os, itertools

MUESTRA = dict(
    ruta="/vod/1/2026/09/11/9db1ede34113/index5.m3u8",
    wsTime="6aaa532c",
    wsSecret="101d6a4246d4fe7f260245d75de9d1d5",
    host="movievn.j5t2n.com",
)
T = MUESTRA["wsTime"]
T_INT = int(T, 16)
RUTA = MUESTRA["ruta"]
OBJ = MUESTRA["wsSecret"]

VARIANTES_RUTA = [RUTA, RUTA[1:], MUESTRA["host"] + RUTA, "http://" + MUESTRA["host"] + RUTA]
VARIANTES_T = [T, T.upper(), str(T_INT), hex(T_INT), T_INT.to_bytes(4, "big").decode("latin1")]

def md5(b):
    return hashlib.md5(b).hexdigest()

def plantillas(k, p, t):
    """Las formas tipicas de Wangsu/CloudFront que probamos."""
    yield (k + p + t)
    yield (k + p + t).upper()
    yield (p + k + t)
    yield (k + t + p)
    yield (t + k + p)
    yield (p + t + k)
    yield (k + "-" + p + "-" + t)
    yield (p + "-" + t + "-" + k)
    yield (p + "-" + t + "-0-0-" + k)
    yield (p + "-" + t + "--" + k)
    yield (k + p)
    yield (p + k)

def carga_candidatas():
    vistos = set()
    def añade(s):
        s = s.strip()
        if 6 <= len(s) <= 200 and s not in vistos:
            vistos.add(s); return s
    # constantes conocidas del proyecto
    fijas = ["87c2cb7ff568d602d5f806c473345600", "92b991df2a8f669cfd8bf5b0f1c6291c",
             "de304f03fe653f329edfea08ea2046c4", "1be0ac56", "c433b213c8398954d54f59210283c0",
             "Zox882LYjEn4Rqpa", "47Q8tBqO4YqrMHf4", "0123456789123456", "2015030120123456",
             "dsawdf634eebGFHITR5UT9kS0", "ppcineweb123", "MxASAkl/yHTGg+/Tw1R7u96nGqkWsOZ2",
             "3736e27f0823b1ba", "0123456789ES9876543210", "movievn", "com.movievn.cinevi",
             "movievn_sh_1000", "pp_hls", "pp_hlsProtected", "wangsu", "p2p_config", "download_control"]
    for s in fijas:
        for c in (s, s[:16], s[-16:], s.lower(), s.upper()):
            yield c
    # trozos y derivados de las fijas
    for s in fijas:
        if len(s) > 16:
            for i in range(0, len(s) - 16 + 1):
                yield s[i:i+16]
    # todas las cadenas de los archivos del APK y de los modulos desempacados
    archivos = []
    for pat in ["/tmp/dexall/*.dex", "/tmp/libs/*.so", "/tmp/apkx/assets/*",
                "/home/user/HUDDLE/auditorias/crack/*.bin", "/home/user/HUDDLE/auditorias/crack/*.so",
                "/tmp/apk.apk"]:
        archivos += glob.glob(pat)
    for f in archivos:
        try:
            if f.endswith(".apk"):
                import zipfile
                d = b"".join(zipfile.ZipFile(f).read(n) for n in zipfile.ZipFile(f).namelist()
                             if zipfile.ZipFile(f).getinfo(n).file_size < 12_000_000)
            else:
                d = open(f, "rb").read()
        except Exception:
            continue
        for m in re.findall(rb"[ -~]{6,120}", d):
            yield m.decode("latin1")

def main():
    ventanas = "--ventanas" in sys.argv
    n = 0
    for k in carga_candidatas():
        n += 1
        for p in VARIANTES_RUTA:
            for t in VARIANTES_T:
                for s in plantillas(k, p, t):
                    if md5(s.encode("latin1")) == OBJ:
                        print("\n*** ¡ENCONTRADA LA LLAVE! ***")
                        print("llave:", repr(k))
                        print("forma: md5(%.40s...)" % s)
                        return
    print(f"probadas {n} candidatas x {len(VARIANTES_RUTA)*len(VARIANTES_T)*12} plantillas = sin resultado")
    if not ventanas:
        print("(se puede reintentar con --ventanas, que recorta cada cadena a 16 letras)")

main()
