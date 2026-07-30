# ADR-0005: Node/TypeScript owns the API and model; Python is an OMR worker

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Two engine choices each brought a runtime. The OMR pipeline (ADR-0010) is built on
oemer, which is Python, alongside a Python OCR model. The renderer (ADR-0011) is
VexFlow, which is JavaScript and must run server-side in Node to produce PDFs.
Both runtimes are therefore required. One of them has to own the HTTP API and the
score store; the other becomes subordinate.

The deciding constraint turned out to be the layout engine. It must run in the
browser (screen) *and* on the server (PDF), and it is ours either way (ADR-0012).

## Decision

Node/TypeScript owns the HTTP API, the SQLite store, the score model, the operation
applier, the layout engine, PDF generation, and the chord grammar.

Python is an OMR worker only. It receives an image and returns raw musical objects
plus OCR text and confidence scores. It never touches the database.

The chord grammar deliberately lives in TypeScript with the model rather than in
Python beside the OCR, so there is one implementation serving both OCR error
correction (ADR-0011) and validation of what a user or agent types.

## Consequences

- The layout engine is literally the same file in the browser and on the server, so
  screen and print cannot drift and there is one implementation to maintain.
- The browser re-renders instantly on edit with no server round trip. This matters
  locally for feel and decisively once hosted, where the alternative is a network
  round trip per keystroke.
- The OMR worker is isolated behind the job boundary, so in a hosted deployment it
  can scale independently on different hardware — the natural shape anyway.
- The worker must conform to the model's JSON schema, defined once in TypeScript.
  This is a contract to keep in sync across a language boundary, and needs a
  schema-conformance test on the Python side.
- Rejected: **Python owns everything with a Node render sidecar**. Keeps model and
  OMR in one language, but then the browser either fetches SVG from the server on
  every edit or the layout engine gets ported to TypeScript — two implementations,
  which is exactly what this decision avoids.
