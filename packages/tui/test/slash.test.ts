import { afterEach, expect, test } from "bun:test"
import { KeyEvent, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createSlashCommands } from "../src/slash"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

function key(name: string, modifiers: Partial<KeyEvent> = {}) {
  return new KeyEvent({
    name,
    sequence: name,
    raw: name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "press",
    source: "raw",
    ...modifiers,
  })
}

async function fixture(commands: () => Promise<{ name: string; description?: string }[]>) {
  const view = await createTestRenderer({ width: 90, height: 32 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  const dialogs = createDialogs(view.renderer, state, createLayout(view.renderer, state), {
    rememberPosition() {},
    cancelPosition() {},
    changed() {},
    async submitted() {},
    say() {},
  })
  const dialog = dialogs.open("Compose")!
  const editor = dialogs.prompt(dialog, "Message")
  let changes = 0
  const previous = editor.onContentChange
  editor.onContentChange = (event) => {
    previous?.(event)
    changes++
  }
  const ran: string[] = []
  const calls: unknown[][] = []
  const location = { directory: "/project", workspaceID: "workspace" }
  let locked = false
  const slash = createSlashCommands(
    view.renderer,
    state,
    {
      commands: async (...args) => {
        calls.push(args)
        return commands()
      },
    },
    () => [
      {
        name: "help",
        description: "Local help",
        run() {
          throw new Error("Must delegate")
        },
      },
      {
        name: "review",
        description: "Local collision",
        run() {
          throw new Error("Must delegate")
        },
      },
    ],
    (name, current, field) => {
      expect(current).toBe(dialog)
      expect(field).toBe(editor)
      ran.push(name)
    },
  )
  slash.attach(
    dialog,
    editor,
    () => location,
    () => locked,
  )
  editor.focus()
  const suggestions = dialog.form.getChildren().find((child) => child.id === `${editor.id}-slash`) as TextRenderable
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await view.renderOnce()
  }
  return {
    ...view,
    state,
    dialogs,
    dialog,
    editor,
    suggestions,
    slash,
    calls,
    ran,
    location,
    settle,
    changes: () => changes,
    lock: () => {
      locked = true
    },
  }
}

test("lazy inventory, bounded suggestions, completion and exact server/local dispatch", async () => {
  const f = await fixture(async () => [
    { name: "review", description: "Server review" },
    { name: "reset" },
    { name: "rename" },
    { name: "resume" },
  ])
  expect(f.calls).toEqual([])
  f.editor.setText("/")
  await f.settle()
  expect(f.calls).toEqual([["/project", "workspace"]])
  expect(f.suggestions.height).toBeLessThanOrEqual(9)
  expect(f.editor.focused).toBe(true)
  expect(f.slash.key(key("down"))).toBe(true)
  expect(f.slash.key(key("up"))).toBe(true)
  expect(f.slash.key(key("enter"))).toBe(true)
  expect(f.editor.plainText).toBe("/review ")
  expect(f.suggestions.visible).toBe(true)
  f.editor.setText("/review")
  expect(f.slash.key(key("enter"))).toBe(false)
  expect(f.ran).toEqual([])
  f.editor.setText("/he")
  expect(f.slash.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe("/help ")
  f.editor.setText("/help")
  expect(f.slash.key(key("enter"))).toBe(true)
  expect(f.ran).toEqual(["help"])
  expect(f.editor.plainText).toBe("/help")
  expect(f.changes()).toBeGreaterThan(0)
})

test("unknown prompts, whitespace, modifiers, locks and Escape remain native", async () => {
  const f = await fixture(async () => [{ name: "review" }])
  f.editor.setText("/")
  await f.settle()
  for (const modifier of ["ctrl", "meta", "option", "shift", "super", "hyper"] as const) {
    for (const name of ["up", "down", "tab", "enter"]) expect(f.slash.key(key(name, { [modifier]: true }))).toBe(false)
  }
  expect(f.slash.key(key("enter", { eventType: "release" }))).toBe(false)
  // The first Escape closes the list; the next one is native.
  expect(f.slash.key(key("escape"))).toBe(true)
  expect(f.suggestions.visible).toBe(false)
  expect(f.slash.key(key("escape"))).toBe(false)
  for (const text of ["/unknown", "/review args", "/review\n", "/review\r", "/review\targs", "//path", "normal"]) {
    f.editor.setText(text)
    const before = f.editor.plainText
    expect(f.slash.key(key("enter"))).toBe(false)
    expect(f.suggestions.visible).toBe(false)
    expect(f.editor.plainText).toBe(before)
  }
  f.editor.setText("/help")
  f.dialog.busy = true
  expect(f.slash.key(key("enter"))).toBe(false)
  f.dialog.busy = false
  f.lock()
  expect(f.slash.key(key("enter"))).toBe(false)
  expect(f.ran).toEqual([])
})

test("late inventory cannot reopen a dismissed modal or overwrite changed text", async () => {
  let resolve!: (items: { name: string }[]) => void
  const f = await fixture(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  f.editor.setText("/re")
  await f.settle()
  expect(f.slash.key(key("enter"))).toBe(true)
  f.editor.setText("ordinary prompt")
  resolve([{ name: "review" }])
  await f.settle()
  expect(f.editor.plainText).toBe("ordinary prompt")
  expect(f.suggestions.visible).toBe(false)
  f.editor.setText("/")
  await f.settle()
  f.dialogs.close()
  resolve([{ name: "review" }])
  await f.settle()
  expect(f.state.modal).toBeUndefined()
  expect(f.slash.key(key("enter"))).toBe(false)
})

test("inventory failures are explicit and unsafe names never become completions", async () => {
  let fail = true
  const f = await fixture(async () => {
    if (fail) throw new Error("Unavailable")
    return [
      { name: "bad\u001bname" },
      { name: "bad name" },
      { name: "review", description: "safe\n\u001b[31m\u202etext" },
    ]
  })
  f.editor.setText("/")
  await f.settle()
  expect(f.suggestions.chunks.map((chunk) => chunk.text).join("")).toContain("Commands unavailable")
  expect(f.slash.key(key("enter"))).toBe(false)
  fail = false
  f.editor.setText("")
  await f.settle()
  f.editor.setText("/re")
  await f.settle()
  expect(f.suggestions.chunks.map((chunk) => chunk.text).join("")).not.toMatch(/[\u001b\u202e\n]/)
  expect(f.slash.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe("/review ")
})

test("late old-location inventory is discarded and busy discovery can retry", async () => {
  const pending: ((items: { name: string }[]) => void)[] = []
  const f = await fixture(() => new Promise((resolve) => pending.push(resolve)))
  f.editor.setText("/")
  await f.settle()
  f.location.directory = "/other"
  pending.shift()!([{ name: "old" }])
  await f.settle()
  expect(f.calls).toEqual([
    ["/project", "workspace"],
    ["/other", "workspace"],
  ])
  f.dialog.busy = true
  pending.shift()!([{ name: "stale" }])
  await f.settle()
  expect(f.suggestions.visible).toBe(false)
  f.dialog.busy = false
  expect(f.slash.key(key("tab"))).toBe(true)
  await f.settle()
  pending.shift()!([{ name: "current" }])
  await f.settle()
  expect(f.slash.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe("/current ")
})

test("Tab-completed local alias with trailing horizontal whitespace never submits a prompt", async () => {
  const f = await fixture(async () => [{ name: "review" }])
  let prompts = 0
  f.dialog.submit = async () => {
    prompts++
  }
  f.editor.setText("/he")
  await f.settle()
  expect(f.slash.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe("/help ")
  const enter = key("enter")
  if (!f.slash.key(enter)) f.dialogs.keypress(enter)
  expect(f.ran).toEqual(["help"])
  expect(prompts).toBe(0)
  f.editor.setText("/help \t")
  expect(f.slash.key(key("enter"))).toBe(true)
  expect(f.ran).toEqual(["help", "help"])
  f.editor.setText("/review \t")
  expect(f.slash.key(key("enter"))).toBe(false)
  expect(f.ran).toEqual(["help", "help"])
})
