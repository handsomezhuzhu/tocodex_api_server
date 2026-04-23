"use strict";

// ToCodex API relay — main entry.
//
// Dispatches incoming HTTP requests to one of three paths:
//
//   * OpenAI-style passthrough  (POST /v1/chat/completions, GET /v1/models, ...)
//       → signs the upstream request if needed and streams the response body
//         back to the client untouched. Zero JSON parsing, zero copies of the
//         message body. This is what NewAPI / OneAPI / plain OpenAI clients use.
//
//   * Anthropic Messages        (POST /anthropic/v1/messages, ...)
//       → translates the client payload to OpenAI chat.completions, signs it,
//         and translates the streamed response back to Anthropic SSE.
//
//   * OpenAI Responses          (POST /v1/responses)
//       → translates the client payload to OpenAI chat.completions (with
//         optional previous_response_id history), signs it, and translates
//         the streamed response back to Responses SSE.
//
// The Anthropic and Responses paths are registered lazily via `lib/anthropic`
// and `lib/responses` respectively (added in later commits). Until they are
// wired in, everything falls through to the passthrough handler.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const { loadConfig, signedHeaders, upstreamUrl } = require("./lib/sign");
const { resolveApiKey } = require("./lib/util");

loadDotEnv(path.join(process.cwd(), ".env"));

const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = toPort(process.env.PORT || process.env.LISTEN_PORT || "8787");
const HEALTH_PATH = normalizePrefix(process.env.HEALTH_PATH || "/_health");
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_ALLOW_HEADERS = process.env.CORS_ALLOW_HEADERS || "Content-Type, Authorization";
const CORS_ALLOW_METHODS = process.env.CORS_ALLOW_METHODS || "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const UPSTREAM_TIMEOUT_MS = toPositiveInt(process.env.UPSTREAM_TIMEOUT_MS || "600000");

const CONFIG = loadConfig(process.env);

// Headers never copied in either direction.
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

// Upstream response headers that must be dropped because Node's fetch
// (undici) already decompressed the body for us; forwarding them would make
// downstream clients (e.g. NewAPI) try to gunzip plaintext.
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
      upstream: CONFIG.apiUrl.toString(),
      signingScheme: "HMAC-SHA256(secret, `${ts}:${nonce}:${METHOD}:${path}`)",
      signedPaths: CONFIG.signAllPaths ? "*" : Array.from(CONFIG.signedPaths),
      routes: {
        openai: ["POST /v1/chat/completions", "GET /v1/models"],
        anthropic: ["(coming next)"],
        responses: ["(coming next)"],
      },
      requestId,
    });
    return;
  }

  // Only the passthrough path exists right now. Anthropic/Responses routes
  // are added in later commits and will be dispatched ahead of this.
  await handlePassthrough(req, res, incomingUrl, requestId);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`ToCodex relay listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`upstream: ${CONFIG.apiUrl.toString()}`);
  console.log(
    `signed paths: ${CONFIG.signAllPaths ? "*" : Array.from(CONFIG.signedPaths).join(", ")}`
  );
});

// --- Passthrough ------------------------------------------------------------

async function handlePassthrough(req, res, incomingUrl, requestId) {
  const upstreamPath = incomingUrl.pathname.startsWith("/")
    ? incomingUrl.pathname
    : `/${incomingUrl.pathname}`;
  const targetUrl = upstreamUrl(CONFIG, `${upstreamPath}${incomingUrl.search}`);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("upstream timeout")),
    UPSTREAM_TIMEOUT_MS
  );

  // Abort the upstream fetch only when the *response socket* is closed
  // before we finish writing, i.e. the client really went away. `req.close`
  // fires as soon as the inbound body is fully consumed, which isn't the
  // same thing.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  });

  try {
    const headers = buildPassthroughHeaders(req, upstreamPath);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstreamResponse = await fetch(targetUrl, {
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
}

function buildPassthroughHeaders(req, upstreamPath) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    // Ask upstream for identity bodies so downstream doesn't get lied to
    // about encoding (see upstreamStripResponseHeaders note above).
    if (lower === "accept-encoding") continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("Accept-Encoding", "identity");

  // Authorization: override if the relay has a pinned token.
  if (CONFIG.defaultApiKey) {
    headers.set("Authorization", `Bearer ${CONFIG.defaultApiKey}`);
  }

  // ToCodex branding headers — match what the extension sends.
  if (!headers.has("HTTP-Referer")) headers.set("HTTP-Referer", CONFIG.referer);
  if (!headers.has("X-Title")) headers.set("X-Title", CONFIG.title);
  if (!headers.has("User-Agent")) headers.set("User-Agent", `ToCodex/${CONFIG.appVersion}`);
  headers.set("X-Roo-App-Version", CONFIG.appVersion);

  // Dynamic signature — only on paths we know are signed by the extension.
  const needSig = CONFIG.signAllPaths || CONFIG.signedPaths.has(upstreamPath);
  if (needSig) {
    // Reuse the canonical signing helper so all call sites stay in sync.
    const signed = signedHeaders(CONFIG, {
      method: req.method,
      path: upstreamPath,
      // We deliberately do NOT pass apiKey here — the extension signs based on
      // method+path only, not the token. Auth was set above.
    });
    // Copy only the 3 signing headers + X-Roo-App-Version (already set) so we
    // don't overwrite the Authorization we put in.
    for (const h of ["X-ToCodex-Timestamp", "X-ToCodex-Nonce", "X-ToCodex-Sig"]) {
      headers.set(h, signed[h]);
    }
  }

  return headers;
}

// --- Helpers ----------------------------------------------------------------

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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

// eslint-disable-next-line no-unused-vars
function _unused(resolveApiKey) {
  // resolveApiKey is exported for protocol translators; imported here to keep
  // them colocated and in-scope once Anthropic/Responses routes land.
}
