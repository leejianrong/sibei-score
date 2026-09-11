"""Tests for the OMR worker's HTTP server (V10).

Standalone, like the rest of ``worker/`` — outside the pnpm workspace and not in the Node CI
(ADR-0005). Run with ``python -m unittest`` from ``worker/`` in the venv. No oemer, no weights, and
no minutes: the recogniser is stubbed through the injection seam ``serve`` exposes, which is the
whole point of that seam — the server's own logic (routing, the body cap, temp-file handling, the
Q80 error path) is exercised without the heavy recognition behind it.

These validate the language boundary from the Python side (ADR-0005): the shape the server puts on
the wire is what the Node ``WorkerClient`` re-validates with ``parseOmrDocument``.
"""

from __future__ import annotations

import http.client
import json
import threading
import unittest

from sibei_omr.server import serve

A_DOCUMENT = {
    "schemaVersion": 1,
    "source": {
        "engine": "oemer",
        "engineVersion": "0.1.8",
        "imagePath": "page-1",
        "imageWidth": 100,
        "imageHeight": 200,
        "provider": "CPUExecutionProvider",
        "wallClockSeconds": 1.0,
    },
    "staves": [],
    "zones": [],
    "noteheads": [],
    "noteGroups": [],
    "barlines": [],
    "rests": [],
}


class ServerTest(unittest.TestCase):
    def _serve(self, recognize_fn):
        server = serve(host="127.0.0.1", port=0, recognize_fn=recognize_fn)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def _request(self, port, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request(method, path, body=body)
            response = conn.getresponse()
            payload = response.read()
            return response.status, payload
        finally:
            conn.close()

    def test_recognize_returns_the_document_and_passes_the_name_through(self):
        seen = {}

        def fake(img_path, image_name):
            seen["path"] = img_path
            seen["name"] = image_name
            doc = dict(A_DOCUMENT)
            doc["source"] = dict(A_DOCUMENT["source"], imagePath=image_name)
            return doc

        port = self._serve(fake)
        status, payload = self._request(port, "POST", "/recognize?name=chart.png", body=b"\x89PNG-bytes")
        self.assertEqual(status, 200)
        doc = json.loads(payload)
        self.assertEqual(doc["source"]["imagePath"], "chart.png")
        self.assertEqual(seen["name"], "chart.png")
        # The worker wrote the bytes to a temp file with the name's suffix and handed that path over.
        self.assertTrue(seen["path"].endswith(".png"))

    def test_health(self):
        port = self._serve(lambda p, n: A_DOCUMENT)
        status, payload = self._request(port, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)["status"], "ok")

    def test_empty_body_is_rejected(self):
        port = self._serve(lambda p, n: A_DOCUMENT)
        status, _ = self._request(port, "POST", "/recognize", body=b"")
        self.assertEqual(status, 400)

    def test_recognition_failure_is_a_500_with_a_diagnostic(self):
        def boom(img_path, image_name):
            raise RuntimeError("oemer fell over")

        port = self._serve(boom)
        status, payload = self._request(port, "POST", "/recognize?name=x.png", body=b"bytes")
        self.assertEqual(status, 500)
        self.assertIn("oemer fell over", json.loads(payload)["error"])

    def test_unknown_paths_404(self):
        port = self._serve(lambda p, n: A_DOCUMENT)
        self.assertEqual(self._request(port, "GET", "/nope")[0], 404)
        self.assertEqual(self._request(port, "POST", "/nope", body=b"x")[0], 404)


if __name__ == "__main__":
    unittest.main()
