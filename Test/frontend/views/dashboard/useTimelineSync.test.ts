/**
 * W3.4c/W3.6：useTimelineSync 组合式函数测试。
 *
 * 重点覆盖工作流进度 seek 消费路径（W3.6 P-02）：
 *  - workflowProgressTimeSeek watch → seekTimelineToWorkflowProgressTimeKey
 *  - 同组放行 / 异组忽略 / 锁与播放互斥
 *  - 运行启动 start_at 对齐、切层记忆恢复、渐进 time_list 跟随
 *  - refreshImportedRasterEffectiveTimes、timelineSegments 基础形态
 */
import { computed, effectScope, nextTick, reactive, ref, type ComputedRef, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTimelineSync } from '@/views/dashboard/useTimelineSync'
import type {
  ActiveLayer,
  ActiveRunLayerGroup,
  JobLayerItem,
} from '@/stores/layers/types'
import type { OverlayTimeState } from '@/components/map/overlay-image-module'
import type { WorkflowProgressTimeSeekHint } from '@/utils/workflow-timekey-seek'

// ── Mock selectors（闭包在调用期读取模块级引用，规避 vi.mock 提升问题）─────────

let mockActiveLayers: Ref<ActiveLayer[]>
let mockJobLayers: Ref<JobLayerItem[]>
let mockRunGroups: Ref<ActiveRunLayerGroup[]>

const workspaceCalls = {
  setCurrentHour: vi.fn(),
  isWeatherEngineLayer: vi.fn((_catalogId: string) => false),
  resolveEffectiveDescriptor: vi.fn(() => null),
  getOnlineTemporalConfig: vi.fn(() => null),
}

vi.mock('@/stores/layers/selectors', () => ({
  useLayerWorkspace: () => ({
    get activeLayers() {
      return mockActiveLayers
    },
    setCurrentHour: workspaceCalls.setCurrentHour,
    isWeatherEngineLayer: workspaceCalls.isWeatherEngineLayer,
    resolveEffectiveDescriptor: workspaceCalls.resolveEffectiveDescriptor,
    getOnlineTemporalConfig: workspaceCalls.getOnlineTemporalConfig,
  }),
  useWorkflowRun: () => ({
    get jobLayers() {
      return mockJobLayers
    },
    get runLayerGroups() {
      return mockRunGroups
    },
  }),
}))

// ── Harness ───────────────────────────────────────────────────────────────────

interface SyncHarness {
  uiStore: {
    applyDateHour: ReturnType<typeof vi.fn>
    applyTimelineFromLayerGranularity: ReturnType<typeof vi.fn>
    rememberLayerTime: ReturnType<typeof vi.fn>
    restoreLayerTime: ReturnType<typeof vi.fn>
    isLayerTimeLocked: ReturnType<typeof vi.fn>
    /** 2026-11-07：显式指定时刻的「钉子」，保护窗内禁止自动跳帧（默认无钉子） */
    isTimelinePinned: ReturnType<typeof vi.fn>
    setLayerTimeMemoryAt: ReturnType<typeof vi.fn>
    setUnifiedTimeLock: ReturnType<typeof vi.fn>
    layerTimeMemory: Record<string, { dateKey: string; hour: number }>
    analysisFocusRequest: { kind: string } | null
  }
  logOperation: ReturnType<typeof vi.fn>
  getLayerStatus: ReturnType<typeof vi.fn>
  setOverlayTime: ReturnType<typeof vi.fn>
  showPanel: ReturnType<typeof vi.fn>
  weatherCoverage: Ref<null>
  selectedLayerDisplay: Ref<{ catalogId?: string; instanceId?: string } | null>
  overlayTimeStates: Ref<OverlayTimeState[]>
  currentHour: Ref<number>
  currentDate: Ref<Date>
  unifiedTimeLock: Ref<boolean>
  isPlaying: Ref<boolean>
  weatherStatusVersion: Ref<number>
  weatherActivityVersion: Ref<number>
  workflowProgressTimeSeek: Ref<WorkflowProgressTimeSeekHint | null>
  sync: ReturnType<typeof useTimelineSync>
  activeLayer: ComputedRef<{
    catalogId?: string
    name?: string
    availabilityLabel?: string
    observationTimeLabel?: string
    runReadiness?: unknown
  }>
}

const syncScopes: ReturnType<typeof effectScope>[] = []
afterEach(() => { for (const scope of syncScopes.splice(0)) scope.stop() })

let idSeq = 0

function makeLayer(overrides: Partial<ActiveLayer> = {}): ActiveLayer {
  idSeq += 1
  return {
    instanceId: `inst-${idSeq}`,
    catalogId: `cat-${idSeq}`,
    name: `Layer ${idSeq}`,
    visible: true,
    opacity: 1,
    order: idSeq,
    isAdminBoundary: false,
    dataState: 'catalog',
    ...overrides,
  }
}

function setupSync(initial: { layers?: ActiveLayer[]; selectedCatalogId?: string } = {}): SyncHarness {
  mockActiveLayers = ref(initial.layers ?? [])
  mockJobLayers = ref<JobLayerItem[]>([])
  mockRunGroups = ref<ActiveRunLayerGroup[]>([])

  const uiStore = reactive({
    applyDateHour: vi.fn(),
    applyTimelineFromLayerGranularity: vi.fn(),
    rememberLayerTime: vi.fn(),
    restoreLayerTime: vi.fn((): { date: Date; hour: number } | null => null),
    isLayerTimeLocked: vi.fn(() => false),
    isTimelinePinned: vi.fn(() => false),
    setLayerTimeMemoryAt: vi.fn((catalogId: string, date: Date, hour: number) => {
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      uiStore.layerTimeMemory = { ...uiStore.layerTimeMemory, [catalogId]: { dateKey, hour } }
    }),
    setUnifiedTimeLock: vi.fn((on: boolean) => { unifiedTimeLock.value = on }),
    layerTimeMemory: {} as Record<string, { dateKey: string; hour: number }>,
    analysisFocusRequest: ref<{ kind: string } | null>(null),
  })
  const logOperation = vi.fn()
  const logStore = { logOperation }
  const getLayerStatus = vi.fn(() => null)
  const weatherTileManager = { getLayerStatus }
  const weatherCoverage = ref(null)
  const setOverlayTime = vi.fn()
  const mapCanvasRef = ref({ setOverlayTime } as unknown as {
    setOverlayTime: (id: string, label: string) => void
  })
  const showPanel = vi.fn()
  const analysisPanelRef = ref({ showPanel } as unknown as { showPanel: () => void })
  const selectedLayerDisplay = ref<{ catalogId?: string; instanceId?: string } | null>(
    initial.selectedCatalogId ? { catalogId: initial.selectedCatalogId } : null,
  )
  const activeLayer = computed(() => {
    const catalogId = selectedLayerDisplay.value?.catalogId
    const layer = mockActiveLayers.value.find((l) => l.catalogId === catalogId)
    return {
      catalogId: layer?.catalogId,
      name: layer?.name,
      availabilityLabel: undefined,
      observationTimeLabel: undefined,
      runReadiness: undefined,
    }
  })
  const overlayTimeStates = ref<OverlayTimeState[]>([])
  const currentHour = ref(12)
  const currentDate = ref(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)))
  const unifiedTimeLock = ref(false)
  const isPlaying = ref(false)
  const weatherStatusVersion = ref(0)
  const weatherActivityVersion = ref(0)
  const workflowProgressTimeSeek = ref<WorkflowProgressTimeSeekHint | null>(null)

  const scope = effectScope()
  syncScopes.push(scope)
  const sync = scope.run(() => useTimelineSync(
    uiStore as unknown as Parameters<typeof useTimelineSync>[0],
    logStore as unknown as Parameters<typeof useTimelineSync>[1],
    weatherTileManager as unknown as Parameters<typeof useTimelineSync>[2],
    weatherCoverage,
    mapCanvasRef as unknown as Parameters<typeof useTimelineSync>[4],
    selectedLayerDisplay,
    activeLayer,
    overlayTimeStates,
    currentHour,
    currentDate,
    unifiedTimeLock,
    isPlaying,
    weatherStatusVersion,
    weatherActivityVersion,
    workflowProgressTimeSeek,
    analysisPanelRef as unknown as Parameters<typeof useTimelineSync>[15],
  ))!

  return {
    uiStore,
    logOperation,
    getLayerStatus,
    setOverlayTime,
    showPanel,
    weatherCoverage,
    selectedLayerDisplay,
    overlayTimeStates,
    currentHour,
    currentDate,
    unifiedTimeLock,
    isPlaying,
    weatherStatusVersion,
    weatherActivityVersion,
    workflowProgressTimeSeek,
    activeLayer,
    sync,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  workspaceCalls.isWeatherEngineLayer.mockReturnValue(false)
  workspaceCalls.resolveEffectiveDescriptor.mockReturnValue(null)
  workspaceCalls.getOnlineTemporalConfig.mockReturnValue(null)
})

// ── 基础 computed ─────────────────────────────────────────────────────────────

describe('基础 computed', () => {
  it('未选图层时空闲标签', () => {
    const h = setupSync()
    expect(h.sync.hasTimelineLayer.value).toBe(false)
    expect(h.sync.selectedCatalogId.value).toBeNull()
    expect(h.sync.timelineLayerName.value).toBe('未选择图层')
    expect(h.sync.timelineAvailabilityLabel.value).toBe('空闲')
    expect(h.sync.timelineObservationLabel.value).toBe('—')
  })

  it('选中图层后展示层名与占位标签', () => {
    const layer = makeLayer({ catalogId: 'cat-a', name: '土壤水分' })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-a' })
    expect(h.sync.hasTimelineLayer.value).toBe(true)
    expect(h.sync.timelineLayerName.value).toBe('土壤水分')
    expect(h.sync.timelineAvailabilityLabel.value).toBe('—')
  })

  it('tileForecastHour 立即同步 currentHour 到 workspace', () => {
    setupSync()
    expect(workspaceCalls.setCurrentHour).toHaveBeenCalled()
  })

  it('isLayerLocked 委托 uiStore', () => {
    const layer = makeLayer({ catalogId: 'cat-a' })
    const unlocked = setupSync({ layers: [layer], selectedCatalogId: 'cat-a' })
    expect(unlocked.sync.isLayerLocked.value).toBe(false)
    const locked = setupSync({ layers: [layer], selectedCatalogId: 'cat-a' })
    locked.uiStore.isLayerTimeLocked.mockReturnValue(true)
    expect(locked.sync.isLayerLocked.value).toBe(true)
  })
})

// ── 工作流进度 seek（W3.6 核心）────────────────────────────────────────────────

describe('workflowProgressTimeSeek 消费', () => {
  function makeScienceLayer(catalogId: string, runGroupId?: string): ActiveLayer {
    return makeLayer({
      catalogId,
      runGroupId,
      dataState: 'imported',
      importedRaster: {
        overlayLayerId: `ov-${catalogId}`,
        nativeStep: '8d',
        timeList: ['20240425_20240502', '20240501_20240508'],
      },
    })
  }

  it('hint 命中选中图层：播放中对齐日期/粒度并 seek overlay 时间', async () => {
    const layer = makeScienceLayer('cat-run')
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    h.isPlaying.value = true
    h.workflowProgressTimeSeek.value = {
      runId: 'run-0001-aaaa',
      catalogId: 'cat-run',
      timeKey: '20240501',
      sliceLabel: '20240501_20240508',
      at: new Date().toISOString(),
    }
    await nextTick()
    expect(h.uiStore.applyDateHour).toHaveBeenCalledTimes(1)
    const [seekDate, hour] = h.uiStore.applyDateHour.mock.calls[0] as [Date, number]
    expect(seekDate.getFullYear()).toBe(2024)
    expect(seekDate.getMonth()).toBe(4)
    expect(seekDate.getDate()).toBe(1)
    expect(hour).toBe(0)
    expect(h.uiStore.applyTimelineFromLayerGranularity).toHaveBeenCalledWith('day')
    expect(h.uiStore.rememberLayerTime).toHaveBeenCalledWith('cat-run')
    expect(h.setOverlayTime).toHaveBeenCalledWith('ov-cat-run', '20240501_20240508')
    expect(h.logOperation).toHaveBeenCalledWith(
      'timeline-seek-workflow',
      expect.stringContaining('工作流块 run-0001'),
    )
  })

  it('未播放时忽略 workflow seek（不抢用户选定时刻）', async () => {
    const layer = makeScienceLayer('cat-run')
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    h.isPlaying.value = false
    h.workflowProgressTimeSeek.value = {
      runId: 'run-0001',
      catalogId: 'cat-run',
      timeKey: '20240501',
      sliceLabel: '20240501_20240508',
      at: new Date().toISOString(),
    }
    await nextTick()
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
    expect(h.setOverlayTime).not.toHaveBeenCalled()
  })

  it('sliceLabel 未命中 time_list 时回退原标签', async () => {
    const layer = makeScienceLayer('cat-run')
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    h.isPlaying.value = true
    h.workflowProgressTimeSeek.value = {
      runId: 'run-0001',
      catalogId: 'cat-run',
      timeKey: '20240510',
      sliceLabel: '20240510',
      at: new Date().toISOString(),
    }
    await nextTick()
    expect(h.setOverlayTime).toHaveBeenCalledWith('ov-cat-run', '20240510')
  })

  it('hint 属其它 catalog 且不同运行组时忽略', async () => {
    const selected = makeScienceLayer('cat-a')
    const other = makeScienceLayer('cat-b')
    const h = setupSync({ layers: [selected, other], selectedCatalogId: 'cat-a' })
    h.workflowProgressTimeSeek.value = {
      runId: 'run-1',
      catalogId: 'cat-b',
      timeKey: '20240501',
      sliceLabel: '20240501',
      at: new Date().toISOString(),
    }
    await nextTick()
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
    expect(h.setOverlayTime).not.toHaveBeenCalled()
  })

  it('hint 属同运行组其它成员时放行并对组内 overlay seek', async () => {
    const sm = makeScienceLayer('cat-sm', 'g1')
    const vod = makeScienceLayer('cat-vod', 'g1')
    const h = setupSync({ layers: [sm, vod], selectedCatalogId: 'cat-vod' })
    h.isPlaying.value = true
    h.workflowProgressTimeSeek.value = {
      runId: 'run-1',
      catalogId: 'cat-sm',
      timeKey: '20240501',
      sliceLabel: '20240501_20240508',
      at: new Date().toISOString(),
    }
    await nextTick()
    expect(h.uiStore.applyDateHour).toHaveBeenCalledTimes(1)
    // members = 同组且有 overlay 的成员；选中成员 cat-vod 也在组内
    expect(h.setOverlayTime).toHaveBeenCalledWith('ov-cat-vod', '20240501_20240508')
  })

  it('统一时间锁 / 图层时间锁定时忽略（播放中才跟随）', async () => {
    const layer = makeScienceLayer('cat-run')
    const hint: WorkflowProgressTimeSeekHint = {
      runId: 'run-1',
      catalogId: 'cat-run',
      timeKey: '20240501',
      sliceLabel: '20240501',
      at: new Date().toISOString(),
    }

    const lockAll = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    lockAll.isPlaying.value = true
    lockAll.unifiedTimeLock.value = true
    lockAll.workflowProgressTimeSeek.value = hint
    await nextTick()
    expect(lockAll.uiStore.applyDateHour).not.toHaveBeenCalled()

    const layerLocked = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    layerLocked.isPlaying.value = true
    layerLocked.uiStore.isLayerTimeLocked.mockReturnValue(true)
    layerLocked.workflowProgressTimeSeek.value = hint
    await nextTick()
    expect(layerLocked.uiStore.applyDateHour).not.toHaveBeenCalled()
  })

  it('非法 timeKey 不产生 seek', async () => {
    const layer = makeScienceLayer('cat-run')
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    h.workflowProgressTimeSeek.value = {
      runId: 'run-1',
      catalogId: 'cat-run',
      timeKey: 'garbage',
      sliceLabel: 'garbage',
      at: new Date().toISOString(),
    }
    await nextTick()
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
  })
})

// ── 运行启动对齐 / 切层记忆 ───────────────────────────────────────────────────

describe('运行启动与切层记忆', () => {
  it('未播放时 job expectedTimeRange 不抢轴', async () => {
    const layer = makeLayer({ catalogId: 'cat-run', jobLayer: undefined })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    h.isPlaying.value = false
    mockJobLayers.value = [
      {
        jobId: 'run-1',
        name: 'T',
        commandType: 'analysis',
        status: 'running',
        progress: 0,
        createdAt: '',
        updatedAt: '',
        message: '',
        catalogId: 'cat-run',
        expectedTimeRange: { start_at: '20240425', end_at: '20240530' },
      },
    ]
    await nextTick()
    await nextTick()
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
  })

  it('播放中 job 带 expectedTimeRange 时轴对齐 start_at', async () => {
    const layer = makeLayer({ catalogId: 'cat-run', jobLayer: undefined })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-run' })
    h.isPlaying.value = true
    mockJobLayers.value = [
      {
        jobId: 'run-1',
        name: 'T',
        commandType: 'analysis',
        status: 'running',
        progress: 0,
        createdAt: '',
        updatedAt: '',
        message: '',
        catalogId: 'cat-run',
        expectedTimeRange: { start_at: '20240425', end_at: '20240530' },
      },
    ]
    await nextTick()
    await nextTick()
    expect(h.uiStore.applyDateHour).toHaveBeenCalledTimes(1)
    const [alignDate, hour] = h.uiStore.applyDateHour.mock.calls[0] as [Date, number]
    expect(alignDate.getDate()).toBe(25)
    expect(alignDate.getMonth()).toBe(3)
    expect(hour).toBe(0)
  })

  it('未播放时工作流 runGroup 产物加层不 snap', async () => {
    const seed = makeLayer({ catalogId: 'seed' })
    const h = setupSync({ layers: [seed], selectedCatalogId: 'seed' })
    h.isPlaying.value = false
    await nextTick()
    h.uiStore.applyDateHour.mockClear()

    mockActiveLayers.value = [
      seed,
      makeLayer({
        catalogId: 'cat-wf',
        runGroupId: 'rg-1',
        dataState: 'imported',
        importedRaster: {
          overlayLayerId: 'ov-wf',
          nativeStep: '8d',
          timeList: ['20240425_20240502', '20240501_20240508'],
        },
      }),
    ]
    await nextTick()
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
  })

  it('切层时按图层形态切换粒度并恢复记忆时刻', async () => {
    const science = makeLayer({
      catalogId: 'cat-science',
      dataState: 'imported',
      importedRaster: {
        overlayLayerId: 'ov-1',
        nativeStep: '8d',
        timeList: ['20240425_20240502', '20240501_20240508'],
      },
    })
    const h = setupSync({ layers: [science] })
    h.selectedLayerDisplay.value = { catalogId: 'cat-science' }
    await nextTick()
    expect(h.uiStore.applyTimelineFromLayerGranularity).toHaveBeenCalledWith('day')
    // restoreLayerTime 返回 null 且存在科学切片 → snap 到最新切片
    expect(h.uiStore.applyDateHour).toHaveBeenCalled()
  })

  it('记忆时刻可恢复时仅记录日志不强制 snap', async () => {
    const science = makeLayer({
      catalogId: 'cat-science',
      dataState: 'imported',
      importedRaster: {
        overlayLayerId: 'ov-1',
        nativeStep: '8d',
        timeList: ['20260425_20260502'],
      },
    })
    const h = setupSync({ layers: [science] })
    h.uiStore.restoreLayerTime.mockReturnValue({ date: new Date(), hour: 6 })
    h.selectedLayerDisplay.value = { catalogId: 'cat-science' }
    await nextTick()
    expect(h.logOperation).toHaveBeenCalledWith(
      'timeline-restore-layer',
      expect.stringContaining('cat-science'),
    )
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
  })

  it('普通目录图层无 spec 时回落小时粒度', async () => {
    const plain = makeLayer({ catalogId: 'cat-plain' })
    const h = setupSync({ layers: [plain] })
    h.selectedLayerDisplay.value = { catalogId: 'cat-plain' }
    await nextTick()
    expect(h.uiStore.applyTimelineFromLayerGranularity).toHaveBeenCalledWith('hour')
  })

  /**
   * 2026-11-07 组合指令：切层 + 切日期 + 统计。
   * 新加图层的 timeList 晚到会触发「跳最新帧」，把助手刚设的 12-16 顶成该层默认帧
   * （20250701_20250731 → 界面显示 7 月 31 日）。钉子有效期内必须不 snap。
   */
  it('该层被显式指定过时刻（钉子有效）：切层不跳最新帧', async () => {
    const science = makeLayer({
      catalogId: 'cat-science',
      dataState: 'imported',
      importedRaster: {
        overlayLayerId: 'ov-1',
        nativeStep: '8d',
        timeList: ['20250701_20250731', '20251211_20251218'],
      },
    })
    const h = setupSync({ layers: [science] })
    h.uiStore.isTimelinePinned.mockReturnValue(true)
    h.uiStore.restoreLayerTime.mockReturnValue(null)
    h.selectedLayerDisplay.value = { catalogId: 'cat-science' }
    await nextTick()
    // 仍然切粒度，但不许把时间轴拽到该层最新/默认帧
    expect(h.uiStore.applyTimelineFromLayerGranularity).toHaveBeenCalledWith('day')
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
    expect(h.logOperation).not.toHaveBeenCalledWith(
      'timeline-snap-latest',
      expect.anything(),
    )
  })
})

// ── refreshImportedRasterEffectiveTimes ───────────────────────────────────────

describe('refreshImportedRasterEffectiveTimes', () => {
  it('从 overlay time-series 状态补全 timeList 与 nativeStep 并下发时间', () => {
    const layer = makeLayer({
      catalogId: 'cat-1',
      dataState: 'imported',
      importedRaster: { overlayLayerId: 'ov-9', nativeStep: null },
    })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-1' })
    h.overlayTimeStates.value = [
      {
        layerId: 'ov-9',
        category: 'time-series',
        timeList: ['20240425_20240502'],
        currentTime: null,
        palette: 'viridis',
        unit: '',
        vmin: null,
        vmax: null,
        opacity: 1,
        bounds: null,
      },
    ]
    h.sync.refreshImportedRasterEffectiveTimes()
    expect(layer.importedRaster!.timeList).toEqual(['20240425_20240502'])
    expect(layer.importedRaster!.nativeStep).toBe('8d')
    expect(layer.importedRaster!.effectiveTimeLabel).toBeTruthy()
    expect(h.setOverlayTime).toHaveBeenCalledWith('ov-9', expect.any(String))
  })

  it('无切片可解析时不下发 overlay 时间', () => {
    const layer = makeLayer({
      catalogId: 'cat-1',
      dataState: 'imported',
      importedRaster: { overlayLayerId: 'ov-x', nativeStep: null },
    })
    const h = setupSync({ layers: [layer] })
    h.sync.refreshImportedRasterEffectiveTimes()
    expect(h.setOverlayTime).not.toHaveBeenCalled()
  })
})

// ── timelineSegments / 粒度 ───────────────────────────────────────────────────

describe('timelineSegments 与 activeLayerGranularity', () => {
  it('未选图层返回时钟日段', () => {
    const h = setupSync()
    expect(h.sync.timelineSegments.value.length).toBeGreaterThan(0)
  })

  it('科学图层粒度由 nativeStep 决定', () => {
    const layer = makeLayer({
      catalogId: 'cat-sci',
      dataState: 'imported',
      importedRaster: { overlayLayerId: 'ov-1', nativeStep: '8d', timeList: ['20240501'] },
    })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-sci' })
    expect(h.sync.activeLayerGranularity.value).toBe('day')
  })

  it('导入栅格无时间列表为 static', () => {
    const layer = makeLayer({
      catalogId: 'cat-img',
      dataState: 'imported',
      importedRaster: { overlayLayerId: 'ov-2', nativeStep: null },
    })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-img' })
    expect(h.sync.activeLayerGranularity.value).toBe('static')
    expect(h.sync.timelineSegments.value).toHaveLength(1)
  })

  it('天气图层走小时粒度与时钟段', () => {
    const layer = makeLayer({ catalogId: 'weather-temp' })
    workspaceCalls.isWeatherEngineLayer.mockReturnValue(true)
    const h = setupSync({ layers: [layer], selectedCatalogId: 'weather-temp' })
    expect(h.sync.activeLayerGranularity.value).toBe('hour')
    expect(h.sync.timelineSegments.value.length).toBeGreaterThan(0)
    expect(h.getLayerStatus).toHaveBeenCalledWith('weather-temp')
  })

  it('日粒度科学层带 ready 切片时生成对应时间段', () => {
    const layer = makeLayer({
      catalogId: 'cat-sci',
      dataState: 'imported',
      importedRaster: {
        overlayLayerId: 'ov-1',
        nativeStep: '8d',
        timeList: ['20260425_20260502'],
      },
    })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-sci' })
    const segments = h.sync.timelineSegments.value
    expect(segments.length).toBeGreaterThan(0)
    const readyish = segments.some((s) => s.state === 'ready' || s.state === 'fetchable')
    expect(readyish).toBe(true)
  })
})

// ── analysisFocusRequest ──────────────────────────────────────────────────────

describe('analysisFocusRequest', () => {
  it('请求到达时打开分析面板', async () => {
    const h = setupSync()
    h.uiStore.analysisFocusRequest = { kind: 'chart' }
    await nextTick()
    expect(h.showPanel).toHaveBeenCalled()
  })
})

// ── 事件时间轴（2026-08-25 用户反馈）：静态图层带事件时间 → 年刻度轴 ────────

describe('静态图层事件时间轴', () => {
  it('overlay meta 带事件 time_list → 生成事件年刻度（事件年 ready）', () => {
    const layer = makeLayer({
      catalogId: 'cat-era5-dwaa',
      dataState: 'imported',
      importedRaster: { overlayLayerId: 'ov-era5', nativeStep: null },
    })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-era5-dwaa' })
    h.overlayTimeStates.value = [
      {
        layerId: 'ov-era5',
        category: 'static',
        timeList: ['2020'],
        currentTime: null,
        palette: 'YlOrRd',
        vmin: 0,
        vmax: 10,
        unit: 'events',
        opacity: 0.8,
        bounds: [73, 15, 137, 59],
      },
    ]
    expect(h.sync.activeLayerGranularity.value).toBe('static')
    const segs = h.sync.timelineSegments.value
    // 事件年 2020 前后各留一年 → [2019, 2020, 2021]
    expect(segs.map((s) => s.label)).toEqual(['2019', '2020', '2021'])
    const eventSeg = segs.find((s) => s.label === '2020')
    expect(eventSeg?.state).toBe('ready')
    expect(eventSeg?.availabilityLabel).toContain('事件时间')
    expect(segs.find((s) => s.label === '2019')?.state).toBe('empty')
  })

  it('无事件 time_list → 保持原「静态」单段', () => {
    const layer = makeLayer({
      catalogId: 'cat-static-plain',
      dataState: 'imported',
      importedRaster: { overlayLayerId: 'ov-plain', nativeStep: null },
    })
    const h = setupSync({ layers: [layer], selectedCatalogId: 'cat-static-plain' })
    h.overlayTimeStates.value = [
      {
        layerId: 'ov-plain',
        category: 'static',
        timeList: [],
        currentTime: null,
        palette: 'viridis',
        vmin: null,
        vmax: null,
        unit: '',
        opacity: 0.7,
        bounds: [0, 0, 1, 1],
      },
    ]
    const segs = h.sync.timelineSegments.value
    expect(segs).toHaveLength(1)
    expect(segs[0].label).toBe('静态')
  })
})

it('independent layer dates render separately; unified mode still follows the clock', () => {
  const a = makeLayer({
    catalogId: 'a',
    importedRaster: {
      overlayLayerId: 'oa',
      nativeStep: '1d',
      timeList: ['20260702', '20260718'],
    },
  })
  const b = makeLayer({
    catalogId: 'b',
    importedRaster: {
      overlayLayerId: 'ob',
      nativeStep: '1d',
      timeList: ['20260702', '20260718'],
    },
  })
  const h = setupSync({ layers: [a, b], selectedCatalogId: 'a' })
  h.currentDate.value = new Date(2026, 6, 18)
  h.currentHour.value = 0
  h.uiStore.layerTimeMemory.b = { dateKey: '2026-07-02', hour: 0 }
  h.sync.refreshImportedRasterEffectiveTimes()
  expect(h.setOverlayTime).toHaveBeenCalledWith('oa', '20260718')
  expect(h.setOverlayTime).toHaveBeenCalledWith('ob', '20260702')
  h.setOverlayTime.mockClear()
  h.unifiedTimeLock.value = true
  h.sync.refreshImportedRasterEffectiveTimes()
  expect(h.setOverlayTime).toHaveBeenCalledWith('oa', '20260718')
  expect(h.setOverlayTime).toHaveBeenCalledWith('ob', '20260718')
})


describe('background layer attachment does not take over the selected clock', () => {
  it.each([true, false])('an unselected background layer visible=%s neither snaps nor changes unified mode', async visible => {
    const current = makeLayer({ catalogId: 'current', visible: true })
    const h = setupSync({ layers: [current], selectedCatalogId: 'current' })
    h.unifiedTimeLock.value = true
    await nextTick()
    h.uiStore.applyDateHour.mockClear()
    h.uiStore.setUnifiedTimeLock.mockClear()
    mockActiveLayers.value.push(makeLayer({
      catalogId: 'background', visible, dataState: 'imported',
      importedRaster: { overlayLayerId: 'background', timeList: ['20250701_20250731'] },
    }))
    await nextTick()
    await nextTick()
    expect(h.uiStore.setUnifiedTimeLock).not.toHaveBeenCalled()
    expect(h.uiStore.applyDateHour).not.toHaveBeenCalled()
    expect(h.unifiedTimeLock.value).toBe(true)
    expect(h.sync.selectedCatalogId.value).toBe('current')
  })

  it('a normal newly selected visible layer still switches to its own available frame', async () => {
    const h = setupSync()
    const added = makeLayer({
      catalogId: 'manual-sm', visible: true, dataState: 'imported',
      importedRaster: { overlayLayerId: 'manual-sm', timeList: ['20250731'] },
    })
    h.unifiedTimeLock.value = true
    await nextTick()
    h.uiStore.applyDateHour.mockClear()
    h.uiStore.setUnifiedTimeLock.mockClear()
    mockActiveLayers.value.push(added)
    h.selectedLayerDisplay.value = { catalogId: added.catalogId, instanceId: added.instanceId }
    await nextTick()
    await nextTick()
    expect(h.uiStore.setUnifiedTimeLock).toHaveBeenCalledWith(false)
    expect(h.uiStore.applyDateHour).toHaveBeenCalled()
    const last = h.uiStore.applyDateHour.mock.calls.at(-1)!
    expect((last[0] as Date).getFullYear()).toBe(2025)
    expect((last[0] as Date).getMonth()).toBe(6)
    expect((last[0] as Date).getDate()).toBe(31)
  })
})


describe('missing independent memories never borrow another product clock', () => {
  it.each([
    { name: '风云动态VOD', catalogId: 'imported-731b37b59c97', frame: '20250701_20250708', date: '2025-07-08', hasEffective: true },
    { name: 'SMAP动态SM', catalogId: 'imported-a8940443fd6d', frame: '20251227_20251231', date: '2025-12-31', hasEffective: false },
  ])('keeps hidden $name on its own frame while selected VOD changes date', async product => {
    const current = makeLayer({
      catalogId: 'selected-vod', dataState: 'imported',
      importedRaster: { overlayLayerId: 'selected-vod', timeList: ['20250720', '20250722'] },
    })
    const hidden = makeLayer({
      catalogId: product.catalogId, visible: false, dataState: 'imported',
      importedRaster: { overlayLayerId: product.catalogId, nativeStep: '1d',
        effectiveTimeLabel: product.hasEffective ? product.frame : undefined, defaultTime: product.frame,
        timeList: [product.frame, '20250720', '20250722'] },
    })
    const h = setupSync({ layers: [current, hidden], selectedCatalogId: current.catalogId })
    h.currentDate.value = new Date(2025, 6, 20)
    h.currentHour.value = 0
    h.sync.refreshImportedRasterEffectiveTimes()
    expect(hidden.importedRaster?.effectiveTimeLabel).toBe(product.frame)
    expect(h.uiStore.layerTimeMemory[product.catalogId]).toEqual({ dateKey: product.date, hour: 0 })
    h.currentDate.value = new Date(2025, 6, 22)
    h.sync.refreshImportedRasterEffectiveTimes()
    await nextTick()
    expect(hidden.importedRaster?.effectiveTimeLabel).toBe(product.frame)
    expect(h.uiStore.layerTimeMemory[product.catalogId]).toEqual({ dateKey: product.date, hour: 0 })
    const applied = h.setOverlayTime.mock.calls.filter(call => call[0] === product.catalogId)
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.every(call => call[1] === product.frame)).toBe(true)
    expect(hidden.visible).toBe(false)
  })

  it('keeps an unselected layer time unknown when it has no own frame or default', () => {
    const current = makeLayer({ catalogId: 'current' })
    const hidden = makeLayer({
      catalogId: 'unknown-hidden', visible: false, dataState: 'imported',
      importedRaster: { overlayLayerId: 'unknown-hidden', timeList: ['20250720', '20250722'] },
    })
    const h = setupSync({ layers: [current, hidden], selectedCatalogId: 'current' })
    h.currentDate.value = new Date(2025, 6, 20)
    h.sync.refreshImportedRasterEffectiveTimes()
    expect(hidden.importedRaster?.effectiveTimeLabel).toBeUndefined()
    expect(h.uiStore.layerTimeMemory['unknown-hidden']).toBeUndefined()
    expect(h.setOverlayTime.mock.calls.some(call => call[0] === 'unknown-hidden')).toBe(false)
  })

  it('applies a new existing noncurrent memory without waiting for a global clock or remote frame event', async () => {
    const current = makeLayer({ catalogId: 'current' })
    const target = makeLayer({
      catalogId: 'native-vod', visible: false, dataState: 'imported',
      importedRaster: { overlayLayerId: 'native-vod', effectiveTimeLabel: '20250720', timeList: ['20250720', '20250722'] },
    })
    const h = setupSync({ layers: [current, target], selectedCatalogId: 'current' })
    h.currentDate.value = new Date(2025, 6, 31)
    h.uiStore.layerTimeMemory['native-vod'] = { dateKey: '2025-07-20', hour: 0 }
    h.sync.refreshImportedRasterEffectiveTimes()
    h.uiStore.setLayerTimeMemoryAt('native-vod', new Date(2025, 6, 22), 0)
    await nextTick()
    expect(target.importedRaster?.effectiveTimeLabel).toBe('20250722')
    expect(h.currentDate.value.getDate()).toBe(31)
    expect(target.visible).toBe(false)
  })
})
