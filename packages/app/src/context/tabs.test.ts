import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { createTabMemory } from "./tab-memory"
import {
  nextTabAfterClose,
  pushClosedTab,
  pushClosedTabs,
  removeClosedTabs,
  takeClosedTab,
  type ClosedTab,
} from "./closed-tabs"
import { migrateTabs, tabHref, tabKey, type SessionTab, type Tab } from "./tab"
import type { ServerConnection } from "./server"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)
      dispose()
    })
  })
})

describe("tab migration", () => {
  test("drops retired standalone terminal tabs", () => {
    expect(
      migrateTabs(
        [
          { type: "terminal", terminalID: "retired", server, directory: "/tmp/project", ptyID: "pty-1" },
          { type: "draft", draftID: "legacy", directory: "/tmp/project" },
        ],
        server,
      ),
    ).toEqual([{ type: "draft", draftID: "legacy", directory: "/tmp/project", server }])
  })
})

describe("closed tab stack", () => {
  test("records session tabs with their index", () => {
    const stack = pushClosedTab([], sessionTab("a"), 2)

    expect(stack).toEqual([{ tab: sessionTab("a"), index: 2 }])
  })

  test("ignores draft tabs", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server, directory: "/tmp" }

    expect(pushClosedTab([], draft, 0)).toEqual([])
  })

  test("caps the stack size", () => {
    const stack = Array.from({ length: 30 }, (_, i) => i).reduce<ClosedTab[]>(
      (acc, i) => pushClosedTab(acc, sessionTab(`s${i}`), i),
      [],
    )

    expect(stack).toHaveLength(25)
    expect(stack[0]?.tab.sessionId).toBe("s5")
    expect(stack.at(-1)?.tab.sessionId).toBe("s29")
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab.sessionId).toBe("b")
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("restores a batch-close in its original order", () => {
    const stack = pushClosedTabs(
      [],
      [
        { tab: sessionTab("b"), index: 1 },
        { tab: sessionTab("c"), index: 2 },
      ],
    )
    const restored = [sessionTab("a"), sessionTab("d")]
    const first = takeClosedTab(stack, restored)
    restored.splice(first.entry!.index, 0, first.entry!.tab)
    const second = takeClosedTab(first.stack, restored)
    restored.splice(second.entry!.index, 0, second.entry!.tab)

    expect(restored).toEqual([sessionTab("a"), sessionTab("b"), sessionTab("c"), sessionTab("d")])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab.sessionId).toBe("a")
    expect(result.stack).toEqual([])
  })

  test("returns no entry when everything is open or empty", () => {
    expect(takeClosedTab([], []).entry).toBeUndefined()

    const result = takeClosedTab([{ tab: sessionTab("a"), index: 0 }], [sessionTab("a")])
    expect(result.entry).toBeUndefined()
    expect(result.stack).toEqual([])
  })

  test("purges removed sessions", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]

    expect(removeClosedTabs(stack, server, ["a"])).toEqual([{ tab: sessionTab("b"), index: 1 }])
  })

  test("selects the left neighbor when the active tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("a"))
    expect(nextTabAfterClose(tabs, 0, true)).toEqual(sessionTab("b"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})
