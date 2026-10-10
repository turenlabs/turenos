import { expect, test } from "bun:test"
import { agent, document } from "./agent-fixture"
import { turen } from "./support"
import { room, message, task, state, stateRoute, team } from "./agent-team-fixture"

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
