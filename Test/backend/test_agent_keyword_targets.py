"""Product aliases resolve to stable targets, without guessing a variable."""
from copy import deepcopy
import pytest
from test_agent_single_step_regressions import page
from app.services.agent import mock_orchestrator as mo

@pytest.mark.parametrize("text,index", [
    ("切换到风云平均VOD",1), ("选中FY平均版VOD",1),
    ("换到ＦＹ平均ＶＯＤ",1), ("查看fy average VOD",1),
    ("选择SMAP动态SM",9), ("切换到SMAP动态土壤水分",9),
    ("选中风云动态OMEGA",8), ("切到FY3动态ω",8),
    ("选中风云平均V O D",1), ("显示风云平均S M",0), ("显示 S M A P 平均 SM",3),
])
def test_keyword_target_identity(page,text,index):
    chosen=mo._resolve_layer(text,mo._normalize_layers(page),allow_demo_fallback=False)
    assert chosen and chosen.catalog_id==page["active_layers"][index]["catalog_id"]
    assert chosen.instance_id==page["active_layers"][index]["instance_id"]

def test_short_variable_uses_compatible_selected_group(page):
    chosen=mo._resolve_layer("选中SM",mo._normalize_layers(page),allow_demo_fallback=False)
    assert chosen and chosen.catalog_id==page["active_layers"][0]["catalog_id"]

@pytest.mark.parametrize("text",["选中SMAP VOD","选中风云平均散射约束产品","显示SMAP图层"])
def test_missing_dimensions_clarify_instead_of_guessing(page,text):
    assert mo._resolve_layer(text,mo._normalize_layers(page),allow_demo_fallback=False) is None

def test_bare_variable_without_selected_context_is_ambiguous(page):
    for row in page["active_layers"]:row["selected"]=False
    assert mo._resolve_layer("显示VOD",mo._normalize_layers(page),allow_demo_fallback=False) is None

def test_named_duplicate_instances_are_not_silently_deduplicated(page):
    other=deepcopy(page["active_layers"][1]);other["instance_id"]="second-copy";other["selected"]=False
    page["active_layers"].append(other)
    rows=mo._normalize_layers(page)
    assert len(mo.resolve_target_candidates("选中风云平均VOD",rows))==2
    assert mo._resolve_layer("选中风云平均VOD",rows,allow_demo_fallback=False) is None
    current=mo._resolve_layer("选中当前图层",rows,allow_demo_fallback=False)
    assert current and current.instance_id==page["active_layers"][1]["instance_id"]

def test_unknown_source_does_not_satisfy_explicit_source(page):
    rows=[{"catalog_id":"unknown-source-vod","instance_id":"v1","name":"VOD","visible":False}]
    assert mo._resolve_layer("选中风云平均VOD",rows,allow_demo_fallback=False) is None

def test_unsplit_multiple_variables_never_pick_the_only_present_one(page):
    rows=[page["active_layers"][1]]
    assert mo._resolve_layer("选中风云平均SM VOD",rows,allow_demo_fallback=False) is None

@pytest.mark.parametrize("text",[
    "选中风云平均VOD逐日数据",
    "把风云平均VOD的日尺度日期切到2025-07-10",
])
def test_time_cadence_cannot_override_explicit_product_version(page,text):
    pick=mo._resolve_layer(text,mo._normalize_layers(page),allow_demo_fallback=False)
    assert pick and pick.catalog_id==page["active_layers"][1]["catalog_id"]

@pytest.mark.parametrize("text",[
    "切换到风云平均版或SMAP平均版VOD",
    "切换到风云平均版或动态版VOD",
])
def test_conflicting_product_dimensions_require_clarification(page,text):
    assert mo._resolve_layer(text,mo._normalize_layers(page),allow_demo_fallback=False) is None

def test_catalog_restore_uses_existing_saved_average_group_not_l3(page,monkeypatch):
    from app.services.agent import server_tools_runtime as rt
    from app.services.agent import layer_identity as identity
    members = [{"overlay_layer_id": row["catalog_id"], "variable": code,
                "variable_label": row["name"]} for row,code in
               zip(page["active_layers"][3:6], ("sm", "vod", "omega"))]
    monkeypatch.setattr(identity, "_group_member_ids",
                        lambda group: members if group == "method-smap-season-mean" else [])
    mo._IDENTITY_CACHE.clear()
    monkeypatch.setattr(rt,"_search_layers",lambda *a,**kw:{"layers":[
        {"layer_id":"ref-smap-sm-202512-l3","display_name":"SMAP L3 土壤水分"}]})
    pick=mo._catalog_pick("添加SMAP平均SM")
    assert pick and pick.catalog_id==page["active_layers"][3]["catalog_id"]

def test_catalog_unknown_version_cannot_satisfy_explicit_average(monkeypatch):
    from app.services.agent import layer_identity as identity,server_tools_runtime as rt
    monkeypatch.setattr(identity,"known_product_group_ids",lambda:set())
    monkeypatch.setattr(mo,"_layer_identity",lambda cid:{})
    monkeypatch.setattr(rt,"_search_layers",lambda *a,**kw:{"layers":[
        {"layer_id":"ref-smap-sm-202512-l3","display_name":"SMAP L3 土壤水分"}]})
    assert mo._catalog_pick("添加SMAP平均SM") is None
