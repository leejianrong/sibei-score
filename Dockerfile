# The single-container image for the local app (V8, SLICES.md step 5; ADR-0001's single-container
# deployment). It serves both the built browser UI and the `/v1/` API from one origin — the
# arrangement ADR-0029's Origin/Host guards assume — and holds all state under one volume.
#
# The app runs from source: the CLI entry (`bin.ts`) is executed by Node 22's native type-stripping
# via tsx, and there is no separate compile step, so the image carries the workspace and its
# node_modules. That is honest for v0.1; production hardening (compile, prune dev deps, a distroless
# runtime) is the hosted transition's job — see docs/hosting.md.

FROM node:22-bookworm-slim

# corepack ships with Node and pins pnpm to the version in package.json's `packageManager`.
RUN corepack enable

# Build toolchain for the one native dependency (better-sqlite3). Debian glibc means a prebuilt
# binary usually matches; these are here so a source build still succeeds if it does not.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install against the committed lockfile, then build the browser bundle V8g serves.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sibei/ui build

# The data directory the volume mounts over. Owned by the unprivileged `node` user the image runs as,
# so the server can write the SQLite DB and its blobs without running as root.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

# Bind 0.0.0.0 so Docker's published port (forwarded to the bridge interface) reaches the process
# (ADR-0029 amendment). LAN-unreachability is enforced by the compose file publishing to the host's
# loopback only — never here. SBSCORE_UI turns on same-origin static serving (V8g); SBSCORE_DATA puts
# the library and its cached exports under the volume.
ENV SBSCORE_HOST=0.0.0.0 \
    SBSCORE_UI=/app/packages/ui/dist \
    SBSCORE_DATA=/data/scores.db

EXPOSE 8080

# A GET, no Origin needed; Host is 127.0.0.1 (loopback allow-list passes) and the server binds all
# interfaces, so this reaches it from inside the container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "sbscore", "serve", "--port", "8080"]
