# Copyright (c) 2026 Dinesh Ravi
# SPDX-License-Identifier: MIT

"""AMD Dash — Local LLM Benchmark Notebook.

A tiny local-only Flask app that stores benchmark entries in ~/amddash/data.yaml.
Commands stored in entries are never executed; they exist only for reference/copy.
"""

import os
import tempfile
from pathlib import Path

from flask import Flask, jsonify, render_template, request

import yaml

# ---------------------------------------------------------------------------
# Data file location: ~/amddash/data.yaml  (the ONLY persistent store).
# ---------------------------------------------------------------------------
# Data file location. Defaults to ~/amddash/data.yaml (the ONLY persistent
# store). For Docker deployments the path can be overridden with the
# AMDASH_DATA_FILE env var so a host file can be mounted at a known location.
# Local use needs no environment variables at all.
# ---------------------------------------------------------------------------
DATA_FILE = Path(os.environ.get("AMDASH_DATA_FILE", "")).expanduser() \
    if os.environ.get("AMDASH_DATA_FILE") \
    else Path.home() / "amddash" / "data.yaml"
DATA_DIR = DATA_FILE.parent

ALLOWED_ACCURACY = ("good", "unreliable", "bad")

ACCURACY_ORDER = {"good": 0, "unreliable": 1, "bad": 2}

# ---------------------------------------------------------------------------
# YAML helpers
# ---------------------------------------------------------------------------

def load_entries():
    """Load the benchmark list from ~/amddash/data.yaml.

    Returns a list of dicts (unsorted). If the file is missing, it is
    initialized to an empty list. If the file exists but is invalid YAML,
    raise a ValueError instead of silently destroying the data.
    """
    if not DATA_FILE.exists():
        save_entries([])  # initialize an empty data file
        return []
    with open(DATA_FILE, "r", encoding="utf-8") as fh:
        text = fh.read().strip()
    if not text:  # empty file -> treat as empty list, then normalize it
        return []
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"{DATA_FILE} could not be parsed as YAML") from exc
    if data is None:  # file contained only comments / no document
        return []
    if not isinstance(data, list):
        raise ValueError(f"{DATA_FILE} should contain a YAML list of benchmarks")
    
    # Ensure backward compatibility with existing data files
    entries = list(data)
    for entry in entries:
        if 'speculative_decoding' not in entry:
            entry['speculative_decoding'] = False
        if 'mtp_generation_speed' not in entry:
            entry['mtp_generation_speed'] = 0
        if 'parameter_info' not in entry:
            entry['parameter_info'] = ""
            
    return entries


def save_entries(entries):
    """Atomically write the benchmark list to ~/amddash/data.yaml.

    Writes to a temp file in the same directory, flushes, then replaces the
    real file so a failed write never corrupts the existing data.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = yaml.safe_dump(entries, allow_unicode=False, sort_keys=False)
    fd, tmp_path = tempfile.mkstemp(dir=str(DATA_DIR), prefix="data.", suffix=".tmp")
    try:
        # mkstemp creates a 0600 file; widen to 0644 so the data file stays
        # readable by the host user even when UID/GID mapping differs (Docker).
        os.chmod(tmp_path, 0o644)
        with os.fdopen(fd, "w", encoding="ascii", errors="strict") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, str(DATA_FILE))
    except Exception:
        # clean up the temp file if anything went wrong
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Sorting / ranking
# ---------------------------------------------------------------------------

def rank_key(entry):
    """Sort key: MMProj quality first (good < unreliable < bad), then
    generation speed descending, then prompt speed descending."""
    return (
        ACCURACY_ORDER.get(entry.get("mmproj_accuracy", "bad"), 2),
        -float(entry.get("generation_speed", 0) or 0),
        -float(entry.get("prompt_speed", 0) or 0),
    )


def ranked(entries):
    return sorted(entries, key=rank_key)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_entries(entries):
    """Return True if every entry is valid. Used before saving."""
    for e in entries:
        if not isinstance(e, dict):
            return False
        name = e.get("name")
        if not name or not isinstance(name, str) or not name.strip():
            return False
        if e.get("mmproj_accuracy") not in ALLOWED_ACCURACY:
            return False
        for field in ("prompt_speed", "generation_speed"):
            v = e.get(field)
            if v is None:
                return False
            try:
                f = float(v)
            except (TypeError, ValueError):
                return False
            if f < 0:
                return False
        # Validate new fields
        if 'speculative_decoding' in e and not isinstance(e['speculative_decoding'], bool):
            return False
        if 'mtp_generation_speed' in e:
            v = e.get('mtp_generation_speed')
            if v is None:
                return False
            try:
                f = float(v)
            except (TypeError, ValueError):
                return False
            if f < 0:
                return False
        if 'parameter_info' in e and not isinstance(e['parameter_info'], str):
            return False
    return True


def normalize_entry(raw):
    """Coerce a raw form dict into a clean benchmark dict, validating types.

    Raises ValueError with a friendly message on bad input.
    """
    name = (raw.get("name") or "").strip()
    if not name:
        raise ValueError("Model name is required.")
    accuracy = (raw.get("mmproj_accuracy") or "").strip().lower()
    if accuracy not in ALLOWED_ACCURACY:
        raise ValueError("mmproj_accuracy must be good, unreliable, or bad.")
    try:
        prompt = float(raw.get("prompt_speed") or 0)
    except (TypeError, ValueError):
        raise ValueError("Prompt speed must be a number.")
    try:
        gen = float(raw.get("generation_speed") or 0)
    except (TypeError, ValueError):
        raise ValueError("Generation speed must be a number.")
    if prompt < 0 or gen < 0:
        raise ValueError("Speeds must be non-negative numbers.")
    
    # Handle speculative decoding and MTP generation speed
    speculative_decoding = bool(raw.get("speculative_decoding", False))
    try:
        mtp_gen = float(raw.get("mtp_generation_speed") or 0)
    except (TypeError, ValueError):
        raise ValueError("MTP generation speed must be a number.")
    if mtp_gen < 0:
        raise ValueError("MTP generation speed must be a non-negative number.")
        
    parameter_info = (raw.get("parameter_info") or "").strip()

    entry = {
        "id": (raw.get("id") or "").strip() or None,
        "name": name,
        "model_url": (raw.get("model_url") or "").strip(),
        "local_command": raw.get("local_command") or "",
        "mmproj_accuracy": accuracy,
        "prompt_speed": prompt,
        "generation_speed": gen,
        "notes": raw.get("notes") or "",
        "speculative_decoding": speculative_decoding,
        "mtp_generation_speed": mtp_gen,
        "parameter_info": parameter_info,
    }
    # speeds: keep the number clean (int if integral, else float)
    entry["prompt_speed"] = int(prompt) if prompt.is_integer() else prompt
    entry["generation_speed"] = int(gen) if gen.is_integer() else gen
    entry["mtp_generation_speed"] = int(mtp_gen) if mtp_gen.is_integer() else mtp_gen
    return entry


def gen_id(existing_ids):
    """Generate a stable, unique id. Prefers a slug from the name, then adds
    a short random suffix to guarantee uniqueness."""
    import random
    import string
    import uuid

    suffix = uuid.uuid4().hex[:6]
    base = "benchmark-" + suffix
    # try to base it on the name if available
    name = existing_ids.get("__name__", "")
    if name:
        slug = "".join(c.lower() if c.isalnum() else "-" for c in name)
        slug = "-".join(x for x in slug.split("-") if x)
        base = slug + "-" + suffix
    return base


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/benchmarks", methods=["GET"])
def list_benchmarks():
    try:
        entries = ranked(load_entries())
    except Exception as exc:
        app.logger.error("Failed to load %s: %s", DATA_FILE, exc)
        return jsonify({"error": f"Could not load {DATA_FILE}."}), 500
    return jsonify(entries)


@app.route("/api/benchmarks", methods=["POST"])
def add_benchmark():
    try:
        entries = load_entries()
    except Exception as exc:
        app.logger.error("Failed to load %s: %s", DATA_FILE, exc)
        return jsonify({"error": f"Could not load {DATA_FILE}."}), 500

    raw = request.get_json(silent=True) or {}
    try:
        entry = normalize_entry(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    entry["id"] = gen_id({"__name__": entry["name"]})
    entries.append(entry)
    if not validate_entries(entries):
        return jsonify({"error": "Invalid benchmark data."}), 400
    try:
        save_entries(entries)
    except Exception as exc:
        app.logger.error("Failed to save: %s", exc)
        return jsonify({"error": "Could not save benchmark."}), 500
    return jsonify(entry), 201


@app.route("/api/benchmarks/<entry_id>", methods=["PUT"])
def edit_benchmark(entry_id):
    try:
        entries = load_entries()
    except Exception as exc:
        app.logger.error("Failed to load %s: %s", DATA_FILE, exc)
        return jsonify({"error": f"Could not load {DATA_FILE}."}), 500

    raw = request.get_json(silent=True) or {}
    try:
        entry = normalize_entry(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    target = next((e for e in entries if e.get("id") == entry_id), None)
    if target is None:
        return jsonify({"error": "Benchmark not found."}), 404

    entry["id"] = entry_id  # keep the stable id
    index = entries.index(target)
    entries[index] = entry
    if not validate_entries(entries):
        return jsonify({"error": "Invalid benchmark data."}), 400
    try:
        save_entries(entries)
    except Exception as exc:
        app.logger.error("Failed to save: %s", exc)
        return jsonify({"error": "Could not save benchmark."}), 500
    return jsonify(entry)


@app.route("/api/benchmarks/<entry_id>", methods=["DELETE"])
def delete_benchmark(entry_id):
    try:
        entries = load_entries()
    except Exception as exc:
        app.logger.error("Failed to load %s: %s", DATA_FILE, exc)
        return jsonify({"error": f"Could not load {DATA_FILE}."}), 500

    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        return jsonify({"error": "Benchmark not found."}), 404
    try:
        save_entries(remaining)
    except Exception as exc:
        app.logger.error("Failed to save: %s", exc)
        return jsonify({"error": "Could not save benchmark."}), 500
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    host = os.environ.get("AMDASH_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("AMDASH_PORT", "5000"))
    except ValueError:
        port = 5000
    print(f"AMD Dash running at http://{host}:{port}")
    print(f"Benchmark data: {DATA_FILE}")
    app.run(host=host, port=port)


if __name__ == "__main__":
    main()
