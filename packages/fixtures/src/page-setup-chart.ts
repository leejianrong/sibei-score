import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * Page setup (SIB2-287): a lead sheet with a smaller staff (6 mm against the default 8.5), generous left and right
 * margins and a tight gap between systems, so staff size, margins and system spacing are all visibly off their
 * defaults. Sixteen bars of chords over a simple line: enough lines to show the system gap and fill a page differently.
 */
export function pageSetupChart(): Score {
  const ids = createIdFactory();
  const q = dur(4);
  const chords = ['Cmaj7', 'A7', 'Dm7', 'G7'];
  const bars = Array.from({ length: 16 }, (_, index) => {
    const n = index + 1;
    return new BarBuilder(ids, { number: n }).chord(1, chords[index % 4]!, 480).note('E5', q).note('G5', q).note('E5', q).note('D5', q).build();
  });
  const score = makeScore({ id: 'page-setup', title: 'Page Setup', composer: 'fixture', bars });
  return {
    ...score,
    meta: { ...score.meta, page: { staffSize: 6, margin: { left: 25, right: 25, top: 20 }, systemGap: 12 } },
  };
}
