# Copyright (c) 2026 Dinesh Ravi
# SPDX-License-Identifier: MIT

"""AMD Dash — Local LLM Benchmark Notebook.

A tiny local-only Flask app that stores benchmark entries in ~/amddash/data.yaml.
Commands stored in entries are never executed; they exist only for reference/copy.

Layout: the entry shape lives in parse_entry/validate_entry/migrate, the data
file is owned by BenchmarkStore (the only thing that locks and writes it), and
the routes are thin adapters that translate HTTP to store calls.
"""

import fcntl
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path

import yaml
from flask import Flask, jsonify, render_template, request

# ---------------------------------------------------------------------------
# Data file location: ~/amddash/data.yaml (the ONLY persistent store).
# Docker deployments override it with AMDASH_DATA_FILE so a host file can be
# mounted at a known location. Local use needs no environment variables.
# ---------------------------------------------------------------------------
DATA_FILE = Path(os.environ["AMDASH_DATA_FILE"]).expanduser() \
    if os.environ.get("AMDASH_DATA_FILE") \
    else Path.home() / "amddash" / "data.yaml"

ALLOWED_ACCURACY = ("good", "unreliable", "bad", "untested", "not_available")

ACCURACY_ORDER = {"good": 0, "unreliable": 1, "bad": 2, "untested": 3, "not_available": 4}

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class StoreError(Exception):
    """The data file could not be read or written."""


class EntryNotFound(StoreError):
    """The requested id is not present in the data file."""


# ---------------------------------------------------------------------------
# Entry shape: one definition, one gate, one migration.
# ---------------------------------------------------------------------------

def migrate(entry):
    """Backfill fields that older data files do not carry.

    Applied on load only; the file is rewritten by the next mutation.
    """
    if not isinstance(entry, dict):
        raise StoreError("data file should contain a YAML list of benchmark dicts")
    for field, value in (
        ("speculative_decoding", False),
        ("mtp_generation_speed", 0),
        ("parameter_info", ""),
        ("task_accuracy", "untested"),
        ("favorite", False),
    ):
        entry.setdefault(field, value)
    if "local_commands" not in entry:
        lc = entry.get("local_command", "")
        entry["local_commands"] = [lc] if isinstance(lc, str) and lc.strip() else []
    return entry


def _clean_text(raw, field):
    """Return a stripped string for a text field."""
    value = raw.get(field)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    return value.strip()


def _clean_accuracy(raw, field):
    value = (raw.get(field) or "").strip().lower()
    if value not in ALLOWED_ACCURACY:
        raise ValueError(f"{field} must be one of " + ", ".join(ALLOWED_ACCURACY))
    return value


def _clean_number(raw, field):
    try:
        value = float(raw.get(field) or 0)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number")
    if value < 0:
        raise ValueError(f"{field} must be a non-negative number")
    return int(value) if value.is_integer() else value


def _clean_bool(raw, field):
    value = raw.get(field, False)
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def _clean_commands(raw):
    """Accept a list, a single string, or a JSON-encoded array in a string."""
    cmds = raw.get("local_commands")
    if cmds is None or cmds == "":
        cmds = raw.get("local_command") or ""
    if isinstance(cmds, str):
        if cmds.strip() == "":
            cmds = []
        else:
            try:
                parsed = json.loads(cmds)
            except (ValueError, TypeError):
                parsed = [cmds]
            cmds = parsed if isinstance(parsed, list) else [cmds]
    if not isinstance(cmds, list) or not all(isinstance(c, str) for c in cmds):
        raise ValueError("local_commands must be a list of command strings")
    return [c for c in cmds if c.strip()]


# ---------------------------------------------------------------------------
# Field rules for an entry read from the data file (no coercion, only validation).
# ---------------------------------------------------------------------------

def validate_entry(entry):
    """Raise ValueError unless `entry` is a complete, well-typed benchmark.

    The store calls this on every write, so no caller can persist a shape the
    rest of the app cannot read back.
    """
    if not isinstance(entry, dict):
        raise ValueError("Invalid benchmark data.")
    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Invalid benchmark data.")
    for field in ("mmproj_accuracy", "task_accuracy"):
        if entry.get(field) not in ALLOWED_ACCURACY:
            raise ValueError("Invalid benchmark data.")
    for field in ("prompt_speed", "generation_speed", "mtp_generation_speed"):
        value = entry.get(field)
        if value is None:
            raise ValueError("Invalid benchmark data.")
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValueError("Invalid benchmark data.")
        if value < 0:
            raise ValueError("Invalid benchmark data.")
    if not isinstance(entry.get("speculative_decoding"), bool):
        raise ValueError("Invalid benchmark data.")
    if not isinstance(entry.get("favorite"), bool):
        raise ValueError("Invalid benchmark data.")
    for field in ("parameter_info", "notes", "model_url", "local_command"):
        if field in entry and not isinstance(entry[field], str):
            raise ValueError("Invalid benchmark data.")
    cmds = entry.get("local_commands")
    if cmds is not None and (not isinstance(cmds, list) or not all(isinstance(c, str) for c in cmds)):
        raise ValueError("Invalid benchmark data.")
    return entry


# ---------------------------------------------------------------------------
# HTTP input -> clean benchmark dict.
# ---------------------------------------------------------------------------

def parse_entry(raw):
    """Coerce a raw form dict into a clean benchmark dict, validating types.

    Raises ValueError with a friendly message on bad input.
    """
    if not isinstance(raw, dict):
        raise ValueError("Invalid benchmark data.")
    name = _clean_text(raw, "name")
    if not name:
        raise ValueError("Model name is required.")
    commands = _clean_commands(raw)
    entry = {
        "id": _clean_text(raw, "id") or None,
        "name": name,
        "model_url": _clean_text(raw, "model_url"),
        "local_command": commands[0] if commands else "",
        "local_commands": commands,
        "mmproj_accuracy": _clean_accuracy(raw, "mmproj_accuracy"),
        "task_accuracy": _clean_accuracy(raw, "task_accuracy"),
        "prompt_speed": _clean_number(raw, "prompt_speed"),
        "generation_speed": _clean_number(raw, "generation_speed"),
        "speculative_decoding": _clean_bool(raw, "speculative_decoding"),
        "favorite": _clean_bool(raw, "favorite"),
        "mtp_generation_speed": _clean_number(raw, "mtp_generation_speed"),
        "parameter_info": _clean_text(raw, "parameter_info"),
        "notes": _clean_text(raw, "notes"),
    }
    return validate_entry(entry)


# ---------------------------------------------------------------------------
# The store: the only reader/writer of the data file.
# ---------------------------------------------------------------------------

class BenchmarkStore:
    """One YAML file, four whole transactions.

    Every mutating method holds the cross-process lock across its entire
    read-modify-write, so no caller has to remember the rule and no two
    concurrent requests can drop an update. Callers never touch the file.
    """

    def __init__(self, path):
        self.path = Path(path).expanduser()
        self.dir = self.path.parent

    def list(self):
        return self._load()

    def add(self, entry):
        validate_entry(entry)
        with self._lock():
            entries = self._load()
            entries.append(entry)
            self._save(entries)
        return entry

    def replace(self, entry_id, entry):
        validate_entry(entry)
        with self._lock():
            entries = self._load()
            index = next((i for i, e in enumerate(entries) if e.get("id") == entry_id), None)
            if index is None:
                raise EntryNotFound("Benchmark not found.")
            entry["id"] = entry_id
            entries[index] = entry
            self._save(entries)
        return entry

    def remove(self, entry_id):
        with self._lock():
            entries = self._load()
            remaining = [e for e in entries if e.get("id") != entry_id]
            if len(remaining) == len(entries):
                raise EntryNotFound("Benchmark not found.")
            self._save(remaining)

    # -- implementation ---------------------------------------------------

    def _load(self):
        """Load the benchmark list, migrating older entries in memory.

        A missing file is initialized to an empty list. Invalid YAML raises
        StoreError instead of silently destroying the data.
        """
        if not self.path.exists():
            self._save([])
            return []
        with open(self.path, "r", encoding="utf-8") as fh:
            text = fh.read().strip()
        if not text:
            return []
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise StoreError(f"{self.path} could not be parsed as YAML") from exc
        if data is None:
            return []
        if not isinstance(data, list):
            raise StoreError(f"{self.path} should contain a YAML list of benchmarks")
        return [migrate(entry) for entry in data]

    def _save(self, entries):
        """Atomically write the benchmark list.

        Writes to a temp file in the same directory, flushes, then replaces the
        real file so a failed write never corrupts the existing data.
        """
        self.dir.mkdir(parents=True, exist_ok=True)
        payload = yaml.safe_dump(entries, allow_unicode=False, sort_keys=False)
        fd, tmp_path = tempfile.mkstemp(dir=str(self.dir), prefix="data.", suffix=".tmp")
        try:
            # mkstemp creates a 0600 file; widen to 0644 so the data file stays
            # readable by the host user even when UID/GID mapping differs (Docker).
            os.chmod(tmp_path, 0o644)
            with os.fdopen(fd, "w", encoding="ascii", errors="strict") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, str(self.path))
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    @contextmanager
    def _lock(self):
        """Exclusive cross-process lock over the data file."""
        self.dir.mkdir(parents=True, exist_ok=True)
        with open(self.dir / ".lock", "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Sorting / ranking
# ---------------------------------------------------------------------------

def rank_key(entry):
    """Sort key: favorites first, then MMProj quality, then generation speed
    descending, then prompt speed descending."""
    accuracy = entry.get("mmproj_accuracy")
    if accuracy not in ACCURACY_ORDER:
        raise ValueError(f"mmproj_accuracy {accuracy!r} is not in ACCURACY_ORDER")
    return (
        0 if entry.get("favorite") else 1,
        ACCURACY_ORDER[accuracy],
        -float(entry.get("generation_speed", 0) or 0),
        -float(entry.get("prompt_speed", 0) or 0),
    )


def ranked(entries):
    return sorted(entries, key=rank_key)


def gen_id(name):
    """Generate a unique id: slug of the name plus a short random suffix."""
    slug = "".join(c.lower() if c.isalnum() else "-" for c in (name or ""))
    slug = "-".join(x for x in slug.split("-") if x)
    return (slug + "-" if slug else "benchmark-") + uuid.uuid4().hex[:6]


# ---------------------------------------------------------------------------
# Flask app — thin adapters over the store.
# ---------------------------------------------------------------------------

app = Flask(__name__)

store = BenchmarkStore(DATA_FILE)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    """Liveness probe for Docker/orchestrators: 200 when the app is up."""
    return jsonify({"ok": True})


@app.route("/api/benchmarks", methods=["GET"])
def list_benchmarks():
    try:
        entries = ranked(store.list())
    except (StoreError, ValueError) as exc:
        app.logger.error("Failed to load %s: %s", store.path, exc)
        return jsonify({"error": f"Could not load {store.path}."}), 500
    return jsonify(entries)


@app.route("/api/benchmarks", methods=["POST"])
def add_benchmark():
    raw = request.get_json(silent=True) or {}
    try:
        entry = parse_entry(raw)
        entry["id"] = gen_id(entry["name"])
        store.add(entry)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except StoreError as exc:
        app.logger.error("Failed to add benchmark (%s): %s", store.path, exc)
        return jsonify({"error": f"Could not load or save {store.path}."}), 500
    return jsonify(entry), 201


@app.route("/api/benchmarks/<entry_id>", methods=["PUT"])
def edit_benchmark(entry_id):
    raw = request.get_json(silent=True) or {}
    try:
        entry = parse_entry(raw)
        store.replace(entry_id, entry)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except EntryNotFound:
        return jsonify({"error": "Benchmark not found."}), 404
    except StoreError as exc:
        app.logger.error("Failed to edit benchmark (%s): %s", store.path, exc)
        return jsonify({"error": f"Could not load or save {store.path}."}), 500
    return jsonify(entry)


@app.route("/api/benchmarks/<entry_id>", methods=["DELETE"])
def delete_benchmark(entry_id):
    try:
        store.remove(entry_id)
    except EntryNotFound:
        return jsonify({"error": "Benchmark not found."}), 404
    except StoreError as exc:
        app.logger.error("Failed to delete benchmark (%s): %s", store.path, exc)
        return jsonify({"error": f"Could not load or save {store.path}."}), 500
    return jsonify({"ok": True})
