"""Guest input guard uses the deployment budget without capping account users."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services.agent import orchestrator as agent


@pytest.mark.parametrize("role", [None, "demo", "guest", "admin", "standard"])
def test_guest_input_override_does_not_change_account_budget(monkeypatch, role):
    monkeypatch.setenv("BACKEND_AGENT_MAX_PROMPT_TOKENS", "0")
    monkeypatch.setenv("BACKEND_AGENT_GUEST_MAX_PROMPT_TOKENS", "40000")
    cred = SimpleNamespace(role=role) if role else None
    assert agent._prompt_token_budget(cred=cred) == (
        0 if role in {"admin", "standard"} else 40000
    )


def test_missing_guest_override_preserves_existing_deployment_budget(monkeypatch):
    monkeypatch.delenv("BACKEND_AGENT_GUEST_MAX_PROMPT_TOKENS", raising=False)
    monkeypatch.setenv("BACKEND_AGENT_MAX_PROMPT_TOKENS", "20000")
    assert agent._prompt_token_budget(cred=SimpleNamespace(role="demo")) == 20000


def test_invalid_guest_override_has_a_safe_fallback(monkeypatch):
    monkeypatch.setenv("BACKEND_AGENT_MAX_PROMPT_TOKENS", "0")
    monkeypatch.setenv("BACKEND_AGENT_GUEST_MAX_PROMPT_TOKENS", "invalid")
    assert agent._prompt_token_budget(cred=SimpleNamespace(role="guest")) == 20000
    assert agent._prompt_token_budget(cred=SimpleNamespace(role="admin")) == 0


def test_input_estimate_includes_system_history_message_and_tools():
    base = dict(system="", history=[], message="", tools=[])
    original = agent._estimate_prompt_tokens(**base)
    for field, value in (
        ("system", "系统提示" * 100),
        ("history", [{"role": "user", "content": "历史输入" * 100}]),
        ("message", "本次问题" * 100),
        ("tools", [{"type": "function", "function": {"description": "工具定义" * 100}}]),
    ):
        assert agent._estimate_prompt_tokens(**{**base, field: value}) > original


@pytest.mark.parametrize("estimate, should_call", [(40000, True), (40001, False)])
def test_guest_first_model_hop_checks_full_input(monkeypatch, estimate, should_call):
    monkeypatch.setenv("BACKEND_AGENT_MAX_PROMPT_TOKENS", "0")
    monkeypatch.setenv("BACKEND_AGENT_GUEST_MAX_PROMPT_TOKENS", "40000")
    monkeypatch.setattr(agent, "get_effective_profile_raw", lambda **_: {
        "id": "test-budget", "protocol": "openai", "provider_kind": "openai",
        "context_window_input": 64000, "context_window_output": 2048,
        "model": "test-model", "base_url": "https://invalid.example",
    })
    monkeypatch.setattr(agent, "load_topic_state", lambda **_: {})
    monkeypatch.setattr(agent, "load_history", lambda **_: [])
    monkeypatch.setattr(agent, "append_turn", lambda **_: None)
    monkeypatch.setattr(agent, "get_profile_api_key", lambda *_, **__: "test-only-key")
    monkeypatch.setattr(agent, "_local_takeover", lambda *_, **__: None)
    monkeypatch.setattr(agent, "_estimate_prompt_tokens", lambda **_: estimate)
    model = Mock(return_value={
        "choices": [{"message": {"role": "assistant", "content": "这是一条测试回答。"},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110},
    })
    monkeypatch.setattr(agent.openai_compat, "chat_completions", model)
    result = agent._run_chat_impl(
        "请用一句话介绍遥感观测的作用。",
        cred=SimpleNamespace(role="demo", user_id=42),
    )
    assert bool(model.call_count) is should_call
    if not should_call:
        assert result["provider"] == "guard"
        assert result["ui_intents"] == []
        assert result["usage"]["budget"] == 40000
        assert result["usage"]["hops"][0]["actual_tokens"] == 0
