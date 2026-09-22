#!/usr/bin/env python3
"""Audita todos los capítulos de las series Ennovelas que pasaron la auditoría.
HTTP-only: capítulo -> embed -> VK HLS -> master -> variante -> primer segmento."""
from __future__ import annotations
import argparse, concurrent.futures, datetime as dt, importlib.util, json
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('enn_audit', Path(__file__).with_name('auditar-ennovelas-http.py'))
MOD = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MOD)


def series_eps(item):
    s = MOD.requests.Session()
    try:
        r = MOD.get(s, item['url'], timeout=30)
        if not r.ok:
            return item, [], f'series_http_{r.status_code}'
        return item, MOD.parse_episode_links(r.text, item['slug']), ''
    except Exception as exc:
        return item, [], 'series_request:' + type(exc).__name__


def one(task):
    item, ep = task
    s = MOD.requests.Session()
    try:
        r = MOD.probe_episode(s, ep)
        return {'slug': item['slug'], 'title': item['title'], **r}
    except Exception as exc:
        return {'slug': item['slug'], 'title': item['title'], 'episode': ep.get('ep'), 'url': ep.get('url'), 'ok': False, 'error': 'exception:' + type(exc).__name__}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--infile', default='public/enn-funcionan.json'); ap.add_argument('--workers', type=int, default=10); ap.add_argument('--limit', type=int, default=0); args = ap.parse_args()
    report = json.loads(Path(args.infile).read_text(encoding='utf-8'))
    series = [x for x in report.get('items', []) if x.get('ok')]
    tasks=[]; series_errors=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(32, max(1,args.workers))) as pool:
        for item, eps, err in pool.map(series_eps, series):
            if err:
                series_errors.append({'slug':item['slug'], 'error':err}); continue
            tasks.extend((item, ep) for ep in eps)
    if args.limit: tasks=tasks[:args.limit]
    print(f'[enn-episodes] {len(series)} series · {len(tasks)} episodios · {args.workers} hilos', flush=True)
    results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,args.workers)) as pool:
        futs=[pool.submit(one,t) for t in tasks]
        for n,f in enumerate(concurrent.futures.as_completed(futs),1):
            results.append(f.result())
            if n%100==0 or n==len(futs):
                ok=sum(1 for x in results if x.get('ok'))
                print(f'[enn-episodes] {n}/{len(futs)} · OK {ok} · muertos {n-ok}',flush=True)
    results.sort(key=lambda x:(x['slug'], x.get('episode',0), x.get('url','')))
    ok=[x for x in results if x.get('ok')]; bad=[x for x in results if not x.get('ok')]
    now=dt.datetime.now(dt.timezone.utc)
    out={'version':1,'source':MOD.BASE,'mode':'HTTP-only capítulo×capítulo: embed → VK HLS → primer segmento','finishedAt':now.isoformat(),'seriesAudited':len(series),'episodesAudited':len(results),'workingEpisodes':len(ok),'deadEpisodes':len(bad),'seriesErrors':series_errors,'items':results}
    Path('public/enn-episodios.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    Path('public/enn-episodios-vistas.txt').write_text('\n'.join(x['url'] for x in ok)+'\n',encoding='utf-8')
    Path('public/enn-episodios-ocultos.txt').write_text('\n'.join(x['url']+'\t'+x.get('error','') for x in bad)+'\n',encoding='utf-8')
    from collections import Counter
    Path('public/enn-episodios-resumen.md').write_text('\n'.join([
      '# Auditoría de episodios Ennovelas', '',
      f'- Series auditadas: {len(series)}.', f'- Episodios auditados: {len(results)}.', f'- HLS funcional: {len(ok)}.', f'- Ocultos: {len(bad)}.',
      '- Método: HTTP-only, sin navegador/iframe/Puppeteer; se comprobó el primer segmento HLS.', f'- Ejecutada: {now.isoformat()}.', '', '## Motivos', '',
      *[f'- `{k}`: {v}' for k,v in sorted(Counter(x.get('error','') for x in bad).items())],
    ])+'\n',encoding='utf-8')
    print(f'[enn-episodes] terminado: {len(ok)} OK / {len(bad)} ocultos')

if __name__=='__main__': main()
