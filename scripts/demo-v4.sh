#!/usr/bin/env bash
#
# V4's demo, exactly as SLICES.md describes it: open a chart in the browser, then run `sbscore note
# set` on the same chart in a terminal and watch the browser repaint without a reload. The two
# surfaces visibly cannot disagree, because they are two clients of one API (ADR-0002) and the
# change stream (V4a) tells the open view that a new version exists (V4d).
#
# Unlike `demo-v2.sh`, this one is *interactive* — a person has to look at the browser — so it is
# not a CI job. The automated proof of the same claims is `tests/browser/live-updates.test.ts`,
# which boots this exact stack and drives a real Chromium; CI runs it in the infra layer. This
# script is for watching it happen with your own eyes.
#
# It starts the API and the Vite dev server, authors a short chart, prints the URL and the command
# to run, and waits. Ctrl-C stops both servers.

set -euo pipefail

work="$(mktemp -d)"
export SBSCORE_DATA="$work/scores.db"
api_log="$work/api.log"
ui_log="$work/ui.log"

pnpm tsx packages/cli/src/bin.ts serve --port 4321 >"$api_log" 2>&1 &
server=$!
# `pnpm ui` is Vite; its proxy target defaults to 127.0.0.1:4321, which is where the API is.
pnpm ui >"$ui_log" 2>&1 &
ui=$!
trap 'kill "$server" "$ui" 2>/dev/null || true' EXIT

for _ in $(seq 40); do
  if pnpm -s sbscore health >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "api log: $api_log"
echo "ui  log: $ui_log"
pnpm -s sbscore health

echo
echo '--- author a short chart from the CLI'
pnpm -s sbscore new --id live --title 'Autumn Leaves' --composer 'Joseph Kosma' --key Gm --bars 8
pnpm -s sbscore note add live bar1.beat1 --pitch E5 --dur 4
pnpm -s sbscore note add live bar1.beat2 --pitch A5 --dur 4
pnpm -s sbscore note add live bar1.beat3 --pitch B5 --dur 2

# Wait for Vite to be ready to serve, rather than printing a URL that 404s for a second.
for _ in $(seq 80); do
  if curl -sf -o /dev/null http://127.0.0.1:5173/; then break; fi
  sleep 0.25
done

cat <<EOF

------------------------------------------------------------------------
  Open this in a browser:

      http://127.0.0.1:5173/#/score/live

  Then, in another terminal, edit the chart from the CLI:

      pnpm sbscore note set live bar1.n1 --pitch C5

  Watch the note change and the version tick up in the rail — no reload.
  Every edit is an op through the same /v1/ API the browser writes to.

  Ctrl-C to stop both servers.
------------------------------------------------------------------------

EOF

# Keep the servers up until the operator is done looking.
wait "$server"
