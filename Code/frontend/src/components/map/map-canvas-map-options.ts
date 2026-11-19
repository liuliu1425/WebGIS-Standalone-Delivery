import type { LngLat, Map, MapOptions, StyleSpecification } from 'maplibre-gl'

import { getMapDefaults } from '../../services/map-defaults'

interface CreateMapCanvasMapOptionsOptions {
  container: HTMLElement
}

/**
 * 从 :root 读取 CSS 变量的实际计算值， fallback 到暗色默认。
 * MapLibre GL JS 的 WebGL 渲染器不支持 CSS 自定义属性（var(--xxx)），
 * 必须传入字面量颜色值。
 */
export function resolveSurfaceColor(varName = '--surface-1'): string {
  if (typeof document === 'undefined') return '#0b1a2a'
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || '#0b1a2a'
}

/**
 * 解析 background layer 颜色（globe 感知）。
 *
 * - 2D：--surface-1（原行为，地图画布底色）
 * - 3D globe：深空蓝（暗色主题）/浅蓝灰（浅色主题）——background layer 在
 *   globe 投影下渲染于球面，作为"无瓦片区域兜底色"（高德等仅覆盖中国的源
 *   拖到南半球时避免露出 --surface-1 导致球面发白发灰）；球外区域保持
 *   透明，让 GlobeStarfield 星图层透出。
 */
export function resolveGlobeBackgroundColor(isGlobe: boolean, isLightTheme: boolean): string {
  if (!isGlobe) return resolveSurfaceColor()
  return isLightTheme ? '#c3d0de' : '#0d2436'
}

type MapPanConstraint = NonNullable<MapOptions['transformConstrain']>

interface CreateBoundedMapPanConstraintOptions {
  container: HTMLElement
  getMap: () => Pick<Map, 'getCanvas' | 'getMinZoom' | 'getMaxZoom'> | null
  createLngLat: (longitude: number, latitude: number) => LngLat
}

const MERCATOR_MAX_LATITUDE = 85.0511287798066
const MAP_WORLD_TILE_SIZE = 512
const MAX_HORIZONTAL_PAN_GUTTER_PX = 360

/**
 * Keep one world, but allow a bounded gutter so side panels do not trap its edges.
 * Read CSS canvas dimensions on every update (including resize), not device pixels.
 * The factory is supplied after MapLibre's existing lazy import.
 */
export function createBoundedMapPanConstraint(
  options: CreateBoundedMapPanConstraintOptions,
): MapPanConstraint {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

  return (lngLat, zoom) => {
    const map = options.getMap()
    const canvas = map?.getCanvas()
    const width = Math.max(1, canvas?.clientWidth || options.container.clientWidth || 1)
    const height = Math.max(1, canvas?.clientHeight || options.container.clientHeight || 1)
    const minZoom = map?.getMinZoom() ?? 0
    const maxZoom = map?.getMaxZoom() ?? 22
    // Preserve the former global-fit minimum instead of allowing a tiny world to drift away.
    const worldFitZoom = Math.log2(Math.max(width, height) / MAP_WORLD_TILE_SIZE)
    const nextZoom = clamp(
      Number.isFinite(zoom) ? zoom : minZoom,
      Math.max(minZoom, worldFitZoom),
      maxZoom,
    )
    const worldSize = MAP_WORLD_TILE_SIZE * 2 ** nextZoom
    const gutter = Math.min(MAX_HORIZONTAL_PAN_GUTTER_PX, width / 3)
    const maxCenterOffset = Math.min(
      worldSize / 2,
      Math.max(0, (worldSize - width) / 2) + gutter,
    )
    const maxLongitude = (maxCenterOffset / worldSize) * 360
    const longitude = clamp(lngLat.lng, -maxLongitude, maxLongitude)

    // Retain the Mercator north/south viewport constraint; missing pixels stay outside.
    const latitude = clamp(lngLat.lat, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE)
    const sine = Math.sin((latitude * Math.PI) / 180)
    const mercatorY = 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)
    const halfViewport = Math.min(0.5, height / (2 * worldSize))
    const centerY = clamp(mercatorY, halfViewport, 1 - halfViewport)
    const nextLatitude = (Math.atan(Math.sinh(Math.PI * (1 - 2 * centerY))) * 180) / Math.PI

    return {
      center: options.createLngLat(longitude, nextLatitude),
      zoom: nextZoom,
    }
  }
}

export function createMapCanvasMapOptions(options: CreateMapCanvasMapOptionsOptions): MapOptions {
  const mapDefaults = getMapDefaults()
  return {
    container: options.container,
    style: {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': resolveSurfaceColor() },
        },
      ],
    } as StyleSpecification,
    center: [mapDefaults.longitude, mapDefaults.latitude],
    zoom: mapDefaults.zoom,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
    // 只渲染一份世界；2D 的有限横向留白由 createBoundedMapPanConstraint 管理。
    // 全球覆盖叠加层不会在 ±360° 重复出现。
    renderWorldCopies: false,
    cancelPendingTileRequestsWhileZooming: true,
    refreshExpiredTiles: false,
    canvasContextAttributes: {
      // preserveDrawingBuffer=false（默认）：不回读 framebuffer，大幅提升与 Canvas 2D 叠加层的合成性能
      // 截图：captureMapCanvas() 在 MapLibre `render` 事件回调内同步 toDataURL（无公开 Map.render）
      preserveDrawingBuffer: false,
    },
  }
}
