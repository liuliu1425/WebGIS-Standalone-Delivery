"""Offline fixtures for NAS metadata queries; no real data reads or frame creation."""
from types import SimpleNamespace

import pytest

from app.services.agent import server_tools_runtime as runtime
from app.services.nas_ondemand import config as nas_config
from app.services.nas_ondemand import fetcher, service as nas_service
from app.services.nas_ondemand import date_index as spatial_timeseries_source

LAYER = "imported-a8940443fd6d"


@pytest.fixture
def nas_index(monkeypatch):
    monkeypatch.setattr(nas_config, "ondemand_target", lambda _: {"product": "smap_raw", "variable": "SM"})
    keys = ["20150101", "20250722", "20250723", "20251231"]
    calls = []

    def listing(product, variable):
        calls.append((product, variable))
        return [{"key": key} for key in keys]

    def forbidden(*args, **kwargs):
        raise AssertionError("A coverage query must not download or create a frame")

    monkeypatch.setattr(spatial_timeseries_source, "daily_index", listing)
    monkeypatch.setattr(fetcher, "download_file", forbidden)
    monkeypatch.setattr(nas_service, "ensure_frame", forbidden)
    monkeypatch.setattr(nas_service, "ensure_layer_frame", forbidden)
    return keys, calls


def test_nas_date_summary_uses_real_selected_index_without_materializing(nas_index):
    keys, calls = nas_index
    result = runtime._nas_daily_availability(LAYER, "20250723")

    assert calls == [("smap_raw", "SM")]
    assert result["status"] == "available"
    assert result["count"] == 4
    assert result["coverage_start"] == keys[0]
    assert result["coverage_end"] == keys[-1]
    assert result["requested_available"] is True
    assert result["daily_switch_supported"] is True
    assert result["file_presence_only"] is True
    assert result["declared_coverage_conflict"] is True
    assert result["declared_coverage"]["start"] == "20150401"
    assert "不保证" in result["note"]


def test_large_remote_index_is_compact_and_missing_date_is_not_inferred(nas_index):
    keys, _ = nas_index
    keys[:] = [f"202507{day:02d}" for day in range(1, 32) if day != 12]
    result = runtime._nas_daily_availability(LAYER, "20250712")

    assert result["count"] == 30
    assert result["requested_available"] is False
    assert len(result["date_samples"]) <= 6
    assert "dates" not in result


def test_remote_failure_is_unknown_not_empty_or_a_fabricated_range(monkeypatch, nas_index):
    def fail(*_):
        raise fetcher.NasUnavailable("fixture-only source outage")

    monkeypatch.setattr(spatial_timeseries_source, "daily_index", fail)
    result = runtime._nas_daily_availability(LAYER)

    assert result["status"] == "source_unavailable"
    assert result["available"] is None
    assert result["count"] is None
    assert result["coverage_start"] is None
    assert "未知" in result["note"]


def test_empty_directory_is_distinct_from_a_connection_failure(nas_index):
    nas_index[0].clear()
    result = runtime._nas_daily_availability(LAYER)
    assert result["status"] == "no_observations"
    assert result["available"] is False
    assert result["count"] == 0


def test_non_daily_omega_and_unregistered_layers_never_query_daily_index(monkeypatch, nas_index):
    monkeypatch.setattr(nas_config, "ondemand_target", lambda _: {"product": "smap_raw", "variable": "OMEGA"})
    result = runtime._nas_daily_availability("fixture-omega")
    assert result["status"] == "non_daily"
    assert result["daily_switch_supported"] is False
    assert nas_index[1] == []

    monkeypatch.setattr(nas_config, "ondemand_target", lambda _: None)
    assert runtime._nas_daily_availability("fixture-static")["status"] == "not_registered"
    assert nas_index[1] == []


def patch_local_coverage(monkeypatch):
    spec = SimpleNamespace(resolve_time_key=lambda *args, **kwargs: "20260202_20260208")
    monkeypatch.setattr(runtime, "_filter_ids", lambda ids, cred: ids)
    monkeypatch.setattr("app.services.layer_catalog.get_layer_descriptor", lambda _: None)
    monkeypatch.setattr("app.services.overlay_registry.get_overlay_spec", lambda _: spec)
    monkeypatch.setattr(runtime, "_local_time_keys", lambda _: ["20250701_20250731", "20260202_20260208"])
    monkeypatch.setattr(runtime, "_ondemand_frame_dates", lambda _: [])
    monkeypatch.setattr(runtime, "_qualified_layer_name", lambda *args, **kwargs: "SMAP 动态 · 土壤水分")
    monkeypatch.setattr(runtime, "_layer_display_name", lambda _: "土壤水分")
    monkeypatch.setattr(runtime, "_layer_identity_fields", lambda *args, **kwargs: {})
    monkeypatch.setattr(runtime, "_value_basis", lambda *args, **kwargs: {})


def test_coverage_separates_local_composites_and_remote_daily_index(monkeypatch, nas_index):
    patch_local_coverage(monkeypatch)
    result = runtime._get_layer_coverage({"catalog_id": LAYER, "include_nas": True}, cred=None)

    assert result["ok"] is True
    assert result["channels"]["local"]["count"] == 2
    assert result["channels"]["local"]["coverage_end"] == "20260208"
    assert result["channels"]["nas"]["coverage_end"] == "20251231"
    assert result["channels"]["nas"]["count"] == 4
    assert result["daily_switch_supported"] is True
    assert result["time_blocks"] == ["20250701_20250731", "20260202_20260208"]
    assert "NAS" in result["availability_summary"]


def test_coverage_retains_local_facts_when_remote_index_fails(monkeypatch, nas_index):
    patch_local_coverage(monkeypatch)

    def fail(*_):
        raise fetcher.NasUnavailable("fixture outage")

    monkeypatch.setattr(spatial_timeseries_source, "daily_index", fail)
    result = runtime._get_layer_coverage({"catalog_id": LAYER, "include_nas": True}, cred=None)

    assert result["ok"] is True
    assert result["channels"]["nas"]["status"] == "source_unavailable"
    assert result["channels"]["local"]["count"] == 2
    assert "未知" in result["availability_summary"]


def test_loaded_frame_checks_do_not_enumerate_remote_source_without_opt_in(monkeypatch, nas_index):
    patch_local_coverage(monkeypatch)
    result = runtime._get_layer_coverage({"catalog_id": LAYER, "time": "20250723"}, cred=None)

    assert result["channels"]["nas"]["status"] == "not_checked"
    assert nas_index[1] == []
    result = runtime._get_layer_coverage({"catalog_id": LAYER, "time": "20250723", "include_nas": True}, cred=None)
    assert result["channels"]["nas"]["requested_available"] is True
    assert nas_index[1] == [("smap_raw", "SM")]
