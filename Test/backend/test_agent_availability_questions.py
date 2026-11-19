
"""Availability questions use both read-only inventories; no UI commands or pixels."""
from copy import deepcopy
import pytest
from test_agent_single_step_regressions import page, local_chat  # noqa: F401
from app.services.agent import orchestrator as o, server_tools_runtime as rt


def coverage(status="available"):
    return {"ok":True,"display_name":"SMAP 动态版 · 土壤水分","daily_switch_supported":True,
            "channels":{"local":{"count":3,"coverage_start":"20250701","coverage_end":"20260208"},
                        "nas":{"status":status,"count":4018,"coverage_start":"20150101","coverage_end":"20251231",
                               "declared_coverage":{"start":"20150401","end":"20251231"},
                               "declared_coverage_conflict":True}}}


@pytest.mark.parametrize("text",[
    "SMAP动态版土壤水分有哪些可用日期？是否支持日尺度切换？",
    "查询SMAP动态SM的可用时间范围，并告诉我能否按日切换。",
    "SMAP动态版SM支持逐日吗？有哪些日期可用？",
])
def test_complete_availability_question_is_one_read_only_answer(page,local_chat,monkeypatch,text):
    before=deepcopy(page);calls=[]
    def get(args,**kwargs):
        calls.append(args);return coverage()
    monkeypatch.setattr(rt,"_get_layer_coverage",get)
    monkeypatch.setattr(o,"_run_chat_single",lambda *a,**kw:pytest.fail("metadata must not go to model"))
    result=local_chat(text,client_context=page)
    assert len(calls)==1 and calls[0]["catalog_id"]==page["active_layers"][9]["catalog_id"]
    assert calls[0]["include_nas"] is True
    assert result["provider"]=="local-availability"
    assert result["ui_intents"]==[] and not result.get("operation_plan")
    assert "4018" in result["reply"] and "2015-01-01" in result["reply"]
    assert "2026-02-08" in result["reply"] and "本地" in result["reply"] and "NAS" in result["reply"]
    assert "登记范围外" in result["reply"] and "像元" in result["reply"]
    assert page==before


def test_selected_availability_reads_page_not_visible_or_prior_layer(page,local_chat,monkeypatch):
    monkeypatch.setattr(rt,"_get_layer_coverage",lambda args,**kw:{**coverage(),"catalog_id":args["catalog_id"]})
    result=local_chat("当前图层有哪些可用日期？是否支持日尺度切换？",client_context=page)
    assert result["operation_target"]["catalog_id"]==page["active_layers"][1]["catalog_id"]
    assert not result["ui_intents"]


def test_ambiguous_availability_has_no_side_effect_or_remote_call(page,local_chat,monkeypatch):
    for row in page["active_layers"]:row["selected"]=False
    monkeypatch.setattr(rt,"_get_layer_coverage",lambda *a,**kw:pytest.fail("ambiguous remote query"))
    result=local_chat("SMAP土壤水分有哪些可用日期？",client_context=page)
    assert result["operation_status"]=="needs_clarification" and not result["ui_intents"]


def test_nas_failure_does_not_claim_absent_dates_or_use_local_range_as_nas(page,local_chat,monkeypatch):
    monkeypatch.setattr(rt,"_get_layer_coverage",lambda *a,**kw:coverage("source_unavailable"))
    result=local_chat("SMAP动态SM有哪些可用日期？",client_context=page)
    assert "尚未核实" in result["reply"] and "不能据此认定没有数据" in result["reply"]
    assert "4018" not in result["reply"] and not result["ui_intents"]


@pytest.mark.parametrize("text",[
    "显示SMAP动态SM，然后查询它有哪些可用日期",
    "把SMAP动态SM的日期设为2025-07-22，再查可用日期",
])
def test_mixed_commands_are_not_swallowed_by_metadata_question(text):
    assert not o._is_layer_availability_question(text)


@pytest.mark.parametrize("text", ["列出可用的降水数据，说明单位和可用时间。", "有哪些降水图层？说明单位及可用日期。"])
def test_catalog_listing_stays_with_existing_catalog_query(text):
    assert not o._is_layer_availability_question(text)


def test_index_exception_is_reported_without_ui_actions(page,local_chat,monkeypatch):
    def broken(*a,**kw):
        raise OSError("test-only unavailable source")
    monkeypatch.setattr(rt,"_get_layer_coverage",broken)
    result=local_chat("SMAP动态SM有哪些可用日期？",client_context=page)
    assert result["operation_status"]=="failed"
    assert "未能核实" in result["reply"] and not result["ui_intents"]
