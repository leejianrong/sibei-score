#!/usr/bin/env bash
# Restore a dump made by deploy/backup.sh into the hosted stack's Postgres (V24).
#
#   BACKUP_AGE_IDENTITY=/path/to/key.txt deploy/restore.sh backups/sibei-20261231T030000Z.sql.gz.age [database]
#
# A `.age` dump is decrypted with the private key named by BACKUP_AGE_IDENTITY (an age identity file). That
# key lives off the VM (SIB2-208): bring it for the restore, then take it away again. A plain `.sql.gz` from
# before backups were encrypted is still accepted.
#
# With no database name it restores into a NEW database called `sibei_restore` and leaves the live one
# alone, which is how you verify a backup is good. To replace the live database (disaster recovery), stop
# the API first, restore into `sibei`, and start it again; the runbook has the steps. The dump is taken with
# --no-owner, so the restored objects belong to whoever loads it: this script hands the database to
# `sibei_app` afterwards, which the API (and row-level security) require.
set -euo pipefail

cd "$(dirname "$0")/.."

dump="${1:?usage: deploy/restore.sh DUMP.sql.gz.age [database]}"
target="${2:-sibei_restore}"
# COMPOSE_FILE selects the stack (the smoke test sets it to add its override); the default is production.
export COMPOSE_FILE="${COMPOSE_FILE:-compose.hosted.yaml}"
COMPOSE=(docker compose)
psql_admin=("${COMPOSE[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1)

if [ "$target" != "sibei" ]; then
  "${psql_admin[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"$target\"" -c "CREATE DATABASE \"$target\" OWNER sibei_app"
fi

case "$dump" in
  *.age)
    : "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY to the age private key file that matches BACKUP_AGE_RECIPIENT}"
    age -d -i "$BACKUP_AGE_IDENTITY" "$dump" | gunzip -c | "${psql_admin[@]}" -q -d "$target" >/dev/null
    ;;
  *) gunzip -c "$dump" | "${psql_admin[@]}" -q -d "$target" >/dev/null ;;
esac

# Everything the dump created is owned by the superuser that loaded it; give it to the application role.
"${psql_admin[@]}" -d "$target" <<'SQL' >/dev/null
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO sibei_app', r.tablename);
  END LOOP;
END $$;
SQL

echo "restore: loaded $dump into database \"$target\""
