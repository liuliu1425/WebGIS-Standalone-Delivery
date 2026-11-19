<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { X, MapPin } from '../ui/icons'
import TimeSeriesResults from './TimeSeriesResults.vue'
import { useSeriesPanelDrag } from './useSeriesPanelDrag'
import {
  getSeriesProducts,
  getSeriesAvailability,
  submitSeries,
  getSeriesRun,
  getSeriesResult,
  cancelSeries,
  statisticLabels,
  type SeriesProduct,
  type SeriesResult,
  type SeriesRequest,
  cadenceLabel,
} from '../../services/spatial-timeseries'
import { loadWorldAdmin0Boundaries, loadWorldAdmin1Boundaries } from '../../app/admin-boundaries'
import { readBoundary, featureName, mergeBoundaryFeatures } from './boundary-input'

const props = defineProps<{
  open: boolean
  mapContext?: { productId: string; observationKey: string; visible: boolean }
  locate: (point: [number, number] | null, fly?: boolean) => boolean
  pick?: (done: (point: [number, number]) => void, ended: () => void) => boolean
  draw: (mode: 'rectangle' | 'polygon', done: (geometry: GeoJSON.Polygon) => void) => boolean
  cancelDraw: () => void
  preview: (geometry: GeoJSON.Geometry | null, name?: string) => void
}>()
const emit = defineEmits<{
  close: []
  resultsVisible: [value: boolean]
  timelineInset: [value: number]
}>()
const panelElement = ref<HTMLElement | null>(null)
const { dragStyle, dragging, startDrag, resetPosition } = useSeriesPanelDrag(panelElement)
const products = ref<SeriesProduct[]>([])
const error = ref(''),
  notice = ref(''),
  loading = ref(true),
  busy = ref(false)
const stage = ref(''),
  runId = ref(''),
  result = ref<SeriesResult | null>(null)
const resultSignature = ref(''),
  resultExpanded = ref(false)
const resultHeight = ref(0)
watch([result, resultExpanded], () => {
  emit('timelineInset', result.value && !resultExpanded.value ? 58 : 0)
})
const longitude = ref<string | number>('116.4'),
  latitude = ref<string | number>('39.9')
const fields = reactive<SeriesRequest>({
  product_id: '',
  mode: 'point',
  point: null,
  geometry: null,
  location_name: '',
  start: '',
  end: '',
  cadence: 'daily',
  statistic: 'mean',
})
const source = ref<'draw' | 'admin' | 'file'>('draw'),
  drawing = ref(false)
const features = ref<GeoJSON.Feature[]>([]),
  featureIndex = ref(''),
  featureSearch = ref('')
const boundaryName = ref('')
const merging = ref(false)
let mergeGeneration = 0
const boundaryBusy = ref(false),
  boundaryError = ref(''),
  adminLevel = ref('province')
let boundaryGeneration = 0
let generation = 0,
  timer: ReturnType<typeof setTimeout> | null = null
const product = computed(() => products.value.find((p) => p.id === fields.product_id))
const mapProduct = computed(() => products.value.find((p) => p.id === props.mapContext?.productId))
const mapObservation = computed(() => props.mapContext?.observationKey || '尚未确认加载时刻')
const sameMapProduct = computed(() => fields.product_id === props.mapContext?.productId)
const indexLoading = ref(false),
  indexError = ref(''),
  picking = ref(false),
  marked = ref(false)
let indexGeneration = 0
const selectedFrames = computed(() =>
  frames.value.filter((f) => f.start >= fields.start && f.end <= fields.end),
)
const missingDays = computed(() => {
  if (fields.cadence !== 'daily' || !fields.start || !fields.end || fields.end < fields.start)
    return null
  const count = Math.round((Date.parse(fields.end) - Date.parse(fields.start)) / 86400000) + 1
  return Math.max(0, count - selectedFrames.value.length)
})
const outsideCoverage = computed(() => {
  const bounds = product.value?.coverage_bounds
  return !!(
    pointValid.value &&
    bounds &&
    (point.value[0] < bounds[0] ||
      point.value[0] > bounds[2] ||
      point.value[1] < bounds[1] ||
      point.value[1] > bounds[3])
  )
})
const cadences = computed(() => [...new Set(product.value?.frames.map((f) => f.cadence) || [])])
const frames = computed(
  () => product.value?.frames.filter((f) => f.cadence === fields.cadence) || [],
)
const minDate = computed(() => frames.value.map((f) => f.start).sort()[0] || '')
const maxDate = computed(
  () =>
    frames.value
      .map((f) => f.end)
      .sort()
      .at(-1) || '',
)
const point = computed<[number, number]>(() => [Number(longitude.value), Number(latitude.value)])
const pointValid = computed(
  () =>
    String(longitude.value).trim() !== '' &&
    String(latitude.value).trim() !== '' &&
    Number.isFinite(point.value[0]) &&
    Number.isFinite(point.value[1]) &&
    Math.abs(point.value[0]) <= 180 &&
    Math.abs(point.value[1]) <= 90,
)
const snapshot = computed<SeriesRequest>(() => ({
  ...fields,
  point: fields.mode === 'point' ? point.value : null,
  geometry: fields.mode === 'region' ? fields.geometry : null,
  location_name:
    fields.mode === 'point'
      ? '经度 ' + longitude.value + '，纬度 ' + latitude.value
      : fields.location_name,
  statistic: fields.mode === 'point' ? 'mean' : fields.statistic,
}))
const signature = computed(() => JSON.stringify(snapshot.value))
const stale = computed(() => !!result.value && signature.value !== resultSignature.value)
const problems = computed(() => ({
  product:
    indexError.value ||
    (indexLoading.value
      ? '正在读取真实观测日期'
      : fields.product_id
        ? ''
        : '请选择有真实源数据的产品和变量'),
  location:
    fields.mode === 'point'
      ? pointValid.value
        ? outsideCoverage.value
          ? '坐标有效，但位于当前产品数据覆盖范围外'
          : ''
        : '经度范围 -180～180，纬度范围 -90～90'
      : fields.geometry
        ? ''
        : '请绘制、选择或上传一个区域',
  dates:
    !fields.start || !fields.end
      ? '请填写起止日期'
      : fields.start > fields.end
        ? '开始日期不能晚于结束日期'
        : fields.start < minDate.value || fields.end > maxDate.value
          ? '日期超出当前时间尺度的真实数据范围'
          : selectedFrames.value.length
            ? ''
            : '所选范围没有可用观测；缺测日期不会补零',
}))
const touched = ref(false)
const filteredFeatures = computed(() =>
  features.value
    .map((f, i) => ({ f, i, name: featureName(f, i) }))
    .filter((row) => row.name.toLowerCase().includes(featureSearch.value.trim().toLowerCase()))
    .slice(0, 300),
)
watch(
  () => fields.product_id,
  () => void refreshAvailability(),
)
function resetDates() {
  fields.end = maxDate.value
  // Start with the latest month to avoid accidentally submitting ten years.
  // Users can freely select any range in the actual source index.
  fields.start =
    fields.cadence === 'daily' && fields.end
      ? [minDate.value, fields.end.slice(0, 8) + '01'].sort().at(-1) || ''
      : minDate.value
}
async function refreshAvailability(preserveSelection = false) {
  const previous = { start: fields.start, end: fields.end, cadence: fields.cadence }
  const id = fields.product_id,
    token = ++indexGeneration
  indexError.value = ''
  if (!id) return
  indexLoading.value = true
  try {
    const selected = product.value
    const fresh = selected?.source_kind ? await getSeriesAvailability(id) : selected
    if (token !== indexGeneration || !fresh) return
    products.value = products.value.map((p) => (p.id === id ? fresh : p))
    fields.cadence =
      preserveSelection === true && cadences.value.includes(previous.cadence)
        ? previous.cadence
        : cadences.value.includes('daily')
          ? 'daily'
          : cadences.value[0] || 'daily'
    if (
      preserveSelection === true &&
      previous.start >= minDate.value &&
      previous.end <= maxDate.value &&
      previous.start <= previous.end
    ) {
      fields.start = previous.start
      fields.end = previous.end
    } else resetDates()
  } catch (e) {
    if (token === indexGeneration) {
      indexError.value = e instanceof Error ? e.message : String(e)
      products.value = products.value.map((p) => (p.id === id ? { ...p, frames: [] } : p))
      fields.start = ''
      fields.end = ''
    }
  } finally {
    if (token === indexGeneration) indexLoading.value = false
  }
}
watch(
  () => fields.cadence,
  () => {
    resetDates()
  },
)
watch(
  () => props.open,
  (open) => {
    if (!open) stopDraw()
    else if (product.value?.source_kind) void refreshAvailability(true)
  },
)
watch(featureIndex, async (value) => {
  const token = ++mergeGeneration
  merging.value = false
  boundaryError.value = ''
  fields.geometry = null
  fields.location_name = ''
  if (value === '') {
    props.preview(null)
    return
  }
  try {
    if (value === '__all__' && source.value === 'file') {
      merging.value = true
      const merged = await mergeBoundaryFeatures(features.value)
      if (token !== mergeGeneration) return
      fields.geometry = merged
      fields.location_name = boundaryName.value || '上传文件完整区域'
      notice.value = '已合并全部 ' + features.value.length + ' 个要素，按一个完整区域分析。'
    } else {
      const feature = features.value[Number(value)]
      if (!feature) {
        props.preview(null)
        return
      }
      fields.geometry = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
      fields.location_name = featureName(feature, Number(value))
    }
    if (fields.mode === 'region') props.preview(fields.geometry, fields.location_name)
  } catch (e) {
    if (token !== mergeGeneration) return
    props.preview(null)
    boundaryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (token === mergeGeneration) merging.value = false
  }
})
watch(source, () => {
  stopDraw()
  clearBoundary()
})
watch(adminLevel, clearBoundary)
function clearBoundary() {
  boundaryGeneration++
  mergeGeneration++
  merging.value = false
  boundaryBusy.value = false
  features.value = []
  boundaryName.value = ''
  featureIndex.value = ''
  fields.geometry = null
  fields.location_name = ''
  boundaryError.value = ''
  props.preview(null)
}
watch(
  () => fields.mode,
  (mode) => {
    stopDraw()
    notice.value = ''
    props.preview(mode === 'region' ? fields.geometry : null, fields.location_name)
    props.locate(mode === 'point' && marked.value && pointValid.value ? point.value : null, false)
  },
)
onMounted(async () => {
  try {
    products.value = (await getSeriesProducts()).items
    fields.product_id =
      products.value.find((p) => p.id === props.mapContext?.productId)?.id ||
      products.value[0]?.id ||
      ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => {
  indexGeneration++
  generation++
  boundaryGeneration++
  mergeGeneration++
  if (timer) clearTimeout(timer)
  stopDraw()
  props.locate(null, false)
  props.preview(null)
})
function stopDraw() {
  props.cancelDraw()
  drawing.value = false
  picking.value = false
}
function beginDraw(mode: 'rectangle' | 'polygon') {
  boundaryError.value = ''
  notice.value = ''
  const ok = props.draw(mode, (geometry) => {
    fields.geometry = geometry
    fields.location_name = mode === 'rectangle' ? '地图绘制矩形' : '地图绘制多边形'
    drawing.value = false
    props.preview(geometry, fields.location_name)
  })
  drawing.value = ok
  if (!ok) boundaryError.value = '地图未就绪，或正在使用其他绘制/测量工具，请先结束当前操作。'
}
function locatePoint() {
  touched.value = true
  if (!pointValid.value) return
  marked.value = props.locate(point.value)
  notice.value = marked.value
    ? outsideCoverage.value
      ? '坐标标记已更新，但此位置超出产品覆盖范围。'
      : '已标记输入坐标；尚未执行分析，范围内有效性以读取结果为准。'
    : '地图尚未就绪，无法定位。'
}
function beginPick() {
  stopDraw()
  picking.value =
    props.pick?.(
      (value) => {
        longitude.value = Number(value[0].toFixed(6))
        latitude.value = Number(value[1].toFixed(6))
        marked.value = true
        notice.value = '已获取 WGS84 坐标；点击“生成曲线”后才读取数据。'
      },
      () => {
        picking.value = false
      },
    ) ?? false
  if (!picking.value) notice.value = '地图未就绪或其他绘制工具正在使用，请先结束当前操作。'
}
watch([longitude, latitude], () => {
  if (marked.value && fields.mode === 'point')
    props.locate(pointValid.value ? point.value : null, false)
})
async function loadAdmin() {
  clearBoundary()
  const token = boundaryGeneration
  boundaryBusy.value = true
  boundaryError.value = ''
  try {
    const loaded = (
      await (adminLevel.value === 'country'
        ? loadWorldAdmin0Boundaries()
        : loadWorldAdmin1Boundaries())
    ).features
    if (token === boundaryGeneration) features.value = loaded
  } catch (e) {
    if (token === boundaryGeneration)
      boundaryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (token === boundaryGeneration) boundaryBusy.value = false
  }
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  clearBoundary()
  const token = boundaryGeneration
  boundaryName.value = file.name.replace(/\.(zip|geojson|json)$/i, '')
  boundaryBusy.value = true
  boundaryError.value = ''
  fields.geometry = null
  featureIndex.value = ''
  try {
    const loaded = await readBoundary(file)
    if (token !== boundaryGeneration) return
    features.value = loaded
    if (features.value.length) featureIndex.value = '0'
    if (features.value.length > 1)
      notice.value = `文件包含 ${features.value.length} 个区域，已预览首个；可选择单个区域或合并全部要素。`
  } catch (e) {
    if (token === boundaryGeneration)
      boundaryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (token === boundaryGeneration) boundaryBusy.value = false
    ;(event.target as HTMLInputElement).value = ''
  }
}
async function generate() {
  touched.value = true
  if (busy.value || Object.values(problems.value).some(Boolean)) return
  const token = ++generation,
    frozen = JSON.parse(signature.value) as SeriesRequest,
    frozenSignature = signature.value
  error.value = ''
  busy.value = true
  stage.value = '正在核对观测目录并提交分析…'
  runId.value = ''
  try {
    const accepted = await submitSeries(frozen)
    if (token !== generation) {
      await cancelSeries(accepted.run_id)
      return
    }
    runId.value = accepted.run_id
    const poll = async () => {
      if (token !== generation) return
      try {
        const run = await getSeriesRun(accepted.run_id)
        if (token !== generation) return
        stage.value =
          (run.status === 'queued' ? '等待计算资源' : '正在读取观测期') +
          ' · ' +
          (run.progress || 0) +
          '%'
        if (run.status === 'succeeded') {
          const ref = run.result_refs.find(
            (r) => r.result_kind === 'file' && r.result_id.startsWith('algorithm-product-'),
          )
          if (!ref?.resource_url) throw new Error('任务完成但未返回时序结果文件。')
          const data = await getSeriesResult(ref.resource_url)
          if (token !== generation) return
          if (data.schema_version !== 1 || !Array.isArray(data.rows))
            throw new Error('返回的结果格式不完整。')
          result.value = data
          resultSignature.value = frozenSignature
          busy.value = false
          stage.value = data.valid_count ? '分析完成' : '分析完成：没有有效数据，请查看结果说明'
        } else if (run.status === 'failed' || run.status === 'cancelled') {
          busy.value = false
          if (run.status === 'cancelled') stage.value = '用户已取消'
          else throw new Error(run.message || '分析计算失败')
        } else timer = setTimeout(() => void poll(), 1500)
      } catch (e) {
        if (token === generation) {
          error.value = e instanceof Error ? e.message : String(e)
          busy.value = false
          stage.value = '计算或结果读取失败'
        }
      }
    }
    void poll()
  } catch (e) {
    if (token === generation) {
      error.value = e instanceof Error ? e.message : String(e)
      busy.value = false
      stage.value = '提交失败'
    }
  }
}
async function cancel() {
  if (!busy.value) return
  const id = runId.value
  if (!id) {
    generation++
    busy.value = false
    stage.value = '已取消提交'
    return
  }
  try {
    const token = generation
    const response = await cancelSeries(id)
    if (token !== generation) return
    if (response.status !== 'cancelled') {
      stage.value =
        response.status === 'succeeded' ? '任务已经完成，正在读取结果' : '正在确认任务状态'
      return
    }
    generation++
    if (timer) clearTimeout(timer)
    busy.value = false
    stage.value = '用户已取消'
  } catch (e) {
    error.value = '取消请求未成功：' + (e instanceof Error ? e.message : String(e))
  }
}
function resultVisibility(value: boolean) {
  resultExpanded.value = value
  emit('resultsVisible', value)
}
</script>
<template>
  <aside
    v-show="open"
    ref="panelElement"
    class="ts-settings"
    :class="{ 'with-results': resultExpanded, dragging }"
    :style="[resultExpanded ? { bottom: resultHeight + 24 + 'px' } : {}, dragStyle]"
    @pointerdown.stop
    @wheel.stop
  >
    <header>
      <button
        class="ts-drag-grip"
        aria-label="拖动时序设置"
        title="拖动时序设置 · 双击复位"
        @pointerdown.stop.prevent="startDrag"
        @dblclick="resetPosition"
      >
        <span></span><span></span><span></span>
      </button>
      <div class="ts-heading">
        <small>SPATIAL · TIME SERIES</small>
        <h2>时序分析</h2>
      </div>
      <button aria-label="关闭时序设置" title="关闭设置，保留结果" @click="emit('close')">
        <X :size="18" />
      </button>
    </header>
    <div class="ts-form">
      <p class="ts-intro">选定一个产品和位置，查看真实观测的时间变化。</p>
      <label
        >产品 · 版本 · 变量<select v-model="fields.product_id" aria-label="时序分析产品">
          <option value="" disabled>{{ loading ? '正在读取可用源数据…' : '请选择产品' }}</option>
          <option v-for="p in products" :key="p.id" :value="p.id">
            {{ p.product_name }} · {{ p.variable_name }}
          </option>
        </select></label
      >
      <div v-if="product" class="ts-target-summary">
        <strong>本次分析对象</strong>
        <span>{{ product.product_name }} · {{ product.variable_name }}</span>
        <span
          >{{ cadenceLabel(fields.cadence) }} · {{ fields.start || '—' }} 至
          {{ fields.end || '—' }}</span
        >
        <p v-if="mapProduct">
          地图选中：{{ mapProduct.product_name }} · {{ mapProduct.variable_name }}
          {{ mapContext?.visible ? '（勾选显示）' : '（当前隐藏）' }}<br />
          地图实际帧：{{ mapObservation }}
        </p>
        <p
          v-if="
            mapProduct &&
            (!sameMapProduct || (fields.cadence === 'daily' && mapObservation.includes('_')))
          "
          class="ts-context-note"
        >
          分析与地图当前显示条件不同。地图颜色不能代表本产品、所选观测期在此点有值。
        </p>
      </div>
      <p v-if="touched && problems.product" class="ts-error">{{ problems.product }}</p>
      <p v-if="!loading && !products.length" class="ts-note">
        没有发现可用于本地时序分析的源栅格；不会生成模拟曲线。
      </p>
      <div class="ts-mode">
        <button :class="{ active: fields.mode === 'point' }" @click="fields.mode = 'point'">
          点位分析</button
        ><button :class="{ active: fields.mode === 'region' }" @click="fields.mode = 'region'">
          区域分析
        </button>
      </div>
      <div v-if="fields.mode === 'point'">
        <div class="ts-pair">
          <label
            >经度<input
              v-model="longitude"
              aria-label="分析经度"
              type="number"
              min="-180"
              max="180"
              step="any" /></label
          ><label
            >纬度<input
              v-model="latitude"
              aria-label="分析纬度"
              type="number"
              min="-90"
              max="90"
              step="any"
          /></label>
        </div>
        <button class="ts-locate" @click="locatePoint"><MapPin :size="14" /> 在地图上定位</button>
        <button
          class="ts-locate"
          :class="{ active: picking }"
          @click="picking ? stopDraw() : beginPick()"
        >
          {{ picking ? '退出选点（Esc）' : '地图选点' }}
        </button>
        <p v-if="picking" class="ts-note">在地图上单击获取坐标，按 Esc 退出。不会自动计算。</p>
        <p class="ts-note">
          WGS84（EPSG:4326），经度在前、纬度在后。提取对应产品中该坐标所在的像元。
        </p>
        <p v-if="outsideCoverage" class="ts-error">坐标有效，但位于当前产品数据覆盖范围外。</p>
        <p v-else-if="product?.coverage_note" class="ts-note">{{ product.coverage_note }}</p>
      </div>
      <div v-else>
        <label
          >区域来源<select v-model="source" aria-label="区域来源">
            <option value="draw">地图绘制</option>
            <option value="admin">行政区</option>
            <option value="file">SHP ZIP / GeoJSON</option>
          </select></label
        >
        <div v-if="source === 'draw'" class="ts-draw">
          <button @click="beginDraw('rectangle')">绘制矩形</button
          ><button @click="beginDraw('polygon')">绘制多边形</button
          ><button v-if="drawing" @click="stopDraw">取消绘制</button>
          <p class="ts-note">
            {{
              drawing
                ? '矩形：按下并拖动；多边形：逐点单击、双击结束。完成后再生成曲线。'
                : fields.location_name || '请在地图上指定固定分析边界。'
            }}
          </p>
        </div>
        <template v-if="source === 'admin'"
          ><div class="ts-pair">
            <select v-model="adminLevel" aria-label="行政区层级">
              <option value="province">省 / 州</option>
              <option value="country">国家</option></select
            ><button :disabled="boundaryBusy" @click="loadAdmin">加载边界</button>
          </div>
          <p class="ts-note">
            复用 Natural Earth 边界；目前提供国家与省/州，不含完整市县。名称沿用数据原名（如
            Hubei）。
          </p></template
        >
        <template v-if="source === 'file'"
          ><input
            aria-label="上传分析边界"
            type="file"
            accept=".zip,.geojson,.json"
            @change="upload"
          />
          <p class="ts-note">
            SHP 请打包同名 .shp、.shx、.dbf、.prj；按 .prj 转为 WGS84。GeoJSON 默认遵循 WGS84 标准。
          </p></template
        >
        <template v-if="features.length"
          ><input v-model="featureSearch" placeholder="搜索区域名称" aria-label="搜索区域" /><select
            v-model="featureIndex"
            aria-label="选择一个区域要素"
          >
            <option value="">选择分析区域（共 {{ features.length }} 个要素）</option>
            <option v-if="source === 'file' && features.length > 1" value="__all__">
              整个文件区域（合并全部 {{ features.length }} 个要素）
            </option>
            <option v-for="row in filteredFeatures" :key="row.i" :value="String(row.i)">
              {{ row.name }}
            </option>
          </select>
          <p class="ts-note">
            <template v-if="source === 'file'"
              >可选单个要素，或合并全部要素作为一个区域；保留多部件和孔洞。</template
            >
            <template v-else>一次分析一个要素；MultiPolygon 作为同一个区域。</template>搜索最多显示
            300 项。
          </p></template
        >
        <p v-if="boundaryBusy" class="ts-note">正在读取边界…</p>
        <p v-if="merging" class="ts-note" role="status">正在合并完整区域边界…</p>
        <p v-if="boundaryError" class="ts-error">{{ boundaryError }}</p>
        <label
          >区域统计量<select v-model="fields.statistic" aria-label="区域统计量">
            <option v-for="(label, key) in statisticLabels" :key="key" :value="key">
              {{ label }}
            </option>
          </select></label
        >
      </div>
      <p v-if="touched && problems.location" class="ts-error">{{ problems.location }}</p>
      <label
        >观测时间尺度<select v-model="fields.cadence" aria-label="观测时间尺度">
          <option v-for="c in cadences" :key="c" :value="c">
            {{ cadenceLabel(c) }}
          </option>
        </select></label
      >
      <div class="ts-pair">
        <label
          >开始日期<input
            v-model="fields.start"
            aria-label="分析开始日期"
            type="date"
            :min="minDate"
            :max="maxDate" /></label
        ><label
          >结束日期<input
            v-model="fields.end"
            aria-label="分析结束日期"
            type="date"
            :min="minDate"
            :max="maxDate"
        /></label>
      </div>
      <p v-if="indexLoading" class="ts-note" role="status">正在读取当前产品的真实观测目录…</p>
      <p v-if="indexError" class="ts-error" role="alert">{{ indexError }}</p>
      <button :disabled="indexLoading" @click="refreshAvailability(true)">刷新可用日期</button>
      <p class="ts-note">{{ product?.source_note }}</p>
      <p class="ts-note">
        可用范围 {{ minDate || '—' }} 至 {{ maxDate || '—' }} · {{ frames.length }} 个真实观测期。{{
          product?.timezone
        }}。{{
          fields.cadence !== 'daily'
            ? '仅提取起止日期内完整包含的合成期，不将合成值当作单日值。'
            : '缺少的日期留空，不插值、不补零。'
        }}
      </p>
      <p class="ts-note">
        当前选择：{{ selectedFrames.length }} 个观测期<span v-if="missingDays !== null"
          >，{{ missingDays }} 天缺测</span
        >。
      </p>
      <p v-if="touched && problems.dates" class="ts-error">{{ problems.dates }}</p>
      <p v-if="notice" class="ts-note">{{ notice }}</p>
      <p v-if="stale" class="ts-stale">分析条件已修改，请重新生成。旧结果仍对应原条件。</p>
      <p v-if="error" class="ts-error" role="alert">{{ error }}</p>
    </div>
    <footer>
      <p v-if="stage" role="status">{{ stage }}</p>
      <button v-if="busy" class="ts-cancel" @click="cancel">取消计算</button
      ><button
        class="ts-generate"
        :disabled="busy || loading || indexLoading || merging || !!indexError"
        @click="generate"
      >
        {{ busy ? '计算中…' : '生成曲线' }}</button
      ><small>分析不会更改地图日期或其他图层的显示状态。</small>
    </footer>
  </aside>
  <TimeSeriesResults
    v-if="result"
    :result="result"
    :stale="stale"
    @expanded="resultVisibility"
    @layout-height="resultHeight = $event"
  />
</template>
<style scoped>
.ts-settings {
  position: fixed;
  z-index: 1601;
  top: 98px;
  min-height: 260px;
  right: 18px;
  width: 370px;
  max-width: calc(100vw - 36px);
  bottom: 24px;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  background: var(--surface-1);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  box-shadow: 0 12px 32px #07182a44;
  overflow: hidden;
}
.ts-settings.with-results {
  bottom: calc(36vh + 26px);
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-default);
}
header small {
  font-size: 9px;
  letter-spacing: 2px;
  color: var(--text-secondary);
}
h2 {
  font-size: 18px;
  margin: 4px 0 0;
  color: var(--text-strong);
}
button {
  cursor: pointer;
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  background: var(--surface-1);
  border-radius: 7px;
  padding: 8px 10px;
  font-size: 12px;
}
button:disabled {
  opacity: 0.55;
  cursor: wait;
}
button:hover {
  border-color: var(--accent);
}
header button {
  border: 0;
  background: transparent;
}
.ts-form {
  overflow: auto;
  padding: 0 20px 14px;
  flex: 1;
}
.ts-intro {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 15px 0;
}
label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin: 12px 0 5px;
  font-weight: 600;
}
input,
select {
  font: inherit;
  font-weight: 400;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-default);
  border-radius: 7px;
  background: var(--surface-1);
  color: var(--text-primary);
  padding: 9px 8px;
  margin-top: 6px;
  min-width: 0;
}
input:focus,
select:focus {
  outline: 2px solid var(--accent-border);
  border-color: #1677ff;
}
.ts-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: end;
}
.ts-mode {
  display: flex;
  padding: 3px;
  gap: 4px;
  background: var(--surface-2);
  border-radius: 9px;
  margin: 16px 0 12px;
}
.ts-mode button {
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
}
.ts-mode button.active {
  background: var(--surface-1);
  color: var(--accent);
  box-shadow: 0 1px 5px #1b457222;
}
.ts-note {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 8px 0;
}
.ts-error {
  font-size: 12px;
  color: var(--danger);
  line-height: 1.6;
}
.ts-stale {
  font-size: 12px;
  color: var(--warning);
}
.ts-locate {
  display: flex;
  gap: 5px;
  align-items: center;
  margin-top: 8px;
  color: var(--accent);
  background: var(--accent-surface);
  border-color: var(--accent-border);
}
.ts-draw {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.ts-draw p {
  flex-basis: 100%;
}
footer {
  padding: 12px 20px;
  background: var(--surface-2);
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
}
footer p {
  font-size: 12px;
  margin: 0 0 8px;
  color: var(--text-secondary);
}
footer small {
  display: block;
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 9px;
}
.ts-generate {
  background: #1677ff;
  color: #fff;
  font-weight: 600;
  border: 0;
  width: 100%;
  font-size: 14px;
  padding: 10px;
}
.ts-cancel {
  margin-bottom: 8px;
  width: 100%;
}

.ts-heading {
  flex: 1;
}
header .ts-drag-grip {
  display: flex;
  gap: 3px;
  padding: 7px 5px;
  border: 1px solid var(--accent-border);
  background: var(--accent-surface);
  cursor: grab;
  touch-action: none;
}
.ts-drag-grip span {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
}
.dragging .ts-drag-grip {
  cursor: grabbing;
}
.ts-target-summary {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border-default);
  background: var(--surface-2);
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.65;
  margin-top: 12px;
}
.ts-target-summary strong {
  color: var(--text-strong);
}
.ts-target-summary p {
  margin: 4px 0 0;
  color: var(--text-secondary);
}
.ts-target-summary .ts-context-note {
  color: var(--warning);
  border-top: 1px solid var(--border-default);
  padding-top: 8px;
}
@media (max-width: 700px) {
  .ts-settings {
    top: 80px;
    width: 350px;
  }
}
</style>
