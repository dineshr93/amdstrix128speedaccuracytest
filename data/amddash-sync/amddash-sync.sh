#!/usr/bin/env bash
# amddash-sync.sh — copy ~/amddash/data.yaml into the repo's data/data.yaml
# and auto-commit+push on every change. Triggered by the systemd path unit
# amddash-sync.path (kernel inotify) so it runs immediately on any update.
set -euo pipefail

SRC="$HOME/amddash/data.yaml"
REPO="$HOME/repos/amdstrix128speedaccuracytest"
DEST="data/data.yaml"
LOCK="$HOME/.amddash-sync.lock"

# Single-run lock so rapid path-unit firings never pile up commits.
exec 9>"$LOCK"
flock 9

# No-op unless the source actually differs from what's in the repo.
if ! diff -q "$SRC" "$REPO/$DEST" >/dev/null 2>&1; then
    cp "$SRC" "$REPO/$DEST"
    cd "$REPO"
    git add -- "$DEST"
    if ! git diff --cached --quiet; then
        git commit -m "Auto-sync data.yaml from ~/amddash/data.yaml ($(date '+%F %T'))"
        # Push; rebase first if the remote moved so we stay fast-forward.
        if git push origin main 2>/dev/null; then
            :
        else
            git pull --rebase origin main >/dev/null 2>&1 || true
            git push origin main
        fi
    fi
fi
