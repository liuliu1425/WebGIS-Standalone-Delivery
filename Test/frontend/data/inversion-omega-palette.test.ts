import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  INVERSION_OMEGA_PALETTE,
  isInversionOmegaOverlayId,
  resolveInversionOmegaDefaultPalette,
} from '@/data/inversion-omega-palette'
import {
  buildOverlayStyleQuery,
  getPaletteColors,
  resolveEffectivePalette,
  resolveStyleRenderHint,
} from '@/components/map/layer-symbology'
import { parseOverlayBoundsMeta } from '@/components/map/overlay-image-module'
import { collectCesiumOverlayTileSpecs } from '@/components/map/globe-engine/cesium/overlay-tiles-adapter'
import { useOverlaySymbologyStore } from '@/stores/overlay-symbology'
import { useSidebarSymbology } from '@/components/layer-sidebar/useSidebarSymbology'
import type { ActiveLayerDisplay } from '@/stores/layers/types'

const colors = ['#DFE6F2', '#B8BDDE', '#9894C7', '#7C6AAD', '#5A3C89']
const catalogs = [
  'method-fy-omega-doy-avg',
  'method-fy-omega-doy-dynamic',
  'method-smap-omega-doy-avg',
  'method-smap-omega-doy-dynamic',
  'method-smap-season-mean',
]
const overlayId = (catalog: string, label = 'OMEGA', variable = 'OMEGA') =>
  'imported-' +
  createHash('sha1')
    .update(catalog + '|' + label + '|' + variable)
    .digest('hex')
    .slice(0, 12)
const targetId = overlayId(catalogs[0])
const fakeLayer = (id = targetId, extra: Record<string, unknown> = {}) =>
  ({
    instanceId: 'instance-omega',
    catalogId: 'catalog-omega',
    visible: true,
    isImportedRaster: true,
    importedRasterOverlayLayerId: id,
    importedRasterEffectiveTime: '2025-07-22',
    opacity: 0.9,
    ...extra,
  }) as unknown as ActiveLayerDisplay

describe('inversion omega purple default', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
  })

  it('uses exactly the five requested color stops', () => {
    expect(getPaletteColors(INVERSION_OMEGA_PALETTE).map((c) => c.toUpperCase())).toEqual(colors)
  })

  for (const catalog of catalogs) {
    for (const [label, variable] of [
      ['OMEGA', 'OMEGA'],
      ['OMEGA_BLOCK', 'OMEGA'],
      ['OMEGA', 'OMEGA_BLOCK'],
      ['OMEGA_BLOCK', 'OMEGA_BLOCK'],
    ]) {
      it(catalog + ' supports ' + label + '/' + variable + ' stable identity', () => {
        const id = overlayId(catalog, label, variable)
        expect(isInversionOmegaOverlayId(id)).toBe(true)
        expect(resolveInversionOmegaDefaultPalette(id, 'reds', true)).toBe(INVERSION_OMEGA_PALETTE)
      })
    }
  }

  it('leaves SM, VOD and unrelated red layers unchanged', () => {
    for (const catalog of catalogs) {
      for (const role of ['SM', 'VOD']) {
        const id = overlayId(catalog, role, role)
        expect(isInversionOmegaOverlayId(id)).toBe(false)
        expect(resolveInversionOmegaDefaultPalette(id, 'reds', true)).toBe('reds')
      }
    }
    expect(resolveInversionOmegaDefaultPalette('other-overlay', 'reds', true)).toBe('reds')
  })

  it('preserves custom registered colors and PNG-only metadata', () => {
    expect(resolveInversionOmegaDefaultPalette(targetId, 'viridis', true)).toBe('viridis')
    expect(resolveInversionOmegaDefaultPalette(targetId, 'reds', false)).toBe('reds')
    expect(resolveInversionOmegaDefaultPalette(targetId, undefined, false)).toBeUndefined()
  })

  it('parses map metadata without changing time, unit, range or opacity', () => {
    const raw = {
      palette: 'reds',
      supports_recolor: true,
      supports_xyz_tiles: true,
      current_time: '2025-07-22',
      time_list: ['2025-07-21', '2025-07-22'],
      category: 'time-series',
      vmin: 0,
      vmax: 0.5,
      unit: 'OMEGA',
      opacity: 0.6,
    }
    const before = structuredClone(raw)
    const prior = parseOverlayBoundsMeta(raw)
    const next = parseOverlayBoundsMeta(raw, targetId)
    expect(next).toEqual({ ...prior, palette: INVERSION_OMEGA_PALETTE })
    expect(raw).toEqual(before)
    expect(parseOverlayBoundsMeta({ ...raw, supports_recolor: false }, targetId).palette).toBe(
      'reds',
    )
  })

  it('keeps sidebar metadata and map defaults identical, with explicit overrides first', () => {
    const store = useOverlaySymbologyStore()
    store.putMeta(targetId, {
      palette: 'reds',
      vmin: 0,
      vmax: 0.5,
      unit: 'OMEGA',
      supports_recolor: true,
    })
    expect(store.getMeta(targetId)?.palette).toBe(INVERSION_OMEGA_PALETTE)
    const sidebar = useSidebarSymbology(store)
    const row = {
      instanceId: 'i',
      catalogId: targetId,
      metricLabel: 'OMEGA',
      accentColor: '#000000',
      opacity: 0.9,
      importedRasterOverlayLayerId: targetId,
      runGroupProductTag: 'OMEGA',
    }
    const ramp = sidebar.getColorRampStyle(row).background.toUpperCase()
    for (const color of colors) expect(ramp).toContain(color)
    expect(sidebar.getSymbologyUnit(row)).toBe('')
    expect(sidebar.getSymbologyVmin(row)).toBe('0')
    expect(sidebar.getSymbologyVmax(row)).toBe('0.5')
    expect(sidebar.getColorRampStyle({ ...row, paletteOverride: 'viridis' })).not.toEqual(
      sidebar.getColorRampStyle(row),
    )
  })

  it('normalizes fetched bounds through the same metadata path', async () => {
    const store = useOverlaySymbologyStore()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          meta: { palette: 'reds', supports_recolor: true, vmin: 0, vmax: 0.5 },
        }),
      })),
    )
    await store.ensureMeta(targetId, { skipRegistryCheck: true })
    expect(store.getMeta(targetId)?.palette).toBe(INVERSION_OMEGA_PALETTE)
  })

  it('updates stale red render hints while retaining range and explicit custom styles', () => {
    const hint = {
      layer_id: targetId,
      paint_mode: 'raster_legend',
      palette: 'reds',
      primary_metric: 'OMEGA',
      unit_label: '',
      opacity: 0.9,
      legend_ticks: [0, 0.25, 0.5],
      notes: [],
    } as const
    const effective = resolveStyleRenderHint({
      renderHint: { ...hint, legend_ticks: [...hint.legend_ticks], notes: [] },
      overlayMeta: { palette: INVERSION_OMEGA_PALETTE, vmin: 0, vmax: 0.5 },
    })
    expect(effective?.palette).toBe(INVERSION_OMEGA_PALETTE)
    expect(effective?.legend_ticks).toEqual([0, 0.25, 0.5])
    expect(
      resolveEffectivePalette({
        paletteOverride: 'reds',
        renderHintPalette: 'reds',
        overlayMetaPalette: INVERSION_OMEGA_PALETTE,
      }),
    ).toBe('reds')
  })

  it('sends the same default palette in preview/tile style queries', () => {
    const meta = parseOverlayBoundsMeta({ palette: 'reds', supports_recolor: true }, targetId)
    const q = new URLSearchParams(
      buildOverlayStyleQuery({ time: '2025-07-22', palette: meta.palette }),
    )
    expect(q.get('palette')).toBe(INVERSION_OMEGA_PALETTE)
    expect(q.get('time')).toBe('2025-07-22')
    const specs = collectCesiumOverlayTileSpecs([fakeLayer()])
    expect(new URLSearchParams(specs[0].urlTemplate.split('?')[1]).get('palette')).toBe(
      INVERSION_OMEGA_PALETTE,
    )
    const custom = collectCesiumOverlayTileSpecs([fakeLayer(targetId, { paletteOverride: 'reds' })])
    expect(new URLSearchParams(custom[0].urlTemplate.split('?')[1]).get('palette')).toBe('reds')
    const registered = collectCesiumOverlayTileSpecs([
      fakeLayer(targetId, { defaultPalette: 'viridis' }),
    ])
    expect(new URLSearchParams(registered[0].urlTemplate.split('?')[1]).get('palette')).toBe(
      'viridis',
    )
  })
})
