"use strict";

// Upstream transport wrapper.
//
// Every outbound call from the relay goes through `request()` here.
// When an Electron sidecar is attached (via `useSidecar(handle)` at
// server boot), requests are forwarded to it so the wire JA3/JA4
// matches Electron's BoringSSL fingerprint rather than Node OpenSSL's.
// Without a sidecar we fall back to lib/http-client (direct node:https)
// — used only by tests and dev setups that can't run Electron.
//
// NOTE on transport choice: the real ToCodex extension dispatches EVERY
// upstream request through `globalThis.fetch` (undici), including the
// OpenAI SDK path (see dist/extension.js ~7310932 where
// `this.fetch = c.fetch ?? zin()` and zin() returns globalThis.fetch).
// So there is no reason for the sidecar to offer a node:https transport
// — it would emit a different JA3 (71dc8c...) than the real extension
// produces (1a3153...). All calls go through fetch/undici.

const httpClient = require("./http-client");
const sidecar = require("./sidecar");

let attachedSidecar = null;

function useSidecar(handle) {
  attachedSidecar = handle || null;
}

function clearSidecar() {
  attachedSidecar = null;
}

function getAttachedSidecar() {
  return attachedSidecar;
}

// Same call signature as lib/http-client.request.  `path` / `profile`
// are accepted but currently informational — we unconditionally use
// the fetch transport inside the sidecar because that's what the real
// extension does.
function request(url, opts = {}) {
  if (attachedSidecar) {
    return sidecar.request(attachedSidecar, url, { ...opts, transport: "fetch" });
  }
  // Sidecar absent → fall back to direct Node TLS. Strip sidecar-only
  // options before delegating so http-client doesn't see unknown keys.
  const {
    transport: _t,
    profile: _p,
    path: _path,
    ...passthrough
  } = opts;
  void _t;
  void _p;
  void _path;
  return httpClient.request(url, passthrough);
}

module.exports = {
  request,
  useSidecar,
  clearSidecar,
  getAttachedSidecar,
  readAll: httpClient.readAll,
  readJson: httpClient.readJson,
};
