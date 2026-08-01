#!/usr/bin/env bash
#
# V2's demo, exactly as SLICES.md describes it: author a short chart entirely from the CLI, show
# it, then run the same `note set` twice with a stale --if-version and watch the second fail with
# exit code 4 and the current version.
#
# V3d adds the closing beat that finishes the story — `sbscore export --pdf`, so the chart the demo
# just authored comes out as a printable page. The file keeps its name, and the CI job that runs
# it keeps its name too: the required status checks on `main` are matched by name, and renaming
# one makes every PR unmergeable on a check that can never report.
#
# The suite covers all of this, but a demo that only works inside vitest is not a demo. This runs
# the real binary against a real server over a real socket, and CI runs it on every PR.

set -euo pipefail

work="$(mktemp -d)"
export SBSCORE_DATA="$work/scores.db"
log="$work/server.log"

# The server's structured logs go to stderr, one JSON object per request. Useful, but they would
# drown the demo, so they go to a file and the path is printed in case a run needs reading.
pnpm tsx packages/cli/src/bin.ts serve --port 4321 >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

# Wait for it, rather than sleeping and hoping.
for _ in $(seq 40); do
  if pnpm -s sbscore health >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "server log: $log"
pnpm -s sbscore health

echo
echo '--- author a chart, note by note'
pnpm -s sbscore new --id soul --title 'Body and Soul' --composer 'Johnny Green' --key Db --bars 8
pnpm -s sbscore note add soul bar1.beat1   --pitch Db5 --dur 8
pnpm -s sbscore note add soul bar1.beat1.5 --pitch Eb5 --dur 8
pnpm -s sbscore note add soul bar1.beat2   --pitch F5  --dur 4
pnpm -s sbscore note add soul bar1.beat3   --pitch Gb5 --dur 2
pnpm -s sbscore note add soul bar2.beat1   --pitch F5  --dur 4 --tie start
pnpm -s sbscore rest add soul bar2.beat2   --dur 4
pnpm -s sbscore meta set  soul --style Ballad

echo
echo '--- sbscore show: the four-bar grid, with the addresses it accepts'
pnpm -s sbscore show soul

echo
echo '--- the same note set twice, the second with a stale --if-version'
version="$(pnpm -s sbscore show soul --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
pnpm -s sbscore note set soul bar1.n1 --pitch C5 --if-version "$version"

set +e
pnpm -s sbscore note set soul bar1.n1 --pitch B4 --if-version "$version"
code=$?
set -e

echo "exit code: $code"
if [ "$code" -ne 4 ]; then
  echo "FAIL: a stale write must exit 4, not $code" >&2
  exit 1
fi

echo
echo '--- and the first edit survived, which is why the check exists'
pnpm -s sbscore show soul | grep -q 'n1 c5/8' || { echo 'FAIL: the surviving edit is missing' >&2; exit 1; }
echo 'ok'

echo
echo '--- the closing beat (V3d): export the chart the CLI just authored'
# -o takes a directory as readily as a file, and puts the chart's own name in it. The CLI renders
# nothing: these bytes came off the API's export route (ADR-0002).
pnpm -s sbscore export soul --pdf -o "$work/"
pdf="$work/Body and Soul.pdf"
[ -s "$pdf" ] || { echo "FAIL: no PDF at $pdf" >&2; exit 1; }
head -c 5 "$pdf" | grep -q '%PDF-' || { echo 'FAIL: that is not a PDF' >&2; exit 1; }

echo
echo '--- and the same request again, which the export cache serves from disk'
pnpm -s sbscore export soul -o "$work/again.pdf" --json
cmp -s "$pdf" "$work/again.pdf" || { echo 'FAIL: the cached export differs from the rendered one' >&2; exit 1; }

echo
echo '--- a paper this build cannot produce is a refusal that lists what it can'
set +e
pnpm -s sbscore export soul --paper a5 -o "$work/never.pdf"
code=$?
set -e
echo "exit code: $code"
if [ "$code" -ne 2 ]; then
  echo "FAIL: an unsupported paper must exit 2, not $code" >&2
  exit 1
fi
if [ -e "$work/never.pdf" ]; then
  echo 'FAIL: a refused export wrote a file anyway' >&2
  exit 1
fi
echo 'ok'
