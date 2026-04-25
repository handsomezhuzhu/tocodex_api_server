"use strict";

// Tests for lib/headers.js — the caller-layer header builder.
// Run with `node test/headers.test.js`.
//
// These headers feed into undici.fetch() (either directly or via the
// Electron sidecar). Undici handles host / connection / accept-encoding /
// content-length and its own accept-language / sec-fetch-mode tail at
// transport time, so nothing here asserts on those — they appear in the
// wire tests only.

const assert = require("node:assert/strict");
const { loadConfig, DEFAULT_APP_VERSION } = require("../lib/sign");
const {
  buildUpstreamHeaders,
  pickProfile,
  IMAGES_REFERER,
  HeaderList,
} = require("../lib/headers");

const FORBIDDEN_KEYS = ["anthropic-version", "anthropic-beta", "x-api-key"];

function names(h) {
  return h.entries.map(([k]) => k);
}

function assertNoForbidden(h) {
  const lowered = names(h).map((k) => k.toLowerCase());
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!lowered.includes(k), `forbidden header leaked: ${k}`);
  }
}

const CFG = loadConfig({ TOCODEX_API_URL: "https://api.tocodex.com" });

// Case A: sdk profile — deterministic caller-layer output.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    taskId: "11111111-1111-1111-1111-111111111111",
    stream: true,
    hasBody: true,
  });
  assert.ok(h instanceof HeaderList);

  // Exact wire order the SDK's fn() merger produces for a streaming
  // chat.completions.create call with taskId supplied and the upstream
  // path in the signedPaths set.
  const expected = [
    "Accept",
    "X-Stainless-Retry-Count",
    "X-Stainless-Lang",
    "X-Stainless-Package-Version",
    "X-Stainless-OS",
    "X-Stainless-Arch",
    "X-Stainless-Runtime",
    "X-Stainless-Runtime-Version",
    "Authorization",
    "HTTP-Referer",
    "X-Title",
    "User-Agent",
    "content-type",
    "X-Roo-App-Version",
    "X-Roo-Task-ID",
    "X-ToCodex-Timestamp",
    "X-ToCodex-Nonce",
    "X-ToCodex-Sig",
  ];
  assert.deepEqual(names(h), expected, "sdk caller-layer header order");

  // Values that must be byte-exact.
  assert.equal(h.get("Accept"), "text/event-stream");
  assert.equal(h.get("User-Agent"), `ToCodex/${DEFAULT_APP_VERSION}`);
  assert.equal(h.get("HTTP-Referer"), "https://github.com/tocodex/ToCodex");
  assert.equal(h.get("X-Stainless-Package-Version"), "5.12.2");
  assert.equal(h.get("X-Stainless-Runtime-Version"), "v22.22.1");
  assert.equal(h.get("X-Stainless-OS"), "Windows");
  assert.equal(h.get("X-Stainless-Arch"), "x64");
  assert.equal(h.get("X-Roo-Task-ID"), "11111111-1111-1111-1111-111111111111");
  assert.match(h.get("X-ToCodex-Sig"), /^[0-9a-f]{64}$/u);

  // Things the real SDK does NOT emit at caller layer.
  const lowered = names(h).map((k) => k.toLowerCase());
  assert.ok(!lowered.includes("host"), "host must be added by undici, not by us");
  assert.ok(!lowered.includes("connection"), "connection is an undici concern");
  assert.ok(!lowered.includes("content-length"), "content-length added by undici");
  assert.ok(
    !lowered.includes("accept-encoding"),
    "Accept-Encoding is filled by undici (gzip, deflate)"
  );
  assert.ok(!lowered.includes("accept-language"), "undici adds this");
  assert.ok(!lowered.includes("sec-fetch-mode"), "undici adds this");
  assert.ok(
    !lowered.includes("x-stainless-timeout"),
    "SDK only emits X-Stainless-Timeout when options.timeout is set; ToCodex does not pass one"
  );
  assertNoForbidden(h);
}

// Case B: sdk profile without taskId — X-Roo-Task-ID absent.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    stream: false,
    hasBody: true,
  });
  assert.ok(!h.has("X-Roo-Task-ID"));
  assert.equal(h.get("Accept"), "application/json");
}

// Case C: invalid task id is dropped silently on sdk profile.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    taskId: "not-a-uuid",
    stream: false,
    hasBody: true,
  });
  assert.ok(!h.has("X-Roo-Task-ID"));
}

// Case D: images profile — DIFFERENT Referer, NO User-Agent, NO Stainless,
// NO X-Roo-*.  Signed.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/images/generations",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
  });
  const expected = [
    "HTTP-Referer",
    "X-Title",
    "Authorization",
    "Content-Type",
    "X-ToCodex-Timestamp",
    "X-ToCodex-Nonce",
    "X-ToCodex-Sig",
  ];
  assert.deepEqual(names(h), expected);
  assert.equal(h.get("HTTP-Referer"), IMAGES_REFERER);
  assert.ok(!h.has("User-Agent"), "images profile relies on undici's user-agent: node");
  for (const k of names(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
    assert.ok(!k.toLowerCase().startsWith("x-roo-"));
  }
  assert.match(h.get("X-ToCodex-Sig"), /^[0-9a-f]{64}$/u);
  assertNoForbidden(h);
}

// Case E: images-chat profile — triggered by modalities in bodyHint.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
    bodyHint: { modalities: ["image", "text"] },
  });
  assert.equal(h.get("HTTP-Referer"), IMAGES_REFERER);
  assert.ok(!h.has("User-Agent"));
  for (const k of names(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
    assert.ok(!k.toLowerCase().startsWith("x-roo-"));
  }
  assert.match(h.get("X-ToCodex-Sig"), /^[0-9a-f]{64}$/u);
}

// Case F: lean profile — Fd branding + auth, no signature, no tail.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/models",
    method: "GET",
    apiKey: "sk",
  });
  const expected = ["HTTP-Referer", "X-Title", "User-Agent", "Authorization"];
  assert.deepEqual(names(h), expected);
  assert.equal(h.get("User-Agent"), `ToCodex/${DEFAULT_APP_VERSION}`);
  for (const k of names(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
    assert.ok(!k.toLowerCase().startsWith("x-roo-"));
    assert.ok(!k.toLowerCase().startsWith("x-tocodex-"));
  }
  assertNoForbidden(h);
}

// Case G: stream flag flips Accept on sdk profile only.
{
  const base = {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
  };
  assert.equal(
    buildUpstreamHeaders(CFG, { ...base, stream: true }).get("Accept"),
    "text/event-stream"
  );
  assert.equal(
    buildUpstreamHeaders(CFG, { ...base, stream: false }).get("Accept"),
    "application/json"
  );
}

// Case H: pickProfile.
{
  assert.equal(pickProfile("/v1/chat/completions"), "sdk");
  assert.equal(
    pickProfile("/v1/chat/completions", { modalities: ["image", "text"] }),
    "images-chat"
  );
  assert.equal(pickProfile("/v1/chat/completions", { modalities: [] }), "sdk");
  assert.equal(pickProfile("/v1/images/generations"), "images");
  assert.equal(pickProfile("/v1/models"), "lean");
  assert.equal(pickProfile("/v1/something"), "lean");
}

// Case I: sign-all-paths mode signs even lean.
{
  const cfg = loadConfig({
    TOCODEX_API_URL: "https://api.tocodex.com",
    TOCODEX_SIGN_ALL_PATHS: "true",
  });
  const h = buildUpstreamHeaders(cfg, { path: "/v1/models", method: "GET", apiKey: "sk" });
  assert.ok(h.has("X-ToCodex-Sig"));
}

// Case J: explicit profile override.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
    profile: "lean",
  });
  assert.equal(h.get("User-Agent"), `ToCodex/${DEFAULT_APP_VERSION}`);
  for (const k of names(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
  }
}

// Case K: HeaderList.toFlat() matches entries pairwise.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/models",
    method: "GET",
    apiKey: "sk",
  });
  const flat = h.toFlat();
  assert.equal(flat.length, h.entries.length * 2);
  for (let i = 0; i < h.entries.length; i++) {
    assert.equal(flat[i * 2], h.entries[i][0]);
    assert.equal(flat[i * 2 + 1], h.entries[i][1]);
  }
}

console.log("headers.test.js: all assertions passed");
