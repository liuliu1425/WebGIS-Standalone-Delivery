"""Fixed regression cases. Page transitions here are simulated, not live data."""
import copy
import json

import pytest

from test_agent_single_step_regressions import page, local_chat  # noqa: F401
from app.services.agent.operation_plan import plan_operations, bind_reference
from app.services.agent import orchestrator as o


@pytest.mark.parametrize('message', [
    '当前是什么图层', '现在是哪个图层？', '目前的图层是什么？',
    '请告诉我当前图层是哪一个', '现在是哪一层？', '当前是哪层？',
])
def test_current_layer_overview_reads_all_live_page_states(page, local_chat, monkeypatch, message):
    context = _full_page_context(page, 11)
    context['active_layers'][1]['visible'] = True
    monkeypatch.setattr(o, 'load_history', lambda **kw: [
        {'role': 'user', 'content': '当前是什么图层'},
        {'role': 'assistant', 'content': '没有选中和显示图层，已添加10层，全部隐藏。'},
    ])
    result = local_chat(message, client_context=context)
    assert result['provider'].endswith('page-state-rule')
    assert '等效散射' in result['reply'] and '已隐藏' in result['reply']
    assert '勾选显示（2 层）' in result['reply'] and '植被光学厚度' in result['reply']
    assert '已添加图层：13 层' in result['reply']
    assert not result['ui_intents']
    assert result['operation_target']['catalog_id'] == context['active_layers'][11]['catalog_id']


@pytest.mark.parametrize('message,kind', [
    ('现在地图上显示的是哪一层？', 'visible_list'),
    ('当前正在查看哪个图层？', 'selected'),
    ('当前图层是什么时间的数据？', 'date'),
    ('请显示当前图层', None),
    ('把当前图层切到2025-07-22', None),
])
def test_current_layer_question_does_not_swallow_other_intents(message, kind):
    from app.services.agent.request_semantics import page_query_kind
    assert page_query_kind(message) == kind


def test_model_prompt_counts_remain_complete_when_layer_list_is_shortened(page):
    context = _full_page_context(page, 11)
    context['active_layers'][1]['visible'] = True
    block = o._client_context_block(context)
    payload = json.loads(block.split('```json\n', 1)[1].split('\n```', 1)[0])
    summary = payload['page_state_summary']
    assert summary['added_count'] == 13 and summary['visible_count'] == 2
    assert summary['selected_count'] == 1 and summary['visibility_unknown_count'] == 0
    assert summary['listed_count'] == len(payload['active_layers']) < 13
    assert 'may be a subset' in block


def _full_page_context(page, selected_index):
    page['active_catalog_ids'] = [row['catalog_id'] for row in page['active_layers']]
    for index, row in enumerate(page['active_layers']):
        row.update(selected=index == selected_index, visible=index == 0,
                   requested_time={'date': '2025-07-31', 'hour': 0},
                   actual_time='20250701_20250731', loading=False)
        row['name'] += ' · 完整产品版本及时间范围说明' * 10
    assert len(json.dumps(page, ensure_ascii=False)) > o._CLIENT_CONTEXT_MAX_CHARS
    return page


@pytest.mark.parametrize('selected_index', [2, 11])
def test_state_queries_keep_hidden_selection_beyond_prompt_budget(page, local_chat, selected_index):
    context = _full_page_context(page, selected_index)
    original = copy.deepcopy(context)
    selected = local_chat('当前选中的图层是什么', client_context=context)
    assert '等效散射' in selected['reply'] and '已隐藏' in selected['reply']
    assert selected['operation_target']['catalog_id'] == context['active_layers'][selected_index]['catalog_id']
    count = local_chat('页面目前一共添加了多少个图层？', client_context=context)
    assert '13 个' in count['reply']
    assert not selected['ui_intents'] and not count['ui_intents']
    assert context == original


def test_prompt_budget_does_not_truncate_execution_state(page):
    context = _full_page_context(page, 11)
    execution = o.sanitize_client_context(context, for_prompt=False)
    prompt = o.sanitize_client_context(execution)
    assert len(execution['active_layers']) == 13
    assert execution['active_layers'][11]['selected']
    assert len(json.dumps(prompt, ensure_ascii=False)) <= o._CLIENT_CONTEXT_MAX_CHARS
    assert prompt['active_layers'][0]['catalog_id'] == context['active_layers'][11]['catalog_id']
    assert prompt['active_layers'][0]['selected']


def test_followup_visibility_uses_hidden_selected_reference_with_full_context(page, local_chat):
    context = _full_page_context(page, 11)
    first = local_chat('当前选中的图层是什么', client_context=context)
    second = local_chat('它是否显示', client_context={
        **context, 'operation_single': True, 'operation_inherit_target': True,
        'operation_reference': first['operation_target'],
    })
    assert '已隐藏' in second['reply'] and not second['ui_intents']
    assert second['operation_status'] == 'success'


@pytest.mark.parametrize('text,expected', [
    ('把风云卫星平均版土壤水分SM切到2025年7月10日，把风云卫星平均版VOD切到2025年7月25日。', [(0, '2025-07-10'), (1, '2025-07-25')]),
    ('先把风云卫星平均版VOD切到2025年7月22日，再把风云卫星平均版土壤水分SM切到2025年7月10日。', [(1, '2025-07-22'), (0, '2025-07-10')]),
    ('风云平均版SM切到2025-07-13；风云平均版VOD切到2025-07-23', [(0, '2025-07-13'), (1, '2025-07-23')]),
    ('把SMAP动态版VOD切到2025-07-21，然后把SMAP动态版SM切到2025-07-19', [(10, '2025-07-21'), (9, '2025-07-19')]),
    ('把风云动态版SM切到2025-07-09，再把风云动态版VOD切到2025-07-11', [(6, '2025-07-09'), (7, '2025-07-11')]),
    ('把风云平均版SM切到2025-07-15，再把风云平均版SM切到2025-07-17', [(0, '2025-07-15'), (0, '2025-07-17')]),
])
def test_dates_remain_paired_with_each_target(page, local_chat, monkeypatch, text, expected):
    from app.services.agent import server_tools_runtime as rt
    monkeypatch.setattr(rt, '_local_time_keys', lambda _: ['20250701_20250731'])
    page['operation_protocol'] = 1
    plan = local_chat(text, client_context=page)['operation_plan']
    assert len(plan) == len(expected)
    for step, (index, date) in zip(plan, expected):
        response = local_chat(step['message'], client_context={**page, 'operation_single': True})
        actions = response['ui_intents']
        assert len(actions) == 1
        assert actions[0]['name'] == 'set_timeline'
        assert actions[0]['args']['catalog_id'] == page['active_layers'][index]['catalog_id']
        assert actions[0]['args']['date'] == date


@pytest.mark.parametrize('text,count', [
    ('隐藏当前图层，然后告诉我现在还有哪些图层勾选显示。', 2),
    ('请分别回答：现在有哪些图层勾选显示？当前选中的图层是什么，它是否显示？', 3),
    ('显示风云平均版VOD，并切到2025-07-20，再隐藏CMFD', 3),
    ('先把风云平均版VOD切到2025-07-20，再查询它在广州市当天的区域均值', 2),
    ('显示风云平均版SM和风云平均版VOD，其他图层保持原状', 0),
    ('隐藏SMAP平均版SM和SMAP平均版VOD', 0),
    ('定位经度116.4，纬度39.9', 0),
    ('显示风云平均版SM，再查询当前显示了哪些图层', 2),
    ('将风云平均版VOD显示，然后隐藏该图层', 2),
    ('定位北京，然后放大地图', 2),
])
def test_action_boundaries_not_object_lists(text, count):
    assert len(plan_operations(text)) == count


def test_reference_uses_explicit_identity_and_remembered_date(page):
    target = page['active_layers'][0]
    target['requested_time'] = {'date': '2025-07-20', 'hour': 0}
    page.update(operation_inherit_target=True, operation_reference={
        'catalog_id': target['catalog_id'], 'instance_id': target['instance_id'], 'date': '2025-07-20',
    })
    original = copy.deepcopy(page)
    message, context, reference, error = bind_reference('查询它在广州市当天的区域均值', page)
    assert not error and '2025-07-20' in message and '土壤水分' in message
    assert reference['catalog_id'] == target['catalog_id']
    assert context['timeline']['date'] == '2025-07-20'
    assert page == original


def test_missing_reference_asks_without_mutation(page, local_chat):
    result = local_chat('查询它在广州市当天的均值', client_context={
        **page, 'operation_inherit_target': True, 'operation_reference': None,
    })
    assert result['operation_status'] == 'needs_clarification'
    assert result['ui_intents'] == []


def test_date_to_statistics_dependency_and_state_query_independence():
    plan = plan_operations('风云平均版VOD切到2025-07-20，然后查询它在广州市当天的均值，再告诉我哪些图层显示')
    assert plan[1]['depends_on'] == plan[0]['id']
    assert plan[2]['depends_on'] is None


def test_order_guard_never_drops_dates_or_reorders_visibility():
    items = [
        {'name': 'set_timeline', 'args': {'catalog_id': 'a', 'date': '2025-07-10'}},
        {'name': 'set_layer_visibility', 'args': {'catalog_id': 'b', 'visible': True}},
        {'name': 'set_timeline', 'args': {'catalog_id': 'b', 'date': '2025-07-25'}},
        {'name': 'set_layer_visibility', 'args': {'catalog_id': 'c', 'visible': False}},
    ]
    assert o._order_ui_intents({'ui_intents': copy.deepcopy(items)}, {})['ui_intents'] == items


def test_hide_then_query_uses_fresh_snapshot(page, local_chat):
    page['operation_protocol'] = 1
    plan = local_chat('隐藏当前图层，然后告诉我还有哪些图层勾选显示', client_context=page)['operation_plan']
    target = page['active_layers'][1]
    target['visible'] = True
    first = local_chat(plan[0]['message'], client_context={**page, 'operation_single': True})
    assert first['ui_intents'][0]['args']['visible'] is False
    target['visible'] = False  # simulated browser receipt, not an assertion of real rendering
    second = local_chat(plan[1]['message'], client_context={**page, 'operation_single': True})
    assert second['ui_intents'] == [] and '2 个' in second['reply']


def test_serialized_receipt_keeps_command_identity():
    from app.api.routers.agent_router import _chat_result_to_response
    result = _chat_result_to_response({'session_id': 'test', 'reply': '', 'ui_intents': [
        {'name': 'set_timeline', 'args': {}, 'command_id': 'cmd-fixed'},
    ], 'operation_status': 'pending'})
    assert result.ui_intents[0].command_id == 'cmd-fixed'


@pytest.mark.parametrize('text,visible', [
    ('同时显示风云卫星平均版土壤水分SM和风云卫星平均版VOD，其他图层保持原状。', True),
    ('隐藏风云卫星平均版VOD和风云卫星平均版土壤水分SM。', False),
    ('显示SMAP平均版土壤水分及SMAP平均版VOD，其他图层保持不变', True),
])
def test_parallel_named_variables_survive_guard(page, local_chat, text, visible):
    actions = local_chat(text, client_context=page)['ui_intents']
    indices = (3, 4) if 'SMAP' in text else (0, 1)
    assert {i['args']['catalog_id'] for i in actions} == {page['active_layers'][i]['catalog_id'] for i in indices}
    assert all(i['args']['visible'] is visible for i in actions)


def test_invalid_date_is_failed_not_success(page, local_chat):
    result = local_chat('把风云平均版SM切到2025年2月30日', client_context=page)
    assert result['operation_status'] == 'failed'
    assert result['ui_intents'] == []


def test_missing_parallel_target_is_preserved_in_receipt(page, local_chat):
    result = local_chat('隐藏风云平均版SM和不存在的星辰99图层', client_context=page)
    assert len(result['ui_intents']) == 1
    assert result['ui_intents'][0]['args']['catalog_id'] == page['active_layers'][0]['catalog_id']
    assert result['operation_issues'][0]['status'] == 'not_executed'
    assert '星辰99' in result['operation_issues'][0]['message']


@pytest.mark.parametrize('text,zoom', [('放大地图。', 9), ('请把地图缩小一级', 7)])
def test_relative_zoom_uses_fresh_map_center(page, local_chat, text, zoom):
    page['viewport'] = {'center': {'lng': 116.4, 'lat': 39.9}, 'zoom': 8}
    result = local_chat(text, client_context=page)
    action = result['ui_intents'][0]
    assert action['name'] == 'locate_coordinate'
    assert action['args']['lng'] == 116.4 and action['args']['lat'] == 39.9
    assert action['args']['zoom'] == zoom
