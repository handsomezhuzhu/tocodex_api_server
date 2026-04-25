# syntax=docker/dockerfile:1.6

# ToCodex API Server — TLS-impersonating relay.
#
# The image bundles Electron 39.8.7 (linux-x64) so the upstream-facing
# requests can be routed through Electron's BoringSSL stack.  This makes
# the wire JA3/JA4 fingerprint match the real ToCodex VSCode extension
# (which lives inside an identical Electron host).
#
# The Electron download is large (~110MB compressed, ~280MB extracted),
# but that's the cost of having an indistinguishable TLS profile without
# writing custom Rust.  See lib/sidecar.js / sidecar-app/main.js for how
# the relay talks to it over a loopback socket.

# --- Stage 1: fetch + slim Electron 39 ------------------------------------
FROM debian:bookworm-slim AS electron-stage

ARG ELECTRON_VERSION=39.8.7
ARG ELECTRON_ARCH=linux-x64

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN curl -fsSL -o electron.zip \
      "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-${ELECTRON_ARCH}.zip" \
 && unzip -q electron.zip -d electron \
 && rm electron.zip \
 # Trim non-essential locales (~50MB saving).  Keep en-US — it's the
 # default Electron asks for and removing it produces warnings.
 && find electron/locales -type f ! -name 'en-US.pak' -delete \
 # Drop swiftshader (software GPU fallback we don't need headless).
 && rm -f electron/libvk_swiftshader.so electron/vk_swiftshader_icd.json electron/libvulkan.so.1 \
 # Drop the chromium licence HTML (~15MB) — original kept in the build context.
 && rm -f electron/LICENSES.chromium.html

# --- Stage 2: runtime ------------------------------------------------------
FROM node:22-bookworm-slim

# Electron 39 needs a handful of shared libs even when run headless,
# plus xvfb because the Electron main process refuses to initialise
# without an X display (even with --headless flags it tries to bring up
# Aura/Ozone). xvfb-run wraps electron with an in-memory X server so
# nothing leaves the container; total cost ~30MB.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        tini \
        ca-certificates \
        xvfb \
        xauth \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libgbm1 \
        libgtk-3-0 \
        libasound2 \
        libxshmfence1 \
        libpango-1.0-0 \
        libcairo2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system app \
 && useradd  --system --gid app --create-home --home-dir /home/app app

ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    PORT=8787 \
    TOCODEX_ELECTRON_BIN=/opt/electron/electron

WORKDIR /app

# Copy Electron from stage 1.
COPY --from=electron-stage --chown=root:root /opt/electron /opt/electron
RUN chmod +x /opt/electron/electron

COPY --chown=app:app package.json ./
COPY --chown=app:app server.js    ./
COPY --chown=app:app lib          ./lib
COPY --chown=app:app sidecar-app  ./sidecar-app
COPY --chown=app:app data         ./data

USER app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
