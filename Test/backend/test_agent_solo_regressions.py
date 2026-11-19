"""Only/keep-only synonyms: same existing solo command, independent of selection."""
import copy
import pytest
from test_agent_single_step_regressions import page, local_chat  # noqa: F401
from app.services.agent import orchestrator as o

@pytest.mark.parametrize("text", [
    "仅保留风云平均版VOD显示。",
    "仅保留风云平均版VOD。",
    "只显示风云平均版VOD，隐藏其他图层。",
    "仅保留SMAP动态版土壤水分显示。",
    "仅保留SMAP动态版土壤水分。",
    "只显示SMAP动态版土壤水分，隐藏其他图层。",
])
@pytest.mark.parametrize("target_selected", [True, False])
def test_solo_synonyms_bind_target_not_selection(page, local_chat, monkeypatch, text, target_selected):
    target_idx = 9 if "SMAP" in text else 1
    other_idx = 1 if target_idx == 9 else 9
    for row in page["active_layers"]:
        row["selected"] = row["visible"] = False
    for idx, date in [(1, "2025-07-14"), (9, "2025-07-24")]:
        page["active_layers"][idx].update(visible=True, requested_time={"date":date,"hour":0}, actual_time=date.replace("-",""))
    page["active_layers"][target_idx if target_selected else other_idx]["selected"] = True
    before = copy.deepcopy(page)
    monkeypatch.setattr(o, "_run_chat_single", lambda *a, **kw: pytest.fail("explicit solo must not reach model/fallback"))
    result = local_chat(text, client_context=page)
    assert not result.get("operation_plan")
    assert len(result["ui_intents"]) == 1
    action = result["ui_intents"][0]
    assert action["name"] == "set_layer_visibility"
    assert action["args"]["catalog_id"] == page["active_layers"][target_idx]["catalog_id"]
    assert action["args"]["visible"] is True and action["args"]["solo"] is True
    assert page == before

@pytest.mark.parametrize("text", [
    "当前选中图层的日期是多少？只查询，不修改。",
    "只生成计划，不执行：仅保留风云平均版VOD。",
    "不要仅保留风云平均版VOD，保持其他图层不变。",
])
def test_solo_words_do_not_override_read_only_or_negation(page, local_chat, text):
    result = local_chat(text, client_context=page)
    assert not result["ui_intents"]
    assert not result.get("operation_plan")

@pytest.mark.parametrize("text", ["显示风云平均版VOD。", "打开SMAP动态版土壤水分。"])
def test_ordinary_show_never_becomes_solo(page, local_chat, text):
    result = local_chat(text, client_context=page)
    assert len(result["ui_intents"]) == 1
    assert not result["ui_intents"][0]["args"].get("solo")

def test_unknown_keep_target_cannot_hide_existing_layers(page, local_chat):
    result = local_chat("仅保留星辰XYZ99图层。", client_context=page)
    assert not result["ui_intents"]
    assert result.get("operation_status") != "success"
