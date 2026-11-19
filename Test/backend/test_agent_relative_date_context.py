"""Shared date/context rules. Page fixtures simulate state, not real data."""
from copy import deepcopy

import pytest

from test_agent_single_step_regressions import page  # noqa: F401
from app.services.agent.operation_plan import prepare_local_action, bind_reference
from app.services.agent.request_semantics import (
    has_timeline_request,
    implicit_timeline_target,
    relative_day_offset,
    unresolved_target_qualification,
)


def answer(reply, status="success", intents=None):
    return {"reply": reply, "operation_status": status, "ui_intents": intents or []}


@pytest.mark.parametrize("text,offset", [
    ("把当前图层的日期切换到下一天", 1),
    ("将当前图层换到上一天", -1),
    ("当前图层切到后一天", 1),
    ("日期向前移一天", -1),
    ("当前图层日期往后两天", 2),
    ("往前挪3天", -3),
    ("把日期延后十一天", 11),
    ("日期前进一天", 1),
    ("日期后退两天", -2),
])
def test_calendar_offsets_share_one_parser(text, offset):
    assert relative_day_offset(text) == offset
    assert has_timeline_request(text)


@pytest.mark.parametrize("text", [
    "日期设置为2025年7月21日", "将日期设为20250722",
    "把当前图层的日期切换到下一天", "只改日期到7月22日",
])
def test_implicit_date_object_is_a_bounded_syntax(text):
    assert implicit_timeline_target(text)


@pytest.mark.parametrize("text", [
    "把不存在的星辰99图层切到2025-07-21",
    "把SMAP动态版土壤水分切到2025-07-21",
    "切换到天际99图层并改日期2025-07-21",
    "设置为不存在的图层2025-07-21",
])
def test_named_objects_are_not_replaced_by_current(text):
    assert not implicit_timeline_target(text)


def selected_page(page, index=9):
    for i, row in enumerate(page["active_layers"]):
        row["selected"] = i == index
        row["requested_time"] = {"date": "2025-07-22", "hour": 0}
    page["timeline"] = {"date": "2025-07-31", "hour": 0}
    return page


def test_next_day_uses_target_memory_not_other_timeline_date(page):
    context = selected_page(page)
    before = deepcopy(context)
    prepared, result = prepare_local_action(
        "把当前图层的日期切换到下一天", context, answer
    )
    assert result is None
    assert "SMAP" in prepared and "动态" in prepared
    assert "2025-07-23" in prepared and "土壤水分" in prepared
    assert context == before


def test_explicit_noncurrent_relative_target_keeps_its_own_date(page):
    context = selected_page(page, 1)
    prepared, result = prepare_local_action(
        "把SMAP动态版土壤水分的日期往后两天", context, answer
    )
    assert result is None
    assert "SMAP" in prepared and "2025-07-24" in prepared


@pytest.mark.parametrize("text", [
    "日期设置为2025年7月21日", "日期设为20250721",
    "把当前图层切到2025-07-21",
])
def test_absolute_date_without_name_binds_only_selected_object(page, text):
    context = selected_page(page)
    prepared, result = prepare_local_action(text, context, answer)
    assert result is None
    assert "SMAP" in prepared and "动态" in prepared and "2025-07-21" in prepared
    assert "切到" in prepared


@pytest.mark.parametrize("selected", [[], [0, 9]])
def test_date_without_unique_selection_asks_instead_of_guessing(page, selected):
    for index, row in enumerate(page["active_layers"]):
        row["selected"] = index in selected
    prepared, result = prepare_local_action(
        "日期设置为2025年7月21日", page, answer
    )
    assert result["operation_status"] == "needs_clarification"
    assert not result["ui_intents"]


def test_relative_date_without_date_memory_requests_date(page):
    context = selected_page(page)
    context["active_layers"][9]["requested_time"] = {}
    context["timeline"] = {}
    _, result = prepare_local_action("把当前图层切到下一天", context, answer)
    assert result["operation_status"] == "needs_clarification"
    assert not result["ui_intents"]


@pytest.mark.parametrize("text", [
    "显示SMAP土壤水分，我还没有指定平均版还是动态版。",
    "显示SMAP土壤水分，平均和动态我还没选。",
    "打开SMAP土壤水分，版本没说清。",
    "显示SMAP土壤水分，先别猜版本。",
])
def test_explicitly_unresolved_version_blocks_before_splitting(page, text):
    assert unresolved_target_qualification(text)
    _, result = prepare_local_action(text, selected_page(page), answer)
    assert result["operation_status"] == "needs_clarification"
    assert not result["ui_intents"]


def test_date_question_is_read_only_even_when_it_mentions_next_day(page):
    text = "当前图层的下一天是什么日期？"
    assert not has_timeline_request(text)
    prepared, result = prepare_local_action(text, selected_page(page), answer)
    assert prepared == text and result is None


@pytest.mark.parametrize("text", [
    "显示SMAP动态版土壤水分，日期我还没指定。",
    "显示风云平均版SM，其他图层的版本未指定但保持原状。",
])
def test_missing_other_parameters_does_not_invent_version_ambiguity(text):
    assert not unresolved_target_qualification(text)


def test_relative_followup_uses_confirmed_reference_before_current_selection(page):
    context = selected_page(page, 1)
    target = context["active_layers"][9]
    context.update(
        operation_inherit_target=True,
        operation_reference={
            "catalog_id": target["catalog_id"],
            "instance_id": target["instance_id"],
        },
    )
    prepared, result = prepare_local_action("把它切到下一天", context, answer)
    assert result is None
    assert "SMAP" in prepared and "动态" in prepared and "2025-07-23" in prepared


def test_explicit_current_reference_still_uses_page_selection(page):
    context = selected_page(page, 1)
    old = context["active_layers"][9]
    context.update(
        operation_inherit_target=True,
        operation_reference={
            "catalog_id": old["catalog_id"],
            "instance_id": old["instance_id"],
        },
    )
    prepared, result = prepare_local_action("把当前图层切到下一天", context, answer)
    assert result is None
    assert "风云" in prepared and "平均" in prepared and "2025-07-23" in prepared


def test_bind_reference_explicit_current_and_product_override_old_reference(page):
    context = selected_page(page, 1)
    old = context["active_layers"][9]
    context.update(
        operation_inherit_target=True,
        operation_reference={
            "catalog_id": old["catalog_id"],
            "instance_id": old["instance_id"],
        },
    )
    for text in ["把当前图层切到2025-07-23", "把风云平均版VOD切到2025-07-23"]:
        _, bound, reference, error = bind_reference(text, context)
        assert error is None
        assert reference["catalog_id"] == context["active_layers"][1]["catalog_id"]
        assert not bound["operation_inherit_target"]
