"""Assemble a bespoke recognition from its stages (V16c, ADR-0031).

Stage 1 (``layout.detect_layout``) finds the staves + barlines; Stage 2a (``stage2a.recognize_staff``)
reads each staff's melody. This module combines them into the ``OmrDocument`` object lists — staves,
barlines, noteheads, rests — in the source image's own pixel grid. Bars are **not** built here: the
mapper derives them from the barline x-positions + system breaks (ADR-0031). The chord band is left to
V17, so ``bandTokens`` stays empty (a bespoke import carries no chords yet, exactly as V11 did).
"""

from __future__ import annotations

from typing import Any

from . import layout, stage2a


def assemble(image: Any, np: Any, layout_session: Any, stage2a_session: Any, stage2a_symbols: list[str]) -> "tuple[list[dict], list[dict], list[dict], list[dict]]":
    """Run both stages and return ``(staves, barlines, noteheads, rests)`` for the document."""
    staves, barlines = layout.detect_layout(image, np, layout_session)

    noteheads: list[dict] = []
    rests: list[dict] = []
    for group, staff in enumerate(staves):
        stage2a.recognize_staff(stage2a_session, stage2a_symbols, image, staff, group, np, noteheads, rests)

    staff_dicts = [_staff_dict(i, s) for i, s in enumerate(staves)]
    return staff_dicts, barlines, noteheads, rests


def _staff_dict(index: int, s: dict) -> dict:
    """The emitted OmrStaff shape (matches the heuristic engine's, so the mapper is unchanged)."""
    return {
        "index": index,
        "track": 0,
        "group": index,
        "xLeft": float(s["xLeft"]),
        "xRight": float(s["xRight"]),
        "yUpper": float(s["yUpper"]),
        "yLower": float(s["yLower"]),
        "yCenter": float(s["yCenter"]),
        "unitSize": float(s["unit"]),
    }
