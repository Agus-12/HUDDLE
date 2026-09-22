#!/usr/bin/env python3
"""Auditoría HTTP-only de Ennovelas.

No usa navegador, iframe ni reproductor: enumera el catálogo, abre las fichas y
comprueba un máximo de dos episodios representativos por serie hasta el HLS y
el primer segmento. El JSON de salida se consume por server.js como allowlist
persistente de series comprobadas.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import html as htmlmod
import json
import re
from pathlib import Path
from urllib.parse import urljoin

import requests

BASE = "https://l.ennovelas-tv.com/"
SERIES_BASE = BASE + "series/"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9,en;q=0.8"}
VK_HEADERS = {"User-Agent": UA, "Accept": "*/*"}
GENERIC_BAD = re.compile(r"(?:danfra|vip|paywall|pago|premium|suscri(?:pc|b))", re.I)
SLUG_RE = re.compile(r'<a href="https://l\.ennovelas-tv\.com/series/([a-z0-9-]+)/"[^>]*title="([^"]+)"', re.I)
EP_RE = re.compile(r'href="(https://l\.ennovelas-tv\.com/([a-z0-9-]+-capitulo-(\d+)[a-z0-9-]*)/?)["]', re.I)


def get(session: requests.Session, url: str, *, referer: str = "", timeout: float = 25, **kwargs):
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    return session.get(url, headers=headers, timeout=timeout, allow_redirects=True, **kwargs)


def cover_from_block(block: str) -> str:
    m = re.search(r'data-img="background-image:url\(([^)]+)\)"', block, re.I)
    if not m:
        return ""
    u = m.group(1).strip(" '\"")
    if u.startswith("//"):
        u = "https:" + u
    return u if u.startswith("http") and not re.search(r"grey\.gif|logo|33333", u, re.I) else ""


def enum_catalog(session: requests.Session, max_pages: int = 20):
    out = {}
    pages = 0
    for page in range(1, max_pages + 1):
        url = SERIES_BASE if page == 1 else SERIES_BASE + f"page/{page}/"
        try:
            r = get(session, url, timeout=20)
            if r.status_code != 200:
                break
            pages += 1
            text = r.text
        except Exception:
            break
        matches = list(SLUG_RE.finditer(text))
        if not matches:
            break
        for m in matches:
            slug, title = m.group(1), htmlmod.unescape(m.group(2)).strip()
            if slug in out:
                continue
            block = text[m.start(): m.start() + 2400]
            out[slug] = {"slug": slug, "title": title[:100], "url": SERIES_BASE + slug + "/", "img": cover_from_block(block)}
    return list(out.values()), pages


def parse_episode_links(text: str, slug: str):
    seen, rows = set(), []
    for m in EP_RE.finditer(text):
        url, ep_slug, num = m.group(1), m.group(2), int(m.group(3))
        if not (ep_slug == slug + "-capitulo-" + str(num) or ep_slug.startswith(slug + "-capitulo-")):
            continue
        url = url.rstrip("/") + "/"
        if url in seen or num < 1 or num > 5000:
            continue
        seen.add(url)
        rows.append({"url": url, "ep": num})
    if not rows:
        for m in re.finditer(r'href="(https://l\.ennovelas-tv\.com/([a-z0-9-]+-capitulo-(\d+)[a-z0-9-]*)/?)["]', text, re.I):
            url, _, num = m.group(1), m.group(2), int(m.group(3))
            url = url.rstrip("/") + "/"
            if url in seen or num < 1 or num > 5000:
                continue
            seen.add(url)
            rows.append({"url": url, "ep": num})
    return sorted(rows, key=lambda x: (x["ep"], x["url"]))


def hls_from_vk(session: requests.Session, vk_url: str, referer: str):
    m = re.search(r"video_ext\.php\?oid=(\d+).*?id=(\d+)", vk_url, re.I)
    if not m:
        return None, "vk_ids"
    oid, vid = m.group(1), m.group(2)
    al = f"https://vk.com/al_video.php?act=show&al=1&video={oid}_{vid}"
    try:
        r = session.get(al, headers={**VK_HEADERS, "Referer": vk_url}, timeout=12)
        if not r.ok:
            return None, f"vk_http_{r.status_code}"
        raw = r.content.decode("utf-8", "replace").replace("\\/", "/").replace("\\u002f", "/").replace("\\u0026", "&").replace("&amp;", "&")
        m3 = re.search(r'"hls"\s*:\s*"(https?://[^" ]+\.m3u8[^" ]*)"', raw, re.I) or re.search(r'(https?://[^"\'<>\s]+\.m3u8(?:\?[^"\'<>\s]*)?)', raw, re.I)
        if not m3:
            return None, "vk_no_hls"
        return m3.group(1), "ok"
    except requests.RequestException as exc:
        return None, "vk_request:" + type(exc).__name__


def probe_hls(session: requests.Session, master: str, referer: str):
    headers = {"User-Agent": UA, "Referer": referer}
    try:
        r = session.get(master, headers=headers, timeout=12)
        if not r.ok:
            return False, f"hls_master_{r.status_code}"
        variants = [x.strip() for x in r.text.splitlines() if x.strip() and not x.startswith("#")]
        if not variants:
            return False, "hls_no_variant"
        variant = urljoin(r.url, variants[0])
        rv = session.get(variant, headers=headers, timeout=12)
        if not rv.ok:
            return False, f"hls_variant_{rv.status_code}"
        segs = [x.strip() for x in rv.text.splitlines() if x.strip() and not x.startswith("#")]
        if not segs:
            return False, "hls_no_segment"
        rs = session.get(urljoin(rv.url, segs[0]), headers={**headers, "Range": "bytes=0-2047"}, timeout=12)
        if rs.status_code not in (200, 206) or len(rs.content) < 100:
            return False, f"hls_segment_{rs.status_code}"
        return True, "ok"
    except requests.RequestException as exc:
        return False, "hls_request:" + type(exc).__name__


def probe_episode(session: requests.Session, ep: dict):
    url = ep["url"]
    try:
        r = get(session, url, referer=BASE, timeout=15)
        if not r.ok:
            return {"episode": ep["ep"], "url": url, "ok": False, "error": f"episode_http_{r.status_code}"}
        text = r.text
        if GENERIC_BAD.search(text):
            return {"episode": ep["ep"], "url": url, "ok": False, "error": "paywall_or_danfra"}
        embeds = []
        for m in re.finditer(r'content="(https://l\.ennovelas-tv\.com/emb/\?vid=\d+)"', text, re.I):
            embeds.append(m.group(1))
        for m in re.finditer(r"https://l\.ennovelas-tv\.com/emb/\?vid=\d+", text, re.I):
            embeds.append(m.group(0))
        # No se abre ni se usa un iframe remoto; solo embeds HTTP o VK explícitos.
        embeds = list(dict.fromkeys(embeds))
        if not embeds:
            return {"episode": ep["ep"], "url": url, "ok": False, "error": "no_embed"}
        last = "no_supported_embed"
        for emb in embeds:
            er = get(session, emb, referer=url, timeout=12)
            if not er.ok:
                last = f"embed_http_{er.status_code}"; continue
            et = er.text
            vks = re.findall(r'https://vk\.com/video_ext\.php\?[^"\'<> ]+', et, re.I)
            if not vks:
                last = "embed_no_vk"; continue
            for vk in vks:
                hls, why = hls_from_vk(session, vk, emb)
                if not hls:
                    last = why; continue
                ok, why2 = probe_hls(session, hls, vk)
                if ok:
                    return {"episode": ep["ep"], "url": url, "ok": True, "embed": emb, "vk": vk, "hls": "ok"}
                last = why2
        return {"episode": ep["ep"], "url": url, "ok": False, "error": last}
    except requests.RequestException as exc:
        return {"episode": ep["ep"], "url": url, "ok": False, "error": "episode_request:" + type(exc).__name__}
    except Exception as exc:
        return {"episode": ep["ep"], "url": url, "ok": False, "error": "exception:" + type(exc).__name__}


def audit_one(item: dict, attempts: int = 2):
    s = requests.Session()
    try:
        r = get(s, item["url"], timeout=20)
        if not r.ok:
            return {**item, "episodes": 0, "ok": False, "error": f"series_http_{r.status_code}", "probes": []}
        eps = parse_episode_links(r.text, item["slug"])
        probes = []
        for ep in eps[:attempts]:
            p = probe_episode(s, ep); probes.append(p)
            if p.get("ok"):
                return {**item, "episodes": len(eps), "ok": True, "error": "", "probe": p, "probes": probes}
        return {**item, "episodes": len(eps), "ok": False, "error": probes[-1].get("error", "no_playable_episode") if probes else "no_episodes", "probes": probes}
    except requests.RequestException as exc:
        return {**item, "episodes": 0, "ok": False, "error": "series_request:" + type(exc).__name__, "probes": []}
    except Exception as exc:
        return {**item, "episodes": 0, "ok": False, "error": "exception:" + type(exc).__name__, "probes": []}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default="public/enn-funcionan.json"); ap.add_argument("--workers", type=int, default=10); ap.add_argument("--attempts", type=int, default=2); args = ap.parse_args()
    started = dt.datetime.now(dt.timezone.utc); catalog, pages = enum_catalog(requests.Session())
    if not catalog: raise SystemExit("Ennovelas no entregó catálogo")
    results = []; print(f"[enn-audit] {len(catalog)} series en {pages} páginas; HTTP/HLS con {args.workers} hilos", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(audit_one, item, max(1, args.attempts)): item for item in catalog}
        for n, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            result = fut.result(); results.append(result)
            if n % 10 == 0 or n == len(catalog):
                ok = sum(1 for x in results if x.get("ok")); print(f"[enn-audit] {n}/{len(catalog)} · OK {ok} · muertas {n-ok}", flush=True)
    results.sort(key=lambda x: x["slug"]); ok = [x for x in results if x.get("ok")]; bad = [x for x in results if not x.get("ok")]; finished = dt.datetime.now(dt.timezone.utc)
    report = {"version": 1, "source": BASE, "mode": "HTTP-only: ficha → episodio → embed → VK HLS master → variante → primer segmento", "startedAt": started.isoformat(), "finishedAt": finished.isoformat(), "catalogPages": pages, "totalSeries": len(results), "workingSeries": len(ok), "deadSeries": len(bad), "sampleEpisodesPerSeries": max(1, args.attempts), "items": results}
    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    Path("public/enn-vistas.txt").write_text("\n".join(x["slug"] for x in ok) + "\n", encoding="utf-8")
    Path("public/enn-ocultas.txt").write_text("\n".join(f"{x['slug']}\t{x.get('error','')}" for x in bad) + ("\n" if bad else ""), encoding="utf-8")
    from collections import Counter
    summary = ["# Auditoría HTTP de Ennovelas", "", f"- Catálogo: {len(results)} series en {pages} páginas.", f"- Funcionales: {len(ok)}.", f"- Ocultas por muertas/paywall/sin reproductor: {len(bad)}.", f"- Método: {report['mode']}.", f"- Ejecutada: {finished.isoformat()}.", "- `enn-vistas.txt` es la allowlist visible; `enn-ocultas.txt` permanece fuera de Huddle hasta que una sonda HTTP la rehabilite.", "", "## Motivos de las ocultas", ""]
    summary += [f"- `{k}`: {v}" for k, v in sorted(Counter(x.get("error", "") for x in bad).items())]
    Path("public/enn-auditoria.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(f"[enn-audit] terminado: {len(ok)} OK / {len(bad)} ocultas; salida {out}")


if __name__ == "__main__": main()
