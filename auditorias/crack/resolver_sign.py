# -*- coding: utf-8 -*-
"""
resolver_sign.py — resuelve el `ck` del sign nativo a partir de UNA captura real.

Qué necesita: un `info_new` real capturado, o sea la terna
    (device_id, cur_time, sign)
tal como la mandó el teléfono. Con eso prueba en local (sin red, en segundos)
todas las combinaciones de secreto y orden hasta encontrar la que reproduce ese
`sign` exacto. Cuando aparece, el candado está abierto: se puede generar el sign
de cualquier vod_id y pedir las URLs de video de todo el catálogo.

De dónde sale la captura:
    ~/captura-sign.jsonl  (lo escribe el addon mitmproxy `captura_sign.py`)
    el cuerpo del POST trae:  vod_id=...&cur_time=...&sign=...&audio_type=...
    y la cabecera `device_id` trae el device.

Uso:
    python3 resolver_sign.py --jsonl ~/captura-sign.jsonl
    python3 resolver_sign.py --dev 3736e27f0823b1ba --ts 1789515864447 --sign ABCDEF...
    python3 resolver_sign.py --jsonl ~/captura-sign.jsonl --extra-secreto "otrointento"

Nota importante: el sign del CUERPO no tiene por qué usar el mismo secreto que el
sign de las CABECERAS (ese ya está resuelto: MD5('47Q8tBqO4YqrMHf4'+dev+ts) en
mayúsculas, verificado contra captura real). Por eso aquí se prueban muchos
candidatos y muchos órdenes, y también varias funciones hash.
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.parse

# Secretos candidatos, con su procedencia. Ninguno confirmado todavía para el sign
# del cuerpo; el primero es el `ck` leído de una respuesta real de public/init.
CANDIDATOS = [
    # ★ EL CANDIDATO PRINCIPAL. El handler verify hace sprintf("%s%s%s", device_id, ts,
    #   cfg[0x38]) y la función que IMPRIME la config (0xb55f4) revela el mapa de campos:
    #   [cfg+0x38] se imprime como 'device_encrypt_key :%s'  ← ESTE es el 3er trozo
    #   [cfg+0x40] se imprime como 'ck                 :%s'  ← ck es OTRO campo
    #   El valor sale de la config por defecto embebida en texto plano dentro del módulo
    #   de libpp_hls (pphls_mips_inflado.bin, offset 0x31efd9..0x31f6c5):
    #       device_encrypt_key=Zox882LYjEn4Rqpa
    #   Corroboración del mapa: el 'ck' de esa config por defecto es idéntico al que
    #   llegó vivo en public/init (92b991...d291c7), así que los offsets están bien leídos.
    ("device_encrypt_key (cfg+0x38) ★", "Zox882LYjEn4Rqpa"),
    ("ck (cfg+0x40, NO es el del sign)", "92b991dfcf878f362f6044f3d6e013255c0726617e4d17858890ecdab1d291c7"),
    ("key de com.pp.hls.load",         "87c2cb7ff568d602d5f806c473345600"),
    ("salt de las cabeceras",          "47Q8tBqO4YqrMHf4"),
    ("salt de las cabeceras, min",     "47q8tbqo4yqrmhf4"),
    ("app key DEX (classes7) A21",     "6A21635498FB7F1E13648270050E1346E"),
    ("app key DEX (classes7) B29",     "6BE2FB29B23E42031B1900D85E0756B75"),
    ("sal del modulo interno de30",    "de304f03fe653f329edfea08ea2046c4"),
    ("sal del modulo interno 1be0",    "1be0ac56"),
    ("sal interna abcdef",             "abcdef0123456789"),
    ("fecha interna 2021-12-30",       "2021-12-30"),
    ("vacio",                          ""),
]

HASHES = {
    "md5":    lambda b: hashlib.md5(b).hexdigest(),
    "sha1":   lambda b: hashlib.sha1(b).hexdigest(),
    "sha256": lambda b: hashlib.sha256(b).hexdigest(),
}


def ordenes(dev, ts, ck):
    """Todas las permutaciones de los 3 trozos que el código sugiere.

    El handler hace sprintf("%s%s%s", device_id, ts, cfg[0x38]), así que el orden
    principal es (dev, ts, ck). Se prueban los demás por si la lectura está mal.
    """
    trozos = [dev, ts, ck]
    visto = set()
    for a in range(3):
        for b in range(3):
            for c in range(3):
                if len({a, b, c}) != 3:
                    continue
                clave = (a, b, c)
                if clave in visto:
                    continue
                visto.add(clave)
                yield "%s|%s|%s" % (
                    ["dev", "ts", "ck"][a],
                    ["dev", "ts", "ck"][b],
                    ["dev", "ts", "ck"][c],
                ), trozos[a] + trozos[b] + trozos[c]


def variantes_de(salto):
    """Formas en que el digest puede aparecer en el sign."""
    h32 = HASHES["md5"](salto.encode())
    yield "md5 min", h32
    yield "md5 MAY", h32.upper()
    yield "md5[:16] min", h32[:16]
    yield "md5[:16] MAY", h32[:16].upper()
    for hn in ("sha1", "sha256"):
        h = HASHES[hn](salto.encode())
        yield hn + "[:32] MAY", h[:32].upper()
        yield hn + "[:32] min", h[:32]
        yield hn + "[:16] min", h[:16]


def resolver(dev, ts, sign, secretos):
    """Devuelve (descripcion, secreto) si alguna combinacion reproduce `sign`."""
    objetivo = sign.strip()
    objetivo_min = objetivo.lower()
    probadas = 0
    for nombre, secreto in secretos:
        for nombre_orden, salto in ordenes(dev, ts, secreto):
            for nombre_hash, candidato in variantes_de(salto):
                probadas += 1
                if candidato == objetivo or candidato.lower() == objetivo_min:
                    return {
                        "secreto_nombre": nombre,
                        "secreto": secreto,
                        "orden": nombre_orden,
                        "hash": nombre_hash,
                        "cadena": salto,
                        "sign": objetivo,
                        "probadas": probadas,
                    }
    return None


def leer_ternas_del_jsonl(ruta):
    """Saca (device_id, cur_time, sign, vod_id, url) de cada info_new del JSONL."""
    ternas = []
    with open(os.path.expanduser(ruta), encoding="utf-8", errors="replace") as f:
        for linea in f:
            linea = linea.strip()
            if not linea:
                continue
            try:
                r = json.loads(linea)
            except Exception:
                continue
            url = r.get("url") or ""
            if "info_new" not in url:
                continue
            cuerpo = urllib.parse.parse_qs(r.get("cuerpo_req") or "")
            cab = {k.lower(): v for k, v in (r.get("cabeceras_req") or {}).items()}
            sign = (cuerpo.get("sign") or [None])[0] or cab.get("sign")
            ts = (cuerpo.get("cur_time") or [None])[0] or cab.get("cur_time")
            dev = cab.get("device_id")
            if not (sign and ts and dev):
                continue
            ternas.append({
                "dev": dev,
                "ts": ts,
                "sign": sign,
                "vod_id": (cuerpo.get("vod_id") or [None])[0],
                "url": url,
                "audio_type": (cuerpo.get("audio_type") or [None])[0],
                "resp": (r.get("resp_descifrada") or "")[:300],
            })
    return ternas


def main():
    ap = argparse.ArgumentParser(description="Resuelve el ck del sign nativo con una captura real")
    ap.add_argument("--jsonl", help="ruta del captura-sign.jsonl")
    ap.add_argument("--dev", help="device_id")
    ap.add_argument("--ts", help="cur_time (milisegundos)")
    ap.add_argument("--sign", help="sign capturado")
    ap.add_argument("--extra-secreto", action="append", default=[],
                    help="candidato adicional (se puede repetir)")
    args = ap.parse_args()

    secretos = list(CANDIDATOS)
    for i, s in enumerate(args.extra_secreto):
        secretos.insert(0, ("extra #%d" % (i + 1), s))

    ternas = []
    if args.jsonl:
        if not os.path.exists(os.path.expanduser(args.jsonl)):
            print("ERROR: no existe %s" % args.jsonl)
            return 2
        ternas = leer_ternas_del_jsonl(args.jsonl)
        print("ternas info_new encontradas en el JSONL: %d" % len(ternas))
    if args.dev and args.ts and args.sign:
        ternas.insert(0, {"dev": args.dev, "ts": args.ts, "sign": args.sign,
                          "vod_id": None, "url": "(manual)", "audio_type": None, "resp": ""})
    if not ternas:
        print("ERROR: no hay ninguna terna (device_id, cur_time, sign) que probar.")
        print("       Pasa --jsonl ~/captura-sign.jsonl o --dev/--ts/--sign.")
        return 2

    ganadoras = []
    for t in ternas:
        print("\n--- device=%s ts=%s sign=%s vod=%s" % (t["dev"], t["ts"], t["sign"], t.get("vod_id")))
        r = resolver(t["dev"], t["ts"], t["sign"], secretos)
        if r:
            print("    ✅ RESUELTO tras %d combinaciones" % r["probadas"])
            print("       secreto : %s = %r" % (r["secreto_nombre"], r["secreto"]))
            print("       orden   : %s" % r["orden"])
            print("       hash    : %s" % r["hash"])
            print("       cadena  : %s" % r["cadena"])
            ganadoras.append((t, r))
        else:
            print("    ❌ ninguna combinacion reproduce ese sign")
            print("       (probadas %d por terna; el ck es otro: hace falta el real)" %
                  (len(secretos) * 6 * 7))

    if ganadoras:
        t, r = ganadoras[0]
        print("\n" + "=" * 68)
        print("FÓRMULA DEL SIGN DEL CUERPO, RESUELTA:")
        print("  sign = %s( %s )   [%s]" % (
            r["hash"], r["orden"].replace("|", " + "), r["secreto_nombre"]))
        print("  secreto = %r" % r["secreto"])
        print("=" * 68)
        print("\nCon esto se puede pedir info_new de cualquier vod_id.")
        return 0

    print("\nNo se resolvió con los candidatos conocidos.")
    print("Siguiente paso: conseguir el `ck` real. Vías, en orden de coste:")
    print("  1. Mirar la respuesta descifrada de public/init en la MISMA captura")
    print("     (campo sys_conf.p2p_config, dentro viene ^ck=...^).")
    print("  2. Buscar en el JSONL cualquier campo que huela a secreto y pasarlo")
    print("     con --extra-secreto.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
