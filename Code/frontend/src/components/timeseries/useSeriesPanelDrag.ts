import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { usePanelDragResize } from '../ui/usePanelDragResize'

/** Reuse panel dragging while keeping each analysis window inside the viewport. */
export function useSeriesPanelDrag(
  element: Ref<HTMLElement | null>,
  enabled: Ref<boolean> = ref(true),
) {
  const panel = usePanelDragResize({
    draggable: true,
    resizable: false,
    maxOffsetX: 10000,
    maxOffsetY: 10000,
  })
  let observer: ResizeObserver | undefined
  function clampToViewport() {
    const el = element.value
    if (!enabled.value || !el || !el.getClientRects().length) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(
      12,
      Math.min(rect.left, Math.max(12, window.innerWidth - rect.width - 12)),
    )
    const top = Math.max(
      80,
      Math.min(rect.top, Math.max(80, window.innerHeight - rect.height - 12)),
    )
    panel.offsetX.value += left - rect.left
    panel.offsetY.value += top - rect.top
  }
  const dragStyle = computed(() => (enabled.value ? panel.frameStyle.value : { transform: 'none' }))
  function startDrag(event: PointerEvent) {
    if (!enabled.value || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    panel.startDragging(event)
  }
  function resetPosition() {
    panel.offsetX.value = 0
    panel.offsetY.value = 0
  }
  watch([panel.offsetX, panel.offsetY], clampToViewport, { flush: 'post' })
  watch(enabled, async () => {
    await nextTick()
    clampToViewport()
  })
  onMounted(() => {
    window.addEventListener('resize', clampToViewport)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(clampToViewport)
      if (element.value) observer.observe(element.value)
    }
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    window.removeEventListener('resize', clampToViewport)
  })
  return { dragStyle, dragging: panel.dragging, startDrag, resetPosition }
}
