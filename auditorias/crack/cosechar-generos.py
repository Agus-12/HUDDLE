#!/usr/bin/env python3
# v227: COSECHA DEL CATÁLOGO por géneros y áreas (la vía nueva para pasar de 441).
# La app pide: POST /api/search/screen  type_id=1&psize=20&is_random=1&area=94407&type=Terror%2FChoque
#  - psize tope 20 por llamada; langostear: barrer géneros (español con acentos + chino) y áreas.
#  - 'page' no funciona; 'is_random' devuelve el mismo bloque (sirve como bloque fijo).
# Escribe el resultado en ~/catalogo-generos.json y va imprimiendo el avance.
#
# Uso:  python3 auditorias/crack/cosechar-generos.py [--token TOKEN_DEL_AMIGO] [--tipo 1] [--salida ruta.json]
import sys, os, time, json, urllib.parse, hashlib

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
from info_new_vivo import pedir, aes_puro, token_nuevo          # noqa: E402

GENEROS = [
    # español (los que respondieron y los que faltaba probar)
    'Acción', 'Comedia', 'Terror/Choque', 'Drama', 'Suspenso', 'Animación', 'Aventura',
    'Fantasía', 'Guerra', 'Familia', 'Historia', 'Deportes', 'Romance', 'Bélica', 'Crimen',
    'Documental', 'Musical', 'Misterio', 'Thriller', 'Ciencia Ficción', 'Western', 'Biografía',
    'Infantil', 'Anime', 'Novela', 'Accion', 'Comedia Romantica', 'Ciencia Ficcion',
    'Terror', 'Suspenso/Thriller', 'Superhéroes', 'Catástrofe', 'Erótico', 'Policial',
    # chino (como los tiene su base: funcionan 恐怖 科幻 犯罪 纪录片 奇幻 悬疑 剧情 惊悚 音乐)
    '动作', '喜剧', '恐怖', '爱情', '动画', '科幻', '冒险', '战争', '犯罪', '纪录片',
    '奇幻', '悬疑', '剧情', '惊悚', '音乐', '家庭', '历史', '体育', '武侠', '灾难',
]
AREAS = ['94407', '114110', '1', '100', '2', '3', '10', '1000']


def titulos(tok, tipo, cuerpo, extra=''):
    try:
        j = aes_puro(pedir('/api/search/screen', f'type_id={tipo}&{cuerpo}{extra}', tok))
    except Exception:
        return {}
    res = j.get('result')
    lst = res if isinstance(res, list) else (res or {}).get('list') or (res or {}).get('data') or []
    salida = {}
    for x in lst:
        if isinstance(x, dict) and x.get('id'):
            salida[str(x['id'])] = {
                'nombre': x.get('vod_name'), 'año': x.get('vod_year'),
                'tipo': x.get('type_id') or tipo, 'pic': x.get('vod_pic'),
                'genero': x.get('vod_tag'),
            }
    return salida


def main():
    token = ''
    tipo = '1'
    salida = os.path.expanduser('~/catalogo-generos.json')
    for i, a in enumerate(sys.argv):
        if a == '--token' and i + 1 < len(sys.argv): token = sys.argv[i + 1]
        elif a == '--tipo' and i + 1 < len(sys.argv): tipo = sys.argv[i + 1]
        elif a == '--salida' and i + 1 < len(sys.argv): salida = sys.argv[i + 1]
    if not token:
        token = token_nuevo()
        print('(token de invitado; para el catálogo completo usar el del amigo con --token)')

    acumulado = {}
    if os.path.exists(salida):
        try:
            acumulado = json.load(open(salida))
            print(f"(venia con {len(acumulado)} titulos guardados)")
        except Exception:
            pass

    base = titulos(token, tipo, 'psize=20&is_random=0')
    acumulado.update(base)
    print(f"sin filtro: {len(base)} titulos | acumulado {len(acumulado)}")

    pruebas = [('genero', g) for g in GENEROS] + [('area', a) for a in AREAS]
    for clase, valor in pruebas:
        if clase == 'genero':
            d = titulos(token, tipo, 'psize=20&is_random=1&type=' + urllib.parse.quote(valor))
        else:
            d = titulos(token, tipo, f'psize=20&is_random=1&area={valor}')
        nuevos = {k: v for k, v in d.items() if k not in acumulado}
        acumulado.update(d)
        print(f"  {clase} {valor:18s} -> {len(d):3d} ({len(nuevos):3d} nuevos) | acumulado {len(acumulado)}")
        time.sleep(0.25)

    # segunda pasada cruzando genero x area (solo si el avance se estanco)
    print('--- segunda pasada: genero x area ---')
    antes = len(acumulado)
    for g in GENEROS[:16]:
        for a in AREAS[:4]:
            d = titulos(token, tipo, f'psize=20&is_random=1&area={a}&type=' + urllib.parse.quote(g))
            nuevos = {k: v for k, v in d.items() if k not in acumulado}
            acumulado.update(d)
            if nuevos:
                print(f"  {g} + area {a}: {len(nuevos)} nuevos | acumulado {len(acumulado)}")
            time.sleep(0.2)
    print(f"segunda pasada aporto {len(acumulado) - antes} titulos")

    json.dump(acumulado, open(salida, 'w'), ensure_ascii=False, indent=1)
    print(f"\nTOTAL: {len(acumulado)} titulos distintos -> {salida}")
    print("Comprobar: si el barrido se estanca, el techo del invitado es menor que 70k"
          " y habra que usar el token de una cuenta (--token).")


if __name__ == '__main__':
    main()
