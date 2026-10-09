import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { isServer } from "solid-js/web"
import { createTeamScroll } from "../src/pages/team/scroll"

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function fixture() {
  const geometry = { height: 1_000, viewport: 200, top: 0 }
  const log = document.createElement("div")
  const content = document.createElement("div")
  log.append(content)
  document.body.append(log)
  // Happy DOM has no layout. Keep geometry local to this element.
  Object.defineProperties(log, {
    scrollHeight: { get: () => geometry.height },
    clientHeight: { get: () => geometry.viewport },
    scrollTop: {
      get: () => geometry.top,
      set: (top: number) => {
        geometry.top = Math.max(0, Math.min(top, geometry.height - geometry.viewport))
      },
    },
  })
  const owner = createRoot((dispose) => {
    const scroll = createTeamScroll()
    scroll.scrollRef(log)
    scroll.contentRef(content)
    log.addEventListener("scroll", scroll.handleScroll)
    return { scroll, dispose }
  })
  return {
    ...owner,
    log,
    content,
    geometry,
    cleanup: () => {
      owner.dispose()
      log.remove()
    },
  }
}

describe.skipIf(isServer)("Team room browser scrolling", () => {
  test("initial history, polls, and late layout keep the newest message visible", async () => {
    const view = fixture()
    try {
      view.scroll.reset()
      await frame()
      expect(view.geometry.top).toBe(800)
      view.geometry.height = 1_300
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(1_100)
      view.geometry.height = 1_800
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(1_600)
    } finally {
      view.cleanup()
    }
  })

  test("scrolling up pauses follow and sending restores it", async () => {
    const view = fixture()
    try {
      view.scroll.reset()
      await frame()
      view.log.dispatchEvent(new WheelEvent("wheel", { deltaY: -5, bubbles: true }))
      view.log.scrollTop = 795
      view.log.dispatchEvent(new Event("scroll"))
      view.geometry.height = 1_200
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(795)
      view.scroll.resume()
      await frame()
      expect(view.geometry.top).toBe(1_000)
    } finally {
      view.cleanup()
    }
  })

  test("touch or scrollbar movement pauses follow until the reader reaches bottom", async () => {
    const view = fixture()
    try {
      view.scroll.reset()
      await frame()
      view.log.scrollTop = 400
      view.log.dispatchEvent(new Event("scroll"))
      view.geometry.height = 1_200
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(400)
      view.log.scrollTop = 1_000
      view.log.dispatchEvent(new Event("scroll"))
      view.geometry.height = 1_400
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(1_200)
    } finally {
      view.cleanup()
    }
  })

  test("nested rich output scrolling does not pause room follow", async () => {
    const view = fixture()
    try {
      view.scroll.reset()
      await frame()
      view.content.dataset.scrollable = ""
      view.content.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
      view.geometry.height = 1_200
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(1_000)
    } finally {
      view.cleanup()
    }
  })

  test("older pages keep the current anchor and leave follow paused", async () => {
    const view = fixture()
    try {
      view.scroll.reset()
      await frame()
      view.log.scrollTop = 300
      view.scroll.prepend()
      view.geometry.height = 1_500
      await frame()
      expect(view.geometry.top).toBe(800)
      view.geometry.height = 1_800
      view.scroll.update()
      await frame()
      expect(view.geometry.top).toBe(800)
    } finally {
      view.cleanup()
    }
  })

  test("room switches and disposal cancel pending anchor callbacks", async () => {
    const view = fixture()
    try {
      view.log.scrollTop = 300
      view.scroll.prepend()
      view.geometry.height = 700
      view.scroll.reset()
      await frame()
      expect(view.geometry.top).toBe(500)
      view.scroll.update()
      view.dispose()
      view.geometry.height = 900
      await frame()
      expect(view.geometry.top).toBe(500)
    } finally {
      view.cleanup()
    }
  })
})
