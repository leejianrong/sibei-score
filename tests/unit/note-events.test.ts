import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoteEventsError, parseNoteEvents } from '@sibei/model';

const DIR = join(__dirname, '..', 'fixtures', 'note-events');
const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const load = (name: string): Record<string, any> => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

function refusal(raw: unknown): NoteEventsError {
  try {
    parseNoteEvents(raw);
  } catch (e) {
    if (e instanceof NoteEventsError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('NoteEvents v1 validation (ADR-0040)', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThanOrEqual(4));

  it.each(fixtures)('%s validates', (name) => {
    const doc = parseNoteEvents(load(name));
    expect(doc.schema_version).toBe(1);
    expect(doc.notes.length).toBeGreaterThan(0);
  });

  it('rejects an unknown major with its own kind', () => {
    const e = refusal({ ...load('voice-ode-beats.json'), schema_version: 2 });
    expect(e.kind).toBe('unsupported-version');
    expect(e.problems[0]).toContain('schema_version');
  });

  it('reads an absent schema_version as 1', () => {
    const { schema_version: _drop, ...rest } = load('voice-ode-beats.json');
    expect(parseNoteEvents(rest).schema_version).toBe(1);
  });

  it('defaults beats, notes and warnings to empty', () => {
    const { beats: _b, notes: _n, warnings: _w, ...rest } = load('voice-ode-beats.json');
    const doc = parseNoteEvents(rest);
    expect([doc.beats, doc.notes, doc.warnings]).toEqual([[], [], []]);
  });

  it('names the failing field', () => {
    const raw = load('voice-ode-beats.json');
    raw.notes[3].onset_s = -1;
    raw.notes[4].pitch = 128;
    raw.notes[5].confidence = 1.5;
    raw.beats[1].t_s = 'x';
    raw.source.sha256 = 'abc';
    const e = refusal(raw);
    expect(e.kind).toBe('malformed');
    const text = e.problems.join('\n');
    for (const field of ['notes[3].onset_s', 'notes[4].pitch', 'notes[5].confidence', 'beats[1].t_s', 'source.sha256']) {
      expect(text).toContain(field);
    }
  });

  it('rejects unknown fields (one repo is ahead of the other)', () => {
    const raw = load('voice-ode-beats.json');
    raw.notes[0].swing = 0.5;
    raw.extra = true;
    const text = refusal(raw).problems.join('\n');
    expect(text).toContain('notes[0].swing');
    expect(text).toContain('extra');
  });

  it('rejects a bad instrument and a non-object', () => {
    expect(refusal({ ...load('voice-ode-beats.json'), instrument: 'kazoo' }).problems[0]).toContain('instrument');
    expect(refusal([]).kind).toBe('malformed');
    expect(refusal(null).kind).toBe('malformed');
  });
});
