# Run via mise so the pinned bun toolchain is on PATH, e.g. `mise exec -- make check`.
BUN ?= bun

.DEFAULT_GOAL := help

# ---- install -----------------------------------------------------------

.PHONY: install
install:  ## Install dependencies (frozen lockfile)
	$(BUN) install --frozen-lockfile

# ---- quality -----------------------------------------------------------

.PHONY: check
check: typecheck lint test  ## Run all checks (typecheck, lint, tests)

.PHONY: typecheck
typecheck:  ## Type-check without emitting
	$(BUN) run typecheck

.PHONY: lint
lint:  ## Lint and format-check with Biome
	$(BUN) run lint

.PHONY: fmt
fmt:  ## Apply Biome formatting + safe fixes
	$(BUN) run lint:fix

.PHONY: test
test:  ## Run the Vitest harness suite
	$(BUN) run test

# ---- run ---------------------------------------------------------------

.PHONY: run
run:  ## Run the CLI; pass flags via ARGS, e.g. make run ARGS="validate"
	$(BUN) run ftest -- $(ARGS)

# ---- docs --------------------------------------------------------------

.PHONY: docs docs-serve
docs:  ## Build the mkdocs site into site-build/
	uv sync --locked --group docs && uv run --locked zensical build --strict

docs-serve:  ## Serve the docs locally with live reload
	uv sync --locked --group docs && uv run --locked zensical serve

# ---- misc --------------------------------------------------------------

.PHONY: clean
clean:  ## Remove build artifacts
	rm -rf site-build coverage reports

.PHONY: help
help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
