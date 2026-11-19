<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useThemeStore } from '../../stores/theme'
import { useSeriesPanelDrag } from './useSeriesPanelDrag'
import VChart from 'vue-echarts'
import { init, use, type EChartsCoreOption } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  TitleComponent,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  ToolboxComponent,
} from 'echarts/components'
import {
  Maximize2,
  Minimize2,
  Download,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Search,
  Move,
} from '../ui/icons'
import {
  rowValue,
  timestamp,
  formatValue,
  statisticLabels,
  seriesCSV,
  downloadBlob,
  resultFilename,
  type SeriesResult,
  cadenceLabel,
} from '../../services/spatial-timeseries'
use([
  CanvasRenderer,
  LineChart,
  TitleComponent,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  ToolboxComponent,
])
const props = defineProps<{ result: SeriesResult; stale: boolean }>()
const emit = defineEmits<{ expanded: [value: boolean]; layoutHeight: [value: number] }>()
const chart = ref<InstanceType<typeof VChart> | null>(null)
const collapsed = ref(false),
  large = ref(false),
  tab = ref<'curve' | 'table'>('curve')
const mode = ref<'zoom' | 'pan'>('pan')
const height = ref(Math.max(380, window.innerHeight / 3))
const theme = useThemeStore()
const panelElement = ref<HTMLElement | null>(null)
const chartElement = ref<HTMLElement | null>(null)
const { dragStyle, dragging, startDrag, resetPosition } = useSeriesPanelDrag(
  panelElement,
  computed(() => !large.value),
)
const chartSize = ref({ width: 900, height: 260 })
let sizeObserver: ResizeObserver | undefined
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !chartElement.value) return
  sizeObserver = new ResizeObserver(([entry]) => {
    if (entry?.contentRect.width && entry.contentRect.height)
      chartSize.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  sizeObserver.observe(chartElement.value)
})
onBeforeUnmount(() => sizeObserver?.disconnect())
const lightPalette = {
  background: '#FFFFFF',
  text: '#25364A',
  muted: '#536579',
  axis: '#465466',
  grid: '#DDE4EC',
  tooltip: '#FFFFFF',
}
const darkPalette = {
  background: '#101C2B',
  text: '#E4EDF7',
  muted: '#B1C1D3',
  axis: '#A8B7C9',
  grid: '#293A4F',
  tooltip: '#17273A',
}
const palette = computed(() => (theme.mode === 'dark' ? darkPalette : lightPalette))
const zoom = ref({ start: 0, end: 100 })
const page = ref(0)
watch(
  () => props.result,
  () => {
    collapsed.value = false
    zoom.value = { start: 0, end: 100 }
    page.value = 0
  },
)
watch(collapsed, (value) => emit('expanded', !value), { immediate: true })
watch([height, collapsed], () => emit('layoutHeight', collapsed.value ? 44 : height.value), {
  immediate: true,
})
onBeforeUnmount(() => emit('expanded', false))
const request = computed(() => props.result.request)
const title = computed(() => props.result.product.variable_name + '时间变化')
const location = computed(() =>
  request.value.mode === 'point'
    ? 'WGS84 经度 ' + request.value.point?.[0] + '，纬度 ' + request.value.point?.[1]
    : request.value.location_name,
)
const subtitle = computed(
  () =>
    props.result.product.product_name +
    ' · ' +
    props.result.product.variable +
    ' · ' +
    statistic.value +
    '\n' +
    location.value +
    ' · ' +
    request.value.start +
    ' — ' +
    request.value.end +
    ' · ' +
    cadenceLabel(request.value.cadence) +
    (request.value.cadence !== 'daily' ? '（横轴为期初）' : ''),
)
function variableColor(dark = theme.mode === 'dark') {
  return props.result.product.variable === 'VOD'
    ? dark
      ? '#29C99A'
      : '#009E73'
    : props.result.product.variable === 'SM'
      ? dark
        ? '#4C9AFF'
        : '#1677FF'
      : dark
        ? '#C38AEB'
        : '#A64AC9'
}
const statistic = computed(() =>
  request.value.mode === 'point' ? '所在像元值' : statisticLabels[request.value.statistic],
)
const values = computed(() =>
  props.result.rows.map((row) => [timestamp(row.start), rowValue(row, request.value)]),
)
const chartData = computed(() => {
  const rows: Array<Array<number | null>> = []
  props.result.rows.forEach((row, i) => {
    const prev = props.result.rows[i - 1]
    if (
      request.value.cadence !== 'daily' &&
      prev &&
      timestamp(row.start) - timestamp(prev.end) > 86400000
    )
      rows.push([timestamp(prev.end) + 86400000, null])
    rows.push(values.value[i])
  })
  return rows
})
const validCount = computed(() => values.value.filter((row) => row[1] !== null).length)
const grid = computed(() => props.result.rows.find((row) => row.grid)?.grid)
const tableRows = computed(() => props.result.rows.slice(page.value * 100, (page.value + 1) * 100))
const statusLabels: Record<string, string> = {
  ok: '有效',
  missing_date: '缺少该日观测',
  missing_file: '源文件缺失',
  source_unavailable: '数据源连接失败',
  read_error: '文件、变量或坐标读取失败',
  outside_data: '不在数据范围内',
  no_valid_data: '无有效数据',
  no_pixel_centers: '区域内无像元中心',
}
const escape = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
function buildOption(exportImage = false) {
  const colors = exportImage ? lightPalette : palette.value
  const plotHeight = exportImage ? 360 : Math.max(100, chartSize.value.height - 78)
  const plotColor = variableColor(exportImage ? false : undefined)
  return {
    animation: false,
    backgroundColor: colors.background,
    useUTC: true,
    textStyle: { color: colors.text, fontFamily: 'Arial, Microsoft YaHei, sans-serif' },
    title: {
      show: exportImage,
      text: title.value,
      subtext: subtitle.value,
      left: 24,
      top: 13,
      textStyle: { color: '#172C46', fontSize: 16, fontWeight: 600 },
      subtextStyle: { color: '#57697D', fontSize: 11, lineHeight: 18 },
    },
    grid: {
      show: true,
      borderColor: colors.axis,
      borderWidth: 1.25,
      top: exportImage ? 116 : 24,
      bottom: 58,
      left: 94,
      right: 26,
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      enterable: false,
      appendToBody: false,
      backgroundColor: colors.tooltip,
      borderColor: colors.axis,
      textStyle: { color: colors.text, fontSize: 12 },
      extraCssText: 'max-width:340px;white-space:normal;',
      axisPointer: { type: 'line', lineStyle: { color: '#7B91AA', width: 1, type: 'dashed' } },
      formatter: (items: Array<{ axisValue: number }>) => {
        const time = items[0]?.axisValue
        const row = props.result.rows.find((r) => timestamp(r.start) === Number(time))
        if (!row) return '该区间没有观测记录'
        return (
          '<strong>' +
          escape(row.start + (row.end !== row.start ? ' — ' + row.end : '')) +
          '</strong><br>' +
          escape(props.result.timezone) +
          '<br>' +
          escape(props.result.product.product_name) +
          '<br>' +
          escape(props.result.product.variable_name) +
          ' · ' +
          escape(statistic.value) +
          '：<b>' +
          escape(formatValue(rowValue(row, request.value))) +
          '</b> ' +
          escape(props.result.product.unit) +
          (request.value.mode === 'region'
            ? '<br>有效像元：' +
              row.count +
              ' / ' +
              row.total_count +
              '；覆盖率：' +
              (row.coverage == null ? '—' : (100 * row.coverage).toFixed(1) + '%')
            : '')
        )
      },
    },
    xAxis: {
      type: 'time',
      name: '观测日期',
      nameLocation: 'middle',
      nameGap: 34,
      min:
        timestamp(request.value.start) - (request.value.start === request.value.end ? 43200000 : 0),
      max:
        timestamp(request.value.end) + (request.value.start === request.value.end ? 43200000 : 0),
      splitNumber: Math.max(2, Math.min(7, Math.floor(chartSize.value.width / 150))),
      minInterval: 86400000,
      nameTextStyle: { color: colors.text, fontSize: 12 },
      axisLine: { show: true, onZero: false, lineStyle: { color: colors.axis, width: 1.25 } },
      axisTick: { show: true, lineStyle: { color: colors.axis } },
      axisLabel: {
        color: colors.text,
        fontSize: 12,
        margin: 11,
        hideOverlap: true,
        formatter: (v: number) => new Date(v).toISOString().slice(0, 10),
      },
      splitLine: { show: true, lineStyle: { color: colors.grid, type: 'dashed' } },
    },
    yAxis: {
      type: 'value',
      name: props.result.product.variable + '（' + props.result.product.unit + '）',
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 64,
      nameTextStyle: { color: colors.text, fontSize: 12 },
      splitNumber: Math.max(2, Math.min(6, Math.floor(plotHeight / 48))),
      axisLine: { show: true, onZero: false, lineStyle: { color: colors.axis, width: 1.25 } },
      axisTick: { show: true, lineStyle: { color: colors.axis } },
      scale: true,
      min: (v: { min: number; max: number }) =>
        v.min - (v.max - v.min || Math.abs(v.min) || 1) * 0.1,
      max: (v: { min: number; max: number }) =>
        v.max + (v.max - v.min || Math.abs(v.max) || 1) * 0.1,
      axisLabel: {
        color: colors.text,
        fontSize: 12,
        margin: 11,
        hideOverlap: true,
        showMinLabel: false,
        showMaxLabel: false,
        formatter: (v: number) => Number(v.toPrecision(4)).toString(),
      },
      splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
    },
    // Keep the native zoom controller mounted; its icons live outside the plot.
    toolbox: { show: true, left: -100, top: -100, feature: { dataZoom: { yAxisIndex: 'none' } } },
    dataZoom: [
      {
        id: 'series-time',
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        ...zoom.value,
        zoomOnMouseWheel: false,
        moveOnMouseWheel: false,
        moveOnMouseMove: mode.value === 'pan',
      },
    ],
    series: [
      {
        name: props.result.product.variable_name,
        type: 'line',
        data: chartData.value,
        smooth: false,
        connectNulls: false,
        clip: true,
        symbol: 'circle',
        symbolSize: 5,
        showSymbol: validCount.value <= 80,
        lineStyle: { color: plotColor, width: 2.3 },
        itemStyle: { color: plotColor },
        emphasis: { scale: 1.6, focus: 'series' },
      },
    ],
  }
}
const option = computed(() => buildOption())
function activate(value: 'zoom' | 'pan') {
  mode.value = value
  chart.value?.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'dataZoomSelect',
    dataZoomSelectActive: value === 'zoom',
  })
}
function keepZoom(payload: unknown) {
  const event = payload as {
    start?: number
    end?: number
    batch?: Array<{ start?: number; end?: number }>
  }
  const z = event.batch?.[0] ?? event
  if (typeof z.start === 'number' && typeof z.end === 'number')
    zoom.value = { start: z.start, end: z.end }
}
function reset() {
  zoom.value = { start: 0, end: 100 }
  chart.value?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
}
function savePNG() {
  // A separate off-screen chart keeps the on-page zoom, theme and interaction
  // untouched while exporting a white, labelled scientific figure.
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:1100px;height:600px'
  document.body.append(container)
  const exported = init(container, undefined, { renderer: 'canvas', width: 1100, height: 600 })
  try {
    exported.setOption(buildOption(true) as EChartsCoreOption)
    const a = document.createElement('a')
    a.href = exported.getDataURL({
      type: 'png',
      pixelRatio: 3,
      backgroundColor: '#fff',
      excludeComponents: ['toolbox'],
    })
    a.download = resultFilename(props.result) + '_当前视图.png'
    a.click()
  } finally {
    exported.dispose()
    container.remove()
  }
}
function saveCSV() {
  downloadBlob(
    new Blob([seriesCSV(props.result)], { type: 'text/csv;charset=utf-8' }),
    resultFilename(props.result) + '.csv',
  )
}
function resize(event: PointerEvent) {
  if (large.value || collapsed.value) return
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const start = event.clientY,
    initial = height.value
  handle.onpointermove = (e) => {
    height.value = Math.min(window.innerHeight - 120, Math.max(280, initial + start - e.clientY))
  }
  handle.onpointerup = () => {
    handle.onpointermove = null
    handle.onpointerup = null
  }
}
</script>
<template>
  <section
    ref="panelElement"
    class="ts-results"
    :class="{ large, collapsed, dragging }"
    :style="[
      { height: collapsed ? '44px' : large ? 'calc(100vh - 102px)' : height + 'px' },
      dragStyle,
    ]"
    @pointerdown.stop
    @wheel.stop
    @dblclick.stop
  >
    <div class="ts-resize" role="separator" aria-label="拖动调整结果区高度" @pointerdown="resize" />
    <header class="ts-result-header">
      <button
        class="ts-drag-handle"
        title="拖动时序结果 · 双击复位"
        aria-label="拖动时序结果"
        @pointerdown.stop.prevent="startDrag"
        @dblclick.stop="resetPosition"
      >
        •••
      </button>
      <strong
        >时序结果 <span>{{ validCount }} / {{ result.rows.length }} 期有效</span></strong
      >
      <p v-if="stale" class="ts-stale">分析条件已修改，请重新生成。</p>
      <div v-show="!collapsed" class="ts-tabs">
        <button :class="{ active: tab === 'curve' }" @click="tab = 'curve'">曲线</button>
        <button :class="{ active: tab === 'table' }" @click="tab = 'table'">数据表</button>
      </div>
      <nav>
        <template v-if="!collapsed && tab === 'curve' && validCount">
          <button
            title="框选放大时间范围"
            aria-label="框选放大时间范围"
            :class="{ active: mode === 'zoom' }"
            @click="activate('zoom')"
          >
            <Search :size="17" />
          </button>
          <button
            title="左右平移（先放大时间范围）"
            aria-label="平移曲线"
            :class="{ active: mode === 'pan' }"
            @click="activate('pan')"
          >
            <Move :size="17" />
          </button>
          <button title="恢复本次分析全范围" aria-label="恢复全范围" @click="reset">
            <RotateCcw :size="17" />
          </button>
          <button title="保存当前视图 PNG（3倍像素）" aria-label="保存曲线图片" @click="savePNG">
            <Download :size="17" />
          </button>
        </template>
        <button v-if="!collapsed" title="导出本次分析全部结果 CSV" @click="saveCSV">CSV</button>
        <button
          v-if="!collapsed"
          :title="large ? '还原结果区' : '在当前页面放大查看'"
          aria-label="放大或还原结果区"
          @click="large = !large"
        >
          <Minimize2 v-if="large" :size="17" /><Maximize2 v-else :size="17" />
        </button>
        <button
          :title="collapsed ? '展开结果' : '收起结果并恢复地图时间轴'"
          aria-label="收起或展开结果"
          @click="collapsed = !collapsed"
        >
          <ChevronUp v-if="collapsed" :size="17" /><ChevronDown v-else :size="17" />
        </button>
      </nav>
    </header>
    <div v-show="!collapsed" class="ts-result-content">
      <div v-show="tab === 'curve'" class="ts-curve-layout">
        <aside class="ts-result-info" aria-label="本次分析条件">
          <p class="ts-info-kicker">TIME SERIES</p>
          <h3>{{ title }}</h3>
          <dl>
            <div>
              <dt>产品与版本</dt>
              <dd>{{ result.product.product_name }}</dd>
            </div>
            <div>
              <dt>变量 · 统计量</dt>
              <dd>
                <i :style="{ background: variableColor() }" />{{ result.product.variable_name }} ·
                {{ statistic }}
              </dd>
            </div>
            <div>
              <dt>{{ request.mode === 'point' ? '点位（WGS84）' : '分析区域' }}</dt>
              <dd>{{ location }}</dd>
            </div>
            <div>
              <dt>观测时间</dt>
              <dd>{{ request.start }} — {{ request.end }}</dd>
            </div>
            <div>
              <dt>时间尺度 · 单位</dt>
              <dd>
                {{ cadenceLabel(request.cadence) }} · {{ result.product.unit
                }}<span v-if="request.cadence !== 'daily'">（横轴为期初）</span>
              </dd>
            </div>
          </dl>
          <p class="ts-info-note">{{ result.timezone }}。缺测留空，不插值、不补零。</p>
        </aside>
        <div ref="chartElement" class="ts-chart-wrap">
          <VChart v-if="validCount" ref="chart" :option="option" autoresize @datazoom="keepZoom" />
          <div v-else class="ts-empty">
            <strong>所选范围没有有效数据</strong>
            <p>
              {{
                [...new Set(result.rows.map((row) => statusLabels[row.status] || row.status))].join(
                  '；',
                )
              }}。请在数据表查看各期状态。
            </p>
            <p v-if="request.mode === 'point'">
              此结果只对应左侧注明的产品、时间尺度与日期。地图可能显示其他图层或合成期；
              地图有颜色不代表该产品在所选日期的所在像元有效。
            </p>
          </div>
        </div>
      </div>
      <div v-show="tab === 'table'" class="ts-table-wrap">
        <p>
          {{ result.product.product_name }} · {{ location }} · {{ result.timezone }} ·
          数值保留原始精度，CSV 导出全部 {{ result.rows.length }} 行
        </p>
        <table>
          <thead>
            <tr>
              <th>开始日期</th>
              <th>结束日期</th>
              <th>{{ statistic }}（{{ result.product.unit }}）</th>
              <template v-if="request.mode === 'region'"
                ><th>标准差</th>
                <th>最小值</th>
                <th>最大值</th>
                <th>有效 / 区域像元</th>
                <th>覆盖率</th></template
              >
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tableRows" :key="row.key">
              <td>{{ row.start }}</td>
              <td>{{ row.end }}</td>
              <td>{{ rowValue(row, request) ?? '—' }}</td>
              <template v-if="request.mode === 'region'"
                ><td>{{ row.std ?? '—' }}</td>
                <td>{{ row.min ?? '—' }}</td>
                <td>{{ row.max ?? '—' }}</td>
                <td>{{ row.count }} / {{ row.total_count }}</td>
                <td>
                  {{ row.coverage == null ? '—' : (row.coverage * 100).toFixed(1) + '%' }}
                </td></template
              >
              <td>{{ statusLabels[row.status] || row.status }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="result.rows.length > 100" class="ts-pagination">
          <button :disabled="page === 0" @click="page--">上一页</button> {{ page + 1 }} /
          {{ Math.ceil(result.rows.length / 100) }}
          <button :disabled="(page + 1) * 100 >= result.rows.length" @click="page++">下一页</button>
        </div>
      </div>
      <footer v-if="grid">
        网格 {{ grid.crs }} · {{ grid.resolution.map((n) => n.toFixed(2)).join(' × ') }}
        {{ grid.resolution_unit }}
        <span
          v-if="request.mode === 'region'"
          :title="result.coverage_rule + '；' + result.edge_rule + '；' + result.weighting"
        >
          · 区域均值按面积加权；覆盖率为有效像元比例 ⓘ</span
        ><span v-else> · 输入坐标所在像元</span> · 缺测不补零、不插值
      </footer>
    </div>
  </section>
</template>
<style scoped>
.ts-results {
  position: fixed;
  z-index: 1601;
  left: 16px;
  right: 16px;
  bottom: 14px;
  display: flex;
  flex-direction: column;
  background: var(--surface-panel);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  box-shadow: var(--elevation-3);
  overflow: hidden;
  pointer-events: auto;
}
.ts-results.large {
  z-index: 1602;
  top: 88px;
  bottom: 14px;
}
.ts-results.dragging {
  user-select: none;
}
.ts-resize {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  z-index: 2;
  touch-action: none;
}
.ts-resize:after {
  content: '';
  display: block;
  width: 46px;
  height: 3px;
  border-radius: 3px;
  background: var(--text-faint);
  margin: 2px auto;
}
.ts-result-header {
  flex-shrink: 0;
  min-height: 46px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--border-default);
  background: var(--surface-2);
}
.ts-result-header strong {
  font-size: 14px;
  white-space: nowrap;
}
.ts-result-header strong span {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 400;
  margin-left: 8px;
}
.ts-result-header nav {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}
.ts-result-header button,
.ts-pagination button {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-height: 30px;
  padding: 5px 9px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}
.ts-result-header button:hover,
.ts-result-header button.active {
  color: var(--accent);
  background: var(--accent-surface);
  border-color: var(--accent-border);
}
.ts-result-header .ts-drag-handle {
  cursor: grab;
  touch-action: none;
  color: var(--accent);
  letter-spacing: 2px;
  padding-inline: 6px;
  border-color: var(--accent-border);
}
.ts-result-header .ts-drag-handle:active {
  cursor: grabbing;
}
.ts-tabs {
  display: flex;
  gap: 3px;
}
.ts-stale {
  font-size: 12px;
  color: var(--warning);
}
.ts-result-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ts-curve-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.ts-result-info {
  padding: 18px 20px;
  overflow-y: auto;
  border-right: 1px solid var(--border-default);
  background: var(--surface-2);
}
.ts-info-kicker {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--text-muted);
  margin: 0 0 10px;
}
.ts-result-info h3 {
  font-size: 16px;
  line-height: 1.55;
  color: var(--text-strong);
  margin: 0 0 17px;
  font-weight: 600;
}
.ts-result-info dl {
  margin: 0;
  display: grid;
  gap: 13px;
}
.ts-result-info dl > div {
  display: grid;
  gap: 4px;
}
.ts-result-info dt {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
}
.ts-result-info dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.ts-result-info dd i {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: 1px;
}
.ts-result-info dd span {
  display: block;
  color: var(--text-secondary);
}
.ts-info-note {
  margin: 17px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted);
}
.ts-chart-wrap {
  min-height: 200px;
  min-width: 0;
  background: var(--surface-panel);
}
.ts-result-content footer {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.6;
  padding: 6px 18px;
  color: var(--text-secondary);
  background: var(--surface-2);
  border-top: 1px solid var(--border-default);
}
.ts-table-wrap {
  overflow: auto;
  flex: 1;
  padding: 14px 22px;
  font-size: 12px;
}
.ts-table-wrap p {
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.6;
}
table {
  width: 100%;
  border-collapse: collapse;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
th,
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  text-align: right;
}
th {
  position: sticky;
  top: 0;
  background: var(--surface-3);
  color: var(--text-strong);
  font-weight: 500;
}
tbody tr:nth-child(even) {
  background: var(--surface-sunken);
}
.ts-empty {
  display: grid;
  place-content: center;
  text-align: center;
  height: 100%;
  padding: 24px;
  color: var(--text-secondary);
}
.ts-empty p {
  font-size: 13px;
  line-height: 1.7;
}
.ts-pagination {
  text-align: center;
  padding: 12px;
}
.collapsed .ts-resize {
  display: none;
}
@media (max-width: 1100px) {
  .ts-stale {
    display: none;
  }
  .ts-curve-layout {
    grid-template-columns: 225px minmax(0, 1fr);
  }
  .ts-result-info {
    padding: 14px;
  }
}
@media (max-width: 760px) {
  .ts-result-header {
    gap: 4px;
    padding: 4px;
    flex-wrap: wrap;
  }
  .ts-result-header strong span {
    display: none;
  }
  .ts-result-header nav {
    gap: 0;
  }
  .ts-curve-layout {
    grid-template-columns: 1fr;
    overflow: auto;
  }
  .ts-result-info {
    border-right: 0;
    border-bottom: 1px solid var(--border-default);
    overflow: visible;
    padding: 12px 16px;
  }
  .ts-info-kicker,
  .ts-info-note {
    display: none;
  }
  .ts-result-info h3 {
    margin-bottom: 10px;
    font-size: 14px;
  }
  .ts-result-info dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 14px;
  }
  .ts-chart-wrap {
    min-height: 240px;
  }
}
</style>
