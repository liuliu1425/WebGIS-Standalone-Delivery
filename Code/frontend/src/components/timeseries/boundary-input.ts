import proj4 from 'proj4'
import { requestJson } from '../../services/_http'
import { parseVectorFile } from '../../services/data-import'

/** Inspect ZIP central directory before the existing shpjs worker reprojects .prj. */
function zipEntries(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer),
    entries: Array<{ name: string; compression: number; size: number; offset: number }> = []
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 22; i++) {
    if (view.getUint32(i, true) !== 0x06054b50) continue
    let at = view.getUint32(i + 16, true)
    const count = view.getUint16(i + 10, true)
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
        throw new Error('ZIP 目录无效')
      const length = view.getUint16(at + 28, true)
      entries.push({
        name: new TextDecoder().decode(bytes.slice(at + 46, at + 46 + length)).toLowerCase(),
        compression: view.getUint16(at + 10, true),
        size: view.getUint32(at + 20, true),
        offset: view.getUint32(at + 42, true),
      })
      at += 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    }
    return entries
  }
  throw new Error('无法读取 ZIP 文件目录')
}
export async function readBoundary(file: File): Promise<GeoJSON.Feature[]> {
  const zip = file.name.toLowerCase().endsWith('.zip')
  if (zip) {
    const buffer = await file.arrayBuffer(),
      entries = zipEntries(buffer)
    const names = entries.map((e) => e.name)
    const shapes = names.filter((n) => n.endsWith('.shp'))
    if (!shapes.length) throw new Error('ZIP 中没有 SHP 文件')
    for (const shp of shapes) {
      for (const ext of ['.shx', '.dbf', '.prj']) {
        if (!names.includes(shp.slice(0, -4) + ext))
          throw new Error('SHP ZIP 缺少同名 ' + ext + ' 文件；不能猜测坐标系')
      }
      const entry = entries.find((e) => e.name === shp.slice(0, -4) + '.prj')!
      const view = new DataView(buffer),
        at = entry.offset
      if (at + 30 > buffer.byteLength || view.getUint32(at, true) !== 0x04034b50)
        throw new Error('ZIP 中的坐标系文件无效')
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
      if (start + entry.size > buffer.byteLength) throw new Error('ZIP 坐标系文件不完整')
      const payload = buffer.slice(start, start + entry.size)
      let text: string
      if (entry.compression === 0) text = new TextDecoder().decode(payload)
      else if (entry.compression === 8)
        text = await new Response(
          new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
        ).text()
      else throw new Error('不支持此 ZIP 压缩方式，请使用标准 ZIP')
      if (!text.trim()) throw new Error('.prj 坐标系文件为空，不能猜测坐标系')
      try {
        proj4(text.trim(), 'EPSG:4326', [0, 0])
      } catch {
        throw new Error('无法识别 .prj 坐标系，请提供有效投影定义')
      }
    }
  } else if (!/\.(geojson|json)$/i.test(file.name))
    throw new Error('请上传完整 SHP ZIP 或 GeoJSON，不能只上传 .shp')
  const parsed = await parseVectorFile(file)
  let features = parsed.geojson.features
  if (!zip) {
    const raw = JSON.parse(await file.text())
    const source = raw.crs?.properties?.name
    if (source && !/4326|CRS84/.test(source)) {
      const crs = source.replace(/^urn:ogc:def:crs:EPSG::/, 'EPSG:')
      const convert = (c: number[] | unknown[]): unknown[] =>
        typeof c[0] === 'number'
          ? proj4(crs, 'EPSG:4326', c as [number, number])
          : c.map((v) => convert(v as unknown[]))
      features = features.map((f) => ({
        ...f,
        geometry: {
          ...f.geometry,
          coordinates: convert((f.geometry as GeoJSON.Polygon).coordinates),
        } as GeoJSON.Geometry,
      }))
    }
  }
  const polygons = features.filter(
    (f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
  )
  if (!polygons.length) throw new Error('文件中没有可分析的面要素')
  for (const f of polygons) {
    const geometry = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
    const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat()
    for (const ring of rings) {
      if (ring.length < 4 || ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1])
        throw new Error('边界环没有闭合或顶点不足，请修复边界文件')
      if (
        ring.some(
          (p) =>
            !Number.isFinite(p[0]) ||
            !Number.isFinite(p[1]) ||
            Math.abs(p[0]) > 180 ||
            Math.abs(p[1]) > 90,
        )
      )
        throw new Error('边界坐标不在 WGS84 范围内，请检查 .prj 坐标系；不会按经纬度猜测投影坐标')
    }
  }
  return polygons
}
export function featureName(f: GeoJSON.Feature, index: number): string {
  const p = f.properties || {}
  return String(
    p.name_zh ||
      p.name ||
      p.NAME ||
      p.NAME_1 ||
      p['市'] ||
      p['名称'] ||
      p['市名'] ||
      p.admin ||
      '要素 ' + (index + 1),
  )
}

/** Dissolve all polygon features through the existing server geometry engine. */
export async function mergeBoundaryFeatures(
  features: GeoJSON.Feature[],
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  const polygons = features.filter(
    (feature) => feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon',
  )
  if (!polygons.length) throw new Error('没有可合并的有效面要素，请检查边界文件。')
  const result = await requestJson<{
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
    feature_count: number
  }>('/analysis/time-series/boundary/merge', {
    method: 'POST',
    body: JSON.stringify({ features: polygons }),
    silent: true,
  })
  const geometry = result.geometry
  if (
    !geometry ||
    !['Polygon', 'MultiPolygon'].includes(geometry.type) ||
    !Array.isArray(geometry.coordinates) ||
    !geometry.coordinates.length
  )
    throw new Error('区域边界合并失败：服务未返回有效多边形。')
  return geometry
}
