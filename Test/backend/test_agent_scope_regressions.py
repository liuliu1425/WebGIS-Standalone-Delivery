"""Visitor audit regressions; mocked page/data services, never production data."""
import copy
from types import SimpleNamespace

import pytest

from test_agent_single_step_regressions import page, local_chat  # noqa: F401
from app.services.agent import orchestrator as o, mock_orchestrator as mo
from app.services.agent import server_tools_runtime as rt
from app.services.agent.operation_plan import plan_operations, response_status


@pytest.mark.parametrize('text', [
    '显示风云平均版VOD，然后切到2025-07-15，保持其他图层的显示状态不变，最后分别报告两步结果。',
    '先打开SMAP动态版SM，再改到2025-07-18，其余图层保持原样，逐项汇报执行情况。',
    '隐藏风云平均版VOD，再显示SMAP平均版VOD，别的图层不要改，最后告诉我每步是否成功。',
])
def test_constraints_and_receipt_preferences_are_not_steps(text):
    steps = plan_operations(text)
    assert len(steps) == 2
    assert len(steps[0]['constraints']) == 2
    assert all(step['operation'] != 'existing_agent' for step in steps)


@pytest.mark.parametrize('prefix,target,index', [
    ('不要隐藏', 'SMAP动态版土壤水分', 9),
    ('别关掉', '风云平均版VOD', 1),
    ('不要显示', '风云动态版SM', 6),
])
@pytest.mark.parametrize('visible', [False, True])
def test_scoped_negation_preserves_visibility_and_allows_date(page, local_chat, monkeypatch, prefix, target, index, visible):
    monkeypatch.setattr(rt, '_local_time_keys', lambda _: ['20250701_20250731'])
    page['active_layers'][index]['visible'] = visible
    before = copy.deepcopy(page)
    result = local_chat(f'{prefix}{target}，只把这个图层的日期切换到2025-07-18', client_context=page)
    assert [x['name'] for x in result['ui_intents']] == ['set_timeline']
    assert result['ui_intents'][0]['args']['catalog_id'] == page['active_layers'][index]['catalog_id']
    assert result['ui_intents'][0]['args']['date'] == '2025-07-18'
    assert page == before


@pytest.mark.parametrize('message', [
    '请区分当前选中图层和勾选显示图层，并列出已添加图层及各自显示状态。',
    '当前选中哪个图层？列出每个已添加图层的显示状态。',
])
def test_overview_answers_all_states(page, local_chat, message):
    result = local_chat(message, client_context=page)
    assert not result['ui_intents']
    assert '13' in result['reply'] and '已隐藏' in result['reply']
    assert '土壤水分' in result['reply'] and '等效散射' in result['reply']
    assert result['operation_status'] == 'success'


@pytest.mark.parametrize('message', ['有哪些降水图层？', '列出可用的降水数据，说明单位和可用时间。', '有哪些降水图层？说明单位及是否已添加。'])
def test_catalog_query_filters_and_describes_availability(page, local_chat, monkeypatch, message):
    monkeypatch.setattr(rt, '_search_layers', lambda args, **kw: {
        'layers': [{'layer_id': 'rain', 'display_name': '降水试验数据', 'run_readiness': 'blocked'}]})
    monkeypatch.setattr(rt, '_get_layer_meta', lambda *a, **kw: {'layer': {
        'run_readiness': 'blocked', 'run_readiness_summary': '数据源未配置', 'unit': 'mm'}})
    result = local_chat(message, client_context=page)
    assert '降水试验数据' in result['reply'] and '当前不可用' in result['reply']
    assert 'mm' in result['reply'] and '土壤水分' not in result['reply']
    assert not result['ui_intents'] and result['operation_status'] == 'success'


@pytest.mark.parametrize('message', ['请解释地图初始化失败是什么意思', '有哪些图层不支持小时切换？'])
def test_correct_explanation_is_not_failure_from_quoted_error(message):
    assert response_status({'reply': '初始化失败表示地图未完成加载；该图层不支持切换小时。'}, message) == 'success'


@pytest.mark.parametrize('verb', ['添加', '显示', '打开'])
def test_catalog_exact_identity_ignores_spacing_and_action(verb, monkeypatch):
    monkeypatch.setattr(rt, '_search_layers', lambda *a, **kw: {'layers': [
        {'layer_id': 'parent', 'display_name': '降水'},
        {'layer_id': 'gpcp', 'display_name': 'GPCP 月降水'},
    ]})
    picked = mo._catalog_pick(verb+'GPCP月降水')
    assert picked and picked.catalog_id == 'gpcp'


@pytest.mark.parametrize('status,readiness', [('available', 'blocked'), ('placeholder', None), ('disabled', None)])
def test_unavailable_layer_has_no_mutation_intent(page, local_chat, monkeypatch, status, readiness):
    from app.services import layer_catalog
    monkeypatch.setattr(layer_catalog, 'get_layer_descriptor', lambda cid: SimpleNamespace(
        status=status, run_readiness=readiness, run_readiness_summary='测试数据未开放', supports_time=True))
    result = local_chat('显示风云平均版VOD', client_context=page)
    assert not result['ui_intents']
    assert result['operation_status'] == 'not_executed'
    assert '未开放' in result['reply'] or '不可用' in result['reply']


def test_temporal_catalog_not_misclassified_from_empty_local_frames(monkeypatch):
    from app.services import layer_catalog
    monkeypatch.setattr(layer_catalog, 'get_layer_descriptor', lambda cid: SimpleNamespace(supports_time=True))
    assert not mo._layer_is_static('gpcp-precip-ts')


def test_detailed_science_question_not_truncated_to_definition():
    from app.services.agent.knowledge_guard import project_knowledge_reply
    assert project_knowledge_reply('请用约300字介绍土壤水分遥感反演的基本原理与常见误差来源。') is None


def test_temporal_asset_inspection_uses_registered_default(monkeypatch, tmp_path):
    from app.services import overlay_asset_workflow_service as assets
    requested=[]
    def resolve(time):
        requested.append(time)
        return tmp_path/'missing'
    monkeypatch.setattr(assets, 'get_overlay_spec', lambda _: SimpleNamespace(
        category='time-series', default_time='2025-07', time_list=['2025-07'], ondemand_times=[],
        resolve_png=resolve, resolve_bounds=resolve))
    monkeypatch.setattr(assets, '_current_bake_version', lambda: 1)
    state=assets._read_asset_state('registered-series')
    assert requested == ['2025-07', '2025-07']
    assert state['asset_state'] == 'missing'


def test_only_visible_layer_does_not_imply_selected(page):
    for row in page['active_layers']: row['selected']=False; row['visible']=False
    page['active_layers'][1]['visible']=True
    answer=o._page_state_reply(page)
    assert '没有选中' in answer and '唯一勾选显示' in answer


def test_query_keeps_checked_and_failed_as_separate_states(page, local_chat):
    page['active_layers'][1].update(visible=True, load_state='failed')
    result=local_chat('风云平均版VOD是否勾选显示？',client_context=page)
    assert '已勾选显示' in result['reply'] and '数据加载失败' in result['reply']
    assert result['operation_status']=='success' and not result['ui_intents']


def test_runtime_missing_source_overrides_catalog_ready_flag(monkeypatch):
    from app.services import layer_catalog, workflow_request_resolver as resolver
    desc=SimpleNamespace(status='available', run_readiness='ready', run_readiness_summary=None, display_name='降水', supports_time=False)
    monkeypatch.setattr(layer_catalog, 'get_layer_descriptor',lambda _:desc)
    monkeypatch.setattr(resolver, 'describe_layer_run_readiness',lambda _: {'run_readiness':'blocked','run_readiness_summary':'当前缺少栅格文件'})
    assert '当前缺少栅格文件' in rt.layer_operation_block_reason('rain')


@pytest.mark.parametrize('message', [
    '先别隐藏风云平均版VOD只把它切换到2025-07-18',
    '把风云平均版VOD切到2025-07-18并保持其他图层不变',
])
def test_constraints_do_not_require_exact_punctuation(page, local_chat, monkeypatch, message):
    monkeypatch.setattr(rt,'_local_time_keys',lambda _:['20250701_20250731'])
    result=local_chat(message,client_context=page)
    assert [x['name'] for x in result['ui_intents']]==['set_timeline']
    assert result['ui_intents'][0]['args']['catalog_id']==page['active_layers'][1]['catalog_id']


def test_named_catalog_date_reports_source_unavailable_without_adding(page, local_chat, monkeypatch):
    monkeypatch.setattr(mo,'_catalog_pick',lambda _:mo.LayerPick('cmfd-precip-cn','CMFD 降水'))
    monkeypatch.setattr(rt,'layer_operation_block_reason',lambda *a,**kw:'CMFD 当前不可用：缺少数据文件。')
    result=local_chat('把CMFD降水切到2025-07-15',client_context=page)
    assert '当前不可用' in result['reply'] and not result['ui_intents']


def test_catalog_search_accepts_product_code_adjacent_to_chinese_variable():
    result=rt._search_layers({'query':'CMFD降水'},cred=None)
    assert any(row['layer_id']=='cmfd-precip-cn' for row in result['layers'])
