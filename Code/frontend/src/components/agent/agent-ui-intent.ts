/**
 * 执行后端返回的 UI intent（地图状态仅在客户端）。
 */
import { nextTick, watch } from 'vue'
import type { AgentOperationTarget, AgentUiIntent } from '../../services/agent-api'
import { useLayerWorkspace, useLayerViewport } from '../../stores/layers/selectors'
import { isDefaultLayerOverlayId } from '../../stores/layers/default-layer-ids'
import { DEFAULT_LAYERS, probeOverlay } from '../../stores/layers/default-layers'
import { buildImportedRasterPayload } from '../../stores/layers/imported-raster'
import { useOnDemandFrameStore, toCompactDate } from '../../stores/layers/ondemand-frame'
import { useOverlaySymbologyStore } from '../../stores/overlay-symbology'
import { safeLog } from '../../stores/log'
import { useUiStore } from '../../stores/ui'
import {
  isMapLinkedPalette,
  resolveCanonicalPaletteIdStrict,
  WEATHER_PALETTE_OPTIONS,
} from '../map/layer-symbology'
import {
  formatLocalDateKey,
  layerDisplayName,
  readableFrameLabel,
  resolveEffectiveFrame,
} from './agent-chat-helpers'

export interface AgentUiIntentResult {
  status?: 'success' | 'failed' | 'not_executed' | 'needs_clarification' | 'pending'
  ok: boolean
  message: string
  /** Optional structured cards for UI (list/search results) */
  cards?: Array<{ catalog_id: string; title: string }>
  /** 后端分配的命令编号，与对话里的同一条指令对应（R02 可追溯） */
  commandId?: string
  resourceState?: 'ready' | 'loading' | 'failed' | 'unknown'
  target?: AgentOperationTarget
}

export interface AgentUiIntentHandlers {
  isMapReady?: () => boolean | undefined
  fitToLayerExtent?: (instanceId: string) => boolean
  fitChina?: () => boolean
  locateCoordinate?: (lng: number, lat: number, zoom?: number) => boolean
  /** 返回 true=已切换；返回字符串=失败原因（直接展示给用户）；false=未知原因失败 */
  setBasemap?: (sourceId: string) => boolean | string
  /**
   * 图层来源中文标签（SMAP / 风云卫星…），拿不到返回空。
   *
   * 用途：报告优先4 要求日期提示写成「SMAP · 土壤水分已切到 2025-12-15」，
   * 同时让「有哪些活动图层」不出现两个无法区分的同名图层。
   */
  resolveSourceLabel?: (catalogId: string) => string | null | undefined
  /**
   * 按需补帧：给「图层 + 日期」就去 NAS 取那天的单日图（2026-11-02）。
   *
   * 为什么必须由前端注入：这条能力本来只挂在「用户拖日历」上（useOnDemandFrame），
   * 助手切日期只写页面状态，于是画面停在整段块上，而统计走的又是单日 —— 两边口径分叉。
   * 返回真实结果（applied/cached），回执才能说「真切到了那天」，而不是猜。
   */
  ensureOnDemandFrame?: (
    catalogId: string,
    date: Date,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; applied?: string; cached?: boolean; message?: string }>
}

const ACTIVE_JOB = new Set(['queued', 'running', 'retry_pending', 'accepted'])

/**
 * 单条意图的执行选项（不落进 intent 本身：它是执行上下文，不是模型给的指令）。
 */
export interface AgentUiIntentOptions {
  signal?: AbortSignal
}

/** 等 NAS 取单日帧的上限：实测取一帧 4~6s，本地命中毫秒级；超了就如实说「正在取」 */
const ONDEMAND_AWAIT_MS = 20_000

/** Observe actual map state; a dispatched flyTo is not a completed location. */
async function waitForMapTarget(lng: number, lat: number, zoom: number | undefined, signal?: AbortSignal) {
  const viewport = useLayerViewport()
  const reached = () => Math.abs(viewport.currentMapCenter.value.lng - lng) < 0.0001
    && Math.abs(viewport.currentMapCenter.value.lat - lat) < 0.0001
    && (zoom == null || Math.abs(viewport.currentMapZoom.value - zoom) < 0.01)
  if (signal?.aborted) return false
  if (reached()) return true
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      stop()
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(ok)
    }
    const abort = () => finish(false)
    const stop = watch([viewport.currentMapCenter, viewport.currentMapZoom], () => {
      if (reached()) finish(true)
    }, { deep: true })
    const timer = setTimeout(() => finish(false), 8000)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 按需补帧的返回：`ok` 代表这一天的单日图真的落地了，不是「请求发出去过」。 */
export interface EnsureFrameResult {
  ok: boolean
  applied?: string
  cached?: boolean
  message?: string
  /** 这一帧的真实时间口径说明（ω 层不是当天观测时由后端给出，必须照说） */
  note?: string
}

export type OnDemandFrameProvider = (catalogId: string, date: Date, signal?: AbortSignal) => Promise<EnsureFrameResult>

/**
 * 模块级兜底：`DashboardView` 挂载时把 `ensureFrameForLayer` 注册进来。
 *
 * 为什么不只靠 prop 链（DashboardView → AgentCompanion → AgentChatPanel → handlers）：
 * 这条链有四跳，任何一跳漏传，现象都只是「回执说该日落在时间块内」——
 * 与「这天本来就只有整段块」长得一模一样，根本分不出是没接上还是真没帧。
 * 2026-11-02 用户第二次实测就撞在这里。寄存器直连，props 只当可选覆盖。
 */
let onDemandFrameProvider: OnDemandFrameProvider | null = null

export function registerOnDemandFrameProvider(fn: OnDemandFrameProvider | null): void {
  onDemandFrameProvider = fn
}

function resolveOnDemandFrame(handlers: AgentUiIntentHandlers): OnDemandFrameProvider | null {
  return handlers.ensureOnDemandFrame ?? onDemandFrameProvider
}

/** A cancelled/timed-out frame must not commit a late response to the map. */
async function withFrameDeadline(provider: OnDemandFrameProvider, id: string, date: Date,
  signal?: AbortSignal): Promise<EnsureFrameResult | null> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      provider(id, date, controller.signal),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null) }, ONDEMAND_AWAIT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** 游客回执只说业务结果，不暴露接口、存储服务、文件名或 HTTP 细节。 */
function friendlyFrameFailure(message?: string): string {
  const raw = String(message ?? '')
  if (/不覆盖|没有.*(?:成果|数据|文件)|无可用/.test(raw)) {
    return '该日没有可用的单日数据'
  }
  return '单日数据暂时无法取得，具体原因已记录到系统日志'
}

function resolveInstanceId(
  catalogId: string | undefined,
  instanceId: string | undefined,
): { instanceId: string | null; catalogId: string | null; ambiguous?: string[] } {
  const workspace = useLayerWorkspace()
  const layers = workspace.activeLayers.value
  if (instanceId) {
    const byId = layers.find((l) => l.instanceId === instanceId)
    if (byId) return { instanceId: byId.instanceId, catalogId: byId.catalogId }
  }
  if (catalogId) {
    const matches = layers.filter((l) => l.catalogId === catalogId)
    if (matches.length > 1) return { instanceId: null, catalogId, ambiguous: matches.map(l => l.name || l.instanceId) }
    const byCat = matches[0]
    if (byCat) return { instanceId: byCat.instanceId, catalogId: byCat.catalogId }
    // 2026-10-22：助手（大模型）常把「中文显示名」甚至「图层组名」当成 catalog_id 传过来，
    // 精确匹配必然落空，用户看到的就是「隐藏/改透明度没反应」。这里按显示名兜底：
    // 唯一命中才采纳；命中多个则回报候选，绝不猜。
    const raw = catalogId.trim()
    if (raw) {
      const hits = layers.filter((l) => {
        const name = String(l.name ?? '').trim()
        if (!name || l.isAdminBoundary) return false
        return name === raw || name.includes(raw) || raw.includes(name)
      })
      if (hits.length === 1) {
        return { instanceId: hits[0].instanceId, catalogId: hits[0].catalogId }
      }
      if (hits.length > 1) {
        return {
          instanceId: null,
          catalogId: null,
          ambiguous: hits.map((l) => String(l.name ?? l.catalogId)),
        }
      }
    }
  }
  return { instanceId: null, catalogId: catalogId ?? null }
}

/** 意图文案里的图层称呼：中文名优先，绝不把 catalog_id 甩给用户。 */
function nameOf(catalogId: string | null | undefined, explicit?: unknown): string {
  const workspace = useLayerWorkspace()
  return layerDisplayName(
    catalogId,
    workspace.activeLayers.value.map((l) => ({
      catalogId: l.catalogId,
      name: l.name,
    })),
    explicit == null ? workspace.resolveEffectiveDescriptor?.(String(catalogId || ''))?.display_name || null : String(explicit),
  )
}

/**
 * 「来源 · 图层名」的写法（报告优先4 的固定模板：SMAP · 土壤水分）。
 *
 * 拿不到来源就原样返回图层名——绝不编造，也不把内部 id 顶上去；
 * 图层名本身已含来源（如「风云卫星 土壤水分」）时不重复加前缀。
 */
function withSource(
  handlers: AgentUiIntentHandlers,
  catalogId: string | null | undefined,
  title: string,
): string {
  let source: string
  try {
    source = String(handlers.resolveSourceLabel?.(String(catalogId || '')) || '').trim()
  } catch {
    return title
  }
  if (!source || source === '未标注来源' || !title) return title
  if (title.includes(source)) return title
  return `${source} · ${title}`
}

/**
 * 图层不在面板里时的统一说法。
 *
 * 旧版一律回「未找到可定位的图层」，用户不知道是名字没对上、还是这层压根没添加。
 * 后者才是常见情况：助手只能操作「已添加」的层，用户得先去左侧图层库添加。
 */
function notOnPanelMessage(catalogId: string | undefined, action: string): string {
  const resolved = catalogId ? nameOf(catalogId) : ''
  const label = resolved && resolved !== '该图层' ? `「${resolved}」` : '这条指令指定的图层'
  return `${label}现在不在图层面板里，无法${action}。请先在左侧图层库把它添加出来，然后再说一次。`
}

/**
 * 严格布尔解析。
 *
 * 模型偶尔把布尔参数写成字符串，而 `Boolean("false") === true`——用户说
 * 「隐藏这一层」，实际执行成「显示」，还不报错，事后极难查。
 * 只认 true / "true" / "1" / 1，其余（含 "false"、缺省）一律 false。
 */
function strictBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/**
 * 「同一变量」的归一化键：剥掉「来源 · 」前缀与括号备注，只留变量名本身
 * （土壤水分 / 植被光学厚度 / 等效散射 ω）。
 *
 * 2026-11-03 用户报障：他手动勾着「SMAP 平均·土壤水分」，助手下发「显示
 * SMAP 动态·土壤水分」后，两层同时亮着——上面那层把下面完全盖住，看上去
 * 跟没切换一模一样（其实切了，只是没撤旧的）。
 * 一个像素只能显示一个值，同变量两层同显没有任何观测价值 ⇒ 必须互斥。
 */
function variableKeyOf(displayName: string): string {
  return String(displayName || '')
    .replace(/^[\s\S]*?·\s*/, '') // 去掉「SMAP · 」这类来源前缀
    .replace(/（[^）]*）|\([^)]*\)/g, '') // 去掉括号里的补充说明
    .replace(/\s+/g, '')
    .trim()
}

/**
 * 图层当前生效的量程（用户覆盖值优先，其次 meta 里的原始量程）。
 *
 * 只用于回执说实话：「量程没动，还是 0 到 1.5」这种话里的数字不能编。
 * 拿不到就返回 null，调用方只说「量程没动」而不给数值。
 */
function currentRangeOf(
  catalogId: string | null | undefined,
): { vmin: number | null; vmax: number | null } | null {
  const id = String(catalogId || '').trim()
  if (!id) return null
  const workspace = useLayerWorkspace()
  const layer = workspace.activeLayers.value.find((l) => l.catalogId === id)
  let metaVmin: number | null = null
  let metaVmax: number | null = null
  try {
    const meta = useOverlaySymbologyStore().getMeta(id)
    metaVmin = typeof meta?.vmin === 'number' ? meta.vmin : null
    metaVmax = typeof meta?.vmax === 'number' ? meta.vmax : null
  } catch {
    /* store 未就绪时按「无 meta」处理，不编数字 */
  }
  const vmin = typeof layer?.vminOverride === 'number' ? layer.vminOverride : metaVmin
  const vmax = typeof layer?.vmaxOverride === 'number' ? layer.vmaxOverride : metaVmax
  if (vmin == null && vmax == null) return null
  return { vmin, vmax }
}

function formatRange(r: { vmin: number | null; vmax: number | null } | null): string {
  if (!r) return ''
  // 只有一端时不要输出「? 到 1」这种半截话 —— 回执里出现问号，用户只会更糊涂
  if (r.vmin == null && r.vmax == null) return ''
  if (r.vmin == null) return `上限 ${r.vmax}`
  if (r.vmax == null) return `下限 ${r.vmin}`
  return `${r.vmin} 到 ${r.vmax}`
}

/**
 * 收起要撤掉的图层，返回被收起的层（带来源，回执要用）。
 *
 * 两种口径：
 *   - 默认（solo=false）只动**同一变量**的其他可见层——VOD / ω 和别的产品组一律
 *     保持原样，用户可能正拿它们做对比，顺手关掉比不关更烦人。
 *   - solo=true 用户说了「只 / 仅 / 单独」，清场：除目标层外全部收起。
 *
 * 两种口径都跳过行政区边界（那是底图，关掉就没参照了）和锁在计算组里的层
 * （runGroupLocked，工作流占位，半路摘掉会把组的状态弄乱）。
 * 被跳过的层要一并返回：solo 回执若写死「省界保留」，而实际还有计算中的层
 * 亮着，那句「只显示」就是不准确的。
 */
function hideConflictingLayers(
  workspace: ReturnType<typeof useLayerWorkspace>,
  handlers: AgentUiIntentHandlers,
  target: { instanceId: string; catalogId: string; name?: string },
  solo: boolean,
): { closed: string[]; kept: string[] } {
  const targetKey = solo ? '' : variableKeyOf(nameOf(target.catalogId, target.name))
  if (!solo && !targetKey) return { closed: [], kept: [] }
  const closed: string[] = []
  const kept: string[] = []
  for (const other of workspace.activeLayers.value) {
    if (other.instanceId === target.instanceId) continue
    if (!other.visible) continue
    if (other.isAdminBoundary) continue
    const otherName = nameOf(other.catalogId, other.name)
    if (other.runGroupLocked) {
      // solo 时这些层本来要收，但计算中的层不能动 ⇒ 如实记下「保留」
      if (solo) kept.push(withSource(handlers, other.catalogId, otherName))
      continue
    }
    if (!solo && variableKeyOf(otherName) !== targetKey) continue
    workspace.toggleLayerVisibility(other.instanceId)
    closed.push(withSource(handlers, other.catalogId, otherName))
  }
  return { closed, kept }
}

/**
 * 挑一个「用来核对日期的时间序列图层」。
 *
 * 顺序（报告第二轮 A06：回执说切到 12-15、页面却停在 01-31，就是因为
 * 回执拿「帧数最多的可见图层」算，而页面按「选中/目标图层」渲染）：
 *   ① 指令里点名的目标图层 → ② 当前选中图层 → ③ 唯一可见带帧图层 → ④ 帧数最多
 * 时间轴本身不做吸附，吸附发生在渲染层，必须拿真实 time_list 才能算准。
 */
function pickDominantTimeseries(target?: {
  catalogId?: string | null
  instanceId?: string | null
}): {
  catalogId: string
  name: string
  list: string[]
} | null {
  const workspace = useLayerWorkspace()
  const layers = workspace.activeLayers.value
  const asSeries = (layer: (typeof layers)[number]) => {
    const list = layer.importedRaster?.timeList
    if (!Array.isArray(list) || !list.length) return null
    return {
      catalogId: layer.catalogId,
      name: layerDisplayName(layer.catalogId, [{ catalogId: layer.catalogId, name: layer.name }]),
      list: list.map((t) => String(t)),
    }
  }

  const wantCatalog = String(target?.catalogId ?? '').trim()
  const wantInstance = String(target?.instanceId ?? '').trim()
  if (wantCatalog || wantInstance) {
    const hit = wantInstance
      ? layers.find((l) => l.instanceId === wantInstance)
      : layers.find((l) => l.catalogId === wantCatalog)
    if (hit) {
      const series = asSeries(hit)
      if (series) return series
    }
    return null
  }

  const selectedId = String(workspace.selectedInstanceId.value ?? '').trim()
  if (selectedId) {
    const hit = layers.find((l) => l.instanceId === selectedId)
    if (hit) {
      const series = asSeries(hit)
      if (series) return series
    }
  }

  let best: ReturnType<typeof asSeries> = null
  let visibleCount = 0
  for (const layer of layers) {
    if (layer.visible === false) continue
    if (layer.isAdminBoundary) continue
    const series = asSeries(layer)
    if (!series) continue
    visibleCount += 1
    if (!best || series.list.length > best.list.length) best = series
  }
  // 只有一个可见带帧图层时直接用；多个才退化成「帧数最多」的近似
  if (best && visibleCount >= 1) return best
  return null
}

/**
 * 切层之后等时间轴落定，再把「页面真实停在哪天」读回来（2026-11-04）。
 *
 * 为什么必须等：切层改日期这段逻辑挂在 `useTimelineSync` 的 watcher 上
 * （先按 `cgda.timeline.layer-memory` 恢复记忆日期，记忆日无覆盖时再 snap 到最新切片），
 * 是「选中某个层之后才发生」的异步动作。意图函数如果立刻 return，读到的还是切换前的
 * 旧日期 —— 这正是「页面已跳到 2026-02-02、助手却回『仍停在 2025-12-15』」的根因。
 *
 * 只轮询「日期是否还在变」，不用固定 sleep：静态图层（无 time_list）约 40ms 就返回。
 */
async function waitForTimelineSettle(maxMs = 900): Promise<void> {
  const ui = useUiStore()
  // 至少放过两轮 Vue 更新：watcher 本身要跑，跑完才会改 currentDate
  await nextTick()
  await nextTick()
  const started = Date.now()
  let last = ui.currentDate.getTime()
  let steady = 0
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const now = ui.currentDate.getTime()
    if (now === last) {
      steady += 1
      if (steady >= 3) return
    } else {
      steady = 0
      last = now
    }
  }
}

/**
 * 等新加图层的元数据就绪（2026-11-11 用户复测第 3 条）。
 *
 * `addLayer` 只同步建出实例壳子，`importedRaster`（bounds / time_list / native_step）
 * 是随后异步回来的。旧实现加完立刻往下走，于是：
 *   - 同一条回复里排着的 `set_timeline` 绑到了「元数据还没到」的实例上；
 *   - `pickDominantTimeseries` 找不到这层的时间序列，退化成「帧数最多的可见层」，
 *     日期就切到了**别的图层**上——正是用户说的「误用原先选中的图层」。
 * 这里最多等 `maxMs`，就绪或超时都返回（超时不阻塞，不让页面卡住）。
 */
async function waitForLayerMetadata(instanceId: string | undefined, maxMs = 1500): Promise<boolean> {
  if (!instanceId) return false
  const workspace = useLayerWorkspace()
  const started = Date.now()
  await nextTick()
  while (Date.now() - started < maxMs) {
    const layer = workspace.activeLayers.value.find((l) => l.instanceId === instanceId)
    if (!layer) return false
    // 目录层 / 矢量层本来就没有 importedRaster，不该等
    if (layer.dataState !== 'imported') return true
    const raster = layer.importedRaster
    if (raster && (raster.bounds || (raster.timeList && raster.timeList.length))) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** One add path for list-only add and show, including removed registered rasters. */
async function ensureAgentLayerAdded(
  catalogId: string, displayName: unknown,
  options: { visible: boolean; select: boolean; signal?: AbortSignal },
): Promise<{ instanceId?: string; existed: boolean; error?: AgentUiIntentResult }> {
  const workspace = useLayerWorkspace()
  const checkCancelled = () => options.signal?.throwIfAborted()
  checkCancelled()
  let resolved = resolveInstanceId(catalogId, undefined)
  if (resolved.ambiguous?.length) return { existed: false, error: {
    ok: false, status: 'needs_clarification', message: '匹配到多个图层，请明确产品、版本或变量。',
  } }
  let existing = workspace.activeLayers.value.find(layer => layer.instanceId === resolved.instanceId)
  const imported = catalogId.startsWith('imported-')
  if (existing && (!imported || existing.importedRaster)) return { instanceId: existing.instanceId, existed: true }
  const block = workspace.getCatalogAddBlockReason?.(catalogId)
  if (block) return { existed: Boolean(existing), error: { ok: false, status: 'not_executed', message: block } }
  const descriptor = workspace.resolveEffectiveDescriptor?.(catalogId)
  const libraryItem = workspace.layerLibrary.value.find(layer => layer.catalogId === catalogId)
  const available = Boolean(libraryItem || descriptor || isDefaultLayerOverlayId(catalogId))
  if (!available || descriptor?.run_readiness === 'blocked' || ['placeholder', 'disabled'].includes(descriptor?.status ?? '')) {
    return { existed: Boolean(existing), error: { ok: false, status: 'not_executed',
      message: `${nameOf(catalogId, displayName)} 当前不可添加：${descriptor?.run_readiness_summary || '未找到已开放的数据产品'}` } }
  }
  if (imported) {
    const metadata = await probeOverlay(catalogId)
    // A cancelled or superseded request may finish probing, but cannot mutate UI.
    checkCancelled()
    if (!metadata?.bounds || !metadata.bounds.every(Number.isFinite)
      || metadata.bounds[0] >= metadata.bounds[2] || metadata.bounds[1] >= metadata.bounds[3]) {
      return { existed: Boolean(existing), error: { ok: false, status: 'failed', resourceState: 'failed',
        message: `未能取得「${nameOf(catalogId, displayName)}」的有效栅格元数据，图层可能不存在或资源服务暂不可用；未添加占位图层。` } }
    }
    // Initialization or another action may have attached it while metadata loaded.
    resolved = resolveInstanceId(catalogId, undefined)
    existing = workspace.activeLayers.value.find(layer => layer.instanceId === resolved.instanceId)
    if (existing?.importedRaster) return { instanceId: existing.instanceId, existed: true }
    const fallbackName = DEFAULT_LAYERS.flatMap(group => group.members).find(member => member.overlayId === catalogId)?.label
    const label = String(displayName || descriptor?.display_name || libraryItem?.name || fallbackName || '').trim()
    if (!label || label === catalogId) return { existed: Boolean(existing), error: {
      ok: false, status: 'not_executed', message: '缺少可确认的产品名称，未添加图层。',
    } }
    checkCancelled()
    if (existing) {
      // Repair a legacy catalog-only shell without duplicating it or resetting
      // its focus, switch, custom name or remembered time.
      existing.importedRaster = buildImportedRasterPayload(catalogId, {
        bounds: metadata.bounds, timeList: metadata.timeList, defaultTime: metadata.defaultTime,
        nativeStep: metadata.nativeStep, fileName: label,
      })
      existing.dataState = 'imported'
      if (!existing.name || existing.name === catalogId) existing.name = label
      workspace.scheduleWorkspacePersist?.()
      return { instanceId: existing.instanceId, existed: true }
    }
    const layer = workspace.addImportedRasterLayer(label, catalogId, metadata.bounds, {
      timeList: metadata.timeList, defaultTime: metadata.defaultTime, nativeStep: metadata.nativeStep,
      visible: options.visible, select: options.select,
    })
    return { instanceId: layer.instanceId, existed: false }
  }
  if (options.visible && options.select) workspace.addLayer(catalogId)
  else workspace.addLayer(catalogId, false, undefined, {
    visible: options.visible, select: options.select, skipAutoRun: !options.visible,
  })
  await nextTick()
  checkCancelled()
  const instanceId = resolveInstanceId(catalogId, undefined).instanceId ?? undefined
  return { instanceId, existed: false }
}

/** Follow the actual layer/job, not the acknowledgement that an add was accepted. */
async function waitForLayerResource(instanceId: string, signal?: AbortSignal, maxMs = 8000) {
  const workspace = useLayerWorkspace()
  const read = () => {
    const layer = workspace.activeLayers.value.find(l => l.instanceId === instanceId)
    if (!layer) return { state: 'failed' as const, message: '目标图层已被移除' }
    const job = layer.jobLayer
    if (job?.status === 'failed' || job?.status === 'cancelled') return { state: 'failed' as const, message: job.message || '图层数据加载失败' }
    if (job && ACTIVE_JOB.has(job.status)) return { state: 'loading' as const, message: '数据仍在加载中' }
    if (job?.status === 'succeeded') return { state: 'ready' as const, message: '数据加载成功' }
    if (layer.importedRaster?.bounds || layer.importedVector || layer.isAdminBoundary) return { state: 'unknown' as const, message: '图层资源信息已就绪，实际渲染尚未核实' }
    return { state: 'unknown' as const, message: '尚未确认数据加载完成' }
  }
  await nextTick()
  const initial = read()
  if (initial.state !== 'loading' || signal?.aborted) return initial
  return new Promise<ReturnType<typeof read>>(resolve => {
    const finish = () => { stop(); clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(read()) }
    const stop = watch(() => read(), value => { if (value.state !== 'loading') finish() }, { deep: true })
    const timer = setTimeout(finish, maxMs)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * 点名的图层是否是「静态数据」（没有时间维度），是则返回它的显示名。
 *
 * 判据按可信度排序：图层库条目 `supportsTime === false` / updateLabel 含「静态」 /
 * 栅格元数据已到手但 time_list 为空。三者都不满足（含「元数据还没回来」）返回 null，
 * 表示不能断定是静态 —— 宁可不说，也不能把「还没加载完」说成「静态」。
 */
function resolveStaticTimelineTarget(catalogId: string, instanceId: string): string | null {
  if (!catalogId && !instanceId) return null
  const workspace = useLayerWorkspace()
  const layer = instanceId
    ? workspace.activeLayers.value.find((l) => l.instanceId === instanceId)
    : workspace.activeLayers.value.find((l) => l.catalogId === catalogId)
  const target = layer?.catalogId || catalogId
  if (!target) return null
  const raster = layer?.importedRaster
  // 只认「timeList 是数组」这一明确状态：有时序 → 不是静态；
  // timeList 还没赋值（undefined）说明元数据在路上，此时什么都不能断定。
  const list = raster?.timeList
  if (Array.isArray(list) && list.length > 0) return null
  const lib = (workspace.layerLibrary?.value || []).find((i) => i.catalogId === target)
  const label = layer?.name || lib?.name || target
  // Use the same authoritative runtime descriptor as the timeline.  A layer
  // added from the catalogue (CMFD is the common case) may not have its
  // library entry or raster timeList populated yet, while the timeline has
  // already determined it is static from `supports_time` / granularity.
  const descriptor = workspace.resolveEffectiveDescriptor?.(target)
  if (descriptor?.supports_time === true || lib?.supportsTime === true) return null
  const descriptorGranularity =
    (descriptor as { time_granularity?: string; timeGranularity?: string } | null)
      ?.time_granularity ||
    (descriptor as { time_granularity?: string; timeGranularity?: string } | null)?.timeGranularity
  if (descriptorGranularity === 'static' || descriptor?.supports_time === false) return label
  if (lib?.supportsTime === false) return label
  if (String(lib?.updateLabel || '').includes('静态')) return label
  // 与时间轴保持一致：导入栅格只有在已经拿到非空 timeList 时才是时序层。
  // 否则时间轴已按静态层渲染，回执也必须停止沿用其他图层的旧日期。
  if (raster) return label
  return null
}

function parseDateArg(raw: unknown): Date | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  /**
   * 只认「年月日」三段的写法。
   *
   * 旧实现失败后会把字符串丢给 `new Date(s)`，而它对 `2025-12`、`2025` 这种
   * 残缺输入是宽松解析的：前者补成 12-01、后者补成 01-01。用户说「切到 12 月」，
   * 助手却真的切到了某一天，还不解释 —— 属于静默改日期，必须拒掉让他说清哪天。
   */
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (!m) return null
  {
    const y = Number(m[1])
    const mo = Number(m[2])
    const day = Number(m[3])
    const d = new Date(y, mo - 1, day)
    /**
     * 回检：JS 的 Date 会把越界值自动进位 —— `2025-02-30` 变成 3 月 1 日、
     * `2025-13-01` 变成 12 月 31 日。旧实现直接返回这个 Date，于是助手会
     * 一本正经地回「已切到 2025-03-01」，用户以为在看自己说的那天。
     * 构造后必须逐项对回去，不一致就当无效输入拒掉。
     */
    if (
      Number.isNaN(d.getTime()) ||
      d.getFullYear() !== y ||
      d.getMonth() !== mo - 1 ||
      d.getDate() !== day
    ) {
      return null
    }
    return d
  }
}

export async function executeAgentUiIntent(
  intent: AgentUiIntent,
  handlers: AgentUiIntentHandlers = {},
  options: AgentUiIntentOptions = {},
): Promise<AgentUiIntentResult> {
  if (options.signal?.aborted) return {
    ok: false, status: 'not_executed', message: '用户已取消，未执行本操作。',
  }
  const workspace = useLayerWorkspace()
  const findTarget = () => workspace.activeLayers.value.find(l =>
    intent.args.instance_id ? l.instanceId === intent.args.instance_id : l.catalogId === intent.args.catalog_id)
  const beforeVisible = findTarget()?.visible
  let result: AgentUiIntentResult
  try {
    result = await executeAgentUiIntentCore(intent, handlers, options)
  } catch (error) {
    const target = findTarget()
    const changed = intent.name === 'set_layer_visibility' && target && target.visible !== beforeVisible
      ? `已${target.visible ? '勾选' : '取消勾选'}「${nameOf(target.catalogId, target.name)}」；` : ''
    result = { ok: false, status: options.signal?.aborted ? 'not_executed' : 'failed', message: options.signal?.aborted
      ? `操作已中止；${changed}已发生的图层或日期变化保留，后续取数未确认完成。`
      : `操作失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const commandId = String(intent.command_id ?? '').trim()
  const enriched: AgentUiIntentResult = commandId ? { ...result, commandId } : result
  // R02：命令与其「实际执行结果」用同一个编号串起来，失败也要记
  safeLog(
    'agent-cmd',
    `${commandId || 'cmd-?'} ${intent.name} → ${enriched.status === 'pending' ? '加载中' : enriched.status === 'not_executed' ? '未执行或已中止' : enriched.ok ? '成功' : '失败'}`,
    JSON.stringify({
      target: describeIntentTarget(intent),
      message: enriched.message,
    }).slice(0, 400),
    enriched.ok ? 'info' : 'warn',
  )
  return enriched
}

/** 指令目标的可读摘要（只用于日志，不参与执行） */
function describeIntentTarget(intent: AgentUiIntent): string {
  const args = intent.args ?? {}
  const pick = (keys: string[]): string => {
    for (const k of keys) {
      const v = args[k]
      if (v != null && String(v).trim() !== '') return String(v).trim()
    }
    return ''
  }
  const hit = pick([
    'lng',
    'lon',
    'longitude',
    'latitude',
    'lat',
    'catalog_id',
    'layer_id',
    'name',
    'date',
    'time',
    'source_id',
  ])
  if (hit) return hit
  const raw = JSON.stringify(args)
  return raw && raw !== '{}' ? raw.slice(0, 80) : '-'
}

async function executeAgentUiIntentCore(
  intent: AgentUiIntent,
  handlers: AgentUiIntentHandlers = {},
  options: AgentUiIntentOptions = {},
): Promise<AgentUiIntentResult> {
  const workspace = useLayerWorkspace()
  const ui = useUiStore()
  const name = intent.name
  const args = intent.args ?? {}
  const checkCancelled = () => options.signal?.throwIfAborted()
  checkCancelled()

  if (name === 'add_layer' || name === 'select_layer') {
    const catalogId = String(args.catalog_id ?? '').trim()
    const instanceId = args.instance_id != null ? String(args.instance_id).trim() : undefined
    if (!catalogId && !instanceId) return { ok: false, message: '未提供明确的图层目标。' }
    let resolved = resolveInstanceId(catalogId || undefined, instanceId)
    if (resolved.ambiguous?.length) return { ok: false, status: 'needs_clarification',
      message: `匹配到多个图层（${resolved.ambiguous.join('、')}），请明确卫星来源、版本或变量。` }
    const previousSelection = workspace.selectedInstanceId.value
    let existed = Boolean(resolved.instanceId)
    if (!resolved.instanceId) {
      if (name === 'select_layer') return { ok: false, status: 'not_executed',
        message: notOnPanelMessage(catalogId, '选中') }
      const added = await ensureAgentLayerAdded(catalogId, args.display_name, {
        visible: false, select: false, signal: options.signal,
      })
      if (added.error) return added.error
      existed = added.existed
      resolved = resolveInstanceId(catalogId, added.instanceId)

    }
    if (name === 'add_layer' && catalogId.startsWith('imported-')
      && !workspace.activeLayers.value.find(l => l.instanceId === resolved.instanceId)?.importedRaster) {
      const repaired = await ensureAgentLayerAdded(catalogId, args.display_name, {
        visible: false, select: false, signal: options.signal,
      })
      if (repaired.error) return repaired.error
      resolved = resolveInstanceId(catalogId, repaired.instanceId)
    }
    const layer = workspace.activeLayers.value.find(l => l.instanceId === resolved.instanceId)
    if (!layer) return { ok: false, message: `未能添加或找到「${nameOf(catalogId, args.display_name)}」。` }
    const target: AgentOperationTarget = { catalog_id: layer.catalogId, instance_id: layer.instanceId,
      name: nameOf(layer.catalogId, args.display_name || layer.name) }
    const label = withSource(handlers, layer.catalogId, target.name!)
    workspace.setSidebarView('active')
    if (name === 'add_layer') {
      if (!existed && (layer.visible || workspace.selectedInstanceId.value !== previousSelection)) {
        return { ok: false, status: 'failed', target, message: `「${label}」已加入列表，但显隐或选中状态与添加要求不一致，请检查页面。` }
      }
      return { ok: true, target, resourceState: 'unknown',
        message: existed
          ? `「${label}」已在图层列表中，保留原有选中、显隐和日期。`
          : `已将「${label}」加入图层列表，当前隐藏；未改变选中对象，尚未加载显示数据。` }
    }
    const visibleBefore = layer.visible
    workspace.selectLayer(layer.instanceId)
    await waitForTimelineSettle()
    checkCancelled()
    const actual = workspace.activeLayers.value.find(l => l.instanceId === layer.instanceId)
    if (!actual || workspace.selectedInstanceId.value !== layer.instanceId || actual.visible !== visibleBefore) {
      return { ok: false, status: 'failed', target, message: `未能按要求选中「${label}」并保留显隐状态，请检查页面。` }
    }
    // Selection is independent of resource loading, especially for hidden layers.
    return { ok: true, target, resourceState: 'unknown',
      message: `已选中「${label}」，${actual.visible ? '保持勾选显示' : '当前隐藏，未勾选显示'}` }
  }

  if (name === 'set_layer_visibility') {
    const catalogId = String(args.catalog_id ?? '').trim()
    const instanceIdArg = args.instance_id != null ? String(args.instance_id).trim() : undefined
    const visible = strictBool(args.visible)
    if (!catalogId) return { ok: false, message: '缺少 catalog_id' }
    if (visible) {
      const descriptor = workspace.resolveEffectiveDescriptor?.(catalogId)
      if (descriptor?.run_readiness === 'blocked' || ['placeholder', 'disabled'].includes(descriptor?.status ?? '')) {
        return { ok: false, status: 'not_executed', message: `${nameOf(catalogId, args.display_name)} 当前不可用：${descriptor?.run_readiness_summary || '数据服务未开放或未就绪'}` }
      }
    }

    let resolved = resolveInstanceId(catalogId, instanceIdArg)
    if (resolved.ambiguous?.length) {
      return {
        ok: false, status: 'needs_clarification',
        message: `「${catalogId}」匹配到多个图层（${resolved.ambiguous.join('、')}），请说得更具体一点`,
      }
    }
    if (!resolved.instanceId) {
      // 2026-10-22 修正：隐藏一个当前不在地图上的图层时，绝不能「顺手把它加上」——
      // 用户看到的是「已隐藏」，实际地图上反而多出一层。只有「显示」才允许自动添加。
      if (!visible) {
        return {
          ok: false,
          message: `当前地图上没有「${nameOf(catalogId, args.display_name)}」，无需隐藏`,
        }
      }
      const added = await ensureAgentLayerAdded(catalogId, args.display_name, {
        visible: true, select: true, signal: options.signal,
      })
      if (added.error) return added.error
      // Wait on the actual attached instance, never create an imported catalog shell.
      const ready = await waitForLayerMetadata(added.instanceId)
      checkCancelled()
      if (!ready) return { ok: false, message: `「${nameOf(catalogId, args.display_name)}」已添加，但资源信息尚未就绪；后续依赖步骤未执行。` }
      resolved = resolveInstanceId(catalogId, added.instanceId)
    }
    if (!resolved.instanceId) {
      // 不再回「无法添加「该图层」」——名字都没解析出来，说这句等于没说
      const known = nameOf(catalogId, args.display_name)
      return {
        ok: false,
        message:
          known && known !== '该图层'
            ? `没能把「${known}」加到地图上，请从左侧图层库手动添加后再试`
            : '没有在图层库里找到这一层，可能名字对不上。请从左侧图层库点选后再告诉我。',
      }
    }
    if (visible && catalogId.startsWith('imported-')
      && !workspace.activeLayers.value.find(l => l.instanceId === resolved.instanceId)?.importedRaster) {
      const repaired = await ensureAgentLayerAdded(catalogId, args.display_name, {
        visible: true, select: true, signal: options.signal,
      })
      if (repaired.error) return repaired.error
      resolved = resolveInstanceId(catalogId, repaired.instanceId)
    }
    checkCancelled()
    const layer = workspace.activeLayers.value.find((l) => l.instanceId === resolved.instanceId)
    if (!layer) {
      return {
        ok: false,
        message: '这一层没能在图层面板里建起来（可能刚被移除），请刷新后再试',
      }
    }
    if (layer.visible !== visible) {
      workspace.toggleLayerVisibility(resolved.instanceId!)
    }
    if (visible) workspace.selectLayer(resolved.instanceId!)
    workspace.setSidebarView('active')
    /**
     * ★ 2026-11-04 修：切层会触发时间轴按图层记忆跳转，而那是**异步**的
     * （useTimelineSync 的 watcher）。不等它落定就读日期，读到的是切换前的旧值，
     * 回执必然说错日期 —— 用户看到「页面已跳到 2026-02-02，助手却说仍停在 2025-12-15」。
     * 先等时间轴稳住，再用页面真实日期拼回执。
     */
    await waitForTimelineSettle()
    checkCancelled()
    const actual = workspace.activeLayers.value.find(l => l.instanceId === resolved.instanceId)
    if (!actual || actual.visible !== visible) return { ok: false, message: '显隐状态未按要求改变，请检查图层是否正在计算或已被移除。' }
    if (visible && workspace.selectedInstanceId.value !== actual.instanceId) {
      return { ok: false, message: '目标图层已勾选，但未能设为当前选中图层，请检查页面。' }
    }
    // Visibility and selection restore this layer's remembered time. Their
    // receipt must not describe an unrequested date change.
    const label = nameOf(catalogId, args.display_name || layer.name)
    if (!visible) {
      return { ok: true, message: `已隐藏「${label}」` }
    }
    const resource = await waitForLayerResource(layer.instanceId, options.signal)
    checkCancelled()
    const prefix = `已勾选「${label}」`
    if (resource.state === 'failed') return { ok: false, status: 'failed', resourceState: 'failed', message: `${prefix}，但数据加载失败：${resource.message}` }
    if (resource.state === 'loading') return { ok: false, status: 'pending', resourceState: 'loading', message: `${prefix}，数据仍在加载中，尚不能确认完成。` }
    const resourceHint = `；${resource.message}${handlers.isMapReady?.() === false ? '；地图尚未就绪，未确认实际渲染' : ''}`
    // 只有用户明确说「只显示 / 仅显示 / 单独显示」才允许收起其他层。
    // 普通「显示 X」是加显示，不得悄悄改变 VOD 等其他图层状态。
    const solo = strictBool(args.solo)
    const { closed, kept } = solo
      ? hideConflictingLayers(
          workspace,
          handlers,
          {
            instanceId: layer.instanceId,
            catalogId,
            name: args.display_name ? String(args.display_name) : layer.name,
          },
          true,
        )
      : { closed: [], kept: [] }
    const shown = withSource(handlers, catalogId, label)
    const brief = (names: string[]): string =>
      names.length <= 3
        ? names.map((n) => `「${n}」`).join('')
        : `${names
            .slice(0, 3)
            .map((n) => `「${n}」`)
            .join('')} 等 ${names.length} 个`
    if (solo) {
      // Verify the final checked set, not just attempted toggle calls.
      // Administrative boundaries keep their existing background-layer policy.
      await nextTick()
      checkCancelled()
      const finalLayers = workspace.activeLayers.value
      const finalTarget = finalLayers.find(l => l.instanceId === resolved.instanceId)
      const remaining = finalLayers.filter(l =>
        l.instanceId !== resolved.instanceId && !l.isAdminBoundary && l.visible !== false,
      )
      if (!finalTarget || finalTarget.visible === false) {
        return { ok: false, status: 'failed', resourceState: resource.state,
          message: `未完成只显示「${shown}」：目标图层未保持勾选；请查看当前图层状态。` }
      }
      if (remaining.length) {
        const names = remaining.map(l => withSource(handlers, l.catalogId, nameOf(l.catalogId, l.name)))
        return { ok: false, status: 'failed', resourceState: resource.state,
          message: `未完成只显示「${shown}」：目标已勾选，但仍有 ${remaining.length} 个其他数据图层勾选（${brief(names)}）；${kept.length ? '计算中的图层保留未动；' : ''}请查看图层状态。` }
      }
      if (!closed.length) {
        return {
          ok: true,
          resourceState: resource.state, message: `已勾选显示「${shown}」，当前没有其他勾选图层${resourceHint}`,
        }
      }
      // 被跳过的层要照实说：边界是底图性质，「只显示」仍留着它；
      // 计算中的层不能摘，也要让用户知道地图上不止一层。
      // 目标自身就是边界层时要排除，否则会出现「已只显示「省界」……省界保留」这种自我矛盾。
      const hasBoundary = workspace.activeLayers.value.some(
        (l) => l.isAdminBoundary && l.visible !== false && l.instanceId !== resolved.instanceId,
      )
      const notes: string[] = []
      if (hasBoundary) notes.push('省界保留')
      if (kept.length) notes.push(`正在计算的 ${kept.length} 层保留未动`)
      const tail = notes.length ? `，${notes.join('，')}` : ''
      return {
        ok: true,
        resourceState: resource.state, message: `已只勾选「${shown}」，关掉了另外 ${closed.length} 层（${brief(closed)}）${tail}${resourceHint}`,
      }
    }
    // 非「只显示」指令不得关闭任何其它图层；即使未来某个调用方错误地
    // 传回了 closed，也不能把普通的「显示 X」说成「只留这一层」。
    // 这类回执会让用户误以为 VOD 等图层被隐藏，实际页面状态反而无法核验。
    return { ok: true, resourceState: resource.state, message: `已勾选显示「${shown}」${resourceHint}` }
  }

  if (name === 'set_layer_opacity') {
    const catalogId = String(args.catalog_id ?? '').trim()
    const raw = Number(args.opacity)
    if (!catalogId || Number.isNaN(raw)) {
      return { ok: false, message: '缺少 catalog_id 或 opacity' }
    }
    /**
     * 模型可能把「透明度调到 50%」直接传成 50。旧实现走 clamp(0,1) 静默截成 1，
     * 用户要的是半透明、结果是完全不透明，还以为自己没说清。
     * 这里按百分数折算并明确回报；超过 100 直接拒绝，不猜。
     */
    if (raw < 0 || raw > 100) {
      return {
        ok: false,
        message: `透明度 ${raw} 超出范围：请用 0~1，或用 0~100 表示百分比`,
      }
    }
    const asPercent = raw > 1
    const opacity = asPercent ? raw / 100 : raw
    const resolved = resolveInstanceId(catalogId, undefined)
    if (resolved.ambiguous?.length) {
      return {
        ok: false,
        message: `「${catalogId}」匹配到多个图层（${resolved.ambiguous.join('、')}），请说得更具体一点`,
      }
    }
    if (!resolved.instanceId) {
      const opLabel = nameOf(catalogId, args.display_name)
      return {
        ok: false,
        message:
          opLabel && opLabel !== '该图层'
            ? `「${opLabel}」还没在图层列表里`
            : '没找到你说的这一层，它可能还没添加到图层面板',
      }
    }
    const clamped = Math.max(0, Math.min(1, opacity))
    workspace.setLayerOpacity(resolved.instanceId, clamped)
    return {
      ok: true,
      message: `已把「${nameOf(catalogId, args.display_name)}」的不透明度设为 ${Math.round(
        clamped * 100,
      )}%${asPercent ? '（按百分数换算）' : ''}`,
    }
  }

  if (name === 'fit_layer') {
    const catalogId = args.catalog_id != null ? String(args.catalog_id).trim() : undefined
    const instanceIdArg = args.instance_id != null ? String(args.instance_id).trim() : undefined
    const resolved = resolveInstanceId(catalogId, instanceIdArg)
    if (!resolved.instanceId) {
      return { ok: false, message: notOnPanelMessage(catalogId ?? instanceIdArg, '缩放') }
    }
    const ok = handlers.fitToLayerExtent?.(resolved.instanceId) ?? false
    const fitLabel = nameOf(resolved.catalogId, args.display_name)
    return ok
      ? { ok: true, message: `已缩放到「${fitLabel}」` }
      : { ok: false, message: `「${fitLabel}」暂无可用显示范围` }
  }

  if (name === 'list_active_layers') {
    const visibleOnly = strictBool(args.visible_only) === true
    const allLayers = workspace.activeLayers.value.filter((l) => !l.isAdminBoundary)
    const layers = visibleOnly ? allLayers.filter((l) => l.visible !== false) : allLayers
    if (!layers.length) {
      // 只有边界时不能说「没有活动图层」——用户侧栏明明有东西，会觉得助手眼瞎
      const onlyBoundary = workspace.activeLayers.value.some((l) => l.isAdminBoundary)
      return {
        ok: true,
        message: onlyBoundary
          ? '当前只有行政区边界，没有数据图层。可先在左侧图层库添加图层。'
          : visibleOnly
            ? '当前没有勾选显示的数据图层。'
            : '当前没有活动图层。可先在左侧图层库添加图层。',
        cards: [],
      }
    }
    const cards = layers.map((l) => ({
      catalog_id: l.catalogId,
      title: (l.name || l.catalogId || '').trim() || l.catalogId,
    }))
    // 正文只列中文名 + 显示状态；catalog_id 只留在 cards 里供点击复用
    // 来源前缀用于区分同名图层（两个「土壤水分」分属 SMAP 与风云卫星）。
    const lines = layers.map((l) => {
      const title = layerDisplayName(l.catalogId, [{ catalogId: l.catalogId, name: l.name }])
      const vis = l.visible === false ? '已隐藏' : '显示中'
      return `- ${withSource(handlers, l.catalogId, title)}（${vis}）`
    })
    return {
      ok: true,
      message: visibleOnly
        ? `当前有 ${layers.length} 个勾选显示图层：\n${lines.join('\n')}`
        : `当前有 ${layers.length} 个活动图层：\n${lines.join('\n')}`,
      cards,
    }
  }

  if (name === 'fit_china' || name === 'zoom_to_china') {
    const ok = handlers.fitChina?.() ?? false
    return ok
      ? { ok: true, message: '已缩放到中国全境范围' }
      : { ok: false, message: '无法缩放到中国范围（地图未就绪）' }
  }

  if (name === 'locate_coordinate' || name === 'fly_to_location' || name === 'fly_to') {
    const rawLng = args.lng ?? args.longitude ?? args.lon
    const rawLat = args.lat ?? args.latitude
    const lng = Number(rawLng)
    const lat = Number(rawLat)
    const zoom = args.zoom != null ? Number(args.zoom) : undefined

    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      return { ok: false, message: '缺少有效的经纬度坐标 (lng, lat)' }
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return { ok: false, message: '经纬度超出有效范围 (lng∈[-180,180], lat∈[-90,90])' }
    }

    const ok = handlers.locateCoordinate?.(lng, lat, zoom) ?? false
    if (!ok) return { ok: false, message: '无法定位到指定坐标（地图未就绪）' }
    if (!await waitForMapTarget(lng, lat, zoom, options.signal)) {
      return { ok: false, message: options.signal?.aborted
        ? '已取消等待地图定位；已发出的地图移动可能仍在进行。'
        : '已发出地图移动请求，但未确认视图到达目标位置。' }
    }
    const action = args.view_action === '放大' || args.view_action === '缩小' ? args.view_action : null
    return { ok: true, message: action
      ? `已${action}地图，当前缩放级别 ${zoom?.toFixed(1)}`
      : `已定位到经纬度 (${lng.toFixed(4)}, ${lat.toFixed(4)})` }
  }

  if (name === 'switch_basemap' || name === 'set_basemap') {
    const sourceId = String(args.basemap_id ?? args.source_id ?? args.id ?? args.style ?? '').trim()
    if (!sourceId) {
      return { ok: false, message: '缺少底图标识 (basemap_id / source_id)' }
    }
    const result = handlers.setBasemap?.(sourceId)
    // 底图 source id 是内部标识，正文不点名，后端回复会给出中文底图名。
    // 2026-10-22：切换失败要说明原因（缺密钥 / 无此底图），不再一律回「切换失败」。
    if (result === true) return { ok: true, message: '底图已切换' }
    if (typeof result === 'string') return { ok: false, message: result }
    // 只说「切换失败」用户没法自救；也不列 source id（内部标识不进正文）
    return {
      ok: false,
      message:
        '没有切换底图：这个底图名我这边对不上。可以换个说法，比如「换成卫星影像」「换成矢量地图」「换成路网地图」',
    }
  }

  if (name === 'set_timeline') {
    const explicitInstanceId = String(args.instance_id ?? '').trim()
    if (explicitInstanceId && !workspace.activeLayers.value.some(l => l.instanceId === explicitInstanceId)) {
      return { ok: false, status: 'not_executed',
        message: '指定图层实例已失效或已被移除，未改动任何图层日期或时间轴；请重新指定目标。' }
    }
    const hasHour = args.hour != null && args.hour !== ''
    const hasDate = args.date != null && String(args.date).trim() !== ''
    if (!hasHour && !hasDate) {
      return { ok: false, message: '请提供 hour（0–23）和/或 date（YYYY-MM-DD）' }
    }
    const explicitCatalogId = String(args.catalog_id ?? args.layer_id ?? '').trim()
    const requestedTarget = resolveInstanceId(
      explicitCatalogId || undefined,
      explicitInstanceId || (!explicitCatalogId ? workspace.selectedInstanceId.value || undefined : undefined),
    )
    if (requestedTarget.ambiguous?.length) return { ok: false, status: 'needs_clarification',
      message: `日期目标匹配多个图层（${requestedTarget.ambiguous.join('、')}），请明确产品和版本。` }
    if (!requestedTarget.instanceId || !requestedTarget.catalogId) {
      return { ok: false, status: explicitCatalogId || explicitInstanceId ? 'not_executed' : 'needs_clarification',
        message: explicitCatalogId || explicitInstanceId
          ? '未找到指定的日期目标图层，没有改动图层日期或时间轴。'
          : '当前没有唯一选中的图层，请先选中一个图层或补充产品和版本；日期未改动。' }
    }
    if (explicitCatalogId && explicitInstanceId && requestedTarget.catalogId !== explicitCatalogId) {
      return { ok: false, status: 'needs_clarification',
        message: '指定的产品与图层实例不一致，请重新确认日期目标；日期未改动。' }
    }
    const remembered = requestedTarget.catalogId ? ui.layerTimeMemory[requestedTarget.catalogId] : undefined
    let hour = remembered?.hour ?? ui.currentHour
    if (hasHour) {
      hour = Number(args.hour)
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return { ok: false, message: 'hour 须为 0–23 的整数' }
      }
    }
    let targetDate = remembered ? parseDateArg(remembered.dateKey) || new Date(ui.currentDate) : new Date(ui.currentDate)
    if (hasDate) {
      const d = parseDateArg(args.date)
      if (!d) return { ok: false, message: 'date 格式无效，请用 YYYY-MM-DD' }
      targetDate = d
    }

    // ★ 2026-10-28 修：写入页面状态必须推迟到「所有校验都通过之后」。
    // 旧实现在这里就先 applyDateHour/setHour 再往下判定，一旦命中
    // `!eff`（目标日没有任何时间帧）就返回 ok:false —— 但日期已经改掉了，
    // 于是界面同时出现「✗ 执行失败」和「时间轴确实变了」两种相反的信号。
    // 现在改成 commit()：只有确定能落帧（或确知没有时序图层可校验）才落盘，
    // 失败分支保持页面原状，零副作用（不写 localStorage、不触发重绘）。
    let clockChanged = false
    const commit = async (resolvedCatalogId?: string): Promise<void> => {
      checkCancelled()
      const requestedId = String(resolvedCatalogId ?? requestedTarget.catalogId)
      const target = workspace.activeLayers.value.find(l =>
        l.instanceId === requestedTarget.instanceId && l.catalogId === requestedId)
      if (!target) {
        throw new Error('指定图层在执行期间已失效，未改动日期或时间轴。')
      }
      // A named date edits its own memory. It must not select it, restore another
      // layer's memory, or lend the current clock to an unrelated target.
      if (target) ui.setLayerTimeMemoryAt(target.catalogId, targetDate, hour)
      clockChanged = workspace.selectedInstanceId.value === target.instanceId
      if (clockChanged) {
        if (hasDate) ui.applyDateHour(targetDate, hour)
        else ui.setHour(hour)
      }
      // The latest explicit target time must also replace its prior short-lived
      // restore pin. A noncurrent target keeps the global clock unchanged, but
      // an older pin must not later restore an obsolete date over this memory.
      if (requestedId) ui.pinTimelineAt(requestedId, targetDate, hour)
      await waitForTimelineSettle()
      checkCancelled()
      if (target) {
        const actual = ui.layerTimeMemory[target.catalogId]
        if (!actual || actual.dateKey !== formatLocalDateKey(targetDate) || actual.hour !== hour) {
          throw new Error('目标图层的记忆日期未按要求更新，未确认数据切换成功。')
        }
        if (clockChanged && workspace.selectedInstanceId.value === target.instanceId
          && (formatLocalDateKey(ui.currentDate) !== formatLocalDateKey(targetDate) || ui.currentHour !== hour)) {
          throw new Error('目标图层的时间轴日期或小时没有按要求更新，未确认数据切换成功。')
        }
      }
    }

    // 2026-11-11 用户复测第 3 条：点名的层若是静态数据（如 CMFD 区域降水），
    // 没有时间维度可切。旧实现会落到下面的兜底分支回「时间轴已设为 X」——报成功、
    // 画面却毫无变化；更糟的是 pickDominantTimeseries 会退到「帧数最多的可见层」，
    // 日期被切到**别的图层**上，正是用户说的「误用原先选中的图层」。
    // 这里先认目标层：确认静态就明确说不支持，且一点状态都不改。
    const namedStatic = resolveStaticTimelineTarget(
      requestedTarget.catalogId,
      requestedTarget.instanceId,
    )
    if (namedStatic) {
      return {
        ok: false,
        message: `「${namedStatic}」是静态数据，没有时间维度，不支持切换日期（时间轴保持不变）`,
      }
    }
    // 时间轴只负责「选中某个时刻」，真正的帧是渲染层按切片挑的。
    // 这里提前算出会落到哪一帧，如实回报，避免「切到 12-15」实际放的是 12-03。
    // Bind the exact explicit or selected instance, never another visible series.
    const dominant = pickDominantTimeseries({
      catalogId: requestedTarget.catalogId,
      instanceId: requestedTarget.instanceId,
    })
    if (!dominant) {
      return { ok: false, status: 'not_executed',
        message: '未找到目标图层可核实的时间序列，图层日期和时间轴没有改动。' }
    }
    const eff = resolveEffectiveFrame(dominant.list, targetDate, hour)
    if (!eff) {
      // 目标日确实没有可用帧 ⇒ 不写任何状态，页面保持原样
      return {
        ok: false,
        message: `${formatLocalDateKey(targetDate)} 没有可用数据：${dominant.name} 还没有任何时间帧（时间轴未改动）`,
      }
    }
    // Pin the catalog id that the page actually resolved and is about to render,
    // rather than only the catalogue id supplied by the backend.
    const ondemandStore = useOnDemandFrameStore()
    if (!ondemandStore.loaded) await ondemandStore.ensureLoaded()
    checkCancelled()
    const supportsOnDemand = ondemandStore.isOnDemandLayer(dominant.catalogId)
    const localDay = toCompactDate(targetDate)
    const hasLocalDay = supportsOnDemand && dominant.list.includes(localDay)
    // Local frames are authoritative even outside the remote service's coverage.
    // Set the override before the clock watcher runs, so monthly nativeStep cannot
    // replace this known day with its composite block.
    if (hasLocalDay) ondemandStore.setDayTag(dominant.catalogId, localDay)
    await commit(dominant.catalogId)
    await nextTick()
    const requested = formatLocalDateKey(targetDate)
    const dateState = clockChanged ? '日期控件' : '目标图层记忆日期'
    if (!ondemandStore.loaded) {
      return { ok: false, message: `${dateState}已调整到 ${requested}，但未能读取单日数据资源状态，无法确认目标日期的数据已更新；请在资源服务恢复后重试。` }
    }
    const span = `${readableFrameLabel(dominant.list[0])} 至 ${readableFrameLabel(
      dominant.list[dominant.list.length - 1],
    )}`
    // 报告优先4：成功提示用固定模板「来源 · 图层名已切到 YYYY-MM-DD」，
    // 有来源就写成 `SMAP · 土壤水分已切到 2025-12-15`，没来源退回「土壤水分」。
    const dominantLabel = withSource(handlers, dominant.catalogId, String(args.display_name || dominant.name))
    const shownName = dominantLabel === dominant.name ? `「${dominant.name}」` : dominantLabel
    const isBlock = String(eff.key ?? '').includes('_')
    /**
     * 2026-11-02：这里原来直接回「该日落在时间块内（无独立逐日帧）」。
     * 但用户手动拖到同一天是能出单日图的 —— 因为拖日历会走 useOnDemandFrame 去 NAS 取那一帧，
     * 而助手切日期只写页面状态。用户把「让助手切日期」理解成「替他点日历」，
     * 那两条路就必须共用同一条取帧链路，否则统计（按单日算）和画面（按整段块显示）永远对不上。
     * 所以：没有独立单日帧可落时，先按同一入口去取；取到就报单日，取不到才回落旧说法并说原因。
     */
    if (hasLocalDay) {
      return { ok: true, message: `${shownName}已切到 ${requested}（本地已有显示帧）` }
    }
    // Even a locally cached day needs the same override as dragging the calendar:
    // monthly nativeStep otherwise prefers its composite block over a daily frame.
    if (supportsOnDemand || !eff.nativeMatch) {
      const ensureFrame = resolveOnDemandFrame(handlers)
      if (ensureFrame) {
        const fetched = await withFrameDeadline(ensureFrame, dominant.catalogId, targetDate, options.signal)
        checkCancelled()
        const fallback = isBlock ? `该图层仍对应时间块 ${eff.label}` : `该图层实际帧为 ${eff.label}`
        if (fetched?.ok) {
          if (typeof fetched.applied === 'string'
            && fetched.applied.replace(/-/g, '') !== localDay) {
            return { ok: false, status: 'failed',
              message: '目标图层记忆日期已调整，但取回的显示帧日期与请求日期不一致，未确认数据切换成功。' }
          }
          const actualTime = ui.layerTimeMemory[dominant.catalogId]
          const currentTarget = workspace.selectedInstanceId.value === requestedTarget.instanceId
          if (!actualTime || actualTime.dateKey !== requested
            || (currentTarget && (formatLocalDateKey(ui.currentDate) !== requested || ui.currentHour !== hour))) {
            return { ok: false, status: 'failed',
              message: '取数返回后目标图层的日期状态已变化，未确认本次日期切换成功；请查看当前图层和日期。' }
          }
          /**
           * ω 层「按天取」拿到的不是当天观测（平均组是日序气候态、动态组是 8 天块）。
           * 后端把口径写在 `note` 里，这里必须原样带上，且**不能再说「单日图」**
           * —— 说成单日图就是口径欺骗（2026-11-05）。
           */
          const basisNote = String(fetched.note || '').trim()
          if (basisNote) {
            return {
              ok: true,
              message: `${shownName}已切到 ${requested}（${
                fetched.cached ? '本地已有' : '刚从取数服务取得'
              }）。${basisNote}`,
            }
          }
          return {
            ok: true,
            // 按需渲染成功只证明浏览器取得了可显示帧；统计工具仍可能按原生
            // 月/多日时间块取数。这里不能越过后端时间口径，误称“单日图”。
            message: `${shownName}已切到 ${requested}（${
              fetched.cached ? '本地已有显示帧' : '已从取数服务取得显示帧'
            }）`,
          }
        }
        if (fetched && !fetched.ok) {
          // 日期控件变化但数据没换，整体按失败回报；底层错误只进日志，不给游客看。
          return {
            ok: false,
            message: `${dateState}已调整到 ${requested}，但${shownName}的数据没有切换成功：${friendlyFrameFailure(
              fetched.message,
            )}。${fallback}`,
          }
        }
        // 超时不能报成功；只说明尚未确认完成，不暴露内部取数位置。
        return {
          ok: false,
          message: `${dateState}已调整到 ${requested}，但${shownName}的单日数据尚未取得，地图是否切换成功暂时无法确认`,
        }
      }
      /**
       * 没有取帧入口。以前这里会落到下面「该日落在时间块内（无独立逐日帧）」，
       * 把「功能没接上」说成「这天本来就只有块」——用户没法分辨，只能反复反馈同一件事。
       * 现在直接说清是页面没接上，并给出唯一的自救动作。
       */
      return {
        ok: false,
        message: `${dateState}已调整到 ${requested}，但数据未换：这一页没接上「按天取数」入口（页面可能是旧版本），请按 Ctrl+Shift+R 强制刷新后再试。地图目前仍是 ${eff.label}`,
      }
    }
    if (eff.nativeMatch) {
      // 报告第二轮 P2：时间块 ≠ 逐日帧，回执必须说清是「落在块内」还是「真切到了那一天」。
      if (isBlock) {
        return {
          ok: true,
          message: `${shownName}已切到 ${requested}，该日落在时间块 ${eff.label} 内（无独立逐日帧）`,
        }
      }
      // 报告优先4：动作成功也要给「图层 + 具体日期」的确定说法，
      // 不能只丢一个笼统的覆盖区间（否则用户不知道到底切到哪天）。
      const frameHint = eff.label && eff.label !== requested ? `（实际命中帧 ${eff.label}）` : ''
      return {
        ok: true,
        message: `${shownName}已切到 ${requested}${frameHint}`,
      }
    }
    return {
      ok: true,
      message: `${shownName}已设为 ${requested}，但该日没有数据，实际显示的是 ${eff.label}\n（可用范围是 ${span}，已自动对齐到最近可用帧）`,
    }
  }

  if (name === 'set_timeline_playing') {
    // 与其他布尔参数统一口径：模型偶尔把 true 写成字符串 "true"，
    // 旧实现对非布尔直接报「缺少 playing: boolean」，「开始播放」这种简单指令
    // 就莫名其妙失败。但仍要保留「真没传」的判定，否则缺省会被当成暂停。
    const given = args.playing != null && String(args.playing).trim() !== ''
    if (!given) {
      return { ok: false, message: '缺少 playing（true 表示开始播放，false 表示暂停）' }
    }
    const playing = strictBool(args.playing)
    if (playing) ui.play()
    else ui.pause()
    return {
      ok: true,
      message: playing ? '已开始时间轴播放' : '已暂停时间轴播放',
    }
  }

  if (name === 'remove_layer') {
    const catalogId = args.catalog_id != null ? String(args.catalog_id).trim() : undefined
    const instanceIdArg = args.instance_id != null ? String(args.instance_id).trim() : undefined
    const resolved = resolveInstanceId(catalogId, instanceIdArg)
    if (!resolved.instanceId) {
      return { ok: false, message: notOnPanelMessage(catalogId ?? instanceIdArg, '移除') }
    }
    const layer = workspace.activeLayers.value.find((l) => l.instanceId === resolved.instanceId)
    if (!layer) return { ok: false, message: '未找到可移除的图层' }
    const removeLabel = nameOf(resolved.catalogId, args.display_name || layer.name)
    const status = layer.jobLayer?.status
    if (status && ACTIVE_JOB.has(status)) {
      return {
        ok: false,
        message: `「${removeLabel}」还有进行中的任务（${status}），请先取消再移除`,
      }
    }
    // 只从面板移除，不删后端产物（与侧栏 × 行为一致）。
    // 默认四组的「移除」是否写持久化名单，已统一在 removeLayer 内部按 overlay 判定；
    // 这里只负责提示语：默认图层刷新后会自动加载回来。
    const isDefaultMember = isDefaultLayerOverlayId(layer.importedRaster?.overlayLayerId)
    workspace.removeLayer(resolved.instanceId, { deleteBackendFile: false })
    if (isDefaultMember) {
      return {
        ok: true,
        message: `已从图层面板移除「${removeLabel}」（默认图层，刷新后会随默认四组自动加载回来）`,
      }
    }
    return { ok: true, message: `已从图层面板移除「${removeLabel}」（数据文件保留）` }
  }

  if (name === 'reorder_layer') {
    const action = String(args.action ?? '')
      .trim()
      .toLowerCase()
    if (action !== 'front' && action !== 'back') {
      return { ok: false, message: 'action 须为 front 或 back' }
    }
    const catalogId = args.catalog_id != null ? String(args.catalog_id).trim() : undefined
    const instanceIdArg = args.instance_id != null ? String(args.instance_id).trim() : undefined
    const resolved = resolveInstanceId(catalogId, instanceIdArg)
    if (!resolved.instanceId) {
      return { ok: false, message: notOnPanelMessage(catalogId ?? instanceIdArg, '调整层级') }
    }
    if (action === 'front') workspace.bringLayerToFront(resolved.instanceId)
    else workspace.sendLayerToBack(resolved.instanceId)
    const reorderLabel = nameOf(resolved.catalogId, args.display_name)
    return {
      ok: true,
      message:
        action === 'front'
          ? `已把「${reorderLabel}」移到最上层`
          : `已把「${reorderLabel}」移到最下层`,
    }
  }

  if (name === 'set_layer_symbology') {
    const catalogId = args.catalog_id != null ? String(args.catalog_id).trim() : undefined
    const instanceIdArg = args.instance_id != null ? String(args.instance_id).trim() : undefined
    const resolved = resolveInstanceId(catalogId, instanceIdArg)
    if (!resolved.instanceId) {
      return { ok: false, message: notOnPanelMessage(catalogId ?? instanceIdArg, '改配色') }
    }
    const display = workspace.activeLayersDisplay.value.find(
      (l) => l.instanceId === resolved.instanceId,
    )
    const layer = workspace.activeLayers.value.find((l) => l.instanceId === resolved.instanceId)
    const hasRenderHint = Boolean(display?.renderHint?.palette || display?.jobLayer)
    const supportsRecolor = Boolean(
      (layer as { supportsRecolor?: boolean } | undefined)?.supportsRecolor ||
      (display as { supportsRecolor?: boolean } | undefined)?.supportsRecolor ||
      layer?.importedRaster,
    )
    if (
      !isMapLinkedPalette({
        hasRenderHint,
        supportsRecolor,
        isImportedRaster: Boolean(layer?.importedRaster),
      })
    ) {
      return { ok: false, message: '该图层不支持前端调色板/拉伸（可能为烘焙 PNG）' }
    }
    const hasPalette = args.palette != null && String(args.palette).trim() !== ''
    const hasVmin = args.vmin != null && args.vmin !== ''
    const hasVmax = args.vmax != null && args.vmax !== ''
    if (!hasPalette && !hasVmin && !hasVmax) {
      return { ok: false, message: '请提供 palette 和/或 vmin/vmax' }
    }
    // ── 先全部校验、再落库：避免「配色改了、量程被判无效」这种半成品状态 ──
    const before = currentRangeOf(resolved.catalogId ?? catalogId)
    const patch: { vmin?: number; vmax?: number } = {}
    if (hasVmin) {
      const v = Number(args.vmin)
      if (Number.isNaN(v)) return { ok: false, message: 'vmin 无效' }
      patch.vmin = v
    }
    if (hasVmax) {
      const v = Number(args.vmax)
      if (Number.isNaN(v)) return { ok: false, message: 'vmax 无效' }
      patch.vmax = v
    }
    /**
     * 量程填反会渲染成全黑或全白，而且不会报错——用户只会觉得「图坏了」。
     * 两端都给了就互相比；只给一端就跟现有另一端比。
     */
    const badOrder =
      patch.vmin != null && patch.vmax != null
        ? patch.vmin >= patch.vmax
        : patch.vmin != null && before?.vmax != null
          ? patch.vmin >= before.vmax
          : patch.vmax != null && before?.vmin != null
            ? patch.vmax <= before.vmin
            : false
    if (badOrder) {
      const now = before ? `（当前量程 ${formatRange(before)}）` : ''
      return {
        ok: false,
        message:
          `量程不合法：最小值必须小于最大值，本次没有修改${now}。` + '请确认下限和上限各设成多少。',
      }
    }
    /**
     * 配色名可能根本不存在（模型会编 `rainbow-ultra` 这类名字）。旧实现照样落库，
     * 渲染时又被兜底成默认色带 ⇒ 回执说「已换配色」，用户却看不出任何变化。
     * 先校验，认不出来就拒掉并给出真实可选的名字。
     */
    let paletteId: string | null = null
    if (hasPalette) {
      const raw = String(args.palette).trim()
      const canon = resolveCanonicalPaletteIdStrict(raw) || raw
      const known = WEATHER_PALETTE_OPTIONS.some(
        (o) => o.id === canon || o.id === raw || resolveCanonicalPaletteIdStrict(o.id) === canon,
      )
      if (!known) {
        const names = WEATHER_PALETTE_OPTIONS.slice(0, 6)
          .map((o) => `${o.id}（${o.label}）`)
          .join('、')
        return {
          ok: false,
          message: `没有「${raw}」这个配色，这次什么都没改。可用的有：${names}。说其中一个我再换。`,
        }
      }
      paletteId = canon
    }
    if (paletteId) workspace.setLayerPaletteOverride(resolved.instanceId, paletteId)
    const changedRange = patch.vmin != null || patch.vmax != null
    if (changedRange) workspace.setLayerRangeOverride(resolved.instanceId, patch)
    const symLabel = nameOf(resolved.catalogId, args.display_name || layer?.name)
    /**
     * 回执必须分清「只换色」和「真改了量程」。
     * 旧版两种都回「已更新配色与拉伸」⇒ 用户没有任何途径判断量程被没被动，
     * 而这正是 10-20 那次（只授权换色、vmax 却被改）的核心问题。
     */
    if (!changedRange) {
      const known = formatRange(before)
      const keep = known ? `，量程没动（还是 ${known}）` : '，量程没动'
      return { ok: true, message: `已给「${symLabel}」换了配色${keep}` }
    }
    /**
     * 只描述「这次改成了什么」。旧实现拼成「从 原来的量程 改为 ? 到 1」——
     * 拿不到旧量程时会出现「原来的量程」和问号，用户读不懂到底改成了多少。
     */
    const parts: string[] = []
    if (patch.vmin != null) parts.push(`下限 ${patch.vmin}`)
    if (patch.vmax != null) parts.push(`上限 ${patch.vmax}`)
    const changedTxt = parts.join('、')
    const old = formatRange(before)
    const fromTxt = old ? `（原 ${old}）` : ''
    if (paletteId) {
      return { ok: true, message: `已给「${symLabel}」换了配色，量程改为 ${changedTxt}${fromTxt}` }
    }
    return { ok: true, message: `已把「${symLabel}」的量程改为 ${changedTxt}${fromTxt}` }
  }

  // 不把内部意图名播报给用户（他看不懂 do_something_magic 是什么）
  return {
    ok: false,
    message:
      '这个操作我这边还做不了。能帮你做的是：显示/隐藏图层、切日期、改配色、调透明度、定位与缩放、换底图、跑工作流。',
  }
}

/**
 * 逐条执行助手下发的界面意图。
 *
 * 2026-11-02 起改为 async：`set_timeline` 要真去 NAS 取那天的单日帧（约 4~6 秒），
 * 结果必须等回来才能写回执。调用方只有 AgentChatPanel（`applyChatResult` 本来即 async），
 * 用 `await` 取结果即可；其它意图内部同步，行为不变。
 */
export async function executeAgentUiIntents(
  intents: AgentUiIntent[],
  handlers: AgentUiIntentHandlers = {},
  options: AgentUiIntentOptions = {},
): Promise<AgentUiIntentResult[]> {
  const results: AgentUiIntentResult[] = []
  const failedAdds = new Set<string>()
  for (let i = 0; i < intents.length; i += 1) {
    const intent = intents[i]
    if (options.signal?.aborted) {
      results.push({ ok: false, status: 'not_executed', message: '用户已取消，尚未执行此操作。' })
      continue
    }
    const targetId = String(intent.args.catalog_id ?? '')
    if (failedAdds.has(targetId) && ['select_layer', 'set_timeline'].includes(intent.name)) {
      results.push({ ok: false, status: 'not_executed', message: '目标图层未成功添加，依赖此图层的后续操作未执行。' })
      continue
    }
    const result = await executeAgentUiIntent(intent, handlers, options)
    results.push(result)
    if (intent.name === 'add_layer') {
      if (result.ok) failedAdds.delete(targetId)
      else failedAdds.add(targetId)
    }
  }
  return results
}
