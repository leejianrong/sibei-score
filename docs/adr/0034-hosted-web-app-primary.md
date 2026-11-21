# ADR-0034: The hosted web app becomes the primary surface

- **Status:** Proposed — 2026-09-30 (amended 2026-11-22: audio jobs, decisions 14-17), revised the same day after design discussion. V18 (async ports),
  V19a (tenancy keys), V19 (the Postgres adapter) and V20a (the identity backend) are built; the rest of SLICES v0.4 (V20–V26) is the plan.
- **Date:** 2026-09-30
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0001](0001-local-first-hosting-shaped.md) (which this cashes in),
  [ADR-0002](0002-server-owns-score-api-only-writer.md), [ADR-0003](0003-op-log-and-optimistic-concurrency.md),
  [ADR-0005](0005-node-owns-api-python-omr-worker.md), [ADR-0006](0006-sqlite-json-document-store.md),
  [ADR-0008](0008-imperative-cli-verbs-plus-batch.md), [ADR-0022](0022-svelte-shell-and-api-versioning.md),
  [ADR-0028](0028-score-document-schema-versioning.md), [ADR-0029](0029-local-http-threat-model.md),
  [ADR-0031](0031-bespoke-recogniser.md)

## Context

ADR-0001 built the app "hosting-shaped" and `docs/hosting.md` mapped the transition. The direction has
now been chosen: **anyone can use sibei-score in a browser**, with open sign-up. The local app stays a
supported way to run it, but the hosted web app is the primary interface, and it must be drivable by
agents — from the CLI and from a **remote MCP endpoint** — as an authenticated user.

Decisions from the design discussion: open sign-up with **GitHub login first** (Google and others
later); the only users for now are the maintainer and the agent, so launch rigour is about the *shape*,
not the scale; **import ships as beta on the bespoke engine**; deployment is **Docker Compose on a
single VM** (Hetzner or DigitalOcean) behind **Caddy** for TLS; local mode remains an option;
`sbscore auth login` authenticates against the platform; beta data may be wiped.

Reading the code against `hosting.md` found that the "swap" framing understates one thing. **The
`ScoreStore`, `JobStore` and `Authenticator` ports are synchronous** (shaped by SQLite's in-process,
synchronous driver). Every Postgres driver in Node is promise-based, because a query is a network
round-trip, so a Postgres adapter — and any session-lookup authenticator — is async-only. The first
slice is therefore a no-behaviour-change refactor of the ports, not an adapter.

## Decision

1. **Ports go async first (V18), on SQLite, with no behaviour change.** `ScoreStore`, `JobStore` and
   `Authenticator` return promises, and the applier awaits them (the store's `create` and `commit` are
   already the units of work, so there is no applier-level transaction to convert). Every existing test
   must pass unchanged in meaning. Paying this before Postgres keeps the two risks apart.
2. **Postgres is a second adapter behind the same port (V19, built)**, selected by config
   (`SBSCORE_DATABASE_URL` / `--database-url` → Postgres, otherwise SQLite — the *named* variable, not the
   generic `DATABASE_URL`, so an ambient value in an unrelated environment cannot silently move a local
   library). One shared **conformance suite** runs against both adapters. Tenancy is
   the existing `owner` column, backed by **row-level security** with the owner set per transaction
   (`SET LOCAL`). Schema versioning stays forward-on-read (ADR-0028). In production Postgres runs **in
   the Compose stack on the VM**; because it is just a database URL, a managed Postgres (Neon, etc.)
   is a config change, not a redesign. As built: documents and log payloads are stored as `text`, not
   `jsonb`, so they round-trip byte-for-byte as SQLite's do (the export cache key digests the serialised
   document); RLS is `ENABLE`d and `FORCE`d on every table with default-deny policies keyed on
   `app.owner`, plus an `app.system` branch on `import_jobs` only, for the runner; and **the adapter
   refuses to run as a superuser or `BYPASSRLS` role** (the official image's default user is one, and
   running as it would silently switch the backstop off) unless told to with `--allow-rls-bypass`.
3. **Identity is ours, GitHub is the login provider (V20).** The API implements the GitHub OAuth code
   flow directly, stores `users` (keyed by an internal id, not the GitHub login) and hashed `sessions`,
   and the browser gets an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. No passwords are ever
   stored. Providers are a small table (`provider`, `subject`) so Google etc. add rows and a route, not
   a redesign. The `owner` on every row becomes the user id. Local mode keeps `resolveLocalPrincipal`
   and owner `local`.
4. **CLI and agents authenticate with API tokens obtained by a device flow (V21).**
   `sbscore auth login` starts an RFC 8628-style device authorisation on *our* server: the CLI prints a
   short code and a URL, the user approves in the browser (already signed in via GitHub), and the CLI
   receives a token minted by us. Tokens are random, stored **hashed**, named, scoped, revocable from
   the web UI, and expire. They live in a `0600` credentials file (per base URL). `auth
   logout|status|token` round it out; `auth login --token` is the headless fallback. GitHub's own
   tokens never reach the CLI. Bearer-token requests are exempt from the cookie CSRF concern; cookie
   requests keep the Origin/Host guards.
5. **The remote MCP endpoint is first-class and lands right after tokens (V22).** A **Streamable HTTP
   MCP endpoint at `/mcp`**, same origin, is a route family on the API that goes through the same
   services and the same applier — never a second write path (ADR-0003). It is an **OAuth 2.1
   resource**: our own authorisation server (PKCE, dynamic client registration, authorisation-server
   and protected-resource metadata) reuses the GitHub session for consent and issues tokens from the V21
   token model, with an audience and scopes. Tools are built for agents: reads use the existing text
   projection (`sbscore show`), writes go through `batch` and addresses, and failures return ADR-0008's
   structured errors including `currentVersion`; export and render are tools too. `sbscore mcp` (stdio)
   is a thin local wrapper over the same client and stored credentials. The CLI remains the equivalent
   for agents that have a shell.
6. **Blobs stay on a volume at first (V23).** A single VM has a disk, and the existing directory
   `BlobStore` already works on it, so the S3-compatible adapter is deferred until there is a second
   host or a reason. The port is unchanged, so it remains a pure adapter when needed.
7. **Hosted guards widen, they do not loosen (V23).** The Host/Origin allow-list takes the real
   domain from config; bodies stay capped; add per-user and per-IP rate limits (shared counters in
   Redis) and per-user quotas (score count, stored bytes, import pages). Open sign-up makes quotas part
   of the launch, because the shape is the deliverable. Amends ADR-0029, which is local-only.
8. **Redis is in from day 1 (V23).** It carries the **cross-process change bus** (so an SSE client on
   any API process hears an edit made through another) and the **rate-limit counters**. The in-process
   bus stays the local default; the bus is a port with a Redis adapter, selected by config. Pub/sub is
   fire-and-forget, which is acceptable because a client that misses an event re-reads the current
   version. This supersedes the earlier lean towards Postgres `LISTEN/NOTIFY`.
9. **Deploy is Docker Compose on one VM, TLS by Caddy (V24).** The OCI images and a **hosted Compose
   profile** are the reference runtime: `caddy` (automatic certificates, the only published ports,
   80/443), the `api` (serving the UI, V8g), the `worker`, `postgres` and `redis` on a private network,
   volumes for Postgres and blobs. Images are built in CI and pushed to a registry; the VM pulls them.
   Secrets are an env file that is not in the repo. Backups are a nightly `pg_dump` shipped off the box
   (beta: best effort, no durability promise). The API runs as a single replica to start; Redis is what
   makes a second one a config change. Kubernetes is **not** used; nothing here precludes it later,
   because the artifact is plain images plus config.
10. **Import in the hosted app is beta and runs on the bespoke engine (V26).** The hosted deployment
    sets `SIBEI_OMR_ENGINE=bespoke` (~300 MB, ~0.6 s/page), so the worker is a small always-on
    container in the same Compose stack and oemer is not deployed. This is a **deliberate beta
    exception to ADR-0031's "swap the default only when the harness says so"**: the *local* default
    stays `oemer` until V17f. The UI must say plainly that chord recognition is unreliable (end-to-end
    chord F1 ~0.13, ADR-0031 / V17e) — notes and bars are the usable part.
11. **Retention: hard delete, no promises (V25).** Deleting an account removes its scores, op logs, jobs,
    sessions, tokens and blobs in one operation, with no soft-delete or grace period. A blob lives as
    long as the score or job that references it (reparse and the source pane need it); a sweep removes
    orphans. The UI states that this is a beta, data may be wiped, and exporting is the way to keep a
    chart. The ADR-0001 copyright posture stands: uploads are private and account-scoped, there is no
    shared library, and user uploads are never a training corpus.
12. **Local mode is preserved by config, and the primary surface is the web app.** `sbscore serve`
    (SQLite, local principal, loopback bind) is unchanged. The CLI gains a base-URL/profile so the same
    binary talks to local or hosted. The README and UI lead with the hosted app.
13. **`/v1` becomes additive-only from the first hosted deploy** (ADR-0022). New auth and MCP routes are
    additive.

## Amendment 2026-11-22: audio jobs (SIB2-135)

[ADR-0039](0039-product-direction-and-schedule.md) puts audio in the 2026 hosted launch. The audio
engine is a separate repo (music-audio-transcriber) that runs on a GPU; its output contract is
NoteEvents v1, owned there. This amendment settles the queue, the storage and the retention; billing is
deliberately **not** decided (ADR-0039 decision 7).

14. **The audio worker pulls (supersedes the "worker is a push client" assumption for audio only).**
    A second job kind, `audio`, lives in the same durable job table as import (ADR-0001). The worker
    holds a **worker credential** (`sbsw_` prefix, stored hashed, configured by the operator, never a
    user token) and calls out over HTTPS: `POST /v1/worker/audio/claim` takes the oldest queued audio job and
    grants a **lease**; heartbeat extends it; complete or fail ends it (the exact wire format is
    [Audio worker protocol v1](#audio-worker-protocol-v1) below). A lease that is not renewed within its timeout is expired and the job goes back
    to `queued` with its attempt count incremented, up to a bounded number of attempts, after which it
    fails with a diagnostic. A GPU host is behind NAT or preemptible, so it calls out; claiming gives
    back-pressure, retry after a lost lease and several workers for free. The OMR worker stays push
    (ADR-0005): the two are not unified. The worker credential can reach **only** `/v1/worker/*`: it has
    no owner, no scores, no library, and `tests/arch/http-boundary.test.ts` keeps the worker routes out
    of the user principal path. A job claimed by a worker is addressed by job id alone; the lease
    token returned by claim must accompany every later call, so a stale worker cannot complete a job
    that was re-queued and claimed by another.
15. **Bytes move by presigned URL, never through the API.** The API mints a presigned `PUT` for the
    upload (browser or CLI to the object store) and a presigned `GET` for the worker to fetch it; the
    worker uploads nothing but a small result document, which travels in the `complete` request body
    (NoteEvents is JSON and bounded). This amends decision 6: the S3-compatible `BlobStore` adapter is
    no longer deferred, because presigned transfer is the first real reason. The port gains an optional
    `presign` capability; the directory adapter does not implement it and local mode keeps proxying
    through the API exactly as before. The upload is validated at the boundary (ADR-0029): declared
    content type and a size cap are signed into the URL, and the job moves to `queued` only when the
    client confirms and the object's existence and size are checked.
16. **Retention of uploaded audio.** Audio is copyright-sensitive. It is private to the account, never
    shared and never a training corpus (ADR-0001). The audio object is deleted as soon as the job
    reaches a terminal state (succeeded, failed for good, or cancelled) and in any case no later than
    **24 hours** after upload (a sweep removes orphans, configurable); it is not kept for re-parse, as
    photo sources are, because the result document is the product. The NoteEvents result is kept with
    the job as long as the job exists. Account deletion (decision 11) removes jobs and any remaining
    audio objects in the same operation.
17. **The metering unit is audio-seconds.** When a job succeeds, the duration the worker reports (and
    the API cross-checks against the file's declared duration within a tolerance) is recorded once in a
    per-user ledger, idempotent on the job id, so a retried or redelivered completion adds nothing.
    A free-tier cap is configuration (audio-seconds per period) checked when a job is created. **How
    seconds become money, the plans and the provider are not decided here**; the ledger is the input to
    whichever decision follows.

### Audio worker protocol v1

This is the contract the audio repo's worker (music-audio-transcriber) builds a pull client against.
SIB2-138 implements it; a change after merge is a version bump (`/v1/` is additive-only, decision 13).
The result document is **NoteEvents v1** (`schemas/note-events-v1.schema.json` in the audio repo, which owns
it; `Beat.is_downbeat` may be `null`). The API stores it and hands it to the import service; it does not
define the schema.

**Auth.** Every worker call carries `Authorization: Bearer sbsw_<random>`. Worker credentials are minted by
the operator (`SBSCORE_AUDIO_WORKER_TOKENS`, comma-separated, each `sbsw_` plus at least 32 characters; the API keeps only their SHA-256) and are not
users: no owner, no session, no scopes. A `sbsw_` credential is accepted on `/v1/worker/*` **only**
(anywhere else: `403 forbidden`), and a user token or cookie on `/v1/worker/*` is `403 forbidden`. A worker
therefore cannot list, read or write any user's scores, library or other jobs; it sees only the job it
holds a lease on. A missing or unknown credential is `401 unauthenticated`. Over TLS only in hosted mode. Content type is `application/json` both ways.

**Lifecycle.** `queued -> running (leased) -> succeeded | failed`, plus `running -> queued` when a lease is
lost or a worker reports a retryable failure. Each claim increments `attempt`; the job fails for good
after **3 attempts** (`worker-lost` or the worker's own kind). A failed or cancelled job commits nothing.

**1. Claim** — `POST /v1/worker/audio/claim`

```json
{ "workerId": "gpu-7f3a", "waitSeconds": 20 }
```

`workerId` is a free-form label for logs (not trusted). `waitSeconds` (0-30, default 0) long-polls for a
job. No job: `204`, no body (poll again with back-off). A job: `200`

```json
{
  "job": {
    "id": "job_01J...",
    "attempt": 1,
    "leaseToken": "l_9c1...",
    "leaseExpiresAt": "2026-12-01T10:02:00.000Z",
    "heartbeatIntervalSeconds": 30,
    "audio": {
      "url": "https://bucket.example/...signed...",
      "method": "GET",
      "headers": {},
      "viaApi": false,
      "expiresAt": "2026-12-01T11:00:00.000Z",
      "contentType": "audio/mpeg",
      "sizeBytes": 4123456
    },
    "params": { "instrument": "piano", "declaredDurationSeconds": 183.2 },
    "resultUpload": {
      "url": "https://bucket.example/...signed...",
      "method": "PUT",
      "headers": { "Content-Type": "application/json" },
      "viaApi": false,
      "expiresAt": "2026-12-01T13:00:00.000Z"
    }
  }
}
```

`params.instrument` is optional and is one the audio engine understands (it is the user's choice, passed
through). `declaredDurationSeconds` is what the uploader's metadata said, advisory. `resultUpload` is
present only when the blob store presigns (hosted); local disk mode omits it and the worker inlines the
result. `audio.url` is a presigned `GET` valid 1 hour from claim, re-issued by heartbeat (below). The
audio object is deleted when the job reaches a terminal state (decision 16): download once, do not rely
on it afterwards.

**2. Heartbeat** — `POST /v1/worker/audio/jobs/{id}/heartbeat`

```json
{ "leaseToken": "l_9c1...", "progress": { "stage": "transcribing", "fraction": 0.4 } }
```

`progress` is optional, shown to the user as-is (`stage` is a short label, `fraction` 0-1). `200`:

```json
{ "leaseExpiresAt": "2026-12-01T10:04:00Z", "cancelled": false, "audio": { "url": "...", "method": "GET", "headers": {}, "viaApi": false } }
```

Each heartbeat sets the lease to now + **120 s**; send one every `heartbeatIntervalSeconds` (**30 s**). A
lease runs only while heartbeats keep arriving (there is no absolute cap in v1). If the user deleted the
job the answer is still `200` but `cancelled` is `true` and `leaseExpiresAt` is `null`: stop and discard (a
later `complete` is `409 lease-lost`). With object storage every heartbeat carries a freshly signed
`audio` GET, so a long job never works against a lapsed URL; with the local store `audio` is `null`.
Timestamps are second-resolution UTC (`2026-12-01T10:04:00Z`).

Local mode (no object storage) has nothing to sign: the claim's `audio` is `{ url: "/v1/worker/audio/jobs/{id}/content",
method: "GET", headers: { "x-lease-token": "..." }, viaApi: true }`, fetched with the worker credential
plus that header, and `resultUpload` is absent so the result goes inline.

**3. Complete** — `POST /v1/worker/audio/jobs/{id}/complete`

```json
{
  "leaseToken": "l_9c1...",
  "durationSeconds": 183.2,
  "result": { "inline": { "schema_version": 1, "...": "NoteEvents v1" } }
}
```

or, after `PUT`ting the NoteEvents JSON to `resultUpload`, `"result": { "uploaded": true }`. Inline bodies
are limited to **8 MiB** (`413 body-too-large`; use the upload for more). `durationSeconds` is the audio
length the worker decoded; it is the metering input (decision 17) and the API cross-checks it against the
file. `200 { "status": "succeeded" }`; the API stores the document and runs the import hook. If the hook
refuses the document (it does not validate as NoteEvents v1) the job becomes `failed`, non-retryable, with
kind `invalid-result`, the result is kept for diagnosis, and the same call answers `200 { "status": "failed" }`:
the worker's work was delivered, the document was the problem, so there is nothing to retry. An upload
that is not there yet is `400 bad-request`; one that is not a JSON object is `422 invalid-result`.
**Complete is idempotent**: a repeat with the same `leaseToken` after success returns the same `200`
(plus `"alreadyCompleted": true`) and changes nothing, so a worker that lost the response can simply retry.
A `leaseToken` that is not the current holder's is `409 lease-lost`.

**4. Fail** — `POST /v1/worker/audio/jobs/{id}/fail`

```json
{ "leaseToken": "l_9c1...", "kind": "unsupported-audio", "message": "no audio stream", "retryable": false }
```

`kind` is a short slug for the user-facing diagnostic (suggested: `unsupported-audio`, `audio-too-long`,
`engine-error`, `out-of-memory`); `message` is for the operator, truncated to 500 characters, and never
shown verbatim as trusted text. `retryable: true` re-queues (counts against the 3 attempts); `false` fails
the job. `200 { "status": "queued" | "failed" }`. Also idempotent per lease.

**Lease expiry and re-queue.** A sweep on every claim and every 15 s finds `running` jobs whose lease has
passed: attempt < 3 puts them back to `queued` (the next claim gets a new `leaseToken`; the old one is
dead, so a returning stale worker gets `409 lease-lost` on its next call and must abandon the work);
otherwise the job fails with kind `worker-lost`. The worker has no obligation to clean anything up on loss.

**Errors.** `{ "error": { "kind": "...", "message": "..." } }` with ADR-0008's shape, HTTP status by
kind: `400 bad-request`, `401 unauthenticated` (missing/unknown credential), `403 forbidden` (wrong kind of
credential for the route), `404 no-such-audio-job` (no such job, or not this lease's: the same answer, so ids reveal
nothing), `409 lease-lost`, `413 body-too-large`, `422 invalid-result`. `5xx` and `429` (`Retry-After`) are
retried with back-off. Network errors and `5xx` are retried by the worker with
exponential back-off; `complete` and `fail` are safe to retry.

## Consequences

- V18 is a wide but mechanical diff and is the riskiest early step; doing it alone, on SQLite, is the
  mitigation.
- We own session and token handling, including an OAuth authorisation server for MCP. That is more
  security-sensitive code than adopting a hosted identity product; it is the trade for keeping the
  API framework-free and the CLI/MCP flows ours. Mitigations: hashed secrets at rest, short-lived and
  single-use device codes, no passwords, tests for cross-tenant leakage, and RLS as a backstop for a
  missed `WHERE`.
- We own the VM: OS patching, disk, Docker upgrades, certificate renewal (Caddy automates the last),
  monitoring and the backup job. That is the accepted cost of the Compose choice; a single VM is also a
  single point of failure, acceptable for a beta.
- Five services on one box (caddy, api, worker, postgres, redis) is a memory budget to size: the
  worker is ~300 MB and the rest are small, so a 4 GB VM is a comfortable floor.
- Local users see no change unless they opt into `DATABASE_URL`.

## Alternatives considered

- **Fly.io + Neon.** Fastest to a public URL, with managed TLS, deploys, backups and a route to more
  machines. Rejected in favour of owning the infrastructure and keeping one portable Compose artifact;
  the images are unchanged if we move later.
- **Kubernetes.** Overkill for one API, one worker, Postgres and Redis and two users: it adds a cluster,
  ingress, cert management and upgrades without solving a problem we have. Revisit only with a reason.
- **Hosted identity product (Neon Auth, Clerk, Auth0).** Less code to own, more providers. Rejected for
  now: it puts the CLI device flow and MCP OAuth on a third party's constraints and makes local mode a
  second auth path. Revisit if provider sprawl grows.
- **Stay on SQLite (Litestream) on the VM.** Avoids V18 and V19 and is simpler for one host. Rejected
  because it keeps the store port unproven against a second engine, and Redis-backed multi-process
  is easier to reach with Postgres.
- **Postgres `LISTEN/NOTIFY` as the change bus.** One less service, but needs an unpooled connection
  for the listener and does not help rate limits. Superseded by decision 8.
- **CLI login by pasting a token from the web UI.** Kept only as the headless fallback.

## Open questions

- Which provider, Hetzner or DigitalOcean, and the VM size — a config choice, not an architectural one.
- Whether Postgres backups need a stated retention beyond "nightly, best effort".
- Rate-limit and quota numbers (set conservatively, tune with real use).

## Amendment (V25a, 2026-11): how account deletion is built

Decision 11 as implemented. `DELETE /v1/auth/account` takes the **session cookie only** (a leaked API token
must not be able to destroy the account it was minted for, so there is deliberately no `sbscore account
delete`: the one capability Q79 gives no CLI twin) and a body `{ "confirm": "<your login>" }`. It erases, in
order: the account's jobs, scores (op logs by cascade), every blob, the blob-ledger rows, and last the
identity (users, identities, sessions, device codes, tokens, OAuth codes). The identity goes last so a failure
part-way leaves the person signed in and able to press the button again; every step is idempotent.

A blob key is hashed into a filename or object name by every `BlobStore`, so the store cannot be asked what an
account holds. A **blob ledger** (`blob_refs`: owner, key, kind, first-recorded time) is the index: every
writer of a blob for an account records it (import scans and the export cache now; audio objects when that
slice lands). Import-scan and export keys are owner-scoped so two accounts never share a blob. The same
ledger is what the orphan/expired-blob sweep (V25b) and audio retention (decision 16) query by kind and age.
Residual: a *running* import that finishes after its job row was deleted lands a score for an account that no
longer exists; the sweep removes such orphans. A new table holding account data must be named in
`tests/arch/account-erasure-coverage.test.ts` and reached by one of the deletes above.

### Amendment: the join as built (SIB2-E10)

The import hook is `createAudioResultImporter` and is wired by default in `createApi`. Differences from the text
above: a job's `diagnostic` also carries the draft's warnings when it `succeeded` (it was failure-only), and
metering is recorded only for a job that ends `succeeded`, after the import, so a document the hook refuses is
not metered. The duration cross-check compares the document's `source.duration_s` with the worker's decoded
duration and with the declared one, and only adds a `duration-mismatch` warning (tolerance: the larger of 1 s
and 5%); it never rejects. The draft is score `audio-<jobId>`, so a redelivered `complete` lands one draft.
