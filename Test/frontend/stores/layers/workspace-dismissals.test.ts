import { describe, expect, it } from 'vitest'
import { filterDismissedWorkspace, mergeWorkspaceDismissals, recordWorkspaceDismissal } from '@/stores/layers/workspace-dismissals'
import type { DismissedLayersRegistry, WorkspaceSnapshot } from '@/stores/layers/workspace-persist'

const empty = (): DismissedLayersRegistry => ({ catalogIds: [], overlayLayerIds: [], vectorBackendLayerIds: [], runIds: [] })
describe('cross-browser removal and explicit re-addition', () => {
  it.each(['aridity-cn', 'cmfd-precip', 'koppen'])('keeps removal of %s when an old browser saves an empty registry', (id) => {
    const removed = { ...empty(), catalogIds: [id] }
    recordWorkspaceDismissal(removed, 'catalogIds', id, true)
    expect(mergeWorkspaceDismissals(empty(), removed).catalogIds).toEqual([id])
    expect(mergeWorkspaceDismissals(removed, empty()).catalogIds).toEqual([id])
  })
  it('propagates an explicit re-add to a browser that still remembers the removal', () => {
    const removed = { ...empty(), catalogIds: ['aridity-cn'] }
    recordWorkspaceDismissal(removed, 'catalogIds', 'aridity-cn', true)
    const restored = structuredClone(removed)
    restored.catalogIds = []
    recordWorkspaceDismissal(restored, 'catalogIds', 'aridity-cn', false)
    expect(mergeWorkspaceDismissals(removed, restored).catalogIds).toEqual([])
    const deletedAgain = structuredClone(restored)
    deletedAgain.catalogIds = ['aridity-cn']
    recordWorkspaceDismissal(deletedAgain, 'catalogIds', 'aridity-cn', true)
    expect(mergeWorkspaceDismissals(restored, deletedAgain).catalogIds).toEqual(['aridity-cn'])
  })
  it('accepts legacy removal arrays but ignores malformed operation records', () => {
    const remote = { ...empty(), catalogIds: ['old'], operations: {
      'catalogIds:old': { removed: false, changedAt: NaN },
      'unknown:x': { removed: true, changedAt: 100 },
    }}
    expect(mergeWorkspaceDismissals(empty(), remote).catalogIds).toEqual(['old'])
  })
  it('filters the removed layer and group membership without changing another layer or its time', () => {
    const snapshot: WorkspaceSnapshot = { version: 1, schemaVersion: 3, savedAt: '2026-11-15T01:00:00Z', layers: [],
      catalogLayers: [
        { instanceId: 'gone', catalogId: 'aridity-cn', visible: false, opacity: 0.9, order: 1, runGroupId: 'g' },
        { instanceId: 'keep', catalogId: 'cmfd-temp', visible: true, opacity: 0.6, order: 2, runGroupId: 'g' },
      ], groups: [{ groupId: 'g', memberInstanceIds: ['gone', 'keep'], status: 'ready' } as WorkspaceSnapshot['groups'][number]] }
    const original = structuredClone(snapshot)
    const result = filterDismissedWorkspace(snapshot, { ...empty(), catalogIds: ['aridity-cn'] })
    expect(result.catalogLayers).toEqual([snapshot.catalogLayers![1]])
    expect(result.groups[0]!.memberInstanceIds).toEqual(['keep'])
    expect(result.savedAt).toBe(snapshot.savedAt)
    expect(snapshot).toEqual(original)
  })
})

