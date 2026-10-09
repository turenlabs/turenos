import { expect, test } from "bun:test"
import { headerRight, statusline, welcomeBody } from "../src/chrome"
import type { Snapshot } from "../src/server"
import { todoText } from "../src/session-actions/todos"
import { createDashboardState } from "../src/state"
import { assistant, dashboard, mount, session } from "./support"

const interrupt = { "POST /api/session/ses_main/interrupt": () => new Response(null, { status: 204 }) }

function withModel(variant: string | undefined) {
  const item = { ...session(), model: { providerID: "openai", id: "gpt-6.1-sol", ...(variant ? { variant } : {}) } }
  return { "GET /api/session": () => ({ data: [item], cursor: {} }), "GET /api/session/ses_main": () => ({ data: item }) }
}

test("a variant named default is not shown as if the model itself were a default", async () => {
  const { view, screen } = await mount(120, withModel("default"), 36)
  const frame = await screen("build · openai/gpt-6.1-sol")
  expect(frame).not.toContain("(default)")
  view.mockInput.pressKey("i")
  const details = await screen("Model: openai/gpt-6.1-sol")
  expect(details).not.toContain("(default)")
})

test("a real variant still follows the model", async () => {
  const { screen } = await mount(120, withModel("fast"), 36)
  await screen("build · openai/gpt-6.1-sol (fast)")
})

test("before a session names an agent the footer shows the agent it will use", () => {
  const state = createDashboardState()
  state.selected = "ses_a"
  const snapshot = { sessions: [{ id: "ses_a" }], active: {} } as unknown as Snapshot
  expect(statusline(state, snapshot, 120)).toContain("server default · server default")
  state.defaultAgent = "build"
  expect(statusline(state, snapshot, 120)).toContain("build · server default")
})

test("typed-word dialogs say Enter or Ctrl+S, and Enter does confirm", async () => {
  const { server, view, screen, palette } = await dashboard(interrupt)
  await screen("main task")
  await palette("Kill session")
  await screen("Enter or Ctrl+S kill")
  await view.mockInput.typeText("kill")
  view.mockInput.pressEnter()
  await screen("Session killed.")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(1)
})

test.each([
  ["Stop all agents", "Enter or Ctrl+S stop all"],
  ["Archive / restore session", "Enter or Ctrl+S archive"],
  ["Delete session", "Enter or Ctrl+S delete"],
])("the %s confirmation names Enter as well as Ctrl+S", async (command, hint) => {
  const { screen, palette } = await dashboard({})
  await screen("main task")
  await palette(command)
  const frame = await screen(hint)
  expect(frame.split("\n").find((line) => line.includes(hint))!.trim().length).toBeLessThanOrEqual(80)
})

test("queued messages show their first line under the working line", async () => {
  const input = (seq: number, text: string) => ({
    admittedSeq: seq,
    id: `msg_q${seq}`,
    sessionID: "ses_main",
    prompt: { text },
    delivery: "queue",
    timeCreated: seq,
  })
  const { screen } = await mount(
    100,
    {
      "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }),
      "GET /api/session/ses_main/input": () => ({ data: [input(2, "later"), input(1, "run the tests\nthen lint")] }),
    },
    30,
  )
  const frame = await screen("queued: run the tests · 1 more")
  expect(frame).not.toContain("then lint")
  const rows = frame.split("\n")
  expect(rows.findIndex((row) => row.includes("queued: "))).toBe(rows.findIndex((row) => row.includes("Working (")) + 1)
})

test("the first-launch welcome leads with how to start and names the session list where the sidebar is hidden", () => {
  const narrow = welcomeBody("sessions", { connected: true, connectionError: "", columns: 80 })
  expect(narrow).toContain("Press n or Enter to start a session.")
  expect(narrow).toContain("? help · Ctrl+P commands · m model · Ctrl+K sessions")
  expect(narrow).toContain("b shows the session list")
  const wide = welcomeBody("sessions", { connected: true, connectionError: "", columns: 160 })
  expect(wide).not.toContain("b shows the session list")
  expect(welcomeBody("sessions", { connected: true, connectionError: "", columns: 160, sidebarHidden: true })).toContain(
    "b shows the session list",
  )
})

test("New session summarises the agent and model on one line and says what Tab reaches", async () => {
  const { view, screen } = await mount(120, {}, 36)
  view.mockInput.pressKey("n")
  const frame = await screen("Tab: folder · agent · model · workspace")
  expect(frame).toContain("server default agent · server default model")
})

test("New session lists each agent with its description and uses the room a wide terminal has", async () => {
  const { view, screen } = await mount(
    180,
    {
      "GET /api/agent": (_, url) => ({
        location: { directory: url.searchParams.get("location[directory]") },
        data: [
          {
            id: "build",
            mode: "primary",
            hidden: false,
            description: "Writes and edits code",
            request: { headers: {}, body: {} },
            permissions: [],
          },
        ],
      }),
    },
    40,
  )
  view.mockInput.pressKey("n")
  // Once the catalog arrives the summary names the agent a session would run.
  await screen("build · server default model")
  view.mockInput.pressTab()
  const frame = await screen("build · Writes and edits code")
  const top = frame.split("\n").find((line) => line.includes("╭─ New session"))!
  const width = top.indexOf("╮") - top.indexOf("╭") + 1
  expect(width).toBeGreaterThan(88)
  expect(width).toBeLessThanOrEqual(120)
})

const parent = { ...session("main"), title: "Plan the release", time: { created: 1, updated: 2 } }
const child = {
  ...session("kid"),
  title: "Check the changelog",
  parentID: "ses_main",
  time: { created: 3, updated: 4 },
}
const family = {
  "GET /api/session": () => ({ data: [child, parent], cursor: {} }),
  "GET /api/session/ses_kid": () => ({ data: child }),
  "GET /api/session/ses_kid/message": () => ({ data: [assistant("kid", "kid says hello")], cursor: {} }),
  "GET /api/session/ses_kid/task": () => ({ data: [], active: [], cursor: {} }),
  "GET /api/session/ses_kid/permission": () => ({ data: [] }),
  "GET /api/session/ses_kid/question": () => ({ data: [] }),
  "GET /api/session/ses_kid/input": () => ({ data: [] }),
}

test("a subagent session names its parent and the key back, and Esc Esc does not offer a rewind there", async () => {
  const { view, screen } = await mount(140, { ...family, "GET /api/session/ses_main": () => ({ data: parent }) }, 36)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Check the")
  await screen("Check the changelog")
  view.mockInput.pressEnter()
  await screen("Subagent of Plan the release · f returns")
  view.mockInput.pressEscape()
  await Bun.sleep(150)
  view.mockInput.pressEscape()
  await Bun.sleep(150)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Press Esc again to rewind")
})

test("Esc Esc still offers a rewind in an ordinary session", async () => {
  const { view, screen } = await mount(140, {}, 36)
  view.mockInput.pressEscape()
  await Bun.sleep(150)
  view.mockInput.pressEscape()
  await screen("Press Esc again to rewind")
})

test("the History view says which page it shows and the keys that move", async () => {
  const pages = (_: Request, url: URL) =>
    url.searchParams.get("cursor") === "older"
      ? { data: [assistant("old", "older page text")], cursor: { previous: "newer" } }
      : { data: [assistant("new", "main says hello")], cursor: { next: "older" } }
  const { view, screen } = await mount(140, { "GET /api/session/ses_main/message": pages }, 36)
  view.mockInput.pressKey("h")
  await screen("History · page 1 · [ older · ] newer · h back to live")
  await screen("1 messages")
  view.mockInput.pressKey("[")
  await screen("History · page 2 · [ older · ] newer · h back to live")
  view.mockInput.pressKey("]")
  await screen("History · page 1 ·")
})

test("a long shell output folds to its first lines until Ctrl+O expands it", async () => {
  const output = Array.from({ length: 12 }, (_, index) => `row ${index}`).join("\n")
  const shell = {
    id: "msg_shell",
    type: "shell",
    command: "seq 12",
    status: "completed",
    exitCode: 0,
    output,
    time: { created: 1, completed: 2 },
  }
  const { view, screen } = await mount(
    120,
    { "GET /api/session/ses_main/message": () => ({ data: [assistant("a", "main says hello"), shell], cursor: {} }) },
    40,
  )
  // The code block paints after the transcript text, so wait for its last kept row.
  const folded = await screen("row 3")
  expect(folded).toContain("… +8 lines · Ctrl+O expands")
  expect(folded).not.toContain("row 4")
  view.mockInput.pressKey("o", { ctrl: true })
  expect(await screen("row 11")).not.toContain("Ctrl+O expands")
})

test("the Files hint names the arrow as well as Enter, and the arrow opens the folder", async () => {
  const folder = { name: "src", path: "src/", absolute: "/srv/main/src", type: "directory", ignored: false }
  const { view, screen, server } = await mount(120, { "GET /file": () => [folder] }, 36)
  view.mockInput.pressKey("e")
  await screen("→/Enter open folder")
  view.mockInput.pressArrow("right")
  await screen("src/")
  const listed = () => server.requests.filter((item) => item.path === "/file").length
  await Bun.sleep(100)
  expect(listed()).toBe(2)
})

test("once a session has a message the reply editor stops repeating the send and newline keys", async () => {
  const user = { id: "msg_user", type: "user", text: "please run it", time: { created: 1 } }
  const { screen } = await mount(
    80,
    { "GET /api/session/ses_main/message": () => ({ data: [user, assistant("a", "main says hello")], cursor: {} }) },
    24,
  )
  const frame = await screen("Typing")
  expect(frame).not.toContain("Shift/Alt+Enter newline")
  expect(frame).toContain("Enter send · Esc shortcuts")
})

test("the model picker says Esc close when it leaves to the dashboard and Esc back when it returns to New session", async () => {
  const { view, screen } = await mount(120, {}, 36)
  view.mockInput.pressKey("m")
  expect(await screen("Esc close")).not.toContain("Esc back")
  view.mockInput.pressEscape()
  await Bun.sleep(150)
  view.mockInput.pressKey("n")
  await screen("What would you like to do?")
  view.mockInput.pressKey("l", { ctrl: true })
  expect(await screen("Esc back")).not.toContain("Esc close")
})

test("every failed state in the header leads with the same ! marker", () => {
  const state = createDashboardState()
  expect(headerRight(state, undefined)).toBe("Connecting…")
  state.connectionError = "refused"
  expect(headerRight(state, undefined)).toBe("! Disconnected")
  state.connected = true
  state.tab = "terminals"
  const snapshot = { sessions: [], active: {}, terminalsAvailable: false, terminals: [], loops: [] } as unknown as Snapshot
  expect(headerRight(state, snapshot)).toBe("! Terminals unavailable")
  state.tab = "automations"
  const broken = { ...snapshot, inventoryErrors: { automations: "down" } } as unknown as Snapshot
  expect(headerRight(state, broken)).toBe("! Automations unavailable")
})

test("to-dos use the same word for a finished item as tasks and tool rows", async () => {
  const text = todoText([{ content: "ship it", status: "completed", priority: "high" }])
  expect(text).toContain("[completed]")
  expect(text).not.toContain("[done]")
})
