<script lang="ts">
  /**
   * One chart: the rail, and the pages.
   *
   * The chart is fetched once from `GET /v1/scores/:id` and rendered in the browser through
   * `layout()` + `engravePage()` — **the same two packages the PDF goes through** (ADR-0014,
   * ADR-0015). Nothing here is a second opinion about the page.
   *
   * **The rail is not a sidebar of metadata; it is the half of the chart the engraving cannot
   * say.** The face and the paper change the sheet above *and* the export URL below, because
   * they are one render-time choice and not two settings (ADR-0030, Q38). And review state has
   * nowhere else to go: an under-filled bar and a correct one are the same ink, so the engraver
   * draws no flag, and if the chrome does not say it nobody ever finds out (ADR-0013).
   *
   * **Selection and the inspector are V4c.** A click on the sheet hit-tests against the exact
   * geometry the engraver drew from (`../lib/hit-test.js`), never a second opinion about where
   * anything sits. Saving submits an op to the same `/v1/scores/:id/ops` the CLI uses — there is
   * no second write path — and a stale write recovers by reloading, never by retrying with the
   * server's version (ADR-0003).
   */
  import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
  import type { MusicFontName } from '@sibei/engrave';
  import type { PageNumberFormat, PageNumberPosition, PageNumberSettings, Paper } from '@sibei/layout';
  import { displayTitle, formatKeySignature, formatPitch, NEEDS_REVIEW, NO_SECTIONS_ADVISORY, reviewSummary } from '@sibei/model';
  import type { Id, KeySignature, Score } from '@sibei/model';
  import { writtenPart } from '@sibei/music';
  import {
    ApiError,
    exportRoute,
    exportUrl,
    FONTS,
    FORMATS,
    getScore,
    INSTRUMENTS,
    NUMBER_FORMATS,
    NUMBER_POSITIONS,
    OfflineError,
    PAPERS,
    redoScore,
    submitOps,
    undoScore,
  } from '../lib/api.js';
  import type { ExportFormat, ExportInstrument, MetaSetPayload, Operation } from '../lib/api.js';
  import { TARGET_KEYS, keyEquals } from '../lib/keys.js';
  import { SERVE_COMMAND } from '../lib/branding.js';
  import { watchScore } from '../lib/events.js';
  import { absoluteTime, displayKey, formatBarRanges, paperLabel } from '../lib/format.js';
  import { boxFor, findItem, hitTest, loadFont, pageItemBoxes } from '../lib/hit-test.js';
  import type { Point } from '../lib/hit-test.js';
  import { beatSlotAt, chordAt, pageChordBoxes } from '../lib/chord-hit.js';
  import type { ChordBox } from '../lib/chord-hit.js';
  import { barAt, barBoxFor, pageBarBoxes } from '../lib/bar-hit.js';
  import { FIRST_LANE, clampLane, laneLabel, needsQualifier, notePinnedIn, qualifierOf, staffClef, tupletOf } from '../lib/lanes.js';
  import type { Lane } from '../lib/lanes.js';
  import { renderScorePages } from '../lib/render.js';
  import { ottavaOp, ottavasOnNote, removeOttavaOp, removeSlurOp, slurOp, slursOnNote } from '../lib/slur-edits.js';
  import type { SlurChoice } from '../lib/slur-edits.js';
  import Inspector from './Inspector.svelte';
  import type { NoteEdits, RestEdits, Selection } from './Inspector.svelte';
  import ChordInspector from './ChordInspector.svelte';
  import type { ChordSelection } from './ChordInspector.svelte';
  import StructureInspector from './StructureInspector.svelte';
  import StaffPanel from './StaffPanel.svelte';
  import NewItem from './NewItem.svelte';
  import { newItemOp, seedPitchFor, voiceForKey } from '../lib/staff-edits.js';
  import type { NewItem as NewItemSpec } from '../lib/staff-edits.js';
  import { structureOps } from '../lib/structure-edits.js';
  import type { BarStructure, StructureEdits } from '../lib/structure-edits.js';
  import { barByNumber, barViews, beatOfOnset, sectionStartingAt } from '@sibei/model';
  import SegmentedControl from './SegmentedControl.svelte';
  import SheetStack from './SheetStack.svelte';
  import SourcePane from './SourcePane.svelte';
  import { getScoreSource, getImport, reparseScore, REPARSE_ENGINES } from '../lib/api.js';
  import { hashOf } from '../lib/routing.js';

  interface Props {
    id: string;
    /** The loaded chart's title, for the breadcrumb. `''` is untitled; `null` is not loaded. */
    onTitle: (title: string | null) => void;
    onReachable: (reachable: boolean) => void;
  }

  const { id, onTitle, onReachable }: Props = $props();

  /** A4 and `normal` are the API's defaults too, so the first render matches the default export. */
  const DEFAULT_PAPER: Paper = 'a4';

  /** 60% to 200%, in steps of 20. A document viewer's range, not a design tool's. */
  const ZOOM_MIN = 60;
  const ZOOM_MAX = 200;
  const ZOOM_STEP = 20;
  /** The sheet's width at 100%. */
  const SHEET_WIDTH = 780;

  let score = $state<Score | null>(null);
  let version = $state(0);
  let updatedAt = $state('');
  let failure = $state<{ kind: 'offline' | 'missing' | 'error'; message: string } | null>(null);

  let paper = $state<Paper>(DEFAULT_PAPER);
  let font = $state<MusicFontName>(DEFAULT_MUSIC_FONT);
  // Page numbers (SIB2-171): a render-time choice like the paper, off by default. The position is
  // `none` or a corner/centre; the format and first-page flag only matter once one is chosen.
  let numberPosition = $state<PageNumberPosition | 'none'>('none');
  let numberFormat = $state<PageNumberFormat>('n');
  let numberFirst = $state(true);
  // Empty staves to fill the last page (SIB2-181): a render choice, off by default.
  let blankStaves = $state(false);
  // Bar numbers at each system start (SIB2-191): drawn by default; a render choice like the paper.
  let barNumbers = $state(true);
  const pageNumbers = $derived<PageNumberSettings | null>(
    numberPosition === 'none' ? null : { position: numberPosition, format: numberFormat, first: numberFirst },
  );
  let zoom = $state(100);

  // The retained source scan, for the split-pane review (V14b, ADR-0019). A chart that came from an
  // import has one or more source pages kept forever and shown beside the engraved result; a
  // hand-authored or duplicated chart has none, and then this view is unchanged — no pane, no error.
  // `source` is null until the provenance is fetched and stays null for a scan-less chart; `showSource`
  // is the reader's toggle, defaulted on when a scan exists (side-by-side is the whole point of the
  // review, per ADR-0019) and flipped off to give the sheet the full width for editing.
  let source = $state<{ jobId: string; imageCount: number } | null>(null);
  let showSource = $state(false);
  const hasSource = $derived(source !== null && source.imageCount > 0);
  const splitView = $derived(hasSource && showSource);

  // Re-parse (V14e, ADR-0019): re-run OMR on this chart's retained scans into a NEW draft, so the
  // original chart and any corrections on it survive. Shown only for a source-bearing chart (`hasSource`,
  // the same gate the scan toggle uses). `reparseEngine` is the recogniser the user picks — the worker's
  // default until they choose one; `reparsing` guards the control and drives the progress label while the
  // job runs (recognition is minutes, ADR-0025); `reparseError` shows a failure in place rather than
  // navigating away.
  let reparseEngine = $state<string>('');
  let reparsing = $state(false);
  let reparseError = $state<string | null>(null);

  // The export format (V8e). PDF is the default and is what the sheet on screen is; MusicXML is a
  // codec at the edges (ADR-0004), so it does not change the sheet, only the file the rail downloads.
  let format = $state<ExportFormat>('pdf');

  // The instrument part on view (V6e). `concert` is the stored score; a transposing instrument is a
  // render-time view (ADR-0016) — the sheet shows the written part and the same choice drives the
  // export URL, but the part is a preview only: it is not the concert truth, so editing is off while
  // one is shown (a click on the written B♭ Tenor pitch would otherwise submit it as concert).
  let instrument = $state<ExportInstrument>('concert');
  const editable = $derived(instrument === 'concert');

  // The score actually rendered: the stored one for the concert view, its written part otherwise.
  // `writtenPart` is a pure transform (@sibei/music), the same one the server runs before an export,
  // so the sheet on screen and the exported part are the one render (ADR-0016).
  const renderScore = $derived.by(() =>
    score === null ? null : instrument === 'concert' ? score : writtenPart(score, instrument),
  );

  // The transpose target (V6e). Seeded to the chart's current key and snapped back to it after every
  // change, so the picker always opens on "where the chart is now" and the button is a no-op until
  // the reader moves it somewhere else.
  let transposeIndex = $state(0);
  const currentKeyIndex = $derived(
    score === null ? -1 : TARGET_KEYS.findIndex((option) => keyEquals(option.key, score!.meta.key)),
  );
  $effect(() => {
    if (currentKeyIndex !== -1) transposeIndex = currentKeyIndex;
  });

  // The page footer (SIB2-172): a copyright or credit line in the bottom margin. A draft the reader edits
  // and saves as a `meta.set`; re-seeded from the chart after every change, like the transpose target.
  let footerDraft = $state('');
  let footerPagesDraft = $state<'first' | 'last' | 'all'>('all');
  $effect(() => {
    footerDraft = score?.meta.footer?.text ?? '';
    footerPagesDraft = score?.meta.footer?.pages ?? 'all';
  });
  const footerDirty = $derived(
    score !== null &&
      (footerDraft !== (score.meta.footer?.text ?? '') ||
        (footerDraft !== '' && footerPagesDraft !== (score.meta.footer?.pages ?? 'all'))),
  );

  // The title block (SIB2-178): title, composer and the style or tempo line. Drafts the reader edits and
  // saves as one `meta.set` of whichever fields changed; re-seeded from the chart after every change.
  let titleDraft = $state('');
  let composerDraft = $state('');
  let subtitleDraft = $state('');
  let arrangerDraft = $state('');
  let styleDraft = $state('');
  $effect(() => {
    titleDraft = score?.meta.title ?? '';
    composerDraft = score?.meta.composer ?? '';
    subtitleDraft = score?.meta.subtitle ?? '';
    arrangerDraft = score?.meta.arranger ?? '';
    styleDraft = score?.meta.style ?? '';
  });
  const titleBlockDirty = $derived(
    score !== null &&
      (titleDraft !== score.meta.title ||
        composerDraft !== score.meta.composer ||
        subtitleDraft.trim() !== (score.meta.subtitle ?? '') ||
        arrangerDraft.trim() !== (score.meta.arranger ?? '') ||
        styleDraft.trim() !== (score.meta.style ?? '')),
  );

  async function handleTitleBlockSave(): Promise<void> {
    if (score === null || !titleBlockDirty) return;
    const payload: MetaSetPayload = {};
    if (titleDraft !== score.meta.title) payload.title = titleDraft;
    if (composerDraft !== score.meta.composer) payload.composer = composerDraft;
    if (subtitleDraft.trim() !== (score.meta.subtitle ?? '')) payload.subtitle = subtitleDraft.trim() === '' ? null : subtitleDraft.trim();
    if (arrangerDraft.trim() !== (score.meta.arranger ?? '')) payload.arranger = arrangerDraft.trim() === '' ? null : arrangerDraft.trim();
    if (styleDraft.trim() !== (score.meta.style ?? '')) payload.style = styleDraft.trim() === '' ? null : styleDraft.trim();
    deselect();
    await runOps([{ type: 'meta.set', payload }]);
  }

  async function handleBarsPerSystem(count: number): Promise<void> {
    if (score === null || count === (score.meta.barsPerSystem ?? 4)) return;
    deselect();
    await runOps([{ type: 'meta.set', payload: { barsPerSystem: count === 4 ? null : count } }]);
  }

  async function handleLayout(kind: 'lead-sheet' | 'score'): Promise<void> {
    if (score === null || kind === (score.meta.layout ?? 'lead-sheet')) return;
    deselect();
    await runOps([{ type: 'meta.set', payload: { layout: kind === 'lead-sheet' ? null : kind } }]);
  }

  async function handleSignaturePolicy(policy: 'every' | 'first' | 'page'): Promise<void> {
    if (score === null || policy === (score.meta.signaturePolicy ?? 'every')) return;
    deselect();
    await runOps([{ type: 'meta.set', payload: { signaturePolicy: policy } }]);
  }

  async function handleFooterSave(): Promise<void> {
    if (score === null) return;
    deselect();
    await runOps([
      {
        type: 'meta.set',
        payload: footerDraft.trim() === '' ? { footer: null } : { footer: footerDraft, footerPages: footerPagesDraft },
      },
    ]);
  }

  // The tempo mark (SIB2-177): a beat unit and a number, saved as a `meta.set`, re-seeded from the chart.
  let tempoUnit = $state('4');
  let tempoBpm = $state('');
  $effect(() => {
    const tempo = score?.meta.tempo;
    tempoUnit = tempo === undefined ? '4' : `${tempo.unit.value}${tempo.unit.dots === 1 ? '.' : ''}`;
    tempoBpm = tempo === undefined ? '' : String(tempo.bpm);
  });
  async function handleTempoSave(): Promise<void> {
    if (score === null) return;
    deselect();
    await runOps([
      {
        type: 'meta.set',
        payload: {
          tempo: {
            unit: { value: Number(tempoUnit.replace('.', '')), dots: tempoUnit.endsWith('.') ? 1 : 0 },
            bpm: Number(tempoBpm),
          },
        },
      },
    ]);
  }
  async function handleTempoRemove(): Promise<void> {
    if (score === null) return;
    deselect();
    await runOps([{ type: 'meta.set', payload: { tempo: null } }]);
  }

  async function handleChordStyle(event: Event): Promise<void> {
    if (score === null) return;
    const chosen = (event.currentTarget as HTMLSelectElement).value as 'standard' | 'dash' | 'words' | 'real-book';
    deselect();
    await runOps([{ type: 'meta.set', payload: { chordStyle: chosen } }]);
  }

  // Selection (V4c). The id is the whole of it — everything the inspector shows is looked up
  // fresh from the current render each time, never cached at selection time, so a reload never
  // leaves it holding a stale copy of what it is inspecting.
  let selectedId = $state<Id | null>(null);
  let selectedPage = $state<number | null>(null);
  // The second note of a slur (SIB2-168): shift-click beside the selected note. Like the selection it is
  // only an id and a page, its box and the slurs it would join looked up fresh from the render and model.
  let rangeId = $state<Id | null>(null);
  let rangePage = $state<number | null>(null);
  let conflict = $state(false);
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // Chord selection (V5e) is separate from item selection — a chord is not an item — and the two
  // are mutually exclusive: selecting one clears the other. In edit mode the overlay is looked up
  // fresh by `chordId` on every render (like the note path), so paper/face changes and live updates
  // move it with the ink. In add mode there is no chord yet, so its target box is the beat slot the
  // click resolved to, carried until Save turns it into a real chord.
  let chordSel = $state<{
    pageIndex: number;
    mode: 'add' | 'edit';
    chordId: Id | null;
    addr: string;
    barNumber: number;
    beat: number;
    seedText: string;
    box: { x: number; y: number; width: number; height: number };
  } | null>(null);

  // Bar selection (V7c) — a third, mutually-exclusive selection alongside items and chords. A bar is
  // not an item, so it is its own state; the id is just the page and the bar number, and everything
  // the Structure panel shows is looked up fresh from the model by number, so a reload never leaves
  // it holding a stale copy (the same discipline as note/chord selection).
  let barSel = $state<{ pageIndex: number; barNumber: number; staffIndex: number } | null>(null);

  // The active staff and voice (ADR-0041, slice 5b): where an edit by position lands. A click on a note,
  // a rest or a bar's staff sets it; it is kept inside what the chart has (a removed staff or voice
  // falls back). A chart with one staff and one voice never shows it and addresses unqualified.
  let laneChoice = $state<Lane>(FIRST_LANE);
  const activeLane = $derived(score === null ? FIRST_LANE : clampLane(score, laneChoice));
  const multiLane = $derived(score !== null && needsQualifier(score));

  // The beat under the pointer while it is over a chord band and nothing is being saved — the
  // "click above the staff to add a chord" affordance (the approved V5e interaction).
  let hoverSlot = $state<{ pageIndex: number; box: { x: number; y: number; width: number; height: number } } | null>(null);

  // The whole render, re-run when the score, the paper or the face changes — which is what makes
  // the switches change the page rather than only the URL.
  const pages = $derived(
    renderScore === null ? [] : renderScorePages(renderScore, { paper, pageNumbers, blankStaves, barNumbers }, { font }),
  );
  const review = $derived(score === null ? null : reviewSummary(score));
  const bars = $derived(score === null ? 0 : score.bars.filter((bar) => bar.number !== 0).length);
  const route = $derived(exportRoute({ format, paper, font, instrument, pageNumbers, blankStaves, barNumbers }));
  const formatLabel = $derived(FORMATS.find((f) => f.value === format)?.label ?? 'PDF');

  // The same font metrics `pages` above just rendered from — hit-testing calls the engraver's
  // own geometry functions with it rather than a second copy of them (../lib/hit-test.js).
  const musicFont = $derived(loadFont(font));

  const located = $derived.by(() => {
    if (selectedId === null || selectedPage === null) return null;
    const page = pages[selectedPage];
    if (page === undefined) return null;
    return findItem(page.layout, selectedId);
  });

  const selection = $derived.by((): Selection | null => {
    // A part is a preview, not the editable truth, so nothing is selectable while one is shown.
    if (!editable || located === null) return null;
    const { item } = located;
    if (item.kind === 'note') {
      return {
        kind: 'note',
        id: item.noteId,
        pitch: formatPitch(item.pitch),
        duration: item.duration,
        accidental: item.accidental,
        tie: item.tie,
        // The pin is not a layout property (it changes no ink), so it is read from the model note.
        spellingPinned: notePinned(item.noteId),
        fermata: item.fermata === true,
        articulations: item.articulations ?? [],
        graces: (item.graces ?? []).map((grace) => ({
          id: grace.graceId,
          pitch: formatPitch(grace.pitch),
          value: grace.value,
          slashed: grace.slashed,
        })),
      };
    }
    return { kind: 'rest', id: item.restId, duration: item.duration, fermata: item.fermata === true };
  });

  /** A note's spelling pin, looked up from the stored score by id — the layout item does not carry it. */
  function notePinned(noteId: Id): boolean {
    return score !== null && notePinnedIn(score, noteId);
  }

  /** The tuplet an item sits in, from the stored score, on any staff or voice (SIB2-166). */
  function tupletOfItem(itemId: Id): { actual: number; normal: number } | null {
    const found = score === null ? null : tupletOf(score, itemId);
    return found === null ? null : { actual: found.actual, normal: found.normal };
  }

  /** A chord's spelling pin, looked up from the stored score by id (the seed for the chord inspector). */
  function chordPinned(chordId: Id): boolean {
    if (score === null) return false;
    for (const bar of barViews(score)) {
      for (const chord of bar.chords) {
        if (chord.id === chordId) return chord.spellingPinned;
      }
    }
    return false;
  }

  const rangeOverlay = $derived.by(() => {
    if (rangeId === null || rangePage === null) return null;
    const page = pages[rangePage];
    if (page === undefined) return null;
    const box = boxFor(pageItemBoxes(page.layout, musicFont), rangeId);
    return box === null ? null : { pageIndex: rangePage, box };
  });

  /** The slur the two selected notes would make, or null when the pair is not two notes. */
  const pendingSlur = $derived.by(() => {
    if (score === null || selectedId === null || rangeId === null) return null;
    return slurOp(score, selectedId, rangeId, 'auto') === null ? null : { with: rangeId };
  });
  const slursHere = $derived(score === null || selectedId === null ? [] : slursOnNote(score, selectedId));

  // Ottava lines (SIB2-184) share the two-note selection the slur control uses.
  const ottavasHere = $derived(score === null || selectedId === null ? [] : ottavasOnNote(score, selectedId));
  async function handleOttava(shift: 'up' | 'down'): Promise<void> {
    if (score === null || selectedId === null || rangeId === null) return;
    const operation = ottavaOp(score, selectedId, rangeId, shift);
    if (operation !== null) await runOps([operation]);
  }

  async function handleSlur(placement: SlurChoice): Promise<void> {
    if (score === null || selectedId === null || rangeId === null) return;
    const operation = slurOp(score, selectedId, rangeId, placement);
    if (operation !== null) await runOps([operation]);
  }

  const selectionOverlay = $derived.by(() => {
    if (selectedId === null || selectedPage === null) return null;
    const page = pages[selectedPage];
    if (page === undefined) return null;
    const box = boxFor(pageItemBoxes(page.layout, musicFont), selectedId);
    return box === null ? null : { pageIndex: selectedPage, box };
  });

  // The selected chord's current box, looked up fresh so it tracks a repaint. Null in add mode, and
  // null in edit mode once the chord no longer exists (removed here or elsewhere).
  const selectedChordBox = $derived.by((): ChordBox | null => {
    if (chordSel === null || chordSel.mode !== 'edit' || chordSel.chordId === null) return null;
    const page = pages[chordSel.pageIndex];
    if (page === undefined) return null;
    return pageChordBoxes(page.layout, musicFont).find((box) => box.chordId === chordSel?.chordId) ?? null;
  });

  const chordSelection = $derived.by((): ChordSelection | null => {
    if (!editable || chordSel === null) return null;
    // A chord edited away elsewhere leaves nothing to inspect: hide rather than dangle.
    if (chordSel.mode === 'edit' && selectedChordBox === null) return null;
    return {
      addr: chordSel.addr,
      mode: chordSel.mode,
      text: chordSel.seedText,
      barNumber: chordSel.barNumber,
      beat: chordSel.beat,
      spellingPinned: chordSel.chordId === null ? false : chordPinned(chordSel.chordId),
    };
  });

  const chordOverlay = $derived.by(() => {
    if (chordSel === null) return null;
    const box = chordSel.mode === 'edit' ? selectedChordBox : chordSel.box;
    return box === null ? null : { pageIndex: chordSel.pageIndex, box };
  });

  // The selected bar's structure, read fresh from the stored score by bar number (V7c). Barlines and
  // the ending are on the model bar; the rehearsal letter and section name come from the section that
  // begins on this bar, if any. Nothing here is a layout property — the panel edits the document, not
  // the render — so like note/chord pins it is looked up from `score`, never from the layout items.
  const barStructure = $derived.by((): BarStructure | null => {
    if (!editable || barSel === null || score === null) return null;
    const bar = barByNumber(score, barSel!.barNumber);
    if (bar === null) return null;
    const section = sectionStartingAt(score, bar.number);
    return {
      barNumber: bar.number,
      addr: `bar${bar.number}`,
      isPickup: bar.number === 0,
      hasSection: section !== null,
      letter: section?.letter ?? '',
      name: section?.name ?? '',
      startBarline: bar.startBarline,
      endBarline: bar.endBarline,
      ending: bar.ending,
      lineBreak: bar.lineBreak ?? 'none',
      texts: [...bar.annotations]
        .sort((a, b) => a.onset - b.onset)
        .map((a) => ({
          id: a.id,
          beat: beatOfOnset(a.onset, score!.meta.time),
          text: a.text,
          until: score!.bars.find((b) => b.id === a.lineEndBarId)?.number ?? null,
        })),
    };
  });

  const barOverlay = $derived.by(() => {
    if (barSel === null) return null;
    const page = pages[barSel.pageIndex];
    if (page === undefined) return null;
    const box = barBoxFor(pageBarBoxes(page.layout), barSel.barNumber, barSel.staffIndex);
    return box === null ? null : { pageIndex: barSel.pageIndex, box };
  });

  async function load(): Promise<void> {
    try {
      const record = await getScore(id);
      score = record.score;
      version = record.version;
      updatedAt = record.updatedAt;
      failure = null;
      onTitle(record.score.meta.title);
      onReachable(true);
    } catch (error) {
      score = null;
      onTitle(null);
      if (error instanceof OfflineError) {
        failure = { kind: 'offline', message: error.message };
        onReachable(false);
        return;
      }
      onReachable(true);
      if (error instanceof ApiError && error.status === 404) {
        failure = { kind: 'missing', message: error.message };
        return;
      }
      failure = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The source-scan provenance (V14b, ADR-0019). Fetched once per opened chart (the id is fixed for
   * this component's life — `App.svelte` keys it on the id), separately from `load` because it never
   * changes with an edit: `GET /v1/scores/:id/source` answers the owning import and its page count,
   * or the empty shape for a chart with no scan behind it. A failure here is swallowed on purpose —
   * the scan is an aid to correction, not the chart, so nothing about not reaching it may disturb the
   * score view (which is exactly why the route answers a value, not a 404, for a scan-less chart).
   */
  async function loadSource(): Promise<void> {
    try {
      const provenance = await getScoreSource(id);
      if (provenance.jobId !== null && provenance.imageCount > 0) {
        source = { jobId: provenance.jobId, imageCount: provenance.imageCount };
        showSource = true;
      } else {
        source = null;
      }
    } catch {
      source = null;
    }
  }

  /**
   * Re-parse (V14e, ADR-0019): submit the chart's retained scans for a fresh OMR run and open the new
   * draft. It reuses the same server-only import path a normal import does (the runner → `Applier.import`),
   * so it is not a second write path, and it produces a *new* score — the chart on screen is untouched.
   * The job is durable (ADR-0001), so this submits, polls to a terminal status while the recogniser runs,
   * then navigates to the new draft on success (the hash change remounts the view on the new id). A
   * failure is shown in place; the original chart is still there to keep correcting by hand.
   */
  async function handleReparse(): Promise<void> {
    if (reparsing) return;
    reparsing = true;
    reparseError = null;
    try {
      let job = await reparseScore(id, reparseEngine === '' ? undefined : reparseEngine);
      while (job.status === 'queued' || job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await getImport(job.id);
      }
      if (job.status === 'succeeded' && job.scoreId !== null) {
        // Open the new draft. Keyed on the id in `App.svelte`, so this remounts the view fresh.
        window.location.hash = hashOf({ view: 'score', id: job.scoreId });
      } else {
        reparseError = job.diagnostic ?? 'the re-parse did not produce a chart';
      }
    } catch (error) {
      reparseError = error instanceof Error ? error.message : 'the re-parse could not be started';
    } finally {
      reparsing = false;
    }
  }

  function stepZoom(by: number): void {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + by));
  }

  function deselect(): void {
    selectedId = null;
    selectedPage = null;
    rangeId = null;
    rangePage = null;
    chordSel = null;
    barSel = null;
    conflict = false;
    saveError = null;
  }

  /**
   * A click on a sheet, in that page's own layout units (`SheetStack` did the pixel-to-unit
   * arithmetic; this is where musical meaning is decided). Missing everything counts as a
   * deselect — clicking white space is how the mockup's "Deselect" affordance behaves without a
   * second control for it.
   */
  function handleSheetClick(pageIndex: number, point: Point, extend = false): void {
    // A part view is read-only: its notes are written pitches, and an edit there would be submitted
    // against the concert score at the wrong pitch. So a click does nothing until you are on concert.
    if (saving || !editable) return;
    const page = pages[pageIndex];
    if (page === undefined) return;
    conflict = false;
    saveError = null;

    // A chord first: its band sits above the staff, clear of the notes, so a click there is never
    // ambiguous with a note. Clicking an existing chord edits it; clicking an empty beat in the band
    // adds one there (Q32). Only then does a click fall through to the notes and rests below.
    const chordHit = chordAt(pageChordBoxes(page.layout, musicFont), point);
    if (chordHit !== null && !chordHit.plain) {
      selectChord(pageIndex, 'edit', chordHit.chordId, chordHit.addr, chordHit.barNumber, chordHit.beat, chordHit.text, chordHit);
      return;
    }
    if (score !== null) {
      const slot = beatSlotAt(page.layout, point, score.meta.time);
      if (slot !== null && chordHit === null) {
        selectChord(pageIndex, 'add', null, slot.addr, slot.barNumber, slot.beat, '', slot);
        return;
      }
    }

    const hit = hitTest(pageItemBoxes(page.layout, musicFont), point);
    // Shift-click a second note while one is selected: the other end of a slur (SIB2-168).
    if (extend && hit !== null && selectedId !== null && hit.id !== selectedId) {
      rangeId = hit.id;
      rangePage = pageIndex;
      return;
    }
    if (hit !== null) {
      rangeId = null;
      rangePage = null;
      chordSel = null;
      barSel = null;
      selectedId = hit.id;
      selectedPage = pageIndex;
      laneChoice = { staff: hit.staffIndex + 1, voice: hit.voice };
      return;
    }

    // Nothing above the staff and no note under the click: the bar itself, so its structure (section,
    // barlines, endings) becomes editable. A barline sits on a bar edge, so clicking one lands in the
    // bar it bounds — "click the bar or its barline" (V7c). Only a click that misses every bar — the
    // margins, the gap between systems — is a deselect.
    const barHit = barAt(pageBarBoxes(page.layout), point);
    if (barHit === null) {
      deselect();
      return;
    }
    selectedId = null;
    chordSel = null;
    barSel = { pageIndex, barNumber: barHit.barNumber, staffIndex: barHit.staffIndex };
    // A click on an empty staff makes it active; the voice stays as chosen (clamped to what the staff has).
    laneChoice = { staff: barHit.staffIndex + 1, voice: laneChoice.voice };
  }

  function selectChord(
    pageIndex: number,
    mode: 'add' | 'edit',
    chordId: Id | null,
    addr: string,
    barNumber: number,
    beat: number,
    seedText: string,
    box: { x: number; y: number; width: number; height: number },
  ): void {
    selectedId = null;
    selectedPage = null;
    barSel = null;
    chordSel = { pageIndex, mode, chordId, addr, barNumber, beat, seedText, box };
  }

  /** The pointer moved over a sheet: light the add-a-chord marker if it is in an empty band beat. */
  function handleSheetHover(pageIndex: number, point: Point | null): void {
    if (point === null || saving || score === null || !editable) {
      hoverSlot = null;
      return;
    }
    const page = pages[pageIndex];
    if (page === undefined) {
      hoverSlot = null;
      return;
    }
    // Don't offer "add" where a chord already sits — that is an edit target, not an empty beat.
    if (chordAt(pageChordBoxes(page.layout, musicFont), point) !== null) {
      hoverSlot = null;
      return;
    }
    const slot = beatSlotAt(page.layout, point, score.meta.time);
    hoverSlot = slot === null ? null : { pageIndex, box: slot };
  }

  async function handleChordSave(text: string, spellingPinned: boolean): Promise<void> {
    if (score === null || chordSel === null) return;
    await runOps([{ type: 'chord.set', target: chordSel.addr, payload: { text, spellingPinned } }]);
  }

  /**
   * Transpose the whole chart into a new concert key (V6e, ADR-0016). Unlike Face, Paper and Part —
   * which only change what is drawn — this is a **mutation**: it posts a `transpose` op to the one
   * write path and re-reads, so the version bumps and it is undoable later like any edit. A no-op
   * when the target is the key the chart is already in.
   */
  async function handleTranspose(): Promise<void> {
    const target = TARGET_KEYS[transposeIndex];
    if (score === null || target === undefined || keyEquals(target.key, score.meta.key)) return;
    deselect();
    await runOps([{ type: 'transpose', payload: { to: target.key } }]);
  }

  async function handleChordRemove(): Promise<void> {
    if (score === null || chordSel === null || chordSel.mode !== 'edit') return;
    await runOps([{ type: 'chord.rm', target: chordSel.addr }]);
  }

  /**
   * `note.set` for a note; `rest.rm` + `rest.add` in one batch for a rest, because there is no
   * `rest.set` verb and inventing one is a slice-level decision this card does not get to make
   * (KAN-589). The add's target is a position — `bar12.beat3` — because the rm just freed that
   * beat and the new rest has no id yet to address by.
   *
   * Success re-reads the score rather than trusting `ApplyResult`'s content, the same reasoning
   * as the SSE event payload: this response says an edit landed, not what the chart now says.
   * A 409 is the one path that does not re-read — it shows the conflict panel, and reloading is
   * the only way out of it (ADR-0003).
   */
  async function handleSave(edits: NoteEdits | RestEdits): Promise<void> {
    if (score === null || located === null || selectedId === null) return;
    // A rest is replaced by position, so the address names the staff and voice the rest sits in.
    const here = qualifierOf(score, { staff: located.staffIndex + 1, voice: located.voice });

    const operations: Operation[] =
      located.item.kind === 'note'
        ? [{ type: 'note.set', target: selectedId, payload: edits as NoteEdits }]
        : [
            { type: 'rest.rm', target: selectedId },
            {
              type: 'rest.add',
              target: `${here}bar${located.barNumber}.beat${located.item.beat}`,
              payload: { duration: (edits as RestEdits).duration },
            },
            // `rest.add` makes a new rest, which would drop the old one's fermata (SIB2-183).
            ...(located.item.fermata === true
              ? [{ type: 'fermata.set', target: `${here}bar${located.barNumber}.beat${located.item.beat}` } as Operation]
              : []),
          ];

    await runOps(operations);
  }

  /** Bracket a run as a tuplet from the selected item, or take it off (SIB2-166). One op, so one undo. */
  async function handleSetTuplet(actual: number, normal: number, count: number): Promise<void> {
    if (selectedId === null) return;
    await runOps([{ type: 'tuplet.set', target: selectedId, payload: { actual, normal, count } }]);
  }

  async function handleRemoveTuplet(): Promise<void> {
    if (selectedId === null) return;
    await runOps([{ type: 'tuplet.rm', target: selectedId }]);
  }

  /**
   * Save a bar's structure (V7c). The panel hands over the bar's desired section, barlines and
   * ending; this turns the diff against what the bar carries now into the minimal batch of the ops
   * V7a/V7b built — `section.set`/`section.rm`, `barline.set`, `ending.set`/`ending.rm` — and posts
   * them as one unit, so undo reverts the whole structural edit at once. Editing the letter/name
   * fields to empty removes the section; the panel does not author a label-less boundary (the CLI
   * does), which keeps two text fields meaning exactly one thing.
   */
  async function handleStructureSave(edits: StructureEdits): Promise<void> {
    if (score === null || barStructure === null) return;
    const operations = structureOps(barStructure, edits);
    // Nothing changed: skip the round trip rather than post an empty batch (the server refuses one).
    if (operations.length === 0) {
      deselect();
      return;
    }
    await runOps(operations);
  }

  /**
   * The write half every inspector shares: submit to the one write path, then re-read rather than
   * trust the response (`changed[]` names ids, not values), and deselect. A 409 is the one path that
   * does not re-read — it raises the conflict panel, and reloading is the only way out (ADR-0003).
   */
  async function runOps(operations: Operation[]): Promise<boolean> {
    if (score === null) return false;
    saving = true;
    saveError = null;
    try {
      await submitOps(score.id, { operations, expectedVersion: version });
      await load();
      deselect();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        conflict = true;
        return false;
      }
      saveError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      saving = false;
    }
  }

  /** Put a note or a rest at a beat of the selected bar, in the active staff and voice (slice 5b). */
  async function handleNewItem(item: NewItemSpec): Promise<void> {
    if (score === null || barSel === null) return;
    const lane = { staff: barSel.staffIndex + 1, voice: activeLane.voice };
    await runOps([newItemOp(qualifierOf(score, lane), barSel.barNumber, item)]);
  }

  async function handleReload(): Promise<void> {
    deselect();
    await load();
  }

  /**
   * Undo and redo (V8a, ADR-0003). Same recovery path as `runOps`: submit, re-read, deselect, and a
   * 409 raises the conflict panel rather than retrying at the server's version. A move that did
   * nothing — the undo floor or the redo head — comes back `moved: false`, and the re-read is a
   * cheap no-op, so ctrl-Z past the first edit is quiet rather than an error.
   */
  async function runMove(direction: 'undo' | 'redo'): Promise<void> {
    if (score === null || !editable || saving) return;
    saving = true;
    saveError = null;
    try {
      await (direction === 'undo' ? undoScore : redoScore)(score.id, version);
      await load();
      deselect();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        conflict = true;
        return;
      }
      saveError = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }

  /** A field with its own undo stack: ctrl-Z there is text editing, not a document undo. */
  function isTextField(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
  }

  /**
   * Ctrl-Z / ⌘-Z undo, and Ctrl-Shift-Z / ⌘-Shift-Z / Ctrl-Y redo — the global affordance PLAN.md
   * names (P4), the browser half of `sbscore undo`. Registered on the window once (the effect reads
   * nothing reactive synchronously, so it does not re-bind on every edit) and reads the live state
   * at keypress. It stands down over a text field so the chord editor keeps its own undo, and over a
   * part preview, where editing — and so undo — is off (the sheet is not the concert truth).
   */
  $effect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const undo = key === 'z' && !event.shiftKey;
      const redo = (key === 'z' && event.shiftKey) || key === 'y';
      if (!undo && !redo) return;
      if (isTextField(event.target) || score === null || !editable || saving) return;
      event.preventDefault();
      void runMove(undo ? 'undo' : 'redo');
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  /**
   * Keys 1 to 4 pick that voice of the active staff (slice 5b), only on a chart that has more than one lane and only
   * when nothing else wants the key: not in a text field, not with a modifier, not over a focused control (a button
   * or a select owns its own keys). Nothing else in the score view binds a bare digit, so a lead sheet is unaffected.
   */
  $effect(() => {
    function onVoiceKey(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (score === null || !editable || saving || !multiLane || isTextField(event.target)) return;
      if (event.target instanceof HTMLElement && ['BUTTON', 'SELECT', 'A'].includes(event.target.tagName)) return;
      const voice = voiceForKey(score, activeLane, event.key);
      if (voice === null) return;
      event.preventDefault();
      laneChoice = { staff: activeLane.staff, voice };
    }
    window.addEventListener('keydown', onVoiceKey);
    return () => window.removeEventListener('keydown', onVoiceKey);
  });

  /**
   * Live updates (V4d, SLICES.md V4 step 5). One stream per mounted chart: `App.svelte` keys this
   * component on the id, so `id` is fixed here and the effect opens exactly one connection and
   * closes it on unmount (the teardown `watchScore` returns is the effect's cleanup).
   *
   * A `changed` frame carries the version that now exists. If that is not the version on screen,
   * re-read — the same recovery `handleSave` runs, and what the server's `{version}`-only payload
   * was shaped for (`change-bus.ts`). Three frames are deliberately no-ops: the stream's opening
   * catch-up frame (its version is the one we just loaded), a change we made ourselves (`load`
   * already moved us there), and any frame that lands mid-save — that one is left to the save's own
   * re-read rather than raced with it. A `deleted` frame means the chart is gone; there is no
   * version to re-read to, so it becomes the same "no chart with that id" state a 404 does.
   */
  $effect(() =>
    watchScore(id, {
      onChanged: (incoming) => {
        if (score !== null && !saving && incoming !== version) void load();
      },
      onDeleted: () => {
        score = null;
        onTitle(null);
        deselect();
        failure = { kind: 'missing', message: 'this chart was deleted.' };
      },
    }),
  );

  void load();
  void loadSource();
</script>

{#if failure !== null}
  <div class="failure">
    <div class="state">
      <h2>
        {#if failure.kind === 'offline'}No answer from the server.
        {:else if failure.kind === 'missing'}No chart with that id.
        {:else}The server refused that.{/if}
      </h2>
      <p>{failure.message}</p>
      {#if failure.kind === 'offline'}
        <div class="term"><span class="prompt">{'$ '}</span>{SERVE_COMMAND}</div>
      {/if}
    </div>
  </div>
{:else if score !== null}
  <section class="score">
    <aside class="rail">
      <div>
        <h2 class="rail-title" class:untitled={score.meta.title === ''}>
          {displayTitle(score.meta.title)}
        </h2>
        {#if score.meta.composer !== ''}
          <p class="rail-by">{score.meta.composer}</p>
        {/if}
      </div>

      <!-- Deliberately not repeating `style` here — it is printed on the page, two centimetres
           away. The rail carries what the page cannot say. -->
      <dl class="facts">
        <dt>key</dt>
        <dd>{displayKey(formatKeySignature(score.meta.key))}</dd>
        <dt>time</dt>
        <dd>{score.meta.time.beats}/{score.meta.time.beatValue}</dd>
        <dt>bars</dt>
        <dd>{bars}</dd>
        <dt>pages</dt>
        <dd>{pages.length} · {paperLabel(paper)}</dd>
        <dt>version</dt>
        <dd>v{version}</dd>
        <dt>updated</dt>
        <dd>{absoluteTime(updatedAt)}</dd>
        <dt>id</dt>
        <dd class="id">{score.id}</dd>
      </dl>

      <div class="group">
        <h3>Review</h3>
        <!-- `anythingFlagged` is the model's single answer, and until KAN-597 it was not: it read
             the *stored* `bar.review.flagged` while the two lines below derived the same fact from
             the bar's contents, so this branch printed "Nothing flagged." over a chart with two
             invalid bars. Every chart authored through the API was right — the applier stamps the
             flag on write — so it was correct exactly where anyone looked. Nothing about the branch
             changes; the answer it asks for does. -->
        {#if review === null || !review.anythingFlagged}
          <p class="review-ok">Nothing flagged.</p>
        {:else}
          <!-- The wording is the model's, not this component's: `reviewSummary` is what the text
               projection prints too, so the two surfaces cannot describe the same chart in two
               vocabularies. A blank chart now reports nothing, which is why the first thing a new
               user sees is no longer a chart entirely in review. -->
          <div class="review-flag">
            <span class="bang">!</span>{review.meterNote ?? NEEDS_REVIEW}
            {#if review.invalidBars.length > 0}
              <span class="bars">{formatBarRanges(review.invalidBars)}</span>
            {/if}
          </div>
        {/if}
        <!-- A layout advisory, not a review flag (V14, ADR-0015): sections drive line-breaking, so
             a section-less chart — every fresh import (ADR-0021) — lays out on a plain four-bar grid
             until one is added. Non-blocking by decision (ADR-0013/0019 never refuse a draft), so it
             is a prompt beside the flags, never a `!`. `hasSections` is the model's single answer, the
             same one the text projection prints, so the two surfaces cannot word it differently. -->
        {#if review !== null && !review.hasSections}
          <p class="review-advisory">{NO_SECTIONS_ADVISORY}</p>
        {/if}
      </div>

      <div class="group control-row">
        <h3>Transpose</h3>
        <div class="transpose-row">
          <select
            class="key-select"
            aria-label="Transpose to key"
            value={transposeIndex}
            onchange={(event) => (transposeIndex = Number((event.currentTarget as HTMLSelectElement).value))}
          >
            {#each TARGET_KEYS as option, index (option.label)}
              <option value={index}>{option.label}</option>
            {/each}
          </select>
          <button
            type="button"
            class="transpose-btn"
            disabled={saving || transposeIndex === currentKeyIndex}
            onclick={handleTranspose}
          >
            {saving ? 'Working…' : 'Transpose'}
          </button>
        </div>
        <p class="control-note">
          Changes the chart's concert key — the melody and chords move together. A logged, undoable
          edit, not a view: the version bumps.
        </p>
      </div>

      {#if editable}
        <div class="group control-row">
          <h3>Staves and voices</h3>
          <StaffPanel
            {score}
            lane={activeLane}
            barNumber={barSel?.barNumber ?? null}
            {saving}
            error={chordSelection === null && selection === null && barStructure === null ? saveError : null}
            onops={runOps}
            onlane={(next) => (laneChoice = next)}
          />
        </div>
      {/if}

      <div class="group control-row">
        <h3>Title block</h3>
        <input class="meta-input" aria-label="Title" placeholder="Title" bind:value={titleDraft} />
        <input class="meta-input" aria-label="Subtitle" placeholder="Subtitle" bind:value={subtitleDraft} />
        <textarea class="meta-input" aria-label="Composer" placeholder="Composer (one per line)" rows="2" bind:value={composerDraft}></textarea>
        <input class="meta-input" aria-label="Arranger" placeholder="Arranger" bind:value={arrangerDraft} />
        <input class="meta-input" aria-label="Style or tempo" placeholder="Style or tempo, e.g. Medium swing" bind:value={styleDraft} />
        <button type="button" class="transpose-btn" disabled={saving || !titleBlockDirty} onclick={handleTitleBlockSave}>
          {saving ? 'Working…' : 'Set title block'}
        </button>
        <p class="control-note">
          Printed above the first system. A logged, undoable edit (<code>meta set --title --subtitle --composer --arranger --style</code>).
        </p>
      </div>

      <div class="group control-row">
        <h3>Bars per line</h3>
        <select
          class="part-select"
          aria-label="Bars per line"
          value={score.meta.barsPerSystem ?? 4}
          disabled={saving}
          onchange={(event) => void handleBarsPerSystem(Number((event.currentTarget as HTMLSelectElement).value))}
        >
          {#each [1, 2, 3, 4, 5, 6, 7, 8] as count (count)}
            <option value={count}>{count}{count === 4 ? ' (the grid)' : ''}</option>
          {/each}
        </select>
        <p class="control-note">Where one line should end instead, click a bar and set its line break. A logged, undoable edit (<code>meta set --bars-per-system</code>, <code>break set</code>).</p>
      </div>

      <div class="group control-row">
        <h3>Layout</h3>
        <select
          class="part-select"
          aria-label="How systems are broken"
          value={score.meta.layout ?? 'lead-sheet'}
          disabled={saving}
          onchange={(event) => void handleLayout((event.currentTarget as HTMLSelectElement).value as 'lead-sheet' | 'score')}
        >
          <option value="lead-sheet">Lead sheet (four bars to a line)</option>
          <option value="score">Score (lines break by width)</option>
        </select>
        <p class="control-note">For a chart of several staves. A logged, undoable edit (<code>meta set --layout</code>).</p>
      </div>

      <div class="group control-row">
        <h3>Clef and key</h3>
        <select
          class="part-select"
          aria-label="Where clef and key signature are drawn"
          value={score.meta.signaturePolicy ?? 'every'}
          disabled={saving}
          onchange={(event) => void handleSignaturePolicy((event.currentTarget as HTMLSelectElement).value as 'every' | 'first' | 'page')}
        >
          <option value="every">Every system</option>
          <option value="first">First system only</option>
          <option value="page">First system of each page</option>
        </select>
        <p class="control-note">Later systems without them get the room back. A logged, undoable edit (<code>meta set --signature-policy</code>).</p>
      </div>

      <div class="group control-row">
        <h3>Footer</h3>
        <textarea
          class="footer-text"
          aria-label="Page footer text"
          rows="3"
          maxlength="500"
          placeholder="© 2026 … · lead sheet by …"
          bind:value={footerDraft}
        ></textarea>
        <div class="transpose-row">
          <select class="key-select" aria-label="Pages carrying the footer" bind:value={footerPagesDraft}>
            <option value="all">Every page</option>
            <option value="first">First page</option>
            <option value="last">Last page</option>
          </select>
          <button type="button" class="transpose-btn" disabled={saving || !footerDirty} onclick={handleFooterSave}>
            {saving ? 'Working…' : 'Set footer'}
          </button>
        </div>
        <p class="control-note">
          A copyright or credit line in the bottom margin, wrapped to fit. A logged, undoable edit
          (<code>meta set --footer</code>).
        </p>
      </div>

      <div class="group control-row">
        <h3>Tempo</h3>
        <div class="transpose-row">
          <select class="key-select" aria-label="Tempo beat unit" bind:value={tempoUnit}>
            <option value="4">quarter =</option>
            <option value="4.">dotted quarter =</option>
            <option value="2">half =</option>
            <option value="8">eighth =</option>
            <option value="1">whole =</option>
          </select>
          <input
            class="key-select"
            type="number"
            min="20"
            max="400"
            aria-label="Beats per minute"
            bind:value={tempoBpm}
          />
        </div>
        <div class="transpose-row">
          <button type="button" class="transpose-btn" disabled={saving || tempoBpm === ''} onclick={handleTempoSave}>
            {saving ? 'Working…' : 'Set tempo'}
          </button>
          <button type="button" class="transpose-btn" disabled={saving || score.meta.tempo === undefined} onclick={handleTempoRemove}>
            Remove
          </button>
        </div>
        <p class="control-note">
          A metronome mark above the first bar; notation only, nothing plays. A logged, undoable edit
          (<code>meta set --tempo</code>).
        </p>
      </div>

      <div class="group control-row">
        <h3>Chord symbols</h3>
        <select
          class="key-select"
          aria-label="Print chords as"
          disabled={saving}
          value={score?.meta.chordStyle ?? 'standard'}
          onchange={handleChordStyle}
        >
          <option value="standard">Δ · m7 · ø (standard)</option>
          <option value="dash">Δ · -7 · -7♭5</option>
          <option value="words">maj7 · min7 · m7♭5</option>
          <option value="real-book">MA7 · MI7 · MI7♭5</option>
        </select>
        <p class="control-note">
          How this chart prints its chords; the chord text is unchanged. A logged, undoable edit
          (<code>meta set --chord-style</code>).
        </p>
      </div>

      <div class="group control-row">
        <h3>Face</h3>
        <SegmentedControl
          label="Music face"
          options={FONTS}
          value={font}
          onselect={(chosen) => (font = chosen)}
        />
        <p class="control-note">
          Bravura, engraved · Petaluma, the handwritten Real Book face. The face is chosen per
          render, not per chart.
        </p>
      </div>

      <div class="group control-row">
        <h3>Paper</h3>
        <SegmentedControl
          label="Paper size"
          options={PAPERS}
          value={paper}
          display={paperLabel}
          onselect={(chosen) => (paper = chosen)}
        />
        <p class="control-note">Paper changes the line breaks, so the page above changes with it.</p>
      </div>

      <div class="group control-row">
        <h3>Page numbers</h3>
        <select
          class="part-select"
          aria-label="Page number position"
          value={numberPosition}
          onchange={(event) => (numberPosition = (event.currentTarget as HTMLSelectElement).value as PageNumberPosition | 'none')}
        >
          <option value="none">None</option>
          {#each NUMBER_POSITIONS as position (position)}
            <option value={position}>{position.replace('-', ' ')}</option>
          {/each}
        </select>
        {#if numberPosition !== 'none'}
          <select
            class="part-select"
            aria-label="Page number format"
            value={numberFormat}
            onchange={(event) => (numberFormat = (event.currentTarget as HTMLSelectElement).value as PageNumberFormat)}
          >
            {#each NUMBER_FORMATS as option (option)}
              <option value={option}>{option === 'n' ? '2' : option === 'page' ? 'Page 2' : 'Page 2 of 3'}</option>
            {/each}
          </select>
          <label class="control-note"><input type="checkbox" bind:checked={numberFirst} /> Number the first page</label>
        {/if}
        <p class="control-note">Printed in the margin of every page of the PDF. Off by default; a render choice, not stored in the chart.</p>
      </div>

      <div class="group control-row">
        <h3>Blank staves</h3>
        <label class="control-note"><input type="checkbox" bind:checked={blankStaves} /> Fill the rest of the last page with empty staves</label>
        <p class="control-note">For writing in by hand. Off by default; a render choice, not stored in the chart (<code>export --blank-staves</code>).</p>
      </div>

      <div class="group control-row">
        <h3>Bar numbers</h3>
        <label class="control-note"><input type="checkbox" bind:checked={barNumbers} /> Number the bar at the head of each line</label>
        <p class="control-note">Drawn by default. A render choice, not stored in the chart (<code>export --no-bar-numbers</code>).</p>
      </div>

      <div class="group">
        <h3>Part</h3>
        <select
          class="part-select"
          aria-label="Instrument part"
          value={instrument}
          onchange={(event) => (instrument = (event.currentTarget as HTMLSelectElement).value as ExportInstrument)}
        >
          {#each INSTRUMENTS as option (option.value)}
            <option value={option.value}>{option.label} — {option.hint}</option>
          {/each}
        </select>
        {#if !editable}
          <!-- The part is drawn from the concert score by the same transform the export runs, so it
               is a true preview — but a preview, so the sheet says so and editing is off. -->
          <p class="control-note preview-note">
            Previewing the {INSTRUMENTS.find((o) => o.value === instrument)?.label} part — a view,
            nothing stored. Switch to <b>Concert score</b> to edit.
          </p>
        {:else}
          <p class="control-note">
            A written part for a transposing instrument — a render-time view (ADR-0016). The concert
            chart is unchanged.
          </p>
        {/if}
      </div>

      <div class="group">
        <h3>Export</h3>
        <SegmentedControl
          label="Export format"
          options={FORMATS.map((f) => f.value)}
          value={format}
          display={(value) => FORMATS.find((f) => f.value === value)?.label ?? value}
          onselect={(chosen) => (format = chosen)}
        />
        <a class="export" href={exportUrl(score.id, { format, paper, font, instrument, pageNumbers, blankStaves, barNumbers })} download>
          Export {editable
            ? formatLabel
            : `${INSTRUMENTS.find((o) => o.value === instrument)?.label} part`}
        </a>
        <!-- The route, not the instance: the id is already in the facts above, and a
             40-character id wraps this column into nonsense. -->
        <p class="url">
          <span class="u-path">{route.path}</span>
          <span class="u-q">{route.query}</span>
        </p>
        {#if format === 'musicxml'}
          <p class="control-note">
            MusicXML is a codec at the edges (ADR-0004) — lossy in known ways, and it ignores the
            paper and face, which are page choices. A transposing part exports transposed.
          </p>
        {/if}
      </div>

      <div class="group">
        <h3>Selected</h3>
        {#if chordSelection !== null}
          {#key `${chordSelection.mode}:${chordSelection.addr}`}
            <ChordInspector
              chord={chordSelection}
              {conflict}
              {saving}
              error={saveError}
              onsave={handleChordSave}
              onremove={handleChordRemove}
              ondeselect={deselect}
              onreload={handleReload}
            />
          {/key}
        {:else if selection !== null}
          {#key selection.id}
            <Inspector
              {selection}
              lane={multiLane && located !== null
                ? laneLabel(score, { staff: located.staffIndex + 1, voice: located.voice })
                : null}
              {conflict}
              {saving}
              error={saveError}
              pendingSlur={pendingSlur}
              slurs={slursHere}
              onfermata={(on) =>
                void runOps([{ type: on ? 'fermata.set' : 'fermata.rm', target: selection!.id } as Operation])}
              onslur={(placement) => void handleSlur(placement)}
              onrmslur={(id) => void runOps([removeSlurOp(id)])}
              ottavas={ottavasHere}
              onottava={(shift) => void handleOttava(shift)}
              onrmottava={(id) => void runOps([removeOttavaOp(id)])}
              ongraceadd={(grace) =>
                void runOps([{ type: 'grace.add', target: selection!.id, payload: grace } as Operation])}
              ongracerm={(id) => void runOps([{ type: 'grace.rm', target: id } as Operation])}
              onsave={handleSave}
              tuplet={tupletOfItem(selection.id)}
              onsettuplet={handleSetTuplet}
              onremovetuplet={handleRemoveTuplet}
              ondeselect={deselect}
              onreload={handleReload}
            />
          {/key}
        {:else if barStructure !== null}
          {#key barStructure.barNumber}
            <StructureInspector
              bar={barStructure}
              {conflict}
              {saving}
              error={saveError}
              onsave={handleStructureSave}
              onaddbar={() => void runOps([{ type: 'bar.add', target: barStructure!.addr }])}
              onrmbar={() => void runOps([{ type: 'bar.rm', target: barStructure!.addr }])}
              onsettext={(beat, text, until) =>
                void runOps([
                  {
                    type: 'text.set',
                    target: `${barStructure!.addr}.beat${beat}`,
                    payload: { text, until: until === null ? null : `bar${until}` },
                  },
                ])}
              onrmtext={(id) => void runOps([{ type: 'text.rm', target: id }])}
              ondeselect={deselect}
              onreload={handleReload}
            />
          {/key}
          {#key `${barStructure.barNumber}:${barSel!.staffIndex}`}
            <NewItem
              barNumber={barStructure.barNumber}
              laneText={laneLabel(score, { staff: barSel!.staffIndex + 1, voice: activeLane.voice })}
              seedPitch={seedPitchFor(staffClef(score, barSel!.staffIndex + 1) ?? 'treble')}
              {saving}
              onnew={(item) => void handleNewItem(item)}
            />
          {/key}
        {:else}
          <p class="inspector-empty">
            Nothing selected. Click a note or a rest to edit it, a bar or its barline to set its
            structure, or the band above a bar to add a chord.
          </p>
          {#if editable}
            <button
              type="button"
              class="add-bar"
              disabled={saving}
              onclick={() => void runOps([{ type: 'bar.add' }])}
            >
              Add a bar at the end
            </button>
          {/if}
        {/if}
      </div>
    </aside>

    <!-- The workspace: just the sheet stage for most charts, and the retained scan beside it for one
         that came from an import (V14b, ADR-0019). The `split` class turns the single stage into a
         two-column review, each side its own scroll and its own zoom. -->
    <div class="workspace" class:split={splitView}>
      {#if splitView && source !== null}
        <SourcePane jobId={source.jobId} imageCount={source.imageCount} />
      {/if}
      <div class="stage" style="--sheet-w: {(SHEET_WIDTH * zoom) / 100}px">
        <div class="stage-inner">
          <div class="stage-bar">
            <span>
              {pages.length} {pages.length === 1 ? 'page' : 'pages'}
              {#if multiLane}· <span class="lane-status" data-testid="active-lane">{laneLabel(score, activeLane)}</span>{/if}
              {#if !editable}· <span class="part-flag">{INSTRUMENTS.find((o) => o.value === instrument)?.label} part</span>{/if}
            </span>
            <!-- The scan toggle lives here — always visible, so it can bring the scan back after it is
                 hidden (the pane itself is gone then). Shown only for a chart that has a scan. -->
            {#if hasSource}
              <button
                type="button"
                class="scan-toggle"
                aria-pressed={showSource}
                onclick={() => (showSource = !showSource)}
              >
                {showSource ? 'Hide scan' : 'Show scan'}
              </button>
              <!-- Re-parse (V14e): re-run OMR on the kept scans into a NEW draft. Shown only for a
                   source-bearing chart, beside the scan toggle. The engine selector is optional — the
                   worker's default until the reader picks one (heuristic on a small host, oemer where
                   RAM allows). -->
              <div class="reparse" role="group" aria-label="Re-parse">
                <select
                  class="reparse-engine"
                  aria-label="Recognition engine"
                  bind:value={reparseEngine}
                  disabled={reparsing}
                >
                  <option value="">default engine</option>
                  {#each REPARSE_ENGINES as engine (engine.value)}
                    <option value={engine.value}>{engine.label}</option>
                  {/each}
                </select>
                <button type="button" class="reparse-btn" disabled={reparsing} onclick={handleReparse}>
                  {reparsing ? 'Re-parsing…' : 'Re-parse'}
                </button>
                {#if reparseError !== null}
                  <span class="reparse-error" role="alert">{reparseError}</span>
                {/if}
              </div>
            {/if}
            <div class="zoom" role="group" aria-label="Zoom">
              <button
                aria-label="Zoom out"
                disabled={zoom <= ZOOM_MIN}
                onclick={() => stepZoom(-ZOOM_STEP)}>−</button
              >
              <span class="val">{zoom}%</span>
              <button
                aria-label="Zoom in"
                disabled={zoom >= ZOOM_MAX}
                onclick={() => stepZoom(ZOOM_STEP)}>+</button
              >
            </div>
          </div>
          <SheetStack
            {pages}
            selection={selectionOverlay}
            rangeSelection={rangeOverlay}
            chordSelection={chordOverlay}
            barSelection={barOverlay}
            addHint={hoverSlot}
            onselect={handleSheetClick}
            onhover={handleSheetHover}
          />
        </div>
      </div>
    </div>
  </section>
{/if}

<style>
  /* Same surface the library's own failure sits on, so a stopped server looks the same wherever
     you were standing when it stopped. */
  .failure {
    max-width: 920px;
    margin: 0 auto;
    padding: 0 46px 120px;
    background: var(--panel);
    border-inline: 1px solid var(--rule);
    min-height: calc(100vh - var(--top-h));
  }

  .score {
    display: grid;
    grid-template-columns: var(--rail-w) 1fr;
    align-items: start;
    min-height: calc(100vh - var(--top-h));
  }

  .rail {
    position: sticky;
    top: var(--top-h);
    align-self: start;
    height: calc(100vh - var(--top-h));
    overflow-y: auto;
    background: var(--panel);
    border-right: 1px solid var(--rule);
    padding: 26px 22px 40px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .rail-title {
    font-family: var(--serif);
    font-size: 24px;
    line-height: 1.15;
    margin: 0;
    font-weight: 400;
    text-wrap: balance;
  }
  .rail-title.untitled {
    font-style: italic;
    color: var(--ink-faint);
  }
  .rail-by {
    font-family: var(--serif);
    font-style: italic;
    font-size: 15px;
    color: var(--ink-soft);
    margin: 5px 0 0;
  }

  .facts {
    display: grid;
    grid-template-columns: 62px 1fr;
    gap: 5px 12px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .facts dt {
    color: var(--ink-faint);
    letter-spacing: 0.06em;
    text-transform: lowercase;
  }
  .facts dd {
    margin: 0;
    color: var(--ink);
  }
  .facts dd.id {
    font-size: 11px;
    color: var(--ink-soft);
    word-break: break-all;
  }

  .group {
    border-top: 1px solid var(--rule);
    padding-top: 15px;
  }
  .group > h3 {
    font-size: 10.5px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0 0 10px;
    font-weight: 600;
  }

  /* the review block carries what the engraving cannot say, in the same words
     `sbscore show` prints (ADR-0009) */
  .review-ok {
    color: var(--ink-soft);
    font-size: 12px;
    margin: 0;
  }
  .review-flag {
    background: var(--flag-wash);
    border-left: 2px solid var(--flag);
    padding: 9px 11px;
    font-size: 12px;
    line-height: 1.55;
  }
  .review-flag .bang {
    color: var(--flag);
    font-weight: 700;
    margin-right: 6px;
  }
  .review-flag .bars {
    display: block;
    margin-top: 6px;
    color: var(--ink-faint);
    font-size: 11px;
    letter-spacing: 0.03em;
  }
  /* An advisory, not a flag: muted, no alarm wash, and separated from the flag block above so it
     reads as a suggestion about layout rather than something that needs fixing (ADR-0013/0019). */
  .review-advisory {
    margin: 8px 0 0;
    color: var(--ink-soft);
    font-size: 12px;
    line-height: 1.55;
  }

  .inspector-empty {
    font-size: 12px;
    color: var(--ink-faint);
    line-height: 1.6;
    margin: 0;
  }

  .add-bar {
    margin-top: 10px;
    font: inherit;
    font-size: 12.5px;
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-soft);
  }
  .add-bar:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink-faint);
  }

  .control-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .control-note {
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.5;
    margin: 0;
  }
  .preview-note {
    color: var(--flag);
  }
  .preview-note b {
    color: var(--ink);
    font-weight: 600;
  }

  /* Transpose (V6e). A key picker and a committing button — deliberately not a segmented control,
     because it is an action that writes, not a render toggle you flip and forget. */
  .footer-text {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 7px 9px;
    font-family: var(--mono);
    font-size: 12px;
    resize: vertical;
    margin-bottom: 8px;
  }
  .meta-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 7px 9px;
    font-size: 12.5px;
    margin-bottom: 8px;
  }
  .meta-input:focus,
  .footer-text:focus {
    border-color: var(--accent);
    outline: none;
  }
  .transpose-row {
    display: flex;
    gap: 8px;
  }
  .key-select,
  .part-select {
    flex: 1;
    min-width: 0;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 7px 9px;
    font-family: var(--mono);
    font-size: 12px;
    cursor: pointer;
  }
  .key-select:focus,
  .part-select:focus {
    border-color: var(--accent);
    outline: none;
  }
  .transpose-btn {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    padding: 7px 12px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .transpose-btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .transpose-btn:disabled {
    background: var(--panel-2);
    color: var(--ink-faint);
    border: 1px solid var(--rule);
    cursor: default;
  }

  .part-flag {
    color: var(--flag);
    font-weight: 600;
  }
  .lane-status {
    color: var(--ink-soft);
    font-weight: 600;
  }

  .export {
    display: block;
    width: 100%;
    text-align: center;
    background: var(--accent);
    border: 0;
    padding: 10px 14px;
    /* Below the format toggle now (V8e); the toggle takes the slot the h3's margin used to give. */
    margin-top: 12px;
    cursor: pointer;
    font-size: 12px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--on-accent);
    text-decoration: none;
  }
  .export:hover {
    filter: brightness(1.08);
  }

  .url {
    font-size: 10.5px;
    color: var(--ink-faint);
    margin: 8px 0 0;
    line-height: 1.6;
  }
  .url span {
    display: block;
  }
  .url .u-path {
    word-break: break-all;
  }
  .url .u-q {
    color: var(--ink-soft);
  }

  /* The right-hand area. For most charts it is just the stage and behaves exactly as before (the
     page body scrolls). For a chart with its scan shown (V14b) it becomes a two-column review: the
     `SourcePane` and the stage side by side, each filling the viewport height and scrolling on its
     own — the two panes read against each other, so neither may scroll or zoom the other. */
  .workspace {
    min-width: 0;
  }
  .workspace.split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    height: calc(100vh - var(--top-h));
  }
  .workspace.split :global(.source-pane) {
    height: 100%;
    border-right: 1px solid var(--rule);
  }
  /* In the split, the stage scrolls inside its own column instead of the body — so the scan column
     and the sheet column move independently (ADR-0019: both scrollable). */
  .workspace.split .stage {
    height: 100%;
    overflow-y: auto;
    padding-top: 22px;
  }

  /* The scan toggle in the stage bar: a quiet text button, since it flips a view and writes nothing. */
  .scan-toggle {
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-soft);
    padding: 4px 10px;
    font-size: 10.5px;
    letter-spacing: 0.05em;
    cursor: pointer;
    text-transform: uppercase;
  }
  .scan-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .scan-toggle[aria-pressed='true'] {
    color: var(--accent);
    border-color: var(--accent);
  }

  /* Re-parse (V14e): the engine picker and its trigger, styled to sit beside the scan toggle. */
  .reparse {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .reparse-engine {
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-soft);
    padding: 3px 6px;
    font-size: 10.5px;
    cursor: pointer;
  }
  .reparse-btn {
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-soft);
    padding: 4px 10px;
    font-size: 10.5px;
    letter-spacing: 0.05em;
    cursor: pointer;
    text-transform: uppercase;
  }
  .reparse-btn:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .reparse-btn:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .reparse-error {
    color: var(--danger, #b00020);
    font-size: 10.5px;
    max-width: 22ch;
  }

  /* The stage scrolls sideways rather than the page body, so zooming past the window width is a
     document-viewer scroll and never a broken layout. */
  .stage {
    --sheet-w: 780px;
    padding: 34px 34px 110px;
    min-width: 0;
    overflow-x: auto;
  }

  .stage-inner {
    width: fit-content;
    min-width: 100%;
    margin-inline: auto;
  }

  .stage-bar {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
    margin-bottom: 18px;
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .zoom button {
    background: none;
    border: 1px solid var(--rule);
    width: 26px;
    height: 24px;
    cursor: pointer;
    color: var(--ink-soft);
    line-height: 1;
  }
  .zoom button:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .zoom button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .zoom .val {
    min-width: 46px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
  }

  @media (max-width: 900px) {
    .score {
      grid-template-columns: 1fr;
    }
    .rail {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--rule);
    }
    .stage {
      padding: 22px 14px 150px;
    }
    /* Too narrow for two columns: stack the scan above the sheet, each scrolling on its own, and let
       the body scroll again rather than pinning both to the viewport height. */
    .workspace.split {
      grid-template-columns: 1fr;
      height: auto;
    }
    .workspace.split :global(.source-pane) {
      height: 70vh;
      border-right: 0;
      border-bottom: 1px solid var(--rule);
    }
    .workspace.split .stage {
      height: auto;
      overflow-y: visible;
    }
  }
</style>
