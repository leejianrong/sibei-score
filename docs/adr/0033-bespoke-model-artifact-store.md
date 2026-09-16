# ADR-0033: Version bespoke model weights as GitHub Release assets, fetched by checksum

- **Status:** Accepted — 2026-09-17. The `bespoke-weights-v17c` release publishes the current pinned
  set (Stage 1 `detect.onnx`, Stage 2a `model.onnx` + `vocab.json`, Stage 2b `chord.onnx` +
  `chord-vocab.json`); `worker/fetch_bespoke.py` pulls them by checksum.
- **Date:** 2026-09-17
- **Deciders:** Jian, in design discussion (backend chosen: GitHub Releases)
- **Relates to:** [ADR-0001](0001-local-first-hosting-shaped.md),
  [ADR-0024](0024-model-weights-baked-at-build-time.md),
  [ADR-0025](0025-cpu-only-floor-gpu-profile.md),
  [ADR-0031](0031-bespoke-recogniser.md),
  [ADR-0032](0032-runpod-dev-compute-wrapper.md)

## Context

v0.3 produces two kinds of large build artifact, and they have **opposite** reproducibility
properties, which is the whole basis of this decision:

- **The synthetic corpora are deterministic.** `pnpm dump:v17b --seeds 800 --bars 16 --levels …`
  regenerates byte-identical output from the generator code + seed + args. The real "version" of a
  dataset is therefore a *recipe* — `(packages/synth git commit) + (dump args)` — not a blob. Storing
  the bytes is only a speed cache, never a correctness need.
- **The trained models are not.** GPU training is nondeterministic; a retrain of `chord.onnx` is a
  *different* model, so it cannot be regenerated bit-for-bit — and a different model **breaks the
  checksum pin** in `bespoke_weights.py`. A trained artifact is thus irreplaceable.

The gap this exposes: as of V17c the pinned artifacts (`bespoke_weights.ARTIFACTS`, on `main`) existed
only in a maintainer's gitignored `out/` directory. The pin recorded their sha256, but the bytes were
retrievable from nowhere durable — lose the box and the pin references a model that exists no longer,
and retraining cannot reproduce it. `out/` is gitignored deliberately (ADR-0024: weights are not in
version control), so "just commit them" is not the answer; they need a **durable, versioned, external
home**, fetched the way ADR-0024 already fetches oemer's weights.

There is a precedent in-repo: `worker/fetch_weights.py` downloads oemer's ONNX checkpoints from a
**GitHub Release** (`github.com/BreezeWhite/oemer/releases/download/checkpoints`), checksum-verified, at
build time. The bespoke models were the odd ones out — `bespoke_weights.py` only *verified* a directory
it was pointed at, with no *fetch* half.

## Decision

**Publish the pinned bespoke artifact set as immutable GitHub Release assets, and fetch them by
checksum at build/dev time. Version datasets by recipe, not by stored bytes.**

1. **Models → GitHub Releases.** Each revision of `bespoke_weights.ARTIFACTS` corresponds to one
   Release, tagged `bespoke-weights-<slice>` (e.g. `bespoke-weights-v17c`), carrying every artifact the
   engine loads as an asset (the three `.onnx` + the two vocab manifests) plus a human-readable
   `manifest.json`. Releases are **immutable** — a retrain cuts a *new* tag, never overwrites one.
2. **`fetch_bespoke.py` is the fetch half of `bespoke_weights.py`'s verify half.** It reads the same
   `ARTIFACTS` pins and `RELEASE_TAG`, downloads each asset, and verifies size + sha256 — refusing a
   mismatch. The tag and the digests are bumped in **one commit** when a model changes, so the pin
   always names the assets it describes. The worker Dockerfile bakes the dir by calling it (the bake
   wiring itself lands with the engine that first loads these — V17d — not here).
3. **The repo is public, so the download needs no auth** (plain `urllib`, like `fetch_weights.py`); a
   `GITHUB_TOKEN` is used only if present, for rate-limit headroom. This keeps the "no new secret to
   handle by reference" property — unlike an S3-keyed bucket.
4. **This is build/dev-time only.** The store is never on a runtime path: the shipped worker loads the
   *baked*, checksummed files and never calls the network (ADR-0001/0024/0025 unchanged). This is the
   same posture as ADR-0032 (RunPod is dev/build-time only).
5. **Datasets are versioned by recipe.** A training run records its generator commit + dump args
   (already in the corpus provenance and the run's `metrics.json`), which reproduces the corpus. We do
   **not** routinely store corpus bytes; if a specific corpus is worth keeping for debugging, snapshot
   its tarball to the same Release keyed to the model version — an option, not a standing cost.

## Consequences

- The durability gap closes: any build host, CI job, or contributor can materialise the exact pinned
  model set with `python worker/fetch_bespoke.py`, checksum-guaranteed, and the maintainer's laptop is
  no longer a single point of failure for an irreplaceable artifact.
- Footprint is trivial — the whole bespoke set is ~14 MB, so keeping every historical version fits
  GitHub's free Release storage (2 GB/asset) indefinitely.
- One discipline to hold: **bump `RELEASE_TAG` + `ARTIFACTS` together and cut the matching Release** in
  the same commit as any retrain. A stale tag or an un-cut release is caught at build time by the
  checksum verify (a download mismatch or a 404), not silently.

## Alternatives considered

- **Cloudflare R2 / Backblaze B2.** S3-compatible object stores with generous free tiers (R2: 10 GB,
  zero egress; B2: 10 GB, egress free to 3×/day). Strictly more capable — private buckets, no
  per-asset ceiling — and R2's zero-egress matters if pods pull weights repeatedly. Rejected *for now*
  only because they add an S3 key to handle by reference (ADR-0032 discipline) for no benefit at 14 MB
  on a public repo. If the artifact set grows large, becomes private, or is pulled hot by many pods,
  revisit R2 — `fetch_bespoke.py` is a thin seam to repoint.
- **Hugging Face Hub.** The purpose-built ML registry (git-based versioning, free private repos,
  first-class for models *and* datasets). Heavier ecosystem dependency than the problem warrants today;
  a natural home if the model/dataset zoo grows.
- **Git LFS / committing the weights.** GitHub LFS free tier (1 GB storage + 1 GB/mo bandwidth) is too
  small and its bandwidth cap bites; committing binaries bloats the clone and contradicts ADR-0024
  (weights out of version control). Rejected.
