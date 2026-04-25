"use strict";

// Client side of the Electron-hosted TLS sidecar.
//
// The sidecar is a separate process (Electron 39, headless) launched by
// server.js.  It exposes a tiny POST /proxy interface on a kernel-chosen
// loopback port; we route every upstream call through it so the wire-side
// JA3/JA4 fingerprint matches what a real VSCode extension produces.
//
// See sidecar-app/main.js for the protocol description.
//
// This module exports:
//   - launchSidecar(opts):       spawn Electron, return { port, child, dispose }
//   - request(url, opts):        same shape as lib/http-client.request,
//                                but proxied through the sidecar
//
// When TOCODEX_DISABLE_SIDECAR=1 (or no Electron binary is available),
// callers should fall back to lib/http-client directly.

const child_process = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");

const DEFAULT_SIDECAR_DIR = path.join(__dirname, "..", "sidecar-app");

const PORT_LINE_RE = /^SIDECAR_PORT=(\d+)\s*$/u;

const HTTP_AGENT = new http.Agent({ keepAlive: true });

function candidatePaths() {
  return [
    process.env.TOCODEX_ELECTRON_BIN,
    "/opt/electron/electron",
    "/usr/local/lib/electron/electron",
    path.join(process.cwd(), "vendor/electron/electron"),
  ].filter(Boolean);
}

function findElectronBinary() {
  for (const p of candidatePaths()) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Look up an executable on PATH.  Used to decide whether xvfb-run is
// available before we depend on it.
function hasExecutable(name) {
  const PATH = process.env.PATH || "";
  for (const dir of PATH.split(":")) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

// Launch the Electron sidecar.  Returns a Promise that resolves with
// { port, child, dispose } once the sidecar prints its SIDECAR_PORT line.
//
// Rejects if:
//   - no Electron binary can be located
//   - the sidecar exits before printing a port
//   - we don't see a port within `startupTimeoutMs`
function launchSidecar({
  electronBin,
  sidecarDir,
  startupTimeoutMs = 10000,
  env,
} = {}) {
  return new Promise((resolve, reject) => {
    const bin = electronBin || findElectronBinary();
    if (!bin) {
      reject(new Error("electron binary not found (set TOCODEX_ELECTRON_BIN)"));
      return;
    }
    const dir = sidecarDir || DEFAULT_SIDECAR_DIR;
    if (!fs.existsSync(path.join(dir, "main.js"))) {
      reject(new Error(`sidecar app not found: ${dir}/main.js`));
      return;
    }

    // On headless Linux containers Electron's main process refuses to
    // initialise without an X display.  Wrap with xvfb-run when we can
    // detect that condition: Linux + no DISPLAY + xvfb-run is on PATH.
    let cmd = bin;
    let args = ["--no-sandbox", dir];
    const onLinux = process.platform === "linux";
    const needsXvfb =
      onLinux &&
      !process.env.DISPLAY &&
      process.env.TOCODEX_NO_XVFB !== "1" &&
      hasExecutable("xvfb-run");
    if (needsXvfb) {
      cmd = "xvfb-run";
      // -a picks an unused server number automatically; --server-args
      // shrinks Xvfb to the bare minimum we need (no extensions, tiny
      // screen).  electron + dir become positional args after that.
      args = [
        "-a",
        "--server-args=-screen 0 1024x768x24 -ac +extension GLX +render -noreset",
        bin,
        "--no-sandbox",
        dir,
      ];
    }

    const child = child_process.spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    let resolved = false;
    let stdoutBuf = "";

    const settle = (fn, value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(reject, new Error(`sidecar startup timeout after ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const m = PORT_LINE_RE.exec(line);
        if (m) {
          const port = Number(m[1]);
          settle(resolve, {
            port,
            child,
            dispose: () => {
              try {
                child.stdin.end();
              } catch {
                /* ignore */
              }
              setTimeout(() => {
                try {
                  child.kill("SIGTERM");
                } catch {
                  /* ignore */
                }
              }, 1000).unref();
            },
          });
          return;
        }
      }
    });

    child.on("exit", (code, signal) => {
      settle(reject, new Error(`sidecar exited before announcing port (code=${code} sig=${signal})`));
    });
    child.on("error", (err) => settle(reject, err));
  });
}

// Issue an upstream request through a launched sidecar.
//
// Same call signature as lib/http-client.request:
//   request(url, { method, headers, body, signal, timeoutMs })
//
// The sidecar always uses globalThis.fetch (undici) for outbound work
// because that is what the real ToCodex extension does. Legacy callers
// may still pass `transport: "node-https"` — it is silently ignored and
// the sidecar serves the request via fetch regardless.
function request(sidecar, url, {
  method = "GET",
  headers,
  body,
  signal,
  timeoutMs,
  // transport is accepted for back-compat; sidecar ignores it.
  transport: _transport,
} = {}) {
  void _transport;
  if (!sidecar || typeof sidecar.port !== "number") {
    return Promise.reject(new Error("sidecar not launched"));
  }
  const target = url instanceof URL ? url : new URL(url);

  // Normalise headers to [[k,v], ...] for the wire payload.
  let headerPairs = [];
  if (headers && typeof headers.toFlat === "function") {
    const flat = headers.toFlat();
    for (let i = 0; i < flat.length; i += 2) headerPairs.push([flat[i], flat[i + 1]]);
  } else if (Array.isArray(headers)) {
    if (headers.length && Array.isArray(headers[0])) headerPairs = headers.slice();
    else for (let i = 0; i < headers.length; i += 2) headerPairs.push([headers[i], headers[i + 1]]);
  } else if (headers && typeof headers === "object") {
    for (const k of Object.keys(headers)) headerPairs.push([k, headers[k]]);
  }

  // Buffer body to base64.  The sidecar's /proxy endpoint receives a
  // single JSON document and emits the upstream response as a stream,
  // so requests cannot themselves be streamed; this is fine because
  // the relay already buffers bodies for size validation.
  let bodyB64;
  if (body instanceof Buffer) bodyB64 = body.toString("base64");
  else if (typeof body === "string") bodyB64 = Buffer.from(body, "utf8").toString("base64");
  else if (body && typeof body.pipe === "function") {
    return readStream(body).then((buf) =>
      request(sidecar, url, {
        method,
        headers,
        body: buf,
        signal,
        timeoutMs,
      })
    );
  }

  const payload = JSON.stringify({
    url: target.toString(),
    method,
    headers: headerPairs,
    body_b64: bodyB64,
    timeout_ms: typeof timeoutMs === "number" ? timeoutMs : undefined,
  });
  const payloadBuf = Buffer.from(payload, "utf8");

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        host: "127.0.0.1",
        port: sidecar.port,
        path: "/proxy",
        agent: HTTP_AGENT,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payloadBuf.length),
        },
      },
      (res) => {
        const outHeaders = { ...res.headers };
        // Sidecar already removed transfer-encoding etc. quirks (it
        // mirrors upstream raw headers).  We forward as-is.
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: outHeaders,
          body: res,
        });
      }
    );
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason || new Error("aborted"));
        reject(signal.reason || new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => req.destroy(signal.reason || new Error("aborted")), { once: true });
    }
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      req.setTimeout(timeoutMs + 5000, () => req.destroy(new Error("sidecar timeout"))); // give sidecar 5s grace
    }
    req.end(payloadBuf);
  });
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Read all bytes from a body stream — convenience matching http-client.
function readAll(stream) {
  return readStream(stream);
}

async function readJson(stream) {
  const buf = await readAll(stream);
  const text = buf.toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

module.exports = {
  launchSidecar,
  findElectronBinary,
  request,
  readAll,
  readJson,
  PORT_LINE_RE,
};
