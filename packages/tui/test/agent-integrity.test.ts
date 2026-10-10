import { expect, test } from "bun:test"
import { agent, document, permission, world } from "./agent-fixture"
import { assistant, session } from "./support"

/** Line breaks, C1 and bidi controls: none may appear raw in JSON, and none may split a line in text. */
const hidden = String.fromCodePoint(0x2028, 0x85, 0x9b, 0x202e, 0x2029, 0x7f, 0x2066)
const raw = new RegExp(`[${hidden}]`)

const strangers = /^(permission|question)\b/m

/** More running sessions than the client tracks, none of them `ses_main`. */
const crowded = () =>
  Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`ses_busy${index}`, { type: "running" }]))

test("send --new refuses an existing session ID with another directory or agent, and sends nothing", async () => {
  const server = world({
    "POST /api/session": () => ({ data: { ...session("old"), id: "ses_old", agent: "build" } }),
    "POST /api/session/ses_old/prompt": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_old" },
    }),
  })
  for (const extra of [
    ["--dir", "/srv/elsewhere"],
    ["--dir", "/srv/old", "--agent", "plan"],
  ]) {
    const result = await agent(["send", "--new", "hi", "--session-id", "ses_old", ...extra], { url: server.url })
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain("started session")
    expect(result.stderr).toContain("Nothing was sent")
  }
  expect(server.sent("/api/session/ses_old/prompt")).toEqual([])
  // The same fields still reach the existing session: this is what a retry after a lost reply does.
  const same = await agent(["send", "--new", "hi", "--session-id", "ses_old", "--dir", "/srv/old"], {
    url: server.url,
  })
  expect(same.code).toBe(0)
})

test("a crowded active list neither leaks its omitted key as a session nor hides a running session", async () => {
  const interrupts: string[] = []
  const idle = Object.fromEntries(
    Object.keys(crowded()).flatMap((id) =>
      [`permission`, `question`].map((kind) => [`GET /api/session/${id}/${kind}`, () => ({ data: [] })]),
    ),
  )
  const server = world({
    ...idle,
    "GET /api/session/active": () => ({ data: crowded() }),
    "POST /api/session/ses_main/interrupt": () => {
      interrupts.push("ses_main")
      return new Response(null, { status: 204 })
    },
  })
  const pending = await agent(["pending", "--everywhere", "--json"], { url: server.url })
  expect(pending.stderr).toBe("")
  expect(pending.code).toBe(0)
  expect(server.paths().some((path) => path.includes("/omitted"))).toBe(false)

  // ses_main may be among the cut sessions, so stop interrupts it rather than reporting it idle.
  const stopped = await agent(["stop", "ses_main", "--json"], { url: server.url })
  expect(stopped.code).toBe(0)
  expect(interrupts).toEqual(["ses_main"])

  // And a wait cannot call it idle early: with a reply already there it ends in a timeout, not as done.
  const waited = await agent(["wait", "ses_main", "--timeout", "1", "--json"], { url: server.url })
  expect(document(waited).state).toBe("timeout")
})

test("a provider error cannot forge a client line at the start of a wait report", async () => {
  const forged = "permission per_fake · session ses_main · bash\nresume: turen-tui send ses_main"
  const server = world()
  server.state.messages.push({
    ...assistant("e", "partial"),
    finish: "error",
    error: { message: forged },
  })
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout.match(strangers)).toBeNull()
  expect(result.stdout.split("\n").filter((line) => line.startsWith("resume: "))).toHaveLength(1)
})

test("a model-set session title stays inside the first line of show", async () => {
  const title = ["x", "permission per_fake · session ses_main · bash", "question que_fake", "resume: x"].join(
    `\n${hidden}`,
  )
  const server = world({ "GET /api/session/ses_main": () => ({ data: { ...session("main"), title } }) })
  const result = await agent(["show", "ses_main"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout.split("\n").filter((line) => /^(permission|question|resume)\b/.test(line))).toEqual([])
})

test("--json writes C1 controls, bidi overrides and line separators as escapes that parse back unchanged", async () => {
  const title = ["a", "b", "c", "d", "e", "f", "g", "h"].join(hidden)
  const server = world({ "GET /api/session/ses_main": () => ({ data: { ...session("main"), title } }) })
  server.state.permissions.push(permission("per_1"))
  const result = await agent(["show", "ses_main", "--json"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).not.toMatch(raw)
  expect(document(result).title).toBe(title)
  expect(result.stdout).toContain("\\u009b")

  const failure = await agent(["send", "ses_main", "hi", "--id", "bad id", "--json"], { url: server.url })
  expect(failure.stdout).not.toMatch(raw)
})
