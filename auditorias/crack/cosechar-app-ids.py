#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cosechar-app-ids.py — Cosecha masiva del catálogo APP vía info_new directo (v1).

Descubrimiento 19-sep noche: `search/screen` solo da 485 títulos (techo del servidor),
pero `vod/info_new` responde a MUCHOS ids al azar con 30-90% de aciertos.
Ejemplo: 500000001 -> Backdraft 2, 938578616 -> The Old Guard, etc.
Con token de moquito86 (vip1) el hit-rate es alto en todo el rango 1..2B.

Este script barre un rango de vod_ids, llama a info_new con la fórmula verificada
(sign = MD5(Zox882LYjEn4Rqpa + device_id + vod_id + cur_time)) y guarda solo los
que devuelven code 10000 con vod_name.

Uso:
  python3 auditorias/crack/cosechar-app-ids.py --inicio 500000000 --fin 500010000 --salida /tmp/catalogo-app-ids.json
  python3 auditorias/crack/cosechar-app-ids.py --inicio 1 --fin 650000 --concurrentes 3  (reanudable)
Reanudable: guarda checkpoint en `salida`.checkpoint.json con siguiente id y cubiertos.
"""
import argparse, base64, hashlib, json, os, sys, time, urllib.request, urllib.error

HOST = "https://surfclick.vd7au6.com"
DEV  = "3736e27f0823b1ba"
SEC  = "Zox882LYjEn4Rqpa"
SALT = "47Q8tBqO4YqrMHf4"
AES_KEY = b"0123456789123456"
AES_IV  = b"2015030120123456"

try:
    from Crypto.Cipher import AES
    def descifrar(txt):
        txt=txt.strip().strip('"')
        txt+="="*(-len(txt)%4)
        raw=base64.b64decode(txt)
        c=AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
        d=c.decrypt(raw)
        pad=d[-1]
        if 1<=pad<=16 and d[-pad:] == bytes([pad])*pad:
            d=d[:-pad]
        return json.loads(d.decode())
except ImportError:
    # fallback a verificar_api
    sys.path.insert(0, os.path.dirname(__file__))
    from verificar_api import descifrar  # type: ignore

def token_nuevo():
    # si hay token en /tmp/tok_moquito.txt lo usa, si no pide guest
    p="/tmp/tok_moquito.txt"
    if os.path.exists(p):
        tok=open(p).read().strip()
        if len(tok)>50:
            return tok
    # guest
    ts=int(time.time()*1000)
    sign=hashlib.md5((SALT+DEV+str(ts)).encode()).hexdigest().upper()
    h={'app_id':'movievn','version':'40000','sys_platform':'2','device_id':DEV,'channel_code':'movievn_sh_1000','cur_time':str(ts),'sign':sign,'token':'','user-agent':'okhttp/4.12.0','content-type':'application/x-www-form-urlencoded'}
    body=f"device_id={DEV}&channel_code=movievn_sh_1000"
    req=urllib.request.Request(HOST+"/api/public/init", data=body.encode(), headers=h)
    with urllib.request.urlopen(req, timeout=15) as r:
        j=descifrar(r.read().decode())
        return j["result"]["user_info"]["token"]

def pedir_info(vod_id, token):
    ts=int(time.time()*1000)
    sign=hashlib.md5((SEC+DEV+str(vod_id)+str(ts)).encode()).hexdigest().upper()
    body=f"vod_id={vod_id}&cur_time={ts}&sign={sign}&audio_type=0"
    sign_h=hashlib.md5((SALT+DEV+str(ts)).encode()).hexdigest().upper()
    h={'app_id':'movievn','version':'40000','sys_platform':'2','device_id':DEV,'channel_code':'movievn_sh_1000','cur_time':str(ts),'sign':sign_h,'token':token,'user-agent':'okhttp/4.12.0','content-type':'application/x-www-form-urlencoded'}
    req=urllib.request.Request(HOST+"/api/vod/info_new", data=body.encode(), headers=h)
    with urllib.request.urlopen(req, timeout=15) as r:
        return descifrar(r.read().decode())

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--inicio", type=int, default=500000000)
    ap.add_argument("--fin", type=int, default=500001000)
    ap.add_argument("--salida", default="/tmp/catalogo-app-ids.json")
    ap.add_argument("--pausa", type=float, default=0.25, help="segundos entre llamadas")
    args=ap.parse_args()

    token=token_nuevo()
    print(f"token {token[:30]}... len {len(token)}")
    # cargar previo
    catalogo={}
    chk_path=args.salida+".checkpoint.json"
    siguiente=args.inicio
    if os.path.exists(args.salida):
        try:
            catalogo=json.load(open(args.salida, encoding="utf-8"))
            print(f"catalogo previo {len(catalogo)} títulos en {args.salida}")
        except Exception as e:
            print(f"no pude leer {args.salida}: {e}")
    if os.path.exists(chk_path):
        try:
            chk=json.load(open(chk_path))
            siguiente=chk.get("siguiente", siguiente)
            print(f"reanudando desde {siguiente} (checkpoint)")
        except Exception:
            pass
    hits=miss=err=0
    start_time=time.time()
    try:
        for vod in range(siguiente, args.fin+1):
            try:
                j=pedir_info(vod, token)
                code=j.get("code")
                if code==10000 and j.get("result") and j["result"].get("vod_name"):
                    r=j["result"]
                    catalogo[str(vod)]={
                        "nombre": r.get("vod_name"),
                        "año": r.get("vod_year"),
                        "idioma": r.get("vod_lang"),
                        "pic": r.get("vod_pic"),
                        "tipo": r.get("type_id"),
                        "genero": r.get("vod_tag"),
                        "url": (r.get("vod_collection") or [{}])[0].get("vod_url") if r.get("vod_collection") else None,
                    }
                    hits+=1
                    if hits%10==0 or hits<5:
                        print(f"  {vod} -> {r.get('vod_name')[:40]} ({r.get('vod_year')}) hits {hits} miss {miss}")
                elif code==10000:
                    miss+=1
                else:
                    miss+=1
                    if miss%100==0:
                        print(f"  {vod} code {code} miss {miss}")
                err=0
            except urllib.error.HTTPError as e:
                err+=1
                print(f"  HTTP {e.code} en {vod}, pausa 5s")
                time.sleep(5)
            except Exception as e:
                err+=1
                if err<5:
                    print(f"  err {vod}: {e}")
                time.sleep(1)
            # checkpoint cada 100
            if (vod - siguiente +1) % 100 ==0:
                json.dump(catalogo, open(args.salida,"w", encoding="utf-8"), ensure_ascii=False, indent=1)
                json.dump({"siguiente": vod+1, "hits": hits, "miss": miss, "total": len(catalogo)}, open(chk_path,"w"))
                elapsed=time.time()-start_time
                rate=(vod - args.inicio +1)/ max(elapsed,1)
                print(f"checkpoint {vod}/{args.fin} hits {hits} total {len(catalogo)} rate {rate:.1f} ids/s")
            time.sleep(args.pausa)
            # pausa larga si el servidor da error chino (caído)
            if err>10:
                print("muchos errores seguidos, esperando 20s")
                time.sleep(20)
                err=0
    except KeyboardInterrupt:
        print("interrumpido por usuario")
    finally:
        json.dump(catalogo, open(args.salida,"w", encoding="utf-8"), ensure_ascii=False, indent=1)
        json.dump({"siguiente": vod+1 if 'vod' in locals() else siguiente, "hits": hits, "miss": miss, "total": len(catalogo)}, open(chk_path,"w"))
        print(f"\nFINAL: {len(catalogo)} títulos guardados en {args.salida} (hits {hits} miss {miss})")
        print(f"checkpoint en {chk_path}")

if __name__=="__main__":
    main()
