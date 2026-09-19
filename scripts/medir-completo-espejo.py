#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
medir-completo-espejo.py (v229) — ¿QUÉ TÍTULOS SE PUEDEN VER COMPLETOS AHORA MISMO?

Para qué: la misión es que los títulos "se vean bien y completos". El espejo
`147.124.216.142` sirve **sin llave** los pedacitos que tiene en caché (el
origen sí exige firma). Este medidor dice, título por título, **cuántos de sus
pedacitos se pueden bajar**, y marca los que están **completos** (listos para
verse de punta a punta) frente a los parciales.

Cómo lo hace:
  1. Pide la lista (`indexN.m3u8`) al espejo; si está en caché, trae los N
     pedacitos con su tamaño (`sz=`) y su huella (`m8=`).
  2. Prueba **cada** pedacito con una petición corta (rango de 1 byte) y cuenta
     los que responden 200.
  3. Informe: completo / parcial / no está, con el % y la lista de huecos.

Uso:
  python3 scripts/medir-completo-espejo.py 65328ba10998
  python3 scripts/medir-completo-espejo.py 65328ba10998 4acbae6998e7 --fecha 2026/09/02
  python3 scripts/medir-completo-espejo.py --ids ids.txt      # uno por línea
  Opciones: --espejo URL  --fecha AAAA/MM/DD  --indices 1,5  --hilos 6
            --lento (una petición cada 0.5 s)  --json salida.json

Nota: el espejo cambia por día. **Re-medir antes de concluir.**
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ESPEJO = 'http://147.124.216.142'
CAB = {'user-agent': 'okhttp/4.12.0'}


def pedir(url, rango=None, timeout=20):
    req = urllib.request.Request(url, headers=CAB)
    if rango:
        req.add_header('range', 'bytes=%s' % rango)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception as e:
        return 'ERR:%s' % type(e).__name__, 0


def lista(espejo, fecha, ident, indice=5):
    """Devuelve los pedacitos de la lista, o None si no está en caché."""
    url = '%s/vod/1/%s/%s/index%d.m3u8' % (espejo, fecha, ident, indice)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=CAB), timeout=20) as r:
            txt = r.read().decode('utf-8', 'replace')
    except Exception:
        return None, url
    if '#EXTM3U' not in txt:
        return None, url
    trozos = []
    for lin in txt.splitlines():
        lin = lin.strip()
        if lin and not lin.startswith('#') and '.ts' in lin:
            m = re.search(r'(?:^|/)([0-9A-Za-z_-]+\.ts)(\?.*)?$', lin)
            if m:
                trozos.append((m.group(1), (m.group(2) or '').lstrip('?')))
    return trozos, url


def medir(espejo, fecha, ident, indices=(1, 5), hilos=6, lento=False):
    res = {'id': ident, 'fecha': fecha, 'listas': {}, 'veredicto': ''}
    for ix in indices:
        trozos, url = lista(espejo, fecha, ident, ix)
        if trozos is None:
            res['listas']['index%d' % ix] = {'estado': 'no está en caché', 'url': url}
            continue
        if not trozos:
            res['listas']['index%d' % ix] = {'estado': 'lista sin pedacitos', 'url': url}
            continue
        def prueba(t):
            nombre, q = t
            u = '%s/vod/1/%s/%s/%s' % (espejo, fecha, ident, nombre) + (('?' + q) if q else '')
            if lento:
                time.sleep(0.5)
            # el espejo responde 206 a las peticiones por rango y 200 al archivo entero
            return pedir(u, rango='0-0')[0] in (200, 206), nombre
        with ThreadPoolExecutor(max_workers=hilos) as ex:
            r = list(ex.map(prueba, trozos))
        ok = [n for bueno, n in r if bueno]
        faltan = [n for bueno, n in r if not bueno]
        pct = 100.0 * len(ok) / max(len(trozos), 1)
        res['listas']['index%d' % ix] = {
            'pedacitos': len(trozos), 'disponibles': len(ok), 'porcentaje': round(pct, 1),
            'primeros_que_faltan': faltan[:12], 'url': url,
        }
    # veredicto: la mejor lista (por cantidad de pedacitos disponibles)
    mejor, mejor_pct = None, -1
    for k, v in res['listas'].items():
        if 'disponibles' not in v:
            continue
        if v['disponibles'] > mejor_pct:
            mejor, mejor_pct = k, v['disponibles']
    if mejor is None:
        res['veredicto'] = 'no está en el espejo (medir otro día o mirar el origen)'
    else:
        v = res['listas'][mejor]
        if v['porcentaje'] >= 99.5:
            res['veredicto'] = 'COMPLETO en %s (%d/%d)' % (mejor, v['disponibles'], v['pedacitos'])
        elif v['disponibles'] == 0:
            res['veredicto'] = 'nada en %s' % mejor
        else:
            res['veredicto'] = 'parcial en %s (%d/%d = %.0f%%)' % (
                mejor, v['disponibles'], v['pedacitos'], v['porcentaje'])
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ids', nargs='*')
    ap.add_argument('--ids', dest='archivo')
    ap.add_argument('--espejo', default=ESPEJO)
    ap.add_argument('--fecha', default='2026/09/18')
    ap.add_argument('--fechas',
                    help='varias fechas separadas por coma; se usa la primera donde la lista exista')
    ap.add_argument('--indices', default='1,5')
    ap.add_argument('--hilos', type=int, default=6)
    ap.add_argument('--lento', action='store_true')
    ap.add_argument('--json')
    a = ap.parse_args()
    ids = list(a.ids)
    if a.archivo:
        ids += [l.strip() for l in open(a.archivo) if l.strip() and not l.startswith('#')]
    if not ids:
        sys.exit('faltan ids (mira los que ya conoces: 65328ba10998, 4acbae6998e7, 3605f6781343)')
    indices = tuple(int(x) for x in a.indices.split(','))
    fechas = [f.strip() for f in (a.fechas or a.fecha).split(',') if f.strip()]
    todo = []
    for ident in ids:
        r = None
        for fecha in fechas:
            cand = medir(a.espejo, fecha, ident, indices, a.hilos, a.lento)
            if any('pedacitos' in v for v in cand['listas'].values()):
                r = cand
                break
            r = r or cand          # guarda el intento si ninguna fecha tiene lista
        r['fechas_probadas'] = fechas
        todo.append(r)
        print('%-16s %-52s' % (r['id'], r['veredicto']))
        for k, v in r['listas'].items():
            if 'pedacitos' in v:
                print('    %-8s %4d/%4d  %.1f%%' % (k, v['disponibles'], v['pedacitos'], v['porcentaje']))
            else:
                print('    %-8s %s' % (k, v['estado']))
    if a.json:
        open(a.json, 'w').write(json.dumps(todo, ensure_ascii=False, indent=1))
        print('(guardado en %s)' % a.json)


if __name__ == '__main__':
    main()
