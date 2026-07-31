# ADR-0015: Our own layout engine — four bars per line, broken by sections

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Status note, 2026-07-31

**This decision stands, and its last consequence was cashed in.** VexFlow is gone
(ADR-0030). "Replacing VexFlow touches only the draw adapter" was a prediction when it
was written; V1d ran it and it held exactly — `layout` did not change and no note moved
on the page. The two VexFlow mentions below read the same with "the renderer" in place of
the name: no general-purpose engine supplies a four-bar-grid policy, so the layout engine
is ours either way.

## Context

`REQS.md` is emphatic: "One rendering convention matters more than the rest: four
bars per line. That is the standard for jazz charts and the PDF export has to honour
it."

Four bars per line is simple until it meets a real chart. Bar counts are not always
multiples of four. Pickup bars exist. And sections change in places that do not
align to a four-bar grid — an 11-bar A section, for instance.

VexFlow supplies no layout policy of this kind (ADR-0014), so the layout engine is
ours either way.

## Decision

The layout engine is ours, engine-independent, and shared verbatim by the browser
and the server (ADR-0005).

Four bars per line is the default. A **section boundary breaks the line** even if it
lands mid-line, so an 11-bar A section lays out 4 / 4 / 3. A pickup bar sits before
bar 1 on the first line without consuming a four-bar slot.

## Consequences

- Musicians read by section. A bridge starting mid-line is wrong even though it
  keeps the grid perfectly regular — which is why the strict-grid alternative was
  rejected.
- **Section boundaries become load-bearing for layout, not just notation.** Section
  markers must therefore exist in the model regardless of how much of the
  navigation family is supported (ADR-0021).
- Section markers are **not detected on import** (ADR-0021), so layout of a fresh
  import is a plain four-bar grid until the user supplies them. This is the sharpest
  consequence of the barline decision: it means correcting a parse includes
  correcting its *layout*, not only its notes.
- Because layout is ours and engine-independent, replacing VexFlow touches only the
  draw adapter, and screen and print cannot drift.
- No manual line-break override in the MVP. If real charts turn out to need one, it
  is a layout-hint field on the model plus a `sibei break set` verb — additive, not
  a redesign.
