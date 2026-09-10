import type { Alter, KeySignature, Step } from '@sibei/model';

/**
 * The keys the transpose control offers (V6e). The twelve pitch classes in both modes, each spelled
 * the conventional way a musician would write that key — flat-side majors (D♭, E♭, A♭, B♭) and the
 * usual minor spellings — so the picker reads like a key list and not a table of enharmonics.
 *
 * A wire-side list, like the instrument one: transposition targets are a UI affordance, and the
 * server validates the `KeySignature` the op carries regardless.
 */

export interface KeyOption {
  label: string;
  key: KeySignature;
}

function major(tonic: Step, alter: Alter, name: string): KeyOption {
  return { label: `${name} major`, key: { tonic, alter, mode: 'major' } };
}

function minor(tonic: Step, alter: Alter, name: string): KeyOption {
  return { label: `${name} minor`, key: { tonic, alter, mode: 'minor' } };
}

export const TARGET_KEYS: readonly KeyOption[] = [
  major('C', 0, 'C'),
  major('D', -1, 'D♭'),
  major('D', 0, 'D'),
  major('E', -1, 'E♭'),
  major('E', 0, 'E'),
  major('F', 0, 'F'),
  major('G', -1, 'G♭'),
  major('G', 0, 'G'),
  major('A', -1, 'A♭'),
  major('A', 0, 'A'),
  major('B', -1, 'B♭'),
  major('B', 0, 'B'),
  minor('A', 0, 'A'),
  minor('B', -1, 'B♭'),
  minor('B', 0, 'B'),
  minor('C', 0, 'C'),
  minor('C', 1, 'C♯'),
  minor('D', 0, 'D'),
  minor('E', -1, 'E♭'),
  minor('E', 0, 'E'),
  minor('F', 0, 'F'),
  minor('F', 1, 'F♯'),
  minor('G', 0, 'G'),
  minor('G', 1, 'G♯'),
];

export function keyEquals(a: KeySignature, b: KeySignature): boolean {
  return a.tonic === b.tonic && a.alter === b.alter && a.mode === b.mode;
}
