import type { Map as MapInstance, GeoJSONSource } from 'maplibre-gl'
import { Marker, LngLatBounds } from 'maplibre-gl'
import { createDrawModule, type DrawStateSnapshot } from '../map/draw-module'
export function createAnalysisDrawing(map: MapInstance, active: (value: boolean) => void) {
  let module: ReturnType<typeof createDrawModule> | null = null
  let drawing = false
  let restore = () => {}
  const previewId = 'analysis-region-preview'
  let pointMarker: Marker | null = null
  let regionLabel: Marker | null = null
  let pickHandler: ((event: { lngLat: { lng: number; lat: number } }) => void) | null = null
  let pickEnd: (() => void) | null = null
  function label(text: string) {
    const element = document.createElement('div')
    element.textContent = text
    element.style.cssText =
      'padding:6px 9px;background:#fff;color:#174d8a;border:1px solid #1677ff;border-radius:6px;font:600 12px Arial,Microsoft YaHei,sans-serif;box-shadow:0 2px 8px #122d5340;white-space:nowrap;pointer-events:none'
    return element
  }
  function showPoint(point: [number, number] | null, fly = true) {
    if (!point) {
      pointMarker?.remove()
      pointMarker = null
      return
    }
    if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return
    if (!pointMarker) {
      pointMarker = new Marker({ color: '#1677ff', scale: 1.15 }).setLngLat(point).addTo(map)
      const caption = label('')
      caption.className = 'analysis-coordinate-label'
      caption.style.position = 'absolute'
      caption.style.bottom = '44px'
      caption.style.left = '50%'
      caption.style.transform = 'translateX(-50%)'
      pointMarker.getElement().append(caption)
    }
    pointMarker.setLngLat(point)
    pointMarker.getElement().querySelector('.analysis-coordinate-label')!.textContent =
      `经度 ${point[0].toFixed(5)} · 纬度 ${point[1].toFixed(5)} · WGS84`
    if (fly) map.easeTo({ center: point, zoom: 8, duration: 450 })
  }
  function preview(geometry: GeoJSON.Geometry | null, name = '', fit = true) {
    regionLabel?.remove()
    regionLabel = null
    // Vue props contain reactive proxies. MapLibre 6 sends GeoJSON to its worker
    // through structured cloning, which cannot clone those proxies.
    geometry = geometry ? (JSON.parse(JSON.stringify(geometry)) as GeoJSON.Geometry) : null
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : [],
    }
    if (!map.getSource(previewId)) {
      map.addSource(previewId, { type: 'geojson', data })
      map.addLayer({
        id: previewId + '-fill',
        type: 'fill',
        source: previewId,
        paint: { 'fill-color': '#1677ff', 'fill-opacity': 0.12 },
      })
      map.addLayer({
        id: previewId + '-line',
        type: 'line',
        source: previewId,
        paint: { 'line-color': '#111111', 'line-width': 2 },
      })
    } else (map.getSource(previewId) as GeoJSONSource).setData(data)
    if (geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
      const positions =
        geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2)
      const bounds = new LngLatBounds()
      positions.forEach((p) => bounds.extend([p[0], p[1]]))
      if (!bounds.isEmpty()) {
        if (fit) {
          const canvas = map.getCanvas()
          const width = canvas.clientWidth || 1600,
            height = canvas.clientHeight || 1000
          const canvasRect = canvas.getBoundingClientRect()
          // Reserve the initial results pane before it opens, so generating
          // the first curve does not cover the lower half of the boundary.
          let bottom = Math.max(380, height / 3) + 35
          // Keep the boundary above the existing time bar or expanded result pane.
          for (const overlay of document.querySelectorAll('.timeline, .ts-results')) {
            const rect = overlay.getBoundingClientRect()
            if (rect.width && rect.height && rect.top > canvasRect.top)
              bottom = Math.max(
                bottom,
                canvasRect.bottom - rect.top + (overlay.matches('.timeline') ? 65 : 20),
              )
          }
          map.fitBounds(bounds, {
            padding: {
              top: Math.min(130, height * 0.15),
              bottom: Math.min(bottom, height * 0.65),
              left: Math.min(350, width * 0.23),
              right: Math.min(430, width * 0.29),
            },
            maxZoom: 11,
            duration: 450,
          })
        }
        if (name)
          regionLabel = new Marker({ element: label(name), anchor: 'bottom' })
            .setLngLat(bounds.getCenter())
            .addTo(map)
      }
      map.moveLayer(previewId + '-fill')
      map.moveLayer(previewId + '-line')
    }
  }
  function cancel() {
    if (pickHandler) map.off('click', pickHandler)
    pickHandler = null
    document.removeEventListener('keydown', escape)
    module?.dispose()
    module = null
    if (drawing) restore()
    drawing = false
    active(false)
    const ended = pickEnd
    pickEnd = null
    ended?.()
  }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }
  function pick(done: (point: [number, number]) => void, ended: () => void) {
    cancel()
    const cursor = map.getCanvas().style.cursor
    restore = () => {
      map.getCanvas().style.cursor = cursor
    }
    drawing = true
    active(true)
    pickEnd = ended
    map.getCanvas().style.cursor = 'crosshair'
    document.addEventListener('keydown', escape)
    pickHandler = (event) => {
      // MapLibre lngLat is WGS84 degrees even when the canvas uses Web Mercator
      // or the globe projection. Wrap repeated world copies, never treat x/y as degrees.
      const lng = ((((event.lngLat.lng + 180) % 360) + 360) % 360) - 180
      const point: [number, number] = [lng, event.lngLat.lat]
      cancel()
      showPoint(point, false)
      done(point)
    }
    map.on('click', pickHandler)
  }
  function begin(mode: 'polygon' | 'rectangle', done: (geometry: GeoJSON.Polygon) => void) {
    cancel()
    const handlers = [map.dragPan, map.doubleClickZoom, map.boxZoom]
    const enabled = handlers.map((h) => h.isEnabled())
    restore = () => {
      handlers.forEach((h, i) => (enabled[i] ? h.enable() : h.disable()))
      map.getCanvas().style.cursor = ''
    }
    drawing = true
    active(true)
    map.dragPan.disable()
    map.getCanvas().style.cursor = 'crosshair'
    document.addEventListener('keydown', escape)
    const state: DrawStateSnapshot = {
      drawMode: mode,
      features: [],
      activeVertices: [],
      isDrawing: false,
      hoverPoint: null,
      selectedFeatureIndex: null,
    }
    const sync = () => module?.syncFromStore()
    module = createDrawModule({
      map,
      idPrefix: 'analysis-',
      getInteractionMode: () => (drawing ? 'draw' : 'move'),
      getDrawState: () => state,
      addVertex: (v) => {
        state.activeVertices.push(v)
        sync()
      },
      undoLastVertex: () => {
        state.activeVertices.pop()
        sync()
      },
      setHoverPoint: (p) => {
        state.hoverPoint = p
        sync()
      },
      addFeature: (f) => {
        const geometry = f.geometry as GeoJSON.Polygon
        queueMicrotask(() => {
          cancel()
          preview(geometry)
          done(geometry)
        })
      },
      clearActiveVertices: () => {
        state.activeVertices = []
        sync()
      },
      setDrawingFlag: (v) => {
        state.isDrawing = v
      },
      scheduleDraftPersist: () => {},
    })
    module.bindEvents()
    module.applyDrawMode()
  }
  function dispose() {
    cancel()
    pointMarker?.remove()
    regionLabel?.remove()
    for (const suffix of ['-line', '-fill'])
      if (map.getLayer(previewId + suffix)) map.removeLayer(previewId + suffix)
    if (map.getSource(previewId)) map.removeSource(previewId)
  }
  return { begin, cancel, preview, dispose, showPoint, pick }
}
