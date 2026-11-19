"""Export endpoints must enforce per-layer access, not only role access."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.data_io.api import router


def test_single_layer_export_checks_layer_resource_access(monkeypatch):
    checked: list[tuple[object, str, str]] = []
    credential = SimpleNamespace(user_id=7)

    monkeypatch.setattr(
        router,
        "check_resource_access",
        lambda cred, kind, layer_id: checked.append((cred, kind, layer_id)),
    )
    monkeypatch.setattr(
        router,
        "export_layer",
        lambda *_args, **_kwargs: (b"data", "application/octet-stream", "layer.bin"),
    )

    response = asyncio.run(
        router.export_layer_endpoint(router.ExportBody(layer_id="private-layer"), credential)
    )

    assert checked == [(credential, "layer", "private-layer")]
    assert response.status_code == 200


def test_batch_export_denies_any_inaccessible_layer_before_creating_job(monkeypatch):
    checked: list[str] = []

    def check_access(_cred, _kind, layer_id: str) -> None:
        checked.append(layer_id)
        if layer_id == "other-users-private-layer":
            raise HTTPException(status_code=403, detail="forbidden")

    def must_not_enqueue(*_args, **_kwargs):
        pytest.fail("a denied batch must not create an export job")

    monkeypatch.setattr(router, "check_resource_access", check_access)
    monkeypatch.setattr(router, "enqueue_job", must_not_enqueue)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            router.export_batch_endpoint(
                router.ExportBatchBody(
                    layer_ids=["owned-layer", "other-users-private-layer"], async_mode=True
                ),
                SimpleNamespace(user_id=7),
            )
        )

    assert exc.value.status_code == 403
    assert checked == ["owned-layer", "other-users-private-layer"]
