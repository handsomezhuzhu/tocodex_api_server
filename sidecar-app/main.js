"use strict";

// Electron-hosted TLS proxy for the ToCodex relay.
//
// Architecture
// ------------
// A tiny HTTP server runs inside Electron 39's main-process Node, and the
// relay forwards every upstream request through it. Because Electron's
// Node uses BoringSSL (not OpenSSL like vanilla Node), the ClientHello
// bytes on the wire match what the real ToCodex VSCode extension emits.
// Confirmed against tls.peet.ws: this process produces ja3_hash
// `1a3153f314dc13e133dc71d113a81b16` for `globalThis.fetch` — identical
// to what the extension would send on any api.tocodex.com call.
//
// Protocol
// --------
// The sidecar listens on a kernel-chosen TCP port and writes:
//
//     SIDECAR_PORT=<port>\n
//
// to stdout.  The relay parses that line, then every upstream call
// becomes:
//
//     POST http://127.0.0.1:<port>/proxy
//     Content-Type: application/json
//     Body: {
//       "url": "https://api.tocodex.com/...",
//       "method": "POST",
//       "headers": [["Name","Value"], ...],
//       "body_b64": "<base64>" | null,
//       "timeout_ms": 600000
//     }
//
// The response mirrors the upstream status/headers/body verbatim.
// Errors from the upstream call surface as 502.
//
// All requests are issued via `globalThis.fetch` (undici) because that
// is what both the OpenAI Node SDK (this.fetch = c.fetch ?? zin() where
// zin() returns fetch) and posthog-node use inside the real extension.
// Using node:https here would produce a different JA3 that WAF rules
// can cross-reference with an API path to flag the relay.

const { app } = require("electron");
const http = require("node:http");
const { Readable } = require("node:stream");

const DEFAULT_TIMEOUT_MS = 600000;
const SHUTDOWN_TIMEOUT_MS = 5000;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 50 * 1024 * 1024) {
        reject(new Error("request body > 50MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendError(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

async function proxyRequest(spec, clientRes) {
  if (!spec || !spec.url) {
    sendError(clientRes, 400, { error: "bad_spec", message: "url required" });
    return;
  }
  // Build a Headers object preserving caller-supplied insertion order.
  const headers = new Headers();
  for (const pair of spec.headers || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    if (pair[1] == null) continue;
    headers.append(String(pair[0]), String(pair[1]));
  }
  const body = spec.body_b64 ? Buffer.from(spec.body_b64, "base64") : undefined;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), spec.timeout_ms || DEFAULT_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(spec.url, {
      method: spec.method || "GET",
      headers,
      body,
      signal: ctrl.signal,
    });
    // Mirror upstream status + headers 1:1.
    const flatHeaders = [];
    for (const [k, v] of upstreamRes.headers) flatHeaders.push(k, v);
    clientRes.writeHead(upstreamRes.status, upstreamRes.statusText, flatHeaders);
    if (upstreamRes.body) {
      const readable = Readable.fromWeb(upstreamRes.body);
      readable.on("error", () => clientRes.destroy());
      readable.pipe(clientRes);
    } else {
      clientRes.end();
    }
  } catch (err) {
    sendError(clientRes, 502, {
      error: "upstream_error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(to);
  }
}

function handleHealth(req, res) {
  const body = Buffer.from(
    JSON.stringify({
      ok: true,
      sidecar: "tocodex-tls-sidecar",
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    })
  );
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

function startSidecar() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/proxy") {
      parseBody(req)
        .then((spec) => proxyRequest(spec, res))
        .catch((err) => sendError(res, 400, { error: "bad_request", message: err.message }));
      return;
    }
    if (req.method === "GET" && req.url === "/_health") return handleHealth(req, res);
    sendError(res, 404, { error: "not_found" });
  });

  server.on("error", (err) => {
    console.error("sidecar server error:", err);
    app.exit(1);
  });

  const host = process.env.SIDECAR_HOST || "127.0.0.1";
  const port = Number(process.env.SIDECAR_PORT) || 0;
  server.listen(port, host, () => {
    const addr = server.address();
    process.stdout.write(`SIDECAR_PORT=${addr.port}\n`);
    if (process.env.TOCODEX_DEBUG_SIDECAR === "1") {
      console.error(
        `[sidecar] listening on ${host}:${addr.port} ` +
          `(electron ${process.versions.electron}, node ${process.versions.node})`
      );
    }
  });

  // Graceful-ish shutdown: when parent closes our stdin we exit.
  process.stdin.on("end", () => {
    server.close(() => app.exit(0));
    setTimeout(() => app.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  });
  process.stdin.resume();
}

app.commandLine.appendSwitch("no-sandbox");
app.whenReady().then(startSidecar);

app.on("window-all-closed", () => {
  /* we have no windows; stay alive until stdin closes */
});
