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
