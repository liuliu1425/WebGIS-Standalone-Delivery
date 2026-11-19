// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useOnDemandFrameStore } from '@/stores/layers/ondemand-frame'
import { useOnDemandFrame } from '@/views/dashboard/useOnDemandFrame'

const fetchFrame = vi.hoisted(() => vi.fn())
vi.mock('@/services/nas-ondemand', () => ({
  ensureNasLayerFrame: fetchFrame, fetchNasOndemandLayers: vi.fn(),
}))

describe('real frame loader commit guards (simulated network)', () => {
  const apps: ReturnType<typeof createApp>[] = []
  beforeEach(() => { setActivePinia(createPinia()); fetchFrame.mockReset() })
  afterEach(() => { apps.splice(0).forEach(app => app.unmount()) })
  function setup() {
    const store = useOnDemandFrameStore()
    store.loaded = true
    store.specs = { 'imported-x': { product: 'fy', variable: 'SM' } } as typeof store.specs
    store.coverage = { start: '20250101', end: '20251231' }
    let loader!: ReturnType<typeof useOnDemandFrame>
    const ready = vi.fn()
    const app = createApp({ setup() {
      loader = useOnDemandFrame({ selectedCatalogId: computed(() => 'imported-x'),
        visibleOnDemandIds: computed(() => ['imported-x']), currentDate: ref(new Date(2025, 6, 10)),
        isPlaying: ref(false), onFrameReady: ready, logOperation: vi.fn() })
      return () => null
    } })
    app.mount(document.createElement('div')); apps.push(app)
    return { store, loader, ready }
  }

  it('ignores a late frame after cancellation even if the transport cannot abort', async () => {
    const { store, loader, ready } = setup()
    store.setDayTag('imported-x', '20250709')
    let finish!: (value: unknown) => void
    fetchFrame.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = loader.ensureFrameForLayer('imported-x', new Date(2025, 6, 10), controller.signal)
    controller.abort()
    finish({ time_key: '20250710', cached: true })
    expect((await pending).ok).toBe(false)
    expect(store.dayTagFor('imported-x')).toBe('20250709')
    expect(ready).not.toHaveBeenCalled()
    expect(store.pendingTag['imported-x']).toBeUndefined()
  })

  it('keeps the newer date when an older frame arrives last', async () => {
    const { store, loader } = setup()
    let oldFinish!: (value: unknown) => void
    fetchFrame.mockReturnValueOnce(new Promise(resolve => { oldFinish = resolve }))
    const oldRequest = loader.ensureFrameForLayer('imported-x', new Date(2025, 6, 10))
    fetchFrame.mockResolvedValueOnce({ time_key: '20250725', cached: true })
    expect((await loader.ensureFrameForLayer('imported-x', new Date(2025, 6, 25))).ok).toBe(true)
    oldFinish({ time_key: '20250710', cached: true })
    expect((await oldRequest).ok).toBe(false)
    expect(store.dayTagFor('imported-x')).toBe('20250725')
  })

  it('a return to the cached date also invalidates an outstanding older request', async () => {
    const { store, loader } = setup()
    store.setDayTag('imported-x', '20250709')
    let finish!: (value: unknown) => void
    fetchFrame.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = loader.ensureFrameForLayer('imported-x', new Date(2025, 6, 10))
    expect((await loader.ensureFrameForLayer('imported-x', new Date(2025, 6, 9))).cached).toBe(true)
    finish({ time_key: '20250710' })
    expect((await pending).ok).toBe(false)
    expect(store.dayTagFor('imported-x')).toBe('20250709')
  })
})
