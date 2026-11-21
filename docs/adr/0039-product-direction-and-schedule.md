# ADR-0039: Product direction and schedule — lead sheets and agents first, then arrangers

- **Status:** Accepted — decisions 1–8 on 2026-11-22; decision 9 (pull) accepted by the maintainer the same day.
- **Date:** 2026-11-22
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0021](0021-notation-coverage-boundary.md), [ADR-0030](0030-own-the-engraver.md),
  [ADR-0034](0034-hosted-web-app-primary.md), [ADR-0038](0038-full-notation-is-the-long-term-direction.md),
  [ADR-0005](0005-node-owns-api-python-omr-worker.md), [ADR-0028](0028-score-document-schema-versioning.md)

## Context

ADR-0038 made full notation a direction "of record, not a schedule". Three things since have turned it
into a plan: the maintainer wants to compete with MuseScore and Sibelius as an expressive, web-hosted,
agent-friendly notation editor; a sister project (music-audio-transcriber, its ADR-0002) will be sold
with this one and needs piano, drum and multi-staff notation from us (its V4–V8); and a look at the
real pages in `examples/` (Wail, Shaw 'Nuff, plus five sample photos) showed the editor and engraver
cannot yet reproduce ordinary lead-sheet material (triplets, slurs, fermatas, ottava, N.C., coda and
D.S., page furniture, a full-band intro with grand staff and drum staff).

## Decisions

1. **Audience and dates.** Jazz and lead-sheet musicians plus agent workflows first; the **hosted
   service launches by 2026-12-31**; **general arrangers and composers by 2027-04**.
2. **The wedge is agent-native plus engraving quality**, not feature parity. Adopt Sibelius's
   *workflows* (keyboard note input with a keypad, a selection model, an inspector); do not copy its
   look, branding or assets. Keep our own engraver (ADR-0030) and invest in spacing, collision handling
   and beaming.
3. **The score model becomes staves × voices × parts.** The design (its own ADR, superseding the
   single-voice parts of ADR-0004 and ADR-0021) is written **now**; the implementation and the
   ADR-0028 migration follow the hosted launch. Pulled forward from ADR-0038's "no schedule" because the
   audio project's piano, drums and multi-staff work depends on it.
4. **MusicXML import before playback.** Import reuses the codec, yields real fixtures and is how
   MuseScore and Sibelius users arrive; playback needs the new model and a sound engine, with swing.
5. **Measure the gap on the real pages.** Inventory each of the eight real pages against model, ops,
   layout, engraver, MusicXML, CLI, UI and MCP, then recreate each through the CLI and render it beside
   the original. Each failure is a card. This is local only: the pages are not rights-cleared (ADR-0036)
   and their transcriptions are derivatives, so neither is committed. Committed fixtures are
   public-domain.
6. **Audio is in the 2026 hosted launch** (this reverses an earlier proposal to defer it): upload by
   presigned URL, an audio job, the audio engine's NoteEvents v1, import as a draft, and audio-second
   metering with a free-tier cap. **Out of the launch:** photo import on hosted (V26), subscriptions.
7. **Billing is planned nearer the launch.** Subscription checkout, plans and webhooks are not designed
   or built in 2026 unless the launch date holds with room to spare.
8. **Piano, drums and multi-staff are needed as soon as the model allows**, in service of the audio
   project's V4 (piano), V5 (drums), V6 (guitar) and V8 (multi-stem score).
9. **Push vs pull for the audio worker — Accepted: pull.** The audio engine's GPU worker, a separate
   repo, claims jobs from our durable job table over authenticated HTTPS with a lease and heartbeat,
   and returns NoteEvents; bytes move by presigned URL. Reasons: a GPU host is typically behind NAT or
   preemptible, so it should call out, not be called in; claiming gives natural back-pressure, retries
   after a lost lease and several workers for free. The OMR worker stays push (ADR-0005) — same compose
   network, CPU, one container — and the two are not unified. If the audio project targets a serverless
   GPU endpoint instead, push plus a completion webhook is the natural shape and this decision reverses.

## Consequences and risks

- **Capacity is the risk.** About five weeks remain. The hosted slices still open (SIB2-100…104) and
  the audio slices (SIB2-129…139) together exceed what the project has shipped in comparable time, and
  the end-of-year period is short. If the date is at risk, cut in this order: audio-second metering to
  a simple counter; the free-tier cap to a per-user job count; then voice/bass only. Not cut: sign-in,
  MCP, the CLI, account deletion.
- ADR-0021 stays in force until the model ADR lands; ADR-0034's scope gains audio and loses V26.
- April 2027 is the tightest date. If it slips, cut lyrics and part extraction before multi-staff.
- Human tasks gate the launch: the GitHub OAuth App (SIB2-110) and the `test (postgres)` required
  check (SIB2-111).
