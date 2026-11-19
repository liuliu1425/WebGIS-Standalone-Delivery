"""Resolve the existing imported products to a frozen, read-only analysis plan."""

from __future__ import annotations

import hashlib
import calendar
import json
import re
from datetime import date
from pathlib import Path

from app.services.layer_catalog import get_layer_catalog
from app.services.overlay_registry import get_overlay_spec, can_view_overlay
from shared.spatial_timeseries import validate_geometry
from app.services.nas_ondemand.config import ondemand_target

VARIABLES = {
    "SM": ("土壤水分 SM", "m³/m³"),
    "VOD": ("植被光学厚度 VOD", "无量纲"),
    "OMEGA": ("等效散射 ω", "无量纲"),
}


def available_frames(folder: Path) -> list[dict]:
    rows = []
    for path in sorted(folder.glob("source_*.tif")):
        match = re.fullmatch(r"source_(\d{8})(?:_(\d{8}))?\.tif", path.name)
        if not match:
            continue

        def iso(s):
            return date(int(s[:4]), int(s[4:6]), int(s[6:])).isoformat()

        try:
            start, end = iso(match[1]), iso(match[2] or match[1])
        except ValueError:
            continue
        if end < start:
            continue
        cadence = "daily"
        if match[2]:
            first, last = date.fromisoformat(start), date.fromisoformat(end)
            monthly = (
                first.day == 1
                and first.year == last.year
                and first.month == last.month
                and last.day == calendar.monthrange(last.year, last.month)[1]
            )
            cadence = "monthly" if monthly else f"period-{(last - first).days + 1}d"
        rows.append(
            dict(
                key=path.stem.removeprefix("source_"),
                start=start,
                end=end,
                cadence=cadence,
                path=str(path),
            )
        )
    return rows


def list_products(cred) -> list[dict]:
    products = []
    entries = [
        (layer, layer.layer_id, layer.display_name)
        for layer in get_layer_catalog().items
    ]
    # The existing default-layers.ts keeps the SMAP seasonal outputs in a separate
    # stable directory. Its catalog descriptor is the average-product descriptor.
    average = next(
        (
            layer
            for layer, _, _ in entries
            if layer.layer_id == "method-smap-omega-doy-avg"
        ),
        None,
    )
    if average:
        entries.append(
            (
                average,
                "method-smap-season-mean",
                average.display_name + "（已保存季均目录）",
            )
        )
    for layer, storage_key, product_name in entries:
        if not layer.layer_id.startswith("method-"):
            continue
        for variable, (name, fallback_unit) in VARIABLES.items():
            stable_id = (
                "imported-"
                + hashlib.sha1(
                    f"{storage_key}|{variable}|{variable}".encode()
                ).hexdigest()[:12]
            )
            spec = get_overlay_spec(stable_id)
            if spec is None or not can_view_overlay(
                stable_id,
                role=cred.role if cred else None,
                user_id=cred.user_id if cred else None,
            ):
                continue
            frames = scientific_frames(spec.overlay_dir, variable)
            target = ondemand_target(stable_id)
            remote_daily = target is not None and variable in {"SM", "VOD"}
            if not frames and not remote_daily:
                continue
            meta_file = spec.overlay_dir / "meta.json"
            meta = (
                json.loads(meta_file.read_text(encoding="utf-8"))
                if meta_file.exists()
                else {}
            )
            unit = meta.get("unit") or fallback_unit
            products.append(
                dict(
                    id=stable_id,
                    catalog_id=layer.layer_id,
                    product_name=product_name,
                    variable=variable,
                    variable_name=name,
                    unit=unit,
                    unit_source="源元数据" if meta.get("unit") else "既有产品变量定义",
                    native_step="1d" if remote_daily else spec.native_step,
                    source_kind="nas_daily" if remote_daily else "local_composite",
                    source_id=target["product"] if remote_daily else storage_key,
                    source_note=("NAS 原始逐日观测；合成期单独选择" if remote_daily else
                                 "本地已保存的合成观测；ω 日序气候态不作为逐日真实观测"),
                    timezone="日期型观测（无小时/时区）",
                    frames=[
                        {k: v for k, v in f.items() if k != "path"} for f in frames
                        if not remote_daily or f["cadence"] != "daily"
                    ],
                )
            )
    return products


def scientific_frames(folder: Path, variable: str) -> list[dict]:
    # nas_ondemand/config.temporal_basis: daily OMEGA caches are DOY climatology
    # or repeated block values, not independent dated observations.
    return [
        f
        for f in available_frames(folder)
        if variable != "OMEGA" or f["cadence"] != "daily"
    ]


def product_frames(product: dict) -> list[dict]:
    local = scientific_frames(get_overlay_spec(product["id"]).overlay_dir, product["variable"])
    if product.get("source_kind") != "nas_daily":
        return local
    from app.services.spatial_timeseries_source import daily_index
    return daily_index(product["source_id"], product["variable"]) + [
        f for f in local if f["cadence"] != "daily"
    ]


def product_availability(product_id: str, cred) -> dict:
    product = next((p for p in list_products(cred) if p["id"] == product_id), None)
    if product is None:
        raise ValueError("该产品不可用或当前账号无权访问。")
    frames = product_frames(product)
    product["frames"] = [{k: f[k] for k in ("key", "start", "end", "cadence")} for f in frames]
    if product.get("source_kind") == "nas_daily":
        from app.data_io.services.grid_presets import GRID_PRESETS
        product["coverage_bounds"] = GRID_PRESETS["ease2-global-9km"]["geographic_bounds"]
        product["coverage_note"] = "产品 EASE 全球网格范围；范围内仍可能为无效像元，以逐期读取结果为准。"
    return product


def build_plan(request: dict, cred) -> dict:
    product = next(
        (p for p in list_products(cred) if p["id"] == request["product_id"]), None
    )
    if product is None:
        raise ValueError("该产品没有可用的本地时序源数据，或当前账号无权访问。")
    start, end = (
        date.fromisoformat(request["start"]),
        date.fromisoformat(request["end"]),
    )
    if start > end:
        raise ValueError("起始日期不能晚于结束日期。")
    frames = [
        f
        for f in product_frames(product)
        if f["cadence"] == request["cadence"]
    ]
    if not frames:
        raise ValueError("该产品没有所选时间尺度的数据。")
    if request["start"] < min(f["start"] for f in frames) or request["end"] > max(
        f["end"] for f in frames
    ):
        raise ValueError("所选时间超出当前产品该时间尺度的真实观测范围，请刷新可用日期。")
    # Composite values represent the whole period: only include fully contained periods.
    frames = [
        f
        for f in frames
        if f["start"] >= request["start"] and f["end"] <= request["end"]
    ]
    if not frames:
        raise ValueError("范围内没有完整观测期；合成数据需覆盖该期的起止日期。")
    if request["mode"] == "region":
        request["geometry"] = validate_geometry(request.get("geometry") or {})
        request["point"] = None
    else:
        point = request.get("point")
        if (
            not point
            or len(point) != 2
            or not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90)
        ):
            raise ValueError("请输入有效的经度（-180～180）和纬度（-90～90）。")
        request["geometry"] = None
    return dict(
        request=request,
        product={k: v for k, v in product.items() if k != "frames"},
        frames=frames,
    )
