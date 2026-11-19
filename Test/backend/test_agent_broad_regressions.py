"""33-case audit contracts. Page/data fixtures are simulations, not NAS evidence."""
import copy
import pytest
from test_agent_single_step_regressions import page, local_chat  # noqa: F401
from app.services.agent import orchestrator as o, server_tools_runtime as rt
from app.services.agent.request_semantics import explicit_bbox, request_mode, request_policy
from app.services.agent.operation_plan import plan_operations, bind_reference


@pytest.mark.parametrize('text', [
    '只生成计划，不执行任何操作。计划内容：先隐藏SMAP动态版土壤水分，再显示风云平均版VOD。',
    '仅列出操作方案：显示风云平均版SM，然后隐藏SMAP动态版VOD，暂不执行。',
    '先不执行，给出隐藏风云平均版VOD并显示SMAP平均版SM的计划。',
])
def test_plan_never_reaches_dispatch(page, monkeypatch, text):
    monkeypatch.setattr(o, '_run_chat_single', lambda *a,**k: pytest.fail('plan executed'))
    result = o.run_chat(text, client_context=page)
    assert not result['ui_intents'] and not result.get('operation_plan')
    assert result['operation_status'] == 'success' and '未执行' in result['reply']


@pytest.mark.parametrize('text', ['只查询统计结果', '只介绍能力，不执行任何操作', '只读查询，禁止修改任何图层'])
def test_read_only_blocks_workflow_before_dispatch(text):
    result=rt.execute_server_tool('run_workflow',{},user_message=text)
    assert result['error_code']=='blocked_by_current_instruction'


@pytest.mark.parametrize('bounds', [
    'west=114、east=113、south=22、north=23',
    'west=113,east=114,south=23,north=22',
    '经度114至113和纬度22至23',
    'west=113,east=114,south=22,north=95',
    'west=113,east=114,south=22',
])
def test_invalid_scope_no_model_or_raster_read(page, monkeypatch, bounds):
    monkeypatch.setattr(o, '_run_chat_single', lambda *a,**k: pytest.fail('invalid geometry dispatched'))
    text=f'统计SMAP动态版SM在2025-07-20、{bounds}矩形范围的均值'
    result=o.run_chat(text,client_context=page)
    assert result['operation_status']=='not_executed' and not result['ui_intents']
    assert '矩形范围' in result['reply']
    direct=rt._get_layer_statistics({},cred=None,user_message=text)
    assert direct['error_code']=='invalid_spatial_scope'


@pytest.mark.parametrize('bounds', ['west=113、east=114、south=22、north=23', '经度113至114和纬度22至23'])
def test_valid_scope_preserved(bounds):
    assert explicit_bbox(bounds)==([113.,22.,114.,23.],None)


def test_numbered_steps_exclude_named_preservation_and_bind_specific_step(page):
    text='请按顺序执行：\n1. 隐藏风云平均版VOD。\n2. 显示SMAP动态版土壤水分。\n3. 将第二步的图层日期设为2025-07-20。\n风云平均版土壤水分保持原来的显示状态。'
    plan=plan_operations(text)
    assert len(plan)==3,plan
    assert plan[2]['target_step_id']=='step-2' and plan[2]['depends_on']=='step-2'
    row=page['active_layers'][9]
    msg,ctx,ref,error=bind_reference(plan[2]['message'],{**page,'operation_inherit_target':True,'operation_reference':row})
    assert not error and ref['catalog_id']==row['catalog_id']
    assert '第二步' not in msg and 'SMAP' in msg


def test_reference_can_point_past_immediately_previous_step():
    plan=plan_operations('1. 显示风云平均版SM。\n2. 显示SMAP动态版VOD。\n3. 隐藏第一步的图层。')
    assert len(plan)==3 and plan[2]['target_step_id']=='step-1'


@pytest.mark.parametrize('text',[ '只显示SMAP动态版土壤水分，其他图层全部隐藏。', '仅显示风云平均版VOD，其余图层全部关闭。'])
def test_exclusive_visibility_is_atomic(page,local_chat,text):
    result=local_chat(text,client_context=page)
    assert len(result['ui_intents'])==1
    assert result['ui_intents'][0]['args']['solo'] is True
    assert result['ui_intents'][0]['args']['visible'] is True


@pytest.mark.parametrize('visible',[True,False])
def test_condition_observes_live_state(page,local_chat,monkeypatch,visible):
    page['active_layers'][9]['visible']=visible
    monkeypatch.setattr(rt,'_local_time_keys',lambda _:['20250701_20250731'])
    result=local_chat('如果SMAP动态版土壤水分已经勾选，就只把它的日期切换到2025-07-21；不要重新添加图层。',client_context=page)
    if visible:
        assert len(result['ui_intents'])==1,result
        assert result['ui_intents'][0]['name']=='set_timeline'
        assert result['ui_intents'][0]['args']['catalog_id']==page['active_layers'][9]['catalog_id']
    else:
        assert result['operation_status']=='not_executed' and not result['ui_intents']


@pytest.mark.parametrize('text', [
    '把风云平均版VOD的图例数值范围设为2到1。',
    '将SMAP动态版SM的显示最小值设为3、最大值设为0。',
])
def test_style_bad_order_rejected_without_statistics(page,local_chat,text):
    result=local_chat(text,client_context=page)
    assert result['operation_status']=='not_executed' and not result['ui_intents']
    assert '最小值必须小于最大值' in result['reply']


def test_style_range_not_visibility(page,local_chat):
    result=local_chat('在样式面板中，将风云卫星平均版植被光学厚度的显示最小值设为0、最大值设为1.2。',client_context=page)
    assert len(result['ui_intents'])==1,result
    action=result['ui_intents'][0]
    assert action['name']=='set_layer_symbology' and action['args']['vmax']==1.2
    assert action['args']['vmin']==0 and action['args']['catalog_id']==page['active_layers'][1]['catalog_id']


@pytest.mark.parametrize('word,expected',[('往前移一天','2025-07-30'),('往后移两天','2025-08-02'),('前一天','2025-07-30')])
def test_relative_date_uses_target_memory(page,local_chat,monkeypatch,word,expected):
    page['active_layers'][1]['requested_time']={'date':'2025-07-31'}
    monkeypatch.setattr(rt,'_local_time_keys',lambda _:['20250701_20250731','20250801_20250831'])
    result=local_chat(f'把当前图层的日期{word}。',client_context=page)
    assert result['ui_intents'][0]['name']=='set_timeline',result
    assert result['ui_intents'][0]['args']['date']==expected


def test_compound_page_read_includes_selected_visible_and_map(page,local_chat):
    result=local_chat('请只查询当前页面：列出当前选中的图层、所有勾选显示的图层，以及地图是否就绪，不要改变任何状态。',client_context={**page,'map_ready':False})
    assert not result['ui_intents'] and not result.get('operation_plan')
    assert '地图未就绪' in result['reply'] and '勾选显示（2 层）' in result['reply']
    assert '当前选中查看' in result['reply']


def test_statistics_followup_never_changes_selected_vod(page,local_chat,monkeypatch):
    from app.services.agent import mock_orchestrator as mo
    target=page['active_layers'][0]['catalog_id']
    monkeypatch.setattr(o,'load_topic_state',lambda **kw:{'layer_id':target,'date':'2025-07-20','region':'广州市'})
    monkeypatch.setattr(o,'load_history',lambda **kw:[{'role':'user','content':'统计风云平均版SM在广州市2025-07-20的均值'}])
    calls=[]
    def statistic(text,**kw):
        calls.append((text,kw['state']))
        return {'reply':'测试夹具：广州市没有有效像元（NoData）。','ui_intents':[],'topic_state':{'layer_id':target,'date':'2025-07-21','region':'广州市'}}
    monkeypatch.setattr(mo,'forced_statistics_reply',statistic)
    original=copy.deepcopy(page)
    result=local_chat('日期换成2025-07-21，产品和广州市范围沿用上一条，只查询统计结果。',client_context=page)
    assert len(calls)==1 and calls[0][1]['layer_id']==target
    assert not result['ui_intents'] and not result.get('operation_plan') and page==original
    assert 'NoData' in result['reply']


def test_readonly_final_guard_catches_late_fallback_write(page,monkeypatch):
    monkeypatch.setattr(o,'_run_chat_single',lambda *a,**k:{'reply':'已切换','ui_intents':[{'name':'set_timeline','args':{'date':'2025-07-21'}}]})
    result=o.run_chat('只查询统计结果',client_context=page)
    assert not result['ui_intents'] and '已切换' not in result['reply']
    assert request_policy.get() is None


def test_list_reorder_not_claimed_as_render_order(page,local_chat):
    result=local_chat('把风云平均版VOD移动到图层列表最上面。',client_context=page)
    assert not result['ui_intents'] and '分组列表' in result['reply']
    assert result['operation_status']=='needs_clarification'


def test_capability_explanation_is_readonly_not_a_plan():
    assert request_mode('游客现在可以让你执行哪些操作？请只介绍能力，不执行任何操作。') == 'read_only'


@pytest.mark.parametrize('prefix',['我指的是','我说的是','指的就是'])
def test_clarified_target_is_one_action(page,local_chat,prefix):
    result=local_chat(prefix+'SMAP动态版的土壤水分，显示它。',client_context=page)
    assert not result.get('operation_plan')
    assert len(result['ui_intents'])==1 and result['ui_intents'][0]['args']['catalog_id']==page['active_layers'][9]['catalog_id']


def test_bbox_reply_names_actual_scope(page,local_chat,monkeypatch):
    monkeypatch.setattr(rt,'_get_layer_statistics',lambda args,**kw:{'ok':False,'valid_pixels':0,'period_start':'20250720','period_end':'20250720','requested_bbox':args['bbox']})
    result=local_chat('统计SMAP动态版土壤水分在2025-07-20、经度113至114和纬度22至23的矩形均值',client_context=page)
    assert '矩形范围' in result['reply'] and '整层在' not in result['reply']
    assert '西 113' in result['reply'] and '有效像元 0' in result['reply']


def test_product_coverage_reads_matching_daily_source(monkeypatch):
    from app.services.agent import mock_orchestrator as mo
    from app.services.nas_ondemand import date_index as source
    seen=[]
    monkeypatch.setattr(source,'daily_index',lambda product,var:seen.append((product,var)) or [{'key':'20150101'},{'key':'20251231'}])
    assert mo._nas_coverage_range('imported-a8940443fd6d')==('20150101','20251231')
    assert seen==[('smap_raw','SM')]


def test_daily_product_never_substitutes_month_even_without_special_wording(monkeypatch):
    class Spec:
        default_time='20250701_20250731'
        time_list=[default_time]
        source_reader='geotiff'
        def resolve_time_key(self,*a,**kw): return self.default_time
    monkeypatch.setattr(rt,'_filter_ids',lambda ids,cred:list(ids))
    monkeypatch.setattr(rt,'_cross_source_guard',lambda *a,**kw:None)
    monkeypatch.setattr(rt,'_ensure_ondemand_frame',lambda *a,**kw:{'ok':False,'reason':'fetch_failed'})
    monkeypatch.setattr('app.services.overlay_registry.get_overlay_spec',lambda _:Spec())
    result=rt._get_layer_statistics({'catalog_id':'imported-55359b8ecd3d','time':'2025-07-21'},cred=None,user_message='查询当天均值')
    assert not result['ok'] and result['strict_time_match'] and 'mean' not in result


def test_smb_source_not_blocked_by_unused_http_tunnel(monkeypatch):
    monkeypatch.setenv('CGDA_FY_NAS_SMB_PROFILE','isolated-test-profile')
    monkeypatch.setattr('app.services.nas_ondemand.config._load_nas_config',lambda:pytest.fail('legacy tunnel should not be read'))
    assert rt._nas_reachable()


def test_visitor_capability_explanation_obeys_tool_permission(page,local_chat):
    result=local_chat('游客现在可以让你执行哪些操作？哪些操作不支持？请只介绍能力，不执行任何操作。',client_context=page)
    assert '不能通过助手提交工作流' in result['reply']
    assert not result['ui_intents'] and not result.get('operation_plan')
    assert result['operation_status']=='success'
