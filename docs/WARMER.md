# Cache Warmer — Documentation

## Overview

The cache warmer (`services/nodejs/src/cache-warmer.js`) is a Node.js script deployed on [Sevalla](https://sevalla.com) that visits every URL listed in the site's XML sitemap on a schedule, ensuring pages stay cached at all three cache layers (Kinsta server cache, Cloudflare CDN, and Kinsta Edge). It runs daily via cron at 01:00 UTC.

## How It Works

### Phase 1: Sitemap Discovery

1. Fetches the sitemap index at `https://pbservices.ge/sitemap-index.xml`
2. Recursively traverses all sub-sitemaps with concurrency limit of 3 (via `Semaphore`)
3. Extracts all `<loc>` URLs into a deduplicated `Set`
4. Typically discovers ~548 unique page URLs

### Phase 2: Sequential Warming

1. Iterates through all discovered URLs **sequentially** (one at a time)
2. Fetches each URL with a 2-second delay between requests (`REQUEST_DELAY_MS = 2000`)
3. Each URL is retried up to 2 times on failure with exponential backoff
4. Reads cache-status response headers from each fetch
5. After warming all URLs, prints a summary and persists results to `cache-warmer-last-run.json`

### Concurrency Guard

An `isRunning` lock prevents overlapping manual runs from stacking on top of a cron-triggered run. If a second run is attempted while one is in progress, it logs `[SKIP]` and exits.

## Cache Status Headers

The warmer reads three HTTP response headers to determine cache state:

| Warmer Label | HTTP Header | Cache Layer | Possible Values |
|---|---|---|---|
| **Kinsta** | `X-Kinsta-Cache` | Kinsta server-level page cache | `HIT`, `MISS`, `BYPASS`, `EXPIRED`, `STALE` |
| **CDN** | `CF-Cache-Status` | Cloudflare CDN edge cache | `HIT`, `MISS`, `BYPASS`, `EXPIRED`, `DYNAMIC`, `STALE` |
| **Edge** | `Ki-Cf-Cache-Status` | Kinsta Cloudflare-integration edge | `HIT`, `MISS`, `BYPASS` |

The tally logic in `tallyStats()` (line 143 of `cache-warmer.js`) normalizes values to lowercase and counts each as `HIT`, `MISS`, `BYPASS`, or `UNKNOWN` (any unrecognized value).

## Configuration

| Constant | Default | Description |
|---|---|---|
| `SITEMAP_URL` | `https://pbservices.ge/sitemap-index.xml` | Sitemap index entry point |
| `REQUEST_DELAY_MS` | `2000` | Delay between individual URL requests (2s) |
| `DISCOVERY_CONCURRENCY` | `3` | Max parallel sitemap fetches during discovery |
| `RETRY_COUNT` | `2` | Retry attempts per URL on failure |
| `USER_AGENT` | `SevallaCacheWarmerSafe-SecureToken-99x` | Custom User-Agent header |

## Why Warmer Stats Differ from Kinsta Analytics

This is by design — the two measure fundamentally different things:

### Scope Mismatch

| | Warmer | Kinsta Analytics |
|---|---|---|
| **URLs measured** | ~548 static sitemap pages | All site URLs (thousands) |
| **Time window** | ~18 minutes (01:00–01:18 UTC) | 1 hour / 24 hours (user-selectable) |
| **Traffic sources** | Only the warmer itself | Real users, bots, crawlers, APIs, logged-in sessions |

### Why the Warmer Shows 100% HIT

- On the **first ever run**, those 548 URLs were MISSes that populated the cache.
- On **every subsequent daily run**, they are HITs because the previous run already warmed them and static sitemap pages rarely change.
- The 2-second pacing ensures no request floods the origin.
- **The warmer measures its own success** — it proves the targeted sitemap pages stay warm, not that the entire site is cached.

### Where Analytics MISS / BYPASS / Non-Cached Come From

These come from traffic the warmer **never touches**:

| Source | Reason Excluded from Warmer |
|---|---|
| Dynamic pages (`/wp-admin/`, REST API, Ajax) | Not in sitemap; often cache-bypassed by design |
| Pages with query strings (`?s=search`, `?utm_source=...`) | Each unique query = separate cache key |
| Logged-in user sessions | WordPress auth cookies → `BYPASS` |
| Bot/crawler traffic (Googlebot, etc.) | Hits pages not in sitemap, or with different headers |
| POST / PUT / DELETE requests | Never cached at any layer |
| Recently published/updated content | Cache purged on save → next visit is MISS |
| `/wp-cron.php`, `/xmlrpc.php` | Not in sitemap |

### CDN & Edge Absorb Most Traffic

In a healthy setup, the CDN (Cloudflare) and Edge (Kinsta Edge) layers serve the majority of requests **before they reach the origin server cache**. This is the cache hierarchy working as designed:

```
User → CDN (CF-Cache-Status) → Edge (Ki-Cf-Cache-Status) → Origin (X-Kinsta-Cache)
```

A high CDN/Edge HIT rate with lower server-cache numbers means the edge layers are doing their job — reducing origin load.

## Granular Stats (v2 — 2026-07-20)

### Nested Architecture

Stats are grouped **per HTTP status code**. Each status code bucket contains its own cache counters (Kinsta, CDN, Edge) plus the list of URLs that returned that code. A top-level rollup is computed from the nested data, so the summary shows both:

```
── Cache Status (totals) ──
Kinsta: 548 HIT (100.0%), 0 MISS, 0 BYPASS

── Per Status Code ──
  200: 545 requests
    Kinsta: 545 HIT (100.0%), 0 MISS, 0 BYPASS
    CDN:    544 HIT (99.8%), 0 MISS, 1 UNKNOWN
    Edge:   544 HIT (99.8%), 0 MISS, 1 UNKNOWN
  404: 3 requests
    ✗ https://example.com/missing-1
    ✗ https://example.com/missing-2
    Kinsta: 3 HIT (100.0%), 0 MISS, 0 BYPASS
```

### URL Lists for Non-2xx Codes

For any status code outside the 2xx range (3xx redirects, 4xx client errors, 5xx server errors), each URL is listed individually under its status bucket. 2xx codes suppress URL lists to keep output manageable (hundreds of URLs).

> **Note:** `fetch()` follows redirects automatically, so a true 301 is never seen as the final status — the final code will be the redirect destination's code (usually 200). The redirect list (`── Redirects ──`) captures the origin → destination mapping separately.

### UNKNOWN Tracking

Any cache header value that isn't `HIT`, `MISS`, or `BYPASS` (e.g., `DYNAMIC`, `EXPIRED`, `STALE`, or a missing header) is captured with full detail: which URL, which header layer (Kinsta/CDN/Edge), and the raw value. Displayed under `── UNKNOWN Details ──` and persisted in the `unknowns` array.

### Uppercase Cache Labels

Cache header values are normalized to uppercase (`HIT`, `MISS`, `BYPASS`, `UNKNOWN`) in both per-URL log lines and the summary. Tally comparison remains case-insensitive.

## Interpreting the Numbers

### Healthy Pattern
- Warmer: 100% Kinsta HIT → sitemap pages are fully warmed
- Analytics: High CDN + Edge counts → edge layers absorbing traffic
- Analytics: Low server-cache MISS/BYPASS relative to total → origin not overloaded

### Warning Signs
- Warmer shows MISS on sitemap pages → cache was purged or expired; check if warmer schedule lapsed
- Analytics shows high server-cache MISS on known static pages → cache TTL may be too short
- Analytics shows high BYPASS → investigate cookie/query-string bypass rules

## Running Manually

```bash
# Via Sevalla cron or SSH
node -e "const {runWarmer}=require('./src/cache-warmer'); runWarmer();"
```

## Viewing Last Run Summary

```bash
npm run logs
# or directly:
node -e "const s=require('./cache-warmer-last-run.json'); console.log('Last run:', s.started, '→', s.finished); console.log('Total:', s.total, '| OK:', s.successful, '| Failed:', s.failed); if(s.statusCodes){ console.log('Status codes:', JSON.stringify(s.statusCodes)); } console.log('Kinsta:', JSON.stringify(s.kinsta)); console.log('CDN:', JSON.stringify(s.cdn)); console.log('Edge:', JSON.stringify(s.edge)); if(s.redirectUrls&&s.redirectUrls.length){ console.log('Redirects:'); s.redirectUrls.forEach(r=>console.log('  ↳', r.from, '→', r.to)); } if(s.failedUrls&&s.failedUrls.length){ console.log('Failed URLs:'); s.failedUrls.forEach(f=>console.log('  ✗', f.url, '-', f.error)); }"
```

## File Map

| File | Purpose |
|---|---|
| `services/nodejs/src/cache-warmer.js` | Main warmer logic |
| `services/nodejs/cache-warmer-last-run.json` | Persisted last-run summary (auto-generated) |
| `services/nodejs/scripts/sevalla-warmer.sh` | Sevalla cron wrapper script |
| `services/nodejs/scripts/sevalla-summary.sh` | Shell script to display last-run summary |
