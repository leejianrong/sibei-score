"""Tests for the CTC decode + sequence metrics (V15b).

The Levenshtein and metric helpers are pure Python and run anywhere. `greedy_decode` needs a torch
tensor, so its tests are skipped where torch is absent (the training dep is not installed on the CPU
dev host) — they run on the GPU training pod and anywhere torch is present. The CTC collapse is the
easy-to-get-wrong part, so it is what the guarded tests pin.
"""

from __future__ import annotations

import unittest

from training.decode import edit_distance, sequence_metrics

try:
    import torch

    HAVE_TORCH = True
except Exception:  # noqa: BLE001 — torch is training-only, absent on the CPU dev host.
    HAVE_TORCH = False

if HAVE_TORCH:
    from training.decode import greedy_decode


def _one_hot(columns: list[int], num_classes: int):
    logits = torch.full((1, len(columns), num_classes), -10.0)
    for t, cls in enumerate(columns):
        logits[0, t, cls] = 10.0
    return logits


class EditDistanceTest(unittest.TestCase):
    def test_matches_and_edits(self) -> None:
        self.assertEqual(edit_distance([], []), 0)
        self.assertEqual(edit_distance([1, 2, 3], [1, 2, 3]), 0)
        self.assertEqual(edit_distance([1, 2, 3], [1, 2]), 1)  # deletion
        self.assertEqual(edit_distance([1, 2], [1, 2, 3]), 1)  # insertion
        self.assertEqual(edit_distance([1, 2, 3], [1, 9, 3]), 1)  # substitution
        self.assertEqual(edit_distance([], [1, 2]), 2)


class SequenceMetricsTest(unittest.TestCase):
    def test_perfect(self) -> None:
        m = sequence_metrics([[1, 2], [3]], [[1, 2], [3]])
        self.assertEqual(m["exact_match"], 1.0)
        self.assertEqual(m["token_error_rate"], 0.0)
        self.assertEqual(m["token_accuracy"], 1.0)

    def test_one_insertion(self) -> None:
        m = sequence_metrics([[1, 2, 3]], [[1, 2]])  # one extra token, truth length 2
        self.assertEqual(m["exact_match"], 0.0)
        self.assertAlmostEqual(m["token_error_rate"], 0.5)
        self.assertAlmostEqual(m["token_accuracy"], 0.5)


@unittest.skipUnless(HAVE_TORCH, "torch not installed")
class GreedyDecodeTest(unittest.TestCase):
    def test_drops_blank_and_keeps_separated_repeat(self) -> None:
        # blank, A, A, blank, A -> [A, A]: the blank between the runs preserves the real repeat.
        self.assertEqual(greedy_decode(_one_hot([0, 1, 1, 0, 1], 3)), [[1, 1]])

    def test_merges_adjacent_repeats(self) -> None:
        # A, A, B, B, B -> [A, B]: consecutive equal columns collapse to one token.
        self.assertEqual(greedy_decode(_one_hot([1, 1, 2, 2, 2], 3)), [[1, 2]])

    def test_all_blank_is_empty(self) -> None:
        self.assertEqual(greedy_decode(_one_hot([0, 0, 0], 3)), [[]])


if __name__ == "__main__":
    unittest.main()
