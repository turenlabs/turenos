import { expect, test } from "bun:test"
import { agent, document } from "./agent-fixture"
import { turen, type Route } from "./support"

const room = { id: "trm_team", name: "Team", topic: "Ship it", head: 2 }
const retro = { id: "trm_retro", name: "retro", topic: "", head: 1, archived: true }
const factoryRoom = {
  id: "trm_fact",
  name: "Factory",
  topic: "",
  head: 0,
  factory: {
    revision: 3,
    config: {
      outcome: "Ship the report",
      parameters: {},
      constraints: "",
      acceptanceCriteria: "Reviewed",
      directory: "/srv/main",
      coordinatorTeammateID: "tm_moss",
      teammateIDs: ["tm_moss"],
    },
  },
}
const teammate = (handle: string, status = "active", created = 1, roomID = "trm_team") => ({
  id: `tm_${handle}`,
  roomID,
  name: handle.toUpperCase(),
  handle,
  role: "Engineer",
  mission: "",
  status,
  directory: "/srv/main",
  time: { created, updated: created },
})
const message = (seq: number, text: string, extra: Record<string, unknown> = {}) => ({
  id: `msg_${seq}`,
  roomID: "trm_team",
  seq,
  kind: "human",
  author: "You",
  text,
  time: Date.UTC(2026, 9, 8, 9, seq),
  ...extra,
})
const task = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "job_1",
  roomID: "trm_team",
  messageID: "msg_2",
  teammateID: "tm_moss",
  sessionID: "ses_work",
  status,
  time: { created: 2, updated: 2 },
  ...extra,
})
const factoryRun = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "run-1",
  roomID: "trm_fact",
  status,
  phase: status === "running" ? "work" : "done",
  taskIDs: ["job_f"],
  time: { created: 5, updated: 6 },
  ...extra,
})

const rooms = [room, retro, factoryRoom]

/** What the state route answers for a room, by ID; the default room is `trm_team`. */
function state(roomID: string | null, limit = 100) {
  const current = rooms.find((item) => item.id === (roomID ?? "trm_team"))!
  const mates = current.id === "trm_team" ? [teammate("moss"), teammate("rae", "paused", 2)] : []
  const messages = current.id === "trm_team" ? [message(1, "Welcome"), message(2, "Review @moss\nplease")] : []
  return {
    rooms,
    room: current,
    teammates: current.id === "trm_fact" ? [teammate("moss", "active", 1, "trm_fact")] : mates,
    messages: messages.slice(-limit),
    tasks: current.id === "trm_team" ? [task("running"), task("succeeded", { id: "job_0" })] : [],
    duties: [],
    factoryRuns: current.id === "trm_fact" ? [factoryRun("succeeded", { result: "All good\nnext line" })] : [],
    hasMore: false,
  }
}

const stateRoute: Route = (_, url) =>
  state(url.searchParams.get("roomID"), Number(url.searchParams.get("limit") ?? 100))

function team(routes: Record<string, Route> = {}) {
  return turen({ routes: { "GET /api/team": stateRoute, ...routes } })
}

const conflict = () =>
  Response.json({ _tag: "ConflictError", message: "Archived rooms are read-only" }, { status: 409 })

test("a server from before Team rooms is named as such, not as a bare 404", async () => {
  const server = turen({ routes: {} })
  const result = await agent(["team", "rooms"], { url: server.url })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("no Team rooms")
  expect(result.stderr).not.toContain("HTTP 404")
})

test("team rooms lists active rooms in one request, and --all adds archived ones", async () => {
  const reads: string[] = []
  const server = team({
    "GET /api/team": (request, url) => {
      reads.push(url.search)
      return stateRoute(request, url)
    },
  })
  const text = await agent(["team", "rooms"], { url: server.url })
  expect(text.code).toBe(0)
  expect(reads).toHaveLength(1)
  expect(text.stdout.split("\n").filter(Boolean)).toEqual([
    "room trm_team · Team · Ship it",
    "room trm_fact · Factory",
    "1 archived room hidden; --all shows them.",
  ])
  const all = document(await agent(["team", "rooms", "--all", "--json"], { url: server.url }))
  expect(all.rooms).toEqual([
    { id: "trm_team", name: "Team", topic: "Ship it", archived: false },
    { id: "trm_retro", name: "retro", topic: "", archived: true },
    { id: "trm_fact", name: "Factory", topic: "", archived: false },
  ])
  expect((await agent(["team", "rooms", "--all"], { url: server.url })).stdout).toContain("· archived")
})

test("team show prints the room, teammates, messages set in by four spaces, active tasks and no factory", async () => {
  const server = team()
  const result = await agent(["team", "show"], { url: server.url })
  expect(result.code).toBe(0)
  const lines = result.stdout.split("\n")
  expect(lines.slice(0, 6)).toEqual([
    "room trm_team · Team",
    "topic: Ship it",
    "",
    "teammates:",
    "  @moss MOSS · Engineer · active",
    "  @rae RAE · Engineer · paused",
  ])
  const first = lines.findIndex((line) => line.endsWith(" You"))
  expect(lines.slice(first, first + 5)).toEqual([
    expect.stringMatching(/^\d\d:\d\d You$/),
    "    Welcome",
    expect.stringMatching(/^\d\d:\d\d You$/),
    "    Review @moss",
    "    please",
  ])
  expect(lines).toContain("task job_1 · @moss · running · session ses_work")
  expect(lines).toContain("  wait: turen-tui wait ses_work")
  expect(result.stdout).not.toContain("job_0")
  expect(result.stdout).not.toContain("factory:")
  const json = document(await agent(["team", "show", "--limit", "1", "--json"], { url: server.url }))
  expect(Object.keys(json)).toEqual(["room", "teammates", "messages", "tasks", "factoryRuns", "truncated"])
  expect(json.messages).toHaveLength(1)
  expect(json.tasks).toHaveLength(2)
  expect(server.requests.at(-1)?.path).toBe("/api/team")
})

test("team show names what a teammate's reply answers between the author and the text", async () => {
  const reply = { kind: "teammate", author: "MOSS", teammateID: "tm_moss" }
  const server = team({
    "GET /api/team": () => ({
      ...state(null),
      messages: [
        message(2, "Review @moss\nplease"),
        message(3, "Looks good", { ...reply, replyTo: "msg_2" }),
        message(4, "Earlier point", { ...reply, replyTo: "msg_1" }),
      ],
    }),
  })
  const lines = (await agent(["team", "show"], { url: server.url })).stdout.split("\n")
  const first = lines.findIndex((line) => /^\d\d:\d\d @moss$/.test(line))
  expect(lines.slice(first, first + 6)).toEqual([
    expect.stringMatching(/^\d\d:\d\d @moss$/),
    "  ↳ reply to You: Review @moss please",
    "    Looks good",
    expect.stringMatching(/^\d\d:\d\d @moss$/),
    "  ↳ reply to a message not loaded",
    "    Earlier point",
  ])
})

test("team show names the factory and its latest run", async () => {
  const server = team()
  const result = await agent(["team", "show", "trm_fact"], { url: server.url })
  expect(result.stdout).toContain("factory: revision 3 · coordinator @moss · 1 teammate · Ship the report")
  expect(result.stdout).toContain("run run-1 · succeeded · done\n  result:\n    All good\n    next line")
  const json = document(await agent(["team", "show", "trm_fact", "--json"], { url: server.url }))
  expect(json).toHaveProperty("factory")
})

test("a room is found by id or exact name in any case; ambiguity is a usage error and an unknown name fails", async () => {
  const asked: (string | null)[] = []
  const server = team({
    "GET /api/team": (request, url) => {
      asked.push(url.searchParams.get("roomID"))
      return stateRoute(request, url)
    },
  })
  expect((await agent(["team", "show", "fACTORY"], { url: server.url })).stdout).toStartWith("room trm_fact · Factory")
  expect(asked.at(-1)).toBe("trm_fact")
  expect((await agent(["team", "show", "trm_retro"], { url: server.url })).code).toBe(0)

  const twins = turen({
    routes: { "GET /api/team": () => ({ ...state(null), rooms: [room, { ...room, id: "trm_other" }] }) },
  })
  const ambiguous = await agent(["team", "show", "team"], { url: twins.url })
  expect(ambiguous.code).toBe(2)
  expect(ambiguous.stderr).toContain("trm_team, trm_other")
  const missing = await agent(["team", "show", "nothing"], { url: server.url })
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain('No room named "nothing"')
})

/** A post route that stores a message by its ID, as the real server does, and may lose the first acknowledgement. */
function posting(options: { lose?: boolean } = {}) {
  const stored = new Map<string, string>()
  const lost = { next: options.lose ?? false }
  const server = team({
    "POST /api/team/message": async (request) => {
      const body = (await request.json()) as { id: string; roomID: string; text: string }
      stored.set(body.id, body.text)
      if (lost.next) {
        lost.next = false
        return new Response("down", { status: 503 })
      }
      return { message: message(3, body.text, { id: body.id }), tasks: /@moss/.test(body.text) ? [task("queued")] : [] }
    },
  })
  return { server, stored }
}

test("team post sends a client id, names the created task and the command that waits for it", async () => {
  const { server, stored } = posting()
  const result = await agent(["team", "post", "Team", "@moss check the build"], { url: server.url })
  expect(result.code).toBe(0)
  const [id] = [...stored.keys()]
  expect(id).toMatch(/^msg_[0-9a-f]{32}$/)
  expect(result.stdout).toBe(
    `posted ${id}\ntask job_1 · @moss · queued · session ses_work\n  wait: turen-tui wait ses_work\n`,
  )
  expect(server.requests.find((item) => item.path === "/api/team/message")?.body).toEqual({
    id,
    roomID: "trm_team",
    text: "@moss check the build",
  })
})

test("team post without a mention says who replies, reads stdin, and notes a mention that made no task", async () => {
  const { server } = posting()
  const piped = await agent(["team", "post", "trm_team", "-"], { url: server.url, stdin: "anything new?\n" })
  expect(piped.stdout).toEndWith("no mention · @moss (coordinator) replies\n")
  const paused = await agent(["team", "post", "trm_team", "@rae and @ghost"], { url: server.url })
  expect(paused.stdout).toContain("@rae is paused; no task was created")
  expect(paused.stdout).not.toContain("@ghost")
  expect(paused.stderr).toContain("@ghost is not in this room; no task was created")
  expect(document(await agent(["team", "post", "trm_team", "hi", "--json"], { url: server.url })).coordinator).toBe(
    "moss",
  )
})

test("a lost acknowledgement prints the ID, and the retry with --id re-sends the same one", async () => {
  const { server, stored } = posting({ lose: true })
  const first = await agent(["team", "post", "team", "@moss go", "--json"], { url: server.url })
  expect(first.code).toBe(1)
  const error = document(first).error as { message: string; retry: { id: string } }
  expect(error.message).toContain("Outcome unknown: Server returned HTTP 503")
  expect(error.message).toContain(`turen-tui team post "team" --id ${error.retry.id}`)
  expect(error.retry.id).toMatch(/^msg_/)
  const retried = await agent(["team", "post", "team", "@moss go", "--id", error.retry.id], { url: server.url })
  expect(retried.code).toBe(0)
  expect(retried.stdout).toStartWith(`posted ${error.retry.id}\n`)
  expect([...stored.keys()]).toEqual([error.retry.id])
})

test("a refusal says nothing was posted, for a 400 and for an archived room's 409", async () => {
  const bad = team({
    "POST /api/team/message": () => Response.json({ _tag: "InvalidRequestError", message: "No" }, { status: 400 }),
  })
  const refused = await agent(["team", "post", "team", "hello", "--json"], { url: bad.url })
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("The server refused the message (No). Nothing was posted.")
  expect(document(refused).error).not.toHaveProperty("retry")
  const archived = team({ "POST /api/team/message": conflict })
  const result = await agent(["team", "post", "trm_retro", "hello"], { url: archived.url })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Archived rooms are read-only). Nothing was posted.")
  expect(result.stderr).not.toContain("Outcome unknown")
  expect(result.stderr).toContain("Restore it in the dashboard (4, then d).")
  // A room that is not archived has nothing to restore.
  const busy = team({
    "POST /api/team/message": () => Response.json({ _tag: "ConflictError", message: "Busy" }, { status: 409 }),
  })
  expect((await agent(["team", "post", "trm_team", "hello"], { url: busy.url })).stderr).not.toContain("Restore")
})

test("team post sends a mention that made no task to stderr and leaves stdout as the result", async () => {
  const { server } = posting()
  const json = await agent(["team", "post", "trm_team", "@ghost hi", "--json"], { url: server.url })
  expect(json.code).toBe(0)
  expect(document(json)).toMatchObject({ ok: true, room: "trm_team" })
  expect(json.stderr).toBe("turen-tui: @ghost is not in this room; no task was created\n")
  const text = await agent(["team", "post", "trm_team", "@ghost hi"], { url: server.url })
  expect(text.code).toBe(0)
  expect(text.stdout).toMatch(/^posted msg_[0-9a-f]{32}\n$/)
})

test("team rooms says how many archived rooms it hides, and its help promises only what it prints", async () => {
  const server = team()
  expect((await agent(["team", "rooms"], { url: server.url })).stdout).toEndWith(
    "1 archived room hidden; --all shows them.\n",
  )
  expect((await agent(["team", "rooms", "--all"], { url: server.url })).stdout).not.toContain("hidden")
  const help = await agent(["team", "--help"], {})
  expect(help.stdout).not.toContain("teammate counts")
  expect(help.stdout).toContain("List rooms: id, name and topic")
})

test("team run refused for an active run names that run and the command that waits for it", async () => {
  const running = factoryRun("running", { id: "run-live" })
  const busy = team({
    "GET /api/team": (_, url) => ({
      ...state(url.searchParams.get("roomID")),
      factoryRuns: url.searchParams.get("roomID") === "trm_fact" ? [running] : [],
    }),
    "POST /api/team/room/trm_fact/factory/run": () =>
      Response.json(
        { _tag: "ConflictError", message: "A factory run is already active in this room" },
        { status: 409 },
      ),
  })
  const result = await agent(["team", "run", "trm_fact"], { url: busy.url })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Nothing was started.")
  expect(result.stderr).toContain("Active run: run-live. Wait with: turen-tui team wait run-live\n")
})

test("team wait and cancel on an unknown run say where runs are listed, and cancel leaves a finished run alone", async () => {
  const cancels: string[] = []
  const missing = () =>
    Response.json(
      { _tag: "InvalidRequestError", message: "Factory run run-9 not found", kind: "Team.NotFoundError" },
      { status: 400 },
    )
  const server = team({
    "GET /api/team/factory-run/run-9": missing,
    "GET /api/team/factory-run/run-1": () => factoryRun("succeeded"),
    "POST /api/team/factory-run/run-1/cancel": () => {
      cancels.push("run-1")
      return factoryRun("cancelled")
    },
  })
  for (const command of ["wait", "cancel"]) {
    const result = await agent(["team", command, "run-9"], { url: server.url })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("turen-tui: Factory run run-9 not found. List runs with: turen-tui team show <room>\n")
  }
  const done = await agent(["team", "cancel", "run-1"], { url: server.url })
  expect(done.code).toBe(0)
  expect(done.stdout).toBe("run run-1 already succeeded; nothing to cancel.\n")
  expect(document(await agent(["team", "cancel", "run-1", "--json"], { url: server.url }))).toMatchObject({
    ok: true,
    run: { id: "run-1", status: "succeeded" },
  })
  expect(cancels).toEqual([])
})

test("team run starts a run with a UUID id; a room without a factory fails before anything is sent", async () => {
  const sent: { id: string; roomID: string; request?: string }[] = []
  const server = team({
    "POST /api/team/room/trm_fact/factory/run": async (request) => {
      const body = (await request.json()) as (typeof sent)[number]
      sent.push(body)
      return factoryRun("running", { id: body.id })
    },
  })
  const started = await agent(["team", "run", "factory", "make the report"], { url: server.url })
  expect(started.code).toBe(0)
  expect(sent[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(sent[0]?.request).toBe("make the report")
  expect(started.stdout).toBe(`started ${sent[0]!.id} · running · work\n  wait: turen-tui team wait ${sent[0]!.id}\n`)
  const none = await agent(["team", "run", "Team"], { url: server.url })
  expect(none.code).toBe(1)
  expect(none.stderr).toContain("Room Team has no factory. Configure it in the dashboard (4, then F).")
  expect(sent).toHaveLength(1)
  expect((await agent(["team", "run", "factory", "x".repeat(4001)], { url: server.url })).code).toBe(2)
})

test("team run with a lost acknowledgement is an unknown outcome that --id retries", async () => {
  const seen: string[] = []
  const lose = { next: true }
  const server = team({
    "POST /api/team/room/trm_fact/factory/run": async (request) => {
      const body = (await request.json()) as { id: string }
      seen.push(body.id)
      if (!lose.next) return factoryRun("running", { id: body.id })
      lose.next = false
      return new Response("down", { status: 503 })
    },
  })
  const first = await agent(["team", "run", "trm_fact", "--json"], { url: server.url })
  expect(first.code).toBe(1)
  const error = document(first).error as { message: string; retry: { id: string } }
  expect(error.message).toContain(`turen-tui team run "trm_fact" --id ${error.retry.id}`)
  const retried = await agent(["team", "run", "trm_fact", "--id", error.retry.id], { url: server.url })
  expect(retried.code).toBe(0)
  expect(seen).toEqual([error.retry.id, error.retry.id])
})

test("team cancel prints the run's final status", async () => {
  const server = team({
    "GET /api/team/factory-run/run-1": () => factoryRun("running"),
    "POST /api/team/factory-run/run-1/cancel": () => factoryRun("cancelled"),
  })
  expect((await agent(["team", "cancel", "run-1"], { url: server.url })).stdout).toBe("run run-1 · cancelled · done\n")
  const missing = turen({
    routes: {
      "GET /api/team/factory-run/run-9": () =>
        Response.json(
          { _tag: "InvalidRequestError", message: "Factory run run-9 not found", kind: "Team.NotFoundError" },
          { status: 400 },
        ),
    },
  })
  expect((await agent(["team", "cancel", "run-9"], { url: missing.url })).code).toBe(1)
})

function waiting(run: unknown, extra: Record<string, Route> = {}) {
  return team({ "GET /api/team/factory-run/run-1": () => run, ...extra })
}

test("team wait exits 0 with the result of a succeeded run", async () => {
  const server = waiting(factoryRun("succeeded", { result: "All good" }))
  const result = await agent(["team", "wait", "run-1"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("run run-1 · succeeded · done\n  result:\n    All good\n")
})

test("team wait exits 5 and prints the error of a failed, cancelled or stale run", async () => {
  for (const status of ["failed", "cancelled", "stale"]) {
    const server = waiting(factoryRun(status, { error: "Check rejected" }))
    const result = await agent(["team", "wait", "run-1"], { url: server.url })
    expect(result.code).toBe(5)
    expect(result.stdout).toBe(`run run-1 · ${status} · done\n  error: Check rejected\n`)
  }
})

test("team wait exits 3 with the coordinator's question, the task sessions and the commands that resolve their requests", async () => {
  const question = "Which database should the migration target?"
  const server = waiting(factoryRun("needs_input", { result: question }), {
    "GET /api/team": () => ({
      ...state("trm_fact"),
      tasks: [task("running", { id: "job_f", roomID: "trm_fact", factoryRunID: "run-1", sessionID: "ses_work" })],
      factoryRuns: [],
      teammates: [teammate("moss", "active", 1, "trm_fact")],
    }),
    "GET /api/session/ses_work/permission": () => ({
      data: [{ id: "per_1", sessionID: "ses_work", action: "bash", resources: ["ls"] }],
    }),
    "GET /api/session/ses_work/question": () => ({ data: [] }),
  })
  const result = await agent(["team", "wait", "run-1"], { url: server.url })
  expect(result.code).toBe(3)
  expect(result.stdout).toContain("run run-1 · needs_input · done\n")
  expect(result.stdout).toContain(question)
  expect(result.stdout.indexOf(question)).toBeLessThan(result.stdout.indexOf("task job_f"))
  expect(result.stdout).toContain("task job_f · @moss · running · session ses_work")
  expect(result.stdout).toContain("  approve: turen-tui approve ses_work per_1")
  const json = document(await agent(["team", "wait", "run-1", "--json"], { url: server.url }))
  expect((json.run as { result: string }).result).toBe(question)
  expect((json.tasks as { pending: { permissions: unknown[] } }[])[0]!.pending.permissions).toHaveLength(1)
})

test("team wait exits 4 on timeout, and keeps waiting through a 503 until the run finishes", async () => {
  const running = waiting(factoryRun("running"))
  const timedOut = await agent(["team", "wait", "run-1", "--timeout", "1"], { url: running.url })
  expect(timedOut.code).toBe(4)
  expect(timedOut.stdout).toBe(
    "run run-1 · timeout (still running after 1s; run turen-tui team wait run-1 to keep waiting)\n",
  )

  const polls = { count: 0 }
  const flaky = waiting(null, {
    "GET /api/team/factory-run/run-1": () => {
      polls.count++
      if (polls.count === 2) return new Response("restarting", { status: 503 })
      return factoryRun(polls.count < 4 ? "running" : "succeeded", { result: "done" })
    },
  })
  const result = await agent(["team", "wait", "run-1", "--timeout", "30"], { url: flaky.url })
  expect(result.code).toBe(0)
  expect(polls.count).toBe(4)
}, 30_000)

test("team usage errors exit 2 and name what is valid", async () => {
  const server = team()
  for (const args of [
    ["team"],
    ["team", "frobnicate"],
    ["team", "rooms", "--limit", "5"],
    ["team", "show", "--all"],
    ["team", "show", "--limit", "101"],
    ["team", "show", "a", "b"],
    ["team", "post"],
    ["team", "post", "Team", "--timeout", "3"],
    ["team", "post", "Team", "hi", "--id", "bad id"],
    ["team", "wait"],
    ["team", "cancel", "a", "b"],
  ])
    expect((await agent(args, { url: server.url })).code).toBe(2)
  const unknown = await agent(["team", "frobnicate"], { url: server.url })
  expect(unknown.stderr).toContain("Use one of: rooms, show, post, run, cancel, wait")
  expect(server.requests).toHaveLength(0)
})

test("team --help lists every subcommand without a server", async () => {
  const result = await agent(["team", "--help"], {})
  expect(result.code).toBe(0)
  for (const word of ["team rooms", "team show", "team post", "team run", "team cancel", "team wait"])
    expect(result.stdout).toContain(word)
})
