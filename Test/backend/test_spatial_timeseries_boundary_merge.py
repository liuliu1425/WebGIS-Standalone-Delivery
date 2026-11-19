"""Dissolving uploaded regions uses polygon union, never a bbox or stacked parts."""

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from shapely.geometry import shape

from app.api.deps import require_workflow_run_access
from app.api.routers.spatial_timeseries_router import (
    SpatialBoundaryMergeRequest,
    merge_boundary,
    router,
)


def polygon(west, south, east, north, holes=None):
    return {
        "type": "Polygon",
        "coordinates": [
            [[west, south], [east, south], [east, north], [west, north], [west, south]],
            *(holes or []),
        ],
    }


def merge(*geometries):
    return merge_boundary(
        SpatialBoundaryMergeRequest(
            features=[{"type": "Feature", "geometry": g, "properties": {}} for g in geometries]
        ),
        _run_ok=None,
    )


def test_adjacent_regions_dissolve_the_shared_edge():
    result = merge(polygon(0, 0, 1, 1), polygon(1, 0, 2, 1))
    region = shape(result["geometry"])
    assert region.geom_type == "Polygon"
    assert region.is_valid and region.area == pytest.approx(2)
    assert result["feature_count"] == 2


def test_overlapping_regions_are_not_counted_twice():
    result = merge(polygon(0, 0, 2, 2), polygon(1, 0, 3, 2))
    region = shape(result["geometry"])
    assert region.geom_type == "Polygon"
    assert region.area == pytest.approx(6)
    assert region.is_valid


def test_union_preserves_holes_and_separate_parts():
    hole = [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]
    result = merge(polygon(0, 0, 4, 4, [hole]), polygon(6, 0, 7, 1))
    region = shape(result["geometry"])
    assert region.geom_type == "MultiPolygon"
    assert len(region.geoms) == 2
    assert sum(len(part.interiors) for part in region.geoms) == 1
    assert region.area == pytest.approx(13)
    assert region.is_valid


def test_multipolygon_parts_and_separate_features_are_all_included():
    parts = {"type": "MultiPolygon", "coordinates": [
        polygon(0, 0, 1, 1)["coordinates"],
        polygon(3, 0, 4, 1)["coordinates"],
    ]}
    result = merge(parts, polygon(6, 0, 7, 1))
    region = shape(result["geometry"])
    assert len(region.geoms) == 3
    assert region.area == pytest.approx(3)
    assert region.is_valid


@pytest.mark.parametrize("bad", [
    {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]]},
    polygon(180, 0, 181, 1),
])
def test_invalid_boundaries_are_rejected_without_repair_or_bbox(bad):
    with pytest.raises(HTTPException) as exc:
        merge(bad)
    assert exc.value.status_code == 422
    assert "区域边界合并失败" in exc.value.detail


def test_no_polygon_does_not_become_whole_map():
    with pytest.raises(HTTPException) as exc:
        merge({"type": "Point", "coordinates": [0, 0]})
    assert exc.value.status_code == 422


def test_http_contract_and_workflow_permission_dependency():
    app = FastAPI()
    app.include_router(router, prefix="/analysis")
    with TestClient(app) as client:
        assert client.post("/analysis/time-series/boundary/merge", json={"features": []}).status_code in {401, 403}
    app.dependency_overrides[require_workflow_run_access] = lambda: None
    with TestClient(app) as client:
        response = client.post("/analysis/time-series/boundary/merge", json={
            "features": [{"type": "Feature", "geometry": polygon(0, 0, 1, 1)}]
        })
        assert response.status_code == 200
        assert response.json()["feature_count"] == 1
        assert shape(response.json()["geometry"]).area == pytest.approx(1)
        assert client.post("/analysis/time-series/boundary/merge", json={"features": []}).status_code == 422
