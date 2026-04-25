"use strict";

// Hardcoded model catalog served in place of any upstream /v1/models hit.
//
// WHY: empirical evidence (2026-04-26 testing) showed that calling
// `GET /v1/models` against api.tocodex.com is treated as a third-party
// fingerprint by the ToCodex backend.  The real VSCode extension never
// fetches /models — it ships the model list hardcoded in dist/extension.js
// — so any client that does is, by definition, NOT the extension.
// Triggering this signal got two test API keys banned within 3-4 minutes
// of the relay's first chat.completion request, even though every header,
// JA3 fingerprint and body field matched the extension byte-for-byte.
//
// Therefore: this file is the SINGLE source of truth for the model list,
// snapshotted from a real /v1/models response on 2026-04-26 and stored at
// data/models.json in the repo.  The relay never asks the upstream for it.
//
// If the upstream ever adds new models the user has to re-snapshot the
// list and update data/models.json.  Doing so requires a fresh API key
// because the snapshot itself is what burned the previous keys.

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_PATH = path.join(__dirname, "..", "data", "models.json");

let _catalog = null;

function loadCatalog() {
  if (_catalog) return _catalog;
  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error(`models-cache: invalid catalog at ${CATALOG_PATH}`);
  }
  _catalog = parsed;
  return _catalog;
}

// OpenAI-shaped /v1/models response.  Returned verbatim from the
// snapshot — same key order, same field set the upstream would send.
function getOpenAIList() {
  return loadCatalog();
}

// Anthropic-shaped /anthropic/v1/models response, derived from the
// OpenAI snapshot.  Only models that advertise the "anthropic"
// supported_endpoint_type are exposed, mirroring what the real
// extension's Anthropic-mode model picker would show.
function getAnthropicList() {
  const cat = loadCatalog();
  const data = cat.data
    .filter(
      (m) =>
        Array.isArray(m.supported_endpoint_types) &&
        m.supported_endpoint_types.includes("anthropic")
    )
    .map((m) => ({
      type: "model",
      id: m.id,
      display_name: m.id,
      created_at: m.created ? new Date(m.created * 1000).toISOString() : null,
    }));
  return {
    data,
    has_more: false,
    first_id: data[0] && data[0].id,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

// Path matcher used by the passthrough dispatcher to short-circuit any
// "list / describe model" probe before it leaves the box.  Matches:
//   /v1/models                 (OpenAI list)
//   /v1/models/<id>            (OpenAI retrieve)
//   /v1beta/models             (Google-style list)
//   /v1beta/models/<id>        (Google-style retrieve)
//   /anthropic/v1/models       (handled by its own route already)
//   anything else with /models in the last two segments
function isModelsPath(p) {
  if (typeof p !== "string") return false;
  // Cheap prefix matches first.
  if (p === "/v1/models") return true;
  if (p.startsWith("/v1/models/")) return true;
  if (p === "/v1beta/models") return true;
  if (p.startsWith("/v1beta/models/")) return true;
  if (p === "/anthropic/v1/models") return true;
  // Catch /<anything>/models/... too — defence in depth.
  return /(^|\/)(models)(\/|$)/u.test(p);
}

// Look up a single model by id.  Returns the raw catalog entry or null.
// Used to serve `GET /v1/models/{id}` from cache.
function getById(id) {
  if (!id) return null;
  const cat = loadCatalog();
  return cat.data.find((m) => m.id === id) || null;
}

module.exports = {
  loadCatalog,
  getOpenAIList,
  getAnthropicList,
  getById,
  isModelsPath,
  CATALOG_PATH,
};
