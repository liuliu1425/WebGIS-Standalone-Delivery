import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

function mockBrowserStorage() {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', {
    localStorage: storage,
    clearTimeout: () => undefined,
    setTimeout: () => 0,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })
}

vi.mock('@/stores/weather-tile-manager', () => ({
  useWeatherTileManager: () => ({
    setLayerActive: vi.fn(),
    clearLayer: vi.fn(),
    setViewport: vi.fn(),
    getLayerStatus: () => ({
      active: false,
      cachedInViewport: 0,
      viewportTotal: 0,
      pending: 0,
      errorType: null,
      errorMessage: null,
    }),
    getMergedGeojsonForViewport: () => null,
    getDataVersion: () => 0,
    dataVersion: { value: 0 },
    statusVersion: { value: 0 },
    activityVersion: { value: 0 },
  }),
}))

vi.mock('@/services/runtime-api', () => ({
  fetchLayerCatalog: vi.fn(async () => ({ items: [] })),
  submitWorkflow: vi.fn(),
  getWorkflowRun: vi.fn(),
  getWorkflowEvents: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  retryWorkflowRun: vi.fn(),
  getWeatherPoint: vi.fn(),
}))

vi.mock('@/services/layer-capabilities', () => ({
  isWeatherLayerDescriptor: () => true,
  supportsMapLayerCapability: () => false,
  supportsParticleFlowCapability: () => false,
  supportsViewportDrivenRefreshCapability: () => false,
}))

import { useLayersStore } from '@/stores/layers/index'
import {
  buildWorkspaceSnapshot, loadDismissedLayers, rememberDismissedLayer,
} from '@/stores/layers/workspace-persist'
import { mergeWorkspaceDismissals } from '@/stores/layers/workspace-dismissals'

describe('catalog remove and explicit add persistence', () => {
  beforeEach(() => {
    mockBrowserStorage()
    setActivePinia(createPinia())
  })

  it.each(['aridity-cn', 'cmfd-precip', 'hfp-cn'])('retains an explicit re-add of %s across an older removal', (catalogId) => {
    rememberDismissedLayer({ catalogId })
    const removed = loadDismissedLayers()
    const store = useLayersStore()
    store.addLayer(catalogId, false, undefined, { skipAutoRun: true })
    const restored = loadDismissedLayers()
    expect(restored.catalogIds).not.toContain(catalogId)
    expect(restored.operations?.['catalogIds:' + catalogId]?.removed).toBe(false)
    expect(mergeWorkspaceDismissals(removed, restored).catalogIds).not.toContain(catalogId)
    expect(buildWorkspaceSnapshot(store.activeLayers, []).catalogLayers?.map(l => l.catalogId)).toContain(catalogId)

    store.removeLayer(store.activeLayers[0]!.instanceId)
    expect(loadDismissedLayers().catalogIds).toContain(catalogId)
    expect(buildWorkspaceSnapshot(store.activeLayers, []).catalogLayers).toEqual([])
  })

  it('does not treat workflow restoration as an explicit re-add', () => {
    rememberDismissedLayer({ catalogId: 'aridity-cn' })
    const store = useLayersStore()
    store.addLayer('aridity-cn', false, { jobId: 'finished-run', status: 'succeeded' } as never)
    expect(loadDismissedLayers().catalogIds).toContain('aridity-cn')
  })
})