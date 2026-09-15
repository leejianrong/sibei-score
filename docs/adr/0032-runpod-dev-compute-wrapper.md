# ADR-0032: RunPod as dev/build-time compute, behind a guardrail wrapper we own

- **Status:** Proposed — spike run 2026-09-14: the **lifecycle + cost/teardown gate is met and
  reliable**, but the **oemer number is blocked** on delivering a multi-minute recognition over the
  network (see *Gate result* below). Stays Proposed; the wrapper and its guardrails are kept.
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

## Gate result (spike run, 2026-09-14)

The spike ran end to end for the first time. **The lifecycle and cost/teardown half of the gate is
met and reliable; the actual oemer number is not yet producible** — and the blocker is not the
wrapper but oemer's multi-minute recognition surviving a single HTTP request over the network.

**Validated** (across 4 spot pods, ~$0.06 total, every one torn down to **$0 idle**):

- `up` (idempotent, name-tagged), `wait-ready`, `down` (terminate, idempotent), the pre-run RAM+price
  guard, and a post-run sweep confirming `GET /pods` and `/networkvolumes` are both 0.
- Getting there required fixes the paper design missed (all in the wrapper — no product change): the
  REST v1 **CPU create schema** (`computeType`, `cpuFlavorIds`+`vcpuCount`, array `ports`,
  `volumeInGb:0`, `cloudType`/`interruptible` — the original body would have 400'd or rented a GPU),
  a **direct tcp endpoint** instead of the http proxy, and **`.env` quoting**. Separately the worker
  image had a latent build bug (missing `libgl1` for PaddleOCR's `cv2`), fixed in the same window.

**Compute used:** a SECURE spot CPU pod, memory-tier flavor (`cpu5m`/`cpu3m`), **4 vCPU / 32 GB RAM,
$0.26/hr**. RAM was ample — oemer's ~7 GB is not the issue here.

**Why the number is blocked — four independent causes, all "a long synchronous request dies":**

1. RunPod's **http proxy** (`proxy.runpod.net`) is Cloudflare-fronted with a ~100 s response cap, so a
   ~5.4-min `/recognize` returns **524**.
2. RunPod's **tcp** forwarding was inconsistent host-to-host — one pod reset the connection early,
   another held it 420 s.
3. On the 4-vCPU pod oemer returned **nothing in 7 minutes** (vs the spike host's 5.4 min; cold model
   load + V13's added PaddleOCR band-OCR, and possibly onnxruntime thread contention). Slow-vs-hung
   was not resolved.
4. **The `WorkerClient` is not actually timeout-free.** Commitment (1) above calls it "timeout-free,"
   but `worker-client.ts` configures no undici dispatcher, so it inherits undici's **~5-min default
   headers-timeout** — shorter than oemer's own runtime. A latent product bug that would also abort a
   slow **local** import; it never surfaced because oemer-over-HTTP had never actually run (the
   heuristic engine is fast). **Follow-up: give the `WorkerClient` an explicit no-timeout dispatcher.**

**Better compute does not fix this.** A GPU only takes oemer to ~3–5 min (ADR-0025) — still over the
proxy cap and near the client timeout — and causes 1, 2 and 4 are network/client, not speed. The real
fix is to **co-locate**: run recognition **on the pod** (no per-image WAN) or move the worker to an
**async submit/poll** contract (which also fixes long local imports). Both are real work, deferred.

The oemer chord baseline (the ADR-0011 stage-2 target) therefore remains deferred — now with a precise
cause and a shortlist of fixes, rather than "needs a bigger host."

## Delivery update — on-pod recognition (KAN-1379, 2026-09-15)

The shortlist's first item is now **built**: the eval runs recognition **on the pod**, so no
per-image request crosses the internet, which removes all four blockers at once (the http-proxy cap,
the tcp-hold inconsistency, oemer's multi-minute runtime, and the `WorkerClient` timeout — none is on
the path). It reuses the existing worker image unchanged (commitment 1 holds), so no rebuild/repush:

- **`worker/sibei_omr/batch.py`** — a batch recogniser that imports the chosen engine **once** and
  loops a directory of images to one `OmrDocument` JSON each (the same core `server.py` calls; the
  worker stays RunPod-agnostic, ADR-0005). Its own `unittest`, not in the Node CI.
- **`scripts/eval.ts`** grows `--dump-corpus DIR` (write the corpus images, recognise nothing) and
  `--engine dump --docs-dir DIR` (score pre-computed documents). Because `buildEntry` is deterministic
  in `(seed, bars, level, zoom)`, the ground truth is regenerated at scoring time — only images (up)
  and documents (down) move — and the number is identical to a live `--engine worker` run. A no-staff
  page now scores as an empty chart instead of aborting the sweep (it previously threw
  `OmrMappingError` on both the worker and dump paths).
- **`tools/runpod/rp`** gains `wait-ssh`, `exec`, `push`, `pull`, and `eval-onpod` (the full flow,
  trap-guarded). On-pod ssh is opt-in via `RP_SSH_KEY`: the **public** key is embedded in the launch
  command and `openssh-server` is installed **at pod start** (like `runpodctl`), so the shipped image
  is untouched; the **private** key never leaves the laptop. The batch's per-page log lines are tee'd
  to the worker log so the idle watchdog counts them as activity and does not reap the pod mid-batch.

Validated end to end locally with the low-RAM heuristic engine (dump-corpus → batch → dump-score). The
**oemer number itself** is recorded here and in `eval/history.jsonl` after the first pod run.

The `WorkerClient` timeout (cause 4) is a genuine product bug that still bites slow **local** imports;
it is **not** on the on-pod path and is fixed separately (KAN-1378), not folded into this dev tooling.

### Live pod test — the ssh transport is blocked, the pivot is `runpodctl` relay (2026-09-15)

The first live run of `eval-onpod` surfaced a transport blocker, so **the mechanism above is scaffolding,
not yet a working delivery** — the pieces that are transport-independent (`batch.py`, the `eval.ts`
dump/score modes) are proven; the pod-side plumbing that moves the files is not.

**What worked** (cost ~$0.06, every pod terminated to `$0`): the REST create with `22/tcp` exposed,
pods coming up (SECURE and COMMUNITY, 32 GB, $0.26/hr, dead-man's-switch armed), and **teardown both
ways** — `rp down` and the interrupt trap each drove the account to zero pods, including the simulated
disconnect (killing `eval-onpod` fired its trap and terminated the pod). The cost/teardown gate holds.

**What failed:** both a **SECURE** and a **COMMUNITY** spot CPU pod came up with `publicIp: ""` and
`portMappings: null` — **no direct-TCP public endpoint** — so ssh/scp over `publicIp:port` cannot reach
them. This is not a bug in `rp`: RunPod's own docs state direct-TCP public IPs are **machine-dependent**
(assigned per machine, and unstable on Community restarts), and the gate above already called tcp
"host-inconsistent" (cause 2). The spot scheduler simply placed both pods on machines without one.
Waiting longer did not help (still empty at ~8 min, pod `RUNNING`).

**The pivot (decided):** move the transport to something that needs **no public IP**:

- **Primary — `runpodctl send`/`receive` relay.** RunPod's relay-based transfer needs only outbound
  network (which the pod has), not an inbound public IP. Bake the batch into `dockerStartCmd` with
  pre-shared transfer codes so the pod pulls the images, recognises, and pushes the documents back with
  **no ssh and no exec**. Verify `runpodctl`'s current send/receive + custom-code surface at run time.
- **Fallback — everything on the pod.** Bake `git clone` + `pnpm install` + `pnpm eval --engine worker`
  (the worker is loopback inside the same container, so no WAN, no proxy, no public IP) into
  `dockerStartCmd`, and read the printed number from the **pod logs**. Heavier setup (a Node toolchain
  and the native `@resvg`/`sharp` build on the Python image) and depends on logs being API-readable, but
  needs zero inbound connectivity.

The ssh verbs (`exec`/`push`/`pull`/`wait-ssh`) are kept: they work on a pod that *does* get a public
IP, and are useful for debugging. The oemer number still lands after the pivoted transport runs.

### Delivery: the relay transport (`rp eval-relay`) — landed and proven live (2026-09-15)

The pivot is built as **`rp eval-relay`** and validated on real spot pods (all torn down to `$0`; the
cost/teardown gate continued to hold, including the trap on a simulated disconnect). It needs **no
public IP and no ssh**: the corpus goes up and the `OmrDocument`s come down over a `runpodctl`
send/receive **relay** (outbound-only), and the pod's results code is read back via `runpodctl pod
logs`. It reuses the existing worker image (commitment 1) — no rebuild, no repush.

**What the runpodctl 2.14.0 surface actually is** (re-verified at run time, per the gate discipline —
and it had moved: `get`/`create`/`remove`/`exec` are now *deprecated* under `pod …` verbs):

- `send --code <base>` takes a **custom** base code but **appends a random relay index** (`<base>-<n>`)
  at send time, and `receive` needs that exact final code — a mismatched index gives "room not ready".
  So a purely pre-shared code (the original "Primary" sketch) cannot work by itself; the sender's final
  code must reach the receiver out of band.
- `runpodctl pod logs <id>` **exists** (JSON-lines, container/system source, `--follow`/`--tail`/
  `--since`), reaches the pod with **no public IP**, and is the feedback channel that closes the gap.

**The mechanism** carries each side's random final code over an outbound-only channel:

- **Up (laptop → pod):** the laptop **pre-starts** its `send`, reads the final code it printed, and only
  then bakes `runpodctl receive <final>` into the pod's `dockerStartCmd` — so the pod knows the exact
  code before it boots. The croc sender holds its relay room while the pod boots and receives (verified
  to hold ≥ 80 s locally, and end-to-end on a real pod).
- **Down (pod → laptop):** the pod `send`s the results and echoes `SIBEI_DOWN_CODE=<final>` to stdout;
  the laptop **polls** `pod logs --tail 5000` (a replaying poll, not a `--tail 0` live follow, so a line
  printed before/between reads is never missed) and receives.

Two image-shape fixes fell out of the first successful pod execution, neither touching product code:

1. **Ship the current `sibei_omr` package up, don't trust the image's copy.** The pushed `:baseline`
   image predates the V13 engine seam, so `import sibei_omr.engines` failed against it. `eval-relay`
   now bundles the checkout's `worker/sibei_omr/` into the up-tar and runs `python -m sibei_omr.batch`
   over it via `PYTHONPATH`, using the image only for its heavy installed deps (opencv, oemer, paddle).
   The eval tracks this code regardless of the image's baked-in age, and the image still needs no rebuild.
2. **runpodctl is already in the image.** The slim image has no `wget`/`curl`, so the pinned install
   no-ops; the image's own runpodctl rendezvoused with the laptop's 2.14.0, so the pinned install is a
   best-effort fallback, not a requirement. `rp` warns on a laptop/pod version skew (relay-list drift).

**Result.** Both engines run the whole flow end-to-end over the relay on a spot pod (transport,
recognition, scoring, teardown), every pod torn down to `$0`. The **oemer baseline** (the
ADR-0011 stage-2 target) is now recorded **complete** — all four degradation levels recognise, the
first delivery having left `light`/`heavy` blocked on KAN-1391 (now fixed, finding 1) — `--seeds 1` on
a 32 GB spot CPU pod, delivered by `eval-relay` and scored through `@sibei/synth` (also in
`eval/history.jsonl`):

| corpus | noteF1 | noteAcc | chordF1 | validBars |
|--------|--------|---------|---------|-----------|
| clean  | 0.812  | 0.800   | 0.400   | 0.250     |
| light  | 0.841  | 0.829   | 0.700   | 0.500     |
| medium | 0.522  | 0.514   | 0.667   | 0.375     |
| heavy  | 0.829  | 0.829   | 0.333   | 0.250     |

This is the **complete** baseline: all four degradation levels recognise. The first delivery of this
table (KAN-1379) had `light` and `heavy` at empty zeros because of a recognition crash; that bug is
now fixed (KAN-1391, below), so this section records the post-fix numbers, and `clean`/`medium` are
unchanged from that first run (0.812/0.400 and 0.522/0.667), confirming the fix left the passing pages
untouched. On `clean`/`medium` oemer clears the heuristic engine comfortably (heuristic clean was
noteF1 0.302 / chordF1 0.200). Two findings the run surfaced, both separate from the transport:

1. **The recognition bug that capped the first run is fixed (KAN-1391).** `light` and `heavy` (both
   JPEG-degraded) had failed with `AttributeError: 'numpy.ndarray' object has no attribute 'start'` in
   the oemer engine, scoring as empty zeros. Root cause: oemer's `init_zones` returns the staff zones as
   `np.array([range(a, b), …], dtype=object)`, and when every range is the **same length** numpy
   collapses the list into a 2-D int array — so iterating the zones yields ndarray *rows*, not `range`
   objects, and the worker's `int(z.start)` dump threw. It was input-specific because the collapse only
   happens when the detected staff bounds divide evenly (hence some JPEGs failed while others passed).
   The fix (`recognize.py:_zone_bounds`) normalises a zone to `[start, stop)` whether it is a
   range/slice or an array-like row, with a worker regression test. Independently, `eval.ts --engine
   dump` now scores a **missing** page as an empty chart (a partial batch is a legitimate zero, not a
   fatal error), mirroring the no-staff handling, so one bad page no longer aborts the whole sweep.
2. **oemer is CPU-thread-bound here, not core-bound.** A page took ~14 min on 4 vCPU and still ~13 min
   (medium: 776 s) on 8 vCPU — the container sees ~128 host cores and onnxruntime over-subscribes
   threads (`pthread_setaffinity_np failed …`), so more vCPUs barely help. Capping threads to the
   allocation, or a GPU, is the real lever (see ADR-0025 for the GPU profile).

(`eval-onpod` and the ssh verbs are kept for a pod that does get a public IP and for debugging.)

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
