import { errorText } from "../server"
import type { Conversation, LivePage } from "./context"
import { drawLive, mergeLive } from "./live-cache"
import { atBottom, currentView } from "./position"

export function cancelPosition(c: Conversation) {
  currentView(c)
  c.textAnchor = undefined
  c.prepend = undefined
  c.position = undefined
  c.beforeQuestion = undefined
  // Docked reply paging bypasses the dashboard's scrollEarlier handler.
  if (c.state.modal?.docked && c.state.modal.editor) void scrollEarlier(c)
}

/** Reveals older cached messages, then fetches an earlier page, keeping the reading position anchored. */
export async function scrollEarlier(c: Conversation) {
  const { state, ui, hooks } = c
  const token = currentView(c)
  const id = state.selected
  const cached = c.live.get(id)
  if (
    c.earlier ||
    state.closed ||
    (state.modal && !state.modal.docked) ||
    state.detail?.questions.length ||
    state.tab !== "sessions" ||
    state.history ||
    state.detail?.sessionID !== id ||
    !cached
  )
    return
  if (!cached.expanded && cached.messages.length > 6) return expandWindow(c, token, id, cached)
  cached.expanded = true
  // Preserve/reveal the local reading window while composing, without paging remotely.
  if (state.modal) return
  if (ui.detail.scrollTop > Math.max(10, ui.detail.viewport.height)) return
  if (cached.capped) return hooks.say("Live scrollback limit reached. Press h, then [ for further history.")
  const cursor = cached.cursor
  if (!cursor) return
  return fetchEarlier(c, token, id, cursor)
}

function expandWindow(c: Conversation, token: number, id: string, cached: LivePage) {
  const { state, ui } = c
  // Let the triggering key/wheel movement finish before measuring its anchor.
  c.earlier = Promise.resolve()
    .then(() => {
      if (
        token !== currentView(c) ||
        state.closed ||
        (state.modal && !state.modal.docked) ||
        state.detail?.sessionID !== id ||
        state.detail.questions.length
      )
        return
      cached.expanded = true
      const follow = c.position?.scroll === Number.MAX_SAFE_INTEGER || (!c.position && atBottom(c))
      c.prepend = follow ? undefined : { height: ui.detail.scrollHeight, scroll: ui.detail.scrollTop }
      c.position = { sessionID: id, history: false, scroll: follow ? Number.MAX_SAFE_INTEGER : ui.detail.scrollTop }
      drawLive(c)
    })
    .finally(() => {
      c.earlier = undefined
    })
  return c.earlier
}

function fetchEarlier(c: Conversation, token: number, id: string, cursor: string) {
  const { state, ui, hooks } = c
  const valid = () =>
    !state.closed &&
    token === currentView(c) &&
    state.selected === id &&
    !state.history &&
    state.tab === "sessions" &&
    !state.modal &&
    state.detail?.sessionID === id &&
    !state.detail.questions.length
  c.earlier = (async () => {
    try {
      const result = await c.connection.client.messages.list({ sessionID: id, limit: 30, cursor })
      if (!valid()) return
      // End (or scrolling to the bottom) while fetching must remain following.
      const follow = c.position?.scroll === Number.MAX_SAFE_INTEGER || (!c.position && atBottom(c))
      // Capture after the request: the user's triggering scroll has now applied.
      const anchor = { height: ui.detail.scrollHeight, scroll: ui.detail.scrollTop }
      const updated = mergeLive(c, result.data.toReversed(), true)
      updated.cursor =
        result.data.length && result.cursor.next !== cursor ? (result.cursor.next ?? undefined) : undefined
      c.position = { sessionID: id, history: false, scroll: follow ? Number.MAX_SAFE_INTEGER : anchor.scroll }
      c.prepend = follow ? undefined : anchor
      drawLive(c)
      if (!result.data.length) hooks.say("Start of history reached.")
    } catch (cause) {
      if (valid()) hooks.say(`Earlier messages unavailable: ${errorText(cause)}. Scroll up to retry.`, true)
    } finally {
      c.earlier = undefined
    }
  })()
  return c.earlier
}
