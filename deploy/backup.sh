#!/usr/bin/env bash
# Nightly Postgres backup for the hosted stack (V24).
#
#   deploy/backup.sh                 dump now, rotate old local dumps, copy off the box if configured
#
# Writes `backups/sibei-YYYYmmddTHHMMSSZ.sql.gz.age`: a `pg_dump` of the `sibei` database, gzipped and
# **encrypted with age** to BACKUP_AGE_RECIPIENT before it touches the disk or leaves the box (SIB2-208). The
# dump holds every user's charts plus token hashes and sign-in sessions, so a plaintext copy in a bucket is a
# breach waiting for a misconfigured ACL. The private key stays off the VM; restore.sh takes it as an argument
# at restore time. With no recipient configured the script refuses to run: there is no plaintext mode.
#
# It deletes local dumps older than BACKUP_KEEP_DAYS (default 14), and, when BACKUP_REMOTE names an rclone
# remote, copies the new dump there. A dump that stays on the same VM as the database is not a backup, so the
# runbook treats an unset BACKUP_REMOTE as unfinished setup.
#
# What it does NOT back up: the blob volume (`api-blobs`: import scans and the export cache). Scores, their
# op logs, jobs, users and tokens are all in Postgres; the blobs are re-derivable (exports) or
# re-uploadable (scans). See docs/deploy-hosted.md.
#
# Schedule it with cron or a systemd timer on the VM; the runbook has both. Run from the repo directory.
set -euo pipefail

cd "$(dirname "$0")/.."

# COMPOSE_FILE selects the stack (the smoke test sets it to add its override); the default is production.
export COMPOSE_FILE="${COMPOSE_FILE:-compose.hosted.yaml}"
COMPOSE=(docker compose)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Fail before doing any work, and loudly: a backup nobody can encrypt must not quietly become a plaintext one.
recipient="${BACKUP_AGE_RECIPIENT:-}"
if [ -z "$recipient" ]; then
  echo "backup: BACKUP_AGE_RECIPIENT is not set, refusing to write an unencrypted backup." >&2
  echo "backup: generate a key pair OFF this machine (age-keygen -o key.txt), put the public key (age1...) in .env." >&2
  exit 1
fi
if ! command -v age >/dev/null 2>&1; then
  echo "backup: the \`age\` command is not installed (apt install age)" >&2
  exit 1
fi

dir="${BACKUP_DIR:-backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$dir"
umask 077
file="$dir/sibei-$(date -u +%Y%m%dT%H%M%SZ).sql.gz.age"
trap 'rm -f "$file.partial"' EXIT

# The superuser inside the container: `pg_dump` must read every table, and row-level security (which binds
# the application role) would hide other users' rows from it. The password never leaves the container.
"${COMPOSE[@]}" exec -T postgres pg_dump -U postgres --no-owner --no-privileges sibei | gzip -9 | age -r "$recipient" >"$file.partial"
mv "$file.partial" "$file"

# A truncated dump is worse than none: refuse an empty or tiny one.
if [ "$(stat -c %s "$file")" -lt 1024 ]; then
  echo "backup: $file is suspiciously small; keeping it for inspection and failing" >&2
  exit 1
fi
echo "backup: wrote $file ($(stat -c %s "$file") bytes)"

# Includes plaintext `.sql.gz` dumps left by versions of this script before encryption: they should not linger.
find "$dir" \( -name 'sibei-*.sql.gz.age' -o -name 'sibei-*.sql.gz' \) -mtime "+$keep" -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$file" "$BACKUP_REMOTE"
  echo "backup: copied to $BACKUP_REMOTE"
else
  echo "backup: BACKUP_REMOTE is not set, so this dump is only on this machine" >&2
fi
