# tools/runpod — dev/build-time RunPod compute wrapper

**This is not part of the shipped product.** sibei-score is local-first and offline
(ADR-0001, ADR-0024); the running app never calls RunPod. This directory is a developer tool
that rents a pod, runs the **existing** OMR worker container (ADR-0005) on it to **produce an
artifact** — an oemer accuracy number now, trained checkpoints later — and then **guarantees the
pod is torn down** so it stops billing. Like `worker/`, it lives **outside** `pnpm-workspace.yaml`
so it can never enter a bundle. It imports no `packages/*` code; it only shells out (`curl`,
`runpodctl`) and sets env vars. The decision of record is [ADR-0032](../../docs/adr/0032-runpod-dev-compute-wrapper.md).

"Run oemer on RunPod" means: deploy the worker image there and point
`SBSCORE_WORKER_URL` / `pnpm eval --engine worker --url …` at it. No product code changes —
`scripts/eval.ts` already resolves `--url` → `SBSCORE_WORKER_URL` → `localhost`, and
`packages/api/src/imports/worker-client.ts` is a pure HTTP client.

> **Status: Proposed, gated on a go/no-go spike.** Nothing here has spent money or created a pod.
> RunPod's CLI/REST surface changes; the endpoint shapes and `runpodctl` flags in `rp` are the
> best current understanding and **must be verified at real-run time**.

## Prerequisites

1. **Install `runpodctl`** (the pod-side dead-man's-switch and `fetch` use it):
   ```sh
   wget -qO- cli.runpod.net | sudo bash    # verify the current install method on RunPod's docs
   ```
2. **A dedicated, limited-scope API key.** Create a *separate*, revocable key with the minimum
   scope needed — not your account-wide key. Put it in `tools/runpod/.env` (gitignored):
   ```sh
   cp tools/runpod/.env.example tools/runpod/.env
   $EDITOR tools/runpod/.env        # set RUNPOD_API_KEY=… and RP_POD_IMAGE=…
   ```
   `rp` reads the key **by reference** (`: "${RUNPOD_API_KEY:?…}"`), feeds it to `curl` through a
   config file on stdin so it never appears in `argv`/`ps`, and never puts it in a URL. **Never**
   commit `.env`; the repo `.gitignore` already ignores it (and `tools/runpod/.rp-state`).
3. **Push the worker image to a registry the pod can pull.** `worker/Dockerfile` builds the
   image but pushes nowhere today — this is a **one-time prerequisite**, done by hand:
   ```sh
   docker build -t ghcr.io/<owner>/sibei-omr-worker:<tag> worker
   docker push  ghcr.io/<owner>/sibei-omr-worker:<tag>          # then set RP_POD_IMAGE to it
   ```
   > **Assumption to confirm with the orchestrator:** which registry (GHCR vs Docker Hub) and
   > image tag to use. This wrapper does not push for you.

## Lifecycle

```sh
export PATH="$PWD/tools/runpod:$PATH"    # or call ./tools/runpod/rp directly

rp up               # create-or-reuse a spot pod (name-tagged), dead-man's-switch armed; prints id
rp wait-ready       # poll https://{pod}-8000.proxy.runpod.net/health until 200
rp wait-ssh         # poll the pod's ssh (port 22) until it accepts a connection (on-pod eval)
rp run <cmd…>       # export SBSCORE_WORKER_URL to the pod, run <cmd> inside a trap that always downs
rp exec <cmd…>      # run a command on the pod over ssh
rp push <local> <r> # scp a file/dir up to the pod
rp pull <r> <local> # scp a file/dir down from the pod
rp eval-onpod [a…]  # full on-pod eval (see below); extra args go to both the dump and score commands
rp status           # the pod's status
rp logs             # pod info / where to read logs
rp fetch <code>     # pull a checkpoint/artifact off the pod (eval numbers already land locally)
rp down             # TERMINATE (delete) the pod — idempotent
```

- **`up` is idempotent:** it lists pods, finds the one tagged `RP_POD_NAME` (default
  `sibei-omr-eval`), and reuses it if present; otherwise it creates a **spot/interruptible** pod
  (cheaper, ~5s reclaim warning, and the eval job is re-runnable). It **refuses** if
  `RP_HOURLY_USD` exceeds the `RP_MAX_HOURLY_USD` cap.
- **`down` TERMINATES, it does not stop.** A merely *stopped* pod still bills for storage; only
  delete frees all cost. `down` is **idempotent** — deleting an already-gone pod is success.

## Cost & teardown guarantees

RunPod has **no native idle-terminate, no max-lifetime, and no per-pod spend cap**, and a
**disconnected laptop does not stop a running pod**. So teardown cannot be laptop-side only. Three
layers, defence-in-depth:

1. **Pod-side dead-man's-switch** (baked into the launch command by `rp up`, runs *inside* the
   pod, survives a laptop disconnect):
   - a **hard max-lifetime ceiling** — `sleep $RP_MAX_LIFETIME_SECS; runpodctl remove pod
     $RUNPOD_POD_ID` (RunPod injects `RUNPOD_POD_ID`);
   - an **idle watchdog** — the worker's stdout is tee'd to a log; every `/recognize` request
     prints a line; if no new `/recognize` line appears for `$RP_IDLE_TIMEOUT_SECS`, the pod
     self-terminates.
2. **Laptop-side trap** — `rp run` wraps your command in `trap … EXIT INT TERM` that always calls
   `rp down` (on success, failure, Ctrl-C, or crash).
3. **Account-level spend limit** — set one in the RunPod console as a coarse backstop.

## First-job runbook (oemer eval) — the on-pod path

The corpus is **synthetic / hand-labeled** and fine to send (ADR-0020). **Never upload arbitrary
user charts.**

> **Why on-pod, not `rp run pnpm eval --engine worker --url …`.** The gate (ADR-0032, 2026-09-14)
> proved oemer's ~5.4-min `/recognize` **cannot survive a single HTTP request over the internet**:
> RunPod's http proxy 524s at ~100 s, tcp forwarding was host-inconsistent for a multi-minute hold,
> and the `WorkerClient` inherits undici's ~5-min timeout. Better compute does not fix it — three of
> those are network/client, not speed. The fix is **co-location**: recognise **on the pod** with no
> per-image WAN, moving only images (up) and OmrDocuments (down). That is what `eval-onpod` does
> (KAN-1379), and it works with the **existing** worker image — no rebuild — because it pushes the
> current `worker/sibei_omr/batch.py` and runs it against the image's already-installed `sibei_omr`.

**Prerequisite (in addition to the three above): an ssh key.** `RP_SSH_KEY` (default
`~/.ssh/id_ed25519`); its public half is embedded in the pod's launch command at `up`, and
`openssh-server` is installed at pod start so the shipped image is untouched. Generate one if needed:
`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`.

```sh
# 0. one-time: push the worker image; set RP_POD_IMAGE + an ssh key in tools/runpod/.env (Prerequisites)
export PATH="$PWD/tools/runpod:$PATH"

# One command does it all, trap-guarded (down on success/failure/Ctrl-C). Start SMALL: --seeds 1 is a
# 4-image (~22 min, ~$0.15) smoke that proves the pipeline before a fuller run.
rp eval-onpod --seeds 1
# The printed table is the oemer number; the score run appends it to eval/history.jsonl. The pod is
# torn down by the trap; `rp down` afterwards is a belt-and-braces no-op (idempotent).
```

For a bigger run, raise the dead-man's-switch ceiling first so it outlasts the batch (oemer is
~5.4 min/page, and the idle watchdog resets per page via the tee'd log, but the hard `MAX_LIFETIME`
does not): e.g. `RP_MAX_LIFETIME_SECS=10800 rp eval-onpod --seeds 3` (12 images ≈ 65 min ≈ $0.40).

Prefer the low-RAM **heuristic** engine for a plumbing smoke that avoids oemer's minutes/RAM entirely:
`RP_EVAL_ENGINE=heuristic rp eval-onpod --seeds 1`.

### The same steps, by hand (for debugging)

```sh
pnpm eval --dump-corpus /tmp/imgs --seeds 1 --no-history   # generate the corpus locally
rp up && rp wait-ssh
rp exec 'mkdir -p /tmp/eval/imgs /tmp/eval/docs'
rp push worker/sibei_omr/batch.py /tmp/eval/batch.py
rp push /tmp/imgs/. /tmp/eval/imgs/
rp exec 'python /tmp/eval/batch.py /tmp/eval/imgs /tmp/eval/docs --engine oemer 2>&1 | tee -a /tmp/sibei-worker.log'
rp pull /tmp/eval/docs/. /tmp/docs/
pnpm eval --engine dump --docs-dir /tmp/docs --seeds 1     # score locally (appends history)
rp down
```

Use a **high-RAM CPU pod (>=16 GB)** — oemer's blocker is RAM (~7 GB), not GPU (ADR-0025), and a
CPU pod is cheaper than GPU. GPU pods are only for later training (V15+).

## The go/no-go gate

Ship this beyond Proposed only if a spot pod can be **`up` → driven to a recorded oemer number →
GUARANTEED torn down**, including on a **simulated laptop disconnect** (kill `rp run` mid-job and
confirm the pod self-terminates via the dead-man's-switch), with **no orphaned billable resource**
left behind. Verify the RunPod REST/`runpodctl` surface at that time — it moves.
