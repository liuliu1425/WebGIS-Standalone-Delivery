"""Spatial series share workflow auth, queue, cancellation and result storage."""

from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from app.api.deps import (
    CredentialContext,
    get_request_user,
    require_workflow_run_access,
    check_resource_access,
)
from app.services.spatial_timeseries_service import list_products, build_plan, product_availability
from app.services.nas_ondemand.config import NasConfigurationError
from app.services.nas_ondemand.fetcher import NasError
from app.services.workflow.service_container import submission_service
from app.services.workflow.submission_service import WorkflowValidationError
from shared.contracts.api_contracts import (
    WorkflowSubmitRequest,
    AlgorithmWorkflowRequest,
    WorkflowAcceptedResponse,
)

router = APIRouter(prefix="/time-series", tags=["spatial-time-series"])


class SpatialSeriesRequest(BaseModel):
    product_id: str
    mode: Literal["point", "region"]
    point: tuple[float, float] | None = None
    geometry: dict | None = None
    location_name: str = Field(default="", max_length=160)
    start: str
    end: str
    cadence: str = Field(pattern=r"^(daily|monthly|period-[1-9]\d*d)$")
    statistic: Literal["mean", "std", "min", "max"] = "mean"


@router.get("/products")
def products(cred: CredentialContext | None = Depends(get_request_user)):
    return {"items": list_products(cred)}


@router.get("/products/{product_id}/availability")
def availability(product_id: str, cred: CredentialContext | None = Depends(get_request_user)):
    if cred:
        check_resource_access(cred, "layer", product_id)
    try:
        return product_availability(product_id, cred)
    except (NasError, NasConfigurationError) as exc:
        raise HTTPException(503, detail={"code": "source_unavailable", "user_message":
            "数据源连接失败，无法读取该产品真实观测日期；请检查测试版 NAS 连接后重试。"}) from exc
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc


class SpatialBoundaryMergeRequest(BaseModel):
    features: list[dict] = Field(min_length=1)


@router.post("/boundary/merge")
def merge_boundary(
    payload: SpatialBoundaryMergeRequest,
    _run_ok: None = Depends(require_workflow_run_access),
):
    """Dissolve uploaded WGS84 polygons without changing source boundaries."""
    import json

    from shapely import to_geojson
    from shapely.errors import GEOSException
    from shapely.geometry import shape
    from shapely.ops import unary_union
    from shared.spatial_timeseries import validate_geometry

    try:
        geometries = [
            feature.get("geometry")
            for feature in payload.features
            if isinstance(feature.get("geometry"), dict)
            and feature["geometry"].get("type") in {"Polygon", "MultiPolygon"}
        ]
        if not geometries:
            raise ValueError("没有可合并的有效面要素，请检查边界文件。")
        # Validate each source first: do not silently repair, drop holes or
        # replace an invalid feature with its bounding rectangle.
        regions = [shape(validate_geometry(geometry)) for geometry in geometries]
        combined = unary_union(regions)
        # Verify serialized coordinates as well as the in-memory GEOS object.
        geometry = validate_geometry(json.loads(to_geojson(combined)))
        return {"geometry": geometry, "feature_count": len(geometries)}
    except (ValueError, TypeError, KeyError, GEOSException) as exc:
        message = str(exc) if isinstance(exc, ValueError) else "多边形运算失败，请检查边界是否完整有效。"
        raise HTTPException(422, detail="区域边界合并失败：" + message) from exc


@router.post("/runs", response_model=WorkflowAcceptedResponse, status_code=202)
def submit(
    payload: SpatialSeriesRequest,
    _run_ok: None = Depends(require_workflow_run_access),
    cred: CredentialContext | None = Depends(get_request_user),
):
    if cred:
        check_resource_access(cred, "layer", payload.product_id)
    try:
        plan = build_plan(payload.model_dump(), cred)
        request = WorkflowSubmitRequest(
            command_type="analysis",
            command_label="analysis:spatial_timeseries",
            layer_id=plan["product"]["catalog_id"],
            parameters={
                "analysis_tool_id": "spatial_timeseries",
                "analysis_exclusivity_key": "spatial_timeseries",
            },
            algorithm_request=AlgorithmWorkflowRequest(
                module_name="spatial_timeseries",
                task_type="spatial_timeseries",
                algorithm_params={"plan": plan},
            ),
            requested_outputs=["json", "file"],
        )
        return submission_service.submit_workflow(
            request,
            user_id=cred.user_id if cred else None,
            role=cred.role if cred else None,
        )
    except (NasError, NasConfigurationError) as exc:
        raise HTTPException(503, detail={"code": "source_unavailable", "user_message":
            "数据源连接失败，尚未提交分析；请检查测试版 NAS 连接。"}) from exc
    except WorkflowValidationError as exc:
        raise HTTPException(
            422, detail={"user_message": "时序请求未通过校验。", "issues": exc.issues}
        ) from exc
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(
            429 if "capacity" in str(exc).lower() else 422, detail=str(exc)
        ) from exc
