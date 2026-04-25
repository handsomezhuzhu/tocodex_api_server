"use strict";

// Tests for lib/version-probe.js — Marketplace version discovery.
// Run with `node test/version-probe.test.js`.

const assert = require("node:assert/strict");

// --- Pure behaviour of VERSION_RE -----------------------------------------
{
  const { VERSION_RE } = require("../lib/version-probe");
  assert.ok(VERSION_RE.test("3.1.3"));
  assert.ok(VERSION_RE.test("3.1.4"));
  assert.ok(VERSION_RE.test("10.20.30"));
  assert.ok(!VERSION_RE.test("3.1"));
  assert.ok(!VERSION_RE.test("3.1.3-beta"));
  assert.ok(!VERSION_RE.test("v3.1.3"));
  assert.ok(!VERSION_RE.test(""));
}

// --- Cache hit path: resolveAppVersion returns cached value without refetch.
//
// We don't want this test to hit the real Marketplace, so we populate the
// cache manually via a probe call whose fetch we control by monkey-patching
// the https module's `request`.  That fake server replies instantly with a
// marketplace-shaped payload the probe can parse, seeding the cache, then
// we assert the next call uses the cache (not a new fetch).
{
  const probe = require("../lib/version-probe");
  probe._resetCache();

  const https = require("node:https");
  const origRequest = https.request;
  let requestCount = 0;

  https.request = function mockRequest(opts, cb) {
    requestCount += 1;
    const body = JSON.stringify({
      results: [
        {
          extensions: [
            {
              versions: [{ version: "3.1.7" }],
            },
          ],
        },
      ],
    });

    const res = new (require("node:stream").Readable)({
      read() {
        this.push(body);
        this.push(null);
      },
    });
    res.statusCode = 200;
    res.headers = { "content-type": "application/json" };

    // Fire the response callback asynchronously to mimic real I/O.
    setImmediate(() => cb(res));

    return {
      on() {},
      end() {},
      destroy() {},
    };
  };

  (async () => {
    try {
      const v1 = await probe.resolveAppVersion("3.1.3", { timeoutMs: 500 });
      assert.equal(v1, "3.1.7", "first call should return probed value");
      assert.equal(requestCount, 1);

      const v2 = await probe.resolveAppVersion("3.1.3", { timeoutMs: 500 });
      assert.equal(v2, "3.1.7", "second call should return cached value");
      assert.equal(requestCount, 1, "cache hit must not refetch");

      // force:true bypasses the cache.
      const v3 = await probe.resolveAppVersion("3.1.3", {
        timeoutMs: 500,
        force: true,
      });
      assert.equal(v3, "3.1.7");
      assert.equal(requestCount, 2, "force=true must refetch");

      // TTL expiry bypasses the cache too.
      let now = 1000;
      const future = () => now;
      probe._resetCache();
      now = 1000;
      await probe.resolveAppVersion("3.1.3", {
        timeoutMs: 500,
        now: future,
      });
      assert.equal(requestCount, 3);
      now = 1000 + 25 * 60 * 60 * 1000; // 25 hours later
      await probe.resolveAppVersion("3.1.3", {
        timeoutMs: 500,
        now: future,
      });
      assert.equal(requestCount, 4, "TTL expiry must refetch");
    } finally {
      https.request = origRequest;
    }

    // --- Network failure falls back to the supplied static default. ------
    probe._resetCache();
    https.request = function failingRequest() {
      return {
        on(ev, fn) {
          if (ev === "error") setImmediate(() => fn(new Error("enetunreach")));
        },
        end() {},
        destroy() {},
      };
    };
    try {
      const v = await probe.resolveAppVersion("3.1.9", { timeoutMs: 100 });
      assert.equal(v, "3.1.9", "probe failure falls back to static default");
    } finally {
      https.request = origRequest;
    }

    // --- Invalid fallback is sanitised to 3.1.3. ------------------------
    probe._resetCache();
    https.request = function failingRequest() {
      return {
        on(ev, fn) {
          if (ev === "error") setImmediate(() => fn(new Error("enetunreach")));
        },
        end() {},
        destroy() {},
      };
    };
    try {
      const v = await probe.resolveAppVersion("garbage", { timeoutMs: 100 });
      assert.equal(v, "3.1.3", "non-semver fallback gets sanitised");
    } finally {
      https.request = origRequest;
    }

    // --- Malformed Marketplace payload also falls back. -----------------
    probe._resetCache();
    https.request = function malformedRequest(opts, cb) {
      const res = new (require("node:stream").Readable)({
        read() {
          this.push("not-json");
          this.push(null);
        },
      });
      res.statusCode = 200;
      res.headers = {};
      setImmediate(() => cb(res));
      return { on() {}, end() {}, destroy() {} };
    };
    try {
      const v = await probe.resolveAppVersion("3.1.3", { timeoutMs: 100 });
      assert.equal(v, "3.1.3");
    } finally {
      https.request = origRequest;
    }

    // --- Non-semver Marketplace value also falls back. ------------------
    probe._resetCache();
    https.request = function oddRequest(opts, cb) {
      const body = JSON.stringify({
        results: [{ extensions: [{ versions: [{ version: "pre-release-5" }] }] }],
      });
      const res = new (require("node:stream").Readable)({
        read() {
          this.push(body);
          this.push(null);
        },
      });
      res.statusCode = 200;
      res.headers = {};
      setImmediate(() => cb(res));
      return { on() {}, end() {}, destroy() {} };
    };
    try {
      const v = await probe.resolveAppVersion("3.1.3", { timeoutMs: 100 });
      assert.equal(v, "3.1.3");
    } finally {
      https.request = origRequest;
    }

    console.log("version-probe.test.js: all assertions passed");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
