import { requestJson } from './_http'
import { cancelWorkflowRun } from './runtime-api'

export type Cadence = 'daily' | 'monthly' | `period-${number}d`
export function cadenceLabel(cadence: string): string {
  return cadence === 'daily'
    ? '单日数据'
    : cadence === 'monthly'
      ? '自然月合成'
      : cadence.replace(/^period-(\d+)d$/, '$1 日合成')
}
export type Statistic = 'mean' | 'std' | 'min' | 'max'
export interface SeriesFrame {
  key: string
  start: string
  end: string
  cadence: Cadence
}
export interface SeriesProduct {
  id: string
  catalog_id: string
  product_name: string
  variable: string
  variable_name: string
  unit: string
  unit_source: string
  native_step: string
  timezone: string
  frames: SeriesFrame[]
  source_kind?: 'nas_daily' | 'local_composite'
  source_id?: string
  source_note?: string
  coverage_bounds?: [number, number, number, number]
  coverage_note?: string
}
export interface SeriesRequest {
  product_id: string
  mode: 'point' | 'region'
  point: [number, number] | null
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null
  location_name: string
  start: string
  end: string
  cadence: Cadence
  statistic: Statistic
}
export interface SeriesRow {
  key: string
  start: string
  end: string
  value: number | null
  mean?: number | null
  std?: number | null
  min?: number | null
  max?: number | null
  count: number
  total_count: number
  coverage: number | null
  status: string
  grid?: { crs: string; resolution: number[]; resolution_unit: string }
  pixel?: { row: number; column: number; center: number[] }
}
export interface SeriesResult {
  schema_version: number
  product: Omit<SeriesProduct, 'frames'>
  request: SeriesRequest
  rows: SeriesRow[]
  valid_count: number
  timezone: string
  edge_rule: string
  coverage_rule: string
  quality_rule: string
  weighting: string
}
export const statisticLabels: Record<Statistic, string> = {
  mean: '均值',
  std: '标准差',
  min: '最小值',
  max: '最大值',
}
export function rowValue(row: SeriesRow, request: SeriesRequest): number | null {
  return request.mode === 'point' ? row.value : (row[request.statistic] ?? null)
}
export function timestamp(date: string): number {
  return Date.parse(date + 'T00:00:00Z')
}
export function formatValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '无有效数据'
    : new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 7 }).format(value)
}
export function resultFilename(r: SeriesResult): string {
  return [r.product.variable, r.request.mode, r.request.start, r.request.end].join('_')
}
export function seriesCSV(r: SeriesResult): string {
  const header = [
    '产品',
    '变量',
    '单位',
    '位置',
    '经度',
    '纬度',
    '观测开始日期',
    '观测结束日期',
    '时间尺度',
    '时间说明',
    '统计量',
    '数值',
    '均值',
    '标准差',
    '最小值',
    '最大值',
    '有效像元数',
    '区域栅格像元数',
    '有效像元覆盖率',
    '状态',
    '像元规则',
    '面积权重',
  ]
  const quote = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
  const rows = r.rows.map((row) => [
    r.product.product_name,
    r.product.variable_name,
    r.product.unit,
    r.request.location_name,
    r.request.point?.[0],
    r.request.point?.[1],
    row.start,
    row.end,
    cadenceLabel(r.request.cadence),
    r.timezone,
    r.request.mode === 'point' ? '所在像元值' : statisticLabels[r.request.statistic],
    rowValue(row, r.request),
    row.mean,
    row.std,
    row.min,
    row.max,
    row.count,
    row.total_count,
    row.coverage,
    row.status,
    r.edge_rule,
    r.weighting,
  ])
  return '\uFEFF' + [header, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export const getSeriesProducts = () =>
  requestJson<{ items: SeriesProduct[] }>('/analysis/time-series/products')
export const getSeriesAvailability = (id: string) =>
  requestJson<SeriesProduct>('/analysis/time-series/products/' + encodeURIComponent(id) + '/availability')
export const submitSeries = (payload: SeriesRequest) =>
  requestJson<{ run_id: string }>('/analysis/time-series/runs', {
    method: 'POST',
    body: JSON.stringify(payload),
    // Submission verifies the NAS observation directory before queueing.
    // Give this request time to finish across the public test tunnel.
    timeoutMs: 120000,
  })
export const cancelSeries = cancelWorkflowRun
export interface SeriesRun {
  status: string
  progress: number
  message: string
  result_refs: Array<{
    result_id: string
    title: string
    result_kind: string
    resource_url?: string | null
  }>
}
export const getSeriesRun = (id: string) =>
  requestJson<SeriesRun>('/workflow-runs/' + encodeURIComponent(id), { silent: true })
export const getSeriesResult = (url: string) => requestJson<SeriesResult>(url, { silent: true })
