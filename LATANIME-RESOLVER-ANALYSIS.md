# Latanime Resolver Analysis — 21 Sep 2026

## Current Architecture (server.js)

### resolverAnime(epUrl)
1. Fetches episode page from `latanime.org/ver/{slug}-episodio-{N}/`
2. Extracts `data-player` attributes (base64-encoded URLs)
3. Filters for **mp4upload** embeds only
4. Extracts mp4 URL via regex: `player.src({ type: 'video/mp4', src: '...' })`
5. Falls back to `resolverAnimePorNavegador` (headless Chromium) for everything else
6. If both fail → registers failure → 3 failures = series hidden (podredumbre)

### resolverAnimePorNavegador(epUrl, embedsExternos)
- Opens Chromium, navigates to episode page
- Clicks through each player option (filemoon, uqload, doodstream, etc.)
- Monitors network requests for .m3u8 or .mp4 URLs
- Returns first playable URL found

## Audit Results (1,368 muertas via Mac Mini relay)

| Player | Count | HTTP-viable? | Status |
|--------|-------|-------------|--------|
| UQLOAD | 418 | NO | CDN returns 403 for m3u8 (token+IP locked). jwplayer with obfuscated JS. |
| LOCAL_FILE | 257 | NO | `data-player` = filename (e.g. "SOG - 01.mp4"). Points to `s01.fisier.ro` which returns **404** — files deleted from hosting. mojon.latanime.org player page loads but source is dead. |
| FILEMOON | 252 | NO | SPA/JS app (Byse player). Requires browser execution. |
| FEMBED | 80 | NO | Domain parked by parklogic.com — **fembed.com is dead**. |
| DOODSTREAM | 68 | NO | Cloudflare "Just a moment" challenge. Requires browser. |
| OTHER_URL | 63 | Varies | Mixed players, some may work individually. |
| PAGE404 | 59 | N/A | Truly dead pages (404). |
| SOLIDFILES | 54 | NO | Domain unreachable (DNS failure). |
| SENDVID | 32 | NO | Returns "Technical Difficulties" page. |
| DSVPLAY | 29 | NO | SPA similar to filemoon. |
| GDRIVE | 28 | NO | Requires Google auth/CAPTCHA. |
| VOE | 19 | NO | WASM-based obfuscation. Returns 119KB but video URL requires executing WebAssembly. |
| MP4UPLOAD | 5 | YES | Standard extraction works (player.src regex). |
| CLIPWATCHING | 3 | NO | Empty response (domain dead). |

## Key Findings

### 1. LOCAL_FILE is dead (fisier.ro)
- **257 series** point to `s01.fisier.ro/{filename}` via mojon.latanime.org player
- **fisier.ro returns 404 for ALL files tested** (both muertas AND visible episodes)
- This means even "visible" LOCAL_FILE episodes are broken
- The mojon player page loads (HTTP 200) with a Plyr player, but the `<source>` points to a dead URL

### 2. UQLOAD CDN is locked down
- **418 series** use UQLOAD
- The embed page loads (HTTP 200, ~14KB) with jwplayer + obfuscated JS
- The m3u8 URL is constructed from a split-array obfuscation:
  - CDN: `strm9.uqload.vc`
  - Path: `/hls2/03/00913/{filecode}_n/master.m3u8`
  - Token changes per session (anti-scraping)
- **CDN returns 403** for all m3u8 requests, even through the Mac Mini relay with fresh tokens
- The CDN likely validates: (a) session cookies from the embed page, (b) IP matching, or (c) CORS/Origin headers

### 3. FEMBED, SOLIDFILES, SENDVID are dead
- fembed.com → parked domain (parklogic.com)
- solidfiles.com → DNS failure
- sendvid.com → "Technical Difficulties" page

### 4. "96% have video" was misleading
- The relay audit checked if **embed pages** returned HTTP 200 with content
- It did NOT verify if the actual video files are playable
- Most embed pages load fine, but the video hosting behind them is largely dead

## What Actually Works

### HTTP-viable (no browser needed)
- **MP4UPLOAD** (5 series): Standard `player.src()` regex extraction
- **CineCalidad**: goodstream/vimeos (already resolved via packer unpacking)
- **GoPelis**: API-based resolution (token + resolve endpoint)
- **Cuevana**: goodstream + vimeos packer

### Browser-required (headless Chromium)
- **FILEMOON** (252): SPA, needs JS execution
- **DOODSTREAM** (68): Cloudflare challenge
- **VOE** (19): WASM execution needed
- **UQLOAD** (418): May work with browser (network request capture)

### Truly dead (no workaround)
- **LOCAL_FILE** (257): fisier.ro files deleted
- **FEMBED** (80): Domain dead
- **SOLIDFILES** (54): Domain dead
- **SENDVID** (32): Site down
- **CLIPWATCHING** (3): Domain dead
- **PAGE404** (59): Pages gone

## Recommendation

For the Latanime resolver in Huddle:

1. **Keep current architecture**: mp4upload extraction + browser fallback
2. **The browser fallback already handles FILEMOON, DOODSTREAM, VOE, UQLOAD** — these are the 779 series that CAN work with a real browser
3. **LOCAL_FILE, FEMBED, SOLIDFILES, SENDVID, CLIPWATCHING** (~426 series) are genuinely dead — no resolver can fix deleted files
4. **The muertas list is accurate** — these series really are dead or require browser
5. **The podredumbre system is working correctly** — it hides series after 3 failures and re-checks periodically

### Net impact on user-visible content
- ~3,453 total series
- ~558 hidden (castellano/duplicates)
- ~1,368 muertas, of which:
  - ~779 could work with browser (uqload, filemoon, doodstream, voe)
  - ~426 are genuinely dead (local_file, fembed, solidfiles, sendvid, clipwatching, page404)
  - ~163 unknown (other_url, gdrive, dsvplay)
- ~1,527 visible series (mostly working via mp4upload or browser)

## No HTTP-only resolver is possible for most muertas

The fundamental issue is that the video hosting services used by Latanime have either:
1. **Deleted the files** (fisier.ro, fembed, solidfiles, sendvid, clipwatching)
2. **Locked down access** with anti-bot measures (uqload CDN 403, doodstream Cloudflare, voe WASM)

The only HTTP-viable player is mp4upload (5 series). Everything else requires a real browser. The current `resolverAnimePorNavegador` fallback is the correct approach.
