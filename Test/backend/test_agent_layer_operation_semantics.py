"""List, selection and visibility are separate operations (no data/model service)."""
import copy
from types import SimpleNamespace
import pytest

from app.services.agent import orchestrator as o
from app.services.agent import mock_orchestrator as mo
from app.services.agent.operation_plan import operation_kind, plan_operations
from app.services.agent.request_semantics import page_query_kind, has_timeline_request
from test_agent_single_step_regressions import page, local_chat


@pytest.fixture
def open_products(monkeypatch):
    from app.services.agent import server_tools_runtime as runtime
    monkeypatch.setattr(runtime, "layer_operation_block_reason", lambda *a, **k: None)


@pytest.mark.parametrize("text,name", [
    ("添加风云平均VOD", "add_layer"), ("加载风云平均VOD", "add_layer"),
    ("切换到风云平均VOD", "select_layer"), ("选中风云平均VOD", "select_layer"),
    ("查看风云平均VOD", "select_layer"), ("切到SMAP动态SM", "select_layer"),
    ("显示风云平均VOD", "set_layer_visibility"), ("勾选风云平均VOD", "set_layer_visibility"),
    ("隐藏风云平均VOD", "set_layer_visibility"), ("取消勾选风云平均VOD", "set_layer_visibility"),
])
def test_same_target_distinct_commands(page, local_chat, open_products, text, name):
    before = copy.deepcopy(page)
    result = local_chat(text, client_context=page)
    assert len(result["ui_intents"]) == 1
    intent = result["ui_intents"][0]
    assert intent["name"] == name and intent["command_id"]
    index = 9 if "SMAP" in text else 1
    assert intent["args"]["catalog_id"] == page["active_layers"][index]["catalog_id"]
    if name in {"add_layer", "select_layer"}:
        assert "visible" not in intent["args"]
        assert "date" not in intent["args"]
    assert result["operation_status"] == "pending"
    assert page == before  # Parser never simulates client execution.


@pytest.mark.parametrize("verb", ["添加", "显示", "选中", "切换到", "隐藏"])
def test_unknown_target_cannot_be_guessed(page, local_chat, open_products, verb):
    result = local_chat(verb + "星辰XYZ不存在的图层", client_context=page)
    assert result["ui_intents"] == []
    assert result["operation_status"] == "needs_clarification"


def test_catalog_selection_explicitly_adds_then_selects(page, monkeypatch):
    monkeypatch.setattr(mo, "_catalog_pick", lambda text: mo.LayerPick("available-catalog-only", "目录产品"))
    result = o._resolve_simple_layer_operation("切换到目录XYZ产品", page)
    assert [i["name"] for i in result["ui_intents"]] == ["add_layer", "select_layer"]
    assert all(i["args"]["catalog_id"] == "available-catalog-only" for i in result["ui_intents"])
    assert result["operation_target"]["catalog_id"] == "available-catalog-only"


@pytest.mark.parametrize("prefix", ["不要执行，只生成计划：", "只查询，不修改任何状态："])
def test_policy_blocks_new_mutations(page, local_chat, open_products, prefix):
    result = local_chat(prefix + "添加风云平均VOD，然后选中它", client_context=page)
    assert result["ui_intents"] == []
    assert not result.get("operation_plan")


@pytest.mark.parametrize("text", [
    "选中风云平均VOD，然后告诉我当前选中图层是什么",
    "切换到SMAP动态SM，再查询当前图层的日期",
    "添加风云平均VOD，然后选中它",
])
def test_action_followed_by_query_or_reference_is_not_swallowed(text):
    assert page_query_kind(text) is None
    steps = plan_operations(text)
    assert len(steps) == 2
    assert steps[0]["operation"] in {"select_layer", "add_layer"}
    if "它" in text:
        assert steps[1]["inherit_target"] and steps[1]["depends_on"] == "step-1"
    else:
        assert steps[1]["operation"] == "query_state"


def test_source_digits_are_not_dates():
    assert not has_timeline_request("切换到FY3平均VOD")
    assert operation_kind("切换到FY3平均VOD") == "select_layer"
    assert operation_kind("风云平均VOD切到2025年7月20日") == "set_timeline"


def test_new_intents_are_mutating_and_advertised():
    assert {"add_layer", "select_layer"} <= o._ALLOWED_INTENTS
    assert {"add_layer", "select_layer"} <= o._MUTATING_UI_INTENTS
    result = {"reply": "已下发", "ui_intents": [{"name":"select_layer","args":{"catalog_id":"x"}}]}
    assert not o._guard_read_only_ui_intents("只查询，不要选中任何图层", result)["ui_intents"]


@pytest.mark.parametrize("text", [
    "有哪些降水图层？说明单位及是否已添加。",
    "列出已添加的风云图层",
    "查看当前选中的图层日期是多少？",
])
def test_catalog_or_state_questions_never_become_add_or_select(page, text):
    assert o._resolve_simple_layer_operation(text, page) is None


def test_parallel_object_list_keeps_existing_multi_target_route(page):
    assert o._resolve_simple_layer_operation("显示SMAP平均SM及SMAP平均VOD", page) is None


@pytest.mark.parametrize("text,names", [
    ("添加风云平均SM和风云平均VOD", ["add_layer", "add_layer"]),
    ("选中风云平均SM及风云平均VOD", ["select_layer", "select_layer"]),
])
def test_parallel_targets_retain_action_kind(page, text, names):
    result = o._resolve_deterministic_map_actions(text, page)
    assert result is not None
    assert [i["name"] for i in result] == names
    assert {i["args"]["catalog_id"] for i in result} == {
        page["active_layers"][i]["catalog_id"] for i in [0, 1]}
    assert not any("visible" in i["args"] for i in result)


def test_date_only_switch_does_not_become_show(page, monkeypatch):
    monkeypatch.setattr(mo, "_layer_is_static", lambda cid: False)
    monkeypatch.setattr(mo, "_build_timeline_reply", lambda args, ctx: ("等待取数", True))
    result = o._resolve_deterministic_map_actions("把风云平均VOD切换到2025-07-20", page)
    assert result and [i["name"] for i in result] == ["set_timeline"]


@pytest.mark.parametrize("verb", ["添加", "选中"])
def test_unavailable_target_is_blocked_by_shared_guard(page, local_chat, monkeypatch, verb):
    from app.services.agent import server_tools_runtime as runtime
    monkeypatch.setattr(runtime, "layer_operation_block_reason", lambda *a, **k: "该产品数据服务未开放")
    before = copy.deepcopy(page)
    result = local_chat(verb + "风云平均VOD", client_context=page)
    assert not result["ui_intents"]
    assert result["operation_status"] == "not_executed"
    assert "未开放" in result["reply"] and page == before


def test_select_after_add_uses_receipt_reference_not_old_selection(page, local_chat, open_products):
    for row in page["active_layers"]:
        row["selected"] = False
    page["active_layers"][9]["selected"] = True
    target = page["active_layers"][1]
    context = {**page, "operation_single": True, "operation_inherit_target": True,
               "operation_reference": {"catalog_id": target["catalog_id"],
                                       "instance_id": target["instance_id"]}}
    result = local_chat("选中它", client_context=context)
    assert [i["name"] for i in result["ui_intents"]] == ["select_layer"]
    assert result["ui_intents"][0]["args"]["instance_id"] == target["instance_id"]
    assert result["operation_target"]["catalog_id"] == target["catalog_id"]


@pytest.mark.parametrize("verb", ["显示", "隐藏", "添加", "选中"])
def test_parallel_short_variable_inherits_explicit_first_product(page, verb):
    for row in page["active_layers"]:
        row["selected"] = False
    page["active_layers"][9]["selected"] = True
    before = copy.deepcopy(page)
    result = o._resolve_deterministic_map_actions(verb + "风云平均SM和VOD", page)
    assert result is not None
    assert {i["args"]["catalog_id"] for i in result} == {
        page["active_layers"][i]["catalog_id"] for i in [0, 1]}
    assert page == before


@pytest.mark.parametrize("verb,name", [
    ("显示", "set_layer_visibility"), ("隐藏", "set_layer_visibility"),
    ("添加", "add_layer"), ("选中", "select_layer"),
])
@pytest.mark.parametrize("targets", [
    "风云平均SM和SMAP平均SM", "SMAP平均SM及风云平均SM",
])
def test_parallel_same_variable_across_sources_is_split_before_target_resolution(
        page, local_chat, open_products, verb, name, targets):
    for row in page["active_layers"]:
        row["selected"] = False
    page["active_layers"][11]["selected"] = True
    before = copy.deepcopy(page)
    result = local_chat("同时" + verb + targets, client_context=page)
    actions = result["ui_intents"]
    assert len(actions) == 2
    assert all(i["name"] == name for i in actions)
    expected_indices = (0, 3) if targets.startswith("风云") else (3, 0)
    assert [i["args"]["catalog_id"] for i in actions] == [
        page["active_layers"][i]["catalog_id"] for i in expected_indices]
    if name == "set_layer_visibility":
        assert all(i["args"]["visible"] is (verb == "显示") for i in actions)
    else:
        assert not any("visible" in i["args"] for i in actions)
    assert result["operation_status"] == "pending"
    assert not result.get("operation_issues")
    assert page == before
