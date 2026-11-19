"""Merge explicit layer removals so stale clients cannot resurrect deleted workspace entries."""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

KINDS = ("overlayLayerIds", "catalogIds", "vectorBackendLayerIds", "runIds")


def _operations(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = {}
    for kind in KINDS:
        values = registry.get(kind)
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str) and value:
                    result[f"{kind}:{value}"] = {"removed": True, "changedAt": 0}
    ops = registry.get("operations")
    if isinstance(ops, dict):
        for key, op in ops.items():
            if not isinstance(key, str) or not any(
                key.startswith(kind + ":") and len(key) > len(kind) + 1
                for kind in KINDS
            ):
                continue
            if not isinstance(op, dict) or not isinstance(op.get("removed"), bool):
                continue
            at = op.get("changedAt")
            if isinstance(at, (int, float)) and not isinstance(at, bool) and 0 <= at <= 9007199254740991 and math.isfinite(at):
                result[key] = {"removed": op["removed"], "changedAt": at}
    return result


def _merge_bundle(previous: dict[str, Any], incoming: dict[str, Any]) -> None:
    old_snapshot, snapshot = previous.get("snapshot"), incoming.get("snapshot")
    if not isinstance(old_snapshot, dict) or not isinstance(snapshot, dict):
        return
    if old_snapshot.get("schemaVersion") != snapshot.get("schemaVersion"):
        return  # A deliberate default/schema migration must not inherit obsolete removals.
    old_reg, new_reg = previous.get("dismissed") or {}, incoming.get("dismissed") or {}
    if not isinstance(old_reg, dict) or not isinstance(new_reg, dict):
        return
    ops = _operations(old_reg)
    for key, new in _operations(new_reg).items():
        old = ops.get(key)
        if old is None or new["changedAt"] > old["changedAt"] or (
            new["changedAt"] == old["changedAt"] and new["removed"]
        ):
            ops[key] = new
    if not ops:
        return
    registry = dict(new_reg)
    for kind in KINDS:
        registry[kind] = [
            key[len(kind) + 1:]
            for key, op in sorted(ops.items(), key=lambda item: -item[1]["changedAt"])
            if key.startswith(kind + ":") and op["removed"]
        ]
    registry["operations"] = ops
    incoming["dismissed"] = registry
    groups = snapshot.get("groups") or []
    removed_groups = {
        g.get("groupId") for g in groups if isinstance(g, dict)
        and g.get("runId") in registry["runIds"]
    }
    removed_instances = set()
    for field, kind, identity in (
        ("layers", "overlayLayerIds", lambda layer: layer["importedRaster"].get("overlayLayerId")
         if isinstance(layer.get("importedRaster"), dict) else None),
        ("catalogLayers", "catalogIds", lambda layer: layer.get("catalogId")),
        ("vectorLayers", "vectorBackendLayerIds", lambda layer: layer.get("backendLayerId")),
    ):
        rows = snapshot.get(field)
        if not isinstance(rows, list):
            continue
        kept = []
        for layer in rows:
            if isinstance(layer, dict) and (
                layer.get("runGroupId") in removed_groups or identity(layer) in registry[kind]
            ):
                removed_instances.add(layer.get("instanceId"))
            else:
                kept.append(layer)
        snapshot[field] = kept
    if isinstance(groups, list) and (removed_instances or removed_groups):
        kept_groups = []
        for group in groups:
            if not isinstance(group, dict) or group.get("groupId") in removed_groups:
                continue
            members = group.get("memberInstanceIds")
            if isinstance(members, list):
                kept = [mid for mid in members if mid not in removed_instances]
                if members and not kept:
                    continue
                group["memberInstanceIds"] = kept
            kept_groups.append(group)
        snapshot["groups"] = kept_groups


def merge_workspace_removals(previous: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    if not previous or previous.get("version") != incoming.get("version"):
        return incoming
    result = deepcopy(incoming)
    if incoming.get("version") == 2:
        old_scopes, scopes = previous.get("scopes"), result.get("scopes")
        if isinstance(old_scopes, dict) and isinstance(scopes, dict):
            for scope, bundle in scopes.items():
                old = old_scopes.get(scope)
                if isinstance(old, dict) and isinstance(bundle, dict):
                    _merge_bundle(old, bundle)
    elif incoming.get("version") == 1:
        old_scope = (previous.get("snapshot") or {}).get("apiScope")
        new_scope = (result.get("snapshot") or {}).get("apiScope")
        if old_scope == new_scope:
            _merge_bundle(previous, result)
    return result

