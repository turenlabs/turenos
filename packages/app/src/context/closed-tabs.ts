import type { SessionTab, Tab } from "./tab"

export type ClosedTab = {
  tab: Tab
  index: number
}

const CLOSED_TAB_LIMIT = 25

// Draft content stays in its existing ID-scoped persistence. Reopening must
// reuse that identity rather than copy an old snapshot into another draft.
export function pushClosedTab(stack: ClosedTab[], tab: Tab, index: number): ClosedTab[] {
  return [...stack.filter((entry) => !isOpen([entry.tab], tab)), { tab: { ...tab }, index }].slice(-CLOSED_TAB_LIMIT)
}

// Closed tabs reopen in last-in-first-out order. Record a batch in reverse so
// restoring it one tab at a time reconstructs the original tab order.
export function pushClosedTabs(stack: ClosedTab[], tabs: Array<{ tab: Tab; index: number }>) {
  return tabs.toReversed().reduce((stack, entry) => pushClosedTab(stack, entry.tab, entry.index), stack)
}

// Pops the most recently closed tab that is not open again,
// discarding stale entries along the way.
export function takeClosedTab(stack: ClosedTab[], tabs: Tab[]): { entry?: ClosedTab; stack: ClosedTab[] } {
  const remaining = [...stack]
  while (remaining.length) {
    const entry = remaining.pop()
    if (entry && !isOpen(tabs, entry.tab)) return { entry, stack: remaining }
  }
  return { stack: remaining }
}

export function removeClosedTabs(stack: ClosedTab[], server: SessionTab["server"], sessionIDs: string[]) {
  const removed = new Set(sessionIDs)
  return stack.filter(
    (entry) => entry.tab.type !== "session" || entry.tab.server !== server || !removed.has(entry.tab.sessionId),
  )
}

export function unretainedDraftIDs(candidates: Tab[], retained: Tab[]) {
  const keep = new Set(retained.flatMap((tab) => (tab.type === "draft" ? [tab.draftID] : [])))
  return [
    ...new Set(candidates.flatMap((tab) => (tab.type === "draft" && !keep.has(tab.draftID) ? [tab.draftID] : []))),
  ]
}

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean) {
  if (!active) return undefined
  return tabs[index - 1] ?? tabs[index + 1] ?? null
}

function isOpen(tabs: Tab[], tab: Tab) {
  if (tab.type === "draft") return tabs.some((item) => item.type === "draft" && item.draftID === tab.draftID)
  return tabs.some((item) => item.type === "session" && item.server === tab.server && item.sessionId === tab.sessionId)
}
