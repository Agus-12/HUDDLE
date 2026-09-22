#!/usr/bin/env python3
"""Obtiene títulos de AnimeD23 y guarda portadas IMDb locales.

La página de AnimeD23 conserva prioridad cuando entrega una imagen válida; la
mapa IMDb se usa para las tarjetas del feed como respaldo/curaduría estable y
nunca altera las URLs ni la auditoría de reproducción.
"""
from __future__ import annotations
import concurrent.futures, datetime as dt, html, json, re
from pathlib import Path
from urllib.parse import quote
import requests

ROOT=Path(__file__).resolve().parents[1]
slugs=[x.strip() for x in (ROOT/'public/d23-slugs.txt').read_text().splitlines() if x.strip()]
hidden={x.strip() for x in (ROOT/'public/d23-ocultas.txt').read_text().splitlines() if x.strip()}
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
OUT=ROOT/'public/d23-imdb-covers.json'; COVERS=ROOT/'public/covers/d23/imdb'; COVERS.mkdir(parents=True,exist_ok=True)

def clean_title(s,slug):
    s=html.unescape(re.sub(r'\s+',' ',s or '')).strip()
    s=re.sub(r'\s*\|.*$','',s).strip()
    s=re.sub(r'\s*[-–—]\s*AnimeD23.*$','',s,flags=re.I).strip()
    return s[:120] or slug.replace('-',' ').title()

def page_title(slug):
    u=f'https://animed23.com/anime/{slug}/'
    try:
        r=requests.get(u,headers={'User-Agent':UA},timeout=18); text=r.text if r.ok else ''
        for pat in [r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)',r'<h1[^>]*>([^<]+)</h1>',r'<title[^>]*>([^<]+)</title>']:
            m=re.search(pat,text,re.I)
            if m:return clean_title(m.group(1),slug)
    except Exception: pass
    return clean_title('',slug)

def imdb(title):
    raw=re.sub(r'\s+',' ',title.lower().strip())
    candidates=[raw]
    clean=re.sub(r'\s*\(?20\d{2}\)?','',raw)
    clean=re.sub(r'\s+(?:anime|pel[ií]cula|ova|sub|espa[nñ]ol|latino|castellano|sin censura).*$','',clean).strip()
    clean=re.sub(r'\s+temporada(?:\s+final)?$','',clean).strip()
    if clean and clean not in candidates:candidates.append(clean)
    for q in candidates:
        first=re.sub(r'[^a-z0-9]','',q)[:1] or 'x'
        try:
            u=f'https://v2.sg.media-imdb.com/suggestion/{quote(first)}/{quote(q)}.json'
            r=requests.get(u,headers={'User-Agent':UA},timeout=18); data=r.json() if r.ok else {}
        except Exception: continue
        for x in data.get('d',[]):
            img=(x.get('i') or {}).get('imageUrl','')
            if img and x.get('qid') in {'tvSeries','tvMiniSeries','movie'}:
                return {'id':x.get('id',''),'name':x.get('l',''),'source':img.replace('._V1_.jpg','._V1_QL75_UX380_.jpg')}
    return {}

def one(slug):
    title=page_title(slug); info=imdb(title); local=''
    if info.get('source'):
        try:
            r=requests.get(info['source'],headers={'User-Agent':UA},timeout=25); r.raise_for_status()
            (COVERS/f'{slug}.jpg').write_bytes(r.content); local=f'/covers/d23/imdb/{slug}.jpg'
        except Exception: pass
    return slug, {'slug':slug,'title':title,'imdb':info,'poster':local,'page':'https://animed23.com/anime/'+slug+'/', 'hidden':slug in hidden}

def main():
    target=[s for s in slugs if s not in hidden]
    out={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for n,(slug,row) in enumerate(pool.map(one,target),1):
            out[slug]=row
            if n%25==0: print(n,'/',len(target),flush=True)
    report={'version':1,'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'source':'AnimeD23 pages + IMDb suggestion API','totalSlugs':len(slugs),'visibleSlugs':len(target),'imdbCovers':sum(bool(x.get('poster')) for x in out.values()),'items':out}
    OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('visible',len(target),'IMDb',report['imdbCovers'])
if __name__=='__main__': main()
