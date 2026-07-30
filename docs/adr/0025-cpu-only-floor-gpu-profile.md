# ADR-0025: CPU-only is the floor; GPU is an opt-in compose profile

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

Q43 made CPU-only a hard requirement so the app runs on any machine. Verification then
found oemer documents a typical run at **3–5 minutes with a GPU**. A CPU-only run will
be materially slower, and the figure is unknown until measured.

This matters more than raw throughput because re-parsing is a *feature*: ADR-0019
keeps source images permanently so a chart can be re-parsed by a better engine. A
correction loop of parse → fix → re-parse is unpleasant if each parse costs fifteen
minutes.

## Decision

**CPU-only remains the hard floor.** The app must run with no special hardware, and
every feature including import must work on CPU alone.

**GPU is an opt-in Docker Compose profile** for users who have one. It changes speed,
never behaviour or output.

The oemer spike (ADR-0023) measures actual CPU wall-clock on representative photos,
and that number goes in the documentation rather than being left for users to
discover.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Accept whatever CPU latency turns out to be, no GPU path | Simplest, but if CPU import is very slow the correction loop degrades badly and there is no recourse for users who could have used a GPU. |
| Require GPU for import | Contradicts Q43, narrows who can use the headline feature, and makes the hosted future need GPU instances from day one. |
| Decide after measuring | The floor is a product commitment, not a measurement outcome. Measuring informs the GPU profile's value, not whether CPU must work. |

## Consequences

- Import being a job rather than a request (ADR-0001) turns out to be what makes this
  survivable: a slow import is a progress bar the user walks away from, not a hung
  request. That decision was made for hosting reasons and pays off here.
- Two runtime configurations to test. Contained, because the GPU profile changes only
  which oemer inference provider is selected — outputs must be identical, and a test
  should assert that on at least one fixture.
- If measured CPU latency is bad enough to make re-parsing impractical, the response is
  a product decision (narrow the pipeline, cache intermediate stages), not a relaxation
  of the floor.
