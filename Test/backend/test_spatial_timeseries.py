import json

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from shared.spatial_timeseries import read_frame, extract_series, validate_geometry
from app.services.spatial_timeseries_service import available_frames, scientific_frames


def raster(
    tmp_path, name="source_20251201.tif", data=None, crs="EPSG:4326", transform=None
):
    values = np.array(
        data if data is not None else [[1, 2], [3, -9999]], dtype="float32"
    )
    path = tmp_path / name
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=values.shape[1],
        height=values.shape[0],
        count=1,
        dtype="float32",
        crs=crs,
        transform=transform or from_origin(0, 2, 1, 1),
        nodata=-9999,
    ) as ds:
        ds.write(values, 1)
    return str(path)


def region():
    return {
        "type": "Polygon",
        "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    }


def test_point_is_containing_cell_and_nodata_is_not_zero(tmp_path):
    path = raster(tmp_path)
    r = read_frame(path, {"mode": "point", "point": [1.8, 1.7]}, lambda: None)
    assert r["value"] == 2 and r["pixel"]["column"] == 1
    assert (
        read_frame(path, {"mode": "point", "point": [1.8, 0.2]}, lambda: None)["value"]
        is None
    )
    assert (
        read_frame(path, {"mode": "point", "point": [20, 20]}, lambda: None)["status"]
        == "outside_data"
    )


def test_region_statistics_ignore_nodata_and_count_centers(tmp_path):
    row = read_frame(
        raster(tmp_path), {"mode": "region", "geometry": region()}, lambda: None
    )
    assert row["count"] == 3 and row["total_count"] == 4
    assert row["coverage"] == 0.75 and row["min"] == 1 and row["max"] == 3
    assert row["mean"] == pytest.approx(2, abs=0.001)
    assert row["std"] == pytest.approx(np.std([1, 2, 3]), abs=0.001)
    assert row["weighting"] == "geodesic_cell_area"


def test_different_grids_project_point_independently(tmp_path):
    from pyproj import Transformer

    x, y = Transformer.from_crs(4326, 6933, always_xy=True).transform(1, 1)
    path = raster(
        tmp_path, crs="EPSG:6933", transform=from_origin(x - 100, y + 100, 100, 100)
    )
    row = read_frame(path, {"mode": "point", "point": [0.9999, 1.0001]}, lambda: None)
    assert row["value"] == 1 and row["grid"]["crs"] == "EPSG:6933"


def test_actual_dates_composites_and_missing_daily_rows(tmp_path):
    raster(tmp_path)
    raster(tmp_path, "source_20251203.tif", [[4, 4], [4, 4]])
    raster(tmp_path, "source_20251201_20251208.tif")
    frames = available_frames(tmp_path)
    assert len(frames) == 3 and sum(f["cadence"] == "period-8d" for f in frames) == 1
    request = dict(
        mode="point",
        point=[0.5, 1.5],
        start="2025-12-01",
        end="2025-12-03",
        cadence="daily",
    )
    result = extract_series(
        {
            "request": request,
            "product": {},
            "frames": [f for f in frames if f["cadence"] == "daily"],
        }
    )
    assert [r["value"] for r in result["rows"]] == [1, None, 4]
    assert result["rows"][1]["status"] == "missing_date"
    assert result["valid_count"] == 2
    json.dumps(result, allow_nan=False)


def test_cancel_during_region_and_missing_file(tmp_path):
    path = raster(tmp_path)

    def cancel():
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        read_frame(path, {"mode": "region", "geometry": region()}, cancel)
    result = extract_series(
        {
            "product": {},
            "request": {"mode": "point", "cadence": "composite"},
            "frames": [
                dict(
                    path=str(tmp_path / "missing.tif"),
                    key="a",
                    start="2025-01-01",
                    end="2025-01-08",
                )
            ],
        }
    )
    assert result["valid_count"] == 0 and result["rows"][0]["status"] == "missing_file"


def test_geometry_rejects_invalid_and_projected_coordinates():
    assert validate_geometry(region())["type"] == "Polygon"
    for coordinates in (
        [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]],
        [[[200, 0], [201, 0], [201, 1], [200, 0]]],
    ):
        with pytest.raises(ValueError):
            validate_geometry({"type": "Polygon", "coordinates": coordinates})


def test_region_coordinates_survive_api_thread_and_workflow_contract():
    from concurrent.futures import ThreadPoolExecutor
    from shared.contracts.api_contracts import (
        AlgorithmWorkflowRequest,
        WorkflowSubmitRequest,
    )

    geometry = {"type": "MultiPolygon", "coordinates": [region()["coordinates"]]}

    def prepare():
        validated = validate_geometry(geometry)
        request = WorkflowSubmitRequest(
            command_type="analysis",
            algorithm_request=AlgorithmWorkflowRequest(
                module_name="spatial_timeseries",
                task_type="spatial_timeseries",
                algorithm_params={"plan": {"request": {"geometry": validated}}},
            ),
        )
        return request.model_dump(mode="json")["algorithm_request"]["algorithm_params"][
            "plan"
        ]["request"]["geometry"]

    with ThreadPoolExecutor(1) as executor:
        assert executor.submit(prepare).result() == geometry


def test_single_and_constant_zero_are_valid(tmp_path):
    path = raster(tmp_path, data=[[0, 0], [0, 0]])
    row = read_frame(path, {"mode": "region", "geometry": region()}, lambda: None)
    assert row["mean"] == 0 and row["std"] == 0 and row["count"] == 4


def test_product_negative_values_are_invalid_but_zero_remains_valid(tmp_path):
    path = raster(tmp_path, data=[[-1, 0], [2, 3]])
    point = read_frame(path, {"mode": "point", "point": [0.5, 1.5]}, lambda: None, "SM")
    assert point["value"] is None and point["count"] == 0
    area = read_frame(
        path, {"mode": "region", "geometry": region()}, lambda: None, "VOD"
    )
    assert area["count"] == 3 and area["min"] == 0 and area["max"] == 3


def test_multiband_is_not_assumed_to_be_daily(tmp_path):
    p = tmp_path / "bands.tif"
    with rasterio.open(
        p,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=2,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(0, 2, 1, 1),
    ) as ds:
        ds.write(np.ones((2, 2, 2), dtype="float32"))
    with pytest.raises(ValueError, match="多波段"):
        read_frame(str(p), {"mode": "point", "point": [0.5, 0.5]}, lambda: None)


def test_different_composite_durations_are_never_mixed(tmp_path):
    for name in [
        "source_20251201_20251231.tif",
        "source_20251201_20251208.tif",
        "source_20251203_20251212.tif",
        "source_20251227_20251231.tif",
    ]:
        raster(tmp_path, name)
    assert {f["cadence"] for f in available_frames(tmp_path)} == {
        "monthly",
        "period-8d",
        "period-10d",
        "period-5d",
    }


def test_omega_daily_cache_is_not_reported_as_daily_observation(tmp_path):
    raster(tmp_path)
    raster(tmp_path, "source_20251201_20251208.tif")
    assert len(scientific_frames(tmp_path, "SM")) == 2
    assert [f["cadence"] for f in scientific_frames(tmp_path, "OMEGA")] == ["period-8d"]


def test_provider_writes_result_without_map_products(tmp_path):
    import sys
    from types import SimpleNamespace

    sys.path.insert(0, "/srv/Code/algorithms/providers/Python")
    from modules.spatial_timeseries import SpatialTimeSeriesModule
    from modules.registry import get_module

    assert get_module("spatial_timeseries").name == "spatial_timeseries"
    raster(tmp_path)
    saved = []
    ctx = SimpleNamespace(
        request=SimpleNamespace(job_id="test-series"),
        runtime_context=SimpleNamespace(run_id="test-series", env={}, tmp_dir=tmp_path),
        workspace=tmp_path,
        logger_adapter=None,
        node_id="series",
        artifact_store=SimpleNamespace(
            put=lambda artifact, payload: saved.append(payload)
        ),
    )
    SpatialTimeSeriesModule().execute(
        {
            "algorithm_params": {
                "plan": {
                    "request": {
                        "mode": "point",
                        "point": [0.5, 1.5],
                        "start": "2025-12-01",
                        "end": "2025-12-01",
                        "cadence": "daily",
                    },
                    "product": {"variable": "SM"},
                    "frames": available_frames(tmp_path),
                }
            }
        },
        {},
        ctx,
    )
    assert saved[0].main_layers == []
    assert (
        json.loads(
            (
                tmp_path
                / "products/spatial_timeseries/test-series/spatial-timeseries.json"
            ).read_text()
        )["valid_count"]
        == 1
    )
