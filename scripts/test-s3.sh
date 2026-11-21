#!/usr/bin/env bash
# Run the S3 blob-store tests (`tests/s3/`, SIB2-136).
#
#   pnpm test:s3
#       Starts a throwaway S3 gateway with Docker Compose (compose.test.yaml), runs the suite against it, and
#       removes it. Needs Docker and the `docker compose` plugin.
#
#   SBSCORE_TEST_S3_ENDPOINT=http://host:9000 SBSCORE_TEST_S3_ACCESS_KEY_ID=... \
#   SBSCORE_TEST_S3_SECRET_ACCESS_KEY=... pnpm test:s3
#       Uses an S3-compatible server you already have; the suite makes its own bucket.
#
# Extra arguments go to vitest.
set -euo pipefail

cd "$(dirname "$0")/.."

started=0
if [ -z "${SBSCORE_TEST_S3_ENDPOINT:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "test:s3: Docker was not found, and SBSCORE_TEST_S3_ENDPOINT is not set." >&2
    exit 2
  fi
  echo "test:s3: starting a throwaway S3 gateway (compose.test.yaml)..." >&2
  docker compose -f compose.test.yaml up -d s3 >&2
  started=1
  for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:54340/ && break; sleep 1; done
  export SBSCORE_TEST_S3_ENDPOINT="http://127.0.0.1:54340"
  export SBSCORE_TEST_S3_ACCESS_KEY_ID="sibeitest"
  export SBSCORE_TEST_S3_SECRET_ACCESS_KEY="sibeitest-secret"
fi

cleanup() {
  if [ "$started" = 1 ]; then
    docker compose -f compose.test.yaml down -v >&2 || true
  fi
}
trap cleanup EXIT

pnpm exec vitest run --project s3 "$@"
