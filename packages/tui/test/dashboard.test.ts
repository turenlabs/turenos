import { afterEach, expect, spyOn, test } from "bun:test"
import { SessionListRenderable } from "../src/session-list"
import {
  InputRenderable,
  KeyEvent,
  RGBA,
  ScrollBoxRenderable,
  SelectRenderable,
  TextareaRenderable,
  TextRenderable,
  type Renderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import type { Session, Snapshot } from "../src/server"
import type {
  CommandsListOutput,
  PermissionsListOutput,
  QuestionsListOutput,
  SessionsTaskListOutput,
  SessionsGoalGetOutput,
} from "@turenlabs/client"
import { matchesKey, printableKey } from "../src/keys"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function waitForFrame(
  view: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await view.renderOnce()
    const frame = view.captureCharFrame()
    if (predicate(frame)) return frame
    // Renderer-idle can occur while HTTP is in flight; wait for those responses.
    await Bun.sleep(10)
  }
  throw new Error(`Expected screen did not appear:\n${view.captureCharFrame()}`)
}

/** Esc leaves an open reply editor for the dashboard shortcuts, keeping its draft. */
async function leaveComposer(view: Awaited<ReturnType<typeof createTestRenderer>>) {
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Typing"))
}

async function clickText(view: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await view.renderOnce()
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  await view.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
}

function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}

function fixture(
  options: {
    ptyStatus?: number
    loopStatus?: number
    runStatus?: number
    pages?: boolean
    providerStatus?: number
    providerDelay?: number
    noModels?: boolean
    agentStatus?: number
    agentDelay?: number
    agents?: Record<string, string[]>
    messageStatus?: number
    more?: boolean
    messageDelay?: number
    postDelay?: number
    authenticated?: boolean
    failPromptOnce?: boolean
    active?: boolean
    history?: boolean
    text?: string
    toolText?: string
    tasks?: SessionsTaskListOutput
    ownedError?: boolean
    commands?: CommandsListOutput["data"]
    failCommandOnce?: boolean
    variants?: Record<string, unknown>
    goal?: SessionsGoalGetOutput
    directory?: string
    schedule?: Snapshot["loops"][number]["schedule"]
    workingFolders?: string[]
    folderRevision?: number
  } = {},
) {
  const sessions: Session[] = [
    {
      id: "ses_running",
      projectID: "project",
      title: "Review the server",
      agent: "build",
      location: { directory: "/srv/project" },
      time: { created: 1, updated: 2 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]
  const reads: string[] = []
  const messageCursors: (string | null)[] = []
  const historical = new Map<string, Session>()
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const pending: { permissions: PermissionsListOutput; questions: QuestionsListOutput } = {
    permissions: [],
    questions: [],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (options.authenticated === false) return new Response(null, { status: 401 })
      if (url.pathname === "/api/fs/list")
        return Response.json({ location: { directory: url.searchParams.get("location[directory]") }, data: [] })
      if (url.pathname === "/global/storage" && options.workingFolders !== undefined) {
        if (request.method === "PUT") {
          const body = await request.json()
          if (body.expectedRevision !== (options.folderRevision ?? 1)) return new Response(null, { status: 409 })
          options.workingFolders = JSON.parse(body.value).directories
          options.folderRevision = (options.folderRevision ?? 1) + 1
        }
        const state = {
          scope: "desktop/store/working-folders",
          key: "open",
          value: JSON.stringify({ version: 1, directories: options.workingFolders }),
          revision: options.folderRevision ?? 1,
          timeCreated: 1,
          timeUpdated: 1,
        }
        return Response.json(request.method === "PUT" ? state : { state })
      }
      if (request.method === "POST") {
        const body: Record<string, unknown> =
          url.pathname.endsWith("/interrupt") ||
          url.pathname.endsWith("/reject") ||
          url.pathname.endsWith("/revert/clear")
            ? {}
            : await request.json()
        posts.push({ path: url.pathname, body })
        if (options.postDelay) await Bun.sleep(options.postDelay)
        if (url.pathname.endsWith("/revert/stage") || url.pathname.endsWith("/revert/clear")) {
          const index = sessions.findIndex((session) => session.id === url.pathname.split("/")[3])
          if (index < 0) return new Response(null, { status: 404 })
          const revert = url.pathname.endsWith("/stage") ? { messageID: String(body.messageID), files: [] } : undefined
          sessions[index] = { ...sessions[index]!, revert }
          return revert ? Response.json({ data: revert }) : new Response(null, { status: 204 })
        }
        if (options.failCommandOnce && url.pathname.endsWith("/command")) {
          options.failCommandOnce = false
          return new Response("Command acknowledgement lost", { status: 502 })
        }
        if (options.ownedError && url.pathname === "/api/session/ses_running/prompt")
          return Response.json(
            {
              _tag: "InvalidRequestError",
              kind: "session_task_owned",
              message: "Task-owned child Sessions reject direct mutation",
            },
            { status: 400 },
          )
        if (url.pathname.endsWith("/shell")) {
          return Response.json({
            data: { id: body.id, type: "shell", command: body.command, output: "", status: "running" },
          })
        }
        if (url.pathname.endsWith("/model")) {
          const index = sessions.findIndex((session) => session.id === url.pathname.split("/")[3])
          if (index >= 0) sessions[index] = { ...sessions[index]!, model: body.model as Session["model"] }
          return new Response(null, { status: 204 })
        }
        if (options.failPromptOnce && url.pathname.endsWith("/prompt")) {
          options.failPromptOnce = false
          return new Response("Admission response lost", { status: 502 })
        }
        if (url.pathname === "/api/session") {
          const session = {
            ...sessions[0]!,
            id: typeof body.id === "string" ? body.id : "",
            title: "New agent",
            agent: typeof body.agent === "string" ? body.agent : "build",
            model: body.model as Session["model"],
            location: body.location as Session["location"],
          }
          if (!sessions.some((item) => item.id === session.id)) sessions.unshift(session)
          return Response.json({ data: session })
        }
        if (
          url.pathname.includes("/permission/") ||
          url.pathname.includes("/question/") ||
          url.pathname.endsWith("/interrupt")
        )
          return new Response(null, { status: 204 })
        return Response.json({ data: { id: body.id, sessionID: url.pathname.split("/")[3] } })
      }
      reads.push(url.pathname)
      if (url.pathname.endsWith("/goal")) return Response.json({ data: options.goal ?? null })
      if (url.pathname === "/api/command") {
        const directory = url.searchParams.get("location[directory]") ?? "/srv/project"
        return Response.json({
          location: { directory, project: { id: "project", directory } },
          data: options.commands ?? [],
        })
      }
      if (url.pathname === "/provider") {
        if (options.providerDelay) await Bun.sleep(options.providerDelay)
        if (options.providerStatus) return new Response(null, { status: options.providerStatus })
        return Response.json({
          all: [
            {
              id: "test",
              name: "Test Provider",
              models: options.noModels
                ? {}
                : {
                    "org/model": {
                      id: "org/model",
                      providerID: "test",
                      name: "Catalog Model",
                      ...(options.variants ? { variants: options.variants } : {}),
                    },
                  },
            },
          ],
          connected: options.noModels ? [] : ["test"],
          default: {},
        })
      }
      if (url.pathname === "/provider/auth") return Response.json({})
      if (url.pathname === "/api/pty" && options.ptyStatus) return new Response(null, { status: options.ptyStatus })
      if (url.pathname === "/api/loop" && options.loopStatus) return new Response(null, { status: options.loopStatus })
      if (url.pathname.endsWith("/run") && options.runStatus) return new Response(null, { status: options.runStatus })
      if (url.pathname === "/api/agent" && options.agentStatus)
        return new Response(null, { status: options.agentStatus })
      if (url.pathname.endsWith("/message") && options.messageStatus)
        return new Response("Temporary message failure", { status: options.messageStatus })
      if (url.pathname.endsWith("/message") && options.messageDelay) await Bun.sleep(options.messageDelay)
      if (url.pathname === "/api/location")
        return Response.json({
          directory: options.directory ?? "/srv/project",
          project: { id: "project", directory: "/srv/project" },
        })
      if (url.pathname === "/api/session")
        return Response.json({
          data:
            url.searchParams.get("roots") === "true"
              ? [...sessions, ...historical.values()].filter((session) => !session.parentID && !session.time.archived)
              : sessions,
          cursor: options.more ? { next: "more-sessions" } : {},
        })
      if (/^\/api\/session\/ses_[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/")[3]!
        const session = sessions.find((item) => item.id === id) ?? historical.get(id)
        return session
          ? Response.json({ data: session })
          : Response.json(
              { _tag: "SessionNotFoundError", message: "Session not found", sessionID: id },
              { status: 404 },
            )
      }
      if (url.pathname === "/api/session/active")
        return Response.json({ data: options.active === false ? {} : { ses_running: { type: "running" } } })
      if (url.pathname === "/api/pty")
        return Response.json({
          location: { directory: url.searchParams.get("location[directory]") ?? "/srv/project" },
          data: [
            {
              id: "pty_shell",
              title: "Build worker",
              command: "sh",
              args: ["build.sh"],
              cwd: "/srv/other",
              status: "running",
              pid: 4242,
            },
          ],
        })
      if (url.pathname === "/api/loop")
        return Response.json([
          {
            id: "loop_check",
            name: "Nightly checks",
            status: "active",
            prompt: "Review overnight changes",
            schedule: options.schedule ?? { type: "interval", seconds: 3600, timezone: "UTC" },
            location: { directory: "/srv/project" },
          },
        ])
      if (url.pathname === "/api/loop/loop_check/run")
        return Response.json([
          {
            id: "run_check",
            loopID: "loop_check",
            status: "succeeded",
            time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
          },
          { id: "run_partial", loopID: "loop_check", status: "failed" },
        ])
      if (url.pathname === "/api/agent") {
        if (options.agentDelay) await Bun.sleep(options.agentDelay)
        const directory = url.searchParams.get("location[directory]") ?? "/srv/project"
        return Response.json({
          location: { directory },
          data: options.agents?.[directory]?.map((id) => ({
            id,
            mode: "primary",
            hidden: false,
          })) ?? [
            { id: "build", mode: "primary", hidden: false, description: "Build agent" },
            { id: "explore", mode: "subagent", hidden: false },
          ],
        })
      }
      if (url.pathname.endsWith("/message")) {
        const cursor = url.searchParams.get("cursor")
        messageCursors.push(cursor)
        if (cursor && url.searchParams.has("order")) return new Response(null, { status: 400 })
        if (options.pages && cursor === "older")
          return Response.json({
            data: [{ id: "msg_old", type: "user", text: "The original task on the older page.", time: { created: 0 } }],
            cursor: { next: "empty-older", previous: "newer" },
          })
        if (options.pages && cursor?.startsWith("empty")) return Response.json({ data: [], cursor: {} })
        return Response.json({
          data: [
            {
              id: "msg_output",
              type: "assistant",
              agent: "build",
              model: { providerID: "test", id: "local" },
              time: { created: 1 },
              content: [
                {
                  id: "part_text",
                  type: "text",
                  text: options.text ?? "Inspecting the server and its running processes.",
                },
                ...(options.toolText
                  ? [
                      {
                        id: "part_result",
                        type: "tool",
                        name: "wait_agents",
                        time: { created: 1 },
                        state: { status: "completed", content: [{ type: "text", text: options.toolText }] },
                      },
                    ]
                  : []),
              ],
            },
            ...(options.history
              ? [
                  {
                    id: "msg_earlier",
                    type: "user",
                    text: "Earlier task that belongs in history.",
                    time: { created: 0 },
                  },
                ]
              : []),
          ],
          cursor: options.pages ? { next: "older", previous: "empty-newer" } : {},
        })
      }
      if (url.pathname.endsWith("/task")) return Response.json(options.tasks ?? { data: [], active: [], cursor: {} })
      if (url.pathname.includes("/permission"))
        return Response.json({
          data: pending.permissions.filter((request) => request.sessionID === url.pathname.split("/")[3]),
        })
      if (url.pathname.includes("/question"))
        return Response.json({
          data: pending.questions.filter((request) => request.sessionID === url.pathname.split("/")[3]),
        })
      if (url.pathname.includes("/input")) return Response.json({ data: [] })
      return new Response(`Unknown fixture route: ${url.pathname}`, { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  return { server, connection, posts, pending, sessions, historical, reads, messageCursors }
}

test("shortcut matching requires exact modifiers and normalizes Enter aliases", () => {
  const key = (name: string, modifiers: Partial<KeyEvent> = {}) =>
    new KeyEvent({
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
  for (const name of ["enter", "return", "kpenter", "linefeed"]) {
    expect(matchesKey(key(name), "enter")).toBe(true)
    expect(matchesKey(key(name, { ctrl: true }), "enter", { ctrl: true })).toBe(true)
  }
  for (const modifier of ["shift", "meta", "option", "super", "hyper"] as const) {
    expect(matchesKey(key("s", { ctrl: true, [modifier]: true }), "s", { ctrl: true })).toBe(false)
    expect(matchesKey(key("f4", { [modifier]: true }), "f4")).toBe(false)
  }
  expect(matchesKey(key("left", { meta: true, option: true }), "left", { meta: true })).toBe(true)
  expect(matchesKey(key("s", { ctrl: true, eventType: "release" }), "s", { ctrl: true })).toBe(false)
  expect(printableKey(key("/", { shift: true, sequence: "?" }))).toBe("?")
  expect(printableKey(key("[", { shift: true, sequence: "{" }))).toBe("{")
  expect(printableKey(key("?", { super: true }))).toBe("")
})

test("extra modifiers do not quit, open commands, create drafts, toggle sidebar, or switch sessions", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second session" })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const list = descendants(view.renderer.root).find((node) => node instanceof SessionListRenderable)!
  for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
    for (const name of ["c", "n", "k", "p", "b"]) view.mockInput.pressKey(name, { ctrl: true, [modifier]: true })
    expect(view.renderer.isDestroyed).toBe(false)
    expect(view.renderer.currentFocusedRenderable).toBe(list)
  }
  for (const modifier of ["ctrl", "shift", "super", "hyper"] as const) {
    view.mockInput.pressArrow("right", { meta: true, [modifier]: true })
    view.mockInput.pressArrow("left", { meta: true, [modifier]: true })
    expect(list.getSelectedIndex()).toBe(0)
  }
  for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
    for (const name of ["q", "n", "m", "b", "2"]) view.mockInput.pressKey(name, { [modifier]: true })
    expect(view.renderer.isDestroyed).toBe(false)
    expect(view.renderer.currentFocusedRenderable).toBe(list)
  }
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Switch session")
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  expect(server.posts).toHaveLength(0)
})

for (const shortcut of ["n", "f"] as const) {
  test(`${shortcut} preserves native editing and keeps its draft through Escape then hopping; only F4 discards`, async () => {
    const server = fixture()
    server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second session" })
    const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey(shortcut)
    await view.mockInput.typeText("alpha beta")
    const editor = view.renderer.currentFocusedEditor!
    expect(editor).toBeInstanceOf(TextareaRenderable)
    view.mockInput.pressArrow("left", { meta: true })
    expect(editor.cursorOffset).toBeGreaterThan(0)
    expect(editor.cursorOffset).toBeLessThan(10)
    view.mockInput.pressArrow("right", { meta: true })
    expect(editor.cursorOffset).toBe(10)
    view.mockInput.pressKey("a", { ctrl: true })
    expect(editor.cursorOffset).toBe(0)
    view.mockInput.pressKey("d", { ctrl: true })
    expect(editor.plainText).toBe("lpha beta")
    view.mockInput.pressArrow("right")
    view.mockInput.pressArrow("right")
    // The launch form's editor keeps Ctrl+K as delete-to-line-end; the reply editor gives it to the session picker.
    if (shortcut === "n") view.mockInput.pressKey("k", { ctrl: true })
    else for (let step = 0; step < 7; step++) view.mockInput.pressKey("DELETE")
    expect(editor.plainText).toBe("lp")
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
      view.mockInput.pressKey("s", { ctrl: true, [modifier]: true })
      view.mockInput.pressEnter({ ctrl: true, [modifier]: true })
      view.mockInput.pressKey("l", { ctrl: true, [modifier]: true })
      view.mockInput.pressKey("t", { ctrl: true, [modifier]: true })
    }
    for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const) {
      view.mockInput.pressKey("F4", { [modifier]: true })
      view.mockInput.pressEscape({ [modifier]: true })
    }
    for (const modifier of ["ctrl", "meta", "super", "hyper"] as const) view.mockInput.pressTab({ [modifier]: true })
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("F4 discard")
    if (shortcut === "f") expect(view.captureCharFrame()).toContain("Steer · agent is working")
    expect(server.posts).toHaveLength(0)
    view.mockInput.pressArrow("left")
    expect(editor.cursorOffset).toBe(1)
    view.mockInput.pressEscape()
    view.mockInput.pressArrow("right", { meta: true })
    await waitForFrame(view, (frame) => frame.includes("Second session"))
    view.mockInput.pressArrow("left", { meta: true })
    view.mockInput.pressKey(shortcut)
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("lp")
    expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe(1)
    await view.mockInput.typeText("X")
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("lXp")
    view.mockInput.pressKey("F4")
    await waitForFrame(view, (frame) => frame.includes("Local draft discarded"))
    // Discarding a reply leaves its editor open and empty; the launch editor closes.
    if (shortcut === "f") await leaveComposer(view)
    view.mockInput.pressKey(shortcut)
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("")
    expect(server.posts).toHaveLength(0)
  })
}

test("Ctrl+K and Alt arrows keep native editing in blocked dialogs and inline search", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second session" })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  for (const context of ["kill", "search"]) {
    if (context === "kill") {
      view.mockInput.pressKey("p", { ctrl: true })
      await view.mockInput.typeText("kill")
      view.mockInput.pressEnter()
      await waitForFrame(view, (frame) => frame.includes("Confirmation (type kill)"))
    }
    if (context === "search") {
      view.mockInput.pressKey("2")
      view.mockInput.pressKey("/")
    }
    await view.mockInput.typeText("alpha beta")
    const input = view.renderer.currentFocusedEditor!
    view.mockInput.pressArrow("left", { meta: true })
    expect(input.cursorOffset).toBeGreaterThan(0)
    expect(input.cursorOffset).toBeLessThan(10)
    view.mockInput.pressArrow("right", { meta: true })
    expect(input.cursorOffset).toBe(10)
    view.mockInput.pressKey("a", { ctrl: true })
    view.mockInput.pressKey("k", { ctrl: true })
    expect(input.plainText).toBe("")
    expect(view.renderer.currentFocusedEditor).toBe(input)
    view.mockInput.pressEscape()
  }
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  expect(server.posts).toHaveLength(0)
})

test("model picker repairs loading and empty selections, keeps Ctrl+A editing, and uses exact F2 setup", async () => {
  const server = fixture({ providerDelay: 50 })
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("m")
  view.mockInput.pressArrow("down")
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  const select = descendants(view.renderer.root)
    .filter((node) => node instanceof SelectRenderable)
    .at(-1)!
  expect(select.getSelectedIndex()).toBe(0)
  await view.mockInput.typeText("nothing-matches")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const input = view.renderer.currentFocusedEditor!
  view.mockInput.pressKey("a", { ctrl: true })
  expect(input.cursorOffset).toBe(0)
  view.mockInput.pressKey("k", { ctrl: true })
  expect(input.plainText).toBe("")
  expect(select.getSelectedIndex()).toBe(0)
  for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const) {
    view.mockInput.pressKey("F2", { [modifier]: true })
    view.mockInput.pressEnter({ [modifier]: true })
    expect(view.renderer.currentFocusedEditor).toBe(input)
  }
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("F2")
  await waitForFrame(view, (frame) => frame.includes("Connect a provider"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  view.mockInput.pressKey("\x1b[57414u")
  await waitForFrame(view, (frame) => frame.includes("Model selected for"))
  expect(server.posts).toHaveLength(1)
})

for (const picker of ["k", "p"] as const) {
  test(`${picker} picker recovers from empty results and shows a selectable first row`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey(picker, { ctrl: true })
    await view.mockInput.typeText("nothing-matches")
    view.mockInput.pressArrow("down")
    view.mockInput.pressEnter()
    view.mockInput.pressKey("u", { ctrl: true })
    if (picker === "p") {
      const select = descendants(view.renderer.root)
        .filter((node) => node instanceof SelectRenderable)
        .at(-1)!
      expect(select.getSelectedIndex()).toBe(0)
      await view.mockInput.typeText("Switch session")
      expect(select.options[select.getSelectedIndex()]?.name).toBe("Switch session  · Jump to a session (Ctrl+K)")
    }
    if (picker === "k") {
      await view.renderOnce()
      expect(view.captureCharFrame()).toContain("▶ * Review the server")
      expect(view.renderer.currentFocusedEditor?.plainText).toBe("")
    }
    view.mockInput.pressKey("LINEFEED")
    await waitForFrame(view, (frame) =>
      picker === "p"
        ? frame.includes("Switch session") && !frame.includes("Commands")
        : !frame.includes("Switch session"),
    )
    expect(server.posts).toHaveLength(0)
  })
}

for (const shortcut of ["n", "f"] as const) {
  for (const [name, enter] of [
    ["Return", "\r"],
    ["keypad Enter", "\x1b[57414u"],
    ["linefeed", "\n"],
  ] as const) {
    test(`${shortcut}: plain ${name} sends the focused composer without appending a newline`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      view.mockInput.pressKey(shortcut)
      await view.mockInput.typeText("Send this exact text")
      const editor = view.renderer.currentFocusedEditor!
      expect(editor).toBeInstanceOf(TextareaRenderable)
      expect(editor.cursorOffset).toBe(editor.plainText.length)
      await view.renderOnce()
      expect(view.captureCharFrame()).toContain("Enter send")
      expect(view.captureCharFrame()).not.toContain("Ctrl+S Send")
      await view.mockInput.pressKeys([enter])
      await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
      expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
      expect(server.posts.filter((post) => post.path.endsWith("/prompt"))).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ prompt: { text: "Send this exact text" } }) }),
      ])
    })
  }

  for (const [name, shift, alt, send] of [
    ["Return", "\x1b[13;2u", "\x1b[13;3u", "\x1b[13;5u"],
    ["keypad Enter", "\x1b[57414;2u", "\x1b[57414;3u", "\x1b[57414;5u"],
  ] as const) {
    test(`${shortcut}: Shift/Alt+${name} insert newlines and explicit send preserves the multiline text`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      view.mockInput.pressKey(shortcut)
      await view.mockInput.typeText("first")
      await view.mockInput.pressKeys([shift])
      expect(view.renderer.currentFocusedEditor?.plainText).toBe("first\n")
      await view.mockInput.typeText("second")
      await view.mockInput.pressKeys([alt])
      expect(view.renderer.currentFocusedEditor?.plainText).toBe("first\nsecond\n")
      await view.mockInput.typeText("third")
      await view.renderOnce()
      expect(server.posts).toHaveLength(0)
      await view.mockInput.pressKeys([send])
      await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
      expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
      expect(server.posts.at(-1)?.body).toMatchObject({ prompt: { text: "first\nsecond\nthird" } })
    })
  }

  test(`${shortcut}: Enter aliases on empty or whitespace-only text never POST and leave the draft editable`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    await leaveComposer(view)
    view.mockInput.pressKey(shortcut)
    const editor = view.renderer.currentFocusedEditor!
    for (const text of ["", "   "]) {
      await view.mockInput.typeText(text)
      for (const enter of ["\r", "\n", "\x1b[57414u"]) {
        await view.mockInput.pressKeys([enter])
        await waitForFrame(view, (frame) =>
          frame.includes(shortcut === "n" ? "Enter a task for the agent." : "Enter a message between"),
        )
        expect(editor.plainText).toBe(text)
        expect(view.renderer.currentFocusedEditor).toBe(editor)
        expect(server.posts).toHaveLength(0)
      }
    }
    await view.mockInput.typeText("Still editable")
    expect(editor.plainText).toBe("   Still editable")
  })

  test(`${shortcut}: multiline bracketed paste including a trailing newline never sends until Enter`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 60, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    await leaveComposer(view)
    view.mockInput.pressKey(shortcut)
    const editor = view.renderer.currentFocusedEditor!
    const text = "first\nsecond\npasted third\npasted fourth\n"
    await view.mockInput.pasteBracketedText(text)
    await app.refresh()
    await view.renderOnce()
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    expect(editor.plainText).toBe(text)
    expect(editor.cursorOffset).toBe(text.length)
    expect(view.captureCharFrame()).toContain("pasted fourth")
    expect(server.posts).toHaveLength(0)
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
    expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
    expect(server.posts.at(-1)?.body).toMatchObject({ prompt: { text } })
  })

  for (const width of [60, 120]) {
    test(`${shortcut}: ${shortcut === "n" ? "the Send button submits on left click" : "the reply editor has no Send button and sends on Enter"} at ${width} columns`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width, height: 24 })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      // A narrow terminal starts with the reply editor already open.
      if (width === 60) await leaveComposer(view)
      view.mockInput.pressKey(shortcut)
      await view.mockInput.typeText("Send by mouse")
      await view.renderOnce()
      const button = descendants(view.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === "[ Send (Enter) ]",
      )
      if (shortcut === "f") {
        expect(button).toBeUndefined()
        expect(view.captureCharFrame()).not.toContain("Your message")
        const row = view
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes("Send by mouse"))
        await view.mockMouse.click(4, row, 2)
        await view.renderOnce()
        expect(server.posts).toHaveLength(0)
        view.mockInput.pressEnter()
      }
      if (shortcut === "n") {
        expect(button).toBeDefined()
        await view.mockMouse.click(button!.x + 2, button!.y, 2)
        await view.renderOnce()
        expect(server.posts).toHaveLength(0)
        await clickText(view, "[ Send (Enter) ]")
      }
      await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
      expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
      expect(server.posts.at(-1)?.body).toMatchObject({ prompt: { text: "Send by mouse" } })
    })
  }
}

test("launch settings ignore plain Enter aliases while Ctrl+S still sends the task", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Send only from the task or an explicit control")
  const editor = view.renderer.currentFocusedEditor!
  for (const setting of ["directory", "agent", "model"]) {
    view.mockInput.pressTab()
    const field = view.renderer.currentFocusedRenderable!
    expect(field).not.toBe(editor)
    if (setting === "directory") expect(view.renderer.currentFocusedEditor?.plainText).toBe("/srv/project")
    if (setting === "agent") {
      expect(field).toBeInstanceOf(SelectRenderable)
      await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
      view.mockInput.pressArrow("down")
    }
    if (setting === "model") await view.mockInput.typeText("test/local")
    for (const enter of ["\r", "\n", "\x1b[57414u"]) {
      await view.mockInput.pressKeys([enter])
      await view.renderOnce()
      expect(view.renderer.currentFocusedRenderable).toBe(field)
      expect(editor.plainText).toBe("Send only from the task or an explicit control")
      expect(server.posts).toHaveLength(0)
    }
  }
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[0]?.body).toMatchObject({
    agent: "build",
    model: { providerID: "test", id: "local" },
    location: { directory: "/srv/project" },
  })
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Send only from the task or an explicit control" } })
})

test("Enter aliases focus list activity, accept inline search, and open exact IDs", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    const list = view.renderer.currentFocusedRenderable
    expect(list).toBeInstanceOf(SessionListRenderable)
    await view.mockInput.pressKeys([enter])
    expect(view.renderer.currentFocusedRenderable).not.toBe(list)
    await leaveComposer(view)
    view.mockInput.pressTab({ shift: true })
    expect(view.renderer.currentFocusedRenderable === list).toBe(true)
    view.mockInput.pressKey("2")
    view.mockInput.pressKey("/")
    await view.mockInput.typeText("worker")
    await view.mockInput.pressKeys([enter])
    expect(view.renderer.currentFocusedEditor).toBeNull()
    view.mockInput.pressKey("k", { ctrl: true })
    view.mockInput.pressKey("o", { ctrl: true })
    await view.mockInput.typeText("ses_running")
    await view.mockInput.pressKeys([enter])
    await waitForFrame(view, (frame) => !frame.includes("Open session by ID"))
    await leaveComposer(view)
    view.mockInput.pressTab()
  }
  expect(server.posts).toHaveLength(0)
})

for (const [width, height] of [
  [60, 24],
  [120, 24],
  [180, 50],
] as const) {
  test(`Ctrl+N shows the anvil and wordmark and immediately focuses the task at ${width}×${height} without POST`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width, height, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey("n", { ctrl: true })
    const frame = await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
    const logo = descendants(view.renderer.root).find((node) => node.id === "turen-logo") as TextRenderable
    expect(logo).toBeDefined()
    expect(logo.height).toBe(height >= 32 ? 9 : 4)
    const spans = view
      .captureSpans()
      .lines.slice(logo.y, logo.y + logo.height)
      .flatMap((line) => line.spans)
    // The desktop mark's colors: the cream and blue wordmark beside the anvil's cream face and blue water.
    const colors = spans.flatMap((span) => [span.fg, span.bg])
    for (const hex of ["#fbf8f0", "#c8daf7", "#f3efe3", "#4a7fd4"]) expect(colors).toContainEqual(RGBA.fromHex(hex))
    expect(frame).toContain("Directory: /srv/project")
    expect(frame).toContain("Tab: folder")
    expect(frame).toContain("[ Send (Enter) ]")
    const editor = view.renderer.currentFocusedEditor!
    expect(editor).toBeDefined()
    expect(editor.plainText).toBe("")
    expect(editor.height).toBeGreaterThanOrEqual(3)
    await view.mockInput.pasteBracketedText("Ready to work\nSecond visible row\nThird visible row")
    await view.renderOnce()
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    expect(editor.plainText).toBe("Ready to work\nSecond visible row\nThird visible row")
    for (const [nextWidth, nextHeight] of [
      [60, 24],
      [180, 50],
      [width, height],
    ] as const) {
      view.resize(nextWidth, nextHeight)
      await view.renderOnce()
      const resized = view.captureCharFrame()
      expect(logo.height).toBe(nextHeight >= 32 ? 9 : 4)
      expect(
        resized
          .split("\n")
          .slice(logo.y, logo.y + logo.height)
          .map((line) => line.slice(logo.x, logo.x + logo.width)),
      ).toEqual(logo.plainText.split("\n"))
      for (const row of editor.plainText.split("\n")) expect(resized).toContain(row)
      expect(resized).toContain("[ Send (Enter) ]")
      expect(editor.height).toBeGreaterThanOrEqual(3)
      expect(view.renderer.currentFocusedEditor).toBe(editor)
    }
    expect(server.posts).toHaveLength(0)
  })
}

for (const form of ["launch", "finder"] as const) {
  test(`${form} releases resize callbacks after closing and tolerates a stale callback`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 120, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    const baseline = view.renderer.listeners("resize")
    for (let round = 0; round < 3; round++) {
      view.mockInput.pressKey(form === "launch" ? "n" : "k", { ctrl: true })
      await waitForFrame(view, (frame) =>
        frame.includes(form === "launch" ? "What would you like to do?" : "Switch session"),
      )
      const callbacks = view.renderer.listeners("resize").filter((listener) => !baseline.includes(listener))
      expect(callbacks).toHaveLength(1)
      view.mockInput.pressEscape()
      await waitForFrame(
        view,
        (frame) => !frame.includes(form === "launch" ? "What would you like to do?" : "Switch session"),
      )
      for (const callback of callbacks) expect(() => callback()).not.toThrow()
      expect(view.renderer.listeners("resize")).toEqual(baseline)
      view.resize(round % 2 ? 120 : 160, round % 2 ? 36 : 48)
      await view.renderOnce()
      expect(view.captureCharFrame()).not.toContain("TextBuffer is destroyed")
    }
    expect(server.posts).toEqual([])
  })
}

test("Ctrl+N deliberately opens New session from a reply or switcher while preserving drafts", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Saved reply")
  view.mockInput.pressKey("n", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("Saved launch")
  view.mockInput.pressEscape()
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressKey("n", { ctrl: true })
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Saved launch")
  view.mockInput.pressEscape()
  view.mockInput.pressKey("f")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Saved reply")
  expect(server.posts).toHaveLength(0)
})

test("CSI-u shifted punctuation uses delivered text, with essentials-first help and a fixed scroll hint", async () => {
  const server = fixture({ pages: true })
  const view = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("[ Older"))
  const cursors = server.messageCursors.length
  view.mockInput.pressKey("\x1b[91:123;2;123u")
  await view.renderOnce()
  expect(server.messageCursors).toHaveLength(cursors)
  view.mockInput.pressKey("\x1b[47:63;2;63u")
  const help = await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  expect(help).toContain("ESSENTIALS")
  expect(help).toMatch(/F4\s+discard local draft/)
  expect(help).toContain("PgUp/PgDn scroll · Esc close")
  view.mockInput.pressKey("\x1b[6~")
  const scrolled = await waitForFrame(view, (frame) => !frame.includes("ESSENTIALS"))
  expect(scrolled).toContain("PgUp/PgDn scroll · Esc close")
  view.mockInput.pressKey("\x1b[5~")
  await waitForFrame(view, (frame) => frame.includes("ESSENTIALS"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
})

test("b, Ctrl+B, and palette sidebar/quit actions work without stealing editor input", async () => {
  const server = fixture({ active: false })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("b")
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("1 Ses")
  view.mockInput.pressKey("b", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("1 Ses")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("sidebar")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Toggle sidebar  · Show or hide the list (b or Ctrl+B)")
  view.mockInput.pressEnter()
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("1 Ses")
  // Hiding the sidebar hands focus to the transcript, whose reply editor opens by itself.
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("ab")
  view.mockInput.pressKey("b", { ctrl: true })
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe(1)
  view.mockInput.pressEscape()
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("quit")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Quit dashboard  · Repeat if work is unsent (q or Ctrl+C)")
  view.mockInput.pressEnter()
  expect(view.renderer.isDestroyed).toBe(false)
  await waitForFrame(view, (frame) => frame.includes("Unsent drafts"))
  view.mockInput.pressKey("q")
  expect(view.renderer.isDestroyed).toBe(true)
  expect(server.posts).toHaveLength(0)
})

test("kill delegates the session and task-tree interruption to the server after typed confirmation", async () => {
  const server = fixture({
    tasks: {
      data: [],
      active: [
        {
          id: "tsk_child",
          rootSessionID: "ses_running",
          parentSessionID: "ses_running",
          childSessionID: "ses_child",
          agent: "explore",
          description: "Explore the repository",
          depth: 1,
          status: "running",
          revision: 3,
          time: { created: 1, updated: 1 },
        },
      ],
      cursor: {},
    },
  })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("kill")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Kill session")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Confirmation (type kill)"))
  expect(server.posts).toHaveLength(0)
  await view.mockInput.typeText("kill")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Session killed."))
  expect(server.posts.map((post) => post.path)).toEqual(["/api/session/ses_running/interrupt"])
})

test.each([60, 120])("a running session shows x Stop in the action row at %i columns", async (width) => {
  const running = fixture()
  const view = await createTestRenderer({ width, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, running.connection, running.server.url.href).ready
  // A narrow terminal starts typing, which hides the action row until Esc.
  if (width === 60) await leaveComposer(view)
  await waitForFrame(view, (frame) => frame.includes("x Stop"))
  const idle = fixture({ active: false })
  const quiet = await createTestRenderer({ width, height: 36, kittyKeyboard: true })
  cleanup.push(() => quiet.renderer.destroy())
  await mountDashboard(quiet.renderer, idle.connection, idle.server.url.href).ready
  await waitForFrame(quiet, (frame) => !frame.includes("Connecting to the server"))
  expect(quiet.captureCharFrame()).not.toContain("x Stop")
})

test("stopping a session is discoverable from help, the palette and the slash list", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("x Stop"))
  view.mockInput.pressKey("?")
  const help = await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  expect(help).toMatch(/Esc Esc\s+stops the running turn/)
  expect(help).toMatch(/x · \/stop\s+stops it/)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("stop")
  const palette = await waitForFrame(view, (frame) => frame.includes("Stop session"))
  expect(palette).toContain("Stop all agents")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Session interrupted."))
  expect(server.posts.map((post) => post.path)).toEqual(["/api/session/ses_running/interrupt"])
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("stop all")
  await waitForFrame(view, (frame) => frame.includes("Stop all agents"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Confirmation (type stop all)"))
  expect(server.posts).toHaveLength(1)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Confirmation (type stop all)"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("/stop")
  const stop = await waitForFrame(view, (frame) => frame.includes("/stop - "))
  expect(stop).toMatch(/\/stop - Stop this session/)
  for (let i = 0; i < 4; i++) view.mockInput.pressBackspace()
  await view.mockInput.typeText("kill")
  const kill = await waitForFrame(view, (frame) => frame.includes("/kill - "))
  expect(kill).toMatch(/\/kill - Stop this session/)
})

test("permission submission defaults to Reject and extra modifiers cannot confirm it", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p")
  const choice = view.renderer.currentFocusedRenderable as SelectRenderable
  expect(choice.options[choice.getSelectedIndex()]?.name).toBe("1 Reject")
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(view.renderer.currentFocusedRenderable).toBe(choice)
    expect(view.captureCharFrame()).toContain("Ctrl+S confirms Reject")
    expect(server.posts).toHaveLength(0)
  }
  for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
    view.mockInput.pressKey("s", { ctrl: true, [modifier]: true })
    view.mockInput.pressEnter({ ctrl: true, [modifier]: true })
  }
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Permission rejected."))
  expect(server.posts[0]?.body).toEqual({ reply: "reject" })
})

test("dashboard renders server inventory, global terminal PID, and responsive layout", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  expect(view.captureCharFrame()).toContain("TurenOS")
  expect(view.captureCharFrame()).toContain("* Review the server")
  expect(view.captureCharFrame()).toContain("Inspecting the server")
  view.mockInput.pressKey("2")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("PID 4242")
  expect(view.captureCharFrame()).toContain("/srv/other")
  view.resize(70, 28)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Build worker")
  expect(view.captureCharFrame()).toContain("Ctrl+P")
})

test("model picker searches connected models and switches only the captured session", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  expect(await waitForFrame(view, (frame) => frame.includes("Models m"))).toContain("Models m")
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  await view.mockInput.typeText("org/model")
  server.sessions.unshift({ ...server.sessions[0]!, id: "ses_another", title: "Another recipient" })
  await app.refresh()
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Model selected for Review the server"))
  expect(server.posts).toEqual([
    { path: "/api/session/ses_running/model", body: { model: { providerID: "test", id: "org/model" } } },
  ])
})

test("draft model selection preserves task, mid-text cursor, and directory without admitting work", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep my unsent task")
  view.mockInput.pressArrow("left", { meta: true })
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Keep my unsent ".length)
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  expect(view.captureCharFrame()).toContain("For this launch draft")
  await view.mockInput.typeText("org/model")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Keep my unsent task") && frame.includes("test/org/model"))
  expect(server.posts).toHaveLength(0)
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Keep my unsent ".length)
  await view.mockInput.typeText("new ")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep my unsent new task")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[0]?.body).toMatchObject({
    location: { directory: "/srv/project" },
    model: { providerID: "test", id: "org/model" },
  })
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Keep my unsent new task" } })
})

test("header Models targets an open draft, and Escape restores its mid-text cursor", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Header draft")
  view.mockInput.pressArrow("left", { meta: true })
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Header ".length)
  await clickText(view, "Models")
  await waitForFrame(view, (frame) => frame.includes("For this launch draft"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Header draft"))
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Header ".length)
  await view.mockInput.typeText("saved ")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Header saved draft")
  expect(server.posts).toHaveLength(0)
})

test("navigating away from the draft model picker does not reopen the draft over another session", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_next", title: "Next session" })
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Preserved draft")
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Preserved draft"))
  view.mockInput.pressEscape()
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Next session") && !frame.includes("Choose model"))
  expect(view.captureCharFrame()).not.toContain("What would you like to do?")
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Preserved draft"))
  expect(server.posts).toHaveLength(0)
})

test("catalog failure is isolated from session readiness and can be retried", async () => {
  const options = { providerStatus: 404 as number | undefined }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("Cannot load models"))
  expect(view.captureCharFrame()).not.toContain("Disconnected")
  options.providerStatus = undefined
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Choose model"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(server.posts).toHaveLength(0)
})

test("an empty catalog leads to provider setup and returns without submitting at 60 columns", async () => {
  const server = fixture({ noModels: true })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("No connected models"))
  view.mockInput.pressKey("F2")
  await waitForFrame(view, (frame) => frame.includes("Connect a provider"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Choose model"))
  expect(server.posts).toHaveLength(0)
})

test("late catalog replies cannot replace a closed picker or mutate a session", async () => {
  const server = fixture({ providerDelay: 100 })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("Loading models"))
  view.mockInput.pressEscape()
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Not a model search")
  await Bun.sleep(150)
  await waitForFrame(view, (frame) => frame.includes("Not a model search"))
  expect(view.captureCharFrame()).not.toContain("Catalog Model")
  expect(server.posts).toHaveLength(0)
})

test("submitted launch locks model selection while preserving exact retry fields", async () => {
  const server = fixture({ failPromptOnce: true })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("One admission")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("original submission is locked"))
  expect(server.reads).not.toContain("/provider")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
  expect(server.posts[2]).toEqual(server.posts[1])
})

test("keyboard launch chooses a primary agent and admits the typed task only once", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("Inspect server processes")
  view.mockInput.pressTab()
  view.mockInput.pressTab()
  await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
  view.mockInput.pressArrow("down")
  view.mockInput.pressTab()
  await view.mockInput.typeText("test/local")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Inspect server processes")
  view.mockInput.pressEnter({ ctrl: true })
  view.mockInput.pressEnter({ ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
  expect(server.posts[0]?.body).toMatchObject({
    agent: "build",
    model: { providerID: "test", id: "local" },
    location: { directory: "/srv/project" },
  })
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Inspect server processes" } })
})

test("filter, palette, and disconnected stale state remain keyboard operable", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 110, height: 32, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("missing")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("No matching loaded sessions"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Commands")
  view.mockInput.pressEscape()
  await app.refresh()
  await server.server.stop(true)
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Disconnected")
  expect(view.captureCharFrame()).toContain("saved data")
})

for (const [schedule, text] of [
  [{ type: "interval", seconds: 3600, timezone: "UTC" }, "Every 1h"],
  [
    { type: "cron", seconds: 3600, expression: "0 2 * * *", timezone: "America/New_York" },
    "Cron 0 2 * * * (America/New_York)",
  ],
] as const) {
  test(`${schedule.type} automation shows its schedule in sidebar and details after loading run history`, async () => {
    const server = fixture({ schedule })
    const view = await createTestRenderer({ width: 110, height: 38 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    view.mockInput.pressKey("3")
    const frame = await waitForFrame(view, (frame) => frame.includes("RECENT RUNS"))
    expect(frame).toContain(text)
    expect(frame).not.toContain(schedule.type === "cron" ? "Every 1h" : "Cron")
    const list = descendants(view.renderer.root).find((node) => node instanceof SessionListRenderable)
    expect(list?.options[0]?.description).toBe(`${text} · /srv/project`)
    expect(frame).toContain("Review overnight changes")
    expect(frame).toMatch(/succeeded · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(frame).toContain("failed · run_partial")
    expect(frame).not.toContain("[object Object]")
  })
}

test("small terminals focus the task immediately and support portable Ctrl+S submission", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("Inspect active workers")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Inspect active workers")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Inspect active workers" } })
})

test("a narrow terminal starts a reply, empty Up recalls the user prompt, and Ctrl+C keeps the draft before quitting", async () => {
  const server = fixture({ history: true, active: false })
  const view = await createTestRenderer({ width: 70, height: 24, exitOnCtrlC: false })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  view.mockInput.pressArrow("up")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Earlier task that belongs in history.")
  view.mockInput.pressKey("c", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Draft kept. Ctrl+C again quits and discards unsent drafts."))
  expect(view.renderer.isDestroyed).toBe(false)
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Earlier task that belongs in history.")
  await leaveComposer(view)
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Earlier task that belongs in history.")
  view.mockInput.pressKey("c", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Draft kept. Ctrl+C again quits"))
  expect(view.renderer.isDestroyed).toBe(false)
  view.mockInput.pressKey("c", { ctrl: true })
  expect(view.renderer.isDestroyed).toBe(true)
  expect(server.posts).toHaveLength(0)
})

test("Up does not replace nonempty editor text and page keys scroll by the viewport", async () => {
  const server = fixture({ history: true, text: Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n\n") })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Line 79"))
  const detail = descendants(view.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable && !(node instanceof SessionListRenderable),
  ) as ScrollBoxRenderable
  const before = detail.scrollTop
  view.mockInput.pressKey("\x1b[5~")
  await view.renderOnce()
  expect(detail.scrollTop).toBe(Math.max(0, before - detail.viewport.height + 1))
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Keep what I typed")
  view.mockInput.pressArrow("up")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep what I typed")
})

test("right-clicking navigation controls does not activate them", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const frame = await waitForFrame(view, (frame) => frame.includes("Models m"))
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("Models m"))
  await view.mockMouse.click(lines[row]!.indexOf("Models m") + 1, row, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Choose model")
  expect(server.posts).toHaveLength(0)

  view.mockInput.pressKey("k", { ctrl: true })
  const switcher = await waitForFrame(view, (frame) => frame.includes("Switch session"))
  const switcherLines = switcher.split("\n")
  const allRow = switcherLines.findIndex((line) => line.includes("Recent") && line.includes("All sessions"))
  await view.mockMouse.click(switcherLines[allRow]!.indexOf("All sessions") + 1, allRow, 2)
  const newRow = switcherLines.findIndex((line) => line.includes("+ New session"))
  await view.mockMouse.click(switcherLines[newRow]!.indexOf("New session") + 1, newRow, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Switch session")

  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  view.mockInput.pressKey("n")
  const launch = await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  const launchLines = launch.split("\n")
  const contextRow = launchLines.findIndex((line) => line.includes("Directory:"))
  await view.mockMouse.click(launchLines[contextRow]!.indexOf("Directory:") + 1, contextRow, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Agent ·")

  view.mockInput.pressKey("l", { ctrl: true })
  const models = await waitForFrame(view, (frame) => frame.includes("+ Connect a provider"))
  const modelLines = models.split("\n")
  const setupRow = modelLines.findIndex((line) => line.includes("+ Connect a provider"))
  await view.mockMouse.click(modelLines[setupRow]!.indexOf("Connect a provider") + 1, setupRow, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Choose model")
})

test.each([false, true])(
  "undo/redo updates visible history and preserves ordinary drafts (existing=%s)",
  async (existing) => {
    const server = fixture({ history: true, active: false })
    const view = await createTestRenderer({ width: 100, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    if (existing) {
      view.mockInput.pressKey("f")
      await view.mockInput.typeText("Existing draft")
      await leaveComposer(view)
    }
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText("Undo conversation turn")
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes("type undo"))
    await view.mockInput.typeText("undo")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("UNDO STAGED") && !frame.includes("Undo conversation?"))
    expect(view.captureCharFrame()).not.toContain("Inspecting the server")
    expect(server.posts.map((post) => post.path)).toEqual([
      "/api/session/ses_running/interrupt",
      "/api/session/ses_running/revert/stage",
    ])
    expect(server.posts[1]?.body).toEqual({ messageID: "msg_earlier", files: false })
    view.mockInput.pressKey("f")
    await waitForFrame(view, (frame) => frame.includes("Typing"))
    expect(view.renderer.currentFocusedEditor?.plainText).toBe(
      existing ? "Existing draft" : "Earlier task that belongs in history.",
    )
    expect(view.captureCharFrame()).toContain("commit undo")
    await leaveComposer(view)
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText("Redo conversation turn")
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes("type redo"))
    await view.mockInput.typeText("redo")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(
      view,
      (frame) => frame.includes("Inspecting the server") && !frame.includes("Redo conversation?"),
    )
    expect(view.captureCharFrame()).not.toContain("UNDO STAGED")
    view.mockInput.pressKey("f")
    await waitForFrame(view, (frame) => frame.includes("Typing"))
    expect(view.renderer.currentFocusedEditor?.plainText).toBe(existing ? "Existing draft" : "")
    expect(server.posts.some((post) => post.path.endsWith("/prompt"))).toBe(false)
  },
)

test("a newly staged undo cannot silently change the meaning of an already open reply", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Keep this draft")
  server.sessions[0] = { ...server.sessions[0]!, revert: { messageID: "msg_boundary" } }
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("undo position changed"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this draft")
  expect(server.posts).toHaveLength(0)
})

test("a shell command runs on the server, and a staged undo blocks it instead of silently skipping the commit", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("!git status")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Shell command sent"))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/shell")
  expect(server.posts[0]?.body).toMatchObject({ command: "git status" })

  // With an undo already staged the editor promises "Send + commit undo", which
  // /shell cannot carry, so the command must be refused rather than run.
  const staged = fixture()
  staged.sessions[0] = { ...staged.sessions[0]!, revert: { messageID: "msg_boundary" } }
  const second = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => second.renderer.destroy())
  await mountDashboard(second.renderer, staged.connection, staged.server.url.href).ready
  second.mockInput.pressKey("f")
  await second.mockInput.typeText("!git status")
  second.mockInput.pressEnter()
  await waitForFrame(second, (frame) => frame.includes("Commit or clear the staged undo"))
  expect(second.renderer.currentFocusedEditor?.plainText).toBe("!git status")
  expect(staged.posts).toHaveLength(0)
})

test("F2 composing refuses a draft whose submission is locked for retry", async () => {
  const server = fixture({ failPromptOnce: true })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Original message")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  expect(server.posts).toHaveLength(1)

  // Retrying requires the original text, so composing cannot rewrite it and
  // must not hand the terminal to an editor.
  view.mockInput.pressKey("\x1b[12~")
  await waitForFrame(view, (frame) => frame.includes("original submission is locked"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Original message")
  expect(server.posts).toHaveLength(1)
})

test("effort selection in a new draft is retained through reopening and sent with the chosen model", async () => {
  const server = fixture({ variants: { low: {}, high: {} } })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  await view.mockInput.typeText("Catalog")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("/effort")
  await waitForFrame(view, (frame) => frame.includes("Choose model effort"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Model variant / effort") && frame.includes("low"))
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?") && frame.includes("variant low"))
  expect(server.posts).toHaveLength(0)
  await view.mockInput.typeText("Use the selected effort")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[0]?.body.model).toEqual({ providerID: "test", id: "org/model", variant: "low" })
  expect(server.posts[1]?.body.prompt).toEqual({ text: "Use the selected effort" })
})

test("goal slash opens a read-only status panel without starting or stopping work", async () => {
  const server = fixture({
    goal: {
      id: "goal_fixture",
      sessionID: "ses_running",
      revision: 1,
      objective: "Finish the fixture",
      status: "active",
      tokensUsed: 12,
      timeUsedSeconds: 3,
      time: { created: 1, updated: 1, statusChanged: 1 },
    },
  })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/goal")
  await waitForFrame(view, (frame) => frame.includes("Inspect and control"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Finish the fixture"))
  expect(view.captureCharFrame()).toContain("Status: active")
  expect(view.captureCharFrame()).toContain("Tokens: 12")
  expect(server.posts).toHaveLength(0)
})

test("agent slash in a new draft opens draft settings rather than mutating the existing session", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("/agent")
  await waitForFrame(view, (frame) => frame.includes("Choose session agent"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Agent ·"))
  expect(view.renderer.currentFocusedRenderable).toBeInstanceOf(SelectRenderable)
  expect(server.posts).toHaveLength(0)
})

for (const width of [60, 120]) {
  test(`conversation slash opens commands and preserves saved drafts at ${width} columns`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    if (view.renderer.currentFocusedRenderable instanceof SessionListRenderable) view.mockInput.pressEnter()
    view.mockInput.pressKey("/")
    await waitForFrame(view, (frame) => frame.includes("/help"))
    const editor = view.renderer.currentFocusedRenderable as TextareaRenderable
    expect(editor).toBeInstanceOf(TextareaRenderable)
    expect(editor.plainText).toBe("/")
    await view.mockInput.typeText("help")
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
    await leaveComposer(view)
    view.mockInput.pressKey("f")
    await view.mockInput.typeText("Keep my unfinished reply")
    await leaveComposer(view)
    view.mockInput.pressKey("/")
    await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
    expect((view.renderer.currentFocusedRenderable as TextareaRenderable).plainText).toBe("Keep my unfinished reply")
    expect(server.posts).toHaveLength(0)
  })
}

for (const composer of ["f", "n"]) {
  // The reply editor has no Send button, so plain Enter stands in for the click there.
  for (const submit of composer === "n" ? ["ctrl-s", "ctrl-enter", "click"] : ["ctrl-s", "ctrl-enter", "enter"]) {
    test(`local slash actions use ${submit} without sending from ${composer}`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width: 100, height: 36 })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      view.mockInput.pressKey(composer)
      await view.mockInput.typeText("/help")
      await waitForFrame(view, (frame) => frame.includes("Keyboard help"))
      if (submit === "click") await clickText(view, "Send (Enter)")
      else if (submit === "enter") view.mockInput.pressEnter()
      else view.mockInput.pressKey(submit === "ctrl-s" ? "s" : "RETURN", { ctrl: true })
      await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts") || server.posts.length > 0)
      expect(server.posts).toHaveLength(0)
      expect(view.captureCharFrame()).toContain("Keyboard shortcuts")
    })
  }
}

test("clicking the selected sidebar session keeps reply editor focus", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Draft")
  const editor = view.renderer.currentFocusedRenderable as TextareaRenderable
  await clickText(view, "> * Review the server")
  expect(view.renderer.currentFocusedRenderable?.id).toBe(editor.id)
  await view.mockInput.typeText(" kept")
  expect(editor.plainText).toBe("Draft kept")
  expect(server.posts).toHaveLength(0)
})

test("startup prefers the main thread and Ctrl+X browses subagents without sending", async () => {
  const task = {
    id: "tsk_child",
    rootSessionID: "ses_root",
    parentSessionID: "ses_root",
    childSessionID: "ses_running",
    agent: "explore",
    description: "Inspect the child task",
    depth: 1,
    status: "running" as const,
    revision: 1,
    time: { created: 1, updated: 2 },
  }
  const server = fixture({ tasks: { data: [task], active: [task], cursor: {} } })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_root" }
  server.sessions.push({ ...server.sessions[0]!, id: "ses_root", title: "Main thread", parentID: undefined })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const dashboard = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await dashboard.ready
  expect(server.reads).toContain("/api/session/ses_root/message")
  expect(server.reads).not.toContain("/api/session/ses_running/message")
  view.mockInput.pressKey("x", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Search task description") && frame.includes(task.description))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Search task description"))
  expect(server.reads).toContain("/api/session/ses_running/message")
  await dashboard.refresh()
  expect(view.captureCharFrame()).not.toContain("Search task description")
  expect(server.posts).toHaveLength(0)
})

test("startup loads a main session outside a child-only recent page", async () => {
  const server = fixture({ more: true })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_root" }
  server.historical.set("ses_root", {
    ...server.sessions[0]!,
    id: "ses_root",
    parentID: undefined,
    title: "Older main thread",
  })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  expect(server.reads).toContain("/api/session/ses_root/message")
  expect(server.reads).not.toContain("/api/session/ses_running/message")
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("Reply to the main thread")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]?.path).toBe("/api/session/ses_root/prompt")
})

test("passive refresh preserves sidebar browsing scroll", async () => {
  const server = fixture({ active: false })
  const template = server.sessions[0]!
  server.sessions.splice(0, 1, ...Array.from({ length: 40 }, (_, i) => ({ ...template, id: `ses_browse_${i}` })))
  const view = await createTestRenderer({ width: 120, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const dashboard = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await dashboard.ready
  await view.renderOnce()
  const list = descendants(view.renderer.root).find(
    (node) => node instanceof SessionListRenderable,
  ) as SessionListRenderable
  list.scrollTo(20)
  await view.renderOnce()
  const position = list.scrollTop
  expect(position).toBeGreaterThan(0)
  const reveal = spyOn(list, "scrollChildIntoView")
  cleanup.push(() => reveal.mockRestore())
  await dashboard.refresh()
  await view.renderOnce()
  expect(list.scrollTop).toBe(position)
  expect(reveal).not.toHaveBeenCalled()
})

test("slash help opens the existing help UI without submitting a prompt", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/help")
  await waitForFrame(view, (frame) => frame.includes("Keyboard help"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  expect(server.posts).toHaveLength(0)
})

test("server slash commands preserve argument text and retry routing after inventory changes", async () => {
  const options = {
    commands: [{ name: "review", description: "Review changes", template: "Review $ARGUMENTS" }],
    failCommandOnce: true,
  }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText('/review  "two words"')
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("HTTP 502"))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/command",
    body: { command: "review", arguments: ' "two words"', resume: true },
  })
  expect(server.posts[0]?.body).not.toHaveProperty("delivery")
  options.commands = []
  const reads = server.reads.filter((path) => path === "/api/command").length
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[1]).toEqual(server.posts[0])
  expect(server.reads.filter((path) => path === "/api/command")).toHaveLength(reads)
})

test("queue mode does not silently steer a slash command", async () => {
  const server = fixture({ commands: [{ name: "review", template: "Review $ARGUMENTS" }] })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/review changes")
  view.mockInput.pressKey("t", { ctrl: true })
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("do not support Queue"))
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("t", { ctrl: true })
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/command")
})

test.each([60, 120])("known task-owned child replies offer main-session navigation at %s columns", async (width) => {
  const task = {
    id: "tsk_owner",
    rootSessionID: "ses_root",
    parentSessionID: "ses_parent",
    childSessionID: "ses_running",
    agent: "build",
    description: "Child task",
    depth: 2,
    status: "running" as const,
    revision: 1,
    time: { created: 1, updated: 1 },
  }
  const server = fixture({ tasks: { data: [task], active: [task], cursor: {} } })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_parent" }
  server.sessions.push({ ...server.sessions[0]!, id: "ses_root", title: "Main conversation", parentID: undefined })
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  // Ctrl+K stays the editor's delete-to-line-end, which a narrow terminal's reply editor would receive.
  if (width === 60) await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review the server")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("read-only"))
  const readsBeforeReply = server.reads.length
  view.mockInput.pressKey("/")
  await waitForFrame(view, (frame) => frame.includes("Find a command"))
  await view.mockInput.typeText("help")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  view.mockInput.pressKey("f")
  const blocked = await waitForFrame(view, (frame) => frame.includes("Task-owned subagent"))
  expect(blocked).toContain("Main conversation")
  expect(blocked).not.toContain("Your message")
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Task-owned subagent"))
  expect(server.reads.slice(readsBeforeReply)).not.toContain("/api/session/ses_root")
  view.mockInput.pressKey("f")
  if (width === 60) await clickText(view, "Open main session and reply")
  else view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(server.reads).toContain("/api/session/ses_root")
  expect(server.posts).toHaveLength(0)
  await view.mockInput.typeText("Instructions for the main agent")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]?.path).toBe("/api/session/ses_root/prompt")
})

test.each([60])("wrapped reply text retains space and visible controls at %s columns", async (width) => {
  const server = fixture()
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  const editor = view.renderer.currentFocusedRenderable as TextareaRenderable
  const text = "Wrapped words with spaces. ".repeat(35) + "\nDRAFTEND"
  editor.setText(text)
  editor.cursorOffset = text.length
  await waitForFrame(view, (frame) => frame.includes("DRAFTEND"))
  await waitForFrame(view, (frame) => frame.includes("DRAFTEND") && editor.height === 6)
  expect(editor.height).toBe(6)
  for (const columns of [60, 120, width]) {
    view.resize(columns, 24)
    const frame = await waitForFrame(view, (frame) => frame.includes("DRAFTEND") && frame.includes("F4 discard"))
    expect(frame).toContain("Enter send")
    expect(editor.plainText).toBe(text)
    expect(editor.y + editor.height).toBeLessThanOrEqual(24)
    expect(view.renderer.currentFocusedRenderable?.id).toBe(editor.id)
  }
  expect(server.posts).toHaveLength(0)
})

test("an unowned session with a parent can still receive direct replies", async () => {
  const server = fixture()
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_parent" }
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Direct fork reply")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/prompt")
})

test("late ownership rejection preserves the draft, blocks repeat POSTs, and never silently redirects", async () => {
  const server = fixture({ ownedError: true })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_root" }
  server.sessions.push({ ...server.sessions[0]!, id: "ses_root", parentID: undefined, title: "Main conversation" })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review the server")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Keep this rejected child draft")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Draft kept. Press Esc"))
  view.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(30)
  expect(server.posts).toHaveLength(1)
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this rejected child draft")
  await leaveComposer(view)
  view.mockInput.pressKey("f")
  const blocked = await waitForFrame(view, (frame) => frame.includes("Saved child draft"))
  expect(blocked).toContain("Keep this rejected child draft")
  expect(server.posts).toHaveLength(1)
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Main conversation") && !frame.includes("Task-owned subagent"))
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("")
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/prompt")
})

test("pending permissions and questions send the selected session's explicit responses", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  server.pending.questions = [
    {
      id: "que_test",
      sessionID: "ses_running",
      questions: [
        {
          header: "Scope",
          question: "Which files?",
          options: [
            { label: "Source", description: "Source files" },
            { label: "Tests", description: "Test files" },
          ],
          multiple: true,
          custom: false,
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("need input")
  expect(view.captureCharFrame()).not.toContain("QUESTION PENDING")
  expect(server.posts).toHaveLength(0)
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  expect(view.captureCharFrame()).toContain("npm test")
  view.mockInput.pressArrow("down")
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(server.posts).toHaveLength(0)
  }
  view.mockInput.pressEnter({ ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Allowed once."))
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/permission/per_test/reply",
    body: { reply: "once" },
  })
  view.mockInput.pressKey("o")
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(view.captureCharFrame()).toContain("Which files?")
  expect(view.captureCharFrame()).toContain("Source files")
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Choose an answer")
    expect(server.posts).toHaveLength(1)
  }
  view.mockInput.pressKey(" ")
  view.mockInput.pressArrow("down")
  view.mockInput.pressKey(" ")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  expect(server.posts).toHaveLength(1)
  view.mockInput.pressEnter({ ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Answers sent."))
  expect(server.posts[1]).toMatchObject({
    path: "/api/session/ses_running/question/que_test/reply",
    body: { answers: [["Source", "Tests"]] },
  })
})

test("new questions open automatically once and defer to an active reply draft", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 32 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Keep this draft")
  server.pending.questions = [
    {
      id: "que_auto",
      sessionID: "ses_running",
      questions: [
        {
          header: "Choice",
          question: "Which automatic choice?",
          custom: false,
          options: [{ label: "Keep", description: "No mutation before review" }],
        },
      ],
    },
  ]
  await app.refresh()
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this draft")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Question 1 of 1"))
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Question 1 of 1")
  server.pending.questions = [{ ...server.pending.questions[0]!, id: "que_next" }]
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  server.pending.questions = []
  await app.refresh()
  await waitForFrame(view, (frame) => !frame.includes("Question 1 of 1"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this draft")
  expect(server.posts).toHaveLength(0)
})

test.each([60])("question panel keeps transcript visible and Ctrl+K preserves answers at %s columns", async (width) => {
  const server = fixture({ text: "TRANSCRIPT REMAINS VISIBLE", postDelay: 200 })
  server.sessions.push({ ...server.sessions[0]!, id: "ses_other", title: "Another session" })
  server.pending.questions = [
    {
      id: "que_docked",
      sessionID: "ses_running",
      questions: [
        {
          header: "Choice",
          question: "Choose a response",
          multiple: true,
          custom: true,
          options: [
            { label: "First", description: "First choice" },
            { label: "Second", description: "Second choice" },
          ],
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const frame = await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(frame).toContain("TRANSCRIPT REMAINS VISIBLE")
  expect(frame).not.toContain("QUESTION PENDING")
  view.mockInput.pressKey(" ")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Your answer"))
  await view.mockInput.typeText("Alpha, beta")
  view.renderer.currentFocusedEditor!.cursorOffset = 5
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Your answer"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Alpha, beta")
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe(5)
  view.mockInput.pressEnter()
  view.mockInput.pressArrow("right")
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  await view.mockInput.typeText("Another")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("Another session"))
  expect(view.captureCharFrame()).not.toContain("Review answers")
  // The other session opened with its reply editor; Ctrl+K works from there too, and from shortcut mode.
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review the server")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  expect(view.captureCharFrame()).toContain("Alpha, beta")
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("s", { ctrl: true })
  view.mockInput.pressKey("k", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Switch session")
  await waitForFrame(view, (frame) => frame.includes("Answers sent."))
  expect(server.posts).toEqual([
    { path: "/api/session/ses_running/question/que_docked/reply", body: { answers: [["First", "Alpha, beta"]] } },
  ])
})

test("shared working folders update the sidebar and explicit folder controls never launch a session", async () => {
  const options = { workingFolders: ["/srv/project", "/srv/empty"], folderRevision: 1 }
  const server = fixture(options)
  server.sessions.push({
    ...server.sessions[0]!,
    id: "ses_nested",
    title: "Nested project work",
    location: { directory: "/srv/project/package" },
  })
  const view = await createTestRenderer({ width: 140, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Nested project work") && frame.includes("/srv/empty"))
  options.workingFolders = ["/srv/empty"]
  options.folderRevision++
  await app.refresh()
  await waitForFrame(view, (frame) => !frame.includes("Nested project work") && frame.includes("(closed)"))
  await clickText(view, "Working folders")
  await waitForFrame(view, (frame) => frame.includes("Open another folder"))
  const input = () =>
    descendants(view.renderer.root).find((node) => node instanceof InputRenderable && node.focused) as InputRenderable
  input().value = "/srv/new"
  // Enter shows the chosen row, every open folder here, and never opens the typed one.
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Open another folder") && frame.includes("Showing every open"))
  expect(options.workingFolders).toEqual(["/srv/empty"])
  await clickText(view, "Working folders")
  await waitForFrame(view, (frame) => frame.includes("Open another folder"))
  input().value = "/srv/new"
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => !frame.includes("Open another folder") && frame.includes("Folder · new"))
  expect(options.workingFolders).toEqual(["/srv/empty", "/srv/new"])
  view.mockInput.pressKey("n", { ctrl: true })
  await waitForFrame(
    view,
    (frame) => frame.includes("What would you like to do?") && frame.includes("Directory: /srv/new"),
  )
  view.mockInput.pressKey("F4")
  await waitForFrame(view, (frame) => !frame.includes("What would you like to do?"))
  // Close mode acts on the folder on screen, which the cursor starts on, and closing it shows every folder again.
  await clickText(view, "Folder · new")
  await waitForFrame(view, (frame) => frame.includes("▶ /srv/new  · showing"))
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Enter close it"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => !frame.includes("Open another folder") && frame.includes("Working folders · 1 open"))
  expect(options.workingFolders).toEqual(["/srv/empty"])
  expect(server.posts).toEqual([])
})

test("empty session welcome is branded and does not block New session", async () => {
  const options = { active: false, authenticated: true }
  const server = fixture(options)
  server.sessions.splice(0)
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  const frame = await waitForFrame(view, (frame) => frame.includes("No session selected"))
  expect(frame).toContain("Connected")
  expect(frame).toContain("Ctrl+K sessions")
  options.authenticated = false
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Disconnected · No session selected."))
  options.authenticated = true
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Connected · No session selected."))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  expect(server.posts).toHaveLength(0)
})

test("an initial pending question opens automatically without requiring o", async () => {
  const server = fixture()
  server.pending.questions = [
    {
      id: "que_initial",
      sessionID: "ses_running",
      questions: [
        {
          header: "Ready",
          question: "Open automatically?",
          custom: false,
          options: [{ label: "Yes", description: "Only selected by the user" }],
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(view.renderer.currentFocusedRenderable).toBeInstanceOf(SelectRenderable)
  expect(server.posts).toHaveLength(0)
})

test("an older server keeps sessions and launch available without claiming an empty terminal inventory", async () => {
  const server = fixture({ ptyStatus: 404 })
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("terminals unavailable")
  expect(view.captureCharFrame()).not.toContain("Disconnected")
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("Global terminal inventory is unavailable"))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  expect(view.captureCharFrame()).toContain("New session")
})

test("initial authentication failure gives recovery instructions and keyboard help", async () => {
  const server = fixture({ authenticated: false })
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("FORGE_SERVER_PASSWORD")
  expect(view.captureCharFrame()).not.toContain("Connecting to the server")
  view.mockInput.pressKey("?")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Keyboard shortcuts")
  view.mockInput.pressTab()
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  expect(view.captureCharFrame()).toContain("Disconnected")
})

test("rapid selection coalesces detail reads and ignores the previous session's pending actions", async () => {
  const server = fixture({ messageDelay: 80 })
  server.sessions.push(
    ...Array.from({ length: 15 }, (_, index) => ({
      ...server.sessions[0]!,
      id: `ses_other${index}`,
      title: `Session ${index}`,
    })),
  )
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  server.reads.length = 0
  for (let index = 0; index < 12; index++) view.mockInput.pressArrow("down")
  await Bun.sleep(220)
  await view.renderOnce()
  expect(server.reads.filter((path) => path.endsWith("/message")).length).toBeLessThanOrEqual(2)
  expect(view.captureCharFrame()).toContain("Session 11")
})

test("oversized paste is rejected before insertion and submitting freezes the draft", async () => {
  const server = fixture({ postDelay: 100 })
  const view = await createTestRenderer({ width: 110, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.pasteBracketedText("x".repeat(32001))
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Paste a shorter message")
  await view.mockInput.typeText("Inspect the server")
  view.mockInput.pressKey("s", { ctrl: true })
  await view.mockInput.typeText("do not append")
  await view.mockInput.pasteBracketedText("nor paste")
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressArrow("right", { meta: true })
  view.mockInput.pressKey("F4")
  view.mockInput.pressEscape()
  view.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(250)
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Inspect the server" } })
})

test("failed agent discovery cannot launch using a blank directory", async () => {
  const server = fixture({ agentStatus: 500 })
  const view = await createTestRenderer({ width: 110, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Cannot load agents"))
  await view.mockInput.typeText("Inspect the server")
  view.mockInput.pressTab()
  view.mockInput.pressKey("a", { ctrl: true })
  for (let index = 0; index < 12; index++) view.mockInput.pressKey("DELETE")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Enter an absolute directory"))
  expect(server.posts).toHaveLength(0)
})

test("failed agent discovery reads as one sentence, replaces the loading row, and names a typed folder", async () => {
  const server = fixture({ agentStatus: 500 })
  const view = await createTestRenderer({ width: 110, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  const frame = await waitForFrame(view, (text) => text.includes("Cannot load agents"))
  expect(frame.replace(/\s*│\s*\n\s*│\s*/g, " ")).toContain("check the server logs. Ctrl+S retries.")
  expect(frame).not.toContain("..")
  view.mockInput.pressTab()
  await waitForFrame(view, (text) => text.includes("Agents unavailable"))
  expect(view.captureCharFrame()).not.toContain("Loading agents")
  view.mockInput.pressKey("a", { ctrl: true })
  for (let index = 0; index < 12; index++) view.mockInput.pressKey("DELETE")
  await view.mockInput.typeText("/srv/nope")
  view.mockInput.pressTab()
  const typed = await waitForFrame(view, (text) => text.includes("/srv/nope may not be a folder on the server"))
  expect(typed.replace(/\s*│\s*\n\s*│\s*/g, " ")).toContain("Fix Directory, or Ctrl+S retries.")
})

test("Escape keeps a launch draft, successful launch remembers settings, and discard starts empty", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep this task")
  view.mockInput.pressTab()
  view.mockInput.pressTab()
  await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
  view.mockInput.pressArrow("down")
  view.mockInput.pressTab()
  await view.mockInput.typeText("test/local")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Keep this task"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[0]?.body).toMatchObject({ agent: "build", model: { providerID: "test", id: "local" } })
  // The launched session opens with its reply editor, so leave it before pressing n again.
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("test/local"))
  expect(view.captureCharFrame()).not.toContain("Keep this task")
  await view.mockInput.typeText("Discard this")
  view.mockInput.pressKey("F4")
  await waitForFrame(view, (frame) => frame.includes("Local draft discarded"))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  expect(view.captureCharFrame()).not.toContain("Discard this")
  expect(server.posts).toHaveLength(2)
})

test("a lost launch response survives close and reopen with the original request identity and fields", async () => {
  const server = fixture({ failPromptOnce: true })
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Run exactly once")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  await view.mockInput.typeText(" accidental edit")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Original submission kept"))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Run exactly once"))
  expect(view.captureCharFrame()).not.toContain("accidental edit")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
  expect(server.posts[2]).toEqual(server.posts[1])
})

test("reopened launch retry succeeds even if unrelated agent discovery fails afterward", async () => {
  const settings: { failPromptOnce: boolean; agentStatus?: number } = { failPromptOnce: true }
  const server = fixture(settings)
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Retry despite agent discovery failure")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Original submission kept"))

  // Simulate agent discovery failing
  settings.agentStatus = 500

  // Reopen launch draft
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Retry despite agent discovery failure"))
  // Submit the frozen retry
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
})

test("follow-up drafts retain recipient context and ambiguous message identities", async () => {
  const settings = { failPromptOnce: true, active: true }
  const server = fixture(settings)
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Continue carefully")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Review the server")
  expect(view.captureCharFrame()).toContain("/srv/project")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  await view.mockInput.typeText(" accidental edit")
  view.mockInput.pressEscape()
  // The session runs, so Esc also arms the stop and that notice replaces the draft-kept one.
  await waitForFrame(
    view,
    (frame) => frame.includes("Press Esc again to stop this turn") && frame.includes("Draft kept"),
  )
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Continue carefully"))
  expect(view.captureCharFrame()).not.toContain("accidental edit")
  server.historical.set(server.sessions[0]!.id, server.sessions[0]!)
  server.sessions.splice(0)
  settings.active = false
  await app.refresh()
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[1]).toEqual(server.posts[0])
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/prompt")
})

test("slash and Ctrl+K share session matching and cancellation without leaving a sidebar filter", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second task" })
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("Second")
  await waitForFrame(view, (frame) => frame.includes("Switch session") && frame.includes("Second task"))
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("* Review the server"))
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Second build")
  view.mockInput.pressEnter()
  await waitForFrame(
    view,
    (frame) => !frame.includes("Switch session") && server.reads.includes("/api/session/ses_second/message"),
  )
  await leaveComposer(view)
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  view.mockInput.pressKey("1")
  await waitForFrame(view, (frame) => frame.includes("Second task"))
  expect(view.captureCharFrame()).not.toContain("Find: Second")
})

test("commands filter by typing and Enter runs the matching action without a server mutation", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("terminal")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Terminal processes")
  expect(view.captureCharFrame()).not.toContain("Send follow-up")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Terminal ID:") && frame.includes("PID 4242"))
  expect(server.posts).toHaveLength(0)
})

test("a permission with a saved rule offers Allow always, like the desktop", async () => {
  const server = fixture()
  server.pending.permissions = [
    { id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"], save: ["npm *"] },
  ]
  const view = await createTestRenderer({ width: 110, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Allow always"))
  expect(view.captureCharFrame()).toContain("saves 1 rule")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Allowed always."))
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/permission/per_test/reply",
    body: { reply: "always" },
  })
})

test("long permission forms reveal the final resource and choice with keyboard scrolling", async () => {
  const server = fixture()
  server.pending.permissions = [
    {
      id: "per_long",
      sessionID: "ses_running",
      action: "shell",
      resources: Array.from({ length: 24 }, (_, index) => `Resource ${index + 1}`),
    },
  ]
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("\x1b[6~")
  view.mockInput.pressTab()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Resource 24")
  expect(view.captureCharFrame()).toContain("Allow once")
  // Without a server-named rule there is nothing to save.
  expect(view.captureCharFrame()).not.toContain("Allow always")
  expect(server.posts).toHaveLength(0)
})

test("a narrow launch keeps the selected session's target and settings visible", async () => {
  const server = fixture()
  server.sessions[0] = { ...server.sessions[0]!, location: { directory: "/srv/tools" } }
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Inspect this directory")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Directory: /srv/tools")
  expect(view.captureCharFrame()).toContain("Tab: folder")
  expect(view.captureCharFrame()).not.toContain("Server default")
  expect(view.captureCharFrame()).not.toContain("Model · optional")
  expect(view.captureCharFrame()).toContain("Inspect this directory")
  expect(server.posts).toHaveLength(0)
})

test("resizing below the minimum protects the draft and restores it on return", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep this while resizing")
  view.resize(45, 18)
  await view.renderOnce()
  expect(view.captureCharFrame().replace(/\s+/g, " ")).toContain("58 columns × 24 rows")
  await view.mockInput.typeText("unexpected")
  await view.mockInput.pasteBracketedText("paste must be blocked")
  view.mockInput.pressKey("s", { ctrl: true })
  view.resize(70, 24)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Keep this while resizing")
  expect(view.captureCharFrame()).not.toContain("unexpected")
  expect(view.captureCharFrame()).not.toContain("paste must")
  expect(server.posts).toHaveLength(0)
})

test("saved launch drafts remain readable and discardable while disconnected", async () => {
  const settings = { authenticated: true }
  const server = fixture(settings)
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep offline")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  settings.authenticated = false
  await app.refresh()
  view.mockInput.pressKey("n")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Keep offline")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.replace(/\s+/g, " ").includes("Reconnect before sending"))
  view.mockInput.pressKey("F4")
  await waitForFrame(view, (frame) => frame.includes("Local draft discarded"))
  expect(server.posts).toHaveLength(0)
})

test("an uncertain launch exposes its ID and can be inspected before an exact retry", async () => {
  const server = fixture({ failPromptOnce: true })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Inspect before retry")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
  const id = server.posts[0]!.body.id as string
  expect(view.captureCharFrame()).toContain(id)
  view.mockInput.pressKey("o", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("New agent"))
  await leaveComposer(view)
  view.mockInput.pressKey("i")
  await waitForFrame(view, (frame) => frame.includes(id))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("SERVER"))
  expect(server.posts).toHaveLength(2)
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts).toHaveLength(3)
  expect(server.posts[2]).toEqual(server.posts[1])
})

test("inspection fetches the exact older session and cannot select an ID mentioned in another title", async () => {
  const server = fixture({ failPromptOnce: true, active: false })
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Inspect the exact session")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
  const intended = server.sessions.shift()!
  server.historical.set(intended.id, { ...intended, title: "Intended older session" })
  server.sessions[0] = { ...server.sessions[0]!, title: `Unrelated mentions ${intended.id}` }
  view.mockInput.pressKey("o", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Intended older session"))
  expect(view.captureCharFrame()).not.toContain("Unrelated mentions")
  expect(server.reads).toContain(`/api/session/${intended.id}`)
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Intended older session")
  expect(server.posts).toHaveLength(2)
})

test("mouse navigation matches the view and composer labels", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const click = async (text: string) => {
    await view.renderOnce()
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    await view.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
  }
  await click("2 Ter")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  await click("1 Ses")
  await waitForFrame(view, (frame) => frame.includes("Review the server"))
  const composer = view
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("Message…"))!
  expect(composer).not.toContain("New session")
  const action = descendants(view.renderer.root).find(
    (node) => node instanceof TextRenderable && node.plainText.startsWith("Message…"),
  ) as TextRenderable
  expect(action.plainText).toBe("Message…")
  await click("Message…")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("Keep while switching tabs")
  await click("2 Ter")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  await click("1 Ses")
  // Back on the chat the reply editor reopens by itself with its draft; Esc leaves it for the label.
  await waitForFrame(view, (frame) => frame.includes("Keep while switching tabs"))
  await leaveComposer(view)
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  await click("Draft kept")
  await waitForFrame(view, (frame) => frame.includes("Keep while switching tabs"))
  expect(server.posts).toHaveLength(0)
})

test("command selection remains visible at the minimum supported size", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Refresh")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Refresh")
  expect(view.captureCharFrame()).toContain("Enter run")
  const select = descendants(view.renderer.root)
    .filter((node) => node instanceof SelectRenderable)
    .at(-1)!
  expect(select.options[select.getSelectedIndex()]?.name).toBe("Refresh  · Reload from the server (r)")
  expect(server.posts).toHaveLength(0)
})

test("the default view shows the full live transcript and keeps technical details on demand", async () => {
  const server = fixture({ history: true })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await view.renderOnce()
  const frame = await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  expect(frame).toContain("Inspecting the server")
  expect(frame).toContain("/srv/project")
  expect(frame).not.toContain("ses_running")
  expect(frame).not.toContain(server.server.url.host)
  expect(frame).toContain("test/local")
  expect(frame).toContain("Earlier task")
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("Earlier task"))
  expect(view.captureCharFrame()).toContain("test/local")
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => !frame.includes("History ·"))
  view.mockInput.pressKey("i")
  await waitForFrame(view, (frame) => frame.includes("SERVER"))
  expect(view.captureCharFrame()).toContain("ses_running")
  expect(view.captureCharFrame()).toContain(server.server.url.host)
  expect(server.posts).toHaveLength(0)
})

test("machine responses are formatted by default and raw JSON is opt-in", async () => {
  const raw = '{"status":"completed","result":{"summary":"Checks passed"}}'
  const server = fixture({ toolText: raw })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const frame = await waitForFrame(view, (frame) => frame.includes("Checks passed"))
  expect(frame).toContain("status: completed")
  expect(frame).not.toContain('{"status"')
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Show raw responses")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes(raw))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Show formatted responses")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("status: completed") && !frame.includes('{"status"'))
  expect(server.posts).toHaveLength(0)
})

test("long tool output is folded by default and the palette expands and folds it again", async () => {
  const server = fixture({ toolText: Array.from({ length: 30 }, (_, index) => `output row ${index + 1}`).join("\n") })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  // Fenced output can paint a frame after the fold note, so wait for both.
  const folded = await waitForFrame(view, (frame) => frame.includes("+26 lines") && frame.includes("output row 4"))
  expect(folded).not.toContain("output row 30")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Expand tool output")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("output row 30") && !frame.includes("+26 lines"))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Collapse tool output")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("+26 lines") && !frame.includes("output row 30"))
  expect(server.posts).toHaveLength(0)
})

test("the primary action exposes the blocker before reply and still opens the correct request", async () => {
  const options = { authenticated: true }
  const server = fixture(options)
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  server.pending.questions = [
    {
      id: "que_test",
      sessionID: "ses_running",
      questions: [
        {
          header: "Scope",
          question: "Which files?",
          options: [{ label: "Source", description: "Source files" }],
          custom: false,
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request") && frame.includes("need input"))
  // Closing the prompt leaves the reply editor open, saying the permission waits; Esc leaves it for shortcuts.
  await waitForFrame(view, (frame) => frame.includes("Enter reviews the permission"))
  await leaveComposer(view)
  expect(view.captureCharFrame()).not.toContain("Message…")
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("p Review permission"))
  await view.mockMouse.click(lines[y]!.indexOf("p Review permission") + 1, y)
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request"))
  server.pending.permissions = []
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Question 1 of 1"))
  await leaveComposer(view)
  expect(view.captureCharFrame()).toContain("o Answer question")
  options.authenticated = false
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("showing saved data")
  expect(view.captureCharFrame()).toContain("r Retry connection")
  expect(view.captureCharFrame()).not.toContain("Message…")
  options.authenticated = true
  const disconnected = view.captureCharFrame().split("\n")
  const retryRow = disconnected.findIndex((line) => line.includes("r Retry connection"))
  await view.mockMouse.click(disconnected[retryRow]!.indexOf("r Retry connection") + 1, retryRow)
  await waitForFrame(view, (frame) => frame.includes("o Answer question") && !frame.includes("Disconnected"))
  server.pending.questions = []
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Message…")
  expect(server.posts).toHaveLength(0)
})

test("clicking Settings reveals launch controls and preserves custom choices in the collapsed draft", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("A short task")
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Directory on the server")
  expect(view.captureCharFrame()).not.toContain("Model · optional")
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Tab: folder"))
  await view.mockMouse.click(lines[y]!.indexOf("Tab: folder") + 1, y)
  view.mockInput.pressTab()
  await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
  view.mockInput.pressArrow("down")
  view.mockInput.pressTab()
  await view.mockInput.typeText("test/local")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  view.mockInput.pressKey("n")
  // The settings stay open, so they show the choices and the summary above them is gone.
  await waitForFrame(view, (frame) => frame.includes("test/local") && frame.includes("▶ build"))
  expect(view.captureCharFrame()).not.toContain("Tab: folder")
  expect(view.captureCharFrame()).not.toContain("Model · optional")
  expect(view.captureCharFrame()).toContain("A short task")
  expect(server.posts).toHaveLength(0)
})

test("recovered session details remove their error and restore the pending action", async () => {
  const options = { messageStatus: undefined as number | undefined }
  const server = fixture(options)
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request"))
  options.messageStatus = 503
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Details unavailable"))
  expect(view.captureCharFrame()).toContain("r Retry details")
  expect(view.captureCharFrame()).not.toContain("p Review permission")
  options.messageStatus = undefined
  view.mockInput.pressKey("r")
  const frame = await waitForFrame(
    view,
    (frame) => frame.includes("Inspecting the server") && frame.includes("p Review permission"),
  )
  expect(frame).not.toContain("Details unavailable")
  expect(frame).not.toContain("Retry details")
  expect(server.posts).toHaveLength(0)
})

test("launching from mouse search opens the new session and restores keyboard shortcuts", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second task" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("Second")
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("+ New session  Ctrl+N"))
  await view.mockMouse.click(lines[y]!.indexOf("New session") + 1, y)
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("New task from search")
  view.mockInput.pressKey("s", { ctrl: true })
  const frame = await waitForFrame(view, (frame) => frame.includes("Task sent.") && frame.includes("New agent"))
  expect(frame).toContain("New agent")
  expect(frame).not.toContain("Find: Second")
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "New task from search" } })
})

test("empty search discloses when older sessions are outside the loaded inventory", async () => {
  const server = fixture({ more: true })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Older task")
  const frame = await waitForFrame(view, (frame) => frame.includes("No matching loaded sessions"))
  expect(frame).toContain("Ctrl+O Open older session by ID")
  expect(server.posts).toHaveLength(0)
})

for (const width of [60, 120]) {
  test(`finder keeps search focused and visible while paging, scrolling, and resizing at ${width} columns`, async () => {
    const server = fixture({ active: false })
    server.sessions.splice(
      0,
      1,
      ...Array.from({ length: 40 }, (_, index) => ({
        ...server.sessions[0]!,
        id: `ses_browse_${index}`,
        title: `Browse ${index}`,
        location: { directory: `/srv/project-${index}` },
      })),
    )
    const view = await createTestRenderer({ width, height: 32 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    if (width === 60) await leaveComposer(view)
    view.mockInput.pressKey("k", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("▶ Browse 0"))
    const input = view.renderer.currentFocusedEditor!
    const y = input.y
    const list = descendants(view.renderer.root)
      .filter((node) => node instanceof ScrollBoxRenderable)
      .at(-1)!
    const slider = list.verticalScrollBar.slider
    await view.mockMouse.click(slider.x, slider.y + slider.height - 1)
    expect(list.scrollTop).toBeGreaterThan(6)
    await view.mockMouse.scroll(list.viewport.x + 2, list.viewport.y + 1, "down")
    await view.renderOnce()
    expect(view.captureCharFrame()).toMatch(/▶ Browse 3\b/)
    expect(list.scrollTop).toBe(7)
    for (let index = 0; index < 3; index++) view.mockInput.pressKey("\x1b[6~")
    await view.renderOnce()
    const selected = view.captureCharFrame().match(/▶ Browse (\d+)/)![1]
    expect(Number(selected)).toBeGreaterThan(0)
    expect(input.y).toBe(y)
    expect(input.focused).toBe(true)
    await view.mockInput.typeText("Browse")
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain(`▶ Browse ${selected}`)
    view.mockInput.pressKey("u", { ctrl: true })
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain(`▶ Browse ${selected}`)
    await view.mockMouse.click(slider.x, slider.y + Math.floor(slider.height / 2))
    expect(input.focused).toBe(true)
    await view.mockMouse.scroll(list.viewport.x + 2, list.viewport.y + 1, "up")
    await view.renderOnce()
    expect(view.captureCharFrame().match(/▶ Browse (\d+)/)![1]).not.toBe(selected)
    expect(input.focused).toBe(true)
    view.resize(60, 24)
    await view.renderOnce()
    expect(input.y).toBeLessThan(list.viewport.y)
    expect(view.captureCharFrame()).toContain("Search title")
    expect(view.captureCharFrame()).toContain("▶ Browse")
    view.resize(59, 23)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Resize the terminal")
    view.resize(60, 24)
    await view.renderOnce()
    await view.mockInput.typeText("project-39")
    await waitForFrame(view, (frame) => frame.includes("▶ Browse 39"))
    expect(input.plainText).toBe("project-39")
    expect(server.reads).not.toContain("/api/session/ses_browse_39/message")
    view.mockInput.pressEnter()
    await waitForFrame(
      view,
      (frame) =>
        !frame.includes("Switch session") &&
        frame.includes("Browse 39") &&
        server.reads.includes("/api/session/ses_browse_39/message"),
    )
    expect(server.reads).toContain("/api/session/ses_browse_39/message")
    expect(server.posts).toHaveLength(0)
  })
}

for (const line of [0]) {
  test(`clicking a scrolled finder result's ${line ? "description" : "title"} opens that row, not the keyboard selection`, async () => {
    const server = fixture({ active: false })
    server.sessions.splice(
      0,
      1,
      ...Array.from({ length: 35 }, (_, index) => ({
        ...server.sessions[0]!,
        id: `ses_browse_${index}`,
        title: `Browse ${index}`,
      })),
    )
    const view = await createTestRenderer({ width: 60, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    await leaveComposer(view)
    view.mockInput.pressKey("k", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("▶ Browse 0"))
    for (let index = 0; index < 3; index++) view.mockInput.pressKey("\x1b[6~")
    await view.renderOnce()
    const list = descendants(view.renderer.root)
      .filter((node) => node instanceof ScrollBoxRenderable)
      .at(-1)!
    const row = descendants(list).find(
      (node) =>
        node instanceof TextRenderable &&
        node.plainText.startsWith("  Browse ") &&
        node.y >= list.viewport.y &&
        node.y + 1 < list.viewport.y + list.viewport.height,
    ) as TextRenderable
    expect(row).toBeDefined()
    const number = row.plainText.match(/Browse (\d+)/)![1]
    expect(view.captureCharFrame()).not.toContain(`▶ Browse ${number}\n`)
    await view.mockMouse.click(row.x + 3, row.y + line, 2)
    expect(view.renderer.currentFocusedEditor?.focused).toBe(true)
    expect(server.reads).not.toContain(`/api/session/ses_browse_${number}/message`)
    await view.mockMouse.click(row.x + 3, row.y + line)
    await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes(`Browse ${number}`))
    expect(server.reads).toContain(`/api/session/ses_browse_${number}/message`)
    expect(server.posts).toHaveLength(0)
  })
}

test("finder shows main sessions by default without excluding children from search", async () => {
  const server = fixture({ active: false })
  server.sessions.unshift({
    ...server.sessions[0]!,
    id: "ses_child",
    parentID: "ses_running",
    title: "Delegate investigation",
  })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("▶ Review the server"))
  expect(view.captureCharFrame()).not.toContain("Delegate investigation")
  await view.mockInput.typeText("Delegate")
  await waitForFrame(view, (frame) => frame.includes("▶ Delegate investigation"))
  expect(view.captureCharFrame()).toContain("[child]")
  expect(view.captureCharFrame()).toContain("1/1")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  expect(server.posts).toHaveLength(0)
})

test("Ctrl+K finds sessions across projects and Escape leaves the current session alone", async () => {
  const server = fixture()
  server.sessions.push({
    ...server.sessions[0]!,
    id: "ses_second",
    title: "Inspect API latency",
    agent: "plan",
    location: { directory: "/srv/backend" },
  })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  expect(view.captureCharFrame()).toContain("Sessions Ctrl+K")
  expect(view.captureCharFrame()).not.toContain("+ New session")
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("backend plan")
  await waitForFrame(view, (frame) => frame.includes("Inspect API latency"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("backend plan")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("/srv/backend"))
  expect(view.captureCharFrame()).toContain("Inspect API latency")
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("▶ * Review the server"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("Review the server"))
  expect(server.posts).toHaveLength(0)
})

test("Escape then Alt arrows or Ctrl+K switches sessions with the saved reply's original recipient", async () => {
  const server = fixture()
  server.sessions.push({
    ...server.sessions[0]!,
    id: "ses_second",
    title: "Another session",
    location: { directory: "/srv/second" },
  })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("/srv/second"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("/srv/project"))
  // Hopping keeps the reply editor closed, so f opens it.
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Keep this reply here")
  await leaveComposer(view)
  // The session is running, so Esc's notice arms the stop; the prompt line shows the draft was kept.
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  await view.mockInput.typeText("Another")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("/srv/second"))
  // A session picked in Ctrl+K opens its reply editor, where Alt+Left moves by word; Esc first to hop.
  await leaveComposer(view)
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Keep this reply here"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/prompt",
    body: { prompt: { text: "Keep this reply here" } },
  })
})

test("narrowing the terminal transfers arrow navigation away from the hidden session list", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.resize(70, 24)
  view.mockInput.pressArrow("down")
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Review the server")
  expect(view.captureCharFrame()).not.toContain("Another session")
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  expect(server.posts).toHaveLength(0)
})

test("session shortcuts retain the departing terminal filter and hop first from another view", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("Build")
  view.mockInput.pressEnter()
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  view.mockInput.pressKey("i")
  await waitForFrame(view, (frame) => frame.includes("ses_running"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("ses_running"))
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242") && frame.includes("Find: Build"))
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Another")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  await leaveComposer(view)
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242") && frame.includes("Find: Build"))
  expect(server.posts).toHaveLength(0)
})

test("session visits restore reading position and history without undoing user scrolling", async () => {
  const options = {
    text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: a useful update.`).join("\n\n"),
    history: true,
  }
  const server = fixture(options)
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Paragraph 79:"))
  // A narrow terminal opens on the reply editor, where Alt+Left/Right move by word; Esc first to hop.
  await leaveComposer(view)
  view.mockInput.pressKey("\x1b[5~")
  await view.renderOnce()
  view.mockInput.pressKey("\x1b[6~")
  const scrolled = await waitForFrame(view, (frame) => frame.includes("Paragraph ") && !frame.includes("Paragraph 0:"))
  const paragraph = scrolled.match(/Paragraph \d+:/)![0]
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Another session") && frame.includes("Paragraph 79:"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(
    view,
    (frame) => frame.includes("Review the server") && frame.match(/Paragraph \d+:/)?.[0] === paragraph,
  )
  view.mockInput.pressKey("\x1b[5~")
  const further = await waitForFrame(
    view,
    (frame) => frame.includes("Paragraph ") && frame.match(/Paragraph \d+:/)?.[0] !== paragraph,
  )
  const next = further.match(/Paragraph \d+:/)![0]
  options.text += "\n\nA new update arrived."
  await app.refresh()
  await waitForFrame(view, (frame) => frame.match(/Paragraph \d+:/)?.[0] === next)
  view.mockInput.pressKey("h")
  await waitForFrame(
    view,
    (frame) => frame.includes("History ·") && frame.includes("test/local") && frame.includes("Paragraph 0:"),
  )
  view.mockInput.pressKey("\x1b[6~")
  const history = await waitForFrame(view, (frame) => frame.includes("Paragraph ") && !frame.includes("Paragraph 0:"))
  const previous = history.match(/Paragraph \d+:/)![0]
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Another session"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("History ·") && frame.match(/Paragraph \d+:/)?.[0] === previous)
  expect(server.posts).toHaveLength(0)
})

test("live transcript follows appended output, pauses while reading, and reveals a new question", async () => {
  const options = { text: Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n\n") }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Line 79"))
  options.text += "\n\nNewest live output"
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Newest live output"))
  view.mockInput.pressKey("\x1b[5~")
  await view.renderOnce()
  const first = view.captureCharFrame().match(/Line \d+/)?.[0]
  expect(first).toBeDefined()
  options.text += "\n\nLater output"
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame().match(/Line \d+/)?.[0]).toBe(first)
  expect(view.captureCharFrame()).not.toContain("Later output")
  server.pending.questions = [
    {
      id: "que_visible",
      sessionID: "ses_running",
      questions: [
        {
          header: "Choice",
          question: "Continue with the change?",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    },
  ]
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Continue with the change?"))
  expect(view.captureCharFrame()).toContain("Question 1 of 1")
  server.pending.questions = []
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame().match(/Line \d+/)?.[0]).toBe(first)
  expect(view.captureCharFrame()).not.toContain("Later output")
  // End moves the cursor in the reply editor, so jump to the latest output from navigation.
  await leaveComposer(view)
  view.mockInput.pressKey("END")
  await waitForFrame(view, (frame) => frame.includes("Later output"))
  server.pending.questions = [
    {
      id: "que_again",
      sessionID: "ses_running",
      questions: [
        {
          header: "Confirm",
          question: "Ready for more?",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    },
  ]
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Ready for more?"))
  server.pending.questions = []
  options.text += "\n\nResumed after answering"
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Resumed after answering"))
  expect(server.posts).toHaveLength(0)
})

test("reply stays beside fresh conversation output and retains its recipient during inventory changes", async () => {
  const options = { text: "Original message to answer.", active: false }
  const server = fixture(options)
  const original = server.sessions[0]!
  server.sessions.push({ ...original, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("Reply to the original session")
  await waitForFrame(
    view,
    (frame) =>
      frame.includes("Original message to answer.") && frame.includes("Typing") && frame.includes("Enter send"),
  )
  options.text = "A fresh update arrived while composing."
  server.historical.set(original.id, original)
  server.sessions.splice(0, 1)
  await app.refresh()
  await waitForFrame(
    view,
    (frame) => frame.includes("A fresh update arrived") && frame.includes("Reply to the original session"),
  )
  // The reply goes to the session in view, which the title already names, so the editor has no heading repeating it.
  expect(view.captureCharFrame()).not.toContain("Reply to Review the server")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/prompt",
    body: { prompt: { text: "Reply to the original session" } },
  })
})

for (const input of ["j", "scrollbar"] as const) {
  test(`${input} scrolling cancels a pending reading-position restore before polling`, async () => {
    const server = fixture({
      text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: a useful update.`).join("\n\n"),
    })
    const view = await createTestRenderer({ width: 70, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    await waitForFrame(view, (frame) => frame.includes("Paragraph 79:"))
    view.mockInput.pressKey("\x1b[5~")
    await view.renderOnce()
    if (input === "j") {
      await leaveComposer(view)
      view.mockInput.pressKey("j")
    }
    if (input === "scrollbar") {
      const find = (node: Renderable): ScrollBoxRenderable | undefined => {
        if (node instanceof ScrollBoxRenderable && node.scrollHeight > node.viewport.height) return node
        for (const child of node.getChildren()) {
          const found = find(child)
          if (found) return found
        }
      }
      const slider = find(view.renderer.root)!.verticalScrollBar.slider
      await view.mockMouse.click(slider.x, slider.y + Math.floor(slider.height * 0.6))
    }
    const moved = await waitForFrame(view, (frame) => frame.includes("Paragraph ") && !frame.includes("Paragraph 0:"))
    await app.refresh()
    await view.renderOnce()
    expect(view.captureCharFrame().match(/Paragraph \d+:/)?.[0]).toBe(moved.match(/Paragraph \d+:/)?.[0])
    expect(server.posts).toHaveLength(0)
  })
}

test("repeated Enter on a busy docked reply sends exactly one POST and blocks edits and navigation", async () => {
  const server = fixture({ postDelay: 300 })
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Send this exact reply")
  view.mockInput.pressEnter()
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Submitting"))
  expect(view.captureCharFrame()).toContain("Sending message")
  await view.mockInput.pressKeys(["\r", "\n", "\x1b[57414u"])
  await view.mockInput.typeText("Do not append this either")
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressArrow("right", { meta: true })
  view.mockInput.pressKey("n", { ctrl: true })
  await clickText(view, "2 Ter")
  await clickText(view, "+ New session")
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Another session"))
  await view.mockMouse.click(lines[y]!.indexOf("Another session") + 1, y)
  await view.mockInput.pasteBracketedText("Do not append this")
  view.mockInput.pressEnter()
  view.mockInput.pressKey("s", { ctrl: true })
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Send this exact reply")
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/prompt",
    body: { prompt: { text: "Send this exact reply" } },
  })
  expect(server.reads).not.toContain("/api/session/ses_second/message")
})

for (const form of ["permission", "question", "kill"] as const) {
  test(`${form} pins its recipient and blocks abandonment ${form === "question" ? "while submitting" : "while open"}`, async () => {
    const server = fixture({ active: false, postDelay: form === "question" ? 3000 : undefined })
    server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
    server.pending.permissions = [
      { id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] },
    ]
    server.pending.questions = [
      {
        id: "que_test",
        sessionID: "ses_running",
        questions: [
          {
            header: "Scope",
            question: "Which files?",
            options: [{ label: "Source", description: "Source files" }],
            custom: false,
          },
        ],
      },
    ]
    const view = await createTestRenderer({ width: 120, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    await waitForFrame(view, (frame) => frame.includes("Permission request"))
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => !frame.includes("Permission request"))
    const rows = view.captureCharFrame().split("\n")
    const targets = ["2 Ter", "+ New session", "Find a session", "Sessions Ctrl+K", "Another session"].map((label) => {
      const y = rows.findIndex((line) => line.includes(label))
      expect(y).toBeGreaterThanOrEqual(0)
      return [rows[y]!.indexOf(label) + 1, y] as const
    })
    if (form === "kill") {
      view.mockInput.pressKey("p", { ctrl: true })
      await view.mockInput.typeText("kill")
      view.mockInput.pressEnter()
    } else view.mockInput.pressKey(form === "permission" ? "p" : "o")
    const send = form === "permission" ? "Ctrl+S confirms Reject" : "Ctrl+S kill"
    await waitForFrame(view, (frame) => frame.includes(form === "question" ? "Question 1 of 1" : send))
    if (form === "question") {
      view.mockInput.pressEnter()
      await waitForFrame(view, (frame) => frame.includes("Review answers"))
      view.mockInput.pressKey("s", { ctrl: true })
    }
    const hint = form === "question" ? "Submitting…" : send
    await waitForFrame(view, (frame) => frame.includes(hint))
    view.mockInput.pressKey("k", { ctrl: true })
    view.mockInput.pressArrow("right", { meta: true })
    view.mockInput.pressKey("n", { ctrl: true })
    for (const [x, y] of targets) await view.mockMouse.click(x, y)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain(hint)
    expect(view.captureCharFrame()).not.toContain("What would you like to do?")
    expect(view.captureCharFrame()).not.toContain("Switch session")
    expect(server.reads).not.toContain("/api/session/ses_second/message")

    server.sessions.shift()
    await app.refresh()
    view.resize(70, 24)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Review the server")
    expect(view.captureCharFrame()).not.toContain("Another session")
    expect(server.reads).not.toContain("/api/session/ses_second/message")
    if (form === "permission") view.mockInput.pressArrow("down")
    if (form === "kill") await view.mockInput.typeText("kill")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) =>
      frame.includes(
        form === "permission" ? "Allowed once." : form === "question" ? "Answers sent." : "Session killed.",
      ),
    )
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0]).toMatchObject(
      form === "permission"
        ? { path: "/api/session/ses_running/permission/per_test/reply", body: { reply: "once" } }
        : form === "question"
          ? { path: "/api/session/ses_running/question/que_test/reply", body: { answers: [["Source"]] } }
          : { path: "/api/session/ses_running/interrupt" },
    )
  })
}

test("Escape explicitly abandons an unanswered request and permits navigation", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p")
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request"))
  await clickText(view, "2 Ter")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  expect(server.posts).toHaveLength(0)
})

for (const submitted of [false, true]) {
  test(`directory changes during discovery ${submitted ? "retain the submitted retry identity" : "cannot carry the old agent into a saved draft"}`, async () => {
    const options = {
      agentDelay: 0,
      failPromptOnce: submitted,
      agents: { "/srv/project": ["build"], "/srv/other": ["review"] },
    }
    const server = fixture(options)
    const view = await createTestRenderer({ width: 120, height: 38 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey("n")
    await view.mockInput.typeText("Keep the task identity")
    view.mockInput.pressTab()
    view.mockInput.pressTab()
    await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
    view.mockInput.pressArrow("down")
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => frame.includes("Draft kept"))
    view.mockInput.pressKey("n")
    await waitForFrame(view, (frame) => frame.includes("▶ build"))
    if (submitted) {
      view.mockInput.pressKey("s", { ctrl: true })
      await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
    }
    options.agentDelay = 200
    view.mockInput.pressTab()
    view.mockInput.pressKey("a", { ctrl: true })
    for (let index = 0; index < "/srv/project".length; index++) view.mockInput.pressKey("DELETE")
    await view.mockInput.typeText("/srv/other")
    view.mockInput.pressTab()
    await waitForFrame(view, (frame) => frame.includes("Loading agents"))
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => frame.includes(submitted ? "Original submission kept" : "Draft kept"))
    view.mockInput.pressKey("n")
    await waitForFrame(view, (frame) => frame.includes("Keep the task identity"))
    view.mockInput.pressTab()
    view.mockInput.pressTab()
    await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
    const lines = view.captureCharFrame().split("\n")
    expect(lines[lines.findIndex((line) => line.includes("Directory on the server")) + 1]).toContain(
      submitted ? "/srv/project" : "/srv/other",
    )
    if (!submitted) expect(view.captureCharFrame()).not.toContain("▶ build")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("Task sent."))
    expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
    if (submitted) expect(server.posts[2]).toEqual(server.posts[1])
    if (!submitted) {
      expect(server.posts[0]?.body).toMatchObject({ location: { directory: "/srv/other" } })
      expect(server.posts[0]?.body.agent).toBeUndefined()
    }
  })
}

for (const inspect of [false, true]) {
  test(`launch ${inspect ? "inspection" : "success"} preserves the departing tab's filter and selection`, async () => {
    const server = fixture({ failPromptOnce: inspect })
    const view = await createTestRenderer({ width: 120, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey("2")
    await waitForFrame(view, (frame) => frame.includes("PID 4242"))
    view.mockInput.pressKey("/")
    await view.mockInput.typeText("worker")
    view.mockInput.pressEnter()
    view.mockInput.pressKey("n")
    await view.mockInput.typeText("Launch from terminals")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes(inspect ? "Ctrl+O inspect" : "Task sent."))
    if (inspect) view.mockInput.pressKey("o", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("New agent") && !frame.includes("What would you like to do?"))
    await leaveComposer(view)
    view.mockInput.pressKey("2")
    await waitForFrame(view, (frame) => frame.includes("PID 4242") && frame.includes("Find: worker"))
    expect(server.posts).toHaveLength(2)
  })
}

test("saved replies remain findable outside recent inventory and revalidate before sending", async () => {
  const server = fixture({ active: false })
  const original = server.sessions[0]!
  server.sessions.push({ ...original, id: "ses_other", title: "Other work" })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("A recoverable saved reply")
  await leaveComposer(view)
  await waitForFrame(view, (frame) => frame.includes("Message draft kept"))
  server.sessions.shift()
  server.historical.set(original.id, original)
  await app.refresh()
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Other work"))
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review")
  await waitForFrame(view, (frame) => frame.includes("draft"))
  view.mockInput.pressEnter()
  // Opening the saved session opens its reply editor by itself, with the draft.
  await waitForFrame(view, (frame) => frame.includes("A recoverable saved reply"))
  server.historical.clear()
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Session not found"))
  expect(server.posts).toHaveLength(0)
  server.historical.set(original.id, original)
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]).toMatchObject({
    path: `/api/session/${original.id}/prompt`,
    body: { prompt: { text: "A recoverable saved reply" } },
  })
})

test("older session lookup validates IDs and retains exact results across refresh", async () => {
  const server = fixture({ more: true })
  server.historical.set("ses_archive", { ...server.sessions[0]!, id: "ses_archive", title: "Archived investigation" })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("ses_archive")
  view.mockInput.pressKey("o", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Open session by ID"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Archived investigation") && !frame.includes("Open session by ID"))
  await app.refresh()
  expect(view.captureCharFrame()).toContain("Archived investigation")
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressKey("o", { ctrl: true })
  await view.mockInput.typeText("../../invalid")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("valid session ID"))
  expect(server.reads.some((path) => path.includes("invalid"))).toBe(false)
  expect(server.posts).toHaveLength(0)
})

test("history paging preserves pages at boundaries, on refresh, and on session switches", async () => {
  const server = fixture({ pages: true })
  server.sessions.push({ ...server.sessions[0]!, id: "ses_other", title: "Other work" })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await leaveComposer(view)
  view.mockInput.pressKey("h")
  await waitForFrame(
    view,
    (frame) => frame.includes("History ·") && frame.includes("[ Older") && frame.includes("Inspecting the server"),
  )
  view.mockInput.pressKey("]")
  await waitForFrame(view, (frame) => frame.includes("Newest history page."))
  expect(view.captureCharFrame()).toContain("Inspecting the server")
  await clickText(view, "[ Older")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  await app.refresh()
  expect(view.captureCharFrame()).toContain("original task on the older page")
  view.mockInput.pressKey("[")
  await waitForFrame(view, (frame) => frame.includes("Start of history reached."))
  expect(view.captureCharFrame()).toContain("original task on the older page")
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Other work"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("original task on the older page") && frame.includes("History"))
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  view.mockInput.pressKey("]")
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server") && frame.includes("History"))
  expect(server.messageCursors).toContain("older")
  expect(server.messageCursors).toContain("newer")
  expect(server.posts).toHaveLength(0)
})

test("history paging waits for the restored page instead of using Latest cursors", async () => {
  const server = fixture({ pages: true, messageDelay: 100 })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("h")
  await waitForFrame(
    view,
    (frame) => frame.includes("History ·") && frame.includes("[ Older") && frame.includes("Inspecting the server"),
  )
  view.mockInput.pressKey("[")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  const before = server.messageCursors.length
  view.mockInput.pressKey("h")
  view.mockInput.pressKey("[")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  expect(server.messageCursors.slice(before)).toEqual(["older"])
  expect(server.posts).toHaveLength(0)
})

test("queued reply keeps its visible delivery mode and identity after an uncertain send", async () => {
  const server = fixture({ failPromptOnce: true })
  server.sessions[0] = {
    ...server.sessions[0]!,
    title: "A long session title that fills more than fifty terminal columns",
  }
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Follow this after pending steers")
  view.mockInput.pressKey("t", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Queue · sent when"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  view.mockInput.pressKey("t", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("original delivery mode"))
  view.mockInput.pressEscape()
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Queue · sent when"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply queued."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[0]).toEqual(server.posts[1])
  expect(server.posts[0]?.body.delivery).toBe("queue")
})

test("question rejection is explicit, reversible before submission, and session-bound", async () => {
  const server = fixture()
  server.pending.questions = [
    {
      id: "que_test",
      sessionID: "ses_running",
      questions: [
        {
          header: "Scope",
          question: "Which files?",
          options: [{ label: "Source", description: "Source files" }],
          custom: false,
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("confirm rejection"))
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Ctrl+S confirm rejection")
    expect(server.posts).toHaveLength(0)
  }
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  expect(view.captureCharFrame()).toContain("Source")
  view.mockInput.pressKey("r", { ctrl: true })
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Question rejected."))
  expect(server.posts).toEqual([{ path: "/api/session/ses_running/question/que_test/reject", body: {} }])
})

for (const kind of ["terminals", "automations"] as const) {
  test(`${kind} failures are visible without disabling replies and recover independently`, async () => {
    const options = { ptyStatus: kind === "terminals" ? 500 : 0, loopStatus: kind === "automations" ? 500 : 0 }
    const server = fixture(options)
    const view = await createTestRenderer({ width: 70, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    expect(view.captureCharFrame()).not.toContain("Disconnected")
    await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
    await view.mockInput.typeText("Session work remains available")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("Reply sent."))
    await leaveComposer(view)
    view.mockInput.pressKey(kind === "terminals" ? "2" : "3")
    await waitForFrame(view, (frame) => frame.includes("HTTP 500"))
    expect(view.captureCharFrame()).toContain("Sessions remain available")
    options.ptyStatus = 0
    options.loopStatus = 0
    await app.refresh()
    await waitForFrame(view, (frame) => frame.includes(kind === "terminals" ? "PID 4242" : "Nightly checks"))
  })
}

test("automation run failures preserve the overview", async () => {
  const server = fixture({ runStatus: 500 })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("3")
  await waitForFrame(view, (frame) => frame.includes("Run history unavailable"))
  expect(view.captureCharFrame()).toContain("Review overnight changes")
  expect(view.captureCharFrame()).not.toContain("Details unavailable")
})

test("mouse pane focus stays synchronized with Tab and dialog restoration", async () => {
  const server = fixture({ text: "Mouse focus target" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const list = descendants(view.renderer.root).find((node) => node instanceof SessionListRenderable)!
  const detail = descendants(view.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable && !(node instanceof SessionListRenderable),
  )!
  await waitForFrame(view, (frame) => frame.includes("Mouse focus target"))
  await clickText(view, "Mouse focus target")
  expect(detail.focused).toBe(true)
  view.mockInput.pressTab()
  expect(list.focused).toBe(true)
  view.mockInput.pressTab()
  await view.renderOnce()
  const row = descendants(list).find(
    (node) => node instanceof TextRenderable && node.plainText.includes("Review the server"),
  )!
  await view.mockMouse.click(row.x + 3, row.y)
  // Clicking a session opens it with typing in its reply editor.
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  expect(view.renderer.currentFocusedEditor).not.toBeNull()
  await leaveComposer(view)
  expect(detail.focused).toBe(true)
  view.mockInput.pressKey("?")
  await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  expect(detail.focused).toBe(true)
  view.mockInput.pressTab()
  expect(list.focused).toBe(true)
})

test("clicking draft labels and non-field space leaves its editor ready for typing", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 80, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  // The narrow terminal starts typing, so Esc frees the shortcut keys first.
  await leaveComposer(view)
  for (const [key, caption] of [
    ["n", "What would you like to do?"],
    ["f", "Message…"],
  ]) {
    view.mockInput.pressKey(key!)
    if (key === "f") await waitForFrame(view, (frame) => frame.includes(caption!))
    await clickText(view, caption!)
    const editor = descendants(view.renderer.root).find((node) => node instanceof TextareaRenderable)!
    expect(editor.focused).toBe(true)
    await view.mockInput.typeText("Still typing in the draft")
    expect(editor.plainText).toBe("Still typing in the draft")
    await view.renderOnce()
    if (key === "n") await view.mockMouse.click(editor.x + 2, editor.y + editor.height)
    if (key === "f") await clickText(view, "Enter send")
    expect(editor.focused).toBe(true)
    await view.mockInput.typeText(" after clicking")
    expect(editor.plainText).toBe("Still typing in the draft after clicking")
    view.mockInput.pressKey("F4")
  }
  expect(server.posts).toHaveLength(0)
})

test("long paths cannot displace header actions or footer shortcuts at supported sizes", async () => {
  const server = fixture({ directory: "/srv/projects/terminal-workbench/packages/runtime" })
  const view = await createTestRenderer({ width: 160, height: 48 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  for (const [width, height] of [
    [160, 48],
    [60, 24],
  ]) {
    view.resize(width!, height!)
    await view.renderOnce()
    const frame = view.captureCharFrame()
    // Below 70 columns the buttons give way to the run state; their keys stay in help and the palette.
    expect(frame.includes("Sessions Ctrl+K")).toBe(width! >= 70)
    expect(frame.includes("Models m")).toBe(width! >= 70)
    // The palette stays in the footer on wide screens; a narrow footer keeps to the next action and help.
    expect(frame).toContain(width! < 90 ? "? help" : "Ctrl+P commands")
  }
  view.mockInput.pressKey("n")
  await view.renderOnce()
  // At 60 columns the buttons are gone whichever dialog is open.
  expect(view.captureCharFrame()).not.toContain("Models")
  expect(view.captureCharFrame()).not.toContain("Sessions Ctrl+K")
})

test("activity animation pauses behind the resize shield, supports reduced motion, and stops when idle", async () => {
  const options = { active: true }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 80, height: 28 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => /Working \(Esc Esc to stop\) [\u2800-\u28ff]{3}/.test(frame))
  const bar = descendants(view.renderer.root).find(
    (node) => node instanceof TextRenderable && /^Working \(Esc Esc to stop\) [\u2800-\u28ff]{3}$/.test(node.plainText),
  ) as TextRenderable
  const first = bar.plainText
  await Bun.sleep(250)
  expect(bar.plainText).not.toBe(first)
  view.resize(59, 23)
  await view.renderOnce()
  const hidden = bar.plainText
  expect(bar.visible).toBe(false)
  await Bun.sleep(200)
  expect(bar.plainText).toBe(hidden)
  view.resize(80, 28)
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Toggle reduced motion")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reduced motion on"))
  const reduced = bar.plainText
  await Bun.sleep(200)
  expect(bar.plainText).toBe(reduced)
  options.active = false
  await app.refresh()
  expect(bar.visible).toBe(false)
  expect(bar.plainText).toBe("")
})

test("runTui closes a connection whose dashboard fails to mount, reports it, and tears down on exit", async () => {
  // Isolate startup mocks so the real renderer/HTTP integration tests above
  // keep their module bindings. Only the terminal boundary is substituted.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { mock } from "bun:test"
    import { createTestRenderer } from "@opentui/core/testing"
    const core = await import("@opentui/core")
    const server = await import("./src/server")
    const connect = server.connect
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ healthy: true }) })
    const view = await createTestRenderer({ width: 80, height: 24 })
    let created = 0
    let closed = 0
    let destroyed = false
    view.renderer.once("destroy", () => { destroyed = true })
    // The server picker mounts first; fail the dashboard that follows it.
    const add = view.renderer.root.add.bind(view.renderer.root)
    let adds = 0
    view.renderer.root.add = (...args) => {
      if (++adds === 2) throw new Error("mount failure")
      return add(...args)
    }
    Object.defineProperty(process.stdin, "isTTY", { value: true })
    Object.defineProperty(process.stdout, "isTTY", { value: true })
    mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => view.renderer }))
    mock.module("./src/server", () => ({ ...server, connect: (options) => {
      created++
      const connection = connect(options)
      const close = connection.close
      return { ...connection, close: () => { closed++; close() } }
    } }))
    const { runTui } = await import("./src/index")
    const running = runTui({ url: upstream.url.origin })
    for (let attempt = 0; closed === 0 && attempt < 200; attempt++) await Bun.sleep(25)
    await view.renderOnce()
    const reported = view.captureCharFrame().includes("mount failure")
    view.renderer.destroy()
    await running
    upstream.stop(true)
    if (!reported || created !== 1 || closed !== 1 || !destroyed) throw new Error("Startup cleanup failed")
    console.log("cleanup verified")
  `,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, XDG_CONFIG_HOME: "/nonexistent-turen-tui-config" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, error }).toEqual({ code: 0, error: "" })
  expect(output).toContain("cleanup verified")
})
