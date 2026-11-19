"""未登录访客的「按天」助手额度（rate_limit.check_agent_guest_daily_quota）。

覆盖点：
1. 同一访客正好放行 ``limit`` 次，第 ``limit+1`` 次拒绝，且 Retry-After 指向次日零点；
2. 不同访客互不挤占（同一 IP 下也各自独立）——这是「按人记」的核心；
3. 前端没上报访客号时退回按 IP 计（旧缓存页面照样限得住）；
4. 额度 <= 0 时完全关闭（本机探针/自动化用）；
5. 计数键包含北京日期，跨日自动换桶（不依赖 Redis TTL 也成立）。
"""

from __future__ import annotations

import pytest

from app.api import rate_limit as rl


@pytest.fixture()
def isolated(monkeypatch):
    """强制走进程内计数，避免测试触碰真实 Redis；前后清空降级桶。"""
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: None)
    monkeypatch.setattr(rl, "_guest_quota_redis_day", None)
    rl._guest_quota_memory.clear()
    yield
    rl._guest_quota_memory.clear()


def test_limit_blocks_exactly_after_limit(isolated):
    limit = rl.guest_quota_limit()
    assert limit > 0, "默认应开启游客额度"

    allowed = [
        rl.check_agent_guest_daily_quota("visitor-a", "10.0.0.1").allowed
        for _ in range(limit)
    ]
    assert all(allowed)

    blocked = rl.check_agent_guest_daily_quota("visitor-a", "10.0.0.1")
    assert blocked.allowed is False
    # Retry-After 应是「距北京次日 0 点」的秒数，落在 (0, 一天] 区间
    assert 1 <= blocked.retry_after_seconds <= 24 * 3600 + 60


def test_visitors_are_independent_even_on_same_ip(isolated):
    visitor_id1, visitor_id2, ip = "visitor-b1", "visitor-b2", "10.0.0.2"
    for _ in range(rl.guest_quota_limit()):
        assert rl.check_agent_guest_daily_quota(visitor_id1, ip).allowed

    assert rl.check_agent_guest_daily_quota(visitor_id1, ip).allowed is False
    # 同一出口 IP 下的另一个访客不受影响
    assert rl.check_agent_guest_daily_quota(visitor_id2, ip).allowed is True


def test_falls_back_to_ip_when_visitor_id_missing(isolated):
    ip = "10.0.0.3"
    for _ in range(rl.guest_quota_limit()):
        assert rl.check_agent_guest_daily_quota(None, ip).allowed
    assert rl.check_agent_guest_daily_quota(None, ip).allowed is False
    # 空串等同于没上报
    assert rl.check_agent_guest_daily_quota("", ip).allowed is False
    # 另一个 IP 仍有自己的额度
    assert rl.check_agent_guest_daily_quota(None, "10.0.0.4").allowed is True


def test_zero_limit_disables_quota(isolated, monkeypatch):
    monkeypatch.setattr(rl, "_GUEST_QUOTA_LIMIT", 0)
    assert all(
        rl.check_agent_guest_daily_quota("visitor-d", "10.0.0.5").allowed
        for _ in range(50)
    )


def test_key_contains_beijing_day(isolated):
    day, ttl = rl._beijing_day_and_ttl()
    key = rl._guest_quota_key("visitor-e", "10.0.0.6")
    assert day in key
    assert 60 <= ttl <= 24 * 3600 + 60


def test_visitor_id_is_hashed_not_stored_raw(isolated):
    raw = "visitor-should-not-leak"
    key = rl._guest_quota_key(raw, "10.0.0.7")
    assert raw not in key


class _FakeRequest:
    """只带 cookies 的最小请求替身（has_valid_session 只用到这一项）。"""

    def __init__(self, cookies: dict[str, str]) -> None:
        self.cookies = cookies


@pytest.fixture()
def session_cookie_name():
    from app.core.config import settings

    return settings.session_cookie_name


def test_no_cookie_is_not_a_session(session_cookie_name):
    assert rl.has_valid_session(_FakeRequest({})) is False


def test_bogus_cookie_is_not_a_session(session_cookie_name, monkeypatch):
    """随便塞一个 cgda_session=fake 不能算已登录，否则额度直接被绕过。"""
    monkeypatch.setattr(
        "app.services.session_service.get_session", lambda token: None
    )
    req = _FakeRequest({session_cookie_name: "totally-fake-token"})
    assert rl.has_valid_session(req) is False


def test_real_session_is_recognised(session_cookie_name, monkeypatch):
    monkeypatch.setattr(
        "app.services.session_service.get_session",
        lambda token: {"user_id": 1} if token == "good" else None,
    )
    req = _FakeRequest({session_cookie_name: "good"})
    assert rl.has_valid_session(req) is True


def test_session_lookup_error_falls_back_to_guest(session_cookie_name, monkeypatch):
    """会话存储故障时按游客处理（fail-closed），宁可多限不漏限。"""

    def boom(token):  # noqa: ANN001, ARG001
        raise RuntimeError("redis down")

    monkeypatch.setattr("app.services.session_service.get_session", boom)
    req = _FakeRequest({session_cookie_name: "whatever"})
    assert rl.has_valid_session(req) is False


# ---------------------------------------------------------------------------
# 按角色判定：游客登录用的是共享 demo 账号，它同样有合法会话 Cookie。
# 只看「有没有会话」会把这类请求判成已登录、从而完全不限额——2026-11-08
# 实测确认过（游客登录后 /agent/quota 直接返回 scope=account）。
# ---------------------------------------------------------------------------


def _patch_session(monkeypatch, role_by_token: dict[str, dict]):
    monkeypatch.setattr(
        "app.services.session_service.get_session",
        lambda token: role_by_token.get(token),
    )


def test_guest_login_with_demo_account_still_counts(session_cookie_name, monkeypatch):
    """「以游客身份进入」= demo 会话，必须照样占游客额度。"""
    _patch_session(monkeypatch, {"demo-token": {"user_id": 2, "role": "demo"}})
    req = _FakeRequest({session_cookie_name: "demo-token"})
    assert rl.session_role(req) == "demo"
    assert rl.is_guest_request(req) is True


def test_admin_session_is_exempt(session_cookie_name, monkeypatch):
    _patch_session(monkeypatch, {"admin-token": {"user_id": 1, "role": "admin"}})
    req = _FakeRequest({session_cookie_name: "admin-token"})
    assert rl.session_role(req) == "admin"
    assert rl.is_guest_request(req) is False


def test_standard_session_is_exempt(session_cookie_name, monkeypatch):
    _patch_session(monkeypatch, {"std-token": {"user_id": 3, "role": "standard"}})
    req = _FakeRequest({session_cookie_name: "std-token"})
    assert rl.is_guest_request(req) is False


def test_role_is_case_insensitive(session_cookie_name, monkeypatch):
    _patch_session(monkeypatch, {"t": {"user_id": 2, "role": "DEMO"}})
    req = _FakeRequest({session_cookie_name: "t"})
    assert rl.session_role(req) == "demo"
    assert rl.is_guest_request(req) is True


def test_no_cookie_counts_as_guest(session_cookie_name):
    assert rl.session_role(_FakeRequest({})) is None
    assert rl.is_guest_request(_FakeRequest({})) is True


def test_bogus_cookie_counts_as_guest(session_cookie_name, monkeypatch):
    _patch_session(monkeypatch, {})
    req = _FakeRequest({session_cookie_name: "fake"})
    assert rl.session_role(req) is None
    assert rl.is_guest_request(req) is True


def test_session_without_role_counts_as_guest(session_cookie_name, monkeypatch):
    """会话里没有 role 字段（旧数据）时不能当成免额度账号。"""
    _patch_session(monkeypatch, {"old-token": {"user_id": 9}})
    req = _FakeRequest({session_cookie_name: "old-token"})
    assert rl.session_role(req) is None
    assert rl.is_guest_request(req) is True


def test_session_error_counts_as_guest(session_cookie_name, monkeypatch):
    def boom(token):  # noqa: ANN001, ARG001
        raise RuntimeError("redis down")

    monkeypatch.setattr("app.services.session_service.get_session", boom)
    req = _FakeRequest({session_cookie_name: "whatever"})
    assert rl.session_role(req) is None
    assert rl.is_guest_request(req) is True


# ---------------------------------------------------------------------------
# 三道闸：访客号 20 / 同 IP 100 / 全站 300（2026-11-08 新增）
# ---------------------------------------------------------------------------
# 防的是「清 localStorage 换个新访客号」这种绕过：第一道按浏览器记，清一下即
# 清零；所以补第二道绑网络、第三道绑全站。这里把上限压小以便快速触顶。


@pytest.fixture()
def small_limits(isolated, monkeypatch):
    """把三道闸压到 2 / 5 / 7，方便几次调用就触顶。"""
    monkeypatch.setattr(rl, "_GUEST_QUOTA_LIMIT", 2)
    monkeypatch.setattr(rl, "_GUEST_IP_QUOTA_LIMIT", 5)
    monkeypatch.setattr(rl, "_GUEST_GLOBAL_QUOTA_LIMIT", 7)
    return {"visitor": 2, "ip": 5, "global": 7}


def test_layer_blocks_on_visitor_quota(small_limits):
    for _ in range(small_limits["visitor"]):
        result, scope = rl.check_agent_guest_quota_layers("v1", "1.1.1.1")
        assert result.allowed is True
        assert scope is None

    result, scope = rl.check_agent_guest_quota_layers("v1", "1.1.1.1")
    assert result.allowed is False
    assert scope == rl.QUOTA_SCOPE_VISITOR
    assert 1 <= result.retry_after_seconds <= 24 * 3600 + 60


def test_same_ip_caps_across_browsers(small_limits):
    """换新访客号（＝清 localStorage）也突破不了同 IP 上限。"""
    ip = "1.1.1.2"
    for i in range(small_limits["visitor"]):
        assert rl.check_agent_guest_quota_layers(f"browser-{i}a", ip)[0].allowed
        assert rl.check_agent_guest_quota_layers(f"browser-{i}b", ip)[0].allowed

    # 已用 4 次（IP 上限 5），新浏览器还能用 1 次
    assert rl.check_agent_guest_quota_layers("browser-fresh", ip)[0].allowed

    # 第 6 次开始被 IP 那道挡住，且报的是 ip 而不是 visitor
    result, scope = rl.check_agent_guest_quota_layers("browser-newer", ip)
    assert result.allowed is False
    assert scope == rl.QUOTA_SCOPE_IP


def test_global_cap_across_ips(small_limits):
    """换 IP 也突破不了全站总量。"""
    used = 0
    ip_idx = 0
    while used < small_limits["global"]:
        ip = f"9.9.9.{ip_idx}"
        ip_idx += 1
        for i in range(small_limits["visitor"]):
            if used >= small_limits["global"]:
                break
            assert rl.check_agent_guest_quota_layers(f"g-{used}", ip)[0].allowed
            used += 1
            if used % small_limits["visitor"] == 0:
                break

    result, scope = rl.check_agent_guest_quota_layers("g-overflow", "9.9.9.99")
    assert result.allowed is False
    assert scope == rl.QUOTA_SCOPE_GLOBAL


def test_blocked_request_does_not_consume_other_layers(small_limits):
    """被后一道拦下时，前面几道不该白掉一次额度（先预检、后统一计数）。"""
    ip = "1.1.1.30"
    used = 0
    idx = 0
    while used < small_limits["ip"]:
        # 每个访客最多 2 次（visitor 上限），轮流换号把 IP 额度用满
        allowed, _scope = rl.check_agent_guest_quota_layers(f"ipfill-{idx}", ip)
        assert allowed.allowed is True
        used += 1
        if used % small_limits["visitor"] == 0:
            idx += 1

    # IP 已满：新访客号这一次被拒，但它的访客桶应该还是 0
    result, scope = rl.check_agent_guest_quota_layers("unlucky", ip)
    assert (result.allowed, scope) == (False, rl.QUOTA_SCOPE_IP)

    peeked = rl.peek_agent_guest_quota_layers("unlucky", ip)
    assert peeked[rl.QUOTA_SCOPE_VISITOR] == (0, small_limits["visitor"])


def test_disabled_layer_is_skipped(small_limits, monkeypatch):
    monkeypatch.setattr(rl, "_GUEST_IP_QUOTA_LIMIT", 0)
    monkeypatch.setattr(rl, "_GUEST_GLOBAL_QUOTA_LIMIT", 0)
    peeked = rl.peek_agent_guest_quota_layers("v-solo", "9.9.9.50")
    assert set(peeked) == {rl.QUOTA_SCOPE_VISITOR}
    # 只剩访客号一道时，同一 IP 上的另一个访客不受影响
    for _ in range(small_limits["visitor"]):
        assert rl.check_agent_guest_quota_layers("v-solo", "9.9.9.50")[0].allowed
    assert rl.check_agent_guest_quota_layers("v-solo", "9.9.9.50")[0].allowed is False
    assert rl.check_agent_guest_quota_layers("v-other", "9.9.9.50")[0].allowed is True


def test_internal_ip_skips_ip_layer(small_limits):
    """拿不到真实 IP（内网/回环/解析不出）时不能拿它当桶。

    否则一旦代理链丢头，全站访客会挤进同一个 IP 桶，100 次瞬间耗光、整站变砖。
    """
    for weird in ("172.20.0.1", "127.0.0.1", "192.168.1.5", "testclient", ""):
        peeked = rl.peek_agent_guest_quota_layers("v-int", weird)
        assert rl.QUOTA_SCOPE_IP not in peeked, weird

    # 访客号那道照样生效
    for _ in range(small_limits["visitor"]):
        assert rl.check_agent_guest_quota_layers("v-int", "172.20.0.1")[0].allowed
    assert rl.check_agent_guest_quota_layers("v-int", "172.20.0.1")[0].allowed is False


def test_public_ip_keeps_ip_layer(small_limits):
    peeked = rl.peek_agent_guest_quota_layers("v-pub", "1.1.1.77")
    assert peeked[rl.QUOTA_SCOPE_IP] == (0, small_limits["ip"])


def test_ip_key_is_hashed_and_dated(isolated):
    ip = "1.1.1.77"
    key = rl._guest_ip_quota_key(ip)
    day, _ttl = rl._beijing_day_and_ttl()
    assert ip not in key, "IP 不应明文进 Redis 键"
    assert day in key
    assert key != rl._guest_global_quota_key()


class _FakeIpRequest:
    """带 headers / client 的请求替身（client_ip 只用到这两项）。"""

    def __init__(self, headers: dict[str, str], peer: str = "172.20.0.1") -> None:
        self.headers = headers
        self.client = type("C", (), {"host": peer})()


def test_client_ip_prefers_gateway_real_ip(monkeypatch):
    """信任代理时优先读网关写的 X-Real-IP；XFF 首段可被客户端伪造，不采信。"""
    import types

    monkeypatch.setattr(
        "app.core.config.settings", types.SimpleNamespace(trust_proxy=True)
    )
    req = _FakeIpRequest(
        {
            "x-real-ip": "203.0.113.5",
            "x-forwarded-for": "1.2.3.4, 203.0.113.5",
        }
    )
    assert rl.client_ip(req) == "203.0.113.5"


def test_client_ip_ignores_headers_when_proxy_untrusted(monkeypatch):
    import types

    monkeypatch.setattr(
        "app.core.config.settings", types.SimpleNamespace(trust_proxy=False)
    )
    req = _FakeIpRequest({"x-real-ip": "203.0.113.5"})
    assert rl.client_ip(req) == "172.20.0.1"


@pytest.mark.parametrize(
    ("scope", "limits", "expected"),
    [
        (rl.QUOTA_SCOPE_VISITOR, (2, 50, 100), 2),
        (rl.QUOTA_SCOPE_IP, (50, 5, 100), 5),
        (rl.QUOTA_SCOPE_GLOBAL, (50, 100, 7), 7),
    ],
)
def test_concurrent_memory_checks_do_not_overshoot(isolated, monkeypatch, scope, limits, expected):
    """Concurrent callers must not pass a separate peek before another caller increments."""
    from concurrent.futures import ThreadPoolExecutor

    for field, limit in zip(
        ("_GUEST_QUOTA_LIMIT", "_GUEST_IP_QUOTA_LIMIT", "_GUEST_GLOBAL_QUOTA_LIMIT"),
        limits,
    ):
        monkeypatch.setattr(rl, field, limit)

    def attempt(index):
        visitor = "same-browser" if scope == rl.QUOTA_SCOPE_VISITOR else f"browser-{index}"
        ip = f"9.9.9.{index + 1}" if scope == rl.QUOTA_SCOPE_GLOBAL else "1.1.1.2"
        return rl.check_agent_guest_quota_layers(visitor, ip)

    with ThreadPoolExecutor(max_workers=24) as pool:
        results = list(pool.map(attempt, range(80)))
    assert sum(result.allowed for result, _scope in results) == expected
    assert {blocked for result, blocked in results if not result.allowed} == {scope}
    assert rl._guest_quota_memory[rl._guest_global_quota_key()] == expected


@pytest.mark.parametrize("blocked_scope", [rl.QUOTA_SCOPE_VISITOR, rl.QUOTA_SCOPE_IP, rl.QUOTA_SCOPE_GLOBAL])
def test_any_full_counter_rejects_without_charging_others(small_limits, blocked_scope):
    layers = rl._guest_quota_layers("not-charged", "1.1.1.3")
    for scope, key, limit in layers:
        rl._guest_quota_memory[key] = limit if scope == blocked_scope else 0
    before = dict(rl._guest_quota_memory)
    result, scope = rl.check_agent_guest_quota_layers("not-charged", "1.1.1.3")
    assert (result.allowed, scope) == (False, blocked_scope)
    assert rl._guest_quota_memory == before


def test_quota_is_available_again_at_beijing_midnight(small_limits, monkeypatch):
    from datetime import datetime, timezone

    clock = [datetime(2026, 11, 17, 15, 59, 59, tzinfo=timezone.utc)]

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0].astimezone(tz) if tz else clock[0].replace(tzinfo=None)

    monkeypatch.setattr(rl, "datetime", FrozenDatetime)
    assert rl._beijing_day_and_ttl()[0] == "2026-11-17"
    assert rl.beijing_quota_reset_at() == "2026-11-18T00:00:00+08:00"
    for _ in range(small_limits["visitor"]):
        assert rl.check_agent_guest_quota_layers("midnight-browser", "1.1.1.4")[0].allowed
    assert not rl.check_agent_guest_quota_layers("midnight-browser", "1.1.1.4")[0].allowed
    clock[0] = datetime(2026, 11, 17, 16, 0, 0, tzinfo=timezone.utc)
    assert rl._beijing_day_and_ttl()[0] == "2026-11-18"
    assert rl.check_agent_guest_quota_layers("midnight-browser", "1.1.1.4")[0].allowed
    assert rl.peek_agent_guest_quota_layers("midnight-browser", "1.1.1.4")[rl.QUOTA_SCOPE_VISITOR][0] == 1


def test_check_uses_one_date_snapshot_at_midnight(small_limits, monkeypatch):
    calls = []

    def changing_day():
        calls.append(None)
        return ("2026-11-17" if len(calls) == 1 else "2026-11-18", 60)

    monkeypatch.setattr(rl, "_beijing_day_and_ttl", changing_day)
    assert rl.check_agent_guest_quota_layers("date-snapshot", "1.1.1.5")[0].allowed
    assert len(calls) == 1
    assert all(key.endswith(":2026-11-17") for key in rl._guest_quota_memory)


def test_redis_check_is_one_atomic_call_and_keeps_known_counts(small_limits, monkeypatch):
    from unittest.mock import Mock

    store = Mock()
    store.eval.return_value = [0, 1, 1, 1]
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: store)
    result, scope = rl.check_agent_guest_quota_layers("redis-browser", "1.1.1.6")
    assert (result.allowed, scope) == (True, None)
    assert store.eval.call_count == 1
    assert store.eval.call_args.args[0] == rl._GUEST_QUOTA_CHECK_LUA
    assert store.eval.call_args.args[1] == 3
    store.get.assert_not_called()
    assert rl._guest_quota_memory[rl._guest_global_quota_key()] == 1


def test_redis_failure_does_not_grant_a_fresh_memory_allowance(small_limits, monkeypatch):
    from unittest.mock import Mock

    store = Mock()
    store.eval.return_value = [1, small_limits["visitor"], 4, 4]
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: store)
    assert rl.check_agent_guest_quota_layers("used-browser", "1.1.1.7")[1] == rl.QUOTA_SCOPE_VISITOR
    known = dict(rl._guest_quota_memory)
    store.eval.side_effect = RuntimeError("quota store unavailable")
    monkeypatch.setattr("app.core.redis_client._mark_redis_failure", lambda _reason: None)
    result, scope = rl.check_agent_guest_quota_layers("fresh-browser", "1.1.1.7")
    assert (result.allowed, scope) == (False, rl.QUOTA_SCOPE_UNAVAILABLE)
    assert rl._guest_quota_memory == known
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: None)
    result, scope = rl.check_agent_guest_quota_layers("another-browser", "1.1.1.7")
    assert (result.allowed, scope) == (False, rl.QUOTA_SCOPE_UNAVAILABLE)
    assert rl._guest_quota_memory == known


def test_redis_read_failure_preserves_previously_observed_usage(small_limits, monkeypatch):
    from unittest.mock import Mock

    store = Mock()
    store.get.return_value = 5
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: store)
    key = rl._guest_ip_quota_key("1.1.1.8")
    assert rl._daily_peek(key) == 5
    store.get.side_effect = RuntimeError("read unavailable")
    assert rl._daily_peek(key) == 5
    assert rl._guest_quota_memory[key] == 5
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: None)
    assert rl.check_agent_guest_quota_layers("new-browser", "1.1.1.8")[1] == rl.QUOTA_SCOPE_UNAVAILABLE


@pytest.mark.parametrize("skip_header", [None, "skip", "SKIP"])
def test_http_client_cannot_skip_daily_charge(app, small_limits, monkeypatch, skip_header):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(rl, "is_guest_request", lambda _request: True)
    executed = []

    @app.post("/agent/chat/quota-probe")
    def probe():
        executed.append(True)
        return {"ok": True}

    headers = {"X-Visitor-Id": "http-browser"}
    if skip_header:
        headers["X-Agent-Charge"] = skip_header
    client = TestClient(app)  # No lifespan: never starts providers or background tasks.
    assert client.post("/agent/chat/quota-probe", headers=headers).status_code == 200
    assert client.post("/agent/chat/quota-probe", headers=headers).status_code == 200
    blocked = client.post("/agent/chat/quota-probe", headers=headers)
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1
    assert len(executed) == small_limits["visitor"]
    assert rl.peek_agent_guest_quota_layers("http-browser", "testclient")[rl.QUOTA_SCOPE_VISITOR][0] == 2


@pytest.mark.parametrize("role", ["admin", "standard"])
def test_http_real_accounts_keep_existing_quota_exemption(app, small_limits, monkeypatch, role):
    from app.core.config import settings
    from fastapi.testclient import TestClient

    _patch_session(monkeypatch, {"account-session": {"user_id": 10, "role": role}})

    @app.post("/agent/chat/quota-probe")
    def probe():
        return {"ok": True}

    client = TestClient(app)
    client.cookies.set(settings.session_cookie_name, "account-session")
    for _ in range(small_limits["visitor"] + 2):
        assert client.post("/agent/chat/quota-probe").status_code == 200
    assert rl._guest_quota_memory == {}


def test_http_quota_store_failure_is_not_reported_as_exhausted(app, small_limits, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(rl, "is_guest_request", lambda _request: True)
    monkeypatch.setattr(
        rl,
        "check_agent_guest_quota_layers",
        lambda _visitor, _ip: (rl.RateLimitResult(False, 30), rl.QUOTA_SCOPE_UNAVAILABLE),
    )
    executed = []

    @app.post("/agent/chat/quota-probe")
    def probe():
        executed.append(True)
        return {"ok": True}

    response = TestClient(app).post("/agent/chat/quota-probe")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "30"
    assert "暂时不可用" in response.json()["detail"]
    assert "用完" not in response.json()["detail"]
    assert executed == []


def test_real_isolated_redis_lua_concurrent_caps_and_rejects_without_charging(isolated, monkeypatch):
    """Optional integration: explicit test URL and unique namespace; never uses application Redis by default."""
    import os
    import secrets
    from concurrent.futures import ThreadPoolExecutor

    redis_url = os.getenv("CGDA_TEST_QUOTA_REDIS_URL", "").strip()
    if not redis_url:
        pytest.skip("Explicit isolated Redis URL not provided")
    import redis

    store = redis.Redis.from_url(redis_url, decode_responses=True)
    store.ping()
    namespace = "test:agent-quota:" + secrets.token_hex(12)
    day = rl._beijing_day_and_ttl()[0]
    monkeypatch.setattr(rl, "_guest_quota_key", lambda visitor, ip, day=None: f"{namespace}:visitor:{visitor}:{day}")
    monkeypatch.setattr(rl, "_guest_ip_quota_key", lambda ip, day=None: f"{namespace}:ip:{ip}:{day}")
    monkeypatch.setattr(rl, "_guest_global_quota_key", lambda day=None: f"{namespace}:global:{day}")
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: store)
    try:
        for scope, limits, expected in [
            (rl.QUOTA_SCOPE_VISITOR, (2, 50, 100), 2),
            (rl.QUOTA_SCOPE_IP, (50, 5, 100), 5),
            (rl.QUOTA_SCOPE_GLOBAL, (50, 100, 7), 7),
        ]:
            # Scope-specific test prefix; all application and production keys remain untouched.
            current_namespace = f"{namespace}:{scope}"
            monkeypatch.setattr(rl, "_guest_quota_key", lambda visitor, ip, day=None: f"{current_namespace}:visitor:{visitor}:{day}")
            monkeypatch.setattr(rl, "_guest_ip_quota_key", lambda ip, day=None: f"{current_namespace}:ip:{ip}:{day}")
            monkeypatch.setattr(rl, "_guest_global_quota_key", lambda day=None: f"{current_namespace}:global:{day}")
            for field, limit in zip(
                ("_GUEST_QUOTA_LIMIT", "_GUEST_IP_QUOTA_LIMIT", "_GUEST_GLOBAL_QUOTA_LIMIT"),
                limits,
            ):
                monkeypatch.setattr(rl, field, limit)

            def attempt(index):
                visitor = "same" if scope == rl.QUOTA_SCOPE_VISITOR else f"v-{index}"
                ip = f"9.9.9.{index + 1}" if scope == rl.QUOTA_SCOPE_GLOBAL else "1.1.1.9"
                return rl.check_agent_guest_quota_layers(visitor, ip)

            with ThreadPoolExecutor(max_workers=24) as pool:
                results = list(pool.map(attempt, range(80)))
            assert sum(result.allowed for result, _scope in results) == expected
            assert {blocked for result, blocked in results if not result.allowed} == {scope}
            assert int(store.get(rl._guest_global_quota_key(day))) == expected
            before = {key: store.get(key) for key in store.scan_iter(match=current_namespace + ":*")}
            result, blocked = attempt(79)
            assert not result.allowed and blocked == scope
            after = {key: store.get(key) for key in store.scan_iter(match=current_namespace + ":*")}
            assert after == before
            assert 0 < store.ttl(rl._guest_global_quota_key(day)) <= 86400 + 120
    finally:
        keys = list(store.scan_iter(match=namespace + ":*"))
        if keys:
            store.delete(*keys)


@pytest.fixture()
def continuation_memory(isolated):
    rl._guest_continuations.clear()
    yield
    rl._guest_continuations.clear()


def _issue_test_continuations():
    steps = [
        {"id": "step-1", "message": "显示风云平均土壤水分", "constraints": ["其他图层保持原状"]},
        {"id": "step-2", "message": "隐藏SMAP动态植被光学厚度", "constraints": []},
    ]
    tokens = rl.issue_agent_guest_continuations(
        visitor_id="ticket-browser", ip="1.1.1.10", session_id="ticket-session",
        parent_message="显示风云平均土壤水分，然后隐藏SMAP动态植被光学厚度",
        steps=steps,
    )
    return steps, tokens


def _consume_test_continuation(token, **changes):
    values = {
        "visitor_id": "ticket-browser", "ip": "1.1.1.10",
        "session_id": "ticket-session", "step_id": "step-1",
        "message": "显示风云平均土壤水分，其他图层保持原状", "operation_single": True,
    }
    values.update(changes)
    return rl.consume_agent_guest_continuation(token, **values)


def test_continuation_is_one_use_and_does_not_charge_a_question(continuation_memory):
    _steps, tokens = _issue_test_continuations()
    assert len(tokens) == 2 and tokens[0] != tokens[1]
    assert _consume_test_continuation(tokens[0]) == "accepted"
    assert _consume_test_continuation(tokens[0]) == "invalid"
    assert rl._guest_quota_memory == {}


@pytest.mark.parametrize(
    "changed",
    [
        {"visitor_id": "another-browser"},
        {"ip": "1.1.1.11"},
        {"session_id": "another-session"},
        {"step_id": "step-2"},
        {"message": "隐藏风云平均土壤水分，其他图层保持原状"},
        {"message": "显示风云平均土壤水分"},
        {"operation_single": False},
    ],
)
def test_continuation_binding_rejects_changes_without_burning_valid_ticket(continuation_memory, changed):
    _steps, tokens = _issue_test_continuations()
    assert _consume_test_continuation(tokens[0], **changed) == "invalid"
    assert _consume_test_continuation(tokens[0]) == "accepted"


def test_continuation_expiry_is_enforced(continuation_memory, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(rl.time, "monotonic", lambda: clock[0])
    _steps, tokens = _issue_test_continuations()
    clock[0] += rl._GUEST_CONTINUATION_TTL + 1
    assert _consume_test_continuation(tokens[0]) == "invalid"


def test_concurrent_continuation_replay_only_authorizes_once(continuation_memory):
    from concurrent.futures import ThreadPoolExecutor

    _steps, tokens = _issue_test_continuations()
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _index: _consume_test_continuation(tokens[0]), range(40)))
    assert results.count("accepted") == 1
    assert results.count("invalid") == 39


def test_continuation_store_failure_does_not_use_memory_after_redis(continuation_memory, monkeypatch):
    from unittest.mock import Mock

    store = Mock()
    store.eval.side_effect = RuntimeError("test store outage")
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: store)
    monkeypatch.setattr("app.core.redis_client._mark_redis_failure", lambda _reason: None)
    with pytest.raises(rl.GuestContinuationUnavailable):
        _issue_test_continuations()
    assert _consume_test_continuation("a" * 64) == "unavailable"
    monkeypatch.setattr("app.core.redis_client.get_redis_client", lambda: None)
    assert _consume_test_continuation("a" * 64) == "unavailable"


@pytest.mark.parametrize("root_endpoint", ["/agent/chat", "/agent/chat/stream"])
def test_http_multi_step_question_counts_once_and_ticket_cannot_bypass_another_question(
    app, small_limits, continuation_memory, monkeypatch, root_endpoint,
):
    """Actual chat routes and middleware, with only language/model execution stubbed."""
    import json
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    from importlib import import_module

    agent_router = import_module("app.api.routers.agent_router")
    monkeypatch.setattr(rl, "_GUEST_QUOTA_LIMIT", 1)
    monkeypatch.setattr(rl, "is_guest_request", lambda _request: True)
    app.dependency_overrides[agent_router.get_request_user] = lambda: SimpleNamespace(user_id=2, role="demo")
    executed = []
    plan = [
        {"id": "step-1", "message": "显示风云平均土壤水分", "constraints": ["其他图层保持原状"]},
        {"id": "step-2", "message": "隐藏SMAP动态植被光学厚度", "constraints": []},
    ]

    def run(message, *, session_id=None, client_context=None, **_kwargs):
        if (client_context or {}).get("operation_single"):
            executed.append(message)
            return {"session_id": session_id, "reply": "已核对测试步骤", "ui_intents": [], "steps": []}
        return {
            "session_id": "http-ticket-session", "reply": "等待逐步执行", "ui_intents": [],
            "operation_plan": [dict(step) for step in plan], "request_mode": "execute", "steps": [],
        }

    monkeypatch.setattr(agent_router, "run_chat", run)
    client = TestClient(app)
    headers = {"X-Visitor-Id": "http-ticket-browser"}
    root = client.post(root_endpoint, headers=headers, json={
        "message": "显示风云平均土壤水分，然后隐藏SMAP动态植被光学厚度",
        "client_context": {"operation_protocol": 1},
    })
    assert root.status_code == 200
    if root_endpoint.endswith("/stream"):
        result = next(
            json.loads(line[6:]) for line in root.text.splitlines()
            if line.startswith("data: ") and "operation_plan" in line
        )
    else:
        result = root.json()
    assert len(result["operation_plan"]) == 2
    assert all(len(step["quota_token"]) == 64 for step in result["operation_plan"])

    for step in result["operation_plan"]:
        message = "，".join([step["message"], *step.get("constraints", [])])
        body = {"message": message, "session_id": result["session_id"], "client_context": {
            "operation_protocol": 1, "operation_single": True, "operation_step_id": step["id"],
        }}
        ticket_headers = {**headers, "X-Agent-Quota-Continuation": step["quota_token"]}
        if step["id"] == "step-1":
            bad = {**body, "message": "隐藏所有图层"}
            assert client.post("/agent/chat", headers=ticket_headers, json=bad).status_code == 409
            another_visitor = {**ticket_headers, "X-Visitor-Id": "another-browser"}
            assert client.post("/agent/chat", headers=another_visitor, json=body).status_code == 409
            assert executed == []
        # The paid question is allowed to finish even though its one daily slot is exhausted.
        assert client.post("/agent/chat", headers=ticket_headers, json=body).status_code == 200
        assert client.post("/agent/chat", headers=ticket_headers, json=body).status_code == 409
    assert len(executed) == 2
    quota = rl.peek_agent_guest_quota_layers("http-ticket-browser", "testclient")
    assert quota[rl.QUOTA_SCOPE_VISITOR] == (1, 1)
    assert quota[rl.QUOTA_SCOPE_GLOBAL][0] == 1

    # A bare operation_single or a made-up ticket must never authorize a free question.
    plain = {"message": "显示风云平均VOD", "session_id": result["session_id"], "client_context": {
        "operation_single": True, "operation_step_id": "step-1",
    }}
    assert client.post("/agent/chat", headers=headers, json=plain).status_code == 429
    forged = {**headers, "X-Agent-Quota-Continuation": "a" * 64}
    assert client.post("/agent/chat", headers=forged, json=plain).status_code == 409
    assert len(executed) == 2
    assert client.post("/agent/chat", headers=headers, json={"message": "新的一次提问"}).status_code == 429
