# Deploying the hosted stack

A runbook for putting the hosted app (ADR-0034) on one VM with Docker Compose. It contains no secrets; every
secret lives in an `.env` file on the VM that is never committed. The architecture and the reasons behind it
are in `docs/adr/0034-hosted-web-app-primary.md` and `docs/hosting.md`; this page is the steps.

```
internet ──443/80──> caddy ──> api ──> postgres
                                 ├───> redis
                                 └───> worker      (api also calls out to github.com to sign people in)
```

Only Caddy publishes ports. The API, Postgres, Redis and the worker have none, and the three data services
sit on an `internal` Docker network with no route to the internet (`compose.hosted.yaml`).

## What you need before you start

| Thing | Notes |
|---|---|
| A VM | Linux, 4 GB RAM and 40 GB disk is comfortable (API ~300 MB, bespoke worker ~300 MB, Postgres, Redis, Caddy). 2 GB works for a quiet beta. Hetzner or DigitalOcean; the choice is not architectural. |
| A domain | Its A (and AAAA) record must point at the VM **before** the first start, or Caddy cannot get a certificate and will retry against Let's Encrypt's rate limits. |
| Open ports | 80 and 443 from the internet (80 is the certificate challenge and the http-to-https redirect). Nothing else. |
| A GitHub OAuth App | https://github.com/settings/developers, "New OAuth App". Homepage `https://<domain>`, callback `https://<domain>/v1/auth/github/callback`. Keep the client id and generate a client secret. |
| Docker | Docker Engine with the compose plugin. |
| Somewhere to ship backups | An [rclone](https://rclone.org) remote (S3, B2, another box). A dump that only lives on the VM is not a backup. |

## First deploy

```sh
# on the VM
git clone https://github.com/<owner>/sibei-score.git && cd sibei-score
cp deploy/hosted.env.example .env
chmod 600 .env
$EDITOR .env        # fill every REQUIRED value; generate passwords with: openssl rand -hex 24
```

The three GitHub settings are mandatory together (hosted mode is selected by configuration, and the API
refuses a partial set): `SBSCORE_PUBLIC_URL`, `SBSCORE_GITHUB_CLIENT_ID`, `SBSCORE_GITHUB_CLIENT_SECRET`.
`SBSCORE_AUDIO_WORKER_TOKENS` holds the bearer tokens the audio transcription worker will authenticate with
(`openssl rand -hex 32`, comma-separated); it has no effect until the audio endpoints are deployed.

```sh
docker compose -f compose.hosted.yaml config --quiet     # fails by name if a required variable is missing
docker compose -f compose.hosted.yaml up -d --build
docker compose -f compose.hosted.yaml ps                 # everything should become "healthy"
curl -fsS https://<domain>/v1/health                     # {"status":"ok","api":"v1"}
```

The schema migrates when the API opens the database, so a healthy API is a migrated one. The first start
also runs `deploy/postgres-init/01-app-role.sh`, which creates the `sibei_app` role the API connects as. It
is deliberately not a superuser: row-level security does not bind one, and the API refuses to start as one.

Then, in a browser: open `https://<domain>`, sign in with GitHub, create a chart, export a PDF. From a
terminal: `sbscore --url https://<domain> auth login` and approve the code in the browser.

## Backups

Nightly, from cron on the VM:

```cron
17 3 * * *  cd /home/<user>/sibei-score && ./deploy/backup.sh >> backups/backup.log 2>&1
```

`deploy/backup.sh` writes `backups/sibei-<timestamp>.sql.gz`, deletes local dumps older than
`BACKUP_KEEP_DAYS` (14), and copies the new one to `BACKUP_REMOTE` with rclone. Set `BACKUP_REMOTE` in `.env`
(for example `offsite:sibei-backups`) and run `rclone config` once as the same user; until you do, the script
says so on every run.

What a backup covers: Postgres, which holds scores, op logs, jobs, users, tokens and the blob ledger. What
it does not: the `api-blobs` volume (import scans and the export cache). Exports are re-derivable and scans
are re-uploadable, and the beta notice says data can be wiped. Redis holds nothing that matters (pub/sub and
counters).

**Prove a backup restores** before you trust it, and after any change to the schema:

```sh
./deploy/restore.sh backups/sibei-<timestamp>.sql.gz            # loads into a NEW database, sibei_restore
docker compose -f compose.hosted.yaml exec postgres psql -U postgres -d sibei_restore -c 'SELECT count(*) FROM scores'
docker compose -f compose.hosted.yaml exec postgres psql -U postgres -c 'DROP DATABASE sibei_restore'
```

### Disaster recovery (a new VM, or a wiped database)

1. Bring the stack up as in "First deploy" with the same `.env` (the passwords must match the ones the dump's
   data was written under only for Redis and the app role; the dump carries no role passwords).
2. Stop the API so nothing writes: `docker compose -f compose.hosted.yaml stop api`.
3. Replace the empty database: `docker compose -f compose.hosted.yaml exec postgres psql -U postgres -c 'DROP DATABASE sibei' -c 'CREATE DATABASE sibei OWNER sibei_app'`.
4. `./deploy/restore.sh backups/<dump>.sql.gz sibei`.
5. Start it: `docker compose -f compose.hosted.yaml start api`. Sessions and tokens are in the dump, so people stay
   signed in.

## Operating it

| To | Run |
|---|---|
| Update to a new version | `git pull && docker compose -f compose.hosted.yaml up -d --build` (migrations run on start) |
| See logs | `docker compose -f compose.hosted.yaml logs -f api` (the API logs method, path, status and duration, never bodies, cookies or tokens; Caddy redacts credentials in its access log by default) |
| Tune limits and quotas | set the `SBSCORE_LIMIT_*` / `SBSCORE_QUOTA_*` variables in `.env` (listed, commented out, in the template) and `up -d` again |
| Rotate the GitHub client secret | change it in GitHub and `.env`, then `up -d`; sessions survive (they are ours, not GitHub's) |
| Rotate a worker token | replace it in `SBSCORE_AUDIO_WORKER_TOKENS` and in the worker's config, then `up -d` |
| Add a second API replica | not yet: the API runs as one replica. Redis already carries the change bus and the rate-limit counters, so it is a configuration change when the time comes |

The compose file restarts every service on failure (`unless-stopped`) and gives each a health check. For an
external monitor, probe `https://<domain>/v1/health`.

## What this does not do yet

- **No CI-built images.** The VM builds the API and worker images itself. Pushing prebuilt images to a
  registry (and setting `API_IMAGE`) is a follow-up.
- **The worker image needs the bespoke model weights** baked in (ADR-0024) for `SIBEI_OMR_ENGINE=bespoke`; that
  provisioning belongs to V26 (import beta on hosted). Until then, import on a deployment without them
  fails with a retryable diagnostic and everything else works.
- **Off-box backup needs a destination you choose** (`BACKUP_REMOTE`).

## The local smoke test

`bash scripts/smoke-hosted.sh` brings the whole stack up on loopback with a fake GitHub, signs in, creates and
exports a chart, checks that only Caddy publishes a port and that a foreign Origin is refused, takes a backup
and restores it into a fresh database, deletes the account, and tears everything down. It needs Docker, curl
and jq, builds the API image (minutes the first time), and starts no worker. It deploys nothing.
