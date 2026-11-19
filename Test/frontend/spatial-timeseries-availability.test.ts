// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import Workspace from '@/components/timeseries/TimeSeriesWorkspace.vue'
const api=vi.hoisted(()=>({availability:vi.fn(),submit:vi.fn()}))
const product=(id:string,dates=['2015-04-01','2025-07-10','2025-07-12'])=>({id,source_kind:'nas_daily',product_name:id,variable:'SM',frames:dates.map(d=>({key:d,start:d,end:d,cadence:'daily'})),coverage_bounds:[-180,-85,180,85]})
vi.mock('@/services/spatial-timeseries',async orig=>({...await orig<typeof import('@/services/spatial-timeseries')>(),
  getSeriesProducts:async()=>({items:[product('A'),product('B')]}),getSeriesAvailability:api.availability,submitSeries:api.submit}))
vi.mock('@/app/admin-boundaries',()=>({loadWorldAdmin0Boundaries:vi.fn(),loadWorldAdmin1Boundaries:vi.fn()}))
const props={open:true,locate:vi.fn(()=>true),pick:vi.fn(()=>true),draw:vi.fn(()=>true),cancelDraw:vi.fn(),preview:vi.fn()}
const create=async()=>{const w=mount(Workspace,{props,global:{stubs:{TimeSeriesResults:true}}});await flushPromises();return w}
const button=(w:Awaited<ReturnType<typeof create>>,name:string)=>w.findAll('button').find(b=>b.text()===name)!
beforeEach(()=>{vi.clearAllMocks();api.availability.mockImplementation(async id=>product(id))})
it('shows real dates, selected observation counts and missing dates without submitting',async()=>{
  const w=await create()
  await w.get('[aria-label="分析开始日期"]').setValue('2025-07-10')
  await w.get('[aria-label="分析结束日期"]').setValue('2025-07-12')
  expect(w.text()).toContain('2 个观测期，1 天缺测')
  expect(w.get('[aria-label="分析开始日期"]').attributes('min')).toBe('2015-04-01')
  expect(api.submit).not.toHaveBeenCalled();w.unmount()
})
it('discards availability arriving late for a previous product',async()=>{
  let resolve!:(v:unknown)=>void
  api.availability.mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
  const w=await create()
  await w.get('[aria-label="时序分析产品"]').setValue('B');await flushPromises()
  resolve(product('A',['2026-01-01']));await flushPromises()
  expect(w.get('[aria-label="分析结束日期"]').attributes('max')).toBe('2025-07-12')
  expect(w.text()).not.toContain('2026-01-01');w.unmount()
})
it('connection failure clears dates and disables submit instead of using cached dates',async()=>{
  api.availability.mockRejectedValue(new Error('数据源连接失败'))
  const w=await create()
  expect(w.text()).toContain('数据源连接失败')
  expect(button(w,'生成曲线').attributes()).toHaveProperty('disabled')
  expect(w.get('[aria-label="分析开始日期"]').element).toHaveProperty('value','');w.unmount()
})
it('keeps coordinate validity distinct from coverage and updates a marked point',async()=>{
  const w=await create()
  await button(w,'在地图上定位').trigger('click')
  await w.get('[aria-label="分析纬度"]').setValue('86')
  expect(w.text()).toContain('坐标有效，但位于当前产品数据覆盖范围外')
  expect(props.locate).toHaveBeenLastCalledWith([116.4,86],false)
  await button(w,'生成曲线').trigger('click')
  expect(api.submit).not.toHaveBeenCalled();w.unmount()
})
it('map pick fills longitude first and does not start analysis',async()=>{
  const w=await create()
  await button(w,'地图选点').trigger('click')
  const [done,ended]=props.pick.mock.calls[0] as unknown as [(p:number[])=>void,()=>void]
  done([113.26,23.13]);ended();await flushPromises()
  expect(w.get('[aria-label="分析经度"]').element).toHaveProperty('value','113.26')
  expect(w.get('[aria-label="分析纬度"]').element).toHaveProperty('value','23.13')
  expect(api.submit).not.toHaveBeenCalled();w.unmount()
})
