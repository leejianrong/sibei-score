#!/usr/bin/env bash
# Smoke test for the hosted Compose stack (V24): brings it up on loopback with a fake GitHub, checks that it
# works end to end and that the API is reachable only through Caddy, then proves a backup restores and that
# account deletion empties the account. Tears everything down afterwards, whatever happens.
#
#   bash scripts/smoke-hosted.sh                 # builds the API image (minutes the first time)
#   KEEP=1 bash scripts/smoke-hosted.sh          # leave the stack running to poke at
#
# Needs Docker with the compose plugin, curl and jq. Uses loopback ports 18080 (the site) and 19000 (the fake
# GitHub), a throwaway project name, and a throwaway env file with random secrets that is never printed.
# It does not start the OMR worker (its image bakes ML weights and takes minutes to build, and nothing here
# imports). It does NOT deploy anything: see docs/deploy-hosted.md for that.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=18080
FAKE_PORT=19000
SITE="http://127.0.0.1:$PORT"
LOGIN=smoketest

work="$(mktemp -d)"
jar="$work/cookies"
envfile="$work/smoke.env"
umask 077

export COMPOSE_PROJECT_NAME=sibei-smoke
export COMPOSE_FILE="compose.hosted.yaml:compose.hosted-smoke.yaml"
export COMPOSE_ENV_FILES="$envfile"

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cat >"$envfile" <<EOF
SITE_ADDRESS=http://
SBSCORE_PUBLIC_URL=$SITE
HTTP_BIND=127.0.0.1
HTTP_PORT=$PORT
HTTPS_PORT=18443
SBSCORE_GITHUB_CLIENT_ID=smoke-client
SBSCORE_GITHUB_CLIENT_SECRET=smoke-secret
FAKE_GITHUB_PORT=$FAKE_PORT
FAKE_GITHUB_LOGIN=$LOGIN
POSTGRES_PASSWORD=$(rand)
SIBEI_APP_PASSWORD=$(rand)
REDIS_PASSWORD=$(rand)
EOF

pass=0
step() { printf '\n== %s\n' "$*"; }
ok() { pass=$((pass + 1)); printf '   ok: %s\n' "$*"; }
fail() { printf '   FAIL: %s\n' "$*" >&2; docker compose logs --tail 40 >&2 || true; exit 1; }

cleanup() {
  if [ -n "${KEEP:-}" ]; then
    echo "smoke: leaving the stack up (docker compose down -v to remove; env in $envfile)" >&2
    return
  fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

step "bring the stack up (no worker)"
docker compose up -d --build --wait --scale worker=0 >/dev/null || fail "the stack did not become healthy"
ok "caddy, api, postgres, redis and the fake GitHub are up and healthy"

step "the edge answers, and only the edge"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/v1/health")" = 200 ] || fail "/v1/health through Caddy"
ok "GET /v1/health through Caddy is 200"
published="$(docker compose ps --format json | jq -rs '[.[] | select((.Publishers // []) | any(.PublishedPort > 0)) | .Service] | sort | join(",")')"
[ "$published" = "caddy,fake-github" ] || fail "services publishing ports: [$published] (expected only caddy, plus the smoke-only fake-github)"
ok "only caddy publishes a port (and the smoke-only fake GitHub)"
api_port="$(docker compose port api 8080 2>/dev/null || true)"
case "$api_port" in ""|*:0) ;; *) fail "the api publishes a port ($api_port)" ;; esac
ok "the api has no published port, so it is reachable only through Caddy"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/v1/scores")" = 401 ] || fail "a signed-out request should be 401"
ok "a signed-out request is refused (401)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -X POST -H 'content-type: application/json' -d '{}' "$SITE/v1/scores")" = 403 ] || fail "a foreign Origin should be 403"
ok "a foreign Origin is refused (403)"

step "sign in with GitHub (the fake one)"
login_headers="$(curl -s -D - -o /dev/null -c "$jar" "$SITE/v1/auth/github/login")"
authorize="$(printf '%s' "$login_headers" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
[ -n "$authorize" ] || fail "no redirect to GitHub"
# The API names the fake by its compose address; the driver reaches the same server on its loopback publish.
authorize="${authorize/http:\/\/fake-github:9000/http:\/\/127.0.0.1:$FAKE_PORT}"
callback="$(curl -s -D - -o /dev/null "$authorize" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
[ -n "$callback" ] || fail "the fake GitHub did not redirect back"
done_headers="$(curl -s -D - -o /dev/null -b "$jar" -c "$jar" "$callback")"
printf '%s' "$done_headers" | head -1 | grep -q 302 || fail "the callback did not redirect"
me="$(curl -s -b "$jar" "$SITE/v1/me")"
[ "$(printf '%s' "$me" | jq -r '.user.login')" = "$LOGIN" ] || fail "/v1/me did not name $LOGIN: $me"
ok "signed in as $LOGIN"

step "create and export a chart"
curl -s -f -b "$jar" -H 'content-type: application/json' -X POST "$SITE/v1/scores" \
  -d '{"operation":{"type":"score.create","payload":{"id":"smoke","barCount":4,"title":"Smoke"}}}' >/dev/null || fail "create"
[ "$(curl -s -b "$jar" "$SITE/v1/scores" | jq '.scores | length')" = 1 ] || fail "the chart is not listed"
xml="$(curl -s -b "$jar" "$SITE/v1/scores/smoke/export?format=musicxml")"
printf '%s' "$xml" | grep -q "score-partwise" || fail "the MusicXML export is not MusicXML"
ok "created a chart, listed it, and exported MusicXML through Caddy"

step "a backup restores into a fresh database"
bash deploy/backup.sh >/dev/null 2>&1 || fail "backup"
latest="$(ls -1t backups/sibei-*.sql.gz | head -1)"
bash deploy/restore.sh "$latest" sibei_restore >/dev/null || fail "restore"
rows="$(docker compose exec -T postgres psql -U postgres -d sibei_restore -Atc 'SELECT count(*) FROM scores')"
[ "$rows" = 1 ] || fail "the restored database has $rows scores, expected 1"
rm -f "$latest"
ok "pg_dump taken, restored into sibei_restore, and the chart is in it"

step "deleting the account empties it"
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -H 'content-type: application/json' -X DELETE "$SITE/v1/auth/account" -d "{\"confirm\":\"$LOGIN\"}")"
[ "$code" = 204 ] || fail "account deletion answered $code"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$SITE/v1/me")" = 401 ] || fail "the session survived the deletion"
left="$(docker compose exec -T postgres psql -U postgres -d sibei -Atc "SELECT (SELECT count(*) FROM scores) + (SELECT count(*) FROM users) + (SELECT count(*) FROM blob_refs)")"
[ "$left" = 0 ] || fail "$left rows remain after the deletion"
ok "the account, its chart and its blob records are gone"

printf '\nsmoke: %s checks passed\n' "$pass"
