#!/usr/bin/env bash
# Run the Postgres integration tests (`tests/postgres/`, V19).
#
#   pnpm test:postgres
#       Starts a throwaway Postgres with Docker Compose (compose.test.yaml), runs the suite against it,
#       and removes it. Needs Docker and the `docker compose` plugin.
#
#   SBSCORE_TEST_DATABASE_URL=postgres://postgres:secret@host:5432/postgres pnpm test:postgres
#       Uses a server you already have instead (as a superuser: the tests create their own databases and
#       an ordinary `sibei_app` role, and connect as that). Docker is not touched.
#
#   KEEP_POSTGRES=1 pnpm test:postgres
#       Leaves the container running afterwards. Remove it with:  docker compose -f compose.test.yaml down -v
#
# Extra arguments go to vitest, e.g.  pnpm test:postgres tests/postgres/serve.test.ts
set -euo pipefail

cd "$(dirname "$0")/.."

started=0
if [ -z "${SBSCORE_TEST_DATABASE_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "test:postgres: Docker was not found, and SBSCORE_TEST_DATABASE_URL is not set." >&2
    echo "  Install Docker, or point SBSCORE_TEST_DATABASE_URL at a Postgres you already have." >&2
    exit 2
  fi
  echo "test:postgres: starting a throwaway Postgres (compose.test.yaml)..." >&2
  docker compose -f compose.test.yaml up -d --wait postgres >&2
  started=1
  export SBSCORE_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54330/postgres"
fi

cleanup() {
  if [ "$started" = 1 ] && [ -z "${KEEP_POSTGRES:-}" ]; then
    echo "test:postgres: removing the throwaway Postgres..." >&2
    docker compose -f compose.test.yaml down -v >&2 || true
  elif [ "$started" = 1 ]; then
    echo "test:postgres: leaving Postgres running on 127.0.0.1:54330 (docker compose -f compose.test.yaml down -v to remove)" >&2
  fi
}
trap cleanup EXIT

pnpm exec vitest run --project postgres "$@"
