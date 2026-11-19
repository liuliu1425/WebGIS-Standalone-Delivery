import { onBeforeUnmount, onMounted, watch } from 'vue'

import type { AgentQuota } from '../../services/agent-api'

/** 只刷新额度状态；恢复发送仍以后端返回值为准，不在浏览器自行补充额度。 */
export function useAgentQuotaReset(
  getQuota: () => AgentQuota | null,
  isOpen: () => boolean,
  refresh: () => Promise<void>,
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let attemptedReset = ''
  let lastAttempt = 0
  let refreshing = false
  let disposed = false

  function resetTime() {
    const quota = getQuota()
    if (!isOpen() || quota?.scope !== 'guest' || quota.limit <= 0) return null
    const at = Date.parse(quota.reset_at)
    return Number.isFinite(at) ? { raw: quota.reset_at, at } : null
  }

  function clearTimer() {
    if (timer != null) clearTimeout(timer)
    timer = null
  }

  function schedule() {
    clearTimer()
    if (disposed) return
    const reset = resetTime()
    if (!reset || attemptedReset === reset.raw) return
    timer = setTimeout(() => void refreshIfDue(), Math.max(0, reset.at - Date.now()) + 100)
  }

  async function refreshIfDue(retry = false) {
    const reset = resetTime()
    if (disposed || refreshing || !reset || reset.at > Date.now()) return
    if (attemptedReset === reset.raw && (!retry || Date.now() - lastAttempt < 1000)) return
    attemptedReset = reset.raw
    lastAttempt = Date.now()
    refreshing = true
    try {
      await refresh()
    } catch {
      // 额度读取失败保留旧状态，回到页面时仍可重试。
    } finally {
      refreshing = false
      // 失败或过期响应不自旋；下次回到页面时可再尝试。
      schedule()
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void refreshIfDue(true)
  }

  function onFocus() {
    void refreshIfDue(true)
  }

  watch(
    () => [getQuota()?.scope, getQuota()?.limit, getQuota()?.reset_at, isOpen()],
    schedule,
    { immediate: true },
  )

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
  })
  onBeforeUnmount(() => {
    disposed = true
    clearTimer()
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onFocus)
  })
}
