import type { Score } from '@sibei/model';
import { beamRules34Chart, beamRules68Chart, beamRulesChart, beamRulesCutChart } from './beam-rules-charts.js';
import { crowdedChordsChart } from './crowded-chords-chart.js';
import { denseSpacingChart } from './dense-spacing-chart.js';
import { aabaChart } from './aaba-chart.js';
import { articulationsChart } from './articulations-chart.js';
import { longFormChart } from './long-form-chart.js';
import { nastyChart } from './nasty-chart.js';
import { marksChart } from './marks-chart.js';
import { slurChart } from './slur-chart.js';
import {
  beamingChart,
  everyGlyphChart,
  invalidBarChart,
  reviewChart,
  untitledChart,
} from './simple-charts.js';

/**
 * Every named fixture, once (KAN-593). `scripts/render-fixture.ts` and `scripts/proof.ts` each used
 * to keep their own map, so a fixture added to one and not the other rendered but could not be
 * proofed, or the reverse — and `beaming` had already drifted that way. Nothing failed, which is the
 * shape of the problem. `tests/unit/fixture-registry.test.ts` fails when a fixture is exported but
 * not listed here.
 */
export const FIXTURE_REGISTRY: Record<string, () => Score> = {
  'nasty-chart': nastyChart,
  'every-glyph': everyGlyphChart,
  beaming: beamingChart,
  'dense-spacing': denseSpacingChart,
  'crowded-chords': crowdedChordsChart,
  'beam-rules': beamRulesChart,
  'beam-rules-68': beamRules68Chart,
  'beam-rules-34': beamRules34Chart,
  'beam-rules-cut': beamRulesCutChart,
  'invalid-bars': invalidBarChart,
  review: reviewChart,
  'long-form': longFormChart,
  'aaba-chart': aabaChart,
  untitled: untitledChart,
  slurs: slurChart,
  marks: marksChart,
  articulations: articulationsChart,
};
