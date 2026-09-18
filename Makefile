# sibei-score — one place for every command.
#
# Bare `make` prints this help. To try the app, run `make up` — it builds and starts the app in
# Docker. If you've enabled the optional Traefik proxy (see compose.override.yaml.example) it is
# served at http://sibei-score.localhost/ with no host port to collide; otherwise on 127.0.0.1:8080.

SHELL := bash
.DEFAULT_GOAL := help

# Everything the app needs runs in Docker. The CLI targets reach the sbscore CLI *inside* the running
# container (pointed at the in-container server on :8080), so you never need pnpm or Node on the host.
COMPOSE := docker compose
DC_CLI := $(COMPOSE) exec -T -e SBSCORE_URL=http://127.0.0.1:8080 sbscore pnpm -s sbscore

.PHONY: help up down logs sample cli install check test test-fast typecheck proof render demo eval hooks clean omr-viz-setup omr-viz

# Where the indah dev checkout lives (EPIC-228) — override if yours is elsewhere:
#   make omr-viz INDAH_PATH=/path/to/indah-python-ui
INDAH_PATH ?= /home/jianlee/projects/abang-ai/indah-python-ui

help: ## List available commands
	@echo "sibei-score — run 'make up', then open http://sibei-score.localhost/ (or http://127.0.0.1:8080)"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'

# --- Run the app (Docker; Traefik auto-detects it) ---

up: ## Try it out: build & run the app in Docker (Ctrl-C stops it)
	$(COMPOSE) up --build

down: ## Stop and remove the Docker stack
	$(COMPOSE) down

logs: ## Follow the running stack's logs
	$(COMPOSE) logs -f

sample: ## Seed a demo chart into the running stack (after `make up`, from another terminal)
	$(DC_CLI) new --id soul --title "Body and Soul" --composer "Johnny Green" --key Db --bars 8
	$(DC_CLI) note add soul bar1.beat1 --pitch Db5 --dur 8
	$(DC_CLI) note add soul bar1.beat2 --pitch F5 --dur 4
	$(DC_CLI) chord set soul bar1.beat1 --text "Ebm7"
	@echo "Created 'soul' — open it in the browser at /#/score/soul"

cli: ## Run the sbscore CLI in the container, e.g. make cli ARGS="list"
	$(DC_CLI) $(ARGS)

# --- Develop & test from source (needs Node >=22 + pnpm on the host) ---

install: ## Install dependencies for the dev/test targets below
	pnpm install

check: install ## The full gate: typecheck + all tests
	pnpm check

test: install ## Run all tests (both layers)
	pnpm test

test-fast: install ## Run the fast, no-infra test layer (what the pre-push hook runs)
	pnpm test:fast

typecheck: install ## Typecheck every package
	pnpm typecheck

proof: install ## Render fixtures and open the engraving proof
	pnpm proof

render: install ## Render every fixture to out/
	pnpm render all

demo: install ## Run the end-to-end demo (create, edit, export)
	pnpm demo

eval: install ## Score OMR accuracy (needs the worker; `make eval ARGS="--engine fixture"` to smoke it)
	pnpm eval $(ARGS)

hooks: ## Install the git pre-push hook (once per clone)
	pnpm hooks:install

omr-viz-setup: install ## One-time setup for the OMR pipeline viewer: indah, bespoke weights, a sample corpus
	@if [ ! -d worker/devtools/omr_viz/.venv ]; then \
	  echo "setting up worker/devtools/omr_viz/.venv ..."; \
	  cd worker/devtools/omr_viz && uv venv --python 3.11 && \
	    uv pip install -e "$(INDAH_PATH)" && uv pip install -e .; \
	fi
	@if [ ! -f out/bespoke/detect.onnx ]; then \
	  echo "fetching bespoke weights ..."; \
	  python3 worker/fetch_bespoke.py --dir out/bespoke; \
	fi
	@if [ ! -d out/viz-corpus ] || [ -z "$$(ls -A out/viz-corpus 2>/dev/null)" ]; then \
	  echo "generating a sample corpus ..."; \
	  pnpm eval --dump-corpus out/viz-corpus --seeds 6 --bars 16; \
	fi

omr-viz: omr-viz-setup ## Qualitatively review the bespoke OMR pipeline (Stage 1 today; indah, dev-only, EPIC-228)
	cd worker/devtools/omr_viz && \
	  SIBEI_BESPOKE_MODEL_DIR=$(CURDIR)/out/bespoke \
	  OMR_VIZ_CORPUS_DIR=$(CURDIR)/out/viz-corpus \
	  .venv/bin/python app.py

clean: ## Remove build and render output
	rm -rf out dist
