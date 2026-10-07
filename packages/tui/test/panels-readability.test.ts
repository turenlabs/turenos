import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, session, terminal, turen, type Route } from "./support"

async function sized(width: number, height: number, routes: Record<string, Route>) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("main task")
  /** Runs a Ctrl+P palette action by name. */
  async function palette(name: string) {
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText(name)
    view.mockInput.pressEnter()
  }
  return { server, view, screen, palette }
}

const lines = (frame: string) => frame.split("\n").map((row) => row.replace(/^\s*│ ?/, "").replace(/\s*(?:[█▀▄])?\s*│\s*$/, ""))

const task = {
  id: "tsk_117ea59ec001K9z4YaV2PEoNOY",
  rootSessionID: "ses_main",
  parentSessionID: "ses_main",
  childSessionID: "ses_ee815a613ffdciwCjatY52nQEM",
  agent: "general",
  description: "Summarise the readme",
  status: "completed",
  depth: 1,
  revision: 1,
  time: { created: 1, updated: 2 },
}

test("to-dos spell their state, and the list says why it cannot be edited", async () => {
  const { view, screen } = await sized(100, 36, {
    "GET /session/ses_main/todo": () => [
      { content: "Read the sandbox README", status: "completed", priority: "high" },
      { content: "Write the notes file", status: "in_progress", priority: "high" },
      { content: "Review the changes", status: "pending", priority: "medium" },
    ],
  })
  view.mockInput.pressKey("t")
  const frame = await screen("TO-DOS · 1/3 done")
  expect(frame).toContain("[done]       ● Read the sandbox README")
  expect(frame).toContain("[in progress] ◐ Write the notes file")
  expect(frame).toContain("[to do]      ○ Review the changes")
  expect(frame).toContain("read-only (the agent keeps this list)")
})

test("task rows lead with the description and agent, ids last, and the hint wraps between entries", async () => {
  const { view, screen } = await sized(80, 24, {
    "GET /api/session/ses_main/task": () => ({ data: [task], active: [], cursor: {} }),
  })
  view.mockInput.pressEscape()
  await screen("t Tasks")
  view.mockInput.pressKey("t")
  const frame = await screen("Summarise the readme")
  const rows = lines(frame)
  const at = rows.findIndex((row) => row.includes("Summarise the readme"))
  expect(rows[at + 1]).toContain("general agent")
  expect(rows[at + 1]).not.toContain("ses_")
  expect(rows[at + 2]).toContain("tsk_117ea59ec001K9z4YaV2PEoNOY")
  expect(frame).toContain("Recent and active subagent tasks")
  expect(frame).not.toContain("Root-wide")
  expect(rows.map((row) => row.trim())).not.toContain("PgUp/PgDn page")
  expect(frame).toContain("PgUp/PgDn page")
})

test("Changes marks the active mode in its hint and spells out the status letters", async () => {
  const { view, screen } = await sized(120, 36, {
    "GET /vcs/diff": () => [
      { file: "answer.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
      { file: "notes.md", status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1 @@\n+n" },
    ],
  })
  view.mockInput.pressKey("d")
  const frame = await screen("m mode:")
  expect(frame).toContain("m mode: [uncommitted] · branch · last turn")
  expect(frame).toContain("A added, M modified")
  view.mockInput.pressKey("m")
  expect(await screen("m mode: uncommitted · [branch] · last turn")).toContain("Changes on this branch")
})

const entry = (name: string, type: "file" | "directory") => ({
  name,
  path: type === "directory" ? `${name}/` : name,
  absolute: `/srv/main/${name}`,
  type,
  ignored: false,
})

test("Files sinks .git, says what Enter does for the selected row and names the previewed file", async () => {
  const { view, screen } = await sized(100, 36, {
    "GET /file": () => [entry(".git", "directory"), entry("src", "directory"), entry("notes.md", "file")],
    "GET /file/content": () => ({ type: "text", content: "# Notes" }),
  })
  view.mockInput.pressKey("e")
  const folder = await screen("▶ src/")
  const rows = lines(folder)
  expect(rows.findIndex((row) => row.includes("notes.md"))).toBeLessThan(rows.findIndex((row) => row.includes(".git/")))
  expect(folder).toContain("Enter open folder")
  view.mockInput.pressArrow("down")
  const file = await screen("1  # Notes")
  expect(file).not.toContain("Enter open folder")
  // The preview opens with the file's own name above its numbered lines.
  expect(file.split("\n").filter((row) => row.includes("notes.md")).length).toBeGreaterThan(1)
})

test("an empty swarm room explains itself across the dialog, not in a narrow column", async () => {
  const { view, screen } = await sized(100, 36, {
    "GET /api/session/ses_main/room": () =>
      Response.json({ _tag: "SwarmRoomNotFoundError", resource: "ses_main" }, { status: 404 }),
    "GET /api/session/ses_main/room/entries": () => ({ data: { entries: [], head: 0 } }),
  })
  view.mockInput.pressEnter()
  await screen("Esc shortcuts")
  view.mockInput.pressEscape()
  await screen("Focus: transcript")
  await view.mockInput.typeText("w")
  const frame = await screen("No swarm room")
  expect(frame).toContain("This session has no swarm room yet.")
  expect(frame).toContain("Type here to post as a human member")
})

test("Tools hangs wrapped descriptions under the row and lists each group alphabetically", async () => {
  const description = "Apply one patch containing add, update, delete, and move file operations. Use this instead of bash"
  const { screen, palette } = await sized(80, 24, {
    "GET /api/session": () => ({ data: [{ ...session(), model: { providerID: "openai", id: "gpt" } }], cursor: {} }),
    "GET /experimental/tool": () => ({
      agent: "build",
      providerID: "openai",
      modelID: "gpt",
      visible: [
        { id: "session_context", source: "builtin", description: "Report context" },
        { id: "bash", source: "session", description },
        { id: "edit", source: "builtin", description: "Replace text" },
        { id: "apply_patch", source: "builtin", description },
      ],
      mcpServers: [],
      exclusions: [],
    }),
  })
  await palette("Session tools")
  const frame = await screen("apply_patch · builtin")
  const rows = lines(frame)
  const first = rows.findIndex((row) => row.includes("apply_patch · builtin"))
  expect(rows[first + 1]).toMatch(/^ {6}\S/)
  const order = ["apply_patch ·", "edit ·", "session_context ·", "bash ·"].map((name) => frame.indexOf(name))
  expect(order).toEqual(order.toSorted((a, b) => a - b))
  expect(order.every((index) => index >= 0)).toBe(true)
})

test("Trace numbers rows by position when sources repeat a seq, and keeps the distinguishing end of a name", async () => {
  const event = (id: string, type: string, aggregateID: string, seq: number) => ({
    id,
    type,
    durable: { aggregateID, seq, version: 1 },
    data: {},
  })
  const { view, screen, palette } = await sized(80, 24, {
    "GET /api/session/ses_main/replay": () => ({
      data: [
        event("evt_1", "session.next.prompted", "ses_main", 0),
        event("evt_2", "session.next.prompt.admitted", "ses_main", 1),
        event("evt_3", "session.next.task.updated", "tsk_a", 0),
        event("evt_4", "session.next.task.updated", "tsk_a", 1),
      ],
      cursor: {},
    }),
  })
  await palette("Session trace")
  const frame = await screen("4 events from 2 sources")
  expect(frame).toContain("seq counts per source")
  expect(frame).toContain("#1 prompted")
  expect(frame).toContain("#2 prompt.admitted")
  expect(frame).toContain("#4 task.updated")
  expect(frame).not.toMatch(/#0 (session|prompt|task)/)
  view.mockInput.pressArrow("down")
  expect(await screen("evt_2 · seq #1 of ses_main")).toContain("session.next.prompt.admitted")
})

test("Trace with one source keeps its seq numbers and cuts the shared prefix of a name that does not fit", async () => {
  const event = (id: string, type: string, seq: number) => ({
    id,
    type,
    durable: { aggregateID: "ses_main", seq, version: 1 },
    data: {},
  })
  const { screen, palette } = await sized(80, 24, {
    "GET /api/session/ses_main/replay": () => ({
      data: [
        event("evt_1", "session.next.prompted", 5),
        event("evt_2", "session.next.prompt.admitted", 6),
        event("evt_3", "session.next.step.completed.with.a.very.long.event.name", 7),
      ],
      cursor: {},
    }),
  })
  await palette("Session trace")
  const frame = await screen("3 events · seq #5–#7")
  expect(frame).toContain("#5 prompted")
  expect(frame).toContain("#6 prompt.admitted")
  expect(frame).toContain("#7 session.next….name")
})

test("the new-terminal form names Tab, and a blank title becomes a readable default", async () => {
  const { server, view, screen } = await sized(100, 36, {
    // Refused, so the test never hands its screen to an attached terminal.
    "POST /api/pty": () => new Response(null, { status: 500 }),
  })
  view.mockInput.pressKey("2")
  await screen("No terminals")
  view.mockInput.pressKey("a")
  const frame = await screen("New terminal")
  expect(frame).toContain("Tab next field · Ctrl+S Open and attach · Esc cancel")
  expect(frame).toContain("blank names it after the folder")
  view.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(200)
  const created = server.sent("/api/pty").find((item) => item.method === "POST")
  expect((created!.body as { title?: string }).title).toBe("Shell in main")
})

test("the automation form lines values up under captions and its example matches the default", async () => {
  const { view, screen } = await sized(100, 36, {})
  view.mockInput.pressKey("3")
  await screen("Automations")
  view.mockInput.pressKey("a")
  const frame = await screen("New automation")
  expect(frame).toContain("Schedule: like every 1h, or cron")
  const caption = frame.split("\n").find((row) => row.includes("Schedule: like"))!
  const value = frame.split("\n").find((row) => row.includes("every 1h") && !row.includes("Schedule"))!
  expect(value.indexOf("every 1h")).toBe(caption.indexOf("Schedule:"))
})

test("the harness says what a snapshot is", async () => {
  const { screen, palette } = await sized(100, 36, {
    "GET /api/session/ses_main/harness": () => ({
      data: {
        snapshot: {
          version: 1,
          status: "active",
          source: "default",
          changes: [],
          tools: [],
          guidance: [],
          validation: { status: "pending", errors: [], warnings: [] },
          timestamps: { created: 1, updated: 1 },
        },
        proposals: [],
        reviewerRequests: [],
        reviewerRuns: [],
      },
    }),
  })
  await palette("Harness")
  const frame = await screen("Snapshot v1 · active · from default · validation pending")
  expect(frame).toContain("A snapshot is the saved set of tools and guidance")
})

/** Rows of x's that reach the bar's column would show it over a letter; the text must end a column early. */
function clearOfBar(frame: string) {
  const rows = frame.split("\n").filter((row) => row.includes("xxxxxxxxxx"))
  expect(rows.length).toBeGreaterThan(3)
  for (const row of rows) expect(row.trimEnd()).toMatch(/x {2}│$/)
}

const long = "x".repeat(2000)

test("a long wrapped line in Files stays clear of the scroll bar at 100x36", async () => {
  const { view, screen } = await sized(100, 36, {
    "GET /file": () => [entry("long.txt", "file")],
    "GET /file/content": () => ({ type: "text", content: long }),
  })
  view.mockInput.pressKey("e")
  clearOfBar(await screen("xxxxxxxxxx"))
})

test("a long wrapped line in the swarm room stays clear of the scroll bar at 100x36", async () => {
  const room = {
    id: "room_1",
    rootSessionID: "ses_main",
    objective: "Ship it",
    budget: 1,
    explicitBudget: false,
    head: 1,
    status: "open",
    timeCreated: 1,
    timeUpdated: 1,
  }
  const { view, screen } = await sized(100, 36, {
    "GET /api/session/ses_main/room": () => ({ data: { room, members: [], lanes: [] } }),
    "GET /api/session/ses_main/room/entries": () => ({
      data: {
        entries: [
          {
            id: "ent_1",
            roomID: "room_1",
            seq: 1,
            actor: { type: "human", memberID: "mem_1", name: "you" },
            kind: "message",
            text: long,
            baseRevision: 0,
            timeCreated: 1,
          },
        ],
        head: 1,
      },
    }),
  })
  view.mockInput.pressEnter()
  await screen("Esc shortcuts")
  view.mockInput.pressEscape()
  await screen("h History")
  await view.mockInput.typeText("w")
  clearOfBar(await screen("xxxxxxxxxx"))
})

test("a long wrapped line in Trace stays clear of the scroll bar at 100x36", async () => {
  const { screen, palette } = await sized(100, 36, {
    "GET /api/session/ses_main/replay": () => ({
      data: [{ id: "evt_1", type: "session.created", durable: { aggregateID: "ses_main", seq: 0, version: 1 }, data: long }],
      cursor: {},
    }),
  })
  await palette("Session trace")
  clearOfBar(await screen("xxxxxxxxxx"))
})
