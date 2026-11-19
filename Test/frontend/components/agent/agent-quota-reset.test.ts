// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@/test-utils'
import { useAgentQuotaReset } from '@/components/agent/useAgentQuotaReset'
import type { AgentQuota } from '@/services/agent-api'

const exhausted: AgentQuota = {
  scope: 'guest', limit: 20, used: 20, remaining: 0, percent: 0,
  reset_at: '2026-11-18T00:00:00+08:00', blocked: true,
}
const restored: AgentQuota = {
  ...exhausted, used: 0, remaining: 20, percent: 100, blocked: false,
  reset_at: '2026-11-19T00:00:00+08:00',
}
const wrappers: Array<{ unmount: () => void }> = []
function show(refresh: () => Promise<void>, quota = exhausted, open = true) {
  const wrapper = mount({
    props: ['quota', 'open'],
    setup(props: { quota: AgentQuota | null; open: boolean }) {
      useAgentQuotaReset(() => props.quota, () => props.open, refresh)
      return {}
    },
    template: '<button :disabled="quota?.blocked">提问</button>',
  }, { props: { quota: { ...quota }, open } })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-17T15:59:59Z'))
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('guest quota reset refresh', () => {
  it('refreshes at Beijing midnight and unlocks only from the returned quota', async () => {
    const refresh = vi.fn(async () => { await wrapper.setProps({ quota: restored }) })
    const wrapper = show(refresh)
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(101)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined()
  })
  it('refreshes when returning after a background-tab clock jump', async () => {
    const refresh = vi.fn(async () => {})
    show(refresh)
    vi.setSystemTime(new Date('2026-11-17T16:01:00Z'))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('does not loop on an old response or manufacture a new balance', async () => {
    const refresh = vi.fn(async () => {})
    const wrapper = show(refresh)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
  it('can retry on return after a failed refresh without rapid focus retries', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('quota unavailable'))
    show(refresh)
    await vi.advanceTimersByTimeAsync(1100)
    expect(refresh).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(2)
  })
  it('does not schedule guest refreshes for account access or a closed panel', async () => {
    const refresh = vi.fn(async () => {})
    show(refresh, { ...exhausted, scope: 'account', limit: 0 })
    show(refresh, exhausted, false)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refresh).not.toHaveBeenCalled()
  })
  it('cleans up both timer and foreground listeners when unmounted', async () => {
    const refresh = vi.fn(async () => {})
    const wrapper = show(refresh)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5000)
    window.dispatchEvent(new Event('focus'))
    expect(refresh).not.toHaveBeenCalled()
  })
})
