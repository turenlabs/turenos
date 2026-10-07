import { afterEach, expect, test } from "bun:test"
import { KeyEvent, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createMentions } from "../src/mentions"
import { attachmentSummary } from "../src/mentions/outside"
import { parseMentions, promptPayload, recordSearch } from "../src/prompt-files"
import { mergeLocal } from "../src/slash/commands"
import { createDashboardState } from "../src/state"
import { fuzzyRank } from "../src/suggest/fuzzy"
import { dashboard, session } from "./support"

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

const catalog = {
  all: [
    { id: "openai", name: "OpenAI", models: {} },
    { id: "anthropic", name: "Anthropic", models: {} },
  ],
  connected: [],
}

test("saved permission rules are listed for the session's project and can be removed", async () => {
  const app = await dashboard({
    "GET /global/permission-checks": () => ({ enforced: true }),
    "GET /api/permission/saved": (_, url) => ({
      data:
        url.searchParams.get("projectID") === "project"
          ? [{ id: "psv_1", projectID: "project", action: "bash", resource: "echo marker" }]
          : [],
    }),
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 5; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("bash · echo marker")
  expect(frame).toContain("Enter on a rule removes it")
})

test("Esc inside a section returns to the Settings menu with its row selected", async () => {
  const app = await dashboard({
    "GET /global/permission-checks": () => ({ enforced: true }),
    "GET /api/permission/saved": () => ({ data: [] }),
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 5; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Permission checks: on")
  app.view.mockInput.pressKey("ESCAPE")
  const frame = await app.screen("Server:")
  expect(frame).toContain("▶ Permissions")
})

test("typing a provider name selects it instead of the pinned custom row", async () => {
  const app = await dashboard({
    "GET /provider": () => catalog,
    "GET /provider/auth": () => ({}),
  })
  await app.palette("Connect provider")
  await app.screen("Find a provider")
  await app.view.mockInput.typeText("openai")
  await Bun.sleep(50)
  app.view.mockInput.pressEnter()
  await app.screen("Connect OpenAI")
})

test("the memory form has no message-editor chrome and Kind is a choice", async () => {
  const app = await dashboard({
    "GET /api/memory/wing": () => [
      { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 },
    ],
    "GET /api/memory/room": () => [
      { id: "rom_1", wingID: "wng_1", slug: "tooling", name: "Tooling", timeCreated: 1, timeUpdated: 1 },
    ],
    "GET /api/memory": () => [],
  })
  await app.palette("Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressKey("a")
  await app.screen("Select a room, then press a")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressKey("a")
  const frame = await app.screen("New memory")
  expect(frame).not.toContain("Send (Enter)")
  expect(frame).not.toContain("Type a message")
  expect(frame).toContain("What should agents remember?")
  expect(frame).toContain("decision")
})

test("Intel sorts advisories by severity and a poll that outlives its dialog stays quiet", async () => {
  const errors: unknown[] = []
  const record = (error: unknown) => errors.push(error)
  const events = process as unknown as NodeJS.EventEmitter
  events.on("unhandledRejection", record)
  cleanup.push(() => events.off("unhandledRejection", record))
  let sort = ""
  const app = await dashboard({
    "GET /api/intel/advisories": (_, url) => {
      sort = url.searchParams.get("sort") ?? ""
      return { items: [], total: 0 }
    },
    "POST /api/intel/poll": async () => {
      await Bun.sleep(300)
      return { feeds: [] }
    },
  })
  app.view.mockInput.pressKey("I")
  await app.screen("Intel")
  app.view.mockInput.pressKey("p")
  await app.screen("Polling feeds")
  app.view.mockInput.pressKey("ESCAPE")
  await Bun.sleep(600)
  await app.view.renderOnce()
  expect(errors).toEqual([])
  expect(sort).toBe("severity")
})

test("a path the server search never resolved stays text, and the summary says so", () => {
  expect(promptPayload("see @zzzq now", "/srv/p").files).toHaveLength(1)
  recordSearch("/srv/p", "zzzq", false)
  expect(promptPayload("see @zzzq now", "/srv/p")).toEqual({ text: "see @zzzq now" })
  expect(parseMentions("see @zzzq now", "/srv/p")).toEqual([])
  expect(attachmentSummary("see @zzzq now", "/srv/p")).toContain("No file matches @zzzq")
  recordSearch("/srv/p", "zzzq", true)
  expect(promptPayload("see @zzzq now", "/srv/p").files).toHaveLength(1)
  // Absolute and escaping paths are never judged by the project search.
  recordSearch("/srv/p", "/etc/hosts", false)
  expect(promptPayload("@/etc/hosts", "/srv/p").files).toHaveLength(1)
})

test("a leading ! announces shell mode", () => {
  expect(attachmentSummary("!git status", "/srv/p")).toContain("Shell command")
  expect(attachmentSummary("hello", "/srv/p")).toBeUndefined()
})

test("commands match by subsequence, ranked prefix then word start then letters in order", () => {
  expect(fuzzyRank("com", "compact")).toBe(0)
  expect(fuzzyRank("act", "compact")).toBe(2)
  expect(fuzzyRank("tab", "switch-tab")).toBe(1)
  expect(fuzzyRank("xyz", "compact")).toBeUndefined()
  const local = ["compact", "commands", "undo"].map((name) => ({ name, description: "", run() {} }))
  expect(mergeLocal([], local, "cmp").map((item) => item.name)).toEqual(["compact"])
  expect(mergeLocal([], local, "co").map((item) => item.name)).toEqual(["compact", "commands"])
  expect(mergeLocal([], local, "ompa").map((item) => item.name)).toEqual(["compact"])
})

test("Esc closes the @ list first and the next Esc is left for the editor", async () => {
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
  const mentions = createMentions(view.renderer, state, {
    findFiles: async () => [{ path: "answer.ts", type: "file" as const }],
  })
  mentions.attach(dialog, editor, () => ({ directory: "/srv/p" }))
  editor.focus()
  await view.mockInput.typeText("@answer")
  await Bun.sleep(320)
  await view.renderOnce()
  const escape = () =>
    new KeyEvent({
      name: "escape",
      sequence: "\u001b",
      raw: "\u001b",
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      number: false,
      eventType: "press",
      source: "raw",
    })
  const list = dialog.form.getChildren().find((child) => child.id === `${editor.id}-mentions`) as TextRenderable
  expect(list.visible).toBe(true)
  expect(mentions.key(escape())).toBe(true)
  expect(list.visible).toBe(false)
  expect(mentions.key(escape())).toBe(false)
})

test("the agent picker names the effective agent when the session never chose one", async () => {
  const bare = { ...session(), agent: undefined }
  const app = await dashboard({
    "GET /api/session": () => ({ data: [bare], cursor: {} }),
    "GET /api/session/ses_main": () => ({ data: bare }),
    "GET /api/agent": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [{ id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] }],
    }),
  })
  await app.palette("Choose agent for this session")
  await app.screen("Current: build (server default)")
})
