import { describe, expect, test } from "bun:test"
import {
  assignTabToGroup,
  createTabGroup,
  migrateTabGroups,
  moveTabToGroup,
  moveTabGroup,
  normalizeTabOrder,
  reconcileTabGroupsAfterReorder,
  removeTabGroupServer,
  removeTabGroupSessions,
  removeTabsFromTabGroups,
  replaceTabInTabGroups,
  syncTabGroups,
  tabGroupDragLayout,
  tabGroupDragKey,
  tabGroupLayout,
  toggleTabGroup,
} from "./tab-groups"
import type { ServerConnection } from "./server"
import { tabKey, type Tab } from "./tab"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): Tab {
  return { type: "session", server, sessionId }
}

function draftTab(draftID: string): Tab {
  return { type: "draft", server, draftID, directory: "/repo" }
}

function group(id: string, tabs: Tab[], input?: { collapsed?: boolean }) {
  return createTabGroup({ id, name: id, color: "blue", tabs, collapsed: input?.collapsed })!
}

describe("tab groups", () => {
  test("creates an optionally named group with unique tabs", () => {
    expect(
      createTabGroup({ id: "group-1", name: "  Investigation  ", tabs: [sessionTab("a"), sessionTab("a")] }),
    ).toEqual({
      id: "group-1",
      name: "Investigation",
      color: "grey",
      collapsed: false,
      tabs: [sessionTab("a")],
    })
    expect(createTabGroup({ id: "group-2", tabs: [draftTab("d1")] })?.name).toBe("")
    expect(createTabGroup({ id: "group-3", tabs: [] })).toBeUndefined()
  })

  test("migrates legacy groups and gives each tab one group", () => {
    expect(
      migrateTabGroups(
        [
          {
            id: "group-1",
            name: "  Investigation ",
            tabs: [{ type: "session", sessionId: "a", title: "Legacy title" }, draftTab("d1")],
          },
          { id: "group-2", name: "Second", color: "pink", collapsed: true, tabs: [sessionTab("a"), sessionTab("b")] },
          { id: "group-2", name: "Duplicate", tabs: [sessionTab("c")] },
        ],
        server,
      ),
    ).toEqual([
      {
        id: "group-1",
        name: "Investigation",
        color: "grey",
        collapsed: false,
        tabs: [sessionTab("a"), draftTab("d1")],
      },
      {
        id: "group-2",
        name: "Second",
        color: "pink",
        collapsed: true,
        tabs: [sessionTab("b")],
      },
    ])
  })

  test("moves a tab between exclusive groups and removes empty groups", () => {
    const groups = [group("one", [sessionTab("a")]), group("two", [sessionTab("b")])]

    expect(assignTabToGroup(groups, "two", sessionTab("a"))).toEqual([group("two", [sessionTab("b"), sessionTab("a")])])
    expect(removeTabsFromTabGroups(groups, [sessionTab("a")])).toEqual([group("two", [sessionTab("b")])])
  })

  test("keeps a draft in its group when it becomes a session", () => {
    const groups = [group("one", [draftTab("d1")]), group("two", [sessionTab("a")])]

    expect(replaceTabInTabGroups(groups, draftTab("d1"), sessionTab("a"))).toEqual([group("one", [sessionTab("a")])])
  })

  test("drops closed tabs, refreshes open tab data, and resolves duplicate membership", () => {
    const currentDraft = { ...draftTab("d1"), directory: "/current" }
    const groups = [
      group("one", [sessionTab("closed"), draftTab("d1")]),
      group("two", [draftTab("d1"), sessionTab("b")]),
    ]

    expect(syncTabGroups(groups, [currentDraft, sessionTab("b")])).toEqual([
      group("one", [currentDraft]),
      group("two", [sessionTab("b")]),
    ])
  })

  test("lays groups out once at their first member and keeps members contiguous", () => {
    const tabs = [sessionTab("a"), sessionTab("x"), sessionTab("b"), sessionTab("c")]
    const groups = [group("one", [sessionTab("a"), sessionTab("b")])]
    const layout = tabGroupLayout(tabs, groups)

    expect(layout.map((entry) => entry.type)).toEqual(["group", "tab", "tab"])
    expect(layout[0]?.type === "group" ? layout[0].tabs : []).toEqual([sessionTab("a"), sessionTab("b")])
    expect(normalizeTabOrder(tabs, groups)).toEqual([
      sessionTab("a"),
      sessionTab("b"),
      sessionTab("x"),
      sessionTab("c"),
    ])
    expect(tabGroupDragLayout(tabs, groups)).toEqual([
      tabGroupDragKey("one"),
      tabKey(sessionTab("a")),
      tabKey(sessionTab("b")),
      tabKey(sessionTab("x")),
      tabKey(sessionTab("c")),
    ])
  })

  test("places a newly assigned tab after the target group", () => {
    const tabs = [sessionTab("x"), sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(moveTabToGroup(tabs, group("one", [sessionTab("a"), sessionTab("b")]), sessionTab("x"))).toEqual([
      sessionTab("a"),
      sessionTab("b"),
      sessionTab("x"),
      sessionTab("c"),
    ])
  })

  test("dragging a member away ungroups it and dropping inside another group assigns it", () => {
    const groups = [group("one", [sessionTab("a"), sessionTab("b")]), group("two", [sessionTab("c"), sessionTab("d")])]

    expect(
      reconcileTabGroupsAfterReorder(
        groups,
        [sessionTab("a"), sessionTab("x"), sessionTab("b"), sessionTab("c"), sessionTab("d")],
        tabKey(sessionTab("b")),
        [
          tabGroupDragKey("one"),
          tabKey(sessionTab("a")),
          tabKey(sessionTab("x")),
          tabKey(sessionTab("b")),
          tabGroupDragKey("two"),
          tabKey(sessionTab("c")),
          tabKey(sessionTab("d")),
        ],
      ),
    ).toEqual([group("one", [sessionTab("a")]), group("two", [sessionTab("c"), sessionTab("d")])])

    expect(
      reconcileTabGroupsAfterReorder(
        groups,
        [sessionTab("a"), sessionTab("b"), sessionTab("c"), sessionTab("x"), sessionTab("d")],
        tabKey(sessionTab("x")),
        [
          tabGroupDragKey("one"),
          tabKey(sessionTab("a")),
          tabKey(sessionTab("b")),
          tabGroupDragKey("two"),
          tabKey(sessionTab("c")),
          tabKey(sessionTab("x")),
          tabKey(sessionTab("d")),
        ],
      ),
    ).toEqual([
      group("one", [sessionTab("a"), sessionTab("b")]),
      group("two", [sessionTab("c"), sessionTab("d"), sessionTab("x")]),
    ])
  })

  test("dragging a group header moves the whole contiguous group", () => {
    const groups = [group("one", [sessionTab("a"), sessionTab("b")])]

    expect(
      moveTabGroup([sessionTab("a"), sessionTab("b"), sessionTab("x"), sessionTab("y")], groups, "one", [
        tabKey(sessionTab("x")),
        tabKey(sessionTab("y")),
        tabGroupDragKey("one"),
        tabKey(sessionTab("a")),
        tabKey(sessionTab("b")),
      ]),
    ).toEqual([sessionTab("x"), sessionTab("y"), sessionTab("a"), sessionTab("b")])

    expect(
      moveTabGroup([sessionTab("x"), sessionTab("y"), sessionTab("a"), sessionTab("b")], groups, "one", [
        tabKey(sessionTab("x")),
        tabGroupDragKey("one"),
        tabKey(sessionTab("y")),
        tabKey(sessionTab("a")),
        tabKey(sessionTab("b")),
      ]),
    ).toEqual([sessionTab("x"), sessionTab("a"), sessionTab("b"), sessionTab("y")])
  })

  test("dragging the only tab keeps its one-tab group", () => {
    const groups = [group("one", [sessionTab("a")])]

    expect(
      reconcileTabGroupsAfterReorder(groups, [sessionTab("x"), sessionTab("a")], tabKey(sessionTab("a")), [
        tabKey(sessionTab("x")),
        tabGroupDragKey("one"),
        tabKey(sessionTab("a")),
      ]),
    ).toBe(groups)
  })

  test("toggles collapse without changing group membership", () => {
    const groups = [group("one", [sessionTab("a"), sessionTab("b")]), group("two", [sessionTab("c")])]
    const collapsed = toggleTabGroup(groups, "one")

    expect(collapsed).toEqual([
      group("one", [sessionTab("a"), sessionTab("b")], { collapsed: true }),
      group("two", [sessionTab("c")]),
    ])
    expect(toggleTabGroup(collapsed, "one")).toEqual(groups)
    expect(toggleTabGroup(groups, "missing")).toBe(groups)
  })

  test("removes deleted sessions and disconnected servers", () => {
    const groups = [group("one", [sessionTab("a")]), group("two", [sessionTab("a"), sessionTab("b")])]

    expect(removeTabGroupSessions(groups, server, ["a"])).toEqual([group("two", [sessionTab("b")])])
    expect(removeTabGroupServer(groups, server)).toEqual([])
  })
})
