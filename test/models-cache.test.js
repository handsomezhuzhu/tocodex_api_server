"use strict";

// Tests for lib/models-cache.js — the local snapshot served in place
// of any /models probe.  Run with `node test/models-cache.test.js`.

const assert = require("node:assert/strict");
const cache = require("../lib/models-cache");

// --- isModelsPath -----------------------------------------------------------
{
  const yes = [
    "/v1/models",
    "/v1/models/",
    "/v1/models/gpt-5.4",
    "/v1/models/some/nested/id",
    "/v1beta/models",
    "/v1beta/models/gemini-3-flash-preview",
    "/anthropic/v1/models",
    "/openai/v1/models",
    "/foo/models",
    "/foo/models/bar",
  ];
  for (const p of yes) {
    assert.equal(cache.isModelsPath(p), true, `should match: ${p}`);
  }

  const no = [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/images/generations",
    "/_health",
    "/",
    "/v1/messages",
    "",
    null,
  ];
  for (const p of no) {
    assert.equal(cache.isModelsPath(p), false, `should NOT match: ${p}`);
  }
}

// --- getOpenAIList: returns the snapshot verbatim ---------------------------
{
  const list = cache.getOpenAIList();
  assert.equal(list.success, true);
  assert.equal(list.object, "list");
  assert.ok(Array.isArray(list.data));
  assert.ok(list.data.length > 0, "snapshot must contain models");

  // Spot-check a known entry.
  const auto = list.data.find((m) => m.id === "Auto-free");
  assert.ok(auto, "Auto-free must be in snapshot");
  assert.equal(auto.object, "model");
  assert.equal(auto.owned_by, "custom");
  assert.deepEqual(auto.supported_endpoint_types, ["openai"]);
}

// --- getAnthropicList: only models with anthropic endpoint ------------------
{
  const list = cache.getAnthropicList();
  assert.ok(Array.isArray(list.data));
  for (const m of list.data) {
    assert.equal(m.type, "model");
    assert.ok(typeof m.id === "string" && m.id.length > 0);
    assert.ok(typeof m.display_name === "string");
    // Anthropic-shaped: created_at as ISO string when present
    if (m.created_at !== null) {
      assert.match(m.created_at, /^\d{4}-\d{2}-\d{2}T/u);
    }
  }
  // claude-* and Auto must be present (per the snapshot).
  const ids = list.data.map((m) => m.id);
  assert.ok(ids.includes("claude-sonnet-4-6"));
  assert.ok(ids.includes("claude-opus-4-7"));
  assert.ok(ids.includes("Auto"));
  // Pure-OpenAI models must NOT be present.
  assert.ok(!ids.includes("gpt-5.4"));
  assert.ok(!ids.includes("Auto-free"));

  assert.equal(list.has_more, false);
  assert.equal(list.first_id, list.data[0].id);
  assert.equal(list.last_id, list.data[list.data.length - 1].id);
}

// --- getById ----------------------------------------------------------------
{
  const m = cache.getById("gpt-5.5");
  assert.ok(m);
  assert.equal(m.id, "gpt-5.5");

  assert.equal(cache.getById("does-not-exist"), null);
  assert.equal(cache.getById(""), null);
  assert.equal(cache.getById(null), null);
}

console.log("models-cache.test.js: all assertions passed");
