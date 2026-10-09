import { createAutoScroll } from "@turenlabs/ui/hooks"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createSignal, onCleanup } from "solid-js"

export function createTeamScroll() {
  // Room output can finish layout long after the latest poll completes.
  const follow = createAutoScroll({ working: () => true, overflowAnchor: "none" })
  const [element, setElement] = createSignal<HTMLDivElement>()
  let frame: number | undefined
  let anchor: { height: number; top: number } | undefined

  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    anchor = undefined
  }

  const update = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const el = element()
      if (el && anchor) {
        el.scrollTop = anchor.top + el.scrollHeight - anchor.height
        // The previous page can be too short for pause() to take effect.
        follow.pause()
      }
      anchor = undefined
      follow.scrollToBottom()
    })
  }

  createResizeObserver(element, () => follow.scrollToBottom())
  onCleanup(cancel)

  const resume = () => {
    cancel()
    follow.resume()
    update()
  }

  return {
    scrollRef: (el: HTMLDivElement) => {
      setElement(el)
      follow.scrollRef(el)
    },
    contentRef: follow.contentRef,
    handleScroll: follow.handleScroll,
    handleInteraction: follow.handleInteraction,
    update,
    cancel,
    reset: resume,
    resume,
    prepend: () => {
      const el = element()
      if (!el) return
      cancel()
      follow.pause()
      anchor = { height: el.scrollHeight, top: el.scrollTop }
      update()
    },
  }
}
