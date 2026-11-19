"""Prompt payload regressions: keep context/receipts while removing duplication."""

import json
from datetime import datetime
from unittest.mock import patch

from app.services.agent import dialogue_state
from app.services.agent import orchestrator as agent
from app.services.agent.usage import estimate_tokens


def _context():
    return {
        "active_layers": [
            {
                "catalog_id": "fixture-sm",
                "name": "SMAP 土壤水分",
                "visible": False,
                "selected": True,
            }
        ],
        "timeline": {"date": "2025-07-31", "hour": 12, "playing": False},
        "map_point": {"lng": 116.4, "lat": 39.9},
        "map_ready": False,
        "intent_results": [
            {"name": "set_timeline", "ok": False, "message": "静态层无法切换日期"}
        ],
        "untrusted_extra": "This must not reach the model",
    }


def _json_context(system):
    block = system.split("## Current client_context\n```json\n", 1)[1]
    return json.loads(block.split("\n```", 1)[0])


def test_context_keeps_receipts_selection_point_and_clock_once():
    ctx = _context()
    system = agent._build_system(ctx, cred=None)
    data = _json_context(system)
    assert data.pop("page_state_summary") == {
        "added_count": 1, "visible_count": 0, "selected_count": 1,
        "visibility_unknown_count": 0, "listed_count": 1,
    }
    assert data == agent.sanitize_client_context(ctx)
    assert system.count("静态层无法切换日期") == 1
    assert "This must not reach the model" not in system
    assert datetime.now().astimezone().strftime("%Y-%m-%d") in system
    assert "不是今天" in system
    assert ctx["active_layers"][0]["selected"] is True  # caller unchanged


def test_oversized_context_stays_valid_json_with_failed_receipts():
    ctx = _context()
    ctx["active_layers"] *= 40
    ctx["active_catalog_ids"] = [f"fixture-{i}" for i in range(40)]
    system = agent._build_system(ctx, cred=None)
    data = _json_context(system)
    assert data["intent_results"][0]["ok"] is False
    assert data["timeline"]["date"] == "2025-07-31"
    assert data["map_point"] == {"lng": 116.4, "lat": 39.9}


def test_build_does_not_lookup_or_inject_arbitrary_catalog_sample():
    with patch.object(
        agent, "catalog_summary", side_effect=AssertionError("no lookup")
    ):
        system = agent._build_system(_context(), cred=None)
    assert "Catalog sample" not in system
    assert "search_layers" in system
    assert "search_layers" in {t["function"]["name"] for t in agent._all_tools_openai()}


def test_confirmed_topic_survives_page_selection_change():
    topic = {
        "layer_id": "fixture-other",
        "layer_name": "风云土壤水分",
        "region": "北京市",
        "date": "2025-12-15",
    }
    description = dialogue_state.describe(topic)
    assert description
    system = agent._build_system(_context(), cred=None, topic_state=topic)
    assert description in system
    assert _json_context(system)["active_layers"][0]["catalog_id"] == "fixture-sm"


def test_static_policy_is_stable_and_small_enough_for_full_tools():
    policy = agent.load_system_prompt()
    assert estimate_tokens(policy) < 4500
    assert agent._build_system(None, cred=None).startswith(policy)
    system = agent._build_system(_context(), cred=None)
    assert system.startswith(policy)
    # Old static policy alone exceeded 16k; keep full-tool first hop under 9k.
    assert (
        agent._estimate_prompt_tokens(
            system=system, history=[], message="你好", tools=agent._all_tools_openai()
        )
        < 9000
    )


def test_breakdown_counts_only_context_actually_sent():
    ctx = _context()
    ctx["untrusted_extra"] = "额外页面数据" * 10000
    system = agent._build_system(ctx, cred=None)
    result = agent._input_token_breakdown(
        system=system, history=[], message="问题", tools=[], client_context=ctx
    )
    assert result["page_context"] == estimate_tokens(agent._client_context_block(ctx))
    assert result["system_prompt"] > 0
    assert result["page_context"] + result["system_prompt"] == estimate_tokens(system)
    absent = agent._input_token_breakdown(
        system="no page context",
        history=[],
        message="问题",
        tools=[],
        client_context=ctx,
    )
    assert absent["page_context"] == 0


def test_scientific_and_action_boundaries_remain_in_policy():
    policy = agent.load_system_prompt()
    for constraint in (
        "用户批准后才提交",
        "ui_intents=[]",
        "executed=false",
        "value_basis",
        "climatology",
        "block_shared",
        "region_empty_hint",
        "total_pixels",
        "不是测量精度",
        "历史同期基线",
        "不是今天",
        "coverage_conflict",
        "不能擅自用区域均值顶替",
        "产品沿用上一轮",
    ):
        assert constraint in policy
    assert "2015-04-01 至 2025-12-31" not in policy
