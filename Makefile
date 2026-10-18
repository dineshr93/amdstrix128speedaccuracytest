# AMD Dash — lifecycle management for the local LLM benchmark notebook.
# Docker is the only runtime: no local venv, no local Python required.
#
# Targets:
#   make up       build and start the container
#   make down     stop and remove the container
#   make update   pull latest source, rebuild, restart
#   make logs     follow container logs
#   make test     run the pytest suite in a throwaway container
#   make fresh    hard reset (down + drop the image, next build starts clean)
#   make clean    remove local build artifacts
#   make help     show this help

.PHONY: help up down update logs test fresh clean

IMAGE  = amd-dash
COMPOSE = docker compose

help:
	@echo "AMD Dash lifecycle targets:"
	@echo "  make up       build and start the container on :5000"
	@echo "  make down     stop and remove the container"
	@echo "  make update   git pull --ff-only, rebuild, restart"
	@echo "  make logs     follow container logs"
	@echo "  make test     run the pytest suite in a throwaway container"
	@echo "  make fresh    hard reset (down + drop the image)"
	@echo "  make clean    remove local build artifacts"

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down --remove-orphans

# update: the target to run after any source change. Compose rebuilds only what
# actually changed and recreates the container when the image moves.
update:
	git pull --ff-only
	$(COMPOSE) up -d --build

logs:
	$(COMPOSE) logs -f

# Tests run in a container too, so the repo needs no local Python environment.
test:
	docker run --rm -v "$$PWD:/w" -w /w python:3.12-slim \
		sh -c "pip install -q -r requirements.txt -r requirements-dev.txt && python -m pytest test_app.py -q"

# fresh: hard-reset helper — stop/remove the container, then delete the image so
# the next build is guaranteed to start from the current source.
fresh: down
	docker image rm -f $(IMAGE) 2>/dev/null || true

clean:
	rm -rf __pycache__ *.pyc .pytest_cache
	@echo "Cleaned local artifacts."
