import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_QUARTER, barCapacity, parseNoteEvents, quantizeNoteEvents, type NoteEvents } from '@sibei/model';

const load = (name: string): NoteEvents =>
  parseNoteEvents(JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'note-events', name), 'utf8')));

const sum = (items: { ticks: number }[]): number => items.reduce((s, i) => s + i.ticks, 0);
const Q = TICKS_PER_QUARTER;

/** A bare document: notes as [onsetS, offsetS, pitch]. */
function doc(notes: Array<[number, number, number]>, beats: NoteEvents['beats'] = []): NoteEvents {
  return {
    schema_version: 1,
    source: { sha256: 'a'.repeat(64), duration_s: 20 },
    instrument: 'voice',
    producer: { model_id: 't', model_version: '0', stage: 'transcribe' },
    beats,
    notes: notes.map(([on, off, pitch], i) => ({ id: `n${i}`, onset_s: on, offset_s: off, pitch, confidence: 0.9 })),
    warnings: [],
  };
}
const beatsAt = (spb: number, count: number, from = 0): NoteEvents['beats'] =>
  Array.from({ length: count }, (_, i) => ({ t_s: from + i * spb, is_downbeat: i % 4 === 0 }));

describe('quantizeNoteEvents (ADR-0040)', () => {
  it('turns the Ode to Joy fixture into four exact 4/4 bars', () => {
    const r = quantizeNoteEvents(load('voice-ode-beats.json'));
    expect(r.time).toEqual({ beats: 4, beatValue: 4 });
    expect(r.bars.map((b) => b.number)).toEqual([1, 2, 3, 4]);
    for (const bar of r.bars) expect(sum(bar.items)).toBe(barCapacity(r.time));
    expect(r.bars[0]!.items.map((i) => [i.midi, i.ticks])).toEqual([[64, Q], [64, Q], [65, Q], [67, Q]]);
    expect(r.bars[3]!.items.map((i) => [i.midi, i.onset, i.ticks])).toEqual([
      [64, 0, 3 * (Q / 2)],
      [62, 3 * (Q / 2), Q / 2],
      [62, 2 * Q, 2 * Q],
    ]);
    expect(r.tempoBpm).toBeCloseTo(120, 0);
  });

  it('quantizes the walking-bass fixture into exact bars', () => {
    const r = quantizeNoteEvents(load('bass-walking-beats.json'));
    expect(r.bars).toHaveLength(4);
    for (const bar of r.bars) {
      expect(sum(bar.items)).toBe(barCapacity(r.time));
      expect(bar.items.every((i) => i.kind === 'note' && i.ticks === Q)).toBe(true);
    }
  });

  it('still drafts a melody with no beat grid, and says so', () => {
    const r = quantizeNoteEvents(load('voice-twinkle-no-beats.json'));
    expect(r.warnings.map((w) => w.code)).toContain('no-beat-grid');
    expect(r.bars).toHaveLength(4);
    for (const bar of r.bars) expect(sum(bar.items)).toBe(barCapacity(r.time));
    expect(r.bars[0]!.items.map((i) => i.midi)).toEqual([60, 60, 67, 67]);
    expect(r.tempoBpm).toBeGreaterThan(90);
    expect(r.tempoBpm).toBeLessThan(102);
  });

  it('is deterministic', () => {
    for (const f of ['voice-ode-beats.json', 'bass-walking-beats.json', 'voice-twinkle-no-beats.json']) {
      expect(quantizeNoteEvents(load(f))).toEqual(quantizeNoteEvents(load(f)));
    }
  });

  it('fills gaps with rests', () => {
    // 120 bpm; a quarter on beat 1, then beat 3 (a quarter rest... a half rest gap of one beat).
    const r = quantizeNoteEvents(doc([[0, 0.45, 60], [1.0, 1.45, 62]], beatsAt(0.5, 8)));
    expect(r.bars[0]!.items.map((i) => [i.kind, i.onset, i.ticks])).toEqual([
      ['note', 0, Q],
      ['rest', Q, Q],
      ['note', 2 * Q, Q],
      ['rest', 3 * Q, Q],
    ]);
  });

  it('splits a note across the bar line and ties it', () => {
    // a note from beat 4 of bar 1 for two beats
    const r = quantizeNoteEvents(doc([[1.5, 2.45, 60]], beatsAt(0.5, 8)));
    const [a, b] = r.bars;
    const tail = a!.items[a!.items.length - 1]!;
    expect(tail).toMatchObject({ kind: 'note', onset: 3 * Q, ticks: Q, tiedToNext: true });
    expect(b!.items[0]).toMatchObject({ kind: 'note', onset: 0, ticks: Q, tiedFromPrevious: true });
    expect(sum(a!.items)).toBe(4 * Q);
    expect(sum(b!.items)).toBe(4 * Q);
  });

  it('makes a pickup bar 0 when notes precede the first downbeat', () => {
    // two pickup eighths... one beat early, beats start at t=0.5 with a downbeat on beat index 1
    const beats = beatsAt(0.5, 10).map((b, i) => ({ ...b, is_downbeat: i >= 1 && (i - 1) % 4 === 0 }));
    const r = quantizeNoteEvents(doc([[0, 0.45, 55], [0.5, 0.95, 60]], beats));
    expect(r.bars.map((b) => b.number)).toEqual([0, 1]);
    expect(r.bars[0]!.items).toHaveLength(1);
    expect(r.bars[0]!.items[0]).toMatchObject({ onset: 0, ticks: Q, midi: 55 });
    expect(sum(r.bars[1]!.items)).toBe(4 * Q);
  });

  it('infers 3/4 from the downbeat spacing', () => {
    const beats = Array.from({ length: 12 }, (_, i) => ({ t_s: i * 0.5, is_downbeat: i % 3 === 0 }));
    const r = quantizeNoteEvents(doc([[0, 0.45, 60], [0.5, 0.95, 62], [1.0, 1.45, 64]], beats));
    expect(r.time).toEqual({ beats: 3, beatValue: 4 });
    expect(r.bars).toHaveLength(1);
    expect(sum(r.bars[0]!.items)).toBe(3 * Q);
  });

  it('assumes 4/4 and warns when the grid marks no downbeats', () => {
    const beats = beatsAt(0.5, 8).map((b) => ({ t_s: b.t_s }));
    const r = quantizeNoteEvents(doc([[0, 0.45, 60]], beats));
    expect(r.warnings.map((w) => w.code)).toEqual(['no-downbeats']);
  });

  it('starts bar 1 at the first note when every downbeat is null (real transcriber output)', () => {
    // beats from 0; first note on beat index 3 -> bar 1 begins there, not at beat 0
    const beats = beatsAt(0.5, 16).map((b) => ({ t_s: b.t_s, is_downbeat: null }));
    const r = quantizeNoteEvents(doc([[1.5, 1.95, 60], [2.0, 2.45, 62]], beats));
    expect(r.bars[0]!.number).toBe(1);
    expect(r.bars[0]!.items[0]).toMatchObject({ kind: 'note', onset: 0 });
    expect(r.warnings.map((w) => w.code)).toContain('no-downbeats');
  });

  it('copes with the audio repo fixtures (null downbeats, silence)', () => {
    const bass = load('valid_bass_line.json');
    for (const b of bass.beats) b.is_downbeat = null;
    const r = quantizeNoteEvents(bass);
    expect(r.bars.length).toBeGreaterThan(0);
    for (const bar of r.bars) expect(sum(bar.items)).toBe(4 * Q);
    const silent = quantizeNoteEvents(load('valid_silent_voice.json'));
    expect(silent.bars).toEqual([]);
  });

  it('survives heavy onset jitter and soft-attack lateness', () => {
    // 100 bpm, eighth notes, onsets jittered +-45 ms (about +-0.07 beat) by a fixed pattern
    const spb = 0.6;
    const jit = [0.03, -0.04, 0.045, -0.02, 0.01, 0.04, -0.045, 0.02];
    const notes = Array.from({ length: 16 }, (_, i): [number, number, number] => {
      const on = Math.max(0, i * spb / 2 + jit[i % 8]!);
      return [on, i * spb / 2 + spb * 0.45, 60 + (i % 4)];
    });
    const r = quantizeNoteEvents(doc(notes, beatsAt(spb, 12)));
    for (const bar of r.bars) {
      expect(sum(bar.items)).toBe(4 * Q);
      expect(bar.items.filter((i) => i.kind === 'note').map((i) => i.ticks)).toEqual(Array(8).fill(Q / 2));
    }
  });

  it('keeps one line: truncates an overlap, keeps the more confident of a collision', () => {
    const over = quantizeNoteEvents(doc([[0, 1.2, 60], [0.5, 0.95, 62]], beatsAt(0.5, 8)));
    expect(over.warnings.map((w) => w.code)).toContain('overlap');
    expect(over.bars[0]!.items[0]).toMatchObject({ midi: 60, ticks: Q });

    const twin = doc([[0, 0.4, 60], [0.02, 0.4, 61]], beatsAt(0.5, 8));
    twin.notes[1]!.confidence = 0.95;
    const hit = quantizeNoteEvents(twin);
    expect(hit.warnings.map((w) => w.code)).toContain('collapsed-onset');
    expect(hit.bars[0]!.items[0]!.midi).toBe(61);
  });

  it('trims leading silence to the bar of the first note', () => {
    const r = quantizeNoteEvents(doc([[4.0, 4.45, 60]], beatsAt(0.5, 16)));
    expect(r.bars.map((b) => b.number)).toEqual([1]);
    expect(r.bars[0]!.items[0]).toMatchObject({ kind: 'note', onset: 0 });
  });

  it('returns no bars and a warning for no notes', () => {
    const r = quantizeNoteEvents(doc([]));
    expect(r.bars).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain('no-notes');
  });

  it('follows a drifting tempo through the beat grid', () => {
    // beats stretch from 0.5 to 0.6 s apart; notes sit on every beat
    const beats: NoteEvents['beats'] = [];
    let t = 0;
    for (let i = 0; i < 16; i++) {
      beats.push({ t_s: t, is_downbeat: i % 4 === 0 });
      t += 0.5 + i * 0.007;
    }
    const notes = beats
      .slice(0, 12)
      .map((b, i): [number, number, number] => [b.t_s, beats[i + 1]!.t_s - 0.02, 60 + (i % 5)]);
    const r = quantizeNoteEvents(doc(notes, beats));
    for (const bar of r.bars) {
      expect(bar.items.map((i) => [i.kind, i.ticks])).toEqual(Array(4).fill(['note', Q]));
      expect(sum(bar.items)).toBe(4 * Q);
    }
  });

  describe('heavy timing jitter (SIB2-196)', () => {
    // 120 bpm: a beat is 0.5 s, an eighth 0.25 s, a sixteenth 0.125 s.
    const pitches = [60, 62, 64, 65, 67, 65, 64, 62];
    const eighths = (shift: (k: number) => number): Array<[number, number, number]> =>
      Array.from({ length: 16 }, (_, k): [number, number, number] => [
        k * 0.25 + shift(k),
        k * 0.25 + 0.23,
        pitches[k % pitches.length]!,
      ]);

    it('snaps soft-attack late onsets to the eighth they were played on', () => {
      // Every onset is 40 ms late and wobbles +-30 ms: the late wobbles land past the halfway point to the
      // next sixteenth (70 ms > 62.5 ms) and nearest-point snapping would move them a whole step.
      const r = quantizeNoteEvents(doc(eighths((k) => 0.04 + (k % 2 === 0 ? -0.03 : 0.03)), beatsAt(0.5, 12)));
      const onsets = r.bars.flatMap((b) => b.items.filter((i) => i.kind === 'note').map((i) => i.onset));
      expect(onsets.length).toBe(16);
      for (const onset of onsets) expect(onset % (Q / 2)).toBe(0);
    });

    it('reads a one-step silence in a smeared clip as legato, not a sixteenth rest', () => {
      const r = quantizeNoteEvents(doc(eighths((k) => 0.04 + (k % 2 === 0 ? -0.03 : 0.03)).map(([on, off, p]) => [on, off - 0.06, p]), beatsAt(0.5, 12)));
      // (the last note has no successor, so only the closing bar-fill may be a rest)
      const items = r.bars.flatMap((b) => b.items);
      expect(items.slice(0, -1).filter((i) => i.kind === 'rest')).toEqual([]);
    });

    it('keeps the same sixteenth rest when the clip is exact', () => {
      // A quarter that sounds a sixteenth short, then a note: a real rest in a rendered clip.
      const r = quantizeNoteEvents(doc([[0, 0.375, 60], [0.5, 0.95, 62], [1, 1.45, 64], [1.5, 1.95, 65]], beatsAt(0.5, 12)));
      expect(r.bars[0]!.items.map((i) => i.kind)).toContain('rest');
    });

    it('merges a held note the transcriber cut in two, in a performed clip', () => {
      // A half note on 67 split into two low-confidence halves 20 ms apart, among jittered eighths.
      const base = eighths((k) => (k % 2 === 0 ? -0.03 : 0.03));
      const events = doc(base, beatsAt(0.5, 12));
      const held = events.notes[4]!; // 67 at 1.0 s
      events.notes.splice(
        4,
        1,
        { ...held, id: 'a', offset_s: 1.115, confidence: 0.55 },
        { ...held, id: 'b', onset_s: 1.135, offset_s: 1.23, confidence: 0.55 },
      );
      const r = quantizeNoteEvents(events);
      const notes = r.bars.flatMap((b) => b.items.filter((i) => i.kind === 'note'));
      expect(notes.length).toBe(16);
      expect(notes.map((i) => i.sourceId)).not.toContain('b');
    });

    it('does not merge a confident repeated note', () => {
      const base = eighths((k) => (k % 2 === 0 ? -0.03 : 0.03));
      const events = doc(base, beatsAt(0.5, 12));
      // Note 5 repeats note 4's pitch right after it, as confidently as everything else.
      events.notes[5] = { ...events.notes[5]!, pitch: events.notes[4]!.pitch };
      const r = quantizeNoteEvents(events);
      expect(r.bars.flatMap((b) => b.items.filter((i) => i.kind === 'note')).length).toBe(16);
    });

    it('is deterministic', () => {
      const events = doc(eighths((k) => 0.04 + (k % 2 === 0 ? -0.03 : 0.03)), beatsAt(0.5, 12));
      expect(quantizeNoteEvents(events)).toEqual(quantizeNoteEvents(structuredClone(events)));
    });
  });
});
