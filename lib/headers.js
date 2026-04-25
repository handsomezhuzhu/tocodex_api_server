"use strict";

// Author the header set the caller hands to `globalThis.fetch` when the
// real ToCodex VSCode extension (v3.1.3) issues an upstream request.
//
// IMPORTANT: this module emits CALLER-LAYER headers only.  `host`,
// `connection`, `accept-encoding`, `content-length`, and undici's own
// `accept-language: *` / `sec-fetch-mode: cors` tail are added by the
// transport (undici) at write time.  The real extension never sets them
// explicitly, and neither do we — faking them at this layer both
// duplicates what undici will add and puts them at the wrong wire
// position relative to the caller-supplied block.
//
// The extension has FOUR distinct caller-layer shapes against
// api.tocodex.com.  All four are issued through the same transport
// (`globalThis.fetch` = undici; OpenAI Node SDK v5.12.2 also sets
// `this.fetch = globalThis.fetch` — see dist/extension.js ~7310932),
// so the JA3 wire fingerprint is identical across profiles.  Only the
// set of caller-supplied headers differs.
//
//   (1) 'sdk'        — OpenAI Node SDK v5.12.2 chat.completions.create
//                      (xB.createStream).  Caller headers = SDK's
//                      buildHeaders() output for /v1/chat/completions
//                      merged with Fd defaultHeaders + the e.headers the
//                      ToCodex handler passes ({X-Roo-*, X-ToCodex-*}).
//                      SIGNED.
//
//   (2) 'images-chat'— lUe() image-fallback on /v1/chat/completions.
//                      Native fetch, no Stainless, no Roo, Referer=tocodex.com.
//                      Body carries `modalities:["image","text"]`. SIGNED.
//
//   (3) 'images'     — ici() on /v1/images/generations. Same shape as
//                      images-chat.  SIGNED.
//
//   (4) 'lean'       — r6o() on /v1/models and aux endpoints. Native
//                      fetch with the Fd branding trio + auth.  NOT SIGNED.
//
// The `fn()` header merger (dist/extension.js ~7.3M) walks the arrays in
// order and, for each (key,value) pair, does `Headers.delete(key)` then
// `Headers.append(key, value)`.  Because a deleted-then-appended key
// lands at the END of the Headers iteration order, the final wire order
// is NOT the "earliest mention" but the "latest mention" of each key.
// For the sdk profile this means User-Agent from Fd re-appears AFTER
// the Stainless block (Fd is array 4; Stainless are in array 2), and
// the handler's Roo/ToCodex headers come at the very end.

const { signToCodex } = require("./sign");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// OpenAI SDK bundled inside the extension (K3 constant in dist/extension.js).
const OPENAI_SDK_VERSION = "5.12.2";

// VSCode Electron host fingerprint. VSCode 1.113–1.117 all ship Electron
// 39.8.x with Node v22.22.1 — this value places the relay in the
// populous current-stable user bucket and matches what the SDK reads
// from `globalThis.process.version` on a real install.
const STAINLESS_STATIC = {
  lang: "js",
  os: "Windows",
  arch: "x64",
  runtime: "node",
  runtimeVersion: "v22.22.1",
};

const IMAGES_REFERER = "https://tocodex.com";

function pickProfile(path, bodyHint) {
  if (path === "/v1/chat/completions") {
    if (bodyHint && Array.isArray(bodyHint.modalities) && bodyHint.modalities.length > 0)
      return "images-chat";
    return "sdk";
  }
  if (path === "/v1/images/generations") return "images";
  return "lean";
}

// Ordered [[name, value], ...] list with case-insensitive lookup helpers.
// The array is the authoritative wire-order representation (modulo what
// undici adds at transport time).
class HeaderList {
  constructor() {
    this.entries = [];
    this._index = new Map();
  }
  append(name, value) {
    if (value == null) return;
    this.entries.push([name, String(value)]);
    this._index.set(name.toLowerCase(), this.entries.length - 1);
  }
  has(name) {
    return this._index.has(name.toLowerCase());
  }
  get(name) {
    const idx = this._index.get(name.toLowerCase());
    return idx == null ? undefined : this.entries[idx][1];
  }
  toFlat() {
    const out = new Array(this.entries.length * 2);
    for (let i = 0; i < this.entries.length; i++) {
      out[i * 2] = this.entries[i][0];
      out[i * 2 + 1] = this.entries[i][1];
    }
    return out;
  }
  toObject() {
    const obj = {};
    for (const [k, v] of this.entries) obj[k] = v;
    return obj;
  }
  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }
}

// --------------------------------------------------------------------------
// Profile-specific header authoring
// --------------------------------------------------------------------------

function buildSdkHeaders(config, { apiKey, taskId, stream, retryCount }) {
  const h = new HeaderList();
  // Order: this is what the SDK's fn() merger ends up with after
  // walking {idempotency}, {Accept, UA, Stainless-Retry-Count,
  // Stainless-Timeout?, Kin()}, authHeaders, Fd, bodyHeaders, e.headers.
  //
  // `X-Stainless-Timeout` is OMITTED — the SDK only emits it when
  // `options.timeout` is truthy, and ToCodex calls
  // chat.completions.create(body, { headers:... }) without timeout.
  h.append("Accept", stream ? "text/event-stream" : "application/json");
  h.append("X-Stainless-Retry-Count", String(retryCount || 0));
  h.append("X-Stainless-Lang", STAINLESS_STATIC.lang);
  h.append("X-Stainless-Package-Version", OPENAI_SDK_VERSION);
  h.append("X-Stainless-OS", STAINLESS_STATIC.os);
  h.append("X-Stainless-Arch", STAINLESS_STATIC.arch);
  h.append("X-Stainless-Runtime", STAINLESS_STATIC.runtime);
  h.append("X-Stainless-Runtime-Version", STAINLESS_STATIC.runtimeVersion);
  if (apiKey) h.append("Authorization", `Bearer ${apiKey}`);
  // Fd defaultHeaders — User-Agent is re-declared here, which places it
  // AFTER the Stainless block on the wire (that's what fn() does).
  h.append("HTTP-Referer", config.referer);
  h.append("X-Title", config.title);
  h.append("User-Agent", `ToCodex/${config.appVersion}`);
  // bodyHeaders from buildBody().  SDK uses lowercase `content-type`.
  h.append("content-type", "application/json");
  // e.headers supplied by the ToCodex handler (xB.createMessage).
  h.append("X-Roo-App-Version", config.appVersion);
  if (taskId && UUID_RE.test(String(taskId))) h.append("X-Roo-Task-ID", taskId);
  return h;
}

function buildLeanHeaders(config, { apiKey, hasBody }) {
  // r6o() does: fetch(url, { method, headers: { ...Fd, Authorization }, body? })
  // Order as written by the caller:
  const h = new HeaderList();
  h.append("HTTP-Referer", config.referer);
  h.append("X-Title", config.title);
  h.append("User-Agent", `ToCodex/${config.appVersion}`);
  if (apiKey) h.append("Authorization", `Bearer ${apiKey}`);
  if (hasBody) h.append("content-type", "application/json");
  return h;
}

function buildImagesHeaders(config, { apiKey, hasBody }) {
  // lUe() and ici() do:
  //   fetch(url, { method, body, headers: {
  //     "HTTP-Referer": "https://tocodex.com",
  //     "X-Title": "ToCodex",
  //     Authorization,
  //     "Content-Type": "application/json",
  //     ...extraHeaders(X-ToCodex-*),
  //   }})
  // NO User-Agent (undici fills in `user-agent: node`), NO Stainless,
  // NO X-Roo-*. Referer is the tocodex.com flavour.
  const h = new HeaderList();
  h.append("HTTP-Referer", IMAGES_REFERER);
  h.append("X-Title", config.title);
  if (apiKey) h.append("Authorization", `Bearer ${apiKey}`);
  if (hasBody) h.append("Content-Type", "application/json");
  return h;
}

function appendSignature(h, config, method, path) {
  if (!config.signAllPaths && !config.signedPaths.has(path)) return;
  const { timestamp, nonce, signature } = signToCodex({
    method,
    path,
    secret: config.hmacSecret,
  });
  h.append("X-ToCodex-Timestamp", timestamp);
  h.append("X-ToCodex-Nonce", nonce);
  h.append("X-ToCodex-Sig", signature);
}

function buildUpstreamHeaders(
  config,
  {
    path,
    method = "POST",
    apiKey,
    taskId,
    stream = false,
    hasBody = false,
    retryCount = 0,
    profile,
    bodyHint,
  } = {}
) {
  if (!path) throw new Error("buildUpstreamHeaders: path is required");
  const prof = profile || pickProfile(path, bodyHint);
  let h;
  if (prof === "sdk") {
    h = buildSdkHeaders(config, { apiKey, taskId, stream, retryCount });
  } else if (prof === "lean") {
    h = buildLeanHeaders(config, { apiKey, hasBody });
  } else if (prof === "images" || prof === "images-chat") {
    h = buildImagesHeaders(config, { apiKey, hasBody });
  } else {
    throw new Error(`buildUpstreamHeaders: unknown profile ${prof}`);
  }
  appendSignature(h, config, method, path);
  return h;
}

module.exports = {
  buildUpstreamHeaders,
  pickProfile,
  UUID_RE,
  OPENAI_SDK_VERSION,
  STAINLESS_STATIC,
  IMAGES_REFERER,
  HeaderList,
};
