"""Offline regressions: no NAS connection or scientific data."""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.services.nas_ondemand import fetcher
from app.services import spatial_timeseries_source


class DirectoryEntry:
    def __init__(self, name, is_dir=False, size=123, allow_stat=True):
        self.name = name
        self.directory = is_dir
        self.size = size
        self.allow_stat = allow_stat
        self.stat_calls = 0

    def is_dir(self):
        return self.directory

    def stat(self):
        self.stat_calls += 1
        assert self.allow_stat, "Name-only listing must not request file metadata"
        return SimpleNamespace(st_size=self.size)


def smb_listing(monkeypatch, entries):
    client = SimpleNamespace(scandir=lambda *args, **kwargs: iter(entries))

    @contextmanager
    def reader(_path):
        yield client, "offline-fixture", {}

    monkeypatch.setattr(fetcher, "_smb_reader", reader)
    monkeypatch.setenv("CGDA_FY_NAS_SMB_PROFILE", "offline-fixture")


def test_smb_default_listing_keeps_file_sizes(monkeypatch):
    entries = [DirectoryEntry("20251202.mat", size=456), DirectoryEntry("folder", is_dir=True)]
    smb_listing(monkeypatch, entries)
    result = fetcher.list_dir("/Liuzheng/omega_final/fy_raw_smvod")
    assert result == [
        {"name": "20251202.mat", "isDir": False, "size": 456},
        {"name": "folder", "isDir": True, "size": 0},
    ]
    assert [entry.stat_calls for entry in entries] == [1, 0]


def test_smb_names_only_listing_never_stats_files(monkeypatch):
    entries = [DirectoryEntry("20251202.mat", allow_stat=False), DirectoryEntry("folder", is_dir=True)]
    smb_listing(monkeypatch, entries)
    result = fetcher.list_dir("/Liuzheng/omega_final/fy_raw_smvod", include_sizes=False)
    assert result == [
        {"name": "20251202.mat", "isDir": False},
        {"name": "folder", "isDir": True},
    ]
    assert all(entry.stat_calls == 0 for entry in entries)


@pytest.mark.parametrize("include_sizes", [True, False])
def test_local_listing_respects_size_option(monkeypatch, include_sizes):
    entry = DirectoryEntry("20251202.mat", size=789, allow_stat=include_sizes)
    monkeypatch.setattr(fetcher, "_local_path", lambda *_: SimpleNamespace(is_dir=lambda: True))
    monkeypatch.setattr(fetcher.os, "scandir", lambda *_: iter([entry]))
    result = fetcher._local_list_dir("offline", "/fixture", include_sizes=include_sizes)
    assert result[0]["name"] == "20251202.mat"
    assert ("size" in result[0]) is include_sizes
    assert entry.stat_calls == int(include_sizes)
    if include_sizes:
        assert result[0]["size"] == 789


def test_daily_index_requests_names_only_and_keeps_real_date_rules(monkeypatch):
    calls = []

    def listing(directory, *, include_sizes=True):
        calls.append((directory, include_sizes))
        return [
            {"name": "20251202.mat", "isDir": False},
            {"name": "20251201.mat", "isDir": False},
            {"name": "20250230.mat", "isDir": False},
            {"name": "20251203.mat", "isDir": True},
            {"name": "notes.txt", "isDir": False},
        ]

    monkeypatch.setattr(spatial_timeseries_source.fetcher, "resolve_nas_dir", lambda *_: "/selected")
    monkeypatch.setattr(spatial_timeseries_source.fetcher, "list_dir", listing)
    frames = spatial_timeseries_source.daily_index("fy_raw", "SM")
    assert calls == [("/selected", False)]
    assert [frame["start"] for frame in frames] == ["2025-12-01", "2025-12-02"]
    assert all(frame["source_product"] == "fy_raw" for frame in frames)
