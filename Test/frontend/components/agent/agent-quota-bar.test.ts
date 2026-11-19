// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@/test-utils'
import AgentQuotaBar from '@/components/agent/AgentQuotaBar.vue'
import type { AgentQuota } from '@/services/agent-api'

const guest: AgentQuota = {
  scope: 'guest', limit: 20, used: 0, remaining: 20, percent: 100,
  reset_at: '2026-11-18T00:00:00+08:00', blocked: false,
}
const wrappers: Array<{ unmount: () => void }> = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})
function show(quota: AgentQuota) {
  const wrapper = mount(AgentQuotaBar, { props: { quota } })
  wrappers.push(wrapper)
  return wrapper
}
describe('guest quota display', () => {
  it('uses the server daily limit and usage, with no unlimited claim', () => {
    const wrapper = show({ ...guest, used: 3, remaining: 17, percent: 85 })
    expect(wrapper.text()).toContain('每位游客每天 20 次')
    expect(wrapper.text()).toContain('今日已用 3 次 / 上限 20 次')
    expect(wrapper.text()).toContain('剩余 85%')
    expect(wrapper.text()).not.toContain('不限次数')
  })
  it('formats reset in Beijing even when local clock getters disagree', () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(7)
    const wrapper = show({ ...guest, used: 20, remaining: 0, percent: 0, blocked: true })
    expect(wrapper.find('.agent-quota__reset').text()).toContain('11-18 00:00')
    expect(wrapper.find('.agent-quota__reset').text()).toContain('北京时间')
    expect(wrapper.text()).toContain('已用完')
  })
  it('keeps account access unlimited and hides guest usage controls', () => {
    const wrapper = show({ ...guest, scope: 'account', limit: 0, remaining: -1 })
    expect(wrapper.text()).toContain('不限次数')
    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.find('[role=progressbar]').exists()).toBe(false)
  })
  it('keeps an invalid reset out of the displayed date', () => {
    const wrapper = show({ ...guest, blocked: true, reset_at: 'not-a-date' })
    expect(wrapper.find('.agent-quota__reset').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('NaN')
  })
})
