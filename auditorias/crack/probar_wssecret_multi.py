#!/usr/bin/env python3
# v228.1: PROBADOR OFFLINE de la llave del CDN (wsSecret) contra muestras reales.
# La firma es: wsSecret = MD5(<llave> + <ruta sin consulta> + <wsTime hex>).
# Este script prueba candidatas de llave de tres fuentes:
#   1) claves derivadas de la propia direccion (--derivadas)
#   2) constantes conocidas del proyecto y sus cortes/MD5 (derivadas_de_constantes)
#   3) TODAS las cadenas del APK y de los modulos desempacados (candidatas)
#
# Uso:
#   python3 auditorias/crack/probar_wssecret_multi.py                      # muestras de abajo
#   python3 auditorias/crack/probar_wssecret_multi.py ~/muestras-wssecret.json --derivadas
#   python3 auditorias/crack/probar_wssecret_multi.py ~/muestras-wssecret.json --max=12
#
# Para agregar una llave a mano: ponerla en CLAVES_FIJAS (o en un archivo y usar --lista).
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

CLAVES_FIJAS = [
    # constantes del proyecto ya conocidas
    "87c2cb7ff568d602d5f806c473345600",
    "92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7",
    "de304f03fe653f329edfea08ea2046c4", "1be0ac56", "c433b213c8398954d54f59210283c0",
    "Zox882LYjEn4Rqpa", "47Q8tBqO4YqrMHf4", "0123456789123456", "2015030120123456",
    "dsawdf634eebGFHITR5UT9kS0", "ppcineweb123", "3736e27f0823b1ba", "0123456789ES9876543210",
    "movievn", "com.movievn.cinevi", "movievn_sh_1000", "pp_hls", "pp_hlsProtected",
    # del SDK de anuncios (probadas, se dejan para dejar constancia)
    "QwEr12TyUi!@Op34AsDf#$GhJk56L%^Z",
]


def derivadas(ruta):
    """Claves sacadas de la propia direccion (por si la llave se arma con ella)."""
    partes = ruta.strip('/').split('/')
    base = partes[-1].split('.')[0]
    carpeta = partes[-2] if len(partes) > 1 else ''
    fecha = ''.join(partes[-5:-2]) if len(partes) >= 5 else ''
    for s in (carpeta, base, fecha, carpeta + base, base + carpeta, carpeta.upper(),
              base.upper(), os.path.basename(ruta)):
        yield s
        if len(s) >= 16:
            yield s[:16]
            for i in range(len(s) - 15):
                yield s[i:i+16]


def derivadas_de_constantes():
    """Llaves sacadas de las constantes conocidas: cortes, MD5 de datos, etc."""
    base = {
        "ck": "92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7",
        "hls": "87c2cb7ff568d602d5f806c473345600",
        "de": "de304f03fe653f329edfea08ea2046c4",
        "dev": "3736e27f0823b1ba",
        "sec": "Zox882LYjEn4Rqpa",
        "hdr": "47Q8tBqO4YqrMHf4",
        "badci": "c433b213c8398954d54f59210283c0",
    }
    for nom, h in base.items():
        yield h
        yield h.upper()
        for m in (hashlib.md5(h.encode()).hexdigest(),
                  hashlib.md5(h.upper().encode()).hexdigest(),
                  hashlib.md5(h.encode()).hexdigest().upper()):
            yield m
            yield m[:16]
            yield m[16:]
            yield m[-16:]
        if len(h) % 2 == 0:
            try:
                b = bytes.fromhex(h)
            except ValueError:
                continue
            for i in range(0, len(b) - 15):
                yield b[i:i+16]
                yield b[i:i+16].hex()
                yield b[i:i+16].hex().upper()
    for ruta, t, s in MUESTRAS:
        partes = ruta.strip("/").split("/")
        for dato in (partes[-2], partes[-1], partes[-1].split(".")[0], "".join(partes[-5:-2])):
            for v in (dato, dato.upper(), dato.lower()):
                for m in (hashlib.md5(v.encode()).hexdigest(),
                          hashlib.md5(v.encode()).hexdigest().upper()):
                    yield m
                    yield m[:16]
                    yield m[16:]


def candidatas():
    """Todas las cadenas del APK y de los modulos desempacados."""
    vistos = set()

    def ok(s):
        if 6 <= len(s) <= 200 and s not in vistos:
            vistos.add(s)
            return True
        return False

    for s in CLAVES_FIJAS:
        for c in (s, s[:16], s[-16:], s.lower(), s.upper()):
            if ok(c):
                yield c
        if len(s) > 16:
            for i in range(len(s) - 15):
                if ok(s[i:i+16]):
                    yield s[i:i+16]
    aqui = os.path.dirname(os.path.abspath(__file__))
    archivos = []
    for pat in ["/home/user/apk-trabajo/apk.apk", "/home/user/apk-trabajo/lib/*",
                os.path.expanduser("~/apk-trabajo/apk.apk"), os.path.expanduser("~/apk-trabajo/lib/*"),
                aqui + "/*.bin", aqui + "/*.so"]:
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
            if ok(s):
                yield s


def formas(k, p, t, ti):
    """Las 13 formas de armar el texto firmado que se han visto o probado."""
    kb = k if isinstance(k, bytes) else k.encode("latin1")
    pe, te = p.encode(), t.encode()
    yield ("md5(k+p+t)", hashlib.md5(kb + pe + te).hexdigest())
    yield ("md5(k+p+t)u", hashlib.md5(kb + pe + te).hexdigest().upper())
    yield ("md5(p+k+t)", hashlib.md5(pe + kb + te).hexdigest())
    yield ("md5(k+t+p)", hashlib.md5(kb + te + pe).hexdigest())
    yield ("md5(t+k+p)", hashlib.md5(te + kb + pe).hexdigest())
    yield ("md5(p+t+k)", hashlib.md5(pe + te + kb).hexdigest())
    yield ("md5(k+p+dec)", hashlib.md5(kb + pe + str(ti).encode()).hexdigest())
    yield ("md5(k+p+0-0)", hashlib.md5(kb + pe + te + b"-0-0").hexdigest())
    yield ("md5(p-t-0-0-k)", hashlib.md5(pe + b"-" + te + b"-0-0-" + kb).hexdigest())
    yield ("md5(k-p-t)", hashlib.md5(kb + b"-" + pe + b"-" + te).hexdigest())
    yield ("md5(k+p)", hashlib.md5(kb + pe).hexdigest())
    yield ("md5(p+k)", hashlib.md5(pe + kb).hexdigest())
    yield ("md5(k+p+t+0)", hashlib.md5(kb + pe + te + b"0").hexdigest())


def probar_candidata(k, muestras, variantes):
    for i, (ruta, t, obj) in enumerate(muestras):
        ti = int(t, 16)
        for p in variantes[i]:
            for nom, val in formas(k, p, t, ti):
                if val == obj:
                    print("\n*** LLAVE ENCONTRADA ***")
                    print("  llave:", repr(k), "| forma:", nom, "| muestra:", ruta, t)
                    return True
    return False


def main():
    global MUESTRAS
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tope = 6          # basta probar unas cuantas muestras: si la llave sirve, sirve para todas
    for a in sys.argv:
        if a.startswith("--max="):
            tope = int(a.split("=")[1])
    usar_derivadas = "--derivadas" in sys.argv
    if args:
        datos = json.load(open(args[0]))
        MUESTRAS = [(m["ruta"], m["t"], m["s"]) if isinstance(m, dict) else tuple(m) for m in datos]

    # 1) claves derivadas de la direccion, contra SU propia muestra
    if usar_derivadas:
        n = 0
        for ruta, t, obj in MUESTRAS:
            for k in derivadas(ruta):
                n += 1
                if probar_candidata(k, [(ruta, t, obj)], [[ruta, ruta[1:], ruta.split("?")[0],
                                                           ruta.split("/")[-1].split(".")[0]]]):
                    return
        print(f"claves derivadas de la direccion: {n} pruebas -> sin resultado")

    # 2) claves derivadas de constantes, contra varias muestras
    vistas, cortas = set(), []
    for m in MUESTRAS:
        if m[0] not in vistas:
            vistas.add(m[0])
            cortas.append(m)
    cortas = cortas[:tope]
    variantes = [[r, r[1:], r.split("?")[0], r.split("/")[-1].split("?")[0],
                  r.split("/")[-1].split(".")[0]] for r, t, s in cortas]
    print(f"muestras distintas usadas: {len(cortas)} de {len(MUESTRAS)}")
    n = 0
    for k in derivadas_de_constantes():
        n += 1
        if probar_candidata(k, cortas, variantes):
            return
    print(f"claves derivadas de constantes: {n} -> sin resultado")

    # 3) todas las cadenas del APK y modulos
    n = 0
    for k in candidatas():
        n += 1
        if probar_candidata(k, cortas, variantes):
            return
        if n % 100000 == 0:
            print(f"  ... {n} candidatas probadas")
    print(f"cadenas del APK y modulos: {n} -> sin resultado")
    print("\nSi aparece la llave, verificar contra un pedacito FRIO (ver auditorias/PLAN-LLAVE-CDN.md).")


if __name__ == "__main__":
    main()
