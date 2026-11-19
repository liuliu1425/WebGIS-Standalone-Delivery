import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createActiveLayersSlice, type ActiveLayersSliceDeps } from '@/stores/layers/active-layers'

const weather = vi.hoisted(() => ({ setLayerActive: vi.fn(), setViewport: vi.fn() }))
vi.mock('@/stores/weather-tile-manager', () => ({ useWeatherTileManager: () => weather }))

function makeSlice(isWeather = false) {
  const runWorkflowForCatalog = vi.fn(async () => {})
  const deps = {
    getLayerLibraryMap: () => new Map(), getRuntimeLayerCatalog: () => ({}),
    getRunLayerGroups: () => [], setRunLayerGroups: vi.fn(), getJobLayers: () => [],
    isWeatherEngineLayer: () => isWeather, supportsParticleFlow: () => false,
    weatherProviderArg: () => 'test', getMapCenter: () => ({ lng: 116, lat: 39 }),
    getMapZoom: () => 4, getMapBBox: () => null, getCurrentHour: () => 6,
    scheduleWorkspacePersist: vi.fn(), canRunCatalog: () => true, runWorkflowForCatalog,
  } as unknown as ActiveLayersSliceDeps
  return { ...createActiveLayersSlice(deps), runWorkflowForCatalog }
}

describe('shared add options used by Agent', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it.each([true, false])('hidden list-only add does not start weather=%s work or change focus', async isWeather => {
    const slice = makeSlice(isWeather)
    slice.selectedInstanceId.value = 'previous'
    slice.addLayer('test-sm', false, undefined, { visible: false, select: false, skipAutoRun: true })
    await vi.runAllTimersAsync()
    expect(slice.activeLayers.value).toHaveLength(1)
    expect(slice.activeLayers.value[0]!.visible).toBe(false)
    expect(slice.selectedInstanceId.value).toBe('previous')
    expect(weather.setLayerActive).not.toHaveBeenCalled()
    expect(weather.setViewport).not.toHaveBeenCalled()
    expect(slice.runWorkflowForCatalog).not.toHaveBeenCalled()
  })

  it('attaches a background imported raster with metadata without selecting or flashing it visible', () => {
    const slice = makeSlice(false)
    slice.selectedInstanceId.value = 'previous'
    const layer = slice.addImportedRasterLayer('VOD', 'overlay-vod', [-180, -90, 180, 90], {
      visible: false, select: false, timeList: ['20250701_20250731'], defaultTime: '20250701_20250731',
    })
    expect(layer.visible).toBe(false)
    expect(slice.selectedInstanceId.value).toBe('previous')
    expect(layer.importedRaster?.timeList).toEqual(['20250701_20250731'])
    expect(layer.importedRaster?.bounds).toEqual([-180, -90, 180, 90])
    expect(slice.runWorkflowForCatalog).not.toHaveBeenCalled()
  })

  it('retains the original visible and selected defaults for manual raster import', () => {
    const slice = makeSlice(false)
    const layer = slice.addImportedRasterLayer('SM', 'overlay-sm')
    expect(layer.visible).toBe(true)
    expect(slice.selectedInstanceId.value).toBe(layer.instanceId)
  })

  it('keeps the original default add behavior for manual weather actions', async () => {
    const slice = makeSlice(true)
    slice.addLayer('test-wind')
    await vi.runAllTimersAsync()
    expect(slice.activeLayers.value[0]!.visible).toBe(true)
    expect(slice.selectedInstanceId.value).toBe(slice.activeLayers.value[0]!.instanceId)
    expect(weather.setLayerActive).toHaveBeenCalledWith('test-wind', true)
    expect(weather.setViewport).toHaveBeenCalledTimes(1)
  })

  it('keeps the original automatic workflow for a normal visible add', async () => {
    const slice = makeSlice(false)
    slice.addLayer('test-sm')
    await vi.runAllTimersAsync()
    expect(slice.runWorkflowForCatalog).toHaveBeenCalledOnce()
    expect(slice.runWorkflowForCatalog).toHaveBeenCalledWith('test-sm')
  })
})
