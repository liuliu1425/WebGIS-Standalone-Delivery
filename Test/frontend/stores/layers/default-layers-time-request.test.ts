import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_LAYERS, ensureDefaultLayers } from '@/stores/layers/default-layers'
import { useUiStore } from '@/stores/ui'
import type { ActiveLayer, ActiveRunLayerGroup } from '@/stores/layers/types'

let layers = ref<ActiveLayer[]>([])
let groups = ref<ActiveRunLayerGroup[]>([])
let selected = ref<string | null>(null)
const addRaster = vi.fn((name: string, id: string, bounds: [number, number, number, number], options: {
  visible?: boolean; select?: boolean; timeList?: string[]; nativeStep?: string | null; defaultTime?: string;
} = {}) => {
  const layer = {
    instanceId: id, catalogId: id, name, visible: options.visible !== false, order: layers.value.length,
    importedRaster: { overlayLayerId: id, bounds, timeList: options.timeList, nativeStep: options.nativeStep, defaultTime: options.defaultTime },
  } as ActiveLayer
  layers.value.push(layer)
  if (options.select !== false) selected.value = id
  return layer
})
vi.mock('@/stores/layers/selectors', () => ({
  useLayerWorkspace: () => ({
    activeLayers: layers,
    selectedInstanceId: selected,
    addImportedRasterLayer: addRaster,
    selectLayer: (id: string | null) => { selected.value = id },
    scheduleWorkspacePersist: vi.fn(),
  }),
  useWorkflowRun: () => ({ runLayerGroups: groups, autoAttachProductsForNewLayer: async () => 0 }),
}))
vi.mock('@/stores/layers/workspace-persist', () => ({ forgetDismissedLayer: vi.fn() }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  groups = ref([])
  selected = ref(null)
  layers = ref(DEFAULT_LAYERS.flatMap((g) => g.members.map((m, i) => ({
    instanceId: m.overlayId, catalogId: m.overlayId, name: m.label, visible: m.visible, order: i,
    importedRaster: { overlayLayerId: m.overlayId, timeList: ['20250701_20250731'] },
  } as ActiveLayer))))
})
afterEach(() => vi.unstubAllGlobals())

const metadata = () => ({ ok: true, json: async () => ({
  bounds: [-180, -90, 180, 90],
  meta: { default_time: '20250701_20250731', time_list: ['20250701_20250731', '20260101'] },
}) })

it('still initializes the normal default frame when no date is requested', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => metadata()))
  const ui = useUiStore()
  await ensureDefaultLayers()
  expect(ui.currentDate.getFullYear()).toBe(2025)
  expect(ui.currentDate.getMonth()).toBe(6)
  expect(ui.currentDate.getDate()).toBe(31)
  expect(ui.layerTimeMemory['imported-a8940443fd6d']?.dateKey).toBe('2025-07-31')
})

it('keeps each restored date and the current layer when metadata is refreshed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => metadata()))
  const ui = useUiStore()
  const sm = 'imported-55359b8ecd3d'
  const vod = 'imported-a94205dad5f9'
  selected.value = vod
  ui.setLayerTimeMemoryAt(sm, new Date(2025, 11, 15))
  ui.setLayerTimeMemoryAt(vod, new Date(2025, 6, 22))
  layers.value.find((layer) => layer.catalogId === vod)!.visible = true
  await ensureDefaultLayers()
  expect(selected.value).toBe(vod)
  expect(ui.layerTimeMemory[sm]?.dateKey).toBe('2025-12-15')
  expect(ui.layerTimeMemory[vod]?.dateKey).toBe('2025-07-22')
  expect(ui.currentDate.getDate()).toBe(22)
  expect(ui.currentDate.getMonth()).toBe(6)
  expect(layers.value.find((layer) => layer.catalogId === vod)?.visible).toBe(true)
})

it.each([1, 13])('late metadata request %i cannot undo an explicit date or other memories', async (blockedCall) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (++calls === blockedCall) await gate
    return metadata()
  }))
  const ui = useUiStore()
  const initializing = ensureDefaultLayers()
  await vi.waitFor(() => expect(calls).toBe(blockedCall))
  const target = 'imported-a8940443fd6d'
  ui.setLayerTimeMemoryAt('imported-55359b8ecd3d', new Date(2025, 11, 5))
  ui.setLayerTimeMemoryAt(target, new Date(2026, 0, 1))
  ui.applyDateHour(new Date(2026, 0, 1), 0)
  ui.pinTimelineAt(target, new Date(2026, 0, 1))
  // Initial loading must remain cancelled even if the short-lived pin is cleared.
  ui.clearTimelinePin()
  release()
  await initializing
  expect(ui.currentDate.getFullYear()).toBe(2026)
  expect(ui.currentDate.getMonth()).toBe(0)
  expect(ui.currentDate.getDate()).toBe(1)
  expect(ui.layerTimeMemory[target]?.dateKey).toBe('2026-01-01')
  expect(ui.layerTimeMemory['imported-55359b8ecd3d']?.dateKey).toBe('2025-12-05')
  expect(layers.value.find((l) => l.catalogId === target)?.importedRaster?.timeList).toContain('20260101')
})


it('late background seeds preserve a user selection, visibility edit and requested date made between member probes', async () => {
  layers.value = layers.value.slice(0, 3)
  const initial = 'imported-55359b8ecd3d'
  const target = 'imported-731b37b59c97'
  selected.value = initial
  const ui = useUiStore()
  ui.setLayerTimeMemoryAt(initial, new Date(2025, 6, 10), 3)
  ui.applyDateHour(new Date(2025, 6, 10), 3)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (++calls === 3) await gate
    return metadata()
  }))
  const initializing = ensureDefaultLayers()
  await vi.waitFor(() => expect(calls).toBe(3))
  // The second new hidden member is ready, while its group's third probe waits.
  expect(layers.value.some(layer => layer.catalogId === target)).toBe(true)
  expect(selected.value).toBe(initial)
  const layer = layers.value.find(item => item.catalogId === target)!
  layer.visible = true
  selected.value = target
  ui.setLayerTimeMemoryAt(target, new Date(2025, 6, 20), 6)
  ui.applyDateHour(new Date(2025, 6, 20), 6)
  release()
  await initializing
  expect(layers.value).toHaveLength(12)
  expect(selected.value).toBe(target)
  expect(layer.visible).toBe(true)
  expect(ui.currentDate.getDate()).toBe(20)
  expect(ui.currentHour).toBe(6)
  expect(ui.layerTimeMemory[target]).toEqual({ dateKey: '2025-07-20', hour: 6 })
  expect(ui.layerTimeMemory[initial]).toEqual({ dateKey: '2025-07-10', hour: 3 })
  expect(layer.importedRaster?.timeList).toContain('20260101')
  expect(addRaster).toHaveBeenCalledTimes(9)
  for (const call of addRaster.mock.calls) expect(call[3]).toMatchObject({ select: false })
})

it('late final seed selection does not restore the initial layer over a different existing user focus', async () => {
  const initial = 'imported-55359b8ecd3d'
  const target = 'imported-a94205dad5f9'
  selected.value = initial
  const ui = useUiStore()
  ui.setLayerTimeMemoryAt(initial, new Date(2025, 6, 10))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => { if (++calls === 1) await gate; return metadata() }))
  const initializing = ensureDefaultLayers()
  await vi.waitFor(() => expect(calls).toBe(1))
  selected.value = target
  layers.value.find(layer => layer.catalogId === target)!.visible = true
  ui.setLayerTimeMemoryAt(target, new Date(2025, 6, 22))
  ui.applyDateHour(new Date(2025, 6, 22), 0)
  release()
  await initializing
  expect(selected.value).toBe(target)
  expect(layers.value.find(layer => layer.catalogId === target)?.visible).toBe(true)
  expect(ui.currentDate.getDate()).toBe(22)
  expect(ui.layerTimeMemory[initial]?.dateKey).toBe('2025-07-10')
  expect(addRaster).not.toHaveBeenCalled()
})

it('fresh stable seeding retains configured initial switches and chooses the primary only at completion', async () => {
  layers.value = []
  vi.stubGlobal('fetch', vi.fn(async () => metadata()))
  await ensureDefaultLayers()
  expect(layers.value).toHaveLength(12)
  expect(selected.value).toBe('imported-55359b8ecd3d')
  expect(layers.value.filter(layer => layer.visible).map(layer => layer.catalogId)).toEqual(['imported-55359b8ecd3d'])
  for (const entry of DEFAULT_LAYERS) for (const member of entry.members) {
    const call = addRaster.mock.calls.find(args => args[1] === member.overlayId)
    expect(call?.[3]).toMatchObject({ visible: member.visible, select: false })
  }
})


it('an explicit pinned date protects user values while missing hidden defaults still obtain their own memories', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => metadata()))
  const ui = useUiStore()
  const target = 'imported-a94205dad5f9'
  selected.value = target
  ui.setLayerTimeMemoryAt(target, new Date(2025, 6, 22), 6)
  ui.applyDateHour(new Date(2025, 6, 22), 6)
  ui.pinTimelineAt(target, new Date(2025, 6, 22), 6)
  const beforePin = { ...ui.timelinePin }
  await ensureDefaultLayers()
  expect(ui.layerTimeMemory[target]).toEqual({ dateKey: '2025-07-22', hour: 6 })
  expect(ui.timelinePin).toEqual(beforePin)
  expect(ui.currentDate.getDate()).toBe(22)
  expect(ui.currentHour).toBe(6)
  expect(selected.value).toBe(target)
  for (const hidden of ['imported-731b37b59c97', 'imported-a8940443fd6d']) {
    expect(ui.layerTimeMemory[hidden]).toEqual({ dateKey: '2025-07-31', hour: 0 })
    expect(layers.value.find(layer => layer.catalogId === hidden)?.visible).toBe(false)
  }
})
