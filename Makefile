# AMD Dash — lifecycle management for the local LLM benchmark notebook.
#
# Targets:
#   make install   create .venv and install requirements.txt
#   make run       run the app locally (native Python, port 5000)
#   make stop      stop a locally-running app (kills app.py on this port)
#   make build     build the Docker image
#   make up        start a fresh Docker container (teardown, rebuild, up)
#   make down      stop the Docker container (compose down)
#   make clean     remove local build artifacts (.venv, __pycache__)
#   make help      show this help

.PHONY: help install run stop build up down fresh clean

PYTHON ?= .venv/bin/python
PIP     = .venv/bin/pip
PORT   ?= 5000

help:
	@echo "AMD Dash lifecycle targets:"
	@echo "  make install   create .venv and install requirements.txt"
	@echo "  make run       run the app locally (port $(PORT))"
	@echo "  make stop      stop a locally-running app"
	@echo "  make build     build the Docker image (amd-dash)"
	@echo "  make up        start a fresh Docker container (teardown, rebuild, up)"
	@echo "  make down      stop Docker container via compose"
	@echo "  make clean     remove local build artifacts"

install:
	test -d .venv || python3 -m venv .venv
	$(PIP) install -r requirements.txt

run: install
	$(PYTHON) app.py

stop:
	@# Kill any locally-running app. The [.] avoids pkill matching its own
	@# command line (which would kill make itself).
	@pkill -f "app[.]py" || true
	@echo "Stopped."

build:
	docker build -t amd-dash .

down:
	docker compose down --remove-orphans

# fresh: hard-reset helper — stop/remove the container, then delete the image so
# the next build is guaranteed to start from the current source.
fresh:
	$(MAKE) down
	docker image rm -f amd-dash 2>/dev/null || true

up: fresh
	docker compose up -d --build

clean:
	rm -rf .venv __pycache__ *.pyc
	@echo "Cleaned local artifacts."
