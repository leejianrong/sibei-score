#!/usr/bin/env bash
# Run the Redis integration tests (`tests/redis/`, V23): the cross-process change bus and the shared
# rate-limit counters, against a real Redis.
#
#   pnpm test:redis                       starts a throwaway Redis (compose.test.yaml), runs, removes it
#   SBSCORE_TEST_REDIS_URL=redis://host:6379 pnpm test:redis     uses one you already have
set -euo pipefail

cd "$(dirname "$0")/.."

started=0
if [ -z "${SBSCORE_TEST_REDIS_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "test:redis: Docker was not found, and SBSCORE_TEST_REDIS_URL is not set." >&2
    exit 2
  fi
  echo "test:redis: starting a throwaway Redis (compose.test.yaml)..." >&2
  docker compose -f compose.test.yaml up -d --wait redis >&2
  started=1
  export SBSCORE_TEST_REDIS_URL="redis://127.0.0.1:54331"
fi

cleanup() {
  if [ "$started" = 1 ]; then
    docker compose -f compose.test.yaml down -v >&2 || true
  fi
}
trap cleanup EXIT

pnpm exec vitest run --project redis "$@"
