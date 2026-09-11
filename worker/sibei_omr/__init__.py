"""sibei-score OMR worker.

Python owns oemer and OCR and nothing else: it receives an image and returns raw musical
objects with pixel coordinates, and never touches the score store (ADR-0005, ADR-0003).

V9 was the coordinate spike (ADR-0023): it proved oemer's internal Staff / NoteHead /
NoteGroup / Barline / Rest coordinates are reachable in-process, and measured CPU
wall-clock (ADR-0025). V10 promotes that spike into the real worker: ``recognize`` is the
recognition core, ``server`` wraps it in the HTTP seam the API calls across (ADR-0005), and
``spike`` remains as a one-file CLI over the same core.
"""

__all__ = ["recognize", "server", "spike"]
