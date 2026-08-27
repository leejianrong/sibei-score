import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import { nastyChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { hitTest, loadFont, pageItemBoxes } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * Hit-testing (V4c, KAN-589) — SLICES.md's own case: a bar with a tie.
 *
 * `nastyChart` is used because it already has one (the tie at bar 9 the render gate found
 * running through the key signature). Nothing here names that bar directly, though: every
 * assertion is derived from whatever tie the fixture happens to have, which is what makes the
 * test keep meaning something if the fixture changes.
 */

describe('hit-testing', () => {
  const result = layout(nastyChart());
  const font = loadFont(DEFAULT_MUSIC_FONT);

  it('resolves the centre of every note and rest to its own id', () => {
    let checked = 0;
    for (const page of result.pages) {
      const boxes = pageItemBoxes(page, font);
      for (const box of boxes) {
        const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        expect(hitTest(boxes, centre)?.id).toBe(box.id);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('resolves each side of a tie to its own note, not to its tied partner', () => {
    let tiesChecked = 0;

    for (const page of result.pages) {
      const boxes = pageItemBoxes(page, font);
      for (const system of page.systems) {
        for (const tie of system.ties) {
          if (tie.fromNoteId === null || tie.toNoteId === null) continue;
          const fromBox = boxes.find((box) => box.id === tie.fromNoteId);
          const toBox = boxes.find((box) => box.id === tie.toNoteId);
          expect(fromBox).toBeDefined();
          expect(toBox).toBeDefined();
          if (fromBox === undefined || toBox === undefined) continue;

          expect(
            hitTest(boxes, { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 })?.id,
          ).toBe(tie.fromNoteId);
          expect(
            hitTest(boxes, { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 })?.id,
          ).toBe(tie.toNoteId);

          tiesChecked += 1;
        }
      }
    }

    // A guard on the guard: nastyChart is used *because* it ties across bar 9, and a fixture
    // change that removed every whole tie would make the assertions above pass by having
    // nothing to check.
    expect(tiesChecked).toBeGreaterThan(0);
  });

  it('finds nothing in open space between systems', () => {
    const page = result.pages[0];
    expect(page).toBeDefined();
    if (page === undefined) return;
    const boxes = pageItemBoxes(page, font);
    const hit = hitTest(boxes, { x: page.width / 2, y: -100 });
    expect(hit).toBeNull();
  });
});
