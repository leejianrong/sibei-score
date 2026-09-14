# ADR-0032: RunPod as dev/build-time compute, behind a guardrail wrapper we own

- **Status:** Proposed — gated on a go/no-go spike
- **Date:** 2026-09-14
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0001](0001-local-first-hosting-shaped.md),
  [ADR-0005](0005-node-owns-api-python-omr-worker.md),
  [ADR-0020](0020-omr-evaluation-strategy.md),
  [ADR-0024](0024-model-weights-baked-at-build-time.md),
  [ADR-0025](0025-cpu-only-floor-gpu-profile.md),
  [ADR-0031](0031-bespoke-recogniser.md)

## Context

Two v0.2/v0.3 jobs want more compute than a laptop has, and both are **build-time**, not runtime:

- **The oemer baseline the eval harness needs.** oemer recognises a page with two dense U-Nets and
  peaks at **~7 GB RSS** (ADR-0023, ADR-0031). On an 8 GB dev machine it is OOM-killed, so `pnpm
  eval --engine worker` cannot score it and the ADR-0011 stage-2 chord baseline stays unmeasured
  (the V12/V13 status notes). oemer's blocker is **RAM, not GPU** — a high-RAM CPU pod (>=16 GB),
  cheaper than a GPU pod, is enough.
- **Training the bespoke recogniser** (ADR-0031, V15+) will want a GPU for a few hours at a time.

Both produce an **artifact** — an accuracy number now, trained checkpoints later — that is consumed
offline: the checkpoints are baked and checksummed into the worker image at build time (ADR-0024),
and the number is recorded in `eval/history.jsonl`. Neither is ever fetched by the running app.

This is the moment to state the boundary, because renting cloud compute is exactly the kind of thing
that quietly becomes a runtime dependency (a hosted inference endpoint the app calls) and then
breaks the local-first, offline promise (ADR-0001, ADR-0024). It is **distinct** from the *runtime*
cloud backends still open in QUESTIONS.md (Q82/Q83/Q84): those, if ever pursued, are a hosted
product's serving path and need their own ADRs. This ADR is only about build-time compute.

The mechanics also matter, because the failure mode of rented compute is a bill, not a bug. Verified
live while shaping this:

- A **stopped** pod still bills for storage; only **terminate/delete** frees all cost.
- A **disconnected laptop does not stop a running pod**, and RunPod has **no native
  idle-terminate, no max-lifetime, and no per-pod spend cap**. Disconnect-safety therefore cannot
  live only on the laptop.
- **Spot/interruptible** pods are cheaper (~5s reclaim warning), and every job here is re-runnable.

## Decision

Adopt RunPod as **dev/build-time compute only**, never a shipped-product runtime dependency, behind
a thin **guardrail wrapper we own** (`tools/runpod/rp`). RunPod **produces artifacts**; it is
**never called by the running app**. Five commitments hold this together.

1. **Reuse the ADR-0005 worker boundary; change no product code.** "Run oemer on RunPod" means
   deploy the **existing** worker container there and point `SBSCORE_WORKER_URL` /
   `pnpm eval --engine worker --url …` at it. `scripts/eval.ts` already resolves
   `--url` → `SBSCORE_WORKER_URL` → localhost, and `worker-client.ts` is a pure, timeout-free HTTP
   client. Nothing in `packages/*` or `worker/` is touched.

2. **`tools/runpod/` lives outside the workspace, like `worker/`.** It is not in
   `pnpm-workspace.yaml`, adds no Node dependency, and imports no `packages/*` code — it only shells
   out (`curl`, `runpodctl`) and sets env vars. `tests/arch`'s "never in a bundle" property holds by
   construction: there is nothing importable to leak.

3. **Control plane = our wrapper over `runpodctl` + REST API v1** (v2 is beta). The wrapper owns the
   guardrail logic and is the **teardown owner**. The official RunPod MCP server (a
   full-account-access key, no guardrail logic) is at most an **optional read-side helper**
   (get-pod, get-billing), never the thing that owns termination.

4. **Pods, not Serverless.** A GPU/CPU **Pod** runs the existing worker container unchanged.
   Serverless is rejected for now (see alternatives): it would need the worker rewritten to
   RunPod's handler contract, coupling the worker to a vendor for a build-time convenience. Pods
   serve both oemer inference (high-RAM CPU) and later GPU training.

5. **Cost, teardown, and secrets are load-bearing, not incidental.**
   - **Terminate, not stop; idempotent.** `rp down` **deletes** the pod (a stopped pod still
     bills); deleting an already-gone pod is success.
   - **A pod-side dead-man's-switch, baked into the launch command** so it survives a laptop
     disconnect: a **hard max-lifetime ceiling** (`sleep $MAX_LIFETIME; runpodctl remove pod
     $RUNPOD_POD_ID`) **plus an idle watchdog** that self-terminates after N minutes with no
     `/recognize` activity. A **laptop-side `trap … EXIT`** in `rp run` calls `down` on
     success/failure/crash. An account-level spend limit is the coarse backstop.
   - **Spot/interruptible by default** (cheaper; re-runnable job), and `rp up` **refuses** a spec
     over a configured hourly cap.
   - **Secrets by reference.** The API key is read as `: "${RUNPOD_API_KEY:?…}"` from a gitignored
     `tools/runpod/.env` (a dedicated, limited-scope key), fed to `curl` via a config file on stdin
     so it never enters `argv`/`ps`, and never placed in a URL query parameter. It is never echoed,
     logged, or baked into an image.
   - **Synthetic data only.** The eval corpus is synthetic / hand-labeled and fine to send
     (ADR-0020). Arbitrary user charts are never uploaded.

## The go/no-go gate

Promote this from Proposed to Accepted only if a spot pod can be **`up` → driven to a recorded oemer
number (noteF1/chordF1) → GUARANTEED torn down**, including on a **simulated laptop disconnect**
(kill `rp run` mid-job; the pod must self-terminate via the dead-man's-switch), leaving **no
orphaned billable resource**. This is the same gate-first discipline as ADR-0023 and ADR-0030: prove
the risky property (here, that we cannot leak a bill) before depending on the tool. RunPod's
CLI/REST surface moves, so the surface is re-verified at gate time.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep the baseline blocked on the 8 GB laptop | oemer OOMs there; the ADR-0011 stage-2 chord baseline and the ADR-0031 engine-swap decision stay unmeasurable. A high-RAM pod is the cheapest unblock. |
| RunPod **Serverless** instead of Pods | Needs the worker rewritten to RunPod's serverless handler contract, coupling `worker/` to a vendor for a build-time convenience and violating commitment (1). Pods run the existing container unchanged. |
| The RunPod **MCP server** as the control plane | It uses a full-account-access key and carries no guardrail logic — wrong tool to own teardown and the cost caps. Kept only as an optional read-side helper. |
| **Laptop-side teardown only** (trap on exit) | A disconnected laptop does not stop the pod, and RunPod has no native idle/max-lifetime cap — so a dropped connection leaks a running pod. The pod-side dead-man's-switch is the fix. |
| **Stop** the pod between runs instead of terminating | A stopped pod still bills for storage. Only terminate/delete frees all cost. |
| A **cloud VLM / hosted inference API** for imports | That is a *runtime* dependency and breaks the offline invariant (ADR-0024, ADR-0025). This ADR is deliberately build-time only; runtime cloud is Q82/Q83/Q84's separate question. |
| Bake the key into an image or pass it on the command line | Leaks the secret (into a layer, or into `ps`/history). Read by reference; fed to `curl` via stdin. |

## Consequences

- **The oemer baseline becomes producible on demand** without buying hardware, and the number lands
  in `eval/history.jsonl` like any other run — the artifact is offline-consumed (ADR-0020).
- **The offline product invariant is untouched.** RunPod is build-time; the app still never reaches
  the network at runtime (ADR-0024). The boundary is stated here so it does not erode later.
- **A one-time registry push is now a prerequisite.** `worker/Dockerfile` builds but pushes
  nowhere; the first job needs the image pushed to GHCR/Docker Hub (the wrapper does not do this).
  Which registry/tag is an open question for the operator.
- **A new, small dev surface is accepted** (`tools/runpod/`), outside the workspace and CI, the way
  `worker/` already is — no Node dependency, nothing in a bundle.
- **The teardown guarantees are only as good as the RunPod surface they call.** That surface moves,
  so the wrapper documents "verify at real-run time" and the gate re-checks it before we rely on it.
- **This does not decide the hosted-product serving path.** If sibei-score ever runs OMR in the
  cloud at runtime, that is Q82/Q83/Q84 and gets its own ADR; nothing here presumes it.
