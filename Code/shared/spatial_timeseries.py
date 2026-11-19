"""Windowed spatial time-series extraction. No map state or source-data writes."""

from __future__ import annotations

import math
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

import numpy as np
import rasterio
from pyproj import CRS, Transformer, Geod
from rasterio.features import geometry_mask, geometry_window
from rasterio.windows import Window
from shapely.geometry import shape, mapping
from shapely.ops import transform
from shapely.validation import explain_validity


def validate_geometry(geometry: dict) -> dict:
    try:
        region = shape(geometry)
    except (ValueError, TypeError, AttributeError, KeyError) as exc:
        raise ValueError(
            "边界格式无效，请提供完整的 Polygon 或 MultiPolygon。"
        ) from exc
    if region.geom_type not in {"Polygon", "MultiPolygon"} or region.is_empty:
        raise ValueError("请选择一个有效的面要素（Polygon 或 MultiPolygon）。")
    if not region.is_valid:
        raise ValueError(f"边界无效：{explain_validity(region)}")
    west, south, east, north = region.bounds
    if not all(math.isfinite(v) for v in region.bounds):
        raise ValueError("边界包含非有限坐标。")
    if west < -180 or east > 180 or south < -90 or north > 90:
        raise ValueError("边界必须转换为 WGS84 经纬度后再分析。")
    if east - west > 180:
        raise ValueError("暂不支持跨越日期变更线的区域，请先拆分边界。")
    # Keep the validated input coordinates verbatim in the queued JSON contract.
    # Re-materializing a GEOS polygon after catalog imports in the API thread
    # returned an empty coordinate sequence in the deployed environment.
    return json.loads(
        json.dumps(
            {"type": geometry["type"], "coordinates": geometry["coordinates"]},
            allow_nan=False,
        )
    )


def read_frame(
    path: str, request: dict, check_cancel: Callable[[], None], variable: str = ""
) -> dict:
    """Read only a point/window, splitting regions into strips to bound memory."""
    empty = dict(
        value=None,
        mean=None,
        std=None,
        min=None,
        max=None,
        count=0,
        total_count=0,
        coverage=None,
        status="no_valid_data",
    )
    with rasterio.open(path) as ds:
        if not ds.crs:
            raise ValueError("栅格没有坐标系，不能可靠定位像元。")
        if ds.count != 1:
            raise ValueError(
                "多波段栅格尚未提供明确的变量/时间映射，不能把波段当作日期。"
            )
        crs = CRS.from_user_input(ds.crs)
        grid = dict(
            crs=ds.crs.to_string(),
            resolution=list(ds.res),
            resolution_unit=crs.axis_info[0].unit_name if crs.axis_info else "unknown",
        )
        empty["grid"] = grid
        project = Transformer.from_crs(4326, crs, always_xy=True)
        if request["mode"] == "point":
            x, y = project.transform(*request["point"], errcheck=True)
            row, col = ds.index(x, y)
            if not (0 <= row < ds.height and 0 <= col < ds.width):
                return {**empty, "status": "outside_data"}
            arr = ds.read(1, window=Window(col, row, 1, 1), masked=True)
            value = float(arr.data[0, 0]) * ds.scales[0] + ds.offsets[0]
            valid = not np.ma.getmaskarray(arr)[0, 0] and math.isfinite(value)
            if variable in {"SM", "VOD", "OMEGA"}:
                valid = valid and value >= 0
            return {
                **empty,
                "value": value if valid else None,
                "count": int(valid),
                "total_count": 1,
                "coverage": float(valid),
                "status": "ok" if valid else "no_valid_data",
                "pixel": {"row": row, "column": col, "center": list(ds.xy(row, col))},
            }
        geom = mapping(transform(project.transform, shape(request["geometry"])))
        try:
            window = geometry_window(ds, [geom])
        except rasterio.errors.WindowError:
            return {**empty, "status": "outside_data"}
        # Equal-area EPSG:6933 uses equal cell weights. Other CRSs use geodesic cell area.
        equal_area = crs.to_epsg() == 6933
        to_lonlat = Transformer.from_crs(crs, 4326, always_xy=True)
        geod = Geod(ellps="WGS84")
        total = count = 0
        weight_sum = mean = m2 = 0.0
        low, high = math.inf, -math.inf
        for row0 in range(
            int(window.row_off), int(window.row_off + window.height), 128
        ):
            check_cancel()
            win = Window(
                window.col_off,
                row0,
                window.width,
                min(128, window.row_off + window.height - row0),
            )
            a = ds.read(1, window=win, masked=True)
            inside = geometry_mask(
                [geom],
                out_shape=a.shape,
                transform=ds.window_transform(win),
                invert=True,
                all_touched=False,
            )
            total += int(inside.sum())
            values = a.data.astype("float64") * ds.scales[0] + ds.offsets[0]
            valid = inside & ~np.ma.getmaskarray(a) & np.isfinite(values)
            if variable in {"SM", "VOD", "OMEGA"}:
                valid &= values >= 0
            if not valid.any():
                continue
            v = values[valid]
            weights = np.ones(v.size)
            if not equal_area:
                rr, cc = np.nonzero(valid)
                for j, (r, c) in enumerate(zip(rr + row0, cc + int(window.col_off))):
                    if j % 1024 == 0:
                        check_cancel()
                    corners = [
                        ds.transform * p
                        for p in ((c, r), (c + 1, r), (c + 1, r + 1), (c, r + 1))
                    ]
                    lon, lat = to_lonlat.transform(*zip(*corners))
                    weights[j] = abs(geod.polygon_area_perimeter(lon, lat)[0])
            valid_w = np.isfinite(weights) & (weights > 0)
            if not valid_w.all():
                raise ValueError("像元面积计算失败，请检查栅格坐标系。")
            w = float(weights.sum())
            block_mean = float(np.average(v, weights=weights))
            delta = block_mean - mean
            m2 += float(
                np.sum(weights * (v - block_mean) ** 2)
            ) + delta**2 * weight_sum * w / (weight_sum + w)
            mean += delta * w / (weight_sum + w)
            weight_sum += w
            count += v.size
            low, high = min(low, float(v.min())), max(high, float(v.max()))
        if not count:
            return {
                **empty,
                "total_count": total,
                "coverage": 0 if total else None,
                "status": "no_valid_data" if total else "no_pixel_centers",
            }
        return {
            **empty,
            "value": mean,
            "mean": mean,
            "std": math.sqrt(max(0, m2 / weight_sum)),
            "min": low,
            "max": high,
            "count": int(count),
            "total_count": total,
            "coverage": count / total,
            "status": "ok",
            "weighting": "equal_area_cells" if equal_area else "geodesic_cell_area",
        }


def extract_series(
    plan: dict, check_cancel=lambda: None, progress=lambda *_: None
) -> dict:
    request, frames = plan["request"], plan["frames"]
    if request["mode"] == "region":
        validate_geometry(request["geometry"])
    by_date = {}
    for i, frame in enumerate(frames):
        check_cancel()
        if frame.get("source") == "nas":
            from app.services.spatial_timeseries_source import read_observation
            row = read_observation(frame, plan["product"]["variable"], request, check_cancel)
        elif not Path(frame["path"]).is_file():
            row = dict(
                value=None, count=0, total_count=0, coverage=None, status="missing_file"
            )
        else:
            row = read_frame(
                frame["path"],
                request,
                check_cancel,
                plan["product"].get("variable", ""),
            )
        by_date[frame["start"]] = {
            **row,
            **{k: v for k, v in frame.items() if k in {"key", "start", "end", "cadence"}},
        }
        progress(i + 1, len(frames))
    # Daily gaps are known from explicit daily file keys, never inferred from composite spacing.
    if request["cadence"] == "daily":
        day, end = (
            date.fromisoformat(request["start"]),
            date.fromisoformat(request["end"]),
        )
        while day <= end:
            key = day.isoformat()
            if key not in by_date:
                by_date[key] = dict(
                    start=key,
                    end=key,
                    key=key,
                    value=None,
                    count=0,
                    total_count=0,
                    coverage=None,
                    status="missing_date",
                )
            day += timedelta(days=1)
    rows = sorted(by_date.values(), key=lambda r: r["start"])
    return dict(
        schema_version=1,
        product=plan["product"],
        request=request,
        rows=rows,
        valid_count=sum(r["value"] is not None for r in rows),
        timezone="日期型观测（无小时/时区）",
        edge_rule="像元中心落在固定边界内才纳入；不按边缘相交比例分摊",
        coverage_rule="有效像元数 / 边界内且位于栅格覆盖范围内的像元中心总数",
        quality_rule="使用源栅格 NoData、掩膜和非有限值；SM、VOD、OMEGA 排除负值，与已有产品读取规则一致；不补零、不插值",
        weighting="EPSG:6933 等面积像元等权；其他坐标系按像元大地面积加权",
    )


def main() -> None:
    """A clean interpreter isolates GDAL/PROJ from a pre-fork workflow worker."""
    import json
    import os
    import sys

    plan_path, result_path, flag_path, progress_path, parent_pid = sys.argv[1:]

    def cancelled():
        if Path(flag_path).exists() or os.getppid() != int(parent_pid):
            raise RuntimeError("时序任务已取消或父任务已结束。")

    def report(done, total):
        target = Path(progress_path)
        temp = target.with_suffix(".tmp")
        temp.write_text(json.dumps({"done": done, "total": total}), encoding="utf-8")
        temp.replace(target)

    result = extract_series(
        json.loads(Path(plan_path).read_text(encoding="utf-8")), cancelled, report
    )
    cancelled()
    Path(result_path).write_text(
        json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
