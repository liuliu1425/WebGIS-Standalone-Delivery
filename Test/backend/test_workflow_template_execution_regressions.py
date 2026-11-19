"""Execution checks for the existing workflow templates."""
from pathlib import Path
from types import SimpleNamespace
import json
import pytest
from app.api.routers.workflow_definition_router import dry_validate_graph
from app.services.workflow_graph_compiler import compile_litegraph_to_workflow_definition
from app.services.workflow_request_resolver import _flatten_ui_workflow_definition

SEEDS = Path(__file__).resolve().parents[2] / "Code/backend/workflow_seeds/system"

@pytest.mark.parametrize("name", ["weather_temperature_grid_demo", "weather_wind_field_demo"])
def test_native_weather_graph_is_not_rejected_as_missing_python_module(name):
    graph = json.loads((SEEDS / (name + ".json")).read_text(encoding="utf-8"))
    result = dry_validate_graph(graph)
    assert result["ok"]
    assert result["workflow_definition"]["metadata"]["engine"] == "weather"

@pytest.mark.parametrize("distance,override", [(500, None), (1500, 750)])
def test_single_tool_canvas_preserves_its_parameters(distance, override):
    graph = json.loads((SEEDS / "analysis_buffer.json").read_text(encoding="utf-8"))
    graph["nodes"][1]["properties"]["distance"] = distance
    compiled = compile_litegraph_to_workflow_definition(**{k: graph[k] for k in ["workflow_id", "nodes", "links"]})
    request = {"workflow_definition": compiled, "algorithm_params": {} if override is None else {"distance": override}}
    output, _, _ = _flatten_ui_workflow_definition(request, descriptor=SimpleNamespace(module_name=None))
    assert output["algorithm_params"]["distance"] == (distance if override is None else override)
    assert output["algorithm_params"]["segments"] == 16
    assert output["algorithm_params"]["distance_unit"] == "meters"
    assert "module_name" not in output["algorithm_params"]

def test_buffer_is_nonempty_and_matches_requested_distance(tmp_path):
    import contracts.job
    from modules.gis_ops import GisBufferModule
    from pyproj import Geod
    ctx = SimpleNamespace(workspace=tmp_path, request=SimpleNamespace(job_id="check", datasource_selection={}),
        runtime_context=SimpleNamespace(run_id="check"), node_id="buffer",
        artifact_store=SimpleNamespace(put=lambda *args, **kwargs: None))
    point = {"type": "FeatureCollection", "features": [{"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [113.2644, 23.1291]}, "properties": {}}]}
    out = GisBufferModule().execute({"points": point}, {"distance": 500, "segments": 16}, ctx)
    geojson = json.loads(Path(out["buffer"]).read_text())
    feature = geojson["features"][0]
    assert feature["properties"]["buffer_distance"] == 500
    ring = feature["geometry"]["coordinates"][0]
    assert len(ring) >= 32
    distances = [Geod(ellps="WGS84").inv(113.2644, 23.1291, x, y)[2] for x,y in ring]
    assert min(distances) == pytest.approx(500, abs=0.1)
    assert max(distances) == pytest.approx(500, abs=0.1)

@pytest.mark.parametrize("distance", [float("nan"), float("inf"), -1])
def test_invalid_buffer_distance_never_becomes_success(tmp_path, distance):
    import contracts.job
    from modules.gis_ops import GisBufferModule
    from modules._raster_ops import RasterOpsValidationError
    point = {"type": "FeatureCollection", "features": [{"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [113.2644, 23.1291]}, "properties": {}}]}
    with pytest.raises(RasterOpsValidationError):
        GisBufferModule().execute({"points": point}, {"distance": distance}, SimpleNamespace(workspace=tmp_path))


@pytest.mark.parametrize("distance", [500, 750])
def test_generated_module_workflow_executes_requested_buffer(tmp_path, distance):
    from contracts.serialization import coerce_job_request
    from runner.dispatch import _build_single_module_workflow
    from runner.runtime import build_runtime_context
    from workflow.executor import WorkflowRunner
    from pyproj import Geod
    point_file = tmp_path / "point.geojson"
    point_file.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature", "geometry": {"type": "Point",
        "coordinates": [113.2644, 23.1291]}, "properties": {}}]}))
    request = coerce_job_request({
        "job_id": "buffer-regression", "pipeline_name": "workflow",
        "task_type": "gis_buffer_analysis", "module_name": "gis_buffer_analysis",
        "region": {"kind": "global", "value": {}},
        "datasource_selection": {"input_path": str(point_file)},
        "algorithm_params": {"distance": distance, "distance_unit": "meters"},
    })
    definition = _build_single_module_workflow(request)
    ctx = build_runtime_context(request, tmp_path / "work")
    result = WorkflowRunner().run(definition, request, ctx)
    feature = result.node_outputs["module_node"]["geojson"]["features"][0]
    assert feature["properties"]["buffer_distance"] == distance
    ring = feature["geometry"]["coordinates"][0]
    assert len(ring) >= 32
    assert all(abs(Geod(ellps="WGS84").inv(113.2644, 23.1291, x, y)[2] - distance) < 0.1 for x, y in ring)


def test_buffer_rejects_empty_export_even_when_computation_is_valid(tmp_path, monkeypatch):
    import shapely
    from modules.gis_ops import GisBufferModule
    from modules._raster_ops import RasterOpsValidationError
    monkeypatch.setattr(shapely, "to_geojson", lambda geom: '{"type":"Polygon","coordinates":[]}')
    point = {"type": "FeatureCollection", "features": [{"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [113.2644, 23.1291]}, "properties": {}}]}
    with pytest.raises(RasterOpsValidationError, match="export contains"):
        GisBufferModule().execute({"points": point}, {"distance": 500}, SimpleNamespace(workspace=tmp_path))
