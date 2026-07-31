import type { Duration } from '@sibei/model';
import type { MusicGlyphName } from './font.js';
import { MIDDLE_LINE } from './staff.js';

/**
 * Rests: which glyph, and where it hangs.
 *
 * The vertical positions are conventions rather than metrics, and there are only two
 * that matter. A whole rest **hangs from** the second line down; every other rest sits
 * on the middle line. SMuFL draws each glyph around an origin that makes those two
 * placements a single number each, so there is nothing to nudge.
 */

export function restFor(duration: Duration): MusicGlyphName {
  switch (duration.value) {
    case 1:
      return 'restWhole';
    case 2:
      return 'restHalf';
    case 4:
      return 'restQuarter';
    case 8:
      return 'rest8th';
    case 16:
      return 'rest16th';
    default:
      // Nothing shorter than a thirty-second exists in the model's vocabulary.
      return 'rest32nd';
  }
}

/** Second line from the top, which a whole rest hangs beneath. */
const WHOLE_REST_LINE = 2;

export function restPosition(duration: Duration): number {
  return duration.value === 1 ? WHOLE_REST_LINE : MIDDLE_LINE;
}
