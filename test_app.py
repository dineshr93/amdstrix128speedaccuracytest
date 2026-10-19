# Copyright (c) 2026 Dinesh Ravi
# SPDX-License-Identifier: MIT

"""Minimal smoke tests for the AMD Dash API.

Each test gets a fresh temp data file (AMDASH_DATA_FILE) and a reloaded app
module, since DATA_FILE is resolved at import time.

Run: make test
"""

import importlib

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AMDASH_DATA_FILE", str(tmp_path / "data.yaml"))
    import app as app_module
    importlib.reload(app_module)
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


BASE = {
    "name": "Test Model",
    "mmproj_accuracy": "good",
    "task_accuracy": "untested",
    "prompt_speed": 100,
    "generation_speed": 20,
}


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}


def test_add_and_list(client):
    resp = client.post("/api/benchmarks", json=BASE)
    assert resp.status_code == 201
    created = resp.get_json()
    assert created["name"] == "Test Model"
    assert created["id"]

    listing = client.get("/api/benchmarks").get_json()
    assert len(listing) == 1
    assert listing[0]["id"] == created["id"]


def test_add_missing_name_rejected(client):
    bad = dict(BASE, name="   ")
    resp = client.post("/api/benchmarks", json=bad)
    assert resp.status_code == 400
    assert "name" in resp.get_json()["error"].lower()


def test_add_bad_accuracy_rejected(client):
    resp = client.post("/api/benchmarks", json=dict(BASE, mmproj_accuracy="awesome"))
    assert resp.status_code == 400


def test_add_negative_speed_rejected(client):
    resp = client.post("/api/benchmarks", json=dict(BASE, generation_speed=-5))
    assert resp.status_code == 400


def test_edit_keeps_id(client):
    created = client.post("/api/benchmarks", json=BASE).get_json()
    updated = dict(created, generation_speed=42)
    resp = client.put(f"/api/benchmarks/{created['id']}", json=updated)
    assert resp.status_code == 200
    assert resp.get_json()["id"] == created["id"]
    assert resp.get_json()["generation_speed"] == 42


def test_edit_missing_404(client):
    resp = client.put("/api/benchmarks/nope", json=BASE)
    assert resp.status_code == 404


def test_delete(client):
    created = client.post("/api/benchmarks", json=BASE).get_json()
    assert client.delete(f"/api/benchmarks/{created['id']}").status_code == 200
    assert client.get("/api/benchmarks").get_json() == []
    assert client.delete(f"/api/benchmarks/{created['id']}").status_code == 404


def test_ranking_good_beats_fast_but_bad(client):
    client.post("/api/benchmarks", json=dict(BASE, name="FastBad", mmproj_accuracy="bad",
                                           generation_speed=100))
    client.post("/api/benchmarks", json=dict(BASE, name="SlowGood", mmproj_accuracy="good",
                                           generation_speed=10))
    names = [e["name"] for e in client.get("/api/benchmarks").get_json()]
    assert names == ["SlowGood", "FastBad"]


def test_not_available_accepted_and_ranked_last(client):
    """not_available = no vision projector, so accuracy can never be graded."""
    client.post("/api/benchmarks", json=dict(BASE, name="GradedBad",
                                            mmproj_accuracy="bad", generation_speed=10))
    resp = client.post("/api/benchmarks", json=dict(BASE, name="NoVision",
                                                   mmproj_accuracy="not_available",
                                                   generation_speed=100))
    assert resp.status_code == 201
    names = [e["name"] for e in client.get("/api/benchmarks").get_json()]
    assert names == ["GradedBad", "NoVision"]


# ---------------------------------------------------------------------------
# Store interface (no HTTP): locking, migration and the entry shape are
# testable directly, so no test has to reload the module to vary the store.
# ---------------------------------------------------------------------------

def test_store_round_trip(tmp_path):
    import app as app_module
    store = app_module.BenchmarkStore(tmp_path / "data.yaml")
    entry = app_module.parse_entry(dict(BASE))
    entry["id"] = "abc123"
    store.add(entry)
    assert [e["id"] for e in store.list()] == ["abc123"]

    store.replace("abc123", dict(entry, generation_speed=7))
    assert store.list()[0]["generation_speed"] == 7

    store.remove("abc123")
    assert store.list() == []


def test_store_missing_id_raises(tmp_path):
    import app as app_module
    store = app_module.BenchmarkStore(tmp_path / "data.yaml")
    with pytest.raises(app_module.EntryNotFound):
        store.remove("nope")
    with pytest.raises(app_module.EntryNotFound):
        store.replace("nope", app_module.parse_entry(dict(BASE)))


def test_store_rejects_invalid_entry(tmp_path):
    import app as app_module
    store = app_module.BenchmarkStore(tmp_path / "data.yaml")
    entry = app_module.parse_entry(dict(BASE))
    entry["mmproj_accuracy"] = "awesome"  # bypasses parse_entry on purpose
    with pytest.raises(ValueError):
        store.add(entry)


def test_store_migrates_legacy_entry(tmp_path):
    import app as app_module
    path = tmp_path / "data.yaml"
    path.write_text(
        "- name: Legacy\n"
        "  mmproj_accuracy: good\n"
        "  prompt_speed: 10\n"
        "  generation_speed: 5\n"
        "  local_command: llama-server -m old.gguf\n"
        "  notes: ''\n",
        encoding="utf-8",
    )
    (entry,) = app_module.BenchmarkStore(path).list()
    assert entry["task_accuracy"] == "untested"
    assert entry["local_commands"] == ["llama-server -m old.gguf"]
    assert entry["speculative_decoding"] is False


def test_store_concurrent_adds_lose_nothing(tmp_path):
    import threading
    import app as app_module
    store = app_module.BenchmarkStore(tmp_path / "data.yaml")

    def worker(i):
        entry = app_module.parse_entry(dict(BASE, name="M%d" % i))
        entry["id"] = "id%d" % i
        store.add(entry)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(store.list()) == 8


def test_add_rejects_non_string_notes(client):
    resp = client.post("/api/benchmarks", json=dict(BASE, notes=["not", "text"]))
    assert resp.status_code == 400
