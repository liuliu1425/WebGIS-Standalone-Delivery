"""Workflow definitions must not write into shared scientific data."""
from pathlib import Path
from dataclasses import replace
import json
import pytest
from app.core import config
from app.services import workflow_definition_service as wds

@pytest.mark.parametrize("runtime", ["", "   "])
def test_legacy_definitions_remain_available_without_runtime_override(tmp_path, monkeypatch, runtime):
    monkeypatch.setenv("BACKEND_RUNTIME_ROOT", runtime)
    monkeypatch.setattr(config, "settings", replace(config.settings, data_root=str(tmp_path)))
    saved = tmp_path / "workflow_definitions" / "user"
    saved.mkdir(parents=True)
    (saved / "existing.json").write_text(json.dumps({
        "workflow_id": "existing", "nodes": [], "links": [],
        "_meta": {"kind": "user", "name": "Saved", "readonly": False}
    }), encoding="utf-8")
    monkeypatch.setattr(wds, "_SEED_SYSTEM_DIR", tmp_path / "no-seeds")
    assert any(d["workflow_id"] == "existing" for d in wds.list_definitions())

def test_readonly_data_and_writable_runtime_support_seed_and_user_lifecycle(tmp_path, monkeypatch):
    raw = tmp_path / "science"
    runtime = tmp_path / "runtime"
    seeds = tmp_path / "seeds"
    raw.mkdir()
    seeds.mkdir()
    untouched = raw / "workflow_definitions" / "system"
    untouched.mkdir(parents=True)
    (untouched / "formal.json").write_text("keep", encoding="utf-8")
    monkeypatch.setenv("BACKEND_RUNTIME_ROOT", str(runtime))
    monkeypatch.setattr(config, "settings", replace(config.settings, data_root=str(raw)))
    monkeypatch.setattr(wds, "_SEED_SYSTEM_DIR", seeds)
    monkeypatch.setattr(wds, "_SEED_SYNC_DONE", False)
    (seeds / "sample.json").write_text(json.dumps({
        "workflow_id": "sample", "nodes": [{"id": 1, "type": "data/source",
        "properties": {"path": "{DATA_ROOT}/sample.tif"}}], "links": [],
        "_meta": {"kind": "system", "name": "Sample", "readonly": True, "is_template": True}
    }), encoding="utf-8")
    mkdir = Path.mkdir
    def deny_scientific_writes(path, *args, **kwargs):
        if path == raw or raw in path.parents:
            raise PermissionError("Scientific data is read-only")
        return mkdir(path, *args, **kwargs)
    monkeypatch.setattr(Path, "mkdir", deny_scientific_writes)
    items = wds.list_definitions()
    assert [d["workflow_id"] for d in items] == ["sample"]
    definition = wds.get_definition("sample")
    assert definition["nodes"][0]["properties"]["path"] == raw.as_posix() + "/sample.tif"
    copy = wds.duplicate_definition("sample", "copy", owner_user_id=123)
    assert copy["_meta"]["kind"] == "user"
    assert copy["_meta"]["owner_user_id"] == 123
    assert (runtime / "workflow_definitions/user/copy.json").is_file()
    wds.update_definition("copy", {"name": "Updated"})
    assert wds.get_definition("copy")["_meta"]["name"] == "Updated"
    assert wds.delete_definition("copy")
    assert (untouched / "formal.json").read_text(encoding="utf-8") == "keep"
    assert list((raw / "workflow_definitions").iterdir()) == [untouched]
    assert not (untouched / "sample.json").exists()
    with pytest.raises(ValueError):
        wds.delete_definition("sample")

def test_relative_runtime_path_is_anchored_to_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("BACKEND_RUNTIME_ROOT", "isolated-state")
    monkeypatch.setattr(wds, "_BACKEND_ROOT", tmp_path)
    assert wds.definitions_root() == tmp_path / "isolated-state/workflow_definitions"
