"""Connection configuration only; no real NAS traffic or scientific values."""
import json
import io
import pytest
from fastapi import HTTPException
from app.services.nas_ondemand import config, fetcher
from app.api.routers.nas_ondemand_routes import _run_frame


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in ('NAS_FILEBROWSER_BASE_URL', 'NAS_FILEBROWSER_USERNAME', 'NAS_FILEBROWSER_PASSWORD', 'NAS_FILEBROWSER_CREDENTIALS_PATH', 'CGDA_FY_NAS_SMB_PROFILE'):
        monkeypatch.delenv(key, raising=False)


def test_explicit_runtime_credentials(monkeypatch, tmp_path):
    path = tmp_path / 'nas.json'
    path.write_text(json.dumps({'filebrowser': {'nasfile': {'base_url': 'https://nas.example/', 'username': 'test-only', 'password': 'test-placeholder'}}}), encoding='utf-8')
    monkeypatch.setenv('NAS_FILEBROWSER_CREDENTIALS_PATH', str(path))
    assert config._load_nas_config() == ('https://nas.example', 'test-only', 'test-placeholder')


@pytest.mark.parametrize('content', [None, '{}', '{invalid'])
def test_missing_or_invalid_config_is_unavailable_not_an_unhandled_500(monkeypatch, tmp_path, content):
    path = tmp_path / 'nas.json'
    if content is not None:
        path.write_text(content, encoding='utf-8')
    monkeypatch.setenv('NAS_FILEBROWSER_CREDENTIALS_PATH', str(path))
    with pytest.raises(HTTPException) as result:
        _run_frame(config._load_nas_config)
    assert result.value.status_code == 503
    assert '数据源连接' in result.value.detail
    assert str(path) not in result.value.detail


def configure_mock_smb(monkeypatch):
    from app.services.remote_access import browser
    monkeypatch.setenv('CGDA_FY_NAS_SMB_PROFILE', 'test-science')
    monkeypatch.setattr(browser, '_get_bundle', lambda _: {'protocol':'smb', 'host':'nas.example',
        'username':'test-only', 'secret':'placeholder', 'extra':{'default_share':'group_nas'}})
    import smbclient
    monkeypatch.setattr(smbclient, 'reset_connection_cache', lambda **_: None)
    return smbclient


def test_smb_single_file_reads_only_and_writes_to_test_destination(monkeypatch, tmp_path):
    client = configure_mock_smb(monkeypatch)
    calls = []
    def open_read(path, *, mode, **options):
        calls.append((path, mode, options['connection_cache']))
        return io.BytesIO(b'test-fixture-not-scientific-data')
    monkeypatch.setattr(client, 'open_file', open_read)
    monkeypatch.setattr(fetcher, '_http', lambda *a, **k: pytest.fail('SMB must not fall back to HTTP'))
    target = tmp_path / 'frame.mat'
    assert fetcher._download_once('/Liuzheng/omega_final/fy_avg_smvod/', '20250723.mat', target) == len(target.read_bytes())
    assert calls[0][:2] == (r'\\nas.example\group_nas\Liuzheng\omega_final\fy_avg_smvod\20250723.mat', 'rb')
    assert not target.with_suffix('.mat.part').exists()


@pytest.mark.parametrize('path', ['/Liuzheng/omega_final/fy_avg_smvod/../private', '/private/data', '/Liuzheng/omega_final/fy_avg_smvod/\\..\\private'])
def test_smb_whitelist_precedes_credentials_and_network(monkeypatch, path):
    from app.services.remote_access import browser
    monkeypatch.setattr(browser, '_get_bundle', lambda _: pytest.fail('invalid path accessed credentials'))
    with pytest.raises(fetcher.NasPathDenied), fetcher._smb_reader(path):
        pass


def test_smb_read_failure_keeps_existing_local_result(monkeypatch, tmp_path):
    client = configure_mock_smb(monkeypatch)
    class BrokenReader(io.BytesIO):
        def read(self, size=-1):
            raise OSError('fixture disconnection')
    monkeypatch.setattr(client, 'open_file', lambda *a, **k: BrokenReader())
    target = tmp_path / 'frame.mat'
    target.write_bytes(b'existing')
    with pytest.raises(fetcher.NasUnavailable):
        fetcher._smb_download('/Liuzheng/omega_final/fy_avg_smvod/20250723.mat', target)
    assert target.read_bytes() == b'existing'
    assert not target.with_suffix('.mat.part').exists()
