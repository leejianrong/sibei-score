import type {
  Annotation,
  Bar,
  BarItem,
  Chord,
  Duration,
  EndBarline,
  Ending,
  IdFactory,
  Note,
  Rest,
  StartBarline,
  Tuplet,
} from '@sibei/model';
import { durationTicks, makeAnnotation, makeBar, makeChord, makeNote, makeRest } from '@sibei/model';

/**
 * Fixture-authoring sugar. Bars are written as a sequence and onsets fall out of the
 * durations, so a fixture reads like the music rather than like arithmetic.
 */

export interface BarSpec {
  number: number;
  startBarline?: StartBarline;
  endBarline?: EndBarline;
  ending?: Ending | null;
}

type Entry =
  | { kind: 'note'; pitch: string; duration: Duration; tie?: Note['tie'] }
  | { kind: 'rest'; duration: Duration }
  | { kind: 'tuplet'; actual: number; normal: number; entries: Entry[] };

export class BarBuilder {
  private readonly entries: Entry[] = [];
  private readonly chords: Chord[] = [];
  private readonly annotations: Annotation[] = [];

  constructor(
    private readonly ids: IdFactory,
    private readonly spec: BarSpec,
  ) {}

  note(pitch: string, duration: Duration, tie?: Note['tie']): this {
    this.entries.push({ kind: 'note', pitch, duration, ...(tie === undefined ? {} : { tie }) });
    return this;
  }

  rest(duration: Duration): this {
    this.entries.push({ kind: 'rest', duration });
    return this;
  }

  /** A triplet is `tuplet(3, 2, b => b.note(...).note(...).note(...))`. */
  tuplet(actual: number, normal: number, build: (bar: BarBuilder) => void): this {
    const inner = new BarBuilder(this.ids, this.spec);
    build(inner);
    this.entries.push({ kind: 'tuplet', actual, normal, entries: inner.entries });
    return this;
  }

  /** A chord symbol at a beat position, as `Ebm7@1` is written (ADR-0007). */
  chord(beat: number, text: string, beatTicks: number): this {
    this.chords.push(
      makeChord({ id: this.ids.next('chord'), onset: (beat - 1) * beatTicks, text }),
    );
    return this;
  }

  /** Non-chord text found in the chord band, kept and flagged rather than dropped (Q56). */
  annotation(beat: number, text: string, beatTicks: number): this {
    this.annotations.push(
      makeAnnotation({
        id: this.ids.next('annotation'),
        onset: (beat - 1) * beatTicks,
        text,
        review: { flagged: true, reasons: ['unrecognised-text'] },
      }),
    );
    return this;
  }

  build(): Bar {
    const items: BarItem[] = [];
    const tuplets: Tuplet[] = [];
    let cursor = 0;

    const emit = (entry: Entry, scale: number): void => {
      if (entry.kind === 'tuplet') {
        const memberIds: string[] = [];
        const inner = scale * (entry.normal / entry.actual);
        for (const member of entry.entries) {
          const before = items.length;
          emit(member, inner);
          const created = items[before];
          if (created !== undefined) memberIds.push(created.id);
        }
        tuplets.push({ id: this.ids.next('tuplet'), actual: entry.actual, normal: entry.normal, memberIds });
        return;
      }

      const occupied = durationTicks(entry.duration) * scale;
      if (entry.kind === 'note') {
        const note: Note = makeNote({
          id: this.ids.next('note'),
          onset: cursor,
          duration: entry.duration,
          pitch: entry.pitch,
          ...(entry.tie === undefined ? {} : { tie: entry.tie }),
        });
        items.push(note);
      } else {
        const rest: Rest = makeRest({
          id: this.ids.next('rest'),
          onset: cursor,
          duration: entry.duration,
        });
        items.push(rest);
      }
      cursor += occupied;
    };

    for (const entry of this.entries) emit(entry, 1);

    return makeBar({
      id: this.ids.next('bar'),
      number: this.spec.number,
      items,
      tuplets,
      chords: this.chords,
      annotations: this.annotations,
      ...(this.spec.startBarline === undefined ? {} : { startBarline: this.spec.startBarline }),
      ...(this.spec.endBarline === undefined ? {} : { endBarline: this.spec.endBarline }),
      ...(this.spec.ending === undefined ? {} : { ending: this.spec.ending }),
    });
  }
}
