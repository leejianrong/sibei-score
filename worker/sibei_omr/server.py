"""The OMR worker's HTTP server (V10).

ADR-0005 makes Python an OMR worker only: it receives an image and returns raw musical objects, and
it never touches the score store. This is that seam, over HTTP — the transport the API's
``WorkerClient`` port speaks (Q44: two containers, the API calls the worker). It exposes exactly two
endpoints:

  POST /recognize?name=<basename>   raw image bytes in the body -> an OmrDocument as JSON
  GET  /health                      liveness, for the container HEALTHCHECK and the compose depends_on

Deliberately stdlib ``http.server`` and nothing else — no framework — matching the Node side's "five
routes is not a framework's worth of work" and keeping the worker's dependency surface to oemer and
its pinned runtime (the offline guarantee, ADR-0024, is only as strong as the dependency list is
short).

**Recognition is serialised** by a lock, even though the server is threaded. oemer's peak resident
memory is ~7 GB and its wall-clock is content-independent (V9), so two concurrent recognitions would
double the memory for no throughput a single-user deployment can use — the API's runner already
sends one at a time, and this lock is the belt to that braces. The server stays threaded so
``/health`` answers promptly even while a five-minute recognition holds the lock.

**Offline** (ADR-0024): this server never fetches a model. The weights are baked into the image at
build time and verified by checksum (``fetch_weights.py``, the Dockerfile); ``recognize`` reads them
from disk. A container with networking disabled runs an import to completion — the property the
offline test asserts.

The recogniser is injected (``recognize_fn``) so this server can be exercised without oemer, weights,
or minutes: a test passes a stub that returns a canned OmrDocument, which is exactly what oemer's
output is on the wire.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from sibei_omr.engines import DEFAULT_ENGINE, ENGINE_NAMES, get_engine

RecognizeFn = Callable[[str, "str | None"], dict[str, Any]]

# A generous cap on the uploaded image, matching the API's upload boundary (25 MB, ADR-0029). The
# API validates and caps first; this is defence in depth for a worker that is, in the hosted future,
# reachable only by the API but still processes untrusted bytes.
MAX_BODY_BYTES = 25_000_000


def make_handler(
    recognize_fn: RecognizeFn,
    lock: threading.Lock,
    engine_name: str,
    version_fn: Callable[[], str],
    resolve_engine: "Callable[[str], tuple[RecognizeFn, str]] | None" = None,
) -> type[BaseHTTPRequestHandler]:
    """Build the request handler. ``recognize_fn``/``engine_name`` are the server's default engine.

    ``resolve_engine`` (V14e), when given, lets one ``/recognize`` call override the engine with a
    ``?engine=<name>`` query param — the seam a re-parse threads the user's choice through
    (``--engine``/``$SIBEI_OMR_ENGINE`` are the whole-server equivalents). It maps a name to that
    engine's ``(recognize_fn, name)``; an unknown name raises, which becomes the API's Q80 diagnostic.
    It is ``None`` when a test injected ``recognize_fn`` directly — then the stub *is* the recogniser
    and a per-request engine is ignored, the same bypass engine resolution has always had.
    """
    class Handler(BaseHTTPRequestHandler):
        # Quieter than the default, and — like the Node side (ADR-0029) — a log line with nowhere for
        # an image or a path to go. One line per request: method, path, status.
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (stdlib signature)
            return

        def _send_json(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(payload)))
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/health":
                self._send_json(200, {"status": "ok", "engine": engine_name, "engineVersion": version_fn()})
                return
            self._send_json(404, {"error": f"nothing at {path}"})

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path != "/recognize":
                self._send_json(404, {"error": f"nothing at {parsed.path}"})
                return

            length = int(self.headers.get("content-length") or 0)
            if length <= 0:
                self._send_json(400, {"error": "empty body: POST the raw image bytes"})
                return
            if length > MAX_BODY_BYTES:
                self._send_json(413, {"error": f"image larger than {MAX_BODY_BYTES} bytes"})
                return

            body = self.rfile.read(length)
            query = parse_qs(parsed.query)
            name = _first(query.get("name")) or "upload"
            requested_engine = _first(query.get("engine"))

            # oemer's inference reads a file path (cv2.imread + onnxruntime session), so the uploaded
            # bytes land in a temp file for the duration of the run and are removed after. Never kept:
            # retaining the source image is the API's job, in the BlobStore (ADR-0019), not the
            # worker's — the worker holds no state (ADR-0005).
            suffix = os.path.splitext(name)[1] or ".img"
            tmp = tempfile.NamedTemporaryFile(prefix="sibei-omr-", suffix=suffix, delete=False)
            try:
                tmp.write(body)
                tmp.close()

                # A per-request engine override (V14e's re-parse): resolve inside the try so an unknown
                # name becomes the same clean 500 → Q80 diagnostic a recognition failure does. Only when
                # the server holds a real engine registry (not an injected test stub, `resolve_engine is
                # None`) and the requested name differs from the start-up default. Absent, the server's
                # start-up engine runs — every normal import's path.
                run_fn = recognize_fn
                if resolve_engine is not None and requested_engine and requested_engine != engine_name:
                    run_fn, _ = resolve_engine(requested_engine)

                # One recognition at a time (see the module docstring).
                with lock:
                    doc = run_fn(tmp.name, name)
                self._send_json(200, doc)
            except Exception as error:  # noqa: BLE001 — any failure is the API's Q80 diagnostic.
                # A short, safe message: the class and text, never a path or the image. The API turns a
                # non-2xx into a failed, retryable job (Q80).
                self._send_json(500, {"error": f"recognition failed: {type(error).__name__}: {error}"})
            finally:
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass

    return Handler


def _first(values: list[str] | None) -> str | None:
    return values[0] if values else None


def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    *,
    engine: str | None = None,
    recognize_fn: RecognizeFn | None = None,
) -> ThreadingHTTPServer:
    """Build and return a started-but-not-serving server. Call ``serve_forever`` on it, or use it in
    a test with ``server_close``.

    With no ``recognize_fn`` the engine is resolved by name (``engine``, else ``$SIBEI_OMR_ENGINE``,
    else the default), so the worker recognises with the selected engine (V13c). A test may still
    inject ``recognize_fn`` directly, bypassing engine resolution — the seam the server has always had.
    """
    resolve_engine: "Callable[[str], tuple[RecognizeFn, str]] | None" = None
    if recognize_fn is not None:
        engine_name = engine or "injected"
        version_fn: Callable[[], str] = lambda: "test"
    else:
        selected = get_engine(engine or os.environ.get("SIBEI_OMR_ENGINE", DEFAULT_ENGINE))
        recognize_fn, engine_name, version_fn = selected.recognize, selected.name, selected.version
        # A per-request engine override (V14e): map a name to that engine's recogniser. Lazy, so a
        # request for the already-running engine never re-imports it, and only a real registry (not an
        # injected stub) offers the override at all.
        def resolve_engine(name: str) -> "tuple[RecognizeFn, str]":
            chosen = get_engine(name)
            return chosen.recognize, chosen.name

    handler = make_handler(recognize_fn, threading.Lock(), engine_name, version_fn, resolve_engine)
    return ThreadingHTTPServer((host, port), handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sibei-omr-server",
        description="The sibei-score OMR worker: POST an image to /recognize, get an OmrDocument (ADR-0005).",
    )
    # The worker binds 0.0.0.0 by default because it lives inside a container reached over the private
    # compose network (Q44); the network isolation is the compose file's job, not the bind's — the
    # worker publishes no port to the host at all (ADR-0029's separation of bind from publish, V8h).
    parser.add_argument("--host", default=os.environ.get("SIBEI_OMR_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SIBEI_OMR_PORT", "8000")))
    parser.add_argument(
        "--engine",
        default=os.environ.get("SIBEI_OMR_ENGINE", DEFAULT_ENGINE),
        choices=ENGINE_NAMES,
        help="which recognition engine to serve (default oemer; heuristic is dependency-light, V13c)",
    )
    args = parser.parse_args(argv)

    server = serve(host=args.host, port=args.port, engine=args.engine)
    print(f"sibei-omr worker listening on http://{args.host}:{args.port} (engine {args.engine})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
