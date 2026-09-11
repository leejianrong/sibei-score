"""sibei-score OMR worker.

Python owns oemer and OCR and nothing else: it receives an image and returns raw musical
objects with pixel coordinates, and never touches the score store (ADR-0005, ADR-0003).

V9 is the coordinate spike (ADR-0023): prove oemer's internal Staff / NoteHead /
NoteGroup / Barline / Rest coordinates are reachable in-process, and measure CPU
wall-clock (ADR-0025), before any import application code is written.
"""

__all__ = ["spike"]
