import { computed, effectScope, nextTick, ref, toRef, type EffectScope } from 'vue'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useOnDemandFrameStore, toCompactDate } from '@/stores/layers/ondemand-frame'
import { executeAgentUiIntent } from '@/components/agent/agent-ui-intent'
import { useTimelineSync } from '@/views/dashboard/useTimelineSync'
import type { ActiveLayer } from '@/stores/layers/types'

const SM = 'imported-55359b8ecd3d'
const VOD = 'imported-a94205dad5f9'
const layers = ref<ActiveLayer[]>([])
const selected = ref<string | null>(null)
const library = ref([{ catalogId: SM, supportsTime: true }, { catalogId: VOD, supportsTime: true }])
const selectLayer = vi.fn((id: string) => { selected.value = id })
const toggleVisibility = vi.fn()
const jobLayers = ref([])
const groups = ref([])
const descriptor = () => ({ supports_time: true, time_granularity: 'day' })

vi.mock('@/stores/layers/selectors', () => ({
  useLayerWorkspace: () => ({
    activeLayers: layers, selectedInstanceId: selected, layerLibrary: library,
    activeLayersDisplay: computed(() => layers.value), selectLayer,
    toggleLayerVisibility: toggleVisibility, setSidebarView: vi.fn(),
    resolveEffectiveDescriptor: descriptor, isWeatherEngineLayer: () => false,
    getOnlineTemporalConfig: () => null, setCurrentHour: vi.fn(),
  }),
  useLayerViewport: () => ({ currentMapCenter: ref({ lng: 0, lat: 0 }), currentMapZoom: ref(2) }),
  useWorkflowRun: () => ({ jobLayers, runLayerGroups: groups }),
}))

let scope: EffectScope
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  scope = effectScope()
})
afterEach(() => scope.stop())

describe('Agent target dates with the real UI memory and timeline selection watcher', () => {
  it.each([true, false])('restores the newest VOD request after a noncurrent update, visible=%s', async visible => {
    layers.value = [
      { instanceId: 'sm-instance', catalogId: SM, name: '风云平均SM', visible: true, opacity: 1, order: 1,
        dataState: 'imported', importedRaster: { overlayLayerId: SM, nativeStep: '1M', timeList: ['20250701_20250731'] } },
      { instanceId: 'vod-instance', catalogId: VOD, name: '风云平均VOD', visible, opacity: 1, order: 2,
        dataState: 'imported', importedRaster: { overlayLayerId: VOD, nativeStep: '1M', timeList: ['20250701_20250731', '20250720'] } },
    ] as ActiveLayer[]
    selected.value = 'vod-instance'
    const ui = useUiStore()
    ui.setLayerTimeMemoryAt(SM, new Date(2025, 6, 31), 0)
    ui.setLayerTimeMemoryAt(VOD, new Date(2025, 6, 20), 0)
    ui.applyDateHour(new Date(2025, 6, 20), 0)
    // This is the still-live protection left by the preceding selected VOD date command.
    ui.pinTimelineAt(VOD, new Date(2025, 6, 20), 0)
    const frames = useOnDemandFrameStore()
    frames.loaded = true
    frames.specs = { [VOD]: { layer_id: VOD } } as typeof frames.specs
    frames.setDayTag(VOD, '20250720')
    const selectedLayer = computed(() => layers.value.find(l => l.instanceId === selected.value) ?? null)
    const map = { setOverlayTime: vi.fn() }
    scope.run(() => useTimelineSync(
      ui, { logOperation: vi.fn() } as never, { getLayerStatus: vi.fn(() => null) } as never,
      ref(null), ref(map) as never, selectedLayer, computed(() => selectedLayer.value ?? {}),
      ref([]), toRef(ui, 'currentHour'), toRef(ui, 'currentDate'), toRef(ui, 'unifiedTimeLock'),
      toRef(ui, 'isPlaying'), ref(0), ref(0), ref(null), ref(null),
    ))
    await nextTick()
    const toSm = await executeAgentUiIntent({
      name: 'select_layer', args: { catalog_id: SM, instance_id: 'sm-instance' },
    })
    expect(toSm.ok).toBe(true)
    expect(selected.value).toBe('sm-instance')
    expect(ui.currentDate.getDate()).toBe(31)

    const ensureFrame = vi.fn(async (id: string, date: Date) => {
      const applied = toCompactDate(date)
      frames.setDayTag(id, applied)
      return { ok: true, applied, cached: false }
    })
    const changed = await executeAgentUiIntent({
      name: 'set_timeline', args: { catalog_id: VOD, instance_id: 'vod-instance', date: '2025-07-22' },
    }, { ensureOnDemandFrame: ensureFrame })
    expect(changed.ok).toBe(true)
    expect(ensureFrame).toHaveBeenCalledOnce()
    expect(selected.value).toBe('sm-instance')
    expect(ui.currentDate.getDate()).toBe(31)
    expect(ui.layerTimeMemory[VOD]).toEqual({ dateKey: '2025-07-22', hour: 0 })
    expect(frames.dayTagFor(VOD)).toBe('20250722')

    const toVod = await executeAgentUiIntent({
      name: 'select_layer', args: { catalog_id: VOD, instance_id: 'vod-instance' },
    })
    expect(toVod.ok).toBe(true)
    expect(selected.value).toBe('vod-instance')
    expect(ui.currentDate.getDate()).toBe(22)
    expect(ui.layerTimeMemory[VOD]).toEqual({ dateKey: '2025-07-22', hour: 0 })
    expect(ui.layerTimeMemory[SM]).toEqual({ dateKey: '2025-07-31', hour: 0 })
    expect(frames.dayTagFor(VOD)).toBe('20250722')
    expect(layers.value.map(layer => layer.visible)).toEqual([true, visible])
    expect(toggleVisibility).not.toHaveBeenCalled()
    expect(toVod.message).not.toContain('2025-07-22')
    expect(toVod.message).not.toContain('时间轴')
    expect(ensureFrame).toHaveBeenCalledOnce()
  })
  it('showing a hidden product restores its own date without resetting memories or narrating a date change', async () => {
    layers.value = [
      { instanceId: 'sm-instance', catalogId: SM, name: '风云平均SM', visible: true, opacity: 1, order: 1,
        dataState: 'imported', importedRaster: { overlayLayerId: SM, nativeStep: '1M', timeList: ['20250701_20250731'] } },
      { instanceId: 'vod-instance', catalogId: VOD, name: '风云平均VOD', visible: false, opacity: 1, order: 2,
        dataState: 'imported', importedRaster: { overlayLayerId: VOD, nativeStep: '1M', timeList: ['20250701_20250731', '20250720'] } },
    ] as ActiveLayer[]
    selected.value = 'sm-instance'
    const ui = useUiStore()
    ui.setLayerTimeMemoryAt(SM, new Date(2025, 6, 31), 0)
    ui.setLayerTimeMemoryAt(VOD, new Date(2025, 6, 20), 0)
    ui.applyDateHour(new Date(2025, 6, 31), 0)
    const frames = useOnDemandFrameStore()
    frames.loaded = true
    frames.specs = { [VOD]: { layer_id: VOD } } as typeof frames.specs
    frames.setDayTag(VOD, '20250720')
    const selectedLayer = computed(() => layers.value.find(l => l.instanceId === selected.value) ?? null)
    const map = { setOverlayTime: vi.fn() }
    scope.run(() => useTimelineSync(
      ui, { logOperation: vi.fn() } as never, { getLayerStatus: vi.fn(() => null) } as never,
      ref(null), ref(map) as never, selectedLayer, computed(() => selectedLayer.value ?? {}),
      ref([]), toRef(ui, 'currentHour'), toRef(ui, 'currentDate'), toRef(ui, 'unifiedTimeLock'),
      toRef(ui, 'isPlaying'), ref(0), ref(0), ref(null), ref(null),
    ))
    await nextTick()
    const memoryBefore = JSON.stringify(ui.layerTimeMemory)
    toggleVisibility.mockImplementation((id: string) => {
      const layer = layers.value.find(item => item.instanceId === id)
      if (layer) layer.visible = !layer.visible
    })
    const ensureFrame = vi.fn()
    const result = await executeAgentUiIntent({
      name: 'set_layer_visibility', args: { catalog_id: VOD, instance_id: 'vod-instance', visible: true },
    }, { ensureOnDemandFrame: ensureFrame })
    expect(result.ok).toBe(true)
    expect(selected.value).toBe('vod-instance')
    expect(layers.value.map(layer => layer.visible)).toEqual([true, true])
    expect(ui.currentDate.getDate()).toBe(20)
    expect(JSON.stringify(ui.layerTimeMemory)).toBe(memoryBefore)
    expect(result.message).not.toContain('时间轴')
    expect(result.message).not.toContain('2025-07-20')
    expect(ensureFrame).not.toHaveBeenCalled()
  })

})
