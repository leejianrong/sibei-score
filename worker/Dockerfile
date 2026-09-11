# The OMR worker image (V10): Python owns oemer and nothing else (ADR-0005). It receives an image
# over HTTP and returns raw recognised objects; it never touches the score store and never becomes a
# second write path. This is the second container in Q44's "two containers via compose" topology,
# which V10 adds to V8h's api-only compose.
#
# CPU-only is the hard floor (ADR-0025): this image uses the CPU onnxruntime wheel the pyproject
# pins, so it runs on any machine with no special hardware. The GPU variant is Dockerfile.gpu — a
# separate image (a CUDA base, onnxruntime-gpu), opt-in, and it changes speed only, never output.
#
# The runtime is pinned WITH the weights (the V9 finding that extends ADR-0024): oemer==0.1.8,
# onnxruntime==1.16.3 (newer refuses oemer's ConvTranspose nodes), opencv<5, numpy<2 — all in
# pyproject.toml. Pinning the checkpoints without pinning the runtime that reads them would not be
# reproducible.

FROM python:3.11-slim-bookworm

# The only system libraries oemer's runtime needs. opencv-python-headless is the GUI-free build, so
# no libGL/X11 — it needs glib, and scipy/scikit-learn need libgomp (OpenMP). Kept to exactly these
# so the offline image's surface stays small and auditable (ADR-0024's argument is only as strong as
# the dependency list is short).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the worker and its pinned dependency set (pyproject.toml). The CPU onnxruntime wheel is the
# ADR-0025 floor; oemer only does `import onnxruntime` and asks for CUDA-then-CPU providers, so the
# CPU wheel is a drop-in.
COPY . .
RUN pip install --no-cache-dir .

# **Bake every model checkpoint into the image at build time, verified by checksum (ADR-0024).** The
# running container never downloads a model — this is what makes an import run with networking
# disabled, the offline requirement's whole point (a fresh container's first import must work on a
# gig with no connectivity). A silently changed or replaced upstream artefact fails the build here,
# not at runtime. This is the layer that makes the image large, and Q43 accepts that size as the
# direct price of the offline guarantee. Build time needs the network (to fetch the ~104 MB of
# weights); runtime does not.
RUN python fetch_weights.py

# Run unprivileged: the worker processes untrusted image bytes (ADR-0029), so it holds no more than
# it needs. It writes nothing persistent — the source image is the API's to keep, in the BlobStore
# (ADR-0019); the worker is stateless (ADR-0005).
RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker

# Bind 0.0.0.0 inside the container so the API can reach it over the private compose network (Q44).
# The worker publishes NO port to the host — the compose file gives it no `ports:` — so binding all
# interfaces here exposes it only to other services on that network, never the host or the LAN
# (ADR-0029's separation of bind from publish, V8h).
ENV SIBEI_OMR_HOST=0.0.0.0 \
    SIBEI_OMR_PORT=8000
EXPOSE 8000

# The server binds immediately (oemer's heavy imports are lazy, deferred to the first recognition),
# so health is up within seconds. A recognition holds a lock but the server is threaded, so /health
# keeps answering even during a five-minute run (V9, ADR-0025).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"

CMD ["sibei-omr-server"]
