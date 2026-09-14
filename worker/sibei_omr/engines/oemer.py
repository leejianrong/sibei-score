"""The oemer engine, behind the engine seam (V13c).

The implementation is the V9/V10 in-process oemer pipeline in ``sibei_omr.recognize`` — unchanged.
This module is only the seam adapter, so ``get_engine('oemer')`` resolves to the same function the
worker has always called. V15 may move the pipeline body in here wholesale (its build-plan item 4);
V13c keeps it where it is and adapts it, to keep the diff about the *seam*, not about moving 250 lines.
"""

from __future__ import annotations

from ..recognize import engine_version as version
from ..recognize import recognize

__all__ = ["recognize", "version"]
