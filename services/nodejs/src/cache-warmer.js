const { XMLParser } = require("fast-xml-parser");
const fs = require("fs");
const path = require("path");

// CONFIGURATION
const SITEMAP_URL = "https://pbservices.ge/sitemap-index.xml";
const REQUEST_DELAY_MS = 2000; // 2s between requests
const DISCOVERY_CONCURRENCY = 3;
const RETRY_COUNT = 2;
const USER_AGENT = "SevallaCacheWarmerSafe-SecureToken-99x";
const SUMMARY_FILE = path.join(__dirname, "..", "cache-warmer-last-run.json");

const parser = new XMLParser({ ignoreAttributes: false });

// ── Concurrency guard: prevent overlapping runs ──
let isRunning = false;

// Concurrency limiter for sitemap discovery
class Semaphore {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

const discoverySem = new Semaphore(DISCOVERY_CONCURRENCY);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function extractLocs(root) {
  const locs = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    const keys = Object.keys(node);
    for (const key of keys) {
      if (key.endsWith("loc") && typeof node[key] === "string") {
        locs.push(node[key].trim());
      } else if (typeof node[key] === "object") {
        walk(node[key]);
      } else if (Array.isArray(node[key])) {
        node[key].forEach((item) => walk(item));
      }
    }
  }
  walk(root);
  return locs;
}

async function fetchSitemap(url, urlsSet) {
  await discoverySem.acquire();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parser.parse(text);

    const rootKey = Object.keys(parsed).find(
      (k) => k.includes("sitemapindex") || k.includes("urlset")
    );

    if (rootKey && rootKey.includes("sitemapindex")) {
      log(`[Index] Scanning directory: ${url}`);
      const locs = extractLocs(parsed[rootKey]);
      const results = await Promise.allSettled(
        locs.map((loc) => fetchSitemap(loc, urlsSet))
      );
      results.forEach((r, i) => {
        if (r.status === "rejected")
          log(`[ERROR] Sub-sitemap failed: ${locs[i]} — ${r.reason}`);
      });
    } else if (rootKey && rootKey.includes("urlset")) {
      const locs = extractLocs(parsed[rootKey]);
      locs.forEach((loc) => urlsSet.add(loc));
    }
  } catch (e) {
    log(`[ERROR] Failed processing sitemap ${url}: ${e.message}`);
  } finally {
    discoverySem.release();
  }
}

/**
 * Warms a single URL. Returns { ok, status, error, kinsta, cdn, edge, redirected, finalUrl }.
 */
async function warmUrl(url) {
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      const kinsta = (res.headers.get("X-Kinsta-Cache") || "MISSING").toUpperCase();
      const cdn = (res.headers.get("CF-Cache-Status") || "MISSING").toUpperCase();
      const edge = (res.headers.get("Ki-Cf-Cache-Status") || "MISSING").toUpperCase();
      log(`[${res.status}] Kinsta: ${kinsta} | CDN: ${cdn} | Edge: ${edge} | Time: ${duration}s -> ${url}`);
      return { ok: true, status: res.status, kinsta, cdn, edge, redirected: res.redirected, finalUrl: res.url };
    } catch (e) {
      if (attempt < RETRY_COUNT) {
        const backoff = 2 ** attempt;
        log(`[RETRY ${attempt + 1}/${RETRY_COUNT}] ${url} — ${e.message}. Waiting ${backoff}s...`);
        await sleep(backoff * 1000);
      } else {
        log(`[ERROR] Failed to warm page ${url}: ${e.message}`);
        return { ok: false, status: null, error: e.message, url };
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Stats helpers ──

function initStats() {
  return { hit: 0, miss: 0, bypass: 0, unknown: 0, unknownBy: {} };
}

function tallyStats(stats, value) {
  const v = (value || "").toLowerCase();
  if (v === "hit") stats.hit++;
  else if (v === "miss") stats.miss++;
  else if (v === "bypass") stats.bypass++;
  else {
    stats.unknown++;
    stats.unknownBy[v] = (stats.unknownBy[v] || 0) + 1;
  }
}

/** Returns true if the uppercased cache value is a known status (not UNKNOWN). */
function isKnownCache(value) {
  const v = (value || "").toLowerCase();
  return v === "hit" || v === "miss" || v === "bypass";
}

function formatStats(label, stats, total) {
  const pct = (n) => total > 0 ? ` (${((n / total) * 100).toFixed(1)}%)` : "";
  let line = `${label}: ${stats.hit} HIT${pct(stats.hit)}, ${stats.miss} MISS${pct(stats.miss)}, ${stats.bypass} BYPASS${pct(stats.bypass)}`;
  if (stats.unknown > 0) {
    const breakdown = Object.entries(stats.unknownBy)
      .map(([k, v]) => `${v} ${k.toUpperCase()}`)
      .join(", ");
    line += ` | ${breakdown}`;
  }
  return line;
}

/** Merge per-status stats into a single rollup. */
function rollupStats(perStatus) {
  const rollup = { kinsta: initStats(), cdn: initStats(), edge: initStats() };
  for (const entry of Object.values(perStatus)) {
    for (const layer of ["kinsta", "cdn", "edge"]) {
      for (const k of ["hit", "miss", "bypass", "unknown"]) {
        rollup[layer][k] += entry[layer][k];
      }
      // Merge unknownBy maps
      for (const [val, count] of Object.entries(entry[layer].unknownBy)) {
        rollup[layer].unknownBy[val] = (rollup[layer].unknownBy[val] || 0) + count;
      }
    }
  }
  return rollup;
}

async function runWarmer() {
  if (isRunning) {
    log("[SKIP] Warmer is already running — concurrent run prevented.");
    return;
  }
  isRunning = true;

  const startTime = new Date().toISOString();

  // ── Nested stats: { "200": { count, urls[], redirects[], unknowns[], kinsta, cdn, edge }, ... } ──
  const perStatus = {};
  const failedUrls = [];     // [{ url, error }] — no HTTP response, sits outside perStatus

  try {
    log("--- Starting Sitemap Discovery Phase ---");
    const urlsSet = new Set();
    await fetchSitemap(SITEMAP_URL, urlsSet);

    const allPages = [...urlsSet];
    if (!allPages.length) {
      log("[Warning] No page URLs discovered.");
      return;
    }

    log(`--- Discovery Finished: Unique Pages Found: ${allPages.length} ---`);
    log("--- Beginning Safe Sequential Warming Loop ---");

    for (const url of allPages) {
      const result = await warmUrl(url);
      if (result.ok) {
        const code = String(result.status);

        // Init per-status bucket on first encounter
        if (!perStatus[code]) {
          perStatus[code] = {
            count: 0,
            urls: [],
            redirects: [],
            unknowns: [],
            kinsta: initStats(),
            cdn: initStats(),
            edge: initStats(),
          };
        }
        const bucket = perStatus[code];
        bucket.count++;
        bucket.urls.push(url);
        tallyStats(bucket.kinsta, result.kinsta);
        tallyStats(bucket.cdn, result.cdn);
        tallyStats(bucket.edge, result.edge);

        // Track UNKNOWN cache values nested under this status code
        if (!isKnownCache(result.kinsta)) bucket.unknowns.push({ url, header: "Kinsta", value: result.kinsta });
        if (!isKnownCache(result.cdn))   bucket.unknowns.push({ url, header: "CDN",    value: result.cdn });
        if (!isKnownCache(result.edge))  bucket.unknowns.push({ url, header: "Edge",   value: result.edge });

        // Track redirects nested under this status code
        if (result.redirected) {
          bucket.redirects.push({ from: url, to: result.finalUrl });
        }
      } else {
        failedUrls.push({ url, error: result.error });
      }
      await sleep(REQUEST_DELAY_MS);
    }

    // ── Compute rollup ──
    const endTime = new Date().toISOString();
    const total = allPages.length;
    const ok = total - failedUrls.length;
    const fail = failedUrls.length;
    const rollup = rollupStats(perStatus);

    // ── Summary ──
    const summaryLines = [
      "",
      "═══════════════════════════════════════════",
      "           CACHE WARMER — SUMMARY           ",
      "═══════════════════════════════════════════",
      `Started:     ${startTime}`,
      `Finished:    ${endTime}`,
      `Total URLs:  ${total}`,
      `Successful:  ${ok}`,
      `Failed:      ${fail}`,
      "",
      "── Cache Status (totals) ──",
      formatStats("Kinsta", rollup.kinsta, ok),
      formatStats("CDN   ", rollup.cdn, ok),
      formatStats("Edge  ", rollup.edge, ok),
      "",
      "── Status Codes ──",
      ...(() => {
        const codes = Object.keys(perStatus).sort((a, b) => a.localeCompare(b));
        return codes.map((code) => {
          const pct = ((perStatus[code].count / ok) * 100).toFixed(1);
          return `  ${code}: ${perStatus[code].count} (${pct}%)`;
        });
      })(),
      "",
      "── Per Status Code ──",
    ];

    // Sort codes: 2xx first, then 3xx, 4xx, 5xx
    const sortedCodes = Object.keys(perStatus).sort((a, b) => {
      const ga = a[0], gb = b[0];
      if (ga === gb) return a.localeCompare(b);
      return ga.localeCompare(gb);
    });

    // Helper: get non-standard entries for a specific layer
    const layerUnknowns = (bucket, layer) =>
      bucket.unknowns.filter((u) => u.header === layer);

    for (const code of sortedCodes) {
      const b = perStatus[code];
      summaryLines.push(`  ${code}: ${b.count} requests`);

      // Kinsta
      summaryLines.push(`    Kinsta: ${formatStats("", b.kinsta, b.count).replace(/^\S+\s*/, "")}`);
      layerUnknowns(b, "Kinsta").forEach((u) =>
        summaryLines.push(`      ${u.value}: ${u.url}`));

      // CDN
      summaryLines.push(`    CDN:    ${formatStats("", b.cdn, b.count).replace(/^\S+\s*/, "")}`);
      layerUnknowns(b, "CDN").forEach((u) =>
        summaryLines.push(`      ${u.value}: ${u.url}`));

      // Edge
      summaryLines.push(`    Edge:   ${formatStats("", b.edge, b.count).replace(/^\S+\s*/, "")}`);
      layerUnknowns(b, "Edge").forEach((u) =>
        summaryLines.push(`      ${u.value}: ${u.url}`));

      // List URLs for non-2xx status codes
      if (code[0] !== "2") {
        const icon = code[0] === "3" ? "↳" : "✗";
        summaryLines.push(`    URLs:`);
        b.urls.forEach((u) => summaryLines.push(`      ${icon} ${u}`));
      }

      // Nested redirects under this status code
      if (b.redirects.length > 0) {
        summaryLines.push(`    Redirects:`);
        b.redirects.forEach((r) => summaryLines.push(`      ↳ ${r.from}\n      → ${r.to}`));
      }
    }

    if (failedUrls.length > 0) {
      summaryLines.push("", "── Failed (no HTTP response) ──");
      failedUrls.forEach((f) =>
        summaryLines.push(`  ✗ ${f.url}\n    Reason: ${f.error}`)
      );
    }

    summaryLines.push(
      "",
      "═══════════════════════════════════════════",
      ""
    );

    const summaryText = summaryLines.join("\n");
    console.log(summaryText);

    // Persist summary to disk for `npm run logs`
    const statusCodes = {};
    const redirectUrls = [];
    const unknowns = [];
    for (const [code, b] of Object.entries(perStatus)) {
      statusCodes[code] = b.count;
      redirectUrls.push(...b.redirects);
      unknowns.push(...b.unknowns);
    }

    const summaryJson = {
      started: startTime,
      finished: endTime,
      total,
      successful: ok,
      failed: fail,
      statusCodes,
      kinsta: rollup.kinsta,
      cdn: rollup.cdn,
      edge: rollup.edge,
      perStatus,
      redirectUrls,
      unknowns,
      failedUrls,
    };
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaryJson, null, 2));
    log(`Summary saved to ${SUMMARY_FILE}`);

    log("Cache warming cycle completed cleanly.");
  } finally {
    isRunning = false;
  }
}

module.exports = { runWarmer };
