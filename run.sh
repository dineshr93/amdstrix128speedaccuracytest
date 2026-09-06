#!/usr/bin/env bash
# AMD Dash — run the local benchmark notebook.
# Uses the project's .venv if present, otherwise the system python3.

set -euo pipefail
cd "$(dirname "$0")"

PYTHON="python3"
if [ -x ".venv/bin/python" ]; then
  PYTHON=".venv/bin/python"
fi

exec "$PYTHON" app.py "$@"
