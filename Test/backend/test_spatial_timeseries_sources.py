"""Synthetic, offline regressions. Real NAS verification is recorded separately."""
from types import SimpleNamespace
import numpy as np
import pytest
from app.services import spatial_timeseries_service as service
from app.services import spatial_timeseries_source as source
from shared.spatial_timeseries import extract_series, read_frame
from test_spatial_timeseries import raster


def test_index_uses_selected_directory_real_dates_and_refreshes(monkeypatch):
    seen=[]
    monkeypatch.setattr(source.fetcher,'resolve_nas_dir',lambda p,v: f'/{p}/{v}')
    names=['20250710.mat','20250712.mat','20250230.mat','source_20260101.tif','20250711.mat']
    def listing(path, *, include_sizes=True):
        assert include_sizes is False
        seen.append(path)
        return [dict(name=n,isDir=n=='20250711.mat') for n in names]
    monkeypatch.setattr(source.fetcher,'list_dir',listing)
    assert [f['start'] for f in source.daily_index('fy_avg','VOD')]==['2025-07-10','2025-07-12']
    names.append('20150401.mat')
    assert source.daily_index('smap_raw','SM')[0]['start']=='2015-04-01'
    assert seen==['/fy_avg/VOD','/smap_raw/SM']


def setup_product(monkeypatch,tmp_path):
    raster(tmp_path,'source_20260101.tif')
    product=dict(id='fixture',variable='VOD',source_kind='nas_daily',source_id='fy_avg',frames=[])
    monkeypatch.setattr(service,'list_products',lambda _: [product.copy()])
    monkeypatch.setattr(service,'get_overlay_spec',lambda _: SimpleNamespace(overlay_dir=tmp_path))
    monkeypatch.setattr(source,'daily_index',lambda p,v: [dict(key=d.replace('-',''),start=d,end=d,cadence='daily',source='nas',source_product=p,filename=d.replace('-','')+'.mat') for d in ['2015-04-01','2025-07-10','2025-07-12']])
    return product


def test_availability_and_plan_share_index_without_future_cached_daily(monkeypatch,tmp_path):
    setup_product(monkeypatch,tmp_path)
    result=service.product_availability('fixture',None)
    assert len(result['frames'])==3 and result['frames'][-1]['end']=='2025-07-12'
    assert 'filename' not in result['frames'][0]
    request=dict(product_id='fixture',mode='point',point=[113.26,23.13],start='2025-07-10',end='2025-07-12',cadence='daily')
    plan=service.build_plan(request,None)
    assert [f['start'] for f in plan['frames']]==['2025-07-10','2025-07-12']
    assert all(f['source_product']=='fy_avg' for f in plan['frames'])
    with pytest.raises(ValueError,match='超出'):
        service.build_plan(dict(request,end='2026-01-01'),None)


def test_source_failure_does_not_fallback_to_cached_dates(monkeypatch,tmp_path):
    setup_product(monkeypatch,tmp_path)
    def fail(*_): raise source.fetcher.NasUnavailable('fixture offline')
    monkeypatch.setattr(source,'daily_index',fail)
    with pytest.raises(source.fetcher.NasUnavailable): service.product_availability('fixture',None)


def nas_mocks(monkeypatch):
    monkeypatch.setattr(source.fetcher,'resolve_nas_dir',lambda *_: '/fixture')
    monkeypatch.setattr(source.fetcher,'download_file',lambda *_: 1)
    monkeypatch.setattr(source.renderer,'read_mat_auto',lambda _: {'CRS':'EPSG:4326'})
    from rasterio.transform import from_origin
    monkeypatch.setattr(source.renderer,'ease_transform_from_mat',lambda _: from_origin(0,2,1,1))
    monkeypatch.setattr(source.renderer,'extract_variable',lambda m,v: np.array([[1,np.nan],[0,3]],dtype=float))
    return dict(source_product='fy_avg',filename='20250710.mat',source='nas',key='20250710',start='2025-07-10',end='2025-07-10',cadence='daily')


def test_native_nas_pixel_precision_zero_nodata_and_coverage(monkeypatch):
    frame=nas_mocks(monkeypatch)
    def read(p): return source.read_observation(frame,'SM',dict(mode='point',point=p),lambda:None)
    assert read([.5,1.5])['value']==1
    assert read([.5,.5])['value']==0
    assert read([1.5,1.5])['status']=='no_valid_data'
    assert read([20,20])['status']=='outside_data'


@pytest.mark.parametrize('exception,status',[(source.fetcher.NasUnavailable,'source_unavailable'),(source.fetcher.NasFileMissing,'missing_file'),(ValueError,'read_error')])
def test_failures_are_null_and_classified(monkeypatch,exception,status):
    frame=nas_mocks(monkeypatch)
    def fail(*_): raise exception('fixture error')
    monkeypatch.setattr(source.fetcher,'download_file',fail)
    row=source.read_observation(frame,'SM',dict(mode='point',point=[0,0]),lambda:None)
    assert row['value'] is None and row['status']==status


def test_cancel_is_not_reported_as_data_failure(monkeypatch):
    frame=nas_mocks(monkeypatch)
    def cancel(): raise RuntimeError('cancelled')
    with pytest.raises(RuntimeError,match='cancelled'):
        source.read_observation(frame,'SM',dict(mode='point',point=[0,0]),cancel)


def test_daily_gap_remains_missing_date_with_nas_row(monkeypatch):
    frame=nas_mocks(monkeypatch)
    result=extract_series(dict(product={'variable':'SM'},request=dict(mode='point',point=[.5,1.5],cadence='daily',start='2025-07-10',end='2025-07-11'),frames=[frame]))
    assert [r['status'] for r in result['rows']]==['ok','missing_date']
    assert result['rows'][1]['value'] is None


def test_polygon_hole_and_multiple_parts_are_not_bbox(tmp_path):
    path=raster(tmp_path,data=np.ones((5,5)),transform=__import__('rasterio').transform.from_origin(0,5,1,1))
    geom={'type':'MultiPolygon','coordinates':[
        [[[0,0],[3,0],[3,3],[0,3],[0,0]],[[1,1],[1,2],[2,2],[2,1],[1,1]]],
        [[[4,4],[5,4],[5,5],[4,5],[4,4]]]]}
    row=read_frame(path,dict(mode='region',geometry=geom),lambda:None)
    assert row['count']==9 and row['total_count']==9
