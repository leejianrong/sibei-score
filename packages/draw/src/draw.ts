import type { LayoutBar, LayoutBarItem, LayoutResult, LayoutSystem, LayoutTie } from '@sibei/layout';
import { LAYOUT_BAR_ITEM_KINDS } from '@sibei/layout';
import type { Id } from '@sibei/model';
import {
  Accidental,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Tuplet,
  Voice,
  Volta,
} from 'vexflow';
import type { SVGContext } from 'vexflow';
import { buildChordSymbol, buildTextSymbol } from './chord-symbol.js';
import { appendHeaderText, appendText } from './text.js';
import {
  VEX_SPACE_ABOVE_STAFF_LN,
  VEX_STAFF_LINE_SPACING,
  vexAccidental,
  vexBeamGroups,
  vexDuration,
  vexEndBarline,
  vexKey,
  vexKeySignature,
  vexRestKey,
  vexStartBarline,
  vexTimeSignature,
} from './vex.js';

/**
 * The draw adapter (ADR-0014). It consumes layout positions and emits glyphs, and it
 * makes no layout decisions: every x, every width and every line break arrives
 * already decided. What it does own is engraving inside a bar box — stem direction,
 * beam grouping, accidental stacking, tie curves — which is what VexFlow is here for.
 */

/** Every item kind this adapter handles. Asserted against the contract, not assumed. */
export const HANDLED_ITEM_KINDS: readonly LayoutBarItem['kind'][] = LAYOUT_BAR_ITEM_KINDS;

const BLACK = '#000000';

/**
 * Extra lift for a rehearsal letter, in units. VexFlow places a section 1.5 staff
 * lines above the stave's top-text line, which layout has already lifted clear of the
 * notes; this clears the chord text that sits on that line.
 */
const REHEARSAL_MARK_LIFT = -8;

export interface DrawOptions {
  /** Chord symbol font size, in layout units. */
  chordFontSize: number;
  barNumberFontSize: number;
  rehearsalFontSize: number;
}

const DEFAULT_OPTIONS: DrawOptions = {
  chordFontSize: 14,
  barNumberFontSize: 11,
  rehearsalFontSize: 13,
};

export interface DrawResult {
  svg: SVGSVGElement;
  /** Note id to the drawn note, so V4 can hit-test the SVG. */
  notes: Map<Id, StaveNote>;
}

export function drawPage(
  result: LayoutResult,
  pageIndex: number,
  host: HTMLDivElement,
  options: Partial<DrawOptions> = {},
): DrawResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const page = result.pages[pageIndex];
  if (page === undefined) throw new Error(`no such page: ${pageIndex}`);

  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(page.width, page.height);
  const context = renderer.getContext() as SVGContext;

  // Layout works in units; the page is paper. The viewBox is the whole conversion,
  // so the same SVG is correct on screen and at print size.
  const svg = context.svg;
  svg.setAttribute('viewBox', `0 0 ${page.width} ${page.height}`);
  svg.setAttribute('width', `${page.widthPt}pt`);
  svg.setAttribute('height', `${page.heightPt}pt`);

  for (const text of page.header) appendHeaderText(svg, text);

  const notes = new Map<Id, StaveNote>();
  for (const system of page.systems) {
    drawSystem(context, svg, result, system, notes, opts);
  }

  return { svg, notes };
}

function drawSystem(
  context: SVGContext,
  svg: SVGSVGElement,
  result: LayoutResult,
  system: LayoutSystem,
  notes: Map<Id, StaveNote>,
  options: DrawOptions,
): void {
  const staveY = system.staveY - VEX_SPACE_ABOVE_STAFF_LN * VEX_STAFF_LINE_SPACING;
  // Layout has decided where the chord baseline goes. VexFlow expresses that as the
  // stave's top-text position, measured in staff lines above the top line.
  const topTextPosition = system.chordBaselineOffset / VEX_STAFF_LINE_SPACING;

  for (const [index, bar] of system.bars.entries()) {
    drawBar(context, svg, result, bar, staveY, topTextPosition, index === 0, notes, options);
  }

  for (const tie of system.ties) drawTie(context, tie, notes);
}

function drawBar(
  context: SVGContext,
  svg: SVGSVGElement,
  result: LayoutResult,
  bar: LayoutBar,
  staveY: number,
  topTextPosition: number,
  isFirstOfSystem: boolean,
  notes: Map<Id, StaveNote>,
  options: DrawOptions,
): void {
  const stave = new Stave(bar.x, staveY, bar.width, {
    // VexFlow's default staff line is grey, which is wrong on paper.
    fill_style: BLACK,
    // Only the head of a system gets an opening line; elsewhere the previous bar's
    // end barline is the junction, and two lines at one x would double it up.
    left_bar: isFirstOfSystem,
    top_text_position: topTextPosition,
  });
  stave.setDefaultLedgerLineStyle({ strokeStyle: BLACK, lineWidth: 1.4 });

  const staveNotes: StaveNote[] = [];
  const tupletsById = new Map<Id, StaveNote[]>();
  const bracketsById = new Map<Id, { actual: number; normal: number }>();
  const byItemId = new Map<Id, StaveNote>();
  const chords: { anchorItemId: Id | null; text: string; isChord: boolean }[] = [];
  let barNumber: string | null = null;

  for (const item of bar.items) {
    switch (item.kind) {
      case 'clef':
        stave.addClef(item.clef);
        break;

      case 'keySignature':
        stave.addKeySignature(vexKeySignature(item.key));
        break;

      case 'timeSignature':
        stave.addTimeSignature(vexTimeSignature(item.time));
        break;

      case 'barNumber':
        barNumber = item.text;
        break;

      case 'rehearsalMark':
        // VexFlow already places a section above the stave's top-text line, which
        // layout has lifted clear of the notes. This clears the chord text as well.
        stave.setSection(item.text, REHEARSAL_MARK_LIFT, 0, options.rehearsalFontSize, true);
        break;

      case 'barline':
        stave.setBegBarType(vexStartBarline(item.barline));
        break;

      case 'endBarline':
        stave.setEndBarType(vexEndBarline(item.barline));
        break;

      case 'ending':
        stave.setVoltaType(voltaType(item.role), item.numbers.join(', '), -8);
        break;

      case 'note': {
        const note = new StaveNote({
          keys: [vexKey(item.pitch)],
          duration: vexDurationWithDots(item.duration),
          auto_stem: true,
        });
        for (let dot = 0; dot < item.duration.dots; dot += 1) {
          Dot.buildAndAttach([note], { all: true });
        }
        if (item.accidentalGlyph !== null) {
          note.addModifier(new Accidental(vexAccidental(item.accidentalGlyph)), 0);
        }
        staveNotes.push(note);
        byItemId.set(item.noteId, note);
        notes.set(item.noteId, note);
        if (item.tupletId !== null) {
          collect(tupletsById, item.tupletId, note);
        }
        break;
      }

      case 'rest': {
        const rest = new StaveNote({
          keys: [vexRestKey(item.duration)],
          duration: `${vexDurationWithDots(item.duration)}r`,
        });
        for (let dot = 0; dot < item.duration.dots; dot += 1) {
          Dot.buildAndAttach([rest], { all: true });
        }
        staveNotes.push(rest);
        byItemId.set(item.restId, rest);
        if (item.tupletId !== null) {
          collect(tupletsById, item.tupletId, rest);
        }
        break;
      }

      case 'chordSymbol':
        chords.push({ anchorItemId: item.anchorItemId, text: item.text, isChord: true });
        break;

      case 'annotation':
        chords.push({ anchorItemId: item.anchorItemId, text: item.text, isChord: false });
        break;

      case 'tupletBracket':
        bracketsById.set(item.tupletId, { actual: item.actual, normal: item.normal });
        break;

      default:
        return exhausted(item);
    }
  }

  // Chord symbols are note modifiers, so they must be attached before formatting:
  // they change how much room a note needs.
  for (const chord of chords) {
    const anchor = chord.anchorItemId === null ? undefined : byItemId.get(chord.anchorItemId);
    const target = anchor ?? staveNotes[0];
    if (target === undefined) continue;
    const build = chord.isChord ? buildChordSymbol : buildTextSymbol;
    target.addModifier(build(chord.text, { fontSize: options.chordFontSize }), 0);
  }

  // Tuplets rescale their members' ticks, so they are built before the formatter runs.
  const tuplets: Tuplet[] = [];
  for (const [tupletId, members] of tupletsById) {
    const ratio = bracketsById.get(tupletId);
    if (ratio === undefined || members.length === 0) continue;
    tuplets.push(
      new Tuplet(members, {
        num_notes: ratio.actual,
        notes_occupied: ratio.normal,
        bracketed: true,
        ratioed: false,
      }),
    );
  }

  stave.setContext(context).draw();
  if (barNumber !== null) {
    appendText(svg, {
      text: barNumber,
      x: bar.x + 2,
      y: staveY + VEX_SPACE_ABOVE_STAFF_LN * VEX_STAFF_LINE_SPACING - 6,
      size: options.barNumberFontSize,
      align: 'left',
      family: 'Times New Roman, serif',
      weight: 'normal',
      style: 'normal',
    });
  }

  if (staveNotes.length > 0) {
    const voice = new Voice({
      num_beats: result.time.beats,
      beat_value: result.time.beatValue,
    })
      // A metrically invalid bar is stored, flagged, and drawn as written (ADR-0013).
      .setStrict(false)
      .addTickables(staveNotes);

    voice.setStave(stave);

    // Beams are built before the notes are formatted or drawn, and the order is
    // load-bearing twice over. A note decides at draw time whether to draw its own
    // flag by asking whether it belongs to a beam, so a beam built afterwards leaves
    // the flag already drawn underneath it. And beaming settles stem direction and
    // length for the whole group, which the formatter needs to space the bar.
    const beams = Beam.applyAndGetBeams(voice, undefined, vexBeamGroups(result.time));

    new Formatter().joinVoices([voice]).formatToStave([voice], stave);
    voice.draw(context, stave);

    for (const beam of beams) {
      beam.setContext(context).draw();
    }
    for (const tuplet of tuplets) {
      tuplet.setContext(context).draw();
    }
  }

}

function drawTie(context: SVGContext, tie: LayoutTie, notes: Map<Id, StaveNote>): void {
  const first = tie.fromNoteId === null ? undefined : notes.get(tie.fromNoteId);
  const last = tie.toNoteId === null ? undefined : notes.get(tie.toNoteId);
  if (first === undefined && last === undefined) return;

  // A half-tie — one endpoint missing — is how a tie crosses a system break.
  const staveTie = new StaveTie({
    ...(first === undefined ? {} : { first_note: first, first_indices: [0] }),
    ...(last === undefined ? {} : { last_note: last, last_indices: [0] }),
  });
  staveTie.setContext(context).draw();
}

function vexDurationWithDots(duration: { value: number; dots: number }): string {
  return `${vexDuration(duration as Parameters<typeof vexDuration>[0])}${'d'.repeat(duration.dots)}`;
}

function voltaType(role: 'start' | 'continue' | 'stop' | 'start-stop'): number {
  switch (role) {
    case 'start':
      return Volta.type.BEGIN;
    case 'continue':
      return Volta.type.MID;
    case 'stop':
      return Volta.type.END;
    case 'start-stop':
      return Volta.type.BEGIN_END;
  }
}

function collect<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

/** Makes an unhandled item kind a compile error, not a silently dropped glyph. */
function exhausted(item: never): never {
  throw new Error(`unhandled layout item kind: ${JSON.stringify(item)}`);
}
