import type { Score } from '@sibei/model';
import { beamRules34Chart, beamRules68Chart, beamRulesChart, beamRulesCutChart } from './beam-rules-charts.js';
import { crowdedChordsChart } from './crowded-chords-chart.js';
import { denseSpacingChart } from './dense-spacing-chart.js';
import { graceNotesChart } from './grace-notes-chart.js';
import { pianoChordsChart, stackedChordsChart } from './stacked-chords-charts.js';
import { aabaChart } from './aaba-chart.js';
import { articulationsChart } from './articulations-chart.js';
import { longFormChart } from './long-form-chart.js';
import { fullBandChart, grandStaffChart, leadBassChart, twoVoiceChart } from './multi-staff-charts.js';
import { clefsAndKeysChart, voiceCollisionsChart } from './staff-engraving-charts.js';
import { clefChangeChart, fermatasStavesChart, ottavaStavesChart } from './staff-refinement-charts.js';
import { instrumentNamesChart } from './instrument-names-chart.js';
import { drumChart } from './drum-chart.js';
import { staffFurnitureChart } from './staff-furniture-chart.js';
import { navigationChart } from './navigation-chart.js';
import { dynamicsChart, dynamicsStavesChart } from './dynamics-chart.js';
import { lyricsChart, lyricsStavesChart } from './lyrics-chart.js';
import { nastyChart } from './nasty-chart.js';
import { marksChart } from './marks-chart.js';
import { slurChart } from './slur-chart.js';
import { titleBlockChart } from './title-block-chart.js';
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
  navigation: navigationChart,
  dynamics: dynamicsChart,
  'dynamics-staves': dynamicsStavesChart,
  lyrics: lyricsChart,
  'lyrics-staves': lyricsStavesChart,
  untitled: untitledChart,
  slurs: slurChart,
  marks: marksChart,
  articulations: articulationsChart,
  'grace-notes': graceNotesChart,
  'stacked-chords': stackedChordsChart,
  'piano-chords': pianoChordsChart,
  'title-block': titleBlockChart,
  'grand-staff': grandStaffChart,
  'two-voice': twoVoiceChart,
  'lead-bass': leadBassChart,
  'full-band': fullBandChart,
  'voice-collisions': voiceCollisionsChart,
  'clefs-and-keys': clefsAndKeysChart,
  'staff-furniture': staffFurnitureChart,
  'drum-kit': drumChart,
  'ottava-staves': ottavaStavesChart,
  'fermatas-staves': fermatasStavesChart,
  'clef-change': clefChangeChart,
  'instrument-names': instrumentNamesChart,
};
