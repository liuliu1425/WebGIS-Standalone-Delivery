"""Regression contracts derived from the real 100-turn UI audit."""
from types import SimpleNamespace

import pytest

from app.services.agent import layer_identity as identity
from app.services.agent import mock_orchestrator as mo
from app.services.agent import orchestrator as o
from app.data_io.services.raster_timeseries import stable_imported_layer_id


@pytest.fixture
def page(monkeypatch):
    groups = ("method-fy-omega-doy-avg", "method-smap-season-mean",
              "method-fy-omega-doy-dynamic", "method-smap-omega-doy-dynamic")
    meta, rows = {}, []
    for group in groups:
        for role, name in (("SM", "土壤水分"), ("VOD", "植被光学厚度"), ("OMEGA", "等效散射 ω")):
            cid = stable_imported_layer_id(group, role, role)
            meta[cid] = {"variable_id": role, "run_id": "missing-run"}
            rows.append({"catalog_id": cid, "overlay_layer_id": cid, "instance_id": cid+"-instance",
                         "name": name, "visible": False, "selected": False})
    monkeypatch.setattr(identity, "_read_meta", lambda cid: meta.get(cid, {}))
    monkeypatch.setattr(identity, "_lookup_run_layer_id", lambda run: None)
    monkeypatch.setattr(identity, "_sibling_copies", lambda cid: ([], False))
    monkeypatch.setattr(identity, "_descriptor", lambda cid: None)
    from app.services import layer_catalog
    monkeypatch.setattr(layer_catalog, "_load_seed_descriptors",
                        lambda: [SimpleNamespace(layer_id=g) for g in groups if "season" not in g])
    identity._ORIGIN_CACHE.clear()
    mo._IDENTITY_CACHE.clear()
    rows[1]["selected"] = True
    rows[0]["visible"] = True
    rows[7]["visible"] = True
    rows.append({"catalog_id": "unlabelled-xyz", "name": "unlabelled-xyz",
                 "instance_id": "unlabelled", "visible": False, "selected": False})
    yield {"active_layers": rows, "timeline": {"date": "2025-07-31", "hour": 0}}
    identity._ORIGIN_CACHE.clear()
    mo._IDENTITY_CACHE.clear()


@pytest.mark.parametrize("source,version,group", [
    ("风云", "平均", "method-fy-omega-doy-avg"),
    ("SMAP", "平均", "method-smap-season-mean"),
    ("风云", "动态", "method-fy-omega-doy-dynamic"),
    ("SMAP", "动态", "method-smap-omega-doy-dynamic"),
])
@pytest.mark.parametrize("role,name", [("SM", "土壤水分"), ("VOD", "VOD"), ("OMEGA", "等效散射ω")])
def test_named_identity_without_workflow_history(page, source, version, group, role, name):
    picked = mo._resolve_layer(f"{source}卫星{version}版{name}", mo._normalize_layers(page), allow_demo_fallback=False)
    assert picked and picked.catalog_id == stable_imported_layer_id(group, role, role)


@pytest.mark.parametrize("text,visible", [
    ("请勾选风云平均版VOD", True), ("把风云平均版VOD打开", True),
    ("开启风云平均版VOD", True), ("取消显示风云平均版VOD", False),
    ("取消勾选风云平均版VOD", False), ("把风云平均版VOD收起", False),
    ("关掉风云平均版VOD", False), ("隐藏风云平均版VOD", False),
    ("显示当前选中的图层", True), ("隐藏当前选中查看的图层", False),
])
def test_visibility_direction_and_target(page, text, visible):
    intent = o._resolve_simple_visibility(text, page)
    assert intent and intent["args"]["visible"] is visible
    assert intent["args"]["catalog_id"] == page["active_layers"][1]["catalog_id"]
    guarded = o._guard_read_only_ui_intents(text, {"reply": "请求已下发", "ui_intents": [intent]})
    assert guarded["ui_intents"] == [intent]


@pytest.mark.parametrize("text", ["显示不存在的星辰99图层", "隐藏紫色海洋XYZ图层"])
def test_missing_layer_never_matches_generated_placeholder(page, text):
    assert mo._resolve_layer(text, mo._normalize_layers(page), allow_demo_fallback=False) is None


@pytest.mark.parametrize("text,expected", [
    ("当前显示了哪些数据图层？", "2 个"),
    ("列出目前勾选显示的图层。", "2 个"),
    ("现在选中查看的是哪个图层？", "植被光学厚度"),
    ("当前分析面板对应哪个图层？", "植被光学厚度"),
    ("告诉我当前选中的图层。", "已隐藏"),
    ("页面目前一共添加了多少个图层？", "13 个"),
    ("风云平均版VOD目前是否勾选显示？", "已隐藏"),
    ("SMAP动态版土壤水分现在显示着吗？", "已隐藏"),
    ("风云平均版产品包含哪些变量？", "等效散射"),
    ("SMAP动态版VOD有没有显示？", "已隐藏"),
    ("风云平均版土壤水分现在开着没？", "已勾选显示"),
    ("风云平均版VOD显示了没有？", "已隐藏"),
    ("风云动态版VOD有无勾选？", "已勾选显示"),
    ("现在显示的图层总数是多少？", "2 个"),
    ("未勾选的图层有多少个？", "11 个"),
    ("目前有哪些已隐藏的图层？", "已隐藏的图层有 11 个"),
    ("列出不可见图层", "已隐藏的图层有 11 个"),
])
def test_queries_are_snapshot_answers_without_actions(page, text, expected):
    answer = o._answer_page_query(text, page)
    assert expected in answer
    result = {"reply": answer, "ui_intents": []}
    assert o._guard_unclaimed_view_intent(text, result)["reply"] == answer
    assert o._resolve_simple_visibility(text, page) is None


@pytest.mark.parametrize("product", ["风云平均版", "风云动态版", "SMAP平均版", "SMAP动态版"])
def test_product_variables_exclude_unrelated_unknown_layers(page, product):
    answer = o._answer_page_query(product + "有哪些变量？", page)
    assert "unlabelled" not in answer and "图层 13" not in answer
    assert all(name in answer for name in ("土壤水分", "植被光学厚度", "等效散射"))


@pytest.mark.parametrize("text", [
    "把风云卫星平均版土壤水分切到2025-12-05",
    "SMAP动态版VOD切换至2025-12-16",
    "将风云平均版VOD的日期设为2025-12-18",
])
def test_date_only_never_demands_showing_layer(page, text):
    result = {"reply": "已下发时间切换请求", "ui_intents": [{"name": "set_timeline", "args": {"date": "2025-12-05"}}]}
    assert o._guard_partial_layer_switch_intent(text, result)["reply"] == result["reply"]
    assert o._guard_read_only_ui_intents(text, result)["ui_intents"]


def test_map_reply_cannot_claim_unrequested_statistics():
    assert o._append_region_scope_note("缩放到中国全境", "已下发定位请求", []) == "已下发定位请求"


@pytest.mark.parametrize("region", ["北京市", "上海市", "广州市", "四川省", "河南省", "云南省"])
def test_fully_specified_statistics_use_the_same_path_for_all_region_levels(region):
    assert o._is_explicit_statistics_read(f"查询SMAP卫星动态版土壤水分2025-12-16的{region}区域均值")


def test_nodata_reply_only_describes_the_requested_scope(page, monkeypatch):
    from app.services.agent import server_tools_runtime as runtime
    monkeypatch.setattr(runtime, "_get_layer_statistics", lambda *a, **k: {
        "ok": False, "valid_pixels": 0, "error": "该行政区边界范围内没有有效像元",
        "period_start": "20251216", "period_end": "20251216",
        "requested_time": "20251216", "actual_time": "20251216",
    })
    result = mo.forced_statistics_reply("查询SMAP卫星动态版土壤水分2025-12-16上海市区域均值", client_context=page)
    assert "NoData" in result["reply"] and "上海市" in result["reply"]
    assert "整片 NoData" not in result["reply"] and "空产物" not in result["reply"]
    assert "云" not in result["reply"]
    assert result["ui_intents"] == []


@pytest.fixture
def local_chat(monkeypatch):
    monkeypatch.setattr(o, "get_effective_profile_raw", lambda **kw: {"protocol": "demo", "id": "test"})
    monkeypatch.setattr(o, "load_topic_state", lambda **kw: {})
    monkeypatch.setattr(o, "load_history", lambda **kw: [])
    monkeypatch.setattr(o, "append_turn", lambda **kw: None)
    return o.run_chat


@pytest.mark.parametrize("text,visible", [
    ("取消勾选当前图层。", False),
    ("开启当前选中查看的图层。", True),
    ("请将当前选中的图层关闭。", False),
    ("当前图层取消显示。", False),
    ("帮我勾选这层。", True),
])
def test_current_visibility_reaches_dispatch_through_chat(page, local_chat, text, visible):
    result = local_chat(text, client_context=page)
    assert len(result["ui_intents"]) == 1
    intent = result["ui_intents"][0]
    assert intent["name"] == "set_layer_visibility"
    assert intent["args"]["catalog_id"] == page["active_layers"][1]["catalog_id"]
    assert intent["args"]["visible"] is visible
    assert "未下发" not in result["reply"] and "没有下发" not in result["reply"]


@pytest.mark.parametrize("text", [
    "不要开启当前图层，只告诉我是否显示。",
    "别取消勾选当前图层。",
    "仅查看当前图层显示情况。",
])
def test_read_or_negated_toggle_does_not_change_page(page, local_chat, text):
    result = local_chat(text, client_context=page)
    assert result["ui_intents"] == []
    assert "重新下发" not in result["reply"] and "正在计算" not in result["reply"]
    assert "已下发" not in result["reply"]
    if "显示情况" in text:
        assert "已隐藏" in result["reply"]
        assert "13 个活动图层" not in result["reply"]


def test_missing_named_date_does_not_invent_multiple_candidates(page, local_chat):
    result = local_chat("把天际99图层日期改为2025-12-15。", client_context=page)
    assert result["ui_intents"] == []
    assert "多个候选" not in result["reply"]
    assert "没有修改" in result["reply"]
