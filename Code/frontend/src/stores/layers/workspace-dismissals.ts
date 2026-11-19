import type { DismissedLayersRegistry, WorkspaceSnapshot } from './workspace-persist'

export type DismissedLayerKind = 'overlayLayerIds' | 'catalogIds' | 'vectorBackendLayerIds' | 'runIds'
const KINDS: DismissedLayerKind[] = ['overlayLayerIds', 'catalogIds', 'vectorBackendLayerIds', 'runIds']
type Operation = { removed: boolean; changedAt: number }

function operations(registry: DismissedLayersRegistry): Record<string, Operation> {
  const result: Record<string, Operation> = {}
  for (const kind of KINDS) {
    for (const id of registry[kind] ?? []) result[kind + ':' + id] = { removed: true, changedAt: 0 }
  }
  for (const [key, op] of Object.entries(registry.operations ?? {})) {
    if (!KINDS.some((kind) => key.startsWith(kind + ':') && key.length > kind.length + 1)) continue
    if (op && typeof op.removed === 'boolean' && Number.isFinite(op.changedAt) && op.changedAt >= 0) {
      result[key] = op
    }
  }
  return result
}

export function recordWorkspaceDismissal(
  registry: DismissedLayersRegistry,
  kind: DismissedLayerKind,
  id: string,
  removed: boolean,
): void {
  const changes = operations(registry)
  const key = kind + ':' + id
  changes[key] = { removed, changedAt: Math.max(Date.now(), (changes[key]?.changedAt ?? 0) + 1) }
  registry.operations = changes
}

/** Removal is an explicit action; absence from a stale browser's registry is not an undo. */
export function mergeWorkspaceDismissals(
  local: DismissedLayersRegistry,
  remote: DismissedLayersRegistry,
): DismissedLayersRegistry {
  const merged = operations(local)
  for (const [key, incoming] of Object.entries(operations(remote))) {
    const previous = merged[key]
    if (!previous || incoming.changedAt > previous.changedAt ||
      (incoming.changedAt === previous.changedAt && incoming.removed)) merged[key] = incoming
  }
  const result: DismissedLayersRegistry = {
    overlayLayerIds: [], catalogIds: [], vectorBackendLayerIds: [], runIds: [],
  }
  for (const kind of KINDS) {
    result[kind] = Object.entries(merged)
      .filter(([key, op]) => key.startsWith(kind + ':') && op.removed)
      .sort((a, b) => b[1].changedAt - a[1].changedAt)
      .map(([key]) => key.slice(kind.length + 1))
  }
  if (Object.keys(merged).length) result.operations = merged
  return result
}

/** Filter persisted membership without changing other layers' dates, visibility or styles. */
export function filterDismissedWorkspace(
  snapshot: WorkspaceSnapshot,
  dismissed: DismissedLayersRegistry,
): WorkspaceSnapshot {
  const removedGroups = new Set(
    snapshot.groups.filter((g) => g.runId && dismissed.runIds.includes(g.runId)).map((g) => g.groupId),
  )
  const keepGroup = (layer: { runGroupId?: string }) =>
    !layer.runGroupId || !removedGroups.has(layer.runGroupId)
  const layers = snapshot.layers.filter(
    (l) => keepGroup(l) && !dismissed.overlayLayerIds.includes(l.importedRaster?.overlayLayerId ?? ''),
  )
  const catalogLayers = (snapshot.catalogLayers ?? []).filter(
    (l) => keepGroup(l) && !dismissed.catalogIds.includes(l.catalogId),
  )
  const vectorLayers = (snapshot.vectorLayers ?? []).filter(
    (l) => keepGroup(l) && !dismissed.vectorBackendLayerIds.includes(l.backendLayerId),
  )
  if (
    layers.length === snapshot.layers.length &&
    catalogLayers.length === (snapshot.catalogLayers?.length ?? 0) &&
    vectorLayers.length === (snapshot.vectorLayers?.length ?? 0) &&
    !removedGroups.size
  ) return snapshot
  const keptIds = new Set([...layers, ...catalogLayers, ...vectorLayers].map((l) => l.instanceId))
  const groups = snapshot.groups
    .filter((g) => !removedGroups.has(g.groupId))
    .map((g) => ({ ...g, memberInstanceIds: g.memberInstanceIds.filter((id) => keptIds.has(id)) }))
    .filter((g) => g.memberInstanceIds.length > 0)
  return { ...snapshot, layers, catalogLayers, vectorLayers, groups }
}
