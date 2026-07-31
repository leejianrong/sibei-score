#!/usr/bin/env bash
#
# V2's demo, exactly as SLICES.md describes it: author a short chart entirely from the CLI, show
# it, then run the same `note set` twice with a stale --if-version and watch the second fail with
# exit code 4 and the current version.
#
# The suite covers all of this, but a demo that only works inside vitest is not a demo. This runs
# the real binary against a real server over a real socket, and CI runs it on every PR.

set -euo pipefail

work="$(mktemp -d)"
export SIBEI_DATA="$work/scores.db"
log="$work/server.log"

# The server's structured logs go to stderr, one JSON object per request. Useful, but they would
# drown the demo, so they go to a file and the path is printed in case a run needs reading.
pnpm tsx packages/cli/src/bin.ts serve --port 4321 >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

# Wait for it, rather than sleeping and hoping.
for _ in $(seq 40); do
  if pnpm -s sibei health >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "server log: $log"
pnpm -s sibei health

echo
echo '--- author a chart, note by note'
pnpm -s sibei new --id soul --title 'Body and Soul' --composer 'Johnny Green' --key Db --bars 8
pnpm -s sibei note add soul bar1.beat1   --pitch Db5 --dur 8
pnpm -s sibei note add soul bar1.beat1.5 --pitch Eb5 --dur 8
pnpm -s sibei note add soul bar1.beat2   --pitch F5  --dur 4
pnpm -s sibei note add soul bar1.beat3   --pitch Gb5 --dur 2
pnpm -s sibei note add soul bar2.beat1   --pitch F5  --dur 4 --tie start
pnpm -s sibei rest add soul bar2.beat2   --dur 4
pnpm -s sibei meta set  soul --style Ballad

echo
echo '--- sibei show: the four-bar grid, with the addresses it accepts'
pnpm -s sibei show soul

echo
echo '--- the same note set twice, the second with a stale --if-version'
version="$(pnpm -s sibei show soul --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
pnpm -s sibei note set soul bar1.n1 --pitch C5 --if-version "$version"

set +e
pnpm -s sibei note set soul bar1.n1 --pitch B4 --if-version "$version"
code=$?
set -e

echo "exit code: $code"
if [ "$code" -ne 4 ]; then
  echo "FAIL: a stale write must exit 4, not $code" >&2
  exit 1
fi

echo
echo '--- and the first edit survived, which is why the check exists'
pnpm -s sibei show soul | grep -q 'n1 c5/8' || { echo 'FAIL: the surviving edit is missing' >&2; exit 1; }
echo 'ok'
