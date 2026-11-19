"""Generate a tiny synthetic GeoFlow raster time series and a composite boundary."""

import hashlib
import json
import tempfile
from pathlib import Path


SAMPLES = Path(__file__).resolve().parent
GENERATED = SAMPLES / "generated"
STORAGE_KEY = "method-fy-omega-doy-avg"
VARIABLE = "OMEGA"
PRODUCT_ID = "imported-" + hashlib.sha1(f"{STORAGE_KEY}|{VARIABLE}|{VARIABLE}".encode()).hexdigest()[:12]
FRAMES = ("20240201_20240229", "20240301_20240331", "20240401_20240430")
BOUNDS = [0.0, 0.0, 3.0, 2.0]
NODATA = -9999.0
OBSERVATIONS = (
    [[0.1, 0.45, 0.3], [0.05, 0.05, 0.05]],
    [[NODATA, NODATA, NODATA], [NODATA, NODATA, NODATA]],
    [[0.0, 0.45, NODATA], [0.05, 0.05, 0.05]],
)


def write_json(path, content):
    path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def boundary_feature(name, west, east):
    return {
        "type": "Feature",
        "properties": {"name": name},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[west, 1.1], [east, 1.1], [east, 1.9], [west, 1.9], [west, 1.1]]],
        },
    }


def generate():
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.transform import from_origin

    if GENERATED.exists():
        raise FileExistsError("samples/generated already exists. Move it aside before regenerating.")

    with tempfile.TemporaryDirectory(prefix="fixture-", dir=SAMPLES) as staging:
        fixture = Path(staging) / "generated"
        overlay = fixture / "imports" / PRODUCT_ID
        overlay.mkdir(parents=True)
        metadata = {
            "layer_id": PRODUCT_ID,
            "label": VARIABLE,
            "unit": "无量纲",
            "description": "Synthetic delivery verification data, not satellite observations.",
            "category": "time-series",
            "published": True,
            "time_list": list(FRAMES),
            "default_time": FRAMES[-1],
            "native_step": "1mo",
            "palette": "wind-blue",
            "vmin": 0.0,
            "vmax": 0.5,
            "crs": "EPSG:4326",
        }
        for date, values in zip(FRAMES, OBSERVATIONS):
            pixels = np.array(values, dtype="float32")
            with rasterio.open(
                overlay / f"source_{date}.tif",
                "w",
                driver="GTiff",
                width=3,
                height=2,
                count=1,
                dtype="float32",
                nodata=NODATA,
                crs="EPSG:4326",
                transform=from_origin(0, 2, 1, 1),
            ) as raster:
                raster.update_tags(synthetic="true", purpose="GeoFlow delivery smoke test")
                raster.write(pixels, 1)
            valid = pixels != NODATA
            shade = (np.where(valid, pixels, 0) * 255).astype("uint8")
            preview = np.stack([shade, shade, shade, np.where(valid, 255, 0)], axis=-1)
            Image.fromarray(preview.astype("uint8")).save(overlay / f"preview_{date}.png")
            write_json(overlay / f"bounds_{date}.json", {"bounds": BOUNDS, "meta": metadata})

        write_json(overlay / "bounds.json", {"bounds": BOUNDS, "meta": metadata})
        write_json(overlay / "meta.json", metadata)
        write_json(
            fixture / "boundary.geojson",
            {
                "type": "FeatureCollection",
                "features": [boundary_feature("合成西区", 0.1, 0.9), boundary_feature("合成东区", 2.1, 2.9)],
            },
        )
        fixture.rename(GENERATED)


if __name__ == "__main__":
    try:
        generate()
    except (ImportError, OSError) as exc:
        raise SystemExit(f"生成失败：{exc}") from None
    print(f"已生成合成样例 {PRODUCT_ID}（共 {len(FRAMES)} 个自然月）。")
