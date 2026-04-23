"use strict";

const crypto = require("node:crypto");

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function safeJsonParse(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
}

function parseBearer(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^\s*Bearer\s+(.+)$/iu);
  return m ? m[1].trim() : null;
}

// Resolve the upstream ToCodex API key for a request. Order of preference:
//   1. relay-level default (env TOCODEX_API_KEY)
//   2. Authorization: Bearer <token> from the client
//   3. x-api-key from the client (Anthropic style)
function resolveApiKey(req, config) {
  if (config.defaultApiKey) return config.defaultApiKey;
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  const bearer = parseBearer(Array.isArray(auth) ? auth[0] : auth);
  if (bearer) return bearer;
  const xkey = req.headers["x-api-key"];
  if (xkey) return (Array.isArray(xkey) ? xkey[0] : xkey).trim();
  return null;
}

// Buffer a JSON request body with a size cap. Returns the parsed JSON or
// throws an Error with a `.statusCode` for us to translate to HTTP.
async function readJsonBody(req, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`invalid JSON body: ${e.message}`);
    err.statusCode = 400;
    throw err;
  }
}

module.exports = { newId, safeJsonParse, parseBearer, resolveApiKey, readJsonBody };
