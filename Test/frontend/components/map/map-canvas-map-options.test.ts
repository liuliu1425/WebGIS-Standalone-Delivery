import { LngLat } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'

import {
  createBoundedMapPanConstraint,
  createMapCanvasMapOptions,
} from '@/components/map/map-canvas-map-options'

describe('map-canvas-map-options', () => {
  it('builds stable maplibre options for the map canvas stage', () => {
    const container = {} as HTMLElement

    expect(createMapCanvasMapOptions({ container })).toMatchObject({
      container,
      center: [113.2644, 23.1291],
      zoom: 4.8,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      renderWorldCopies: false,
      cancelPendingTileRequestsWhileZooming: true,
      refreshExpiredTiles: false,
      canvasContextAttributes: {
        preserveDrawingBuffer: false,
      },
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background' }],
      },
    })
  })
})

function makePanFixture(width = 1680, height = 1050) {
  const viewport = { width, height }
  const zoomRange = { min: 0, max: 22 }
  const canvas = {} as HTMLCanvasElement
  Object.defineProperties(canvas, {
    clientWidth: { get: () => viewport.width },
    clientHeight: { get: () => viewport.height },
  })
  const map = {
    getCanvas: () => canvas,
    getMinZoom: () => zoomRange.min,
    getMaxZoom: () => zoomRange.max,
  }
  const constrain = createBoundedMapPanConstraint({
    container: {} as HTMLElement,
    getMap: () => map,
    createLngLat: (longitude, latitude) => new LngLat(longitude, latitude),
  })
  return { constrain, viewport, zoomRange }
}

describe('bounded 2D map pan', () => {
  it('allows horizontal dragging at world fit but stops at a finite screen gutter', () => {
    const { constrain, viewport } = makePanFixture()
    const east = constrain(new LngLat(1000, 0), 0)
    const west = constrain(new LngLat(-1000, 0), 0)
    const worldSize = 512 * 2 ** east.zoom

    expect(worldSize).toBeCloseTo(viewport.width)
    expect((east.center.lng / 360) * worldSize).toBeCloseTo(360)
    expect(west.center.lng).toBeCloseTo(-east.center.lng)
    expect(east.center.lng).toBeGreaterThan(0)
    expect(constrain(new LngLat(2000, 0), east.zoom).center.lng).toBe(east.center.lng)
  })

  it('reads resized CSS dimensions and limits narrow screens to one-third of their width', () => {
    const { constrain, viewport } = makePanFixture()
    viewport.width = 720
    viewport.height = 480

    const result = constrain(new LngLat(1000, 0), 0)
    const worldSize = 512 * 2 ** result.zoom

    expect(worldSize).toBeCloseTo(720)
    expect((result.center.lng / 360) * worldSize).toBeCloseTo(240)
  })

  it('preserves ordinary zoomed-in centers and leaves at most the gutter beyond world edges', () => {
    const { constrain, viewport } = makePanFixture()
    const local = constrain(new LngLat(113.2644, 23.1291), 5)
    expect(local.zoom).toBe(5)
    expect(local.center.lng).toBeCloseTo(113.2644)
    expect(local.center.lat).toBeCloseTo(23.1291)

    const edge = constrain(new LngLat(1000, 0), 5)
    const worldSize = 512 * 2 ** edge.zoom
    const centerX = ((edge.center.lng + 180) / 360) * worldSize
    expect(centerX + viewport.width / 2 - worldSize).toBeCloseTo(360)
    expect(edge.center.lng).toBeLessThan(180)
  })

  it('keeps the north and south viewport inside Mercator bounds at extreme coordinates', () => {
    const { constrain, viewport } = makePanFixture()
    for (const sign of [-1, 1]) {
      const result = constrain(new LngLat(sign * 10000, sign * 89), 3)
      const sine = Math.sin((result.center.lat * Math.PI) / 180)
      const centerY =
        (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * 512 * 2 ** result.zoom
      const worldSize = 512 * 2 ** result.zoom

      expect(Number.isFinite(result.center.lat)).toBe(true)
      expect(Math.abs(result.center.lng)).toBeLessThanOrEqual(180)
      expect(centerY - viewport.height / 2).toBeGreaterThanOrEqual(-0.00001)
      expect(centerY + viewport.height / 2).toBeLessThanOrEqual(worldSize + 0.00001)
    }
  })

  it('respects public zoom limits and never mutates the requested coordinate', () => {
    const { constrain, zoomRange } = makePanFixture()
    zoomRange.min = 3
    zoomRange.max = 8
    const input = Object.freeze(new LngLat(123, 89))
    const low = constrain(input, -10)
    const high = constrain(input, 30)

    expect(low.zoom).toBe(3)
    expect(high.zoom).toBe(8)
    expect(low.center).not.toBe(input)
    expect(input.lng).toBe(123)
    expect(input.lat).toBe(89)
  })

  it('uses the container until the map exists and keeps portrait viewports inside the world', () => {
    const container = {} as HTMLElement
    Object.defineProperties(container, {
      clientWidth: { value: 480 },
      clientHeight: { value: 900 },
    })
    const constrain = createBoundedMapPanConstraint({
      container,
      getMap: () => null,
      createLngLat: (longitude, latitude) => new LngLat(longitude, latitude),
    })
    const result = constrain(new LngLat(0, 89), 0)

    expect(512 * 2 ** result.zoom).toBeCloseTo(900)
    expect(result.center.lat).toBeCloseTo(0)
  })
})
