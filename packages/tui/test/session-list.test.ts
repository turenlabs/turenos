import { afterEach, expect, test } from "bun:test"
import { InputRenderable, RGBA, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { sessionRows, SessionListRenderable } from "../src/session-list"
import type { Session } from "../src/server"
import { color } from "../src/theme"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

function session(id: string, directory: string, workspaceID?: string): Session {
  return {
    id,
    projectID: "project",
    title: `Title ${id}`,
    agent: "build",
    location: { directory, workspaceID },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

test("groups exact remote locations without dropping archived or child sessions", () => {
  const sessions = [session("a", "/remote/alpha"), session("b", "/remote/beta"), session("c", "/remote/alpha")]
  sessions[2] = { ...sessions[2]!, parentID: "a", time: { created: 1, updated: 2, archived: 3 } }
  const rows = sessionRows(sessions, { a: {} })
  expect(rows.map((row) => row.id)).toEqual(["a", "c", "b"])
  expect(rows.map((row) => row.groupLabel)).toEqual(["alpha", "alpha", "beta"])
  expect(rows.map((row) => row.name)).toEqual(["* Title a", "Title c", "Title b"])
  expect(rows[0]!.description).toContain("running")
  expect(rows[2]!.description).toContain("/remote/beta")
  expect(sessions.map((item) => item.id)).toEqual(["a", "b", "c"])
})

test("orders exact directories and workspaces alphabetically, then sessions newest first with stable ties", () => {
  const sessions = [
    session("z", "/z/app"),
    session("workspace-z", "/a/app", "z"),
    session("old", "/a/app"),
    session("workspace-a", "/a/app", "a"),
    { ...session("new-b", "/a/app"), time: { created: 3, updated: 10 } },
    { ...session("new-a", "/a/app"), time: { created: 3, updated: 10 } },
    { ...session("recent", "/a/app"), time: { created: 4, updated: 10 } },
  ]
  const expected = ["recent", "new-a", "new-b", "old", "workspace-a", "workspace-z", "z"]
  expect(sessionRows(sessions, {}).map((row) => row.id)).toEqual(expected)
  expect(sessionRows([...sessions].reverse(), {}).map((row) => row.id)).toEqual(expected)
  expect(sessions[0]!.id).toBe("z")
})

test("disambiguates duplicate project names and keeps workspace and lexical directory identities separate", () => {
  const rows = sessionRows(
    [
      session("a", "/one/app"),
      session("b", "/two/app"),
      session("c", "C:\\remote\\other"),
      session("d", "/one/app", "sandbox"),
      session("e", "/one/app/"),
      session("f", "/one/./app"),
    ],
    {},
  )
  expect(new Set(rows.map((row) => row.group)).size).toBe(6)
  expect(new Set(rows.map((row) => row.groupLabel)).size).toBe(6)
  expect(rows.find((row) => row.id === "b")!.groupLabel).toBe("two/app")
  expect(rows.find((row) => row.id === "c")!.groupLabel).toBe("other")
  expect(rows.find((row) => row.id === "d")!.groupLabel).toContain("sandbox")
})

async function fixture(height = 12) {
  const view = await createTestRenderer({ width: 40, height, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const list = new SessionListRenderable(view.renderer)
  view.renderer.root.add(list)
  list.options = sessionRows(
    [session("a", "/remote/alpha"), session("b", "/remote/beta"), session("c", "/remote/alpha")],
    {},
  )
  list.focus()
  await view.renderOnce()
  return { view, list }
}

test("title-only lines highlight current selection and keyboard skips group headers", async () => {
  const { view, list } = await fixture()
  const changes: number[] = []
  list.on("selectionChanged", (index) => changes.push(index))
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  await view.renderOnce()
  expect(list.getSelectedIndex()).toBe(2)
  expect(changes).toEqual([1, 2])
  const frame = view.captureCharFrame()
  expect(frame).toContain("> Title b")
  expect(frame).not.toContain("idle")
  expect(frame).not.toContain("build")
  expect(frame).not.toContain("/remote")
  const line = list
    .getChildren()
    .find((child) => child instanceof TextRenderable && child.plainText.includes("Title b")) as TextRenderable
  expect(line.bg).toEqual(RGBA.fromHex(color.selected))
  view.mockInput.pressArrow("down")
  expect(list.getSelectedIndex()).toBe(0)
  view.mockInput.pressArrow("up")
  expect(list.getSelectedIndex()).toBe(2)
  view.mockInput.pressArrow("up", { ctrl: true })
  expect(list.getSelectedIndex()).toBe(2)
  let selected = -1
  list.on("itemSelected", (index) => {
    selected = index
  })
  view.mockInput.pressEnter()
  expect(selected).toBe(2)
})

test("running sessions render as a clear active line in accent until selected", async () => {
  const view = await createTestRenderer({ width: 40, height: 12, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const list = new SessionListRenderable(view.renderer)
  view.renderer.root.add(list)
  list.options = sessionRows([session("a", "/remote/alpha"), session("b", "/remote/beta")], { b: {} })
  list.focus()
  await view.renderOnce()
  const lines = list.getChildren().filter((child): child is TextRenderable => child instanceof TextRenderable)
  const active = lines.find((line) => line.plainText.includes("Title b"))!
  const idle = lines.find((line) => line.plainText.includes("Title a"))!
  expect(active.fg).toEqual(RGBA.fromHex(color.accent))
  expect(idle.fg).toEqual(RGBA.fromHex(color.text))
  // Selection styling wins so the highlight row stays readable.
  list.setSelectedIndex(1)
  await view.renderOnce()
  expect(active.fg).toEqual(RGBA.fromHex(color.text))
  expect(active.bg).toEqual(RGBA.fromHex(color.selected))
})

test("mouse headers do not change selection and session clicks use session indexes", async () => {
  const { view, list } = await fixture()
  const changes: number[] = []
  list.on("selectionChanged", (index) => changes.push(index))
  const lines = view.captureCharFrame().split("\n")
  const headerY = lines.findIndex((line) => line.includes("beta"))
  await view.mockMouse.click(2, headerY)
  expect(changes).toEqual([])
  await view.mockMouse.click(3, headerY + 1)
  expect(changes).toEqual([2])
  expect(list.getSelectedIndex()).toBe(2)
  expect(view.renderer.currentFocusedRenderable).toBe(list)
  list.options = list.options.filter((item) => item.name.includes("b"))
  list.setSelectedIndex(0)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("> Title b")
  expect(view.captureCharFrame()).not.toContain("alpha")
  list.options = []
  list.moveUp()
  list.moveDown()
  list.selectCurrent()
  expect(list.getSelectedIndex()).toBe(0)
})

test("selection scrolls through grouped rows in a short viewport", async () => {
  const { view, list } = await fixture(4)
  list.options = sessionRows(
    Array.from({ length: 20 }, (_, i) => session(String(i), `/remote/project-${i}`)),
    {},
  )
  await view.renderOnce()
  list.setSelectedIndex(19)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("> Title 9")
  list.moveDown()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("> Title 0")
})

test("headers remain inert and rejected mouse navigation retains restored input focus", async () => {
  const { view, list } = await fixture()
  const input = new InputRenderable(view.renderer, {})
  view.renderer.root.add(input)
  input.focus()
  await view.renderOnce()
  expect(list.focusable).toBe(true)
  const lines = view.captureCharFrame().split("\n")
  const headerY = lines.findIndex((line) => line.includes("beta"))
  await view.mockMouse.click(2, headerY)
  expect(view.renderer.currentFocusedRenderable).toBe(input)
  expect(list.getSelectedIndex()).toBe(0)
  list.on("selectionChanged", () => {
    list.setSelectedIndex(0, false)
    input.focus()
  })
  await view.mockMouse.click(3, headerY + 1)
  expect(list.getSelectedIndex()).toBe(0)
  expect(view.renderer.currentFocusedRenderable).toBe(input)
})

test("options refresh is silent and the owner can restore selection by session ID after reorder", async () => {
  const { view, list } = await fixture()
  list.setSelectedIndex(2)
  const changes: number[] = []
  list.on("selectionChanged", (index) => changes.push(index))
  list.options = sessionRows([session("b", "/a"), session("a", "/z")], { b: {} })
  expect(changes).toEqual([])
  list.setSelectedIndex(0)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("> * Title b")
  expect(view.captureCharFrame()).not.toContain("idle")
  expect(changes).toEqual([0])
  list.options = []
  expect(changes).toEqual([0])
})

test("j/k and shifted arrows retain native five-item navigation across headers", async () => {
  const { view, list } = await fixture()
  list.options = sessionRows(
    Array.from({ length: 8 }, (_, i) => session(String(i), `/project-${i}`)),
    {},
  )
  view.mockInput.pressArrow("down", { shift: true })
  expect(list.getSelectedIndex()).toBe(5)
  view.mockInput.pressKey("k")
  expect(list.getSelectedIndex()).toBe(4)
  view.mockInput.pressKey("j")
  expect(list.getSelectedIndex()).toBe(5)
  view.mockInput.pressArrow("up", { shift: true })
  expect(list.getSelectedIndex()).toBe(0)
  view.mockInput.pressArrow("up", { shift: true })
  expect(list.getSelectedIndex()).toBe(7)
})
