# ADR-0024: Model weights are baked into the image at build time

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

`REQS.md` requires the app to run with no network dependency at runtime, and ADR-0010
committed to a fully local pipeline with no vision-model path.

Verification found that both chosen models violate this by default. **oemer downloads
its checkpoints on first run**, taking up to ten minutes. PaddleOCR does the same.
Left alone, a freshly started container's first import would require internet access —
breaking the offline requirement outright, and failing in exactly the situation the
requirement exists to protect (no connectivity, on a gig).

## Decision

The Dockerfile fetches **every** model checkpoint at **build** time and bakes it into
the image. The running container never downloads a model, and never needs to.

Checkpoints are pinned by **checksum**, verified during the build, so a silently
changed or replaced upstream artefact fails the build rather than shipping.

A test asserts the offline property directly: run an import in a container with
networking disabled, and it must succeed.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Download on first run (the default) | Breaks the offline requirement, and fails precisely when connectivity is absent. |
| Ship weights in a separate volume the user populates | Turns a documented one-command start into a setup procedure, and the failure mode is a confusing runtime error. |
| Fetch at build time without checksums | An upstream artefact could change under us with no signal. |

## Consequences

- This is what makes the image multi-gigabyte, so Q43's acceptance of image size is
  load-bearing rather than incidental — it is the direct price of the offline
  guarantee.
- Image builds need network access and are slow. Acceptable: builds are infrequent and
  happen on a connected machine by definition.
- Upgrading a model means rebuilding the image, which is the correct granularity —
  model version becomes part of the image identity, so an import result is reproducible
  from an image tag.
- The offline claim becomes testable rather than aspirational, which matters because it
  is the kind of property that silently regresses the moment someone adds a dependency.
