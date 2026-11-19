from copy import deepcopy
import pytest

from app.services.user_workspace_store import UserWorkspaceStore

SCOPE = "http://127.0.0.1:15175"


def payload(ids=("aridity-cn", "keep"), *, removed=False, restored=False, schema=3):
    dismissed = {"catalogIds": ["aridity-cn"] if removed else [], "overlayLayerIds": [],
                 "vectorBackendLayerIds": [], "runIds": []}
    if removed or restored:
        dismissed["operations"] = {"catalogIds:aridity-cn": {
            "removed": removed, "changedAt": 200 if restored else 100}}
    return {"version": 2, "scopes": {SCOPE: {"snapshot": {
        "version": 1, "schemaVersion": schema, "savedAt": "2026-11-15T01:00:00Z",
        "layers": [], "groups": [],
        "catalogLayers": [{"instanceId": x, "catalogId": x, "visible": x == "keep",
                           "opacity": 0.9, "order": i} for i, x in enumerate(ids)],
    }, "dismissed": dismissed}}}


def test_stale_browser_write_cannot_resurrect_removed_layer(tmp_path):
    store = UserWorkspaceStore(tmp_path / "workspace.sqlite")
    try:
        store.put(1, payload(("keep",), removed=True), 0)
        stale = payload()
        original = deepcopy(stale)
        result = store.put(1, stale, 1)
        bundle = result.payload["scopes"][SCOPE]
        assert [x["catalogId"] for x in bundle["snapshot"]["catalogLayers"]] == ["keep"]
        assert bundle["dismissed"]["catalogIds"] == ["aridity-cn"]
        assert stale == original
        assert store.get(1).payload == result.payload
    finally:
        store.close()


def test_explicit_readd_then_remove_again_survives_roundtrip(tmp_path):
    store = UserWorkspaceStore(tmp_path / "workspace.sqlite")
    try:
        store.put(1, payload(("keep",), removed=True), 0)
        added = store.put(1, payload(restored=True), 1)
        assert added.payload["scopes"][SCOPE]["dismissed"]["catalogIds"] == []
        assert len(added.payload["scopes"][SCOPE]["snapshot"]["catalogLayers"]) == 2
        removed = payload(("keep",), removed=True)
        removed["scopes"][SCOPE]["dismissed"]["operations"]["catalogIds:aridity-cn"]["changedAt"] = 300
        store.put(1, removed, 2)
        stale = store.put(1, payload(restored=True), 3)
        assert stale.payload["scopes"][SCOPE]["dismissed"]["catalogIds"] == ["aridity-cn"]
        assert len(stale.payload["scopes"][SCOPE]["snapshot"]["catalogLayers"]) == 1
    finally:
        store.close()


@pytest.mark.parametrize("different", ["user", "scope", "schema"])
def test_removals_do_not_cross_user_scope_or_schema(tmp_path, different):
    store = UserWorkspaceStore(tmp_path / "workspace.sqlite")
    try:
        store.put(1, payload(("keep",), removed=True), 0)
        candidate = payload(schema=4 if different == "schema" else 3)
        user_id = 2 if different == "user" else 1
        if different == "scope":
            candidate["scopes"]["https://other.example"] = candidate["scopes"].pop(SCOPE)
        result = store.put(user_id, candidate, 0 if different == "user" else 1)
        bundle = next(iter(result.payload["scopes"].values()))
        assert len(bundle["snapshot"]["catalogLayers"]) == 2
        assert bundle["dismissed"]["catalogIds"] == []
    finally:
        store.close()


def test_legacy_registry_without_operations_is_preserved(tmp_path):
    store = UserWorkspaceStore(tmp_path / "workspace.sqlite")
    try:
        old = payload(("keep",), removed=True)
        del old["scopes"][SCOPE]["dismissed"]["operations"]
        store.put(1, old, 0)
        result = store.put(1, payload(), 1)
        assert len(result.payload["scopes"][SCOPE]["snapshot"]["catalogLayers"]) == 1
    finally:
        store.close()

