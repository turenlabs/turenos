import { afterEach, expect, test } from "bun:test"
import { KeyEvent, RGBA } from "@opentui/core"
import { diffLines } from "../src/diff"
import { color } from "../src/theme"
import { backspace, cleanup, dashboard, session, until } from "./support"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const loop = {
  id: "loop_1",
  name: "Nightly check",
  prompt: "Run the tests",
  location: { directory: "/srv/main" },
  status: "active",
  schedule: { type: "interval", seconds: 86400, timezone: "UTC" },
}

async function editLoop(item: Record<string, unknown>) {
  const app = await dashboard({
    "GET /api/loop": () => [item],
    "GET /api/loop/loop_1/run": () => [],
    "PATCH /api/loop/loop_1": () => item,
  })
  app.view.mockInput.pressKey("3")
  await app.screen("Nightly check")
  app.view.mockInput.pressKey("E")
  await app.screen("Edit automation")
  return app
}

const patched = (app: Awaited<ReturnType<typeof editLoop>>) =>
  app.server.requests.find((item) => item.method === "PATCH" && item.path === "/api/loop/loop_1")?.body as
    | Record<string, unknown>
    | undefined

test("renaming an event-triggered automation never sends a schedule", async () => {
  const app = await editLoop({
    ...loop,
    schedule: { type: "interval", seconds: 60, timezone: "UTC" },
    eventTrigger: { type: "file-change", paths: ["src"] },
  })
  const frame = await app.screen("edited in the desktop")
  expect(frame).not.toContain("Schedule:")
  await app.confirm(" two")
  await app.screen("Automation saved.")
  expect(patched(app)).toMatchObject({ name: "Nightly check two" })
  expect(Object.keys(patched(app)!)).not.toContain("intervalSeconds")
  expect(Object.keys(patched(app)!)).not.toContain("cronExpression")
})

test("a name-only edit leaves the schedule alone and a changed schedule is sent", async () => {
  const app = await editLoop(loop)
  await app.confirm(" two")
  await app.screen("Automation saved.")
  expect(patched(app)).toMatchObject({ name: "Nightly check two" })
  expect(Object.keys(patched(app)!)).not.toContain("intervalSeconds")

  const changed = await editLoop(loop)
  changed.view.mockInput.pressTab()
  changed.view.mockInput.pressTab()
  for (let step = 0; step < 8; step++) backspace(changed.view)
  await changed.confirm("every 2h")
  await changed.screen("Automation saved.")
  expect(patched(changed)).toMatchObject({ intervalSeconds: 7200 })
})

test("an interval too long to count in seconds is refused with a reason", async () => {
  const app = await editLoop(loop)
  app.view.mockInput.pressTab()
  app.view.mockInput.pressTab()
  for (let step = 0; step < 8; step++) backspace(app.view)
  await app.confirm("every 999999999999999999d")
  await app.screen("That interval is too long.")
  expect(patched(app)).toBeUndefined()
})

test("a prefilled automation prompt cannot carry terminal control sequences", async () => {
  const app = await editLoop({ ...loop, prompt: "Run\u001b]0;pwned\u0007 the tests" })
  const frame = await app.screen("Run")
  expect(frame).not.toContain("\u001b")
  expect(frame).toContain("Run]0;pwned the tests")
})

test("Ctrl+D on a live run needs a second press inside the window and ignores key repeat", async () => {
  const app = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [{ id: "run_1", loopID: "loop_1", status: "running", time: { created: 1 } }],
    "POST /api/loop/loop_1/run/run_1/cancel": () => ({ id: "run_1", loopID: "loop_1", status: "cancelled" }),
  })
  app.view.mockInput.pressKey("3")
  await app.screen("Nightly check")
  await app.palette("Manage automation")
  await app.screen("Runs")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("1 recent run")
  const cancels = () => app.server.requests.filter((item) => item.path.endsWith("/cancel")).length
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again cancels this run.")
  // A repeat event is the held key, not a second press.
  app.view.renderer.keyInput.emit("keypress", repeat())
  await Bun.sleep(100)
  expect(cancels()).toBe(0)
  const realNow = Date.now
  Date.now = () => realNow() + 3000
  try {
    app.view.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(100)
  } finally {
    Date.now = realNow
  }
  expect(cancels()).toBe(0)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await until(() => cancels() === 1)
})

function repeat() {
  return new KeyEvent({
    name: "d",
    sequence: "d",
    raw: "d",
    ctrl: true,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "repeat",
    source: "raw",
  })
}

const wing = { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 }
const room = { id: "rom_1", wingID: "wng_1", slug: "tooling", name: "Tooling", timeCreated: 1, timeUpdated: 1 }
const memory = {
  id: "drw_1",
  wingID: "wng_1",
  roomID: "rom_1",
  kind: "decision",
  title: "Use pinned bun",
  body: "Global bun is too old.",
  anchor: {},
  provenance: { assertedBy: "build", source: "agent" },
  timeValidFrom: 1,
  timeCreated: 1,
  timeUpdated: 5,
}

async function memoriesRoom(routes: Parameters<typeof dashboard>[0], ready = "Global bun is too old.") {
  const app = await dashboard({
    "GET /api/memory/wing": () => [wing],
    "GET /api/memory/room": () => [room],
    "GET /api/memory": () => [memory],
    ...routes,
  })
  await app.palette("Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen(ready)
  return app
}

const deletes = (app: Awaited<ReturnType<typeof memoriesRoom>>) =>
  app.server.requests.filter((item) => item.method === "DELETE").length

test("deleting a memory needs a second Ctrl+D inside the window, not a held key", async () => {
  const app = await memoriesRoom({ "DELETE /api/memory/drw_1": () => new Response(null, { status: 204 }) })
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again deletes")
  app.view.renderer.keyInput.emit("keypress", repeat())
  await Bun.sleep(100)
  expect(deletes(app)).toBe(0)
  const realNow = Date.now
  Date.now = () => realNow() + 3000
  try {
    app.view.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(100)
  } finally {
    Date.now = realNow
  }
  expect(deletes(app)).toBe(0)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await until(() => deletes(app) === 1)
})

test("a third Ctrl+D while the delete is in flight sends nothing more", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const app = await memoriesRoom({
    "DELETE /api/memory/drw_1": async () => {
      await gate
      return new Response(null, { status: 204 })
    },
  })
  for (let press = 0; press < 3; press++) app.view.mockInput.pressKey("d", { ctrl: true })
  await until(() => deletes(app) === 1)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await Bun.sleep(100)
  expect(deletes(app)).toBe(1)
  release()
  await app.screen("Deleted")
})

test("a slow refresh cannot repaint a memory deleted since it started", async () => {
  let calls = 0
  let deleted = false
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const app = await memoriesRoom({
    "GET /api/memory": async () => {
      calls++
      if (calls !== 2) return deleted ? [] : [memory]
      await gate
      return [memory]
    },
    "DELETE /api/memory/drw_1": () => {
      deleted = true
      return new Response(null, { status: 204 })
    },
  })
  app.view.mockInput.pressKey("r", { ctrl: true })
  await until(() => calls === 2)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again deletes")
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("No memories here yet")
  release()
  await Bun.sleep(150)
  await app.view.renderOnce()
  expect(app.view.captureCharFrame()).toContain("0 memories")
})

test("Ctrl+S after an uncertain create does not add a second memory, but a refusal may be corrected", async () => {
  let status = 500
  const app = await memoriesRoom({
    "POST /api/memory": () => new Response(JSON.stringify({ message: "nope" }), { status }),
  })
  app.view.mockInput.pressKey("a")
  await app.screen("New memory")
  await app.view.mockInput.typeText("Run tests alone")
  app.view.mockInput.pressTab()
  await app.confirm("Parallel runs flake.")
  const posts = () => app.server.requests.filter((item) => item.method === "POST" && item.path === "/api/memory").length
  await until(() => posts() === 1)
  await Bun.sleep(100)
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("The memory may already exist")
  expect(posts()).toBe(1)
})

test("a definite refusal of a memory create lets the corrected form be sent again", async () => {
  const app = await memoriesRoom({
    "POST /api/memory": () => Response.json({ _tag: "InvalidRequestError", message: "nope" }, { status: 400 }),
  })
  app.view.mockInput.pressKey("a")
  await app.screen("New memory")
  await app.view.mockInput.typeText("Run tests alone")
  app.view.mockInput.pressTab()
  await app.confirm("Parallel runs flake.")
  const posts = () => app.server.requests.filter((item) => item.method === "POST" && item.path === "/api/memory").length
  await until(() => posts() === 1)
  await Bun.sleep(100)
  app.view.mockInput.pressKey("s", { ctrl: true })
  await until(() => posts() === 2)
})

test("a memory's title, body and source cannot carry terminal control sequences", async () => {
  const osc = "\x1b]0;x\x07"
  const app = await memoriesRoom(
    {
      "GET /api/memory": () => [
        {
          ...memory,
          title: `Title${osc}`,
          body: `Body${osc}`,
          provenance: { assertedBy: "build", source: `src${osc}` },
        },
      ],
    },
    "Body]0;x",
  )
  expect(app.view.captureCharFrame()).not.toContain("\x1b")
  expect(app.view.captureCharFrame()).toContain("src]0;x")
  app.view.mockInput.pressKey("E")
  const frame = await app.screen("Edit memory")
  expect(frame).not.toContain("\x1b")
  expect(frame).toContain("Title]0;x")
})

const advisory = (id: string, url?: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Advisory ${id}`,
  severity: "high",
  publishedAt: 1,
  updatedAt: 1,
  source: "github",
  summary: `Summary ${id}.`,
  url,
  ...extra,
})

test("intel links show as the URL parser reads them, or are withheld", async () => {
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({
      items: [
        advisory("A1", "javascript:alert(1)"),
        advisory("A2", `https://exa${String.fromCharCode(0x2044)}mple.com/a`),
        advisory("A3", "https://example.com/advisory"),
        advisory("A4", "https://example.com/a b"),
      ],
      total: 4,
      page: 1,
      pageSize: 50,
    }),
  })
  app.view.mockInput.pressKey("I")
  const withheld = await app.screen("Summary A1.")
  expect(withheld).toContain("(link withheld)")
  expect(withheld).not.toContain("javascript:")
  app.view.mockInput.pressArrow("down")
  const lookalike = await app.screen("Summary A2.")
  expect(lookalike).not.toContain(String.fromCharCode(0x2044))
  expect(lookalike).toContain("https://xn--")
  app.view.mockInput.pressArrow("down")
  expect(await app.screen("Summary A3.")).toContain("https://example.com/advisory")
  app.view.mockInput.pressArrow("down")
  expect(await app.screen("Summary A4.")).toContain("(link withheld)")
})

test("intel paging stops at the last page and a failed page does not move the reader", async () => {
  const requested: number[] = []
  const app = await dashboard({
    "GET /api/intel/advisories": (_, url) => {
      const page = Number(url.searchParams.get("page"))
      requested.push(page)
      if (page === 2 && requested.filter((item) => item === 2).length === 1) return new Response(null, { status: 500 })
      return { items: [advisory(`P${page}`)], total: 120, page, pageSize: 50 }
    },
  })
  app.view.mockInput.pressKey("I")
  await app.screen("page 1 of 3")
  app.view.mockInput.pressKey("]")
  await app.screen("unavailable")
  app.view.mockInput.pressKey("r", { ctrl: true })
  await app.screen("page 1 of 3")
  expect(requested.at(-1)).toBe(1)
  for (let press = 0; press < 5; press++) {
    app.view.mockInput.pressKey("]")
    await Bun.sleep(40)
  }
  await app.screen("page 3 of 3")
  expect(Math.max(...requested)).toBe(3)
})

test("a feed toggle that finishes later leaves a dialog the user opened meanwhile alone", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const feed = { id: "kev", name: "CISA KEV", kind: "kev", url: "https://cisa.gov/kev", enabled: true }
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
    "GET /api/intel/feeds": () => [feed],
    "PATCH /api/intel/feeds/kev": async () => {
      await gate
      return { ...feed, enabled: false }
    },
  })
  app.view.mockInput.pressKey("I")
  await app.screen("Intel › Advisories")
  app.view.mockInput.pressKey("f")
  await app.screen("CISA KEV")
  app.view.mockInput.pressEnter()
  await until(() => app.server.requests.some((item) => item.method === "PATCH"))
  app.view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  await app.view.mockInput.typeText("keep this draft")
  await app.screen("keep this draft")
  release()
  await app.screen("CISA KEV turned off.").catch(() => undefined)
  await Bun.sleep(150)
  await app.view.renderOnce()
  const frame = app.view.captureCharFrame()
  expect(frame).toContain("keep this draft")
  expect(frame).not.toContain("Intel › Feeds")
})

test("a feed name cannot carry control sequences into the toggle note", async () => {
  const feed = { id: "kev", name: "Feed\x1b]0;x\x07", kind: "kev", url: "https://cisa.gov/kev", enabled: true }
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
    "GET /api/intel/feeds": () => [feed],
    "PATCH /api/intel/feeds/kev": () => ({ ...feed, enabled: false }),
  })
  app.view.mockInput.pressKey("I")
  await app.screen("Intel › Advisories")
  app.view.mockInput.pressKey("f")
  await app.screen("Feed]0;x")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("turned off.")
  expect(frame).not.toContain("\x1b")
})

test("more than 128 running sessions leaves the dashboard connected", async () => {
  const routes: Parameters<typeof dashboard>[0] = {
    "GET /api/session/active": () => ({
      data: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`ses_r${i}`, { type: "running" }])),
    }),
  }
  for (let i = 0; i < 130; i++) routes[`GET /api/session/ses_r${i}`] = () => ({ data: session(`r${i}`) })
  const app = await dashboard(routes)
  const frame = await app.screen("128+ running")
  expect(frame).not.toContain("Could not connect")
})

function extension(id: string, name: string, enabled = false) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name,
      description: `${name} description`,
      version: "1",
      publisher: "turen",
      trust: "verified",
      contributions: [],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status: enabled ? "connected" : "needs-auth",
    secretsSet: {},
    configurationSet: {},
  }
}

test("a second extension toggle waits for the first instead of painting a stale list", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const app = await dashboard({
    "GET /extension": () => [extension("alpha", "Alpha"), extension("beta", "Beta")],
    "PATCH /extension/alpha": async () => {
      await gate
      return [extension("alpha", "Alpha", true), extension("beta", "Beta")]
    },
    "PATCH /extension/beta": () => [extension("alpha", "Alpha"), extension("beta", "Beta", true)],
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 2; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("○ Alpha")
  app.view.mockInput.pressEnter()
  await until(() => app.server.requests.some((item) => item.path === "/extension/alpha"))
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Wait for the previous change to finish.")
  expect(app.server.requests.filter((item) => item.method === "PATCH")).toHaveLength(1)
  release()
  await app.screen("● Alpha")
})

test("an extension whose id would leave its route is dropped from the list", async () => {
  const app = await dashboard({
    "GET /extension": () => [extension("..", "Dots"), extension("turenlabs/good", "Good")],
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 2; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Good")
  expect(frame).not.toContain("Dots")
})

test("a swarm entry kind is shown as plain text and an inherited name gets no style", async () => {
  const entry = {
    id: "ent_1",
    roomID: "room_1",
    seq: 1,
    actor: { type: "human", memberID: "mem_1", name: "you" },
    kind: "constructor\x1b]0;x\x07",
    text: "hello room",
    baseRevision: 0,
    timeCreated: 1,
  }
  const app = await dashboard({
    "GET /api/session/ses_main/room": () => ({
      data: {
        room: {
          id: "room_1",
          rootSessionID: "ses_main",
          objective: "Ship it",
          budget: 1,
          explicitBudget: false,
          head: 1,
          status: "open",
          timeCreated: 1,
          timeUpdated: 1,
        },
        members: [],
        lanes: [],
      },
    }),
    "GET /api/session/ses_main/room/entries": () => ({ data: { entries: [entry], head: 1 } }),
  })
  await app.screen("main task")
  app.view.mockInput.pressEnter()
  // Opening the session puts the keyboard in the reply editor; Esc returns it to the shortcuts.
  await app.screen("Typing")
  app.view.mockInput.pressKey("ESCAPE")
  await until(() => !app.view.captureCharFrame().includes("Typing"))
  await app.view.mockInput.typeText("w")
  const frame = await app.screen("hello room")
  expect(frame).toContain("constructor]0;x")
  expect(frame).not.toContain("\x1b")
  const span = app.view
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((item) => item.text.includes("hello room"))
  expect(span?.fg).toEqual(RGBA.fromHex(color.text))
})

test("file paths the server sends for Changes are checked and a mention that cannot be written says so", async () => {
  const bell = String.fromCharCode(7)
  const file = (name: string) => ({ file: name, patch: `@@ -0,0 +1 @@\n+${name}`, additions: 1, deletions: 0 })
  const app = await dashboard({
    "GET /vcs/diff": () => [file("/etc/passwd"), file("../outside.ts"), file(`bad${bell}name.ts`), file('say "hi".ts')],
  })
  await app.screen("main task")
  app.view.mockInput.pressKey("d")
  const frame = await app.screen('say "hi".ts')
  expect(frame).not.toContain("passwd")
  expect(frame).not.toContain("outside.ts")
  expect(frame).not.toContain("bad")
  app.view.mockInput.pressKey("@")
  await app.screen("cannot be mentioned")
})

test("++x inside a hunk is an added line, while headers before the hunk stay muted", () => {
  const tones = diffLines({
    messageID: "msg_a",
    files: [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+++x\n---y",
      },
    ],
  }).map((line) => [line.text, line.tone])
  expect(tones).toContainEqual(["--- a/a.ts", "meta"])
  expect(tones).toContainEqual(["+++ b/a.ts", "meta"])
  expect(tones).toContainEqual(["+++x", "added"])
  expect(tones).toContainEqual(["---y", "removed"])
})

test("permission checks the server does not report read as unknown and cannot be toggled", async () => {
  const app = await dashboard({
    "GET /global/permission-checks": () => ({}),
    "GET /api/permission/saved": () => ({ data: [] }),
    "PUT /global/permission-checks": () => ({ enforced: true }),
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 5; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Permission checks: unknown")
  expect(frame).not.toContain("Tools act without asking")
  app.view.mockInput.pressEnter()
  await app.screen("Permission checks: unknown")
  expect(app.server.requests.some((item) => item.method === "PUT")).toBe(false)
})

test("a title over 200 characters is cut to the field and says so", async () => {
  const long = `${"t".repeat(190)} ${"u".repeat(100)}`
  const app = await dashboard({
    "GET /api/session": () => ({ data: [{ ...session(), title: long }], cursor: {} }),
  })
  await app.screen("t".repeat(20))
  await app.palette("Rename session")
  const frame = await app.screen("The title was shortened to 200 characters.")
  expect(frame).toContain("Rename session")
})
