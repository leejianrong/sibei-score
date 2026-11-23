import { describe, expect, it } from 'vitest';
import { writtenPart } from '@sibei/api';
import { allStaves, barViews, formatKeySignature, formatPitch } from '@sibei/model';
import type { Score } from '@sibei/model';
import { FIXTURE_REGISTRY } from '@sibei/fixtures';

/**
 * ADR-0041 slice 5a (SIB2-229): `writtenPart` is a view of the whole score. Every staff and voice moves, the
 * chord lane moves once, a percussion staff never moves, and a part that carries its own transposition is
 * already an instrument's part.
 */

const build = (name: string): Score => (FIXTURE_REGISTRY[name] as () => Score)();

const pitches = (score: Score, staff: string, voice = 1): string[] =>
  barViews(score, { staff, voice }).flatMap((bar) => bar.items.flatMap((item) => (item.kind === 'note' ? [formatPitch(item.pitch)] : [])));

describe('writtenPart on a multi-staff score', () => {
  it('moves every staff and voice by the instrument, and the chords once', () => {
    const concert = build('grand-staff');
    const written = writtenPart(concert, 'bb-trumpet');
    for (const staff of allStaves(concert)) {
      const before = pitches(concert, staff.id);
      const after = pitches(written, staff.id);
      expect(after).toHaveLength(before.length);
      expect(after).not.toEqual(before);
    }
    expect(formatKeySignature(written.meta.key)).not.toBe(formatKeySignature(concert.meta.key));
    // Cmaj7 to a trumpet is Dmaj7: transposed once, not once per staff.
    expect(written.harmony[0]?.chords[0]?.text).toBe('Dmaj7');
    expect(written.harmony[0]?.chords).toHaveLength(concert.harmony[0]?.chords.length ?? -1);
  });

  it('moves a second voice too', () => {
    const concert = build('two-voice');
    const written = writtenPart(concert, 'eb-alto');
    const staff = allStaves(concert)[0]!.id;
    expect(pitches(written, staff, 2)).not.toEqual(pitches(concert, staff, 2));
    expect(pitches(written, staff, 2)).toHaveLength(pitches(concert, staff, 2).length);
  });

  it('leaves a percussion staff where it is', () => {
    const concert = build('full-band');
    const written = writtenPart(concert, 'bb-trumpet');
    const drums = allStaves(concert).find((staff) => staff.type === 'percussion')!;
    expect(pitches(written, drums.id)).toEqual(pitches(concert, drums.id));
  });

  it('is the identity for concert, and leaves the stored score alone', () => {
    const concert = build('full-band');
    const before = JSON.stringify(concert);
    expect(writtenPart(concert, 'concert')).toBe(concert);
    writtenPart(concert, 'eb-alto');
    expect(JSON.stringify(concert)).toBe(before);
  });
});

describe('a part with its own transposition', () => {
  it('moves by its own interval, not the requested instrument, and comes back applied', () => {
    const concert = build('lead-bass');
    const lead = concert.parts[0]!;
    const withTranspose: Score = {
      ...concert,
      parts: [{ ...lead, transposition: 9 }, ...concert.parts.slice(1)], // an Eb alto's own part
    };
    const asTrumpet = writtenPart(withTranspose, 'bb-trumpet');
    const alone = writtenPart({ ...withTranspose, parts: [{ ...lead, transposition: 0 }, ...concert.parts.slice(1)] }, 'eb-alto');
    const leadStaff = lead.staves[0]!.id;
    const bassStaff = concert.parts[1]!.staves[0]!.id;
    // The lead moved a major sixth (its own), as an alto part would; the bass moved a major second (the trumpet's).
    expect(pitches(asTrumpet, leadStaff)).toEqual(pitches(alone, leadStaff));
    expect(pitches(asTrumpet, bassStaff)).toEqual(pitches(writtenPart(concert, 'bb-trumpet'), bassStaff));
    expect(asTrumpet.parts.map((part) => part.transposition)).toEqual([0, 0]);
  });
});

describe('printing a part at its own written pitch (SIB2-239)', () => {
  const trumpetAndBass = (): Score => {
    const concert = build('lead-bass');
    return { ...concert, parts: [{ ...concert.parts[0]!, transposition: 2 }, ...concert.parts.slice(1)] };
  };

  it('is the concert score, untouched, unless asked', () => {
    const score = trumpetAndBass();
    expect(writtenPart(score, 'concert')).toBe(score);
    expect(writtenPart(score, 'concert', { ownParts: false })).toBe(score);
  });

  it('moves only the transposing part, and leaves chords, key and the other staff at concert', () => {
    const score = trumpetAndBass();
    const written = writtenPart(score, 'concert', { ownParts: true });
    const lead = score.parts[0]!.staves[0]!.id;
    const bass = score.parts[1]!.staves[0]!.id;
    expect(pitches(written, lead)).not.toEqual(pitches(score, lead));
    expect(pitches(written, bass)).toEqual(pitches(score, bass));
    expect(written.meta.key).toEqual(score.meta.key);
    expect(written.harmony).toEqual(score.harmony);
    expect(written.parts.map((part) => part.transposition)).toEqual([0, 0]);
  });

  it('is the identity when no part transposes, so ordinary output is byte-identical', () => {
    const concert = build('lead-bass');
    expect(writtenPart(concert, 'concert', { ownParts: true })).toBe(concert);
  });
});
