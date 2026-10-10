import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeLive } from "../src/conversation/live-cache"
import { submitLaunch } from "../src/launch/submit"
import { LOST_EVENT, liveEvents } from "../src/live-events"
import { connect } from "../src/server"
import { createServers } from "../src/servers"
import { memberForm } from "../src/team/member-form"
import { emptyView } from "../src/team/types"
import { backspace, cleanup, dashboard, session, turen, until } from "./support"
import { room } from "./team-fixture"

test("editing a queued message that starts with ! sends it as a message, not a shell command", async () => {
  const { server, view } = await editQueued()
  view.mockInput.pressEnter()
  await until(() => server.sent("/api/session/ses_main/prompt").length > 0)
  expect(server.sent("/api/session/ses_main/shell")).toHaveLength(0)
  expect(server.sent("/api/session/ses_main/prompt")[0]?.body).toMatchObject({ prompt: { text: "!echo queued" } })
})

test("a ! typed again after the restored message is cleared starts a shell command", async () => {
  const { view, screen } = await editQueued()
  for (const _ of "!echo queued") backspace(view)
  // A terminal sends each key on its own, so the editor sees the empty text before the next one.
  await screen("Enter send")
  await Bun.sleep(50)
  await view.mockInput.typeText("!ls")
  await screen("Shell command · Enter runs it on the server")
})

/** A dashboard with the queued message `!echo queued` taken back into the reply editor with Ctrl+E. */
async function editQueued() {
  const queued = { id: "msg_bang", sessionID: "ses_main", prompt: { text: "!echo queued" }, delivery: "queue" }
  const state = { inputs: [{ ...queued, admittedSeq: 1, timeCreated: 1 }] }
  const app = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: state.inputs }),
    "POST /api/session/ses_main/input/msg_bang/cancel": () => {
      state.inputs = []
      return { data: true }
    },
    "POST /api/session/ses_main/prompt": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_main", admittedSeq: 2 },
    }),
  })
  app.view.mockInput.pressKey("u")
  await app.screen("echo queued")
  app.view.mockInput.pressKey("e", { ctrl: true })
  await app.screen("Sent as a message, not a shell command")
  return app
}

test("a worktree retry after Directory changed asks for a new worktree there", async () => {
  const calls: { directory: string; name: string; retry: boolean }[] = []
  const start = Object.assign(async () => ({}), { input: () => undefined, messageID: "msg_s", sessionID: "ses_s" })
  const form = {
    deps: {
      state: { connected: true, sentMessages: new Set() },
      say: () => {},
      connection: {
        worktree: async (directory: string, name: string, retry: boolean) => {
          calls.push({ directory, name, retry })
          throw new Error("uncertain")
        },
      },
    },
    current: { directory: "/project-a", prompt: "hello", model: "", start },
    directory: { value: "/project-a" },
    model: { value: "" },
    task: { plainText: "hello", cursorOffset: 5 },
    agent: { getSelectedIndex: () => 0 },
    workspace: { getSelectedIndex: () => 1 },
    dialog: { error: { content: "" } },
    loaded: "/project-a",
  }
  await submitLaunch(form as never).catch(() => {})
  await submitLaunch(form as never).catch(() => {})
  form.directory.value = "/project-b"
  await submitLaunch(form as never).catch(() => {})
  expect(calls.map((call) => [call.directory, call.retry])).toEqual([
    ["/project-a", false],
    ["/project-a", true],
    ["/project-b", false],
  ])
  expect(calls[1]!.name).toBe(calls[0]!.name)
  expect(calls[2]!.name).not.toBe(calls[0]!.name)
})

test("a private server start that was already stopped spawns nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "tui-headless-"))
  const marker = join(home, "spawned")
  const binary = join(home, "forge")
  await Bun.write(binary, `#!/bin/sh\necho $$ > ${marker}\nexec sleep 30\n`)
  await Bun.$`chmod +x ${binary}`
  const servers = createServers({
    home,
    platform: "linux",
    env: { XDG_CONFIG_HOME: home, FORGE_DB: join(home, "db") },
    forge: binary,
    config: join(home, "servers.json"),
    persistentRecord: join(home, "none.json"),
  })
  cleanup.push(() => servers.stopHeadless())
  const stopped = new AbortController()
  stopped.abort()
  const target = { kind: "headless", id: "headless", name: "private", binary } as const
  expect(
    await servers.resolve(target, { signal: stopped.signal }).then(
      () => "resolved",
      () => "rejected",
    ),
  ).toBe("rejected")
  await Bun.sleep(200)
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("the first live message kept after older ones are evicted gets its own header", () => {
  const step = (n: number) => ({
    id: `msg_${n}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: n, completed: n + 1 },
    finish: "tool-calls",
    content: [{ id: `text_${n}`, type: "text", text: "x ".repeat(25000) }],
  })
  const c = {
    state: { selected: "ses_a", expandToolOutput: false, snapshot: { sessions: [{ id: "ses_a" }] } },
    live: new Map(),
    positions: new Map(),
    hooks: { say: () => {} },
    generation: 0,
  }
  const cached = mergeLive(c as never, [1, 2, 3, 4, 5, 6, 7].map(step) as never)
  expect(cached.capped).toBe(true)
  expect(cached.messages[0]!.continued).toBe(false)
  expect(cached.messages[0]!.formatted).toStartWith("`build` · test/model")
})

test("a live frame dropped as too large is reported, so the transcript can be read again", async () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        [
          frame({ id: "evt_1", type: "server.connected", data: {} }),
          // An empty event is not a dropped one.
          "data:\n\n",
          `data: ${"x".repeat(1024 * 1024 + 10)}\n\n`,
          frame({ id: "evt_2", type: "session.next.step.started", data: {} }),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  cleanup.push(() => listener.stop(true))
  const types: string[] = []
  for await (const event of liveEvents(new URL(listener.url.origin), new Headers(), new AbortController().signal))
    types.push(event.type)
  expect(types).toEqual(["server.connected", LOST_EVENT, "session.next.step.started"])
})

test("a teammate form reopened after the room changed closes instead of saving to another room", () => {
  const said: string[] = []
  const opened: string[] = []
  const ctx = {
    state: { team: { ...emptyView(), room: { ...room, id: "trm_other", name: "other" } } },
    say: (text: string) => said.push(text),
    dialogs: { open: (title: string) => void opened.push(title) },
  }
  memberForm(ctx as never, { roomID: room.id, back: () => {}, saved: () => {} })
  expect(opened).toEqual([])
  expect(said).toEqual(["The room changed while you chose, so the teammate form closed unsaved."])
})

test("every running session is checked for pending input across snapshots, eight at a time", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `run${String(index).padStart(2, "0")}`)
  const running = names.map((name) => `ses_${name}`)
  const server = turen({
    routes: {
      "GET /api/session/active": () => ({ data: Object.fromEntries(running.map((id) => [id, { type: "running" }])) }),
      "GET /api/session/ses_run11/permission": () => ({
        data: [{ id: "per_1", sessionID: "ses_run11", action: "shell", resources: ["ls"] }],
      }),
      ...Object.fromEntries(
        names.map((name) => [`GET /api/session/ses_${name}`, () => ({ data: session(name) })] as const),
      ),
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  expect((await connection.snapshot()).needsInput).toBeUndefined()
  expect((await connection.snapshot()).needsInput).toEqual(["ses_run11"])
  expect((await connection.snapshot()).needsInput).toEqual(["ses_run11"])
})
