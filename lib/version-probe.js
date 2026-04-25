"use strict";

// Runtime discovery of the real ToCodex extension's published version.
//
// Why: the extension emits `User-Agent: ToCodex/${Zr.version}` where
// `Zr.version` is `require('./package.json').version` of the *installed*
// copy of the extension.  VSCode auto-updates extensions, so the value
// every real user sends on the wire floats forward whenever the ToCodex
// team ships a new Marketplace build — 3.1.3 today, 3.1.4 in two weeks,
// etc.  If the relay hardcodes `3.1.3` it eventually becomes an outlier
// in the upstream User-Agent / X-Roo-App-Version distribution.
//
// This module queries the VSCode Marketplace gallery API at startup, caches
// the result in memory for 24h, and exposes an async function the config
// layer can await before serving traffic.  On failure we fall back to the
// static default — the relay never blocks waiting for the probe.
//
// The endpoint is undocumented but stable; it is the same JSON API the
// Marketplace website calls to populate the extension detail page.

const https = require("node:https");

const GALLERY_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const GALLERY_HOST = "marketplace.visualstudio.com";
const GALLERY_PATH = "/_apis/public/gallery/extensionquery";

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const VERSION_RE = /^\d+\.\d+\.\d+$/u;

let cached = null; // { value, at }

// Reset for tests.
function _resetCache() {
  cached = null;
}

// Fetch the latest published version of ToCodex.tocodex from the VSCode
// Marketplace.  Returns a version string like "3.1.3" on success, or null
// on any failure (network, timeout, malformed response, non-semver).
function fetchLatestVersion({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      filters: [
        {
          criteria: [
            { filterType: 7, value: "ToCodex.tocodex" }, // ExtensionName
          ],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: 0x100, // IncludeLatestVersionOnly
    });

    const body = Buffer.from(payload);

    const req = https.request(
      {
        method: "POST",
        host: GALLERY_HOST,
        path: GALLERY_PATH,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;api-version=3.0-preview.1",
          "Content-Length": String(body.length),
          "User-Agent": "VSCode 1.117.0", // plausible but unremarkable UA
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const ext =
              parsed.results &&
              parsed.results[0] &&
              parsed.results[0].extensions &&
              parsed.results[0].extensions[0];
            const version =
              ext && ext.versions && ext.versions[0] && ext.versions[0].version;
            if (typeof version === "string" && VERSION_RE.test(version)) {
              resolve(version);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

// Public API: resolve the "best known" ToCodex version to impersonate.
// Order of preference:
//   1. Cached Marketplace probe result (<24h old)
//   2. Fresh Marketplace probe (with timeout)
//   3. Fallback — the caller-provided static value (typically
//      config.appVersion from env / hardcoded default).
//
// `opts.force = true` bypasses the cache, useful for tests and for
// manual refresh endpoints down the line.
async function resolveAppVersion(fallback, opts = {}) {
  const { force = false, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, now = Date.now } = opts;

  if (!force && cached && now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const probed = await fetchLatestVersion({ timeoutMs });
  if (probed) {
    cached = { value: probed, at: now() };
    return probed;
  }

  // Probe failed — return the caller fallback but do NOT cache it, so
  // the next call still attempts to refresh.
  return typeof fallback === "string" && VERSION_RE.test(fallback) ? fallback : "3.1.3";
}

module.exports = {
  resolveAppVersion,
  fetchLatestVersion,
  GALLERY_URL,
  VERSION_RE,
  DEFAULT_PROBE_TIMEOUT_MS,
  CACHE_TTL_MS,
  _resetCache,
};
