"""Fixed seven-capability regression. Fixtures simulate UI; browser evidence is separate."""
import copy
import json
from pathlib import Path

import pytest
from test_agent_single_step_regressions import page, local_chat  # noqa: F401
from app.services.agent import orchestrator as o, server_tools_runtime as rt
from app.services.agent.request_semantics import page_query_kind

CASES = json.loads(Path(__file__).with_name("agent_basic_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["id"])
def test_basic_contract(page, local_chat, monkeypatch, case):
    for row in page["active_layers"]:
        row["requested_time"] = {"date": "2025-07-17", "hour": 0}
        row["actual_time"] = "20250717"
    page["active_layers"][1]["requested_time"] = {"date": "2025-07-19", "hour": 0}
    page["active_layers"][1]["actual_time"] = "20250719"
    monkeypatch.setattr(rt, "_local_time_keys", lambda _: ["20250701_20250731"])
    before = copy.deepcopy(page)
    result = local_chat(case["command"], client_context=page)
    assert page == before, "server must not mutate the supplied page snapshot"
    assert not result.get("operation_plan"), result
    kind = case["kind"]
    intents = result.get("ui_intents") or []
    if kind in {"selected", "visible", "date", "compound", "count", "missing", "invalid_date"}:
        assert not intents, result
        assert not result.get("confirmation"), result
    if kind in {"date", "compound"}:
        assert "2025-07-19" in result["reply"], result
        assert "2025-07-31" not in result["reply"], "global timeline must not replace layer memory"
    if kind in {"selected", "compound"}:
        assert "植被光学厚度" in result["reply"] and "隐藏" in result["reply"], result
    if kind in {"visible", "compound"}:
        assert "土壤水分" in result["reply"] and "植被光学厚度" in result["reply"], result
        assert "2 " in result["reply"], result
    if kind == "count":
        assert "13 个" in result["reply"]
    if kind in {"missing", "invalid_date"}:
        assert result.get("operation_status") != "success", result
    if kind in {"show", "hide", "solo", "set_date"}:
        assert len(intents) == 1, result
        action = intents[0]
        target = page["active_layers"][9 if "SMAP" in case["command"] else 1]
        assert action["args"]["catalog_id"] == target["catalog_id"], result
        if kind == "set_date":
            assert action["name"] == "set_timeline"
            assert action["args"]["date"] == ("2025-07-21" if "SMAP" in case["command"] else "2025-07-20")
        else:
            assert action["name"] == "set_layer_visibility"
            assert action["args"]["visible"] is (kind != "hide")
            assert bool(action["args"].get("solo")) is (kind == "solo")


@pytest.mark.parametrize("state", ["failed", "running", "cancelled", "succeeded"])
def test_date_reports_requested_actual_and_resource_state(page, local_chat, state):
    row = page["active_layers"][1]
    row.update(requested_time={"date": "2025-07-19", "hour": 0},
               actual_time="20250701_20250731", load_state=state)
    r = local_chat("当前选中图层的日期是多少？只查询，不修改。", client_context=page)
    assert not r["ui_intents"]
    assert "2025-07-19" in r["reply"] and "2025-07-01 至 2025-07-31" in r["reply"]
    assert {"failed":"加载失败","running":"加载中","cancelled":"已取消","succeeded":"资源已就绪"}[state] in r["reply"]


def test_no_selection_does_not_use_visible_layer_or_global_date(page, local_chat):
    for row in page["active_layers"]:
        row["selected"] = False
    r = local_chat("当前选中图层的日期是多少？", client_context=page)
    assert not r["ui_intents"] and "没有选中" in r["reply"]
    assert "2025-07-31" not in r["reply"]


def test_missing_date_is_unknown_not_global_timeline(page, local_chat):
    r = local_chat("查询当前选中图层的日期。", client_context=page)
    assert not r["ui_intents"] and "未提供" in r["reply"]
    assert "2025-07-31" not in r["reply"]


@pytest.mark.parametrize("text", [
    "把当前选中的图层日期切到2025年7月20日。",
    "显示风云平均版VOD，再告诉我它的日期。",
    "查询风云平均版SM在2025-07-20广州市的均值。",
])
def test_mutations_and_data_queries_not_misrouted_as_page_dates(text):
    assert page_query_kind(text) not in {"date", "overview"}
