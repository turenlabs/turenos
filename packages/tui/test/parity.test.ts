import { expect, test } from "bun:test"
import { parseSchedule } from "../src/automations"
import { assistant, dashboard, globalEvents, session, until, type Route } from "./support"

function queued(id: string, text: string, delivery: "queue" | "steer" = "queue") {
  return { admittedSeq: 1, id, sessionID: "ses_main", prompt: { text }, delivery, timeCreated: 1 }
}

test("queued messages can be sent now, discarded, or taken back into the reply editor", async () => {
  let inputs = [queued("msg_first", "Also run the linter"), queued("msg_second", "Then update the docs")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/steer": () => {
      inputs = inputs.filter((item) => item.id !== "msg_first")
      return { data: true }
    },
    "POST /api/session/ses_main/input/msg_second/cancel": () => {
      inputs = inputs.filter((item) => item.id !== "msg_second")
      return { data: true }
    },
  })
  await screen("u 2 queued")
  view.mockInput.pressKey("u")
  await screen("Also run the linter")
  view.mockInput.pressEnter()
  await screen("Sent now")
  expect(server.sent("/api/session/ses_main/input/msg_first/steer")).toHaveLength(1)
  // Discard asks twice; one Ctrl+D sends nothing.
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Ctrl+D again discards")
  expect(server.sent("/api/session/ses_main/input/msg_second/cancel")).toHaveLength(0)
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Discarded.")
  expect(server.sent("/api/session/ses_main/input/msg_second/cancel")).toHaveLength(1)
})

test("editing a queued message cancels it and reopens its text in the reply editor", async () => {
  let inputs = [queued("msg_first", "Rename the flag")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      inputs = []
      return { data: true }
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("Reply to main task")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Rename the flag")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(1)
})

test("a queued message too long for the reply editor is never cancelled for editing", async () => {
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_long", "x".repeat(32001))] }),
  })
  view.mockInput.pressKey("u")
  await screen("Held · agent is idle")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("longer than the reply editor")
  expect(server.sent("/api/session/ses_main/input/msg_long/cancel")).toHaveLength(0)
})

test("deleting a session asks for the word delete, then removes it from the server and the list", async () => {
  let deleted = false
  const { server, screen, palette, confirm } = await dashboard({
    "GET /api/session": () => ({ data: deleted ? [] : [session()], cursor: {} }),
    "DELETE /session/ses_main": () => {
      deleted = true
      return true
    },
  })
  await screen("main task")
  await palette("Delete session")
  await screen("This cannot be undone")
  await confirm("delet")
  await screen("Type delete to confirm.")
  expect(server.sent("/session/ses_main")).toHaveLength(0)
  await confirm("e")
  await screen("Session deleted.")
  expect(server.requests.find((item) => item.path === "/session/ses_main")?.method).toBe("DELETE")
  await screen("Welcome to TurenOS")
})

test("the agent's to-do list shows in the action row and the Tasks view", async () => {
  const { view, screen } = await dashboard({
    "GET /session/ses_main/todo": () => [
      { content: "Read the parser", status: "completed", priority: "high" },
      { content: "Fix the off-by-one", status: "in_progress", priority: "high" },
      { content: "Add a regression test", status: "pending", priority: "medium" },
    ],
  })
  await screen("t Tasks · 1/3 to-dos")
  view.mockInput.pressKey("t")
  const frame = await screen("TO-DOS · 1/3 done")
  expect(frame).toContain("● Read the parser")
  expect(frame).toContain("◐ Fix the off-by-one")
  expect(frame).toContain("○ Add a regression test")
})

test("the context meter uses the newest request's prompt and the model's published window", async () => {
  const { screen } = await dashboard({
    "GET /api/session/ses_main/message": () => ({
      data: [
        assistant("reply", "Done.", {
          tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 48500, write: 0 } },
        }),
      ],
      cursor: {},
    }),
    "GET /provider": () => ({
      all: [
        {
          id: "test",
          name: "Test",
          models: { model: { id: "model", providerID: "test", name: "Model", limit: { context: 200000 } } },
        },
      ],
      connected: ["test"],
    }),
  })
  await screen("Context 25% · 50k/200k")
})

test("the kill switch stops every session only after typing stop all", async () => {
  const { server, screen, palette, confirm } = await dashboard({
    "POST /api/session/interrupt-all": () => ({ data: { interrupted: 3, failed: 0 } }),
  })
  await palette("Stop all agents")
  await screen("Type stop all, then Ctrl+S")
  await confirm("stop")
  await screen("Type stop all to confirm.")
  await confirm(" all")
  await screen("Stopped 3 session(s).")
  expect(server.sent("/api/session/interrupt-all")).toHaveLength(1)
})

test("Changes shows each file's colored patch and cycles uncommitted, branch, and last-turn modes", async () => {
  const modes: (string | null)[] = []
  const { server, view, screen } = await dashboard({
    "GET /vcs/diff": (_, url) => {
      modes.push(url.searchParams.get("mode"))
      return url.searchParams.get("mode") === "git"
        ? [
            {
              file: "src/a.ts",
              patch: "@@ -1 +1 @@\n-old line\n+new line",
              additions: 1,
              deletions: 1,
              status: "modified",
            },
            { file: "docs/b.md", patch: "@@ -0,0 +1 @@\n+hello", additions: 1, deletions: 0, status: "added" },
          ]
        : []
    },
    "GET /api/session/ses_main/message": () => ({
      data: [
        assistant("reply", "Edited it", { snapshot: { start: "a", end: "b", files: ["docs/b.md", "src/gone.ts"] } }),
        { id: "msg_prompt", type: "user", text: "Fix it", time: { created: 1 } },
      ],
      cursor: {},
    }),
  })
  view.mockInput.pressKey("d")
  await screen("Uncommitted changes · 2 files +2 -1")
  expect(await screen("+new line")).toContain("-old line")
  expect(server.requests.find((item) => item.path === "/vcs/diff")).toBeDefined()
  view.mockInput.pressArrow("down")
  await screen("+hello")
  view.mockInput.pressKey("m")
  await screen("working tree matches its base")
  // The last turn's files come from its assistant messages; their patch is what is uncommitted now.
  view.mockInput.pressKey("m")
  expect(await screen("Files the last turn changed · 2 files")).toContain("+hello")
  view.mockInput.pressArrow("down")
  await screen("No uncommitted change to this file now")
  expect(modes).toEqual(["git", "branch", "git"])
  // @ puts the file into the reply draft for the agent.
  view.mockInput.pressKey("@")
  await screen("Reply to main task")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("@src/gone.ts ")
})

test("Files browses folders and shows file contents read-only", async () => {
  const { view, screen } = await dashboard({
    "GET /file": (_, url) =>
      url.searchParams.get("path") === "src"
        ? [{ name: "main.ts", path: "src/main.ts", absolute: "/srv/main/src/main.ts", type: "file", ignored: false }]
        : [
            { name: "README.md", path: "README.md", absolute: "/srv/main/README.md", type: "file", ignored: false },
            // The server ends folder paths with a slash.
            { name: "src", path: "src/", absolute: "/srv/main/src", type: "directory", ignored: false },
          ],
    "GET /file/content": (_, url) => ({
      type: "text",
      content: url.searchParams.get("path") === "src/main.ts" ? "export const main = 1" : "# Readme",
    }),
  })
  view.mockInput.pressKey("e")
  expect(await screen("Enter opens this folder")).not.toContain("src//")
  view.mockInput.pressEnter()
  await screen("1  export const main = 1")
  view.mockInput.pressArrow("left")
  await screen("Enter opens this folder")
  view.mockInput.pressArrow("down")
  await screen("1  # Readme")
})

test("the Terminals tab renames and closes server terminals", async () => {
  const shell = { id: "pty_1", title: "build", command: "zsh", args: [], cwd: "/srv/main", status: "running", pid: 42 }
  const { server, view, screen, confirm } = await dashboard({
    "GET /api/pty": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [shell],
    }),
    "PUT /api/pty/pty_1": () => ({ location: { directory: "/srv/main" }, data: { ...shell, title: "tests" } }),
    "DELETE /api/pty/pty_1": () => new Response(null, { status: 204 }),
  })
  view.mockInput.pressKey("2")
  await screen("Enter attaches (Ctrl+] detaches)")
  view.mockInput.pressKey("R")
  await screen("Rename terminal")
  view.mockInput.pressKey("u", { ctrl: true })
  await confirm("tests")
  await screen("Terminal renamed.")
  expect(server.requests.find((item) => item.method === "PUT")?.body).toEqual({ title: "tests" })
  view.mockInput.pressKey("d")
  await screen("Ends the process and its output.")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Terminal closed.")
  expect(server.requests.some((item) => item.method === "DELETE" && item.path === "/api/pty/pty_1")).toBe(true)
})

test("the swarm room shows lanes and entries, and posts as a human member", async () => {
  const actor = { type: "leader", memberID: "mem_1", name: "build" }
  const entry = (seq: number, text: string, kind = "finding") => ({
    id: `sre_${seq}`,
    roomID: "srm_1",
    seq,
    actor,
    kind,
    text,
    baseRevision: 0,
    timeCreated: 1,
  })
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/room": () => ({
      data: {
        room: {
          id: "srm_1",
          rootSessionID: "ses_main",
          objective: "Ship parity",
          budget: 0,
          explicitBudget: false,
          head: 1,
          status: "open",
          timeCreated: 1,
          timeUpdated: 1,
        },
        members: [{ id: "mem_1", roomID: "srm_1", type: "leader", name: "build", state: "active", joinedAt: 1 }],
        lanes: [{ key: "docs", title: "Write the docs", status: "claimed", claimedByName: "writer", updatedSeq: 1 }],
      },
    }),
    "GET /api/session/ses_main/room/entries": () => ({
      data: { entries: [entry(1, "The parser is fixed")], head: 1, hasMore: false },
    }),
    "POST /api/session/ses_main/room/entries": () => ({ data: entry(2, "Looks good", "message") }),
  })
  view.mockInput.pressKey("w")
  await screen("Ship parity")
  expect(await screen("The parser is fixed")).toContain("[claimed] Write the docs · writer")
  view.mockInput.pressTab()
  await view.mockInput.typeText("Looks good")
  view.mockInput.pressEnter()
  await Bun.sleep(100)
  expect(server.requests.find((item) => item.method === "POST")?.body).toEqual({ text: "Looks good" })
})

test("editing a queued message keeps its text when Escape is pressed during the cancel", async () => {
  let release = () => {}
  const { view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({
      data: [
        {
          id: "msg_q1",
          sessionID: "ses_main",
          prompt: { text: "queued follow-up" },
          delivery: "queue",
          timeCreated: 1,
          admittedSeq: 1,
        },
      ],
    }),
    "POST /api/session/ses_main/input/msg_q1/cancel": () =>
      new Promise((resolve) => {
        release = () => resolve({ data: true })
      }),
  })
  view.mockInput.pressKey("u")
  await screen("queued follow-up")
  view.mockInput.pressKey("e", { ctrl: true })
  await Bun.sleep(50)
  // Escape while the server removes the message must not drop it: the dialog stays until it is a draft.
  view.mockInput.pressEscape()
  await Bun.sleep(50)
  release()
  expect(await screen("Reply")).toContain("queued follow-up")
})

test("a cancel whose answer was lost keeps the message text and does not claim it was delivered", async () => {
  let inputs = [queued("msg_first", "Rename the flag")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      inputs = []
      return new Response("lost", { status: 503 })
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  const frame = await screen("removed or already delivered")
  expect(frame).toContain("Rename the flag")
  expect(frame).not.toContain("already received that message")
  expect(frame).not.toContain("Reply to main task")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(1)
})

test("a lost cancel on a message that is still queued leaves it listed for another try", async () => {
  let fail = true
  let inputs = [queued("msg_first", "Rename the flag")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      if (fail) return new Response("down", { status: 503 })
      inputs = []
      return { data: true }
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("still queued")
  fail = false
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("Reply to main task")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(2)
})

test("a refresh keeps the same queued message selected and disarms a discard that moved", async () => {
  let inputs = [
    queued("msg_a", "First message"),
    { ...queued("msg_b", "Second message"), admittedSeq: 2 },
    { ...queued("msg_c", "Third message"), admittedSeq: 3 },
  ]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_b/steer": () => ({ data: true }),
    "POST /api/session/ses_main/input/msg_b/cancel": () => ({ data: true }),
    "POST /api/session/ses_main/input/msg_c/cancel": () => ({ data: true }),
  })
  view.mockInput.pressKey("u")
  await screen("First message")
  view.mockInput.pressArrow("down")
  await screen("For: main task\n\nSecond message".split("\n")[0]!)
  inputs = inputs.slice(1)
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Second message")
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Ctrl+D again discards")
  inputs = inputs.slice(1)
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("selected message left the queue")
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Ctrl+D again discards")
  expect(server.sent("/api/session/ses_main/input/msg_b/cancel")).toHaveLength(0)
  expect(server.sent("/api/session/ses_main/input/msg_c/cancel")).toHaveLength(0)
})

test("editing an automation keeps the time zone its cron expression was created in", () => {
  const schedule = { type: "cron" as const, seconds: 0, expression: "0 9 * * MON-FRI", timezone: "Asia/Tokyo" }
  expect(parseSchedule("0 9 * * MON-FRI", schedule)).toEqual({
    cronExpression: "0 9 * * mon-fri",
    timezone: "Asia/Tokyo",
  })
  expect(parseSchedule("0 10 * * mon-fri", schedule)?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(parseSchedule("every 2h", schedule)).toEqual({ intervalSeconds: 7200 })
})

test("a run's session fetched for opening is not opened once the user moved on", async () => {
  const loop = {
    id: "loop_1",
    name: "Nightly check",
    prompt: "Run the tests",
    location: { directory: "/srv/main" },
    status: "active",
    schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
  }
  const { view, screen, palette } = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [
      {
        id: "run_1",
        loopID: "loop_1",
        status: "succeeded",
        trigger: "manual",
        sessionID: "ses_run",
        time: { created: 1, updated: 1 },
      },
    ],
    "GET /api/session/ses_run": () => Bun.sleep(600).then(() => ({ data: session("run") })),
  })
  view.mockInput.pressKey("3")
  await screen("Enter manage (run now, pause, edit, runs)")
  await palette("Manage automation")
  await screen("Runs")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("1 recent run")
  view.mockInput.pressEnter()
  // Back to the sessions tab while the run's session is still being fetched.
  view.mockInput.pressKey("1")
  await screen("main says hello")
  await Bun.sleep(800)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("run task")
  expect(view.captureCharFrame()).toContain("main says hello")
})

test("automations can be run now and created with a plain-language schedule", async () => {
  const loop = {
    id: "loop_1",
    name: "Nightly check",
    prompt: "Run the tests",
    location: { directory: "/srv/main" },
    status: "active",
    schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
  }
  const { server, view, screen, palette, confirm } = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [],
    "POST /api/loop/loop_1/run": () => ({ id: "run_1", loopID: "loop_1", status: "claimed" }),
    "POST /api/loop": () => ({ ...loop, id: "loop_2" }),
  })
  view.mockInput.pressKey("3")
  await screen("Enter manage (run now, pause, edit, runs)")
  await palette("Manage automation")
  await screen("Run now")
  view.mockInput.pressEnter()
  await screen("Started a run.")
  expect(server.sent("/api/loop/loop_1/run").some((item) => item.method === "POST")).toBe(true)
  view.mockInput.pressKey("a")
  await screen("╭─ New automation")
  await view.mockInput.typeText("Weekly docs")
  view.mockInput.pressTab()
  await confirm("Update the changelog")
  await screen("Automation created.")
  expect(server.requests.find((item) => item.method === "POST" && item.path === "/api/loop")?.body).toMatchObject({
    name: "Weekly docs",
    prompt: "Update the changelog",
    intervalSeconds: 3600,
    location: { directory: "/srv/main" },
  })
})

test("schedules accept intervals and cron expressions", () => {
  expect(parseSchedule("every 15m")).toEqual({ intervalSeconds: 900 })
  expect(parseSchedule("2h")).toEqual({ intervalSeconds: 7200 })
  expect(parseSchedule("every 1 day")).toEqual({ intervalSeconds: 86400 })
  expect(parseSchedule("0 9 * * 1-5")).toMatchObject({ cronExpression: "0 9 * * 1-5" })
  expect(parseSchedule("sometimes")).toBeUndefined()
})

test("enabled extension skills appear as slash commands and run as commands", async () => {
  const { server, view, screen } = await dashboard({
    "GET /api/command": (_, url) => ({
      location: {
        directory: url.searchParams.get("location[directory]"),
        project: { id: "project", directory: "/srv/main" },
      },
      data: [],
    }),
    "GET /extension": () => [
      {
        enabled: true,
        manifest: { contributions: [{ type: "skill", id: "review", name: "Review", description: "Review code" }] },
      },
      {
        enabled: false,
        manifest: { contributions: [{ type: "skill", id: "hidden", name: "Hidden", description: "" }] },
      },
    ],
    "POST /api/session/ses_main/command": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_main" },
    }),
  })
  view.mockInput.pressKey("f")
  await screen("Reply to main task")
  await view.mockInput.typeText("/rev")
  const frame = await screen("/review - Skill · Review code")
  expect(frame).not.toContain("/hidden")
  view.mockInput.pressTab()
  await view.mockInput.typeText("src")
  view.mockInput.pressEnter()
  await screen("Reply sent.")
  expect(server.sent("/api/session/ses_main/command")[0]?.body).toMatchObject({ command: "review", arguments: "src" })
})

/** Starts a new session with Workspace set to a new git worktree, against the given worktree routes. */
async function worktreeLaunch(
  routes: (events: ReturnType<typeof globalEvents>, order: string[]) => Record<string, Route>,
) {
  const events = globalEvents()
  const order: string[] = []
  const app = await dashboard({
    "GET /global/event": events.route,
    "GET /api/agent": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [{ id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] }],
    }),
    "POST /api/session": async (request) => {
      order.push("session")
      const body = (await request.json()) as Record<string, unknown>
      return { data: { ...session(), id: body.id, location: body.location } }
    },
    ...routes(events, order),
  })
  const view = app.view
  view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  await view.mockInput.typeText("Try the refactor")
  // Directory, agent, model, then workspace; each Tab lays out before the next, as in a terminal.
  for (let step = 0; step < 4; step++) {
    view.mockInput.pressTab()
    await view.renderOnce()
  }
  await app.screen("New git worktree")
  view.mockInput.pressArrow("down")
  await app.screen("▶ New git worktree")
  view.mockInput.pressKey("s", { ctrl: true })
  const created = () => app.server.requests.find((item) => item.method === "POST" && item.path === "/api/session")
  return { ...app, order, created }
}

const worktreeName = async (request: Request) => ((await request.json()) as { name: string }).name

test("a new worktree session starts only after the server has checked the worktree out", async () => {
  const { screen, order, created } = await worktreeLaunch((events, order) => ({
    "POST /experimental/worktree": async (request) => {
      const name = await worktreeName(request)
      order.push("created")
      setTimeout(() => {
        order.push("ready")
        events.emit({ directory: `/srv/wt/${name}`, payload: { type: "worktree.ready", properties: { name } } })
      }, 200)
      return { name, branch: `turen/${name}`, directory: `/srv/wt/${name}` }
    },
  }))
  await screen("Preparing a new git worktree")
  await until(() => !!created())
  expect(order).toEqual(["created", "ready", "session"])
  expect(created()?.body).toMatchObject({
    location: { directory: expect.stringMatching(/^\/srv\/wt\/tui-[0-9a-f]{8}$/) },
  })
})

test("a worktree the server fails to prepare is reported, and the next try makes a new one", async () => {
  const names: string[] = []
  const { view, screen, created } = await worktreeLaunch((events) => ({
    "POST /experimental/worktree": async (request) => {
      const name = await worktreeName(request)
      names.push(name)
      setTimeout(() => {
        events.emit({
          directory: `/srv/wt/${name}`,
          payload: { type: "worktree.failed", properties: { message: "checkout failed" } },
        })
      }, 50)
      return { name, directory: `/srv/wt/${name}` }
    },
  }))
  await screen("could not prepare the worktree: checkout failed")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => names.length === 2)
  expect(names[1]).not.toBe(names[0])
  expect(created()).toBeUndefined()
})

test("Escape stops waiting for a worktree that never becomes ready and sends nothing else", async () => {
  let streamClosed = false
  const { view, screen, created, server } = await worktreeLaunch(() => ({
    "GET /global/event": () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`,
              ),
            )
          },
          cancel() {
            streamClosed = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    "POST /experimental/worktree": async (request) => {
      const name = await worktreeName(request)
      return { name, directory: `/srv/wt/${name}` }
    },
  }))
  await screen("Esc stops waiting")
  const started = Date.now()
  view.mockInput.pressEscape()
  await screen("Stopped waiting for the worktree")
  expect(Date.now() - started).toBeLessThan(1000)
  await until(() => streamClosed)
  expect(created()).toBeUndefined()
  expect(server.requests.filter((item) => item.method === "POST")).toHaveLength(1)
  expect(view.captureCharFrame()).toContain("Esc keep draft")
})

test("after an uncertain worktree request, a retry reuses the worktree it made", async () => {
  const names: string[] = []
  const { view, screen, created } = await worktreeLaunch(() => ({
    "POST /experimental/worktree": async (request) => {
      names.push(await worktreeName(request))
      return new Response("upstream reset", { status: 502 })
    },
    "GET /experimental/worktree": () => names.map((name) => `/srv/wt/${name}`),
    "GET /file": () => [
      { name: ".git", path: ".git", absolute: "/srv/wt/x/.git", type: "file", ignored: true },
      { name: "README.md", path: "README.md", absolute: "/srv/wt/x/README.md", type: "file", ignored: false },
    ],
  }))
  await screen("Server returned HTTP 502")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => !!created())
  expect(names).toHaveLength(1)
  expect(created()?.body).toMatchObject({ location: { directory: `/srv/wt/${names[0]}` } })
})

test("Tools lists the session agent's tools, MCP servers, and exclusions", async () => {
  const { server, screen, palette } = await dashboard({
    "GET /api/session": () => ({ data: [{ ...session(), model: { providerID: "openai", id: "gpt" } }], cursor: {} }),
    "GET /experimental/tool": () => ({
      agent: "build",
      providerID: "openai",
      modelID: "gpt",
      visible: [{ id: "bash", description: "Run a shell command", source: "builtin", parameters: {} }],
      mcpServers: [{ id: "github", status: "needs-auth", definitions: 0 }],
      exclusions: [{ id: "webfetch", reason: "disabled by agent" }],
    }),
  })
  await palette("Session tools")
  const frame = await screen("bash · builtin — Run a shell command")
  expect(frame).toContain("github · needs-auth")
  expect(frame).toContain("webfetch — disabled by agent")
  expect(server.sent("/experimental/tool")).toHaveLength(1)
})

test("Trace pages through the session's durable events", async () => {
  const { view, screen, palette } = await dashboard({
    "GET /api/session/ses_main/replay": (_, url) => ({
      data: [
        {
          id: url.searchParams.get("cursor") ? "evt_old" : "evt_new",
          type: url.searchParams.get("cursor") ? "session.next.prompted" : "session.next.step.ended",
          durable: { aggregateID: "ses_main", seq: url.searchParams.get("cursor") ? 1 : 2, version: 1 },
          data: { note: "hello" },
        },
      ],
      cursor: url.searchParams.get("cursor") ? {} : { previous: "older" },
    }),
  })
  await palette("Session trace")
  expect(await screen("#2 session.next.step.ended")).toContain('"note": "hello"')
  view.mockInput.pressKey("[")
  await screen("#1 session.next.prompted")
})

test("a message the agent already read is reported instead of silently removed", async () => {
  const { view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_first", "Too late")] }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => ({ data: false }),
  })
  view.mockInput.pressKey("u")
  await screen("Too late")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("already received that message")
  expect(view.captureCharFrame()).not.toContain("Reply to main task")
})
