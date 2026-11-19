import { describe, expect, it } from 'vitest'
import { toTimelineLayerDisplayName } from '@/utils/layer-display-name'

describe('timeline product identity label', () => {
  it.each([
    ['method-fy-omega-doy-dynamic', '土壤水分', '风云 · 动态散射约束 · 土壤水分'],
    ['method-fy-omega-doy-avg', '植被光学厚度', '风云 · 平均散射约束 · 植被光学厚度'],
    ['method-smap-season-mean', '土壤水分', 'SMAP · 平均散射约束 · 土壤水分'],
    ['method-smap-omega-doy-dynamic', '等效散射 ω', 'SMAP · 动态散射约束 · 等效散射 ω'],
  ])('shows the stable source/version for %s', (sourceLayerId, name, expected) => {
    expect(toTimelineLayerDisplayName(name, { sourceLayerId })).toBe(expected)
  })
  it('uses workflow metadata when a restored group title is generic', () => {
    expect(toTimelineLayerDisplayName('VOD', { title: '风云卫星反演产品', workflowId: 'omega_sf_fenkuai_fy_single' }))
      .toBe('风云 · 动态散射约束 · 植被光学厚度')
  })
  it('preserves other products without inventing a satellite/version', () => {
    expect(toTimelineLayerDisplayName('ETOPO 高程', {})).toBe('ETOPO 高程')
  })
})
