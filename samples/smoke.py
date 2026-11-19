"""Verify synthetic imports and time-series jobs against the isolated delivery site."""

import getpass
import json
import math
import re
import time
import warnings
from http.cookiejar import CookieJar, DefaultCookiePolicy
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import (
    HTTPCookieProcessor,
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
)
from uuid import uuid4

from generate import BOUNDS, FRAMES, GENERATED, PRODUCT_ID, STORAGE_KEY, VARIABLE


BASE_URL = "http://127.0.0.1:25175"
ENV_HEADER = "X-GeoFlow-Environment"
ENV_VALUE = "delivery"
SERIES = "/analysis/time-series"
PERIODS = (("2024-02-01", "2024-02-29"), ("2024-03-01", "2024-03-31"), ("2024-04-01", "2024-04-30"))
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class SmokeError(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition, message):
    if not condition:
        raise SmokeError(message)


class DeliveryClient:
    def __init__(self):
        # For the fixed loopback HTTP origin only, preserve a Secure session cookie.
        # Disable environment proxies and redirects so credentials never leave that origin.
        cookie_policy = DefaultCookiePolicy(secure_protocols=("http", "https", "wss"))
        self.opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(CookieJar(cookie_policy)))

    def request(self, path, *, label, method="GET", payload=None, raw=None, content_type=None):
        parsed = urlsplit(path)
        require(
            not parsed.scheme and not parsed.netloc and parsed.path.startswith("/") and not path.startswith("//")
            and not parsed.fragment and "\\" not in path,
            f"{label}返回无效的本地接口地址。",
        )
        headers = {"Accept": "application/json"}
        if payload is not None:
            raw = json.dumps(payload).encode("utf-8")
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(BASE_URL + path, data=raw, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                require(response.headers.get(ENV_HEADER) == ENV_VALUE, f"{label}未返回交付环境标识，验收已中断。")
                result = response.read(MAX_RESPONSE_BYTES + 1)
                require(len(result) <= MAX_RESPONSE_BYTES, f"{label}响应超出合成验收大小限制。")
        except HTTPError as exc:
            code = exc.code
            exc.close()
            raise SmokeError(f"{label}未通过（HTTP {code}）。") from None
        except (URLError, OSError):
            raise SmokeError(f"{label}无法连接独立交付站（{BASE_URL}）。") from None
        if not result:
            return None
        try:
            return json.loads(result)
        except (ValueError, UnicodeError):
            raise SmokeError(f"{label}响应不是 JSON。") from None


def verify_import(client, raster):
    boundary = "GeoFlowSmoke" + uuid4().hex
    header = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="synthetic-delivery.tif"\r\n'
        "Content-Type: image/tiff\r\n\r\n"
    )
    data = header.encode("ascii") + raster.read_bytes() + f"\r\n--{boundary}--\r\n".encode("ascii")
    uploaded = client.request(
        "/import/raster", label="合成 GeoTIFF 上传", method="POST", raw=data,
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    layer_id = uploaded.get("layer_id", "")
    require(
        re.fullmatch(r"imported-[0-9a-f]{12}", layer_id) and layer_id != PRODUCT_ID,
        "上传未返回有效的临时导入图层。",
    )
    try:
        require(uploaded.get("source_crs") == "EPSG:4326", "上传未识别 EPSG:4326。")
        client.request(
            "/import/raster/confirm", label="确认导入坐标系", method="POST",
            payload={"layer_id": layer_id, "source_crs": "EPSG:4326"},
        )
        bounds = client.request(f"/overlay-bounds/{layer_id}", label="读取导入图层边界")
        current = bounds.get("bounds")
        require(
            isinstance(current, list) and len(current) == len(BOUNDS)
            and all(
                isinstance(value, (int, float)) and math.isclose(value, expected, rel_tol=0, abs_tol=1e-9)
                for value, expected in zip(current, BOUNDS)
            ),
            "导入图层边界不匹配。",
        )
    finally:
        client.request(f"/import/raster/{layer_id}", label="清理本次临时导入图层", method="DELETE")
    print("通过：合成 GeoTIFF 上传、坐标系确认及边界读取。")


def run_series(client, **location):
    request = {
        "product_id": PRODUCT_ID,
        "start": PERIODS[0][0],
        "end": PERIODS[-1][1],
        "cadence": "monthly",
        "statistic": "mean",
        **location,
    }
    label = "点位时序" if location["mode"] == "point" else "区域时序"
    accepted = client.request(f"{SERIES}/runs", label=f"提交{label}", method="POST", payload=request)
    run_id = accepted.get("run_id")
    require(isinstance(run_id, str) and run_id, f"{label}未返回任务编号。")
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        run = client.request(f"/workflow-runs/{quote(run_id, safe='')}", label=f"查询{label}任务")
        status = run.get("status")
        if status == "succeeded":
            ref = next(
                (ref for ref in run.get("result_refs", []) if ref.get("result_kind") == "file"
                 and ref.get("result_id", "").startswith("algorithm-product-")),
                {},
            )
            url = ref.get("resource_url")
            require(isinstance(url, str) and url, f"{label}未返回结果文件。")
            return validate_result(client.request(url, label=f"读取{label}结果"), request, label)
        require(status not in {"failed", "cancelled", "canceled", "timed_out"}, f"{label}任务未完成。")
        time.sleep(1)
    raise SmokeError(f"{label}超过 120 秒，请核对独立交付时序 worker。")


def validate_result(result, request, label):
    require(result.get("schema_version") == 1, f"{label}结果格式不匹配。")
    require(result.get("request", {}).get("mode") == request["mode"], f"{label}结果模式不匹配。")
    require(result.get("product", {}).get("id") == PRODUCT_ID, f"{label}结果产品不匹配。")
    rows = result.get("rows", [])
    require([(row.get("start"), row.get("end")) for row in rows] == list(PERIODS),
            f"{label}日期或缺测行不匹配。")
    require(result.get("valid_count") == 2, f"{label}有效期数不匹配。")
    gap = rows[1]
    require(gap.get("value") is None and gap.get("status") == "no_valid_data", f"{label}未正确保留全缺测月份。")
    for row in (rows[0], rows[-1]):
        require(row.get("status") == "ok", f"{label}有效观测期状态不匹配。")
    return rows[0], rows[-1]


def verify_series(client, features):
    products = client.request(f"{SERIES}/products", label="读取时序产品目录")
    product = next((item for item in products.get("items", []) if item.get("id") == PRODUCT_ID), {})
    require(product.get("source_id") == STORAGE_KEY and product.get("source_kind") == "local_composite"
            and product.get("variable") == VARIABLE, "合成月尺度产品不可见或未使用交付本地数据。")
    availability = client.request(f"{SERIES}/products/{PRODUCT_ID}/availability", label="读取合成产品可用日期")
    periods = [(frame.get("start"), frame.get("end")) for frame in availability.get("frames", [])
               if frame.get("cadence") == "monthly"]
    require(periods == list(PERIODS), "合成产品可用观测期不匹配。")

    point_first, point_last = run_series(client, mode="point", point=[0.5, 1.5], location_name="合成点位")
    require(math.isclose(point_first["value"], 0.1, abs_tol=1e-6), "点位首期合成值不匹配。")
    require(point_last["value"] == 0, "点位末期有效零值未被保留。")
    print("通过：本地自然月时序、点位取值、有效零值及全缺测月份。")

    merged = client.request(f"{SERIES}/boundary/merge", label="合并 GeoJSON 边界", method="POST",
                            payload={"features": features})
    geometry = merged.get("geometry", {})
    require(merged.get("feature_count") == 2 and geometry.get("type") == "MultiPolygon"
            and len(geometry.get("coordinates", [])) == 2, "合成区划应保留两个分离面。")
    region_first, region_last = run_series(client, mode="region", geometry=geometry, location_name="合成整区")
    require(math.isclose(region_first["mean"], 0.2, abs_tol=1e-6)
            and region_first["count"] == 2 and region_first["total_count"] == 2, "整个区域首期均值或像元数不匹配。")
    require(region_last["mean"] == 0 and region_last["count"] == 1 and region_last["total_count"] == 2
            and region_last["coverage"] == 0.5, "区域末期应排除 NoData 并保留 50% 覆盖率。")
    print("通过：合并两个 GeoJSON 区划、整区均值、NoData 和覆盖率。")


def main():
    raster = GENERATED / "imports" / PRODUCT_ID / f"source_{FRAMES[0]}.tif"
    boundary = GENERATED / "boundary.geojson"
    require(raster.is_file() and boundary.is_file(), "找不到合成样例，请先运行 samples/generate.py。")
    features = json.loads(boundary.read_text(encoding="utf-8"))["features"]
    client = DeliveryClient()
    health = client.request("/health", label="检查独立交付站")
    require(health.get("status") == "ok", "独立交付后端健康检查未通过。")
    username = input("交付环境账号：").strip()
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        password = getpass.getpass("交付环境密码（输入不回显）：")
    require(username and password, "请使用交付环境有效账号。")
    client.request("/auth/login", label="登录独立交付站", method="POST",
                   payload={"username": username, "password": password})
    del password
    try:
        verify_import(client, raster)
        verify_series(client, features)
    finally:
        client.request("/auth/logout", label="退出验收会话", method="POST")


if __name__ == "__main__":
    try:
        main()
    except (SmokeError, getpass.GetPassWarning, EOFError) as exc:
        raise SystemExit(f"验收未通过：{exc}") from None
