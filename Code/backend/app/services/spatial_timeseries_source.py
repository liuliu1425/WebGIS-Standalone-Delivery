"""Read-only NAS observations for the existing map products (no map cache writes)."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import Affine

from app.services.nas_ondemand import config, fetcher, renderer


def daily_index(product: str, variable: str) -> list[dict]:
    directory = fetcher.resolve_nas_dir(product, variable)
    frames = {}
    # Always refresh from the selected directory; never infer coverage from cached TIFFs.
    for item in fetcher.list_dir(directory, include_sizes=False):
        name = str(item.get("name", ""))
        if item.get("isDir") or not re.fullmatch(r"\d{8}\.mat", name):
            continue
        try:
            day = datetime.strptime(name[:8], "%Y%m%d").date().isoformat()
        except ValueError:
            continue
        frames[day] = dict(key=name[:8], start=day, end=day, cadence="daily",
                           source="nas", source_product=product, filename=name)
    return sorted(frames.values(), key=lambda f: f["start"])


def read_observation(frame: dict, variable: str, request: dict, check_cancel) -> dict:
    from shared.spatial_timeseries import read_frame

    empty = dict(value=None, count=0, total_count=0, coverage=None)
    try:
        check_cancel()
        directory = fetcher.resolve_nas_dir(frame["source_product"], variable)
        with TemporaryDirectory(prefix="spatial-series-") as folder:
            path = Path(folder) / frame["filename"]
            fetcher.download_file(directory, frame["filename"], path)
            check_cancel()
            mat = renderer.read_mat_auto(path)
            data = renderer.extract_variable(mat, variable)
            # Same native EASE grid as the map source, not its resampled display PNG.
            transform = renderer.ease_transform_from_mat(mat)
            crs = "EPSG:6933"
            if transform is None:
                # This is the documented grid of these NAS products. Reject unknown
                # shapes instead of silently stretching arbitrary arrays over the world.
                if data.shape != (1624, 3856):
                    raise ValueError("源数据缺少坐标元数据，且不是已登记的 EASE 9 km 网格。")
                transform = Affine(renderer.EASE_GLOBAL_WIDTH_M / data.shape[1], 0,
                                   renderer.EASE_GLOBAL_WEST, 0,
                                   -renderer.EASE_GLOBAL_HEIGHT_M / data.shape[0],
                                   renderer.EASE_GLOBAL_NORTH)
            elif "CRS" in mat:
                raw = np.asarray(mat["CRS"]).squeeze()
                crs = rasterio.crs.CRS.from_user_input(str(raw))
            check_cancel()
            # MAT v5 is compressed: the server must read one file. Only the requested
            # pixel / polygon window and its statistics are returned to the browser.
            with MemoryFile() as memory:
                with memory.open(driver="GTiff", height=data.shape[0], width=data.shape[1],
                                 count=1, dtype="float64", crs=crs, transform=transform,
                                 nodata=float("nan")) as ds:
                    ds.write(data, 1)
                return read_frame(memory.name, request, check_cancel, variable)
    except fetcher.NasFileMissing:
        return dict(empty, status="missing_file", message="观测文件已缺失，请刷新可用日期。")
    except (fetcher.NasUnavailable, config.NasConfigurationError):
        return dict(empty, status="source_unavailable", message="数据源连接或认证失败，请检查测试版 NAS 连接。")
    except (OSError, ValueError, rasterio.errors.RasterioError):
        return dict(empty, status="read_error", message="观测文件、变量或坐标元数据无法读取；未生成替代数值。")
