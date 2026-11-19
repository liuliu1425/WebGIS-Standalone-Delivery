// @vitest-environment jsdom
// Mock map unit checks; real WebGL verification is recorded separately.
import { beforeEach, expect, it, vi } from 'vitest'
import { reactive, isProxy } from 'vue'
const markers: Array<{ element: HTMLElement; point: unknown; removed: boolean }> = []
vi.mock('maplibre-gl', () => ({
  Marker: class {
    element: HTMLElement; point: unknown; removed = false
    constructor(options: { element?: HTMLElement }) { this.element = options.element || document.createElement('div'); markers.push(this) }
    setLngLat(point: unknown) { this.point = point; return this }
    addTo() { return this }
    getElement() { return this.element }
    remove() { this.removed = true }
  },
  LngLatBounds: class {
    points: number[][] = []
    extend(p: number[]) { this.points.push(p); return this }
    isEmpty() { return !this.points.length }
    getCenter() { return this.points[0] }
  },
}))
vi.mock('@/components/map/draw-module', () => ({ createDrawModule: vi.fn() }))
import { createAnalysisDrawing } from '@/components/timeseries/analysis-drawing'
function setup() {
  const handlers = new Map<string, (...args: any[]) => void>()
  const canvas = document.createElement('canvas'), source = { setData: vi.fn() }
  const map = { on: vi.fn((key, fn) => handlers.set(key, fn)), off: vi.fn(key => handlers.delete(key)), getCanvas: () => canvas,
    getSource: vi.fn(() => source), addSource: vi.fn(), addLayer: vi.fn(), moveLayer: vi.fn(), fitBounds: vi.fn(), easeTo: vi.fn(), getLayer: () => false, removeSource: vi.fn() }
  const active = vi.fn()
  return { map, source, handlers, canvas, active, analysis: createAnalysisDrawing(map as any, active) }
}
beforeEach(() => { markers.length = 0 })
it('reuses one coordinate marker and changes its WGS84 label', () => {
  const {analysis,map}=setup()
  analysis.showPoint([113.26,23.13]); analysis.showPoint([116.4,39.9],false)
  expect(markers).toHaveLength(1)
  expect(markers[0].point).toEqual([116.4,39.9])
  expect(markers[0].element.textContent).toContain('经度 116.40000 · 纬度 39.90000')
  expect(map.easeTo).toHaveBeenCalledTimes(1)
})
it('picks wrapped world coordinates once and restores cursor', () => {
  const {analysis,handlers,canvas,active}=setup(), done=vi.fn(), ended=vi.fn()
  analysis.pick(done,ended)
  expect(canvas.style.cursor).toBe('crosshair')
  handlers.get('click')!({lngLat:{lng:473.26,lat:23.13}})
  expect(done.mock.calls[0][0][0]).toBeCloseTo(113.26)
  expect(done.mock.calls[0][0][1]).toBe(23.13)
  expect(ended).toHaveBeenCalledOnce()
  expect(handlers.has('click')).toBe(false)
  expect(canvas.style.cursor).toBe('')
  expect(active).toHaveBeenLastCalledWith(false)
})
it('Escape exits without changing a coordinate', () => {
  const {analysis,handlers}=setup(), done=vi.fn(), ended=vi.fn()
  analysis.pick(done,ended)
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
  expect(done).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledOnce()
  expect(handlers.has('click')).toBe(false)
})
it('previews complete multipart polygon and holes, with fit and name', () => {
  const {analysis,map,source}=setup()
  const ring=[[0,0],[4,0],[4,4],[0,4],[0,0]], hole=[[1,1],[1,2],[2,2],[2,1],[1,1]]
  const geometry: GeoJSON.MultiPolygon={type:'MultiPolygon',coordinates:[[ring,hole],[ring]]}
  analysis.preview(reactive(geometry),'样例边界')
  expect(source.setData.mock.calls[0][0].features[0].geometry).toEqual(geometry)
  expect(isProxy(source.setData.mock.calls[0][0].features[0].geometry)).toBe(false)
  expect(map.fitBounds).toHaveBeenCalledOnce()
  expect(markers[0].element.textContent).toBe('样例边界')
})

it('analysis outline uses black while preserving translucent fill', () => {
  const {analysis,map}=setup()
  map.getSource.mockReturnValueOnce(undefined)
  analysis.preview({type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},'区域')
  const paints=map.addLayer.mock.calls.map(call=>call[0].paint)
  expect(paints).toContainEqual({'line-color':'#111111','line-width':2})
  expect(paints).toContainEqual({'fill-color':'#1677ff','fill-opacity':0.12})
})
