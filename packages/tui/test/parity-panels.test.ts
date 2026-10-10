import { expect, test } from "bun:test"
import { assistant, dashboard, session } from "./support"

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
  await screen("Confirmation (type stop all)")
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
  await screen("Typing")
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
  expect(await screen("or Enter opens this folder")).not.toContain("src//")
  view.mockInput.pressEnter()
  await screen("1  export const main = 1")
  view.mockInput.pressArrow("left")
  await screen("or Enter opens this folder")
  view.mockInput.pressArrow("down")
  await screen("1  # Readme")
})

test("Tab moves the keyboard between a panel's list and its content, so the arrows scroll the content", async () => {
  const file = (name: string) => ({ name, path: name, absolute: `/srv/main/${name}`, type: "file", ignored: false })
  const { view, screen } = await dashboard({
    "GET /file": () => [file("README.md"), file("z.md")],
    "GET /file/content": (_, url) => ({
      type: "text",
      content:
        url.searchParams.get("path") === "z.md"
          ? "zed file"
          : Array.from({ length: 200 }, (_, row) => `row ${row}`).join("\n"),
    }),
  })
  view.mockInput.pressKey("e")
  expect(await screen("row 0")).toContain("Tab pane")
  view.mockInput.pressTab()
  for (let step = 0; step < 3; step++) view.mockInput.pressArrow("down")
  await view.renderOnce()
  const scrolled = view.captureCharFrame()
  expect(scrolled).not.toContain("row 0")
  expect(scrolled).toContain("row 3")
  expect(scrolled).not.toContain("zed file")
  view.mockInput.pressTab({ shift: true })
  view.mockInput.pressArrow("down")
  await screen("zed file")
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
