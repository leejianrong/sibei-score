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

from sibei_omr.recognize import engine_version, recognize

RecognizeFn = Callable[[str, "str | None"], dict[str, Any]]

# A generous cap on the uploaded image, matching the API's upload boundary (25 MB, ADR-0029). The
# API validates and caps first; this is defence in depth for a worker that is, in the hosted future,
# reachable only by the API but still processes untrusted bytes.
MAX_BODY_BYTES = 25_000_000


def make_handler(recognize_fn: RecognizeFn, lock: threading.Lock) -> type[BaseHTTPRequestHandler]:
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
                self._send_json(200, {"status": "ok", "engine": "oemer", "engineVersion": engine_version()})
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
            name = _first(parse_qs(parsed.query).get("name")) or "upload"

            # oemer's inference reads a file path (cv2.imread + onnxruntime session), so the uploaded
            # bytes land in a temp file for the duration of the run and are removed after. Never kept:
            # retaining the source image is the API's job, in the BlobStore (ADR-0019), not the
            # worker's — the worker holds no state (ADR-0005).
            suffix = os.path.splitext(name)[1] or ".img"
            tmp = tempfile.NamedTemporaryFile(prefix="sibei-omr-", suffix=suffix, delete=False)
            try:
                tmp.write(body)
                tmp.close()
                # One recognition at a time (see the module docstring).
                with lock:
                    doc = recognize_fn(tmp.name, name)
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
    recognize_fn: RecognizeFn = recognize,
) -> ThreadingHTTPServer:
    """Build and return a started-but-not-serving server. Call ``serve_forever`` on it, or use it in
    a test with ``server_close``."""
    handler = make_handler(recognize_fn, threading.Lock())
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
    args = parser.parse_args(argv)

    server = serve(host=args.host, port=args.port)
    print(f"sibei-omr worker listening on http://{args.host}:{args.port} (engine oemer {engine_version()})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
