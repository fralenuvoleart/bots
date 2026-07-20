# Active Context

## Current Focus

Project is `automations` — two service runtimes:
- `services/nodejs/` — Telegram bot + cache warmer (production, deployed on Sevalla)
- `services/python/` — placeholder for future AI/NLP services

## Recent Changes

- **2026-07-20**: Added forwarded message deep link to Integrately webhook in [`telegram-bot.js`](../services/nodejs/src/telegram-bot.js):
  - `forwardMessage` return value now captured (`fwdMsg.message_id`)
  - Deep link constructed: `https://t.me/c/{cleanGroupId}/{message_id}` (strips `-100` prefix from supergroup ID)
  - `forwardedMessageLink` field added to webhook payload (null-safe: falls back to `null` if forward fails)
  - Applies to first-contact webhook only (existing scope unchanged)
- **2026-07-20**: Fixed [`sevalla-warmer.sh`](../services/nodejs/scripts/sevalla-warmer.sh) — now uses `sh -c "nohup npm run warmer &"` to background the warmer. Sevalla exec API has max 60s timeout; the warmer takes ~18min. Also corrected `timeout` field (API max is 60, was sending 300).
- **2026-07-20**: Deleted root `package.json` — confirmed unreferenced by any shell script, JS file, Sevalla action, or quick command. Deploys use `services/nodejs/package.json` exclusively.
- **2026-07-20**: Fixed [`index.js`](../services/nodejs/index.js) — `bot.launch()` now wrapped in retry logic (5 attempts, 3s delay) for 409 Conflict errors. Added global `unhandledRejection` handler to prevent unexpected promise rejections from crashing the entire process (logs them instead).
- **2026-07-20**: Fixed [`sevalla-warmer.sh`](../services/nodejs/scripts/sevalla-warmer.sh) and [`sevalla-summary.sh`](../services/nodejs/scripts/sevalla-summary.sh) — both scripts now show HTTP status code and ✓/✗ feedback instead of silent output. Uses `curl -w` to capture status, checks 2xx range, and falls back to `output`/`error` fields if `stdout`/`stderr` are absent.
- **2026-07-20**: Enhanced [`cache-warmer.js`](../services/nodejs/src/cache-warmer.js) — nested stats architecture:
  - Stats grouped per HTTP status code with independent cache counters (Kinsta/CDN/Edge)
  - Top-level rollup computed from nested data; summary shows both totals and per-status drill-down
  - Non-2xx status codes list each URL individually in the summary
  - UNKNOWN cache values tracked with full detail: which URL, which header layer, raw value
  - Redirect detection via `res.redirected` — lists `from → to` for any redirected URLs
  - Cache header values uppercased in logs and display (`HIT`/`MISS`/`BYPASS`)
  - New persisted fields: `perStatus`, `unknowns`, `redirectUrls`, `statusCodes`
  - `npm run logs` updated with backward-compatible null checks
- **2026-07-20**: Created [`docs/WARMER.md`](../docs/WARMER.md) — comprehensive documentation covering warmer logic, cache header semantics, configuration, and explanation of why warmer stats (548 sitemap URLs, 100% HIT) differ from Kinsta Analytics (all traffic, includes MISS/BYPASS/non-cached).
- **2026-07-19**: Patched [`telegram-bot.js`](../services/nodejs/src/telegram-bot.js) — 6 fixes applied:
  1. `t()` helper no longer coerces missing `name` to `"undefined"` string
  2. Deep-clone via `JSON.parse(JSON.stringify())` prevents env-var overrides from mutating the `require()`-cached messages
  3. `startPayloads` Map entries now deleted after first use (memory leak fixed)
  4. `forwardMessage` and auto-reply now retry on failure (2 retries, exponential backoff)
  5. Integrately webhook `fetch` now retries on failure
  6. Per-user rate limiting added: max 3 messages per 10-second window
- **2026-07-19**: Enhanced [`cache-warmer.js`](../services/nodejs/src/cache-warmer.js) — 4 features added:
  1. Concurrency guard (`isRunning` lock) prevents overlapping manual + cron runs
  2. Cache stats tracking: Kinsta (`X-Kinsta-Cache`), CDN (`CF-Cache-Status`), Edge (`Ki-Cf-Cache-Status`) — each tallied HIT/MISS/BYPASS/UNKNOWN
  3. Failed URLs tracked with error reasons, printed in summary
  4. Summary persisted to `cache-warmer-last-run.json`; readable via `npm run logs`
- Extracted bot logic from `index.js` → [`src/telegram-bot.js`](../services/nodejs/src/telegram-bot.js) for self-documenting structure
- Renamed `src/warmer.js` → [`src/cache-warmer.js`](../services/nodejs/src/cache-warmer.js)
- [`index.js`](../services/nodejs/index.js) is now a thin wiring layer: imports bot + warmer, starts cron
- Removed old `pbs-telegram/` directory — fully migrated

## Prior Tasks (Completed)

- Cache warmer JS rewrite (from Python)
- Repo restructuring to `automations/` layout
- Production readiness fixes (concurrency limiting, retries, graceful shutdown, timestamped logging)
- Descriptive file naming for discoverability
