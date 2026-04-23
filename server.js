"use strict";

// ToCodex API relay / signing proxy
// ---------------------------------
// Reverse-engineered from the ToCodex VSCode extension (publisher ToCodex.tocodex, v3.1.3):
//
//   payload = `${unix_seconds}:${uuid_nonce}:${METHOD}:${path}`
//   sig     = HMAC-SHA256(TOCODEX_HMAC_SECRET, payload).hex()
//
// Headers attached to the upstream request:
//   X-ToCodex-Timestamp: <unix_seconds>
//   X-ToCodex-Nonce:     <uuid>
//   X-ToCodex-Sig:       <hex>
//
// The default secret hard-coded in the extension (fallback when env var is unset):
//   tc-hmac-s3cr3t-k3y-2026-tocodex-platform
//
// The relay exposes an OpenAI-compatible interface. Clients POST as usual:
//   POST http://127.0.0.1:8787/v1/chat/completions
//   Authorization: Bearer <your ToCodex session token>
//
// The relay forwards to `${TOCODEX_API_URL}/v1/chat/completions` (default
// https://api.tocodex.com/v1/chat/completions) after attaching the three
// signing headers plus the ToCodex default branding headers.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

loadDotEnv(path.join(process.cwd(), ".env"));

const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = toPort(process.env.PORT || process.env.LISTEN_PORT || "8787");
const HEALTH_PATH = normalizePrefix(process.env.HEALTH_PATH || "/_health");
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_ALLOW_HEADERS = process.env.CORS_ALLOW_HEADERS || "Content-Type, Authorization";
const CORS_ALLOW_METHODS = process.env.CORS_ALLOW_METHODS || "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const UPSTREAM_TIMEOUT_MS = toPositiveInt(process.env.UPSTREAM_TIMEOUT_MS || "600000");

// ToCodex-specific configuration ------------------------------------------------
const TOCODEX_HMAC_SECRET =
  process.env.TOCODEX_HMAC_SECRET || "tc-hmac-s3cr3t-k3y-2026-tocodex-platform";
const TOCODEX_API_URL = normalizeApiUrl(process.env.TOCODEX_API_URL || "https://api.tocodex.com");
const TOCODEX_DEFAULT_TOKEN = process.env.TOCODEX_API_KEY || "";
const TOCODEX_APP_VERSION = process.env.TOCODEX_APP_VERSION || "3.1.3";
const SIGN_ALL_PATHS = (process.env.TOCODEX_SIGN_ALL_PATHS || "false").toLowerCase() === "true";
const SIGNED_PATHS = new Set(
  (process.env.TOCODEX_SIGNED_PATHS || "/v1/chat/completions")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
);

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

// Headers that must be stripped from the *upstream response* before we forward
// it back to the client. Node's fetch (undici) transparently decompresses the
// body, so keeping the original `content-encoding` or `content-length` would
// make downstream clients (e.g. NewAPI) try to gunzip plaintext and fail with
// `gzip: invalid header`.
const upstreamStripResponseHeaders = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  addCorsHeaders(res);

  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "invalid_request", requestId });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const incomingUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (incomingUrl.pathname === HEALTH_PATH) {
    sendJson(res, 200, {
      ok: true,
      upstream: TOCODEX_API_URL.toString(),
      signingScheme: "HMAC-SHA256(secret, `${ts}:${nonce}:${METHOD}:${path}`)",
      signedPaths: SIGN_ALL_PATHS ? "*" : Array.from(SIGNED_PATHS),
      requestId,
    });
    return;
  }

  // Build the upstream URL. The client uses the same path as upstream,
  // e.g. /v1/chat/completions -> https://api.tocodex.com/v1/chat/completions
  const upstreamPath = ensureLeadingSlash(incomingUrl.pathname);
  const upstreamUrl = new URL(
    `${upstreamPath.replace(/^\/+/u, "")}${incomingUrl.search}`,
    TOCODEX_API_URL
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);

  // Abort the upstream fetch only when the *response socket* is closed
  // before we finish writing, i.e. the client really went away. Note that
  // `req.on('close')` fires as soon as the inbound body is fully consumed
  // (Node HTTP behavior), so using it here would abort the upstream the
  // moment the request body was uploaded — which manifested as spurious
  // "client disconnected" 502s under clients like NewAPI.
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort(new Error("client disconnected"));
    }
  });

  try {
    // Copy incoming headers, stripping hop-by-hop and anything that will be replaced.
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      const lower = key.toLowerCase();
      if (hopByHopHeaders.has(lower)) continue;
      // Don't forward the client's Accept-Encoding: Node's fetch will
      // transparently decompress any gzip'd upstream response, and if we
      // advertise gzip upstream the client would then receive decompressed
      // bytes alongside a `Content-Encoding: gzip` header (which we strip),
      // but it's cleaner to just ask upstream for identity bodies.
      if (lower === "accept-encoding") continue;
      if (lower === "authorization" && !TOCODEX_DEFAULT_TOKEN) {
        // keep client-provided token
      }
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("Accept-Encoding", "identity");

    // If server has a default token configured, override client authorization.
    if (TOCODEX_DEFAULT_TOKEN) {
      headers.set("Authorization", `Bearer ${TOCODEX_DEFAULT_TOKEN}`);
    } else if (!headers.has("authorization") && !headers.has("Authorization")) {
      sendJson(res, 401, {
        error: "missing_authorization",
        message: "Provide an Authorization: Bearer <token> header, or set TOCODEX_API_KEY on the relay.",
        requestId,
      });
      clearTimeout(timeout);
      return;
    }

    // ToCodex default branding headers (same as the extension sends).
    if (!headers.has("HTTP-Referer")) headers.set("HTTP-Referer", "https://github.com/tocodex/ToCodex");
    if (!headers.has("X-Title")) headers.set("X-Title", "ToCodex");
    if (!headers.has("User-Agent")) headers.set("User-Agent", `ToCodex/${TOCODEX_APP_VERSION}`);
    headers.set("X-Roo-App-Version", TOCODEX_APP_VERSION);

    // ToCodex dynamic signature --------------------------------------------
    const needSig = SIGN_ALL_PATHS || SIGNED_PATHS.has(upstreamPath);
    if (needSig) {
      const { timestamp, nonce, signature } = signToCodex({
        method: req.method,
        path: upstreamPath,
        secret: TOCODEX_HMAC_SECRET,
      });
      headers.set("X-ToCodex-Timestamp", timestamp);
      headers.set("X-ToCodex-Nonce", nonce);
      headers.set("X-ToCodex-Sig", signature);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    for (const [key, value] of upstreamResponse.headers) {
      const lower = key.toLowerCase();
      if (hopByHopHeaders.has(lower)) continue;
      if (upstreamStripResponseHeaders.has(lower)) continue;
      res.setHeader(key, value);
    }

    res.writeHead(upstreamResponse.status, upstreamResponse.statusText);

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    const bodyStream = Readable.fromWeb(upstreamResponse.body);
    bodyStream.on("error", (error) => {
      if (!res.writableEnded) {
        console.error(`[${requestId}] upstream body error:`, error);
        res.destroy(error);
      }
    });
    bodyStream.pipe(res);
  } catch (error) {
    const statusCode = error?.name === "AbortError" ? 504 : 502;
    console.error(`[${requestId}] relay error:`, error);
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: "upstream_request_failed",
        message: error instanceof Error ? error.message : String(error),
        requestId,
      });
    } else {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    clearTimeout(timeout);
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`ToCodex relay listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`upstream: ${TOCODEX_API_URL.toString()}`);
  console.log(`signed paths: ${SIGN_ALL_PATHS ? "*" : Array.from(SIGNED_PATHS).join(", ")}`);
});

// -------- helpers ------------------------------------------------------------

function signToCodex({ method, path, secret }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const payload = `${timestamp}:${nonce}:${method.toUpperCase()}:${path}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { timestamp, nonce, signature };
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function addCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
}

function sendJson(res, statusCode, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(statusCode);
  res.end(JSON.stringify(payload, null, 2));
}

function normalizeApiUrl(value) {
  // Mirror the extension: if it doesn't end with /v1, append /v1 (kept as base).
  let url = new URL(value);
  // strip trailing slash on pathname
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  if (!url.pathname.endsWith("/v1")) {
    // We keep the base WITHOUT /v1, because the client already provides /v1/... in the path.
    // If a user sets TOCODEX_API_URL=https://api.tocodex.com/v1, strip it to match the pattern.
    if (url.pathname === "/v1") url.pathname = "";
  }
  // Ensure trailing slash so that `new URL(rel, base)` works.
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function ensureLeadingSlash(p) {
  return p.startsWith("/") ? p : `/${p}`;
}

function normalizePrefix(value) {
  if (!value || value === "/") return "/";
  let normalized = value.startsWith("/") ? value : `/${value}`;
  normalized = normalized.replace(/\/+$/u, "");
  return normalized || "/";
}

function toPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function toPositiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return Math.floor(number);
}
