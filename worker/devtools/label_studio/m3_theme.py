"""The studio's Material 3 colour roles, as an indah `Theme` (SIB2-126).

Seeded with the product's own accent (#22409c) — the same generated scheme `packages/ui/src/m3.css`
holds, so the studio looks like part of sibei-score rather than a stock indah demo. Roles are the
spec's, not hand-darkened: M3 names are mapped onto indah's token names (indah's own role set follows
M3's vocabulary), and the tiers indah has no slot for ride as `x-` tokens the workbench reads.

Light and dark are the two generated schemes, swapped as whole blocks. The score paper is never
inverted — it is a scan — and is a token of its own (`x-paper`).
"""

from __future__ import annotations

import indah

# M3 role -> indah token, per scheme.
_LIGHT = {
    "bg": "#fefbff",  # surface
    "surface": "#f5f3f7",  # surface-container-low
    "surface-2": "#efedf1",  # surface-container
    "surface-3": "#e4e1e6",  # surface-container-highest
    "text": "#1b1b1f",  # on-surface
    "muted": "#45464f",  # on-surface-variant
    "outline": "#767680",
    "outline-soft": "#c6c5d0",  # outline-variant
    "primary": "#3d58b4",
    "on-primary": "#ffffff",
    "primary-container": "#dce1ff",
    "on-primary-container": "#001550",
    "secondary": "#595d72",
    "on-secondary": "#ffffff",
    "secondary-container": "#dee1f9",
    "on-secondary-container": "#161b2c",
    "err": "#ba1a1a",
}
_DARK = {
    "bg": "#1b1b1f",
    "surface": "#1b1b1f",
    "surface-2": "#1f1f23",
    "surface-3": "#343438",
    "text": "#e4e1e6",
    "muted": "#c6c5d0",
    "outline": "#90909a",
    "outline-soft": "#45464f",
    "primary": "#b6c4ff",
    "on-primary": "#002780",
    "primary-container": "#213f9b",
    "on-primary-container": "#dce1ff",
    "secondary": "#c2c5dd",
    "on-secondary": "#2b3042",
    "secondary-container": "#424659",
    "on-secondary-container": "#dee1f9",
    "err": "#ffb4ab",
}

# Kind colours: one tonal family, each readable on paper and on the canvas. Dark values are the
# lighter tones. Kind is told apart by hue AND by name everywhere it is shown; status is a pattern.
KIND_COLORS_LIGHT = {
    "lead-staff": "#3d58b4",
    "accompaniment-staff": "#8a4fa3",
    "drum-staff": "#b3541e",
    "chord-band": "#1f7a5a",
    "title": "#7a6a00",
    "rehearsal-mark": "#a0691a",
    "tempo": "#0d7c8a",
    "footer": "#6b6b74",
    "other": "#4a4a52",
    "barline": "#b3261e",
}
KIND_COLORS_DARK = {
    "lead-staff": "#8fa5ff",
    "accompaniment-staff": "#d6a6ec",
    "drum-staff": "#ffb68a",
    "chord-band": "#7fd8b4",
    "title": "#e2d06a",
    "rehearsal-mark": "#f0c274",
    "tempo": "#6fd6e6",
    "footer": "#aeaeb8",
    "other": "#c8c8d0",
    "barline": "#ffb4ab",
}

_EXTRA_LIGHT = {
    "x-high": "#eae7ec",  # surface-container-high
    "x-sv": "#e2e1ec",  # surface-variant
    "x-inv": "#303034",  # inverse-surface
    "x-on-inv": "#f2f0f4",
    "x-inv-primary": "#b6c4ff",
    "x-canvas": "#dcd9e0",
    "x-paper": "#ffffff",
}
_EXTRA_DARK = {
    "x-high": "#2a2a2d",
    "x-sv": "#45464f",
    "x-inv": "#e4e1e6",
    "x-on-inv": "#303034",
    "x-inv-primary": "#3d58b4",
    "x-canvas": "#0e0e11",
    "x-paper": "#fbfaf7",
}


def studio_theme() -> indah.Theme:
    return indah.Theme(
        light=_LIGHT,
        dark=_DARK,
        extra_light=_EXTRA_LIGHT | {f"x-k-{k}": v for k, v in KIND_COLORS_LIGHT.items()},
        extra_dark=_EXTRA_DARK | {f"x-k-{k}": v for k, v in KIND_COLORS_DARK.items()},
    )
