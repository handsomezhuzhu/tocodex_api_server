# ToCodex API Server

> **Research / CTF project.** Zero-dependency Node.js relay that speaks
> ToCodex's dynamic HMAC-SHA256 request-signing scheme, reverse-engineered
> from the [`ToCodex.tocodex`](https://marketplace.visualstudio.com/items?itemName=ToCodex.tocodex)
> VSCode extension (v3.1.3). The relay exposes a standard
> OpenAI-compatible endpoint locally and forwards requests to
> `https://api.tocodex.com` with the signature headers the backend expects.

## Signing scheme

Extracted from the extension's minified `dist/extension.js`:

```js
const ts      = Math.floor(Date.now() / 1000).toString();
const nonce   = crypto.randomUUID();
const payload = `${ts}:${nonce}:POST:/v1/chat/completions`;
const sig     = crypto.createHmac("sha256", HMAC_SECRET)
                      .update(payload)
                      .digest("hex");

headers["X-ToCodex-Timestamp"] = ts;
headers["X-ToCodex-Nonce"]     = nonce;
headers["X-ToCodex-Sig"]       = sig;
```

The extension reads `process.env.TOCODEX_HMAC_SECRET` at runtime, falling back
to the hard-coded string:

```
tc-hmac-s3cr3t-k3y-2026-tocodex-platform
```

Only `POST /v1/chat/completions` is signed by the shipped provider. Alongside
the signature the extension also sends `Authorization: Bearer <token>`,
`HTTP-Referer: https://github.com/tocodex/ToCodex`, `X-Title: ToCodex`, and
`User-Agent: ToCodex/<version>`.

---

## Run with Docker (recommended)

### One-liner with `docker run`

```bash
docker run -d --name tocodex-relay -p 8787:8787 \
  -e TOCODEX_API_KEY=$YOUR_TOCODEX_TOKEN \
  ghcr.io/handsomezhuzhu/tocodex_api_server:latest
```

(omit `TOCODEX_API_KEY` if each client will pass its own `Authorization` header)

### `docker compose`

```bash
git clone https://github.com/handsomezhuzhu/tocodex_api_server.git
cd tocodex_api_server
cp .env.example .env    # optional: set TOCODEX_API_KEY and other knobs
docker compose up -d
```

### Build locally

```bash
docker build -t tocodex-api-server:dev .
docker run --rm -p 8787:8787 tocodex-api-server:dev
```

### Test

```bash
# Health check
curl http://127.0.0.1:8787/_health

# Streaming chat completion (OpenAI-compatible)
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $TOCODEX_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-4o-mini",
        "stream": true,
        "messages": [{"role":"user","content":"hi"}]
      }'
```

---

## Run directly with Node (no Docker)

```bash
cp .env.example .env
npm start            # no dependencies required, Node 20+ only
```

---

## How it works

1. Receives any HTTP method on any path (e.g. `POST /v1/chat/completions`).
2. Rewrites the URL onto `TOCODEX_API_URL` (default `https://api.tocodex.com`).
3. If the path is in `TOCODEX_SIGNED_PATHS` (default `/v1/chat/completions`)
   or `TOCODEX_SIGN_ALL_PATHS=true`, attaches
   `X-ToCodex-Timestamp`, `X-ToCodex-Nonce`, and `X-ToCodex-Sig`.
4. Preserves the incoming `Authorization` header unless `TOCODEX_API_KEY`
   is set on the server, in which case it overrides it.
5. Streams the upstream response (bodies and SSE) back unchanged.

---

## Configuration

All knobs, with defaults:

| Variable | Default | Purpose |
|---|---|---|
| `TOCODEX_API_URL` | `https://api.tocodex.com` | Upstream base |
| `TOCODEX_HMAC_SECRET` | `tc-hmac-s3cr3t-k3y-2026-tocodex-platform` | HMAC key |
| `TOCODEX_API_KEY` | *(empty)* | Pin a Bearer token; otherwise pass-through |
| `TOCODEX_SIGNED_PATHS` | `/v1/chat/completions` | Comma-separated list |
| `TOCODEX_SIGN_ALL_PATHS` | `false` | Set `true` to sign every path |
| `TOCODEX_APP_VERSION` | `3.1.3` | Propagated as `X-Roo-App-Version` / UA |
| `PORT` | `8787` | Listener port |
| `LISTEN_HOST` | `0.0.0.0` | Listener host |
| `HEALTH_PATH` | `/_health` | Health endpoint |
| `UPSTREAM_TIMEOUT_MS` | `600000` | Upstream request timeout |
| `CORS_ALLOW_ORIGIN` | `*` | CORS origin |
| `CORS_ALLOW_HEADERS` | `Content-Type, Authorization` | CORS headers |
| `CORS_ALLOW_METHODS` | `GET,POST,PUT,PATCH,DELETE,OPTIONS` | CORS methods |

---

## Verify syntax

```bash
npm run check
npm run sign:demo    # prints a sample signed payload
```

---

## Notes / CTF caveats

- The HMAC secret shown above is what the extension ships with publicly; the
  real server may enforce a different value at deploy time.
- Only `/v1/chat/completions` is signed by the extension's OpenAI-compatible
  provider path. Flip `TOCODEX_SIGN_ALL_PATHS=true` to experiment with other
  endpoints.
- Timestamp window / nonce replay protection is entirely server-side. The
  relay just generates fresh values each call.

## License

[MIT](./LICENSE)
