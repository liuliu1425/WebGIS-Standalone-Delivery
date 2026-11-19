import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useOnDemandFrameStore } from "@/stores/layers/ondemand-frame";

const activeLayers = ref<
  Array<{
    instanceId: string;
    catalogId: string;
    visible: boolean;
    opacity: number;
    isAdminBoundary?: boolean;
    runGroupLocked?: boolean;
    name?: string;
    jobLayer?: { status: string; message?: string };
    dataState?: string;
    importedRaster?: { overlayLayerId?: string; bounds?: [number, number, number, number]; timeList?: string[]; defaultTime?: string; nativeStep?: unknown };
  }>
>([]);

const toggleLayerVisibility = vi.fn((instanceId: string) => {
  const layer = activeLayers.value.find((l) => l.instanceId === instanceId);
  if (layer) layer.visible = !layer.visible;
});
const setLayerOpacity = vi.fn((instanceId: string, opacity: number) => {
  const layer = activeLayers.value.find((l) => l.instanceId === instanceId);
  if (layer) layer.opacity = opacity;
});
const addLayer = vi.fn((catalogId: string, _admin = false, _job?: unknown, options?: { visible?: boolean; select?: boolean; skipAutoRun?: boolean }) => {
  activeLayers.value.push({
    instanceId: `inst-${catalogId}`,
    catalogId,
    visible: options?.visible !== false,
    opacity: 1,
  });
  if (options?.select !== false) selectedInstanceId.value = `inst-${catalogId}`;
});
const addImportedRasterLayer = vi.fn((name: string, catalogId: string, bounds: [number, number, number, number], options: {
  visible?: boolean; select?: boolean; timeList?: string[]; defaultTime?: string; nativeStep?: string | null;
}) => {
  const layer = {
    instanceId: `restored-${catalogId}`, catalogId, name, visible: options.visible !== false, opacity: 1,
    dataState: 'imported',
    importedRaster: { overlayLayerId: catalogId, bounds, timeList: options.timeList, defaultTime: options.defaultTime, nativeStep: options.nativeStep },
  };
  activeLayers.value.push(layer);
  if (options.select !== false) selectedInstanceId.value = layer.instanceId;
  return layer;
});
const selectLayer = vi.fn((id: string) => { selectedInstanceId.value = id; });
const setSidebarView = vi.fn();
const getCatalogAddBlockReason = vi.fn(
  (_catalogId: string) => null as string | null,
);

const removeLayer = vi.fn((instanceId: string) => {
  activeLayers.value = activeLayers.value.filter(
    (l) => l.instanceId !== instanceId,
  );
});
const bringLayerToFront = vi.fn();
const sendLayerToBack = vi.fn();
const setLayerPaletteOverride = vi.fn();
const setLayerRangeOverride = vi.fn();
const selectedInstanceId = ref("");
const activeLayersDisplay = ref<
  Array<{ instanceId: string; renderHint?: { palette?: string } }>
>([]);
const layerLibrary = ref<
  Array<{
    catalogId: string;
    name?: string;
    supportsTime?: boolean;
    updateLabel?: string;
  }>
>([]);
const resolveEffectiveDescriptor = vi.fn(
  (_catalogId: string) =>
    null as { supports_time?: boolean; time_granularity?: string; status?: string; run_readiness?: string; run_readiness_summary?: string; display_name?: string } | null,
);

const applyDateHour = vi.fn();
const setHour = vi.fn();
const pinTimelineAt = vi.fn();
const layerTimeMemory = ref<Record<string, { dateKey: string; hour: number }>>({});
const setLayerTimeMemoryAt = vi.fn((id: string, date: Date, hour: number) => {
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  layerTimeMemory.value = { ...layerTimeMemory.value, [id]: { dateKey, hour } };
});
const play = vi.fn();
const pause = vi.fn();
const currentHour = ref(12);
const currentDate = ref(new Date(2024, 0, 15));
const currentMapCenter = ref({ lng: 0, lat: 0 });
const currentMapZoom = ref(1);

vi.mock("@/stores/layers/selectors", () => ({
  useLayerViewport: () => ({ currentMapCenter, currentMapZoom }),
  useLayerWorkspace: () => ({
    activeLayers,
    activeLayersDisplay,
    layerLibrary,
    resolveEffectiveDescriptor,
    selectedInstanceId,
    toggleLayerVisibility,
    setLayerOpacity,
    addLayer,
    addImportedRasterLayer,
    selectLayer,
    setSidebarView,
    getCatalogAddBlockReason,
    removeLayer,
    bringLayerToFront,
    sendLayerToBack,
    setLayerPaletteOverride,
    setLayerRangeOverride,
  }),
}));

vi.mock("@/stores/ui", () => ({
  useUiStore: () => ({
    get currentHour() {
      return currentHour.value;
    },
    get currentDate() {
      return currentDate.value;
    },
    get layerTimeMemory() { return layerTimeMemory.value; },
    applyDateHour,
    setHour,
    pinTimelineAt,
    setLayerTimeMemoryAt,
    play,
    pause,
  }),
}));

vi.mock("@/components/map/layer-symbology", () => ({
  isMapLinkedPalette: () => true,
  resolveCanonicalPaletteIdStrict: (id: string) => id,
  WEATHER_PALETTE_OPTIONS: [
    { id: "viridis", label: "Viridis" },
    { id: "plasma", label: "Plasma" },
    { id: "thermal", label: "热力橙红" },
  ],
}));

afterEach(() => vi.unstubAllGlobals());

describe("executeAgentUiIntent", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "cmfd-precip-cn",
        visible: false,
        opacity: 1,
      },
    ];
    layerTimeMemory.value = {};
    layerLibrary.value = [];
    selectedInstanceId.value = "";
    resolveEffectiveDescriptor.mockReset();
    resolveEffectiveDescriptor.mockReturnValue(null);
    vi.clearAllMocks();
    currentDate.value = new Date(2024, 0, 15);
    currentHour.value = 12;
    applyDateHour.mockImplementation((date: Date, hour: number) => {
      currentDate.value = new Date(date);
      currentHour.value = hour;
    });
    setHour.mockImplementation((hour: number) => { currentHour.value = hour; });
    useOnDemandFrameStore().loaded = true;
  });

  const importedMetadata = () => ({ ok: true, json: async () => ({
    bounds: [-180, -90, 180, 90],
    meta: { time_list: ['20250701_20250731', '20250722'], default_time: '20250701_20250731', native_step: '1M' },
  }) });

  it('restores an open removed imported leaf with real metadata, hidden and without changing focus or times', async () => {
    selectedInstanceId.value = 'i1';
    activeLayers.value[0]!.visible = true;
    layerTimeMemory.value = { 'cmfd-precip-cn': { dateKey: '2025-07-10', hour: 6 } };
    const before = JSON.stringify({ old: activeLayers.value[0], time: layerTimeMemory.value, clock: currentDate.value });
    const fetch = vi.fn(async () => importedMetadata());
    vi.stubGlobal('fetch', fetch);
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({
      name: 'add_layer', args: { catalog_id: 'imported-38993117b963', display_name: 'SMAP平均版土壤水分SM' },
    });
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/overlay-bounds/imported-38993117b963');
    expect(addLayer).not.toHaveBeenCalled();
    expect(addImportedRasterLayer).toHaveBeenCalledOnce();
    const restored = activeLayers.value[1]!;
    expect(restored.name).toBe('SMAP平均版土壤水分SM');
    expect(restored.visible).toBe(false);
    expect(restored.importedRaster).toMatchObject({
      overlayLayerId: 'imported-38993117b963', bounds: [-180, -90, 180, 90],
      timeList: ['20250701_20250731', '20250722'], defaultTime: '20250701_20250731', nativeStep: '1M',
    });
    expect(selectedInstanceId.value).toBe('i1');
    expect(JSON.stringify({ old: activeLayers.value[0], time: layerTimeMemory.value, clock: currentDate.value })).toBe(before);
    expect(result.target?.instance_id).toBe(restored.instanceId);
  });

  it('uses the same real raster restoration for a missing show target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => importedMetadata()));
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({
      name: 'set_layer_visibility', args: { catalog_id: 'imported-38993117b963', visible: true, display_name: 'SMAP平均SM' },
    });
    expect(result.ok).toBe(true);
    expect(addLayer).not.toHaveBeenCalled();
    expect(addImportedRasterLayer).toHaveBeenCalledWith('SMAP平均SM', 'imported-38993117b963', [-180, -90, 180, 90],
      expect.objectContaining({ visible: true, select: true }));
    expect(activeLayers.value[1]?.importedRaster?.timeList).toHaveLength(2);
    expect(activeLayers.value[1]?.visible).toBe(true);
    expect(selectedInstanceId.value).toBe(activeLayers.value[1]?.instanceId);
    expect(result.message).toContain('资源信息已就绪');
  });

  it.each(['404', 'network', 'invalid-bounds'])('does not add an imported placeholder when metadata fails: %s', async failure => {
    const fetch = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      if (failure === '404') return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ bounds: [0, 0, 0, 1], meta: {} }) };
    });
    vi.stubGlobal('fetch', fetch);
    selectedInstanceId.value = 'i1';
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    for (const intent of [
      { name: 'add_layer', args: { catalog_id: 'imported-38993117b963', display_name: 'SMAP平均SM' } },
      { name: 'set_layer_visibility', args: { catalog_id: 'imported-38993117b963', visible: true, display_name: 'SMAP平均SM' } },
    ]) {
      const result = await executeAgentUiIntent(intent);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('元数据');
    }
    expect(activeLayers.value).toHaveLength(1);
    expect(selectedInstanceId.value).toBe('i1');
    expect(addLayer).not.toHaveBeenCalled();
    expect(addImportedRasterLayer).not.toHaveBeenCalled();
  });

  it('does not expand availability to arbitrary imported IDs merely because metadata might exist', async () => {
    const fetch = vi.fn(async () => importedMetadata());
    vi.stubGlobal('fetch', fetch);
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'add_layer', args: { catalog_id: 'imported-not-open', display_name: '未开放数据' } });
    expect(result.status).toBe('not_executed');
    expect(fetch).not.toHaveBeenCalled();
    expect(addLayer).not.toHaveBeenCalled();
    expect(addImportedRasterLayer).not.toHaveBeenCalled();
  });

  it('repairs a legacy imported catalog shell in place while keeping its visibility, focus and memory', async () => {
    activeLayers.value.push({ instanceId: 'legacy', catalogId: 'imported-38993117b963', name: 'imported-38993117b963', visible: true, opacity: 0.7 });
    selectedInstanceId.value = 'i1';
    layerTimeMemory.value = { 'imported-38993117b963': { dateKey: '2025-07-22', hour: 6 } };
    vi.stubGlobal('fetch', vi.fn(async () => importedMetadata()));
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'add_layer', args: { catalog_id: 'imported-38993117b963', display_name: 'SMAP平均SM' } });
    expect(result.ok).toBe(true);
    expect(activeLayers.value).toHaveLength(2);
    expect(activeLayers.value[1]).toMatchObject({ instanceId: 'legacy', visible: true, opacity: 0.7, name: 'SMAP平均SM' });
    expect(activeLayers.value[1]?.importedRaster?.overlayLayerId).toBe('imported-38993117b963');
    expect(selectedInstanceId.value).toBe('i1');
    expect(layerTimeMemory.value['imported-38993117b963']).toEqual({ dateKey: '2025-07-22', hour: 6 });
    expect(addLayer).not.toHaveBeenCalled();
    expect(addImportedRasterLayer).not.toHaveBeenCalled();
  });

  it('does not attach a raster when cancelled while its metadata response is still pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async () => { await gate; return importedMetadata(); });
    vi.stubGlobal('fetch', fetch);
    selectedInstanceId.value = 'i1';
    const before = JSON.stringify(activeLayers.value);
    const controller = new AbortController();
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const pending = executeAgentUiIntent({
      name: 'add_layer', args: { catalog_id: 'imported-38993117b963', display_name: 'SMAP平均SM' },
    }, {}, { signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    release();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_executed');
    expect(JSON.stringify(activeLayers.value)).toBe(before);
    expect(selectedInstanceId.value).toBe('i1');
    expect(addLayer).not.toHaveBeenCalled();
    expect(addImportedRasterLayer).not.toHaveBeenCalled();
    expect(selectLayer).not.toHaveBeenCalled();
  });

  it('adds an open product hidden without selecting, loading, or altering existing layers', async () => {
    selectedInstanceId.value = 'i1';
    activeLayers.value[0]!.visible = true;
    layerTimeMemory.value = { 'cmfd-precip-cn': { dateKey: '2025-07-10', hour: 8 } };
    layerLibrary.value = [{ catalogId: 'new-sm', name: 'SMAP平均SM' }];
    const before = JSON.stringify(activeLayers.value);
    const beforeMemory = JSON.stringify(layerTimeMemory.value);
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'add_layer', args: { catalog_id: 'new-sm' } });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('当前隐藏');
    expect(result.target).toMatchObject({ catalog_id: 'new-sm', instance_id: 'inst-new-sm' });
    expect(addLayer).toHaveBeenCalledWith('new-sm', false, undefined, { visible: false, select: false, skipAutoRun: true });
    expect(activeLayers.value[1]!.visible).toBe(false);
    expect(JSON.stringify(activeLayers.value.slice(0, 1))).toBe(before);
    expect(selectedInstanceId.value).toBe('i1');
    expect(selectLayer).not.toHaveBeenCalled();
    expect(JSON.stringify(layerTimeMemory.value)).toBe(beforeMemory);
  });

  it.each([true, false])('adding an existing visible=%s layer is idempotent', async visible => {
    activeLayers.value[0]!.visible = visible;
    selectedInstanceId.value = 'i1';
    layerTimeMemory.value = { 'cmfd-precip-cn': { dateKey: '2025-07-25', hour: 6 } };
    const before = JSON.stringify({ layers: activeLayers.value, time: layerTimeMemory.value });
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'add_layer', args: { catalog_id: 'cmfd-precip-cn' } });
    expect(result.ok).toBe(true);
    expect(addLayer).not.toHaveBeenCalled();
    expect(JSON.stringify({ layers: activeLayers.value, time: layerTimeMemory.value })).toBe(before);
    expect(selectedInstanceId.value).toBe('i1');
  });

  it.each([true, false])('select keeps visible=%s and does not fetch data, even if its previous load failed', async visible => {
    activeLayers.value[0]!.visible = visible;
    activeLayers.value[0]!.jobLayer = { status: 'failed', message: 'old missing asset' };
    const ensureFrame = vi.fn();
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'select_layer', args: { catalog_id: 'cmfd-precip-cn' } }, { ensureOnDemandFrame: ensureFrame });
    expect(result.ok).toBe(true);
    expect(selectedInstanceId.value).toBe('i1');
    expect(activeLayers.value[0]!.visible).toBe(visible);
    expect(result.message).toContain(visible ? '保持勾选显示' : '当前隐藏');
    expect(toggleLayerVisibility).not.toHaveBeenCalled();
    expect(ensureFrame).not.toHaveBeenCalled();
  });

  it('rejects select of an unadded product without implicitly adding or showing it', async () => {
    layerLibrary.value = [{ catalogId: 'unadded-sm', name: 'SMAP动态SM' }];
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'select_layer', args: { catalog_id: 'unadded-sm' } });
    expect(result.status).toBe('not_executed');
    expect(addLayer).not.toHaveBeenCalled();
    expect(selectLayer).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'blocked'])('rejects adding a %s catalog without changes', async kind => {
    if (kind === 'blocked') resolveEffectiveDescriptor.mockReturnValue({ run_readiness: 'blocked' });
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'add_layer', args: { catalog_id: 'not-open' } });
    expect(result.status).toBe('not_executed');
    expect(activeLayers.value).toHaveLength(1);
    expect(addLayer).not.toHaveBeenCalled();
  });

  it('does not execute selection after the prerequisite add failed', async () => {
    const { executeAgentUiIntents } = await import('@/components/agent/agent-ui-intent');
    const results = await executeAgentUiIntents([
      { name: 'add_layer', args: { catalog_id: 'not-open' } },
      { name: 'select_layer', args: { catalog_id: 'not-open' } },
    ]);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]!.status).toBe('not_executed');
    expect(selectLayer).not.toHaveBeenCalled();
  });

  it('does not claim selection succeeded when the workspace rejects it', async () => {
    selectLayer.mockImplementationOnce(() => {});
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'select_layer', args: { catalog_id: 'cmfd-precip-cn' } });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('keeps separate dates when two named targets are updated in reverse order', async () => {
    activeLayers.value = [
      { instanceId: 'sm', catalogId: 'fy-sm', name: '风云平均SM', visible: true, opacity: 1, importedRaster: { timeList: ['20250710', '20250722'] } },
      { instanceId: 'vod', catalogId: 'fy-vod', name: '风云平均VOD', visible: false, opacity: 1, importedRaster: { timeList: ['20250710', '20250722'] } },
    ];
    selectedInstanceId.value = 'sm';
    layerTimeMemory.value = { 'fy-sm': { dateKey: '2025-07-10', hour: 6 }, 'fy-vod': { dateKey: '2025-07-10', hour: 12 } };
    const { executeAgentUiIntents } = await import('@/components/agent/agent-ui-intent');
    const results = await executeAgentUiIntents([
      { name: 'set_timeline', args: { catalog_id: 'fy-vod', date: '2025-07-22' } },
      { name: 'set_timeline', args: { catalog_id: 'fy-sm', date: '2025-07-10' } },
    ]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(layerTimeMemory.value['fy-vod']).toEqual({ dateKey: '2025-07-22', hour: 12 });
    expect(layerTimeMemory.value['fy-sm']).toEqual({ dateKey: '2025-07-10', hour: 6 });
    expect(selectedInstanceId.value).toBe('sm');
    expect(activeLayers.value.map(l => l.visible)).toEqual([true, false]);
    expect(selectLayer).not.toHaveBeenCalled();
    expect(toggleLayerVisibility).not.toHaveBeenCalled();
  });

  it('rejects a stale explicit instance instead of editing another instance with the same catalog or the global clock', async () => {
    activeLayers.value = [
      { instanceId: 'current', catalogId: 'sm', name: 'SM', visible: true, opacity: 1, importedRaster: { timeList: ['20250710'] } },
      { instanceId: 'replacement', catalogId: 'vod', name: 'VOD', visible: false, opacity: 1, importedRaster: { timeList: ['20250701', '20250725'] } },
    ];
    selectedInstanceId.value = 'current';
    layerTimeMemory.value = { sm: { dateKey: '2025-07-10', hour: 3 }, vod: { dateKey: '2025-07-25', hour: 9 } };
    const before = JSON.stringify({ layers: activeLayers.value, memory: layerTimeMemory.value, clock: currentDate.value, hour: currentHour.value });
    const ensureFrame = vi.fn();
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({
      name: 'set_timeline', args: { catalog_id: 'vod', instance_id: 'removed-instance', date: '2025-07-01' },
    }, { ensureOnDemandFrame: ensureFrame });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_executed');
    expect(result.message).toContain('实例已失效');
    expect(JSON.stringify({ layers: activeLayers.value, memory: layerTimeMemory.value, clock: currentDate.value, hour: currentHour.value })).toBe(before);
    expect(selectedInstanceId.value).toBe('current');
    expect(applyDateHour).not.toHaveBeenCalled();
    expect(setLayerTimeMemoryAt).not.toHaveBeenCalled();
    expect(pinTimelineAt).not.toHaveBeenCalled();
    expect(ensureFrame).not.toHaveBeenCalled();
  });

  it('reports failed target data truthfully while preserving another selected layer clock and memory', async () => {
    activeLayers.value = [
      { instanceId: 'old', catalogId: 'sm', name: 'SM', visible: true, opacity: 1, importedRaster: { timeList: ['20250710'] } },
      { instanceId: 'target', catalogId: 'vod', name: 'VOD', visible: false, opacity: 1, importedRaster: { timeList: ['20250701_20250731'] } },
    ];
    selectedInstanceId.value = 'old';
    layerTimeMemory.value = { sm: { dateKey: '2025-07-10', hour: 3 }, vod: { dateKey: '2025-07-25', hour: 9 } };
    const oldClock = currentDate.value.getTime();
    useOnDemandFrameStore().specs = { vod: { layer_id: 'vod' } } as ReturnType<typeof useOnDemandFrameStore>['specs'];
    const ensureFrame = vi.fn().mockResolvedValue({ ok: false, message: 'HTTP 500' });
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'set_timeline', args: { catalog_id: 'vod', date: '2025-07-20' } }, { ensureOnDemandFrame: ensureFrame });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('目标图层记忆日期已调整到 2025-07-20');
    expect(result.message).toContain('数据没有切换成功');
    expect(selectedInstanceId.value).toBe('old');
    expect(currentDate.value.getTime()).toBe(oldClock);
    expect(layerTimeMemory.value.sm).toEqual({ dateKey: '2025-07-10', hour: 3 });
    expect(layerTimeMemory.value.vod).toEqual({ dateKey: '2025-07-20', hour: 9 });
    expect(activeLayers.value.map(l => l.visible)).toEqual([true, false]);
    expect(selectLayer).not.toHaveBeenCalled();
    expect(applyDateHour).not.toHaveBeenCalled();
  });

  it('does not call a checked layer successfully loaded when its workflow failed', async () => {
    activeLayers.value[0]!.jobLayer = { status: 'failed', message: '数据文件不存在' };
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true } });
    expect(activeLayers.value[0]!.visible).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('数据文件不存在');
    expect(result.message).toContain('勾选');
  });

  it('does not show or add a catalog item marked unavailable', async () => {
    resolveEffectiveDescriptor.mockReturnValue({ run_readiness: 'blocked', run_readiness_summary: '数据源未配置' });
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({ name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true } });
    expect(result.status).toBe('not_executed');
    expect(activeLayers.value[0]!.visible).toBe(false);
    expect(addLayer).not.toHaveBeenCalled();
  });

  it('reports a pending load separately and reads the latest status on the next request', async () => {
    vi.useFakeTimers();
    try {
      activeLayers.value[0]!.jobLayer = { status: 'running' };
      const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
      const first = executeAgentUiIntent({ name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true } });
      await vi.advanceTimersByTimeAsync(9500);
      const result = await first;
      expect(result.ok).toBe(false);
      expect(result.status).toBe('pending');
      expect(result.message).toContain('加载');
      activeLayers.value[0]!.jobLayer!.status = 'succeeded';
      const second = executeAgentUiIntent({ name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true } });
      await vi.advanceTimersByTimeAsync(1000);
      expect((await second).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('waits for a real job state transition before reporting data ready', async () => {
    vi.useFakeTimers();
    try {
      activeLayers.value[0]!.jobLayer = { status: 'running' };
      const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
      const pending = executeAgentUiIntent({ name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true } });
      await vi.advanceTimersByTimeAsync(400);
      activeLayers.value[0]!.jobLayer!.status = 'succeeded';
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.message).toContain('数据加载成功');
    } finally { vi.useRealTimers(); }
  });

  it('cancellation retains the changed checkbox and skips remaining actions, then a fresh request works', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      activeLayers.value[0]!.jobLayer = { status: 'running' };
      const { executeAgentUiIntents } = await import('@/components/agent/agent-ui-intent');
      const pending = executeAgentUiIntents([
        { name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true } },
        { name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: false } },
      ], {}, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(400);
      controller.abort();
      const cancelled = await pending;
      expect(activeLayers.value[0]!.visible).toBe(true);
      expect(cancelled[0].message).toContain('已勾选');
      expect(cancelled[1].message).toContain('尚未执行');
      const fresh = executeAgentUiIntents([{ name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: false } }]);
      await vi.advanceTimersByTimeAsync(500);
      expect((await fresh)[0].ok).toBe(true);
      expect(activeLayers.value[0]!.visible).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(['normal', 'toggle-noop', 'locked', 'target-lost'])(
    'checks the final solo set after execution: %s', async (scenario) => {
      activeLayers.value = [
        { instanceId: 'i1', catalogId: 'cmfd-precip-cn', name: '目标', visible: true, opacity: 1 },
        { instanceId: 'other', catalogId: 'other', name: '另一数据层', visible: true, opacity: 1,
          runGroupLocked: scenario === 'locked' },
      ];
      const dateBefore = currentDate.value.getTime();
      if (scenario === 'toggle-noop') toggleLayerVisibility.mockImplementationOnce(() => {});
      if (scenario === 'target-lost') toggleLayerVisibility.mockImplementationOnce(() => {
        activeLayers.value[0]!.visible = false;
        activeLayers.value[1]!.visible = false;
      });
      const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
      const result = await executeAgentUiIntent({
        name: 'set_layer_visibility',
        args: { catalog_id: 'cmfd-precip-cn', visible: true, solo: true },
      });
      expect(result.ok).toBe(scenario === 'normal');
      if (scenario === 'normal') {
        expect(activeLayers.value.filter(l => l.visible).map(l => l.instanceId)).toEqual(['i1']);
      } else {
        expect(result.status).toBe('failed');
        expect(result.message).toContain('未完成只显示');
        if (scenario !== 'target-lost') expect(result.message).toContain('另一数据层');
      }
      expect(currentDate.value.getTime()).toBe(dateBefore);
      expect(setLayerTimeMemoryAt).not.toHaveBeenCalled();
    },
  );

  it('ordinary show leaves other checked layers unchanged', async () => {
    activeLayers.value.push({ instanceId: 'other', catalogId: 'other', visible: true, opacity: 1 });
    const { executeAgentUiIntent } = await import('@/components/agent/agent-ui-intent');
    const result = await executeAgentUiIntent({
      name: 'set_layer_visibility', args: { catalog_id: 'cmfd-precip-cn', visible: true },
    });
    expect(result.ok).toBe(true);
    expect(activeLayers.value.filter(l => l.visible).map(l => l.instanceId)).toEqual(['i1', 'other']);
  });

  it("toggles visibility on when requested", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_visibility",
      args: { catalog_id: "cmfd-precip-cn", visible: true },
    });
    expect(result.ok).toBe(true);
    expect(toggleLayerVisibility).toHaveBeenCalledWith("i1");
    expect(activeLayers.value[0]?.visible).toBe(true);
    expect(selectLayer).toHaveBeenCalledWith("i1");
    expect(result.message).not.toContain("只留这一层");
  });

  it.each(["i1", "other"])("hiding preserves the selected object %s and its timeline", async (selected) => {
    selectedInstanceId.value = selected;
    activeLayers.value[0]!.visible = true;
    const dateBefore = currentDate.value.getTime();
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_visibility",
      args: { catalog_id: "cmfd-precip-cn", visible: false },
    });
    expect(result.ok).toBe(true);
    expect(activeLayers.value[0]!.visible).toBe(false);
    expect(selectLayer).not.toHaveBeenCalled();
    expect(selectedInstanceId.value).toBe(selected);
    expect(currentDate.value.getTime()).toBe(dateBefore);
    expect(result.message).not.toContain("时间轴");
  });

  it("does not attach a stale date to a static layer receipt", async () => {
    activeLayers.value = [
      {
        instanceId: "cmfd",
        catalogId: "cmfd-precip-cn",
        visible: false,
        opacity: 1,
        name: "CMFD 区域降水",
      },
    ];
    // CMFD 这类刚导入的静态层在回执时可能尚无目录描述和 timeList；
    // 时间轴已按静态显示，回执必须同样不带旧日期。
    activeLayers.value[0]!.importedRaster = {};
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_visibility",
      args: { catalog_id: "cmfd-precip-cn", visible: true },
    });
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("时间维度");
    expect(result.message).not.toContain("时间轴仍停在");
  });

  it("uses instance_id to show the selected duplicate layer", async () => {
    activeLayers.value = [
      {
        instanceId: "vod-visible",
        catalogId: "fy-vod",
        visible: true,
        opacity: 1,
        name: "VOD",
      },
      {
        instanceId: "vod-hidden",
        catalogId: "fy-vod",
        visible: false,
        opacity: 1,
        name: "VOD",
      },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_visibility",
      args: { catalog_id: "fy-vod", instance_id: "vod-hidden", visible: true },
    });
    expect(result.ok).toBe(true);
    expect(toggleLayerVisibility).toHaveBeenCalledWith("vod-hidden");
    expect(activeLayers.value[1]?.visible).toBe(true);
  });

  it("adds layer when missing then shows it", async () => {
    activeLayers.value = [];
    layerLibrary.value = [{ catalogId: "dem-etopo", name: "地形" }];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_visibility",
      args: { catalog_id: "dem-etopo", visible: true },
    });
    expect(addLayer).toHaveBeenCalledWith("dem-etopo");
    expect(result.ok).toBe(true);
  });

  it("refuses to add when catalog is blocked", async () => {
    activeLayers.value = [];
    getCatalogAddBlockReason.mockReturnValueOnce("无权限");
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_visibility",
      args: { catalog_id: "secret-layer", visible: true },
    });
    expect(result.ok).toBe(false);
    expect(addLayer).not.toHaveBeenCalled();
  });

  it("sets opacity", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_layer_opacity",
      args: { catalog_id: "cmfd-precip-cn", opacity: 0.5 },
    });
    expect(result.ok).toBe(true);
    expect(setLayerOpacity).toHaveBeenCalledWith("i1", 0.5);
  });

  it("fits layer via handler", async () => {
    const fit = vi.fn(() => true);
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent(
      { name: "fit_layer", args: { catalog_id: "cmfd-precip-cn" } },
      { fitToLayerExtent: fit },
    );
    expect(result.ok).toBe(true);
    expect(fit).toHaveBeenCalledWith("i1");
  });

  it("lists active layers with names instead of opaque placeholder", async () => {
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "cmfd-precip-cn",
        visible: true,
        opacity: 1,
        name: "CMFD 降水",
      },
      {
        instanceId: "i2",
        catalogId: "admin-boundary",
        visible: true,
        opacity: 1,
        isAdminBoundary: true,
        name: "边界",
      },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "list_active_layers",
      args: {},
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("CMFD 降水");
    // 正文只给人看的中文名，内部 catalog_id 不进对话
    expect(result.message).not.toContain("cmfd-precip-cn");
    expect(result.message).not.toContain("已使用客户端活动图层上下文");
    expect(result.message).not.toContain("边界");
  });

  it("lists only checked layers when visible_only is requested", async () => {
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "shown",
        visible: true,
        opacity: 1,
        name: "已显示图层",
      },
      {
        instanceId: "i2",
        catalogId: "hidden",
        visible: false,
        opacity: 1,
        name: "隐藏图层",
      },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "list_active_layers",
      args: { visible_only: true },
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("已显示图层");
    expect(result.message).not.toContain("隐藏图层");
  });

  it("reports empty active layers clearly", async () => {
    activeLayers.value = [];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "list_active_layers",
      args: {},
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("没有活动图层");
  });

  it("handles fit_china and zoom_to_china intent via handler", async () => {
    const fitChina = vi.fn(() => true);
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res1 = await executeAgentUiIntent(
      { name: "fit_china", args: {} },
      { fitChina },
    );
    expect(res1.ok).toBe(true);
    expect(fitChina).toHaveBeenCalledTimes(1);
    expect(res1.message).toContain("中国全境");

    const res2 = await executeAgentUiIntent(
      { name: "zoom_to_china", args: {} },
      { fitChina },
    );
    expect(res2.ok).toBe(true);
    expect(fitChina).toHaveBeenCalledTimes(2);

    const resFail = await executeAgentUiIntent(
      { name: "fit_china", args: {} },
      {},
    );
    expect(resFail.ok).toBe(false);
  });

  it("handles locate_coordinate intent via handler", async () => {
    const locate = vi.fn(() => {
      currentMapCenter.value = { lng: 116.4074, lat: 39.9042 };
      currentMapZoom.value = 11;
      return true;
    });
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent(
      {
        name: "locate_coordinate",
        args: { lng: 116.4074, lat: 39.9042, zoom: 11 },
      },
      { locateCoordinate: locate },
    );
    expect(res.ok).toBe(true);
    expect(locate).toHaveBeenCalledWith(116.4074, 39.9042, 11);
    expect(res.message).toContain("116.4074");

    const resInvalid = await executeAgentUiIntent(
      { name: "locate_coordinate", args: { lng: "abc" } },
      { locateCoordinate: locate },
    );
    expect(resInvalid.ok).toBe(false);

    const resOutOfRange = await executeAgentUiIntent(
      { name: "locate_coordinate", args: { lng: 200, lat: 39 } },
      { locateCoordinate: locate },
    );
    expect(resOutOfRange.ok).toBe(false);
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("waits for real viewport state and reports cancellation without claiming arrival", async () => {
    currentMapCenter.value = { lng: 0, lat: 0 };
    currentMapZoom.value = 1;
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    let completed = false;
    const controller = new AbortController();
    const pending = executeAgentUiIntent(
      { name: "locate_coordinate", args: { lng: 120, lat: 30, zoom: 10 } },
      { locateCoordinate: () => true }, { signal: controller.signal },
    ).then(result => { completed = true; return result; });
    await Promise.resolve();
    expect(completed).toBe(false);
    controller.abort();
    expect((await pending).ok).toBe(false);
  });

  it("handles switch_basemap intent via handler", async () => {
    const setBasemap = vi.fn(() => true);
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent(
      { name: "switch_basemap", args: { basemap_id: "tianditu-img" } },
      { setBasemap },
    );
    expect(res.ok).toBe(true);
    expect(setBasemap).toHaveBeenCalledWith("tianditu-img");
    // source id 是内部标识，只用于调用 handler，不出现在给人看的文案里
    expect(res.message).not.toContain("tianditu-img");

    const resEmpty = await executeAgentUiIntent(
      { name: "switch_basemap", args: {} },
      { setBasemap },
    );
    expect(resEmpty.ok).toBe(false);

    const setBasemapFail = vi.fn(() => false);
    const resUnknown = await executeAgentUiIntent(
      { name: "switch_basemap", args: { basemap_id: "not-a-real-basemap" } },
      { setBasemap: setBasemapFail },
    );
    expect(resUnknown.ok).toBe(false);
    expect(setBasemapFail).toHaveBeenCalledWith("not-a-real-basemap");
  });

  it("sets timeline hour and date with local date label", async () => {
    selectedInstanceId.value = "i1";
    activeLayers.value = [{
      instanceId: "i1", catalogId: "plain-daily", name: "日尺度土壤水分", visible: false, opacity: 1,
      importedRaster: { timeList: ["20240601"] },
    }];
    applyDateHour.mockImplementation((d: Date, h: number) => {
      currentDate.value = d;
      currentHour.value = h;
    });
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "set_timeline",
      args: { hour: 8, date: "2024-06-01" },
    });
    expect(res.ok).toBe(true);
    expect(applyDateHour).toHaveBeenCalled();
    // Must use local YYYY-MM-DD, not toISOString().slice(0,10) (UTC shift)
    expect(res.message).toContain("2024-06-01");
    expect(res.message).not.toContain("T00:00");
  });

  it("reports the frame that actually shows when the day has data", async () => {
    selectedInstanceId.value = "i1";
    applyDateHour.mockImplementation((d: Date, h: number) => {
      currentDate.value = d;
      currentHour.value = h;
    });
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "imported-38993117b963",
        visible: true,
        opacity: 0.9,
        name: "土壤水分（SMAP 平均）",
        importedRaster: { timeList: ["20251201", "20251202", "20251203"] },
      },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "set_timeline",
      args: { date: "2025-12-02" },
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("2025-12-02");
    expect(res.message).toContain("土壤水分（SMAP 平均）");
    expect(res.message).not.toContain("imported-38993117b963");
    // The protection must use the actual runtime/imported layer identity.
    // The backend may have supplied a catalogue family id that differs from it.
    expect(pinTimelineAt).toHaveBeenCalledWith(
      "imported-38993117b963",
      expect.any(Date),
      expect.any(Number),
    );
  });

  it("says the day has no data instead of pretending it switched", async () => {
    selectedInstanceId.value = "i1";
    applyDateHour.mockImplementation((d: Date, h: number) => {
      currentDate.value = d;
      currentHour.value = h;
    });
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "imported-38993117b963",
        visible: true,
        opacity: 0.9,
        name: "土壤水分（SMAP 平均）",
        importedRaster: { timeList: ["20251201", "20251202", "20251203"] },
      },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "set_timeline",
      args: { date: "2025-12-20" },
    });
    // 该日不在帧清单里、且页面没接上取帧入口：必须明说「没接上」，
    // 不能再糊成「该日落在时间块内」——那会让人以为只是块粒度问题。
    expect(res.ok).toBe(false);
    expect(res.message).toContain("没接上");
    expect(res.message).toContain("2025-12-03");
  });

  it("fetches an on-demand frame when the day is outside the frame list", async () => {
    selectedInstanceId.value = "i1";
    applyDateHour.mockImplementation((d: Date, h: number) => {
      currentDate.value = d;
      currentHour.value = h;
    });
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "imported-38993117b963",
        visible: true,
        opacity: 0.9,
        name: "土壤水分（SMAP 平均）",
        importedRaster: { timeList: ["20251201", "20251202", "20251203"] },
      },
    ];
    const ensureOnDemandFrame = vi.fn(async () => ({
      ok: true,
      applied: true,
      cached: false,
    }));
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent(
      { name: "set_timeline", args: { date: "2025-12-20" } },
      { ensureOnDemandFrame },
    );
    expect(ensureOnDemandFrame).toHaveBeenCalledWith(
      "imported-38993117b963",
      expect.any(Date),
      expect.any(AbortSignal),
    );
    expect(res.ok).toBe(true);
    expect(res.message).not.toContain("单日图");
    expect(res.message).toContain("已从取数服务取得显示帧");
  });

  it("reports the fetch failure reason instead of pretending success", async () => {
    selectedInstanceId.value = "i1";
    applyDateHour.mockImplementation((d: Date, h: number) => {
      currentDate.value = d;
      currentHour.value = h;
    });
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "imported-38993117b963",
        visible: true,
        opacity: 0.9,
        name: "土壤水分（SMAP 平均）",
        importedRaster: { timeList: ["20251201", "20251202", "20251203"] },
      },
    ];
    const ensureOnDemandFrame = vi.fn(async () => ({
      ok: false,
      applied: false,
      cached: false,
      message: "NAS 成果不覆盖这一天",
    }));
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent(
      { name: "set_timeline", args: { date: "2025-12-20" } },
      { ensureOnDemandFrame },
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("2025-12-03");
    expect(res.message).toContain("该日没有可用的单日数据");
    expect(res.message).not.toContain("NAS");
  });


  it("asks for a target instead of using the visible layer with the longest dates", async () => {
    activeLayers.value = [
      { instanceId: "a", catalogId: "sm", name: "SM", visible: true, opacity: 1,
        importedRaster: { timeList: ["20250722", "20250723", "20250724"] } },
      { instanceId: "b", catalogId: "vod", name: "VOD", visible: true, opacity: 1,
        importedRaster: { timeList: ["20250722"] } },
    ];
    const before = JSON.stringify({ date: currentDate.value, memory: layerTimeMemory.value });
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({ name: "set_timeline", args: { date: "2025-07-23" } });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("needs_clarification");
    expect(result.message).toContain("当前没有唯一选中");
    expect(applyDateHour).not.toHaveBeenCalled();
    expect(setLayerTimeMemoryAt).not.toHaveBeenCalled();
    expect(JSON.stringify({ date: currentDate.value, memory: layerTimeMemory.value })).toBe(before);
  });

  it("an implicit date targets the selected hidden layer and preserves other memories and switches", async () => {
    activeLayers.value = [
      { instanceId: "a", catalogId: "sm", name: "SM", visible: true, opacity: 1,
        importedRaster: { timeList: ["20250701", "20250723", "20250731"] } },
      { instanceId: "b", catalogId: "vod", name: "VOD", visible: false, opacity: 1,
        importedRaster: { timeList: ["20250722", "20250723"] } },
    ];
    selectedInstanceId.value = "b";
    layerTimeMemory.value = { sm: { dateKey: "2025-07-31", hour: 6 }, vod: { dateKey: "2025-07-22", hour: 0 } };
    currentDate.value = new Date(2025, 6, 22);
    currentHour.value = 0;
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({ name: "set_timeline", args: { date: "2025-07-23" } });
    expect(result.ok).toBe(true);
    expect(currentDate.value.getDate()).toBe(23);
    expect(layerTimeMemory.value.vod).toEqual({ dateKey: "2025-07-23", hour: 0 });
    expect(layerTimeMemory.value.sm).toEqual({ dateKey: "2025-07-31", hour: 6 });
    expect(activeLayers.value.map(layer => layer.visible)).toEqual([true, false]);
    expect(selectLayer).not.toHaveBeenCalled();
    expect(toggleLayerVisibility).not.toHaveBeenCalled();
  });

  it("does not borrow another series when the selected layer is static", async () => {
    activeLayers.value = [
      { instanceId: "static", catalogId: "boundary", name: "边界", visible: false, opacity: 1, importedRaster: {} },
      { instanceId: "daily", catalogId: "sm", name: "SM", visible: true, opacity: 1,
        importedRaster: { timeList: ["20250722", "20250723"] } },
    ];
    selectedInstanceId.value = "static";
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({ name: "set_timeline", args: { date: "2025-07-23" } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("静态数据");
    expect(applyDateHour).not.toHaveBeenCalled();
    expect(setLayerTimeMemoryAt).not.toHaveBeenCalled();
  });

  it("rejects a date target whose product and instance disagree", async () => {
    activeLayers.value = [
      { instanceId: "a", catalogId: "sm", name: "SM", visible: true, opacity: 1,
        importedRaster: { timeList: ["20250723"] } },
      { instanceId: "b", catalogId: "vod", name: "VOD", visible: true, opacity: 1,
        importedRaster: { timeList: ["20250723"] } },
    ];
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_timeline", args: { catalog_id: "sm", instance_id: "b", date: "2025-07-23" },
    });
    expect(result.status).toBe("needs_clarification");
    expect(setLayerTimeMemoryAt).not.toHaveBeenCalled();
    expect(applyDateHour).not.toHaveBeenCalled();
  });

  it("does not report success when the current timeline refuses the requested date", async () => {
    activeLayers.value = [{ instanceId: "a", catalogId: "sm", name: "SM", visible: true, opacity: 1,
      importedRaster: { timeList: ["20250722", "20250723"] } }];
    selectedInstanceId.value = "a";
    currentDate.value = new Date(2025, 6, 22);
    currentHour.value = 0;
    applyDateHour.mockImplementationOnce(() => {});
    const fetchFrame = vi.fn(async () => ({ ok: true, applied: "20250723" }));
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_timeline", args: { catalog_id: "sm", date: "2025-07-23" },
    }, { ensureOnDemandFrame: fetchFrame });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("时间轴日期或小时没有按要求更新");
    expect(result.message).not.toContain("已切到");
    expect(currentDate.value.getDate()).toBe(22);
    expect(fetchFrame).not.toHaveBeenCalled();
  });


  it("rejects an acknowledged frame if its applied date belongs to another day", async () => {
    activeLayers.value = [{ instanceId: "a", catalogId: "sm", name: "SM", visible: true, opacity: 1,
      importedRaster: { timeList: ["20250701_20250731"] } }];
    selectedInstanceId.value = "a";
    const frames = useOnDemandFrameStore();
    frames.specs = { sm: { layer_id: "sm" } } as typeof frames.specs;
    const fetchFrame = vi.fn(async () => ({ ok: true, applied: "20250722" }));
    const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
    const result = await executeAgentUiIntent({
      name: "set_timeline", args: { catalog_id: "sm", date: "2025-07-23" },
    }, { ensureOnDemandFrame: fetchFrame });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("显示帧日期与请求日期不一致");
    expect(result.message).not.toContain("已切到");
  });

  it("toggles timeline playing", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const started = await executeAgentUiIntent({
      name: "set_timeline_playing",
      args: { playing: true },
    });
    expect(started.ok).toBe(true);
    expect(play).toHaveBeenCalled();
    const paused = await executeAgentUiIntent({
      name: "set_timeline_playing",
      args: { playing: false },
    });
    expect(paused.ok).toBe(true);
    expect(pause).toHaveBeenCalled();
  });

  it("accepts string booleans and rejects missing playing", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    // 模型偶尔把布尔写成字符串：旧实现 typeof !== 'boolean' 直接拒
    const asString = await executeAgentUiIntent({
      name: "set_timeline_playing",
      args: { playing: "true" },
    });
    expect(asString.ok).toBe(true);
    expect(play).toHaveBeenCalled();
    // 真没传必须仍当失败，不能被 strictBool 的 false 兜成「暂停」
    const missing = await executeAgentUiIntent({
      name: "set_timeline_playing",
      args: {},
    });
    expect(missing.ok).toBe(false);
  });

  it("removes layer when not running", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "remove_layer",
      args: { catalog_id: "cmfd-precip-cn" },
    });
    expect(res.ok).toBe(true);
    // 只从面板移除，不删后端产物（与侧栏 × 行为一致）
    expect(removeLayer).toHaveBeenCalledWith("i1", {
      deleteBackendFile: false,
    });
  });

  it("refuses remove when job is running", async () => {
    activeLayers.value = [
      {
        instanceId: "i1",
        catalogId: "cmfd-precip-cn",
        visible: true,
        opacity: 1,
        jobLayer: { status: "running" },
      },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "remove_layer",
      args: { catalog_id: "cmfd-precip-cn" },
    });
    expect(res.ok).toBe(false);
    expect(removeLayer).not.toHaveBeenCalled();
  });

  it("reorders layer to front", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "reorder_layer",
      args: { catalog_id: "cmfd-precip-cn", action: "front" },
    });
    expect(res.ok).toBe(true);
    expect(bringLayerToFront).toHaveBeenCalledWith("i1");
  });

  it("sets layer symbology palette and range", async () => {
    activeLayersDisplay.value = [
      { instanceId: "i1", renderHint: { palette: "thermal" } },
    ];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "set_layer_symbology",
      args: {
        catalog_id: "cmfd-precip-cn",
        palette: "viridis",
        vmin: 0,
        vmax: 10,
      },
    });
    expect(res.ok).toBe(true);
    expect(setLayerPaletteOverride).toHaveBeenCalledWith("i1", "viridis");
    expect(setLayerRangeOverride).toHaveBeenCalledWith("i1", {
      vmin: 0,
      vmax: 10,
    });
  });

  it("rejects an unknown palette instead of silently doing nothing", async () => {
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const res = await executeAgentUiIntent({
      name: "set_layer_symbology",
      args: { catalog_id: "cmfd-precip-cn", palette: "rainbow-ultra" },
    });
    // 旧实现：认不出来也照样落库，渲染时被兜底成默认色带 ⇒ 回执说「已换配色」但颜色没变
    expect(res.ok).toBe(false);
    expect(setLayerPaletteOverride).not.toHaveBeenCalled();
    expect(res.message).toContain("viridis");
  });

  it("rejects a half date instead of quietly picking a day", async () => {
    selectedInstanceId.value = "i1";
    activeLayers.value = [{
      instanceId: "i1", catalogId: "plain-daily", name: "日尺度土壤水分", visible: false, opacity: 1,
      importedRaster: { timeList: ["20251215"] },
    }];
    const { executeAgentUiIntent } =
      await import("@/components/agent/agent-ui-intent");
    const monthOnly = await executeAgentUiIntent({
      name: "set_timeline",
      args: { date: "2025-12" },
    });
    // new Date("2025-12") 会被宽松解析成 12-01，助手就会真的切到某一天
    expect(monthOnly.ok).toBe(false);
    expect(applyDateHour).not.toHaveBeenCalled();

    const noDash = await executeAgentUiIntent({
      name: "set_timeline",
      args: { date: "20251215" },
    });
    expect(noDash.ok).toBe(false);

    const okDash = await executeAgentUiIntent({
      name: "set_timeline",
      args: { date: "2025-12-15" },
    });
    expect(okDash.ok).toBe(true);
  });
});

it("named date writes only the target memory and preserves the original selection and clock", async () => {
  setActivePinia(createPinia());
  useOnDemandFrameStore().loaded = true;
  activeLayers.value = [
    {
      instanceId: "old",
      catalogId: "vod",
      name: "VOD",
      visible: true,
      opacity: 1,
      importedRaster: { timeList: ["20260702", "20260718"] },
    },
    {
      instanceId: "target",
      catalogId: "sm",
      name: "SM",
      visible: false,
      opacity: 1,
      importedRaster: { timeList: ["20260702", "20260718"] },
    },
  ];
  selectedInstanceId.value = "old";
  vi.clearAllMocks();
  const { executeAgentUiIntent } =
    await import("@/components/agent/agent-ui-intent");
  const result = await executeAgentUiIntent({
    name: "set_timeline",
    args: { catalog_id: "sm", date: "2026-07-18", hour: 6 },
  });
  expect(result.ok).toBe(true);
  expect(selectLayer).not.toHaveBeenCalled();
  expect(selectedInstanceId.value).toBe("old");
  expect(applyDateHour).not.toHaveBeenCalled();
  expect(pinTimelineAt).toHaveBeenCalledWith("sm", new Date(2026, 6, 18), 6);
  expect(setLayerTimeMemoryAt).toHaveBeenCalledWith(
    "sm",
    new Date(2026, 6, 18),
    6,
  );
  expect(setLayerTimeMemoryAt).not.toHaveBeenCalledWith(
    "vod",
    expect.anything(),
    expect.anything(),
  );
  expect(toggleLayerVisibility).not.toHaveBeenCalled();
});

it("uses a known local day outside remote coverage without reporting a fetch failure", async () => {
  setActivePinia(createPinia());
  const store = useOnDemandFrameStore();
  store.loaded = true;
  store.coverage = { start: "20250101", end: "20251231" };
  store.specs = { sm: { layer_id: "sm" } } as typeof store.specs;
  activeLayers.value = [{
    instanceId: "local-sm", catalogId: "sm", name: "SM", visible: true, opacity: 1,
    importedRaster: { timeList: ["20251201_20251231", "20260101"] },
  }];
  const fetchFrame = vi.fn().mockResolvedValue({ ok: false, message: "remote does not cover this date" });
  const { executeAgentUiIntent } = await import("@/components/agent/agent-ui-intent");
  const result = await executeAgentUiIntent({ name: "set_timeline", args: { catalog_id: "sm", date: "2026-01-01" } }, { ensureOnDemandFrame: fetchFrame });
  expect(result.ok).toBe(true);
  expect(result.message).toContain("本地已有显示帧");
  expect(store.dayTagFor("sm")).toBe("20260101");
  expect(fetchFrame).not.toHaveBeenCalled();
});
