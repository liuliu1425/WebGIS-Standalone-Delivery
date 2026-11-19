import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useOnDemandFrameStore } from '@/stores/layers/ondemand-frame'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@/services/user-local-isolation', () => ({
  readScopedItem: (key: string) => storage.get(key) ?? null,
  writeScopedItem: (key: string, value: string) => storage.set(key, value),
}))
beforeEach(() => { storage.clear(); setActivePinia(createPinia()) })

it('refresh does not claim a saved day loaded until server cache metadata confirms it', () => {
  useOnDemandFrameStore().setDayTag('imported-vod', '20250722')
  setActivePinia(createPinia())
  const restored = useOnDemandFrameStore()
  expect(restored.dayTagFor('imported-vod')).toBeNull()
  restored.restoreCachedDayTag('imported-vod', ['20250701_20250731', '20250722'])
  expect(restored.displayedDayTag('imported-vod', '20250722')).toBe('20250722')
  expect(restored.displayedDayTag('imported-vod', '20250723')).toBeNull()
})

it('an evicted frame is not restored or silently fetched', () => {
  useOnDemandFrameStore().setDayTag('imported-vod', '20250722')
  setActivePinia(createPinia())
  const restored = useOnDemandFrameStore()
  restored.restoreCachedDayTag('imported-vod', ['20250701_20250731'])
  expect(restored.dayTagFor('imported-vod')).toBeNull()
  setActivePinia(createPinia())
  const again = useOnDemandFrameStore()
  again.restoreCachedDayTag('imported-vod', ['20250722'])
  expect(again.dayTagFor('imported-vod')).toBeNull()
})

it('new user requests win over a pending restored frame', () => {
  useOnDemandFrameStore().setDayTag('imported-vod', '20250722')
  setActivePinia(createPinia())
  const restored = useOnDemandFrameStore()
  restored.setDayTag('imported-vod', '20250723')
  restored.restoreCachedDayTag('imported-vod', ['20250722'])
  expect(restored.dayTagFor('imported-vod')).toBe('20250723')
  restored.clearDayTag('imported-vod')
  setActivePinia(createPinia())
  expect(useOnDemandFrameStore().dayTagFor('imported-vod')).toBeNull()
})
