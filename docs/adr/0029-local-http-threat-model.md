# ADR-0029: Threat model for the local HTTP server

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

Q46 settled that there is no authentication: the API binds to localhost and the auth
seam resolves every request to the principal `local`. That is right for a personal tool,
but "localhost" is a weaker boundary than it sounds. A localhost HTTP server is
reachable by every process on the machine, and — via DNS rebinding — by any web page
the user happens to visit while the container is running.

The app also accepts file uploads, which is the one place untrusted bytes enter.

Worth stating plainly: there are no secrets and no sensitive data here. Scores are the
user's own music. The concern is not data theft but the app being trivially drivable by
something that is not the user.

## Decision

- Bind to `127.0.0.1` only. Never `0.0.0.0`, including in the compose file, where the
  default would otherwise expose the port on the host's network.
- Validate the `Origin` header on all state-changing requests and reject cross-origin
  ones. This is what closes the DNS-rebinding and drive-by-request path.
- No wildcard CORS.
- Validate uploads by **decoding** them — real dimension and byte-size caps, actual
  format detected from content — rather than trusting a declared content type or file
  extension.
- No secrets exist in the MVP, so none can leak. The rule for later: no image bytes and
  no file paths in logs, and if a hosted deployment ever introduces credentials, they
  come from the environment and never from the store.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Nothing beyond localhost binding | Leaves a hostile web page able to issue state-changing requests to the API while the container runs. |
| A local API token | Real protection, but it adds setup friction to a single-user local tool, and the Origin check closes the realistic path at no cost. |
| Full auth now | Q48 explicitly deferred this. The seam exists; filling it in is the hosted transition's job. |

## Consequences

- The Origin check must be in place before the browser UI exists, or it will be
  retrofitted against a working client and something will be loosened to make it pass.
- Upload validation by decoding costs a little time per import and rejects some
  malformed-but-recoverable files. Correct trade: a malformed image should fail at the
  boundary, not inside oemer.
- Binding to `127.0.0.1` means the app is unreachable from another device on the LAN —
  no phone-to-laptop upload. That is a real usability loss and the honest answer is that
  it waits for the hosted version rather than being hacked around locally.
- None of this substitutes for authentication. It is the minimum that makes an
  unauthenticated local server not trivially abusable, and it says nothing about the
  hosted case.

## Amendment (2026-09-11, V8h): bind address vs. publish address

Shipping the container (V8's step 5) exposed a flaw in the original wording. &ldquo;Bind
`127.0.0.1`, never `0.0.0.0`, including in the compose file&rdquo; conflated two separate things
that were the same knob only because there was no container yet:

- the **bind address** — where the server process listens, *inside* the container;
- the **publish address** — what Docker exposes to the host, *outside* the container.

Docker forwards a published port to the container's **bridge** interface (a `172.x.x.x` address),
not to loopback. A process bound to `127.0.0.1` inside the container is therefore listening on the
wrong interface and is unreachable from the host — the container looks dead. Binding `0.0.0.0`
inside the container is the only way the forwarded request reaches the process.

**The property this ADR actually protects — the app is unreachable from other devices on the LAN —
is a property of the publish address, not the bind address.** So:

- The bind address becomes a parameter (`Api.listen(port, host?)`), **defaulting to `127.0.0.1`**.
  Every non-container caller omits it and binds loopback exactly as before. `sbscore serve` exposes
  it as `--host` / `SBSCORE_HOST`, default `127.0.0.1`.
- The **container** sets `SBSCORE_HOST=0.0.0.0` so the forwarded port reaches the process.
- The **compose file publishes to the host's loopback only** — `127.0.0.1:8080:8080`, never a bare
  `8080:8080`. This is where LAN-unreachability is now enforced, and where a container can actually
  enforce it. The original rule's *intent* — no bare `0.0.0.0` publish that exposes the port on the
  host's network — stands unchanged; only its location moves from the bind to the publish line.
- The **Origin and Host guards are untouched** and still run. The browser reaches the container as
  `localhost:8080` (via the loopback publish), so the loopback Host allow-list still passes; nothing
  loosens for the local container. Widening that allow-list for a real domain is the hosted
  transition's job, not this one.

Residual, and accepted: binding `0.0.0.0` also exposes the port to other containers on the same
Docker network. For a single-container deployment that is negligible, and a dedicated Compose
network with no other services on it closes it. See `docs/hosting.md` for how the same `0.0.0.0`
bind is reused, behind a TLS edge and real auth, in the hosted future.

## Amendment (V23, 2026-11): hosted guards widen, they do not loosen

The hosted deployment is reached by a real name, so the Host/Origin allow-list takes it from
configuration (ADR-0034 decision 7). What changed and what did not:

- **Host and Origin admit exactly the names configured**: loopback, the hosted public URL's host, and any
  extra hostnames in `--allowed-hosts` / `SBSCORE_ALLOWED_HOSTS` (comma-separated, exact match, no
  wildcards). Anything else is still `403 foreign-host` / `foreign-origin`, before routing, on every path.
- **Still no CORS headers, on any response.** The allow-list admits a name to be *addressed*; it never
  lets a foreign page read a response.
- **Bodies stay capped** (1 MB for JSON, 25 MB for an upload), unchanged.
- **New: per-IP and per-user rate limits and per-user quotas** (`packages/api/src/limits/`), on in hosted
  mode and off for a local install. Refusals are structured problems: `429 rate-limited` with
  `Retry-After`, and `403 quota-exceeded` naming the quota. The client address is the socket's unless the
  deployment says a reverse proxy fronts it (`SBSCORE_TRUST_PROXY=1`), in which case it is the
  *rightmost* `X-Forwarded-For` entry, the one our own proxy appended; trusting the header on an exposed
  server would let a caller choose its own address.
- **New: a per-user cap on concurrent event streams** (the "hold a connection open" residual noted in
  `http/event-stream.ts`, KAN-602).
- Redis carries the change bus and the limiter's counters when `SBSCORE_REDIS_URL` is set (ADR-0034
  decision 8); the limits fail *open* if Redis is down, because they protect the service and must not
  become a way to take it down.
