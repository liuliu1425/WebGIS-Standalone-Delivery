"""Read the NAS daily index without downloading rasters or modifying the map cache."""

from __future__ import annotations

import re
from datetime import datetime

from app.services.nas_ondemand import fetcher


def daily_index(product: str, variable: str) -> list[dict]:
    directory = fetcher.resolve_nas_dir(product, variable)
    frames = {}
    # Always refresh from the selected directory; never infer coverage from cached TIFFs.
    for item in fetcher.list_dir(directory):
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
