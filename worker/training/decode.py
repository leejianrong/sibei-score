"""CTC greedy decoding and sequence metrics (V15b, ADR-0031).

Shared by training-time validation and, later, the bespoke inference engine (V15c), so the model's
raw per-column logits become a note/rest token-id sequence exactly one way. Greedy decode is enough
for the probe; a beam search over the same logits is a later refinement if it pays off.
"""

from __future__ import annotations

from typing import Any

BLANK = 0


def greedy_decode(logits: Any) -> list[list[int]]:
    """[B, T, C] logits -> one token-id sequence per batch item.

    The CTC collapse: walk the per-column argmax, keep a class only when it differs from the previous
    column (merging repeats), then drop the blank. Tracking the previous *raw* class (blank included)
    is what lets a real repeat survive — a blank column between two equal classes breaks the run.
    """
    best = logits.argmax(dim=2)  # [B, T]
    sequences: list[list[int]] = []
    for row in best.tolist():
        seq: list[int] = []
        prev = -1
        for cls in row:
            if cls != prev and cls != BLANK:
                seq.append(cls)
            prev = cls
        sequences.append(seq)
    return sequences


def edit_distance(a: list[int], b: list[int]) -> int:
    """Levenshtein distance between two id sequences."""
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            curr[j] = min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (0 if ca == cb else 1),
            )
        prev = curr
    return prev[-1]


def sequence_metrics(preds: list[list[int]], targets: list[list[int]]) -> dict[str, float]:
    """Exact-match rate and token error rate (Levenshtein / total truth length) over a batch."""
    exact = sum(1 for p, t in zip(preds, targets) if p == t)
    errors = sum(edit_distance(p, t) for p, t in zip(preds, targets))
    truth_len = sum(len(t) for t in targets)
    return {
        "exact_match": exact / max(1, len(targets)),
        "token_error_rate": errors / max(1, truth_len),
        "token_accuracy": 1.0 - errors / max(1, truth_len),
    }
