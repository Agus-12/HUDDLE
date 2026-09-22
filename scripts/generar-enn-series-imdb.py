#!/usr/bin/env python3
"""Construye la ficha técnica persistente de Ennovelas.

Agrupa temporadas que Ennovelas publica como series separadas y descarga una
portada de serie desde IMDb para el feed/historial. Los capítulos siguen usando
sus URLs HLS auditadas; este archivo solo describe presentación y agrupación.
"""
from __future__ import annotations
import datetime as dt
import json
import re
from pathlib import Path
from urllib.parse import quote
import requests

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'public' / 'enn-funcionan.json'
OUT = ROOT / 'public' / 'enn-series-grupos.json'
COVERS = ROOT / 'public' / 'covers' / 'enn' / 'imdb'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36'


def suffix(slug: str):
    m = re.search(r'-(\d+)-temporada$', slug, re.I)
    if m: return slug[:m.start()], int(m.group(1))
    m = re.search(r'-(\d+)$', slug, re.I)
    if m: return slug[:m.start()], int(m.group(1))
    return slug, None


def build_groups(items):
    by = {x['slug']: x for x in items}
    candidates = {}
    for x in items:
        stem, n = suffix(x['slug'])
        candidates.setdefault(stem, []).append((x, n))
    # Una serie base se agrupa solo si hay dos o más temporadas reconocibles.
    groups = []
    for stem, members in sorted(candidates.items()):
        if len(members) < 2:
            continue
        nums = [n for _, n in members if n is not None]
        if len(nums) < 2 and not any(x['slug'] == stem for x, _ in members):
            continue
        base = by.get(stem)
        ordered = sorted(members, key=lambda z: (z[1] if z[1] is not None else 1, z[0]['slug']))
        canonical = base['slug'] if base else ordered[0][0]['slug']
        title = base['title'] if base else re.sub(r'\s+\d+(?:\s+temporada)?$', '', ordered[0][0]['title'], flags=re.I).strip()
        groups.append((stem, canonical, title or stem.replace('-', ' ').title(), ordered))
    grouped = {x['slug']: False for x in items}
    result = []
    for stem, canonical, title, members in groups:
        # no dupliques grupos que hayan quedado absorbidos por otro stem
        if any(grouped.get(x['slug']) for x, _ in members):
            continue
        rows=[]
        for x,n in members:
            grouped[x['slug']] = True
            rows.append({'slug':x['slug'], 'title':x['title'], 'season':n or 1, 'episodes':x.get('episodes',0), 'url':x['url']})
        result.append({'slug':canonical, 'title':title, 'members':rows})
    for x in items:
        if not grouped[x['slug']]:
            result.append({'slug':x['slug'], 'title':x['title'], 'members':[{'slug':x['slug'],'title':x['title'],'season':1,'episodes':x.get('episodes',0),'url':x['url']}]})
    return sorted(result, key=lambda g: (0 if g['slug']=='yo-soy-betty-la-fea' else 1, g['title'].lower()))


def imdb(query):
    q = query.strip().lower()
    if not q: return {}
    first = re.sub(r'[^a-z0-9]', '', q)[:1] or 'x'
    u = f'https://v2.sg.media-imdb.com/suggestion/{quote(first)}/{quote(q)}.json'
    try:
        r=requests.get(u,headers={'User-Agent':UA},timeout=20); r.raise_for_status(); data=r.json()
    except Exception:
        return {}
    for x in data.get('d',[]):
        img=(x.get('i') or {}).get('imageUrl','')
        if img and x.get('qid') in {'tvSeries','tvMiniSeries','movie'}:
            img=img.replace('._V1_.jpg','._V1_QL75_UX380_.jpg')
            return {'id':x.get('id',''), 'name':x.get('l',''), 'source':img}
    return {}


def main():
    report=json.loads(REPORT.read_text(encoding='utf-8'))
    # Incluye también las series ocultas para que, si una sonda las revive,
    # regresen dentro de la misma familia/temporadas sin crear otra tarjeta.
    items=list(report.get('items',[]))
    groups=build_groups(items)
    ok_slugs={x['slug'] for x in items if x.get('ok')}
    COVERS.mkdir(parents=True,exist_ok=True)
    for g in groups:
        if not any(m['slug'] in ok_slugs for m in g['members']):
            g['imdb']={}; g['poster']=''; continue
        info=imdb(g['title'])
        g['imdb']=info
        local=''
        if info.get('source'):
            try:
                r=requests.get(info['source'],headers={'User-Agent':UA},timeout=30); r.raise_for_status()
                fn=COVERS/f"{g['slug']}.jpg"; fn.write_bytes(r.content); local=f'/covers/enn/imdb/{g["slug"]}.jpg'
            except Exception:
                pass
        g['poster']=local or ''
    out={'version':1,'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'source':'IMDb suggestion API + media-amazon poster','seriesAudited':len(items),'groups':groups}
    OUT.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{len(items)} series -> {len(groups)} feed groups; posters {sum(bool(g.get("poster")) for g in groups)}')

if __name__=='__main__': main()
