"""Small, ordered request plan; each step reuses run_chat after actual UI completion.

No optimistic state simulation: references are bound from the previous receipt
and the fresh page snapshot. Unrecognised language still uses the existing model.
"""
from __future__ import annotations

import copy
import re
from typing import Any

from .request_semantics import CURRENT_LAYER, page_query_kind, separate_constraints, layer_query_topic, expand_target_declaration, has_timeline_request, layer_action_kind

_VERB = r"(?:把|将|显示|隐藏|打开|关闭|添加|加载|加入|选中|选择|查看|勾选|取消|切|设|改|调|跳|查询|统计|计算|定位|放大|缩小|告诉我|列出|现在|目前|当前|它|该图层)"
_BOUNDARY = re.compile(
    rf"[；;。！？!?\n]+|[，,、]\s*(?=(?:请|先|再|然后|接着|随后|并且|并)?\s*{_VERB})"
    rf"|(?:然后|接着|随后|之后|后|再|并且|并|同时|以及|和)\s*(?={_VERB})"
    r"|[，,]\s*(?=[^，,；;。]{1,60}(?:切到|切至|改为|设为|保持原状))"
)
_REFERENCE = re.compile(r"第[一二三四五六七八九十\d]+步(?:的)?(?:图层|对象|层)|这个图层|它|该图层|该层|这一层|这层|本层")
_NAMED = re.compile(r"风云|SMAP|CMFD|\bSM\b|\bVOD\b|土壤水|植被光学|散射|降水", re.I)
_CONSTRAINT = re.compile(r"(?:其他|其余).*?(?:保持|维持).*?(?:原状|不变|现状)")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def operation_kind(text: str) -> str:
    if page_query_kind(text):
        return "query_state"
    if re.search(r"最小值|最大值|图例|值域|量程|不透明度|配色", text):
        return "style"
    if re.search(r"查询|统计|计算|均值|平均值|取值", text):
        return "query_data"
    if has_timeline_request(text):
        return "set_timeline"
    kind = layer_action_kind(text)
    if kind:
        return kind
    if re.search(r"定位|放大|缩小|缩放", text):
        return "map_view"
    return "existing_agent"


def plan_operations(message: str) -> list[dict[str, Any]]:
    """Split at action boundaries, never at object lists or coordinate commas."""
    message, constraints = separate_constraints(expand_target_declaration(message))
    # Numbered instructions are action boundaries, not targets or extra steps.
    message = re.sub(r"^\s*(?:请)?(?:按顺序|依次)执行[：:]?\s*", "", message)
    message = re.sub(r"(?:^|[，,\n；;])\s*\d+[.、）)]\s*", "\n", message)
    message = re.sub(r"最后(?=把|将|显示|隐藏|查询)", "然后", message)
    message = re.sub(r"^(?:在)?样式面板中[，,]?", "", message)
    if re.search(r"^(?:如果|若)", message):
        return []
    # Exclusive visibility is one operation with a set of explicit targets.
    if re.search(r"只显示|仅显示|只保留|仅保留|单独显示", message) and re.search(r"其他|其余", message):
        return []
    if page_query_kind(message) == 'overview' or (layer_query_topic(message) and not re.search(r'^(?:请|先|再|把|将)*(?:添加|加载|选中|选择|查看|打开|显示|隐藏|切换)', message)):
        return []
    text = re.sub(r"^\s*请?分别回答[：:]?\s*", "", message).strip()
    parts = [re.sub(r"^(?:请|先)\s*", "", p).strip(" ，,：:")
             for p in _BOUNDARY.split(text) if p.strip(" ，,：:")]
    parts = [p for p in parts if p]
    constraints += [p for p in parts if _CONSTRAINT.fullmatch(p)]
    parts = [p for p in parts if p not in constraints]
    if len(parts) < 2:
        return []
    steps: list[dict[str, Any]] = []
    for part in parts:
        kind = operation_kind(part)
        numbered = re.search(r"第([一二三四五六七八九十\d]+)步", part)
        number = (int(numbered[1]) if numbered and numbered[1].isdigit() else
                  "一二三四五六七八九十".find(numbered[1]) + 1 if numbered else 0)
        target_step = f"step-{number}" if number else None
        reference = bool(_REFERENCE.search(part)) and not _NAMED.search(part)
        implicit = kind in {"set_timeline", "query_data"} and not (
            _NAMED.search(part) or CURRENT_LAYER.search(part)
        )
        inherit = bool(steps) and (reference or implicit)
        inherit_time = bool(re.search(r"当天|当日|该日|那天", part))
        # State questions always observe the page, including after a failure.
        dependency = target_step or (steps[-1]["id"] if steps and (inherit or inherit_time) and kind != "query_state" else None)
        steps.append({
            "id": f"step-{len(steps) + 1}", "message": part,
            "operation": kind, "depends_on": dependency,
            "inherit_target": inherit, "inherit_time": inherit_time,
            "target_step_id": target_step,
            "constraints": constraints,
        })
    return steps


def bind_reference(message: str, context: dict[str, Any] | None):
    """Return a bound message/context/reference, or a clarification without actions."""
    from . import mock_orchestrator as mo

    ctx = copy.deepcopy(context or {})
    ref = ctx.get("operation_reference") or {}
    layers = mo._normalize_layers(ctx)
    page_current = bool(CURRENT_LAYER.search(message) and re.search(r"当前|选中", message))
    inherited = bool(ctx.get("operation_inherit_target")) and not (
        _NAMED.search(message) or page_current
    )
    ctx["operation_inherit_target"] = inherited
    target = None
    if inherited:
        candidates = [la for la in layers if la.get("catalog_id") == ref.get("catalog_id")
                      and (not ref.get("instance_id") or la.get("instance_id") == ref["instance_id"])]
        if len(candidates) != 1:
            return message, ctx, None, "无法唯一确定前一步所指的图层，请明确产品、版本和变量。"
        target = candidates[0]
        label = mo._layer_display_with_identity(target)
        message = _REFERENCE.sub(label, message)
        if not _NAMED.search(message):
            message = f"{label}，{message}"
    elif not _NAMED.search(message) and (
        CURRENT_LAYER.search(message) or page_query_kind(message) in {"selected", "overview"}
    ):
        candidates = [la for la in layers if la.get("selected")]
        if len(candidates) == 1:
            target = candidates[0]
    else:
        pick = mo._resolve_layer(message, layers, allow_demo_fallback=False)
        if pick:
            candidates = [la for la in layers if la.get("catalog_id") == pick.catalog_id
                          and (not getattr(pick, "instance_id", None) or la.get("instance_id") == pick.instance_id)]
            if len(candidates) == 1:
                target = candidates[0]
    reference = None
    if target:
        raw = next((la for la in ctx.get("active_layers", [])
                    if la.get("instance_id") == target.get("instance_id")
                    and la.get("catalog_id") == target.get("catalog_id")), {})
        remembered = raw.get("requested_time") or {}
        day = (_DATE.search(message).group() if _DATE.search(message) else
               (ref.get("date") if inherited or ctx.get("operation_inherit_time") else None) or remembered.get("date"))
        if re.search(r"当天|当日|该日|那天", message):
            if not day:
                return message, ctx, None, "无法确认该图层对应的日期，请补充具体日期。"
            message = re.sub(r"当天|当日|该日|那天", day, message)
        reference = {"catalog_id": target["catalog_id"],
                     "instance_id": target.get("instance_id"), "date": day,
                     "hour": remembered.get("hour"), "name": mo._layer_display_with_identity(target)}
        if inherited:
            for row in ctx.get("active_layers", []):
                row["selected"] = row.get("instance_id") == target.get("instance_id")
            if day:
                ctx["timeline"] = {**ctx.get("timeline", {}), "date": day,
                                   "hour": reference.get("hour") or 0}
    return message, ctx, reference, None


def response_status(result: dict[str, Any], message: str = '') -> str:
    if result.get("ui_intents"):
        return "pending"
    if result.get("operation_status") in {"success", "failed", "not_executed", "needs_clarification"}:
        return result["operation_status"]
    reply = str(result.get("reply") or "")
    if re.search(r"未能唯一|未找到唯一|无法唯一|无法确认|请明确|请补充|多个候选|请.*(?:哪一|哪个)", reply):
        return "needs_clarification"
    if result.get("provider") in {"busy", "degraded"} or result.get('ok') is False:
        return 'failed'
    # Explanations may accurately mention failures or unsupported capabilities.
    # Their content is not an execution receipt.
    if message and operation_kind(message) in {'existing_agent', 'query_state'}:
        return 'success'
    if re.search(
        r"失败|未执行|没有执行|没有切换|不支持切换|非法日期|无效日期|不是.*有效日期|不存在的日期|取数出错", reply
    ):
        return "failed"
    return "success"


def prepare_local_action(message, context, answer):
    """Resolve bounded action parameters; execution still uses existing UI intents."""
    from datetime import date, timedelta
    from . import mock_orchestrator as mo
    from .request_semantics import (
        request_mode, exclusive_visibility_target, relative_day_offset,
        implicit_timeline_target, unresolved_target_qualification,
    )
    from .layer_reference import reference_hints
    if request_mode(message) != 'execute':
        return message, None
    if unresolved_target_qualification(message):
        return message, answer(
            '你说明了目标版本尚未确定，请补充平均散射约束版或动态散射约束版。本次没有执行图层或日期操作。',
            'needs_clarification',
        )
    if plan_operations(message):
        return message, None
    message = expand_target_declaration(message)
    layers = mo._normalize_layers(context)
    if re.match(r'^(?:如果|若)', message):
        condition = re.match(r'^(?:如果|若)(.+?)(?:已经|已)(勾选|显示|隐藏)(?:了)?[，,]?(?:就|则)(.+)', message)
        if not condition:
            return message, answer('无法确认条件及满足条件后要执行的操作，请明确说明。', 'needs_clarification')
        pick = mo._resolve_layer(condition[1], layers, allow_demo_fallback=False)
        row = next((r for r in layers if pick and r['catalog_id'] == pick.catalog_id), None)
        if not row:
            return message, answer('无法唯一确定条件中的图层，未执行操作。', 'needs_clarification')
        if bool(row.get('visible')) != (condition[2] != '隐藏'):
            return message, answer('该图层当前状态不满足指定条件，未执行后续操作。', 'not_executed')
        message = _REFERENCE.sub(mo._layer_display_with_identity(row), condition[3])
    target_text = exclusive_visibility_target(message)
    if target_text:
        from .orchestrator import _resolve_simple_visibility
        intent = _resolve_simple_visibility(target_text, context)
        if intent:
            intent['args']['solo'] = True
            return message, answer('等待核对独占显示结果。', 'pending', [intent])
        return message, answer('未找到唯一匹配的图层，没有改变任何图层的显示状态。请明确产品和变量。', 'needs_clarification')
    action, _ = separate_constraints(message)
    pick = mo._resolve_layer(action, layers, allow_demo_fallback=False)
    row = next((r for r in layers if pick and r['catalog_id'] == pick.catalog_id
                and (not getattr(pick, 'instance_id', None)
                     or r.get('instance_id') == pick.instance_id)), None)
    implicit = implicit_timeline_target(action) and not reference_hints(action)
    page_current = bool(CURRENT_LAYER.search(action) and re.search(r'当前|选中', action))
    inherited = bool(context.get('operation_inherit_target')) and not (
        reference_hints(action) or page_current
    )
    if inherited:
        reference = context.get('operation_reference') or {}
        matching = [r for r in layers if r.get('catalog_id') == reference.get('catalog_id')
                    and (not reference.get('instance_id')
                         or r.get('instance_id') == reference['instance_id'])]
        row = matching[0] if len(matching) == 1 else None
    elif implicit:
        selected = [r for r in layers if r.get('selected')]
        row = selected[0] if len(selected) == 1 else None
    date_action = has_timeline_request(action) and operation_kind(action) == "set_timeline"
    offset = relative_day_offset(action) if date_action else None
    if date_action and (implicit or inherited or offset is not None):
        if not row:
            return message, answer('无法唯一确定日期操作的目标图层，请先选中一个图层或明确产品、版本和变量。', 'needs_clarification')
        raw = next((r for r in context.get('active_layers', [])
                    if r.get('instance_id') == row.get('instance_id')
                    and r.get('catalog_id') == row.get('catalog_id')), {})
        remembered = (raw.get('requested_time') or {}).get('date')
        if not remembered and inherited:
            remembered = (context.get('operation_reference') or {}).get('date')
        if not remembered and row.get('selected'):
            remembered = (context.get('timeline') or {}).get('date')
        if offset is not None:
            try:
                day = (date.fromisoformat(str(remembered)) + timedelta(days=offset)).isoformat()
            except (ValueError, TypeError, OverflowError):
                return message, answer('该图层没有可确认的当前日期，请提供具体日期。', 'needs_clarification')
        else:
            year = int(str(remembered)[:4]) if re.match(r"^\d{4}", str(remembered)) else None
            normalized = mo.normalize_explicit_request(action, default_year=year)
            day = mo._parse_date_arg(normalized)
            if day is None:
                # Existing validation must report illegal dates, not silently use the old day.
                return message, None
        canonical = f'把{mo._layer_display_with_identity(row)}切到{day}'
        hour = re.search(r"(?<!\d)\d{1,2}(?:(?:点|时)(?:\d{1,2}分)?|:\d{2})", action)
        if hour:
            canonical += ' ' + hour[0]
        return canonical, None
    style = bool(re.search(r'图例|值域|量程|最小值|最大值', action))
    order = re.search(r'置顶|置底|(?:移动|移|调|提|放)到.*最(?:上|下|前|后)', action)
    if style or order:
        if not row:
            return message, answer('无法唯一确定要修改的图层，请明确产品、版本和变量。', 'needs_clarification')
        args = {'catalog_id': row['catalog_id'], 'instance_id': row.get('instance_id'),
                'display_name': mo._layer_display_with_identity(row)}
        if order:
            if '列表' in action:
                return message, answer('当前支持调整地图叠放顺序，产品分组列表不会随之重排。本次未修改；若需要调整叠放顺序，请明确“置顶地图图层”。', 'needs_clarification')
            args['action'] = 'back' if re.search(r'置底|最下|最后', action) else 'front'
            return message, answer('等待核对图层叠放顺序。', 'pending', [{'name':'reorder_layer','args':args}])
        number = r'[-+]?\d+(?:\.\d+)?'
        for name,key in [('最小值','vmin'),('最大值','vmax')]:
            match = re.search(rf'{name}\s*(?:设置|设|改)?(?:为|成)?\s*({number})', action)
            if match: args[key] = float(match[1])
        pair = re.search(rf'(?:范围|值域|量程).*?(?:设为|设置为|改为|改成|为)\s*({number})\s*(?:到|至|~|～)\s*({number})', action)
        if pair: args.update(vmin=float(pair[1]), vmax=float(pair[2]))
        if 'vmin' in args and 'vmax' in args and args['vmin'] >= args['vmax']:
            return message, answer('图例范围无效：最小值必须小于最大值。本次未修改样式，也未执行统计。', 'not_executed')
        if 'vmin' in args or 'vmax' in args:
            return message, answer('等待核对图例范围。', 'pending', [{'name':'set_layer_symbology','args':args}])
    return message, None
