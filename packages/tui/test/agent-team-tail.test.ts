import { expect, test } from "bun:test"
import { agent, document } from "./agent-fixture"
import { message, state, team } from "./agent-team-fixture"

/** A room of messages 1..count that answers `after`, `before` and `limit` as the server does. */
function history(count: number, grow?: { at: number; count: number }) {
  const total = { count }
  const queries: string[] = []
  const server = team({
    "GET /api/team": (_, url) => {
      queries.push(url.search)
      const seqs = Array.from({ length: total.count }, (_, index) => index + 1)
      const limit = Number(url.searchParams.get("limit") ?? 100)
      const after = url.searchParams.get("after")
      const before = url.searchParams.get("before")
      const pool = seqs.filter(
        (seq) => (after === null || seq > Number(after)) && (before === null || seq < Number(before)),
      )
      const page = after === null ? pool.slice(-limit) : pool.slice(0, limit)
      return { ...state(null), messages: page.map((seq) => message(seq, `m${seq}`)), hasMore: pool.length > limit }
    },
  })
  if (grow) setTimeout(() => (total.count = grow.count), grow.at)
  return { server, queries }
}

const seqs = (json: Record<string, unknown>) => (json.messages as { seq: number }[]).map((item) => item.seq)

test("--after returns only newer messages, oldest first, and says whether more follow", async () => {
  const { server, queries } = history(10)
  const json = document(await agent(["team", "show", "--after", "4", "--limit", "3", "--json"], { url: server.url }))
  expect(seqs(json)).toEqual([5, 6, 7])
  expect(json.truncated).toBe(true)
  expect(queries.at(-1)).toContain("after=4")
  const last = document(await agent(["team", "show", "--after", "7", "--json"], { url: server.url }))
  expect(seqs(last)).toEqual([8, 9, 10])
  expect(last.truncated).toBe(false)
  const text = await agent(["team", "show", "--after", "9"], { url: server.url })
  expect(text.stdout).toContain("m10")
  expect(text.stdout).not.toContain("m9\n")
})

test("--before pages older messages", async () => {
  const { server, queries } = history(10)
  const json = document(await agent(["team", "show", "--before", "6", "--limit", "2", "--json"], { url: server.url }))
  expect(seqs(json)).toEqual([4, 5])
  expect(json.truncated).toBe(true)
  expect(queries.at(-1)).toContain("before=6")
  const older = document(
    await agent(["team", "show", "--before", "4", "--limit", "2", "--json"], { url: server.url }),
  )
  expect(seqs(older)).toEqual([2, 3])
  const help = await agent(["team", "--help"])
  expect(help.stdout).toContain("the first for --before")
})

test("both cursors, a bad seq, and --wait or --timeout out of place are usage errors that send nothing", async () => {
  const { server, queries } = history(3)
  const cases = [
    ["--after", "1", "--before", "3"],
    ["--after", "-1"],
    ["--after", "1.5"],
    ["--before", "abc"],
    ["--after", "99999999999999999999"],
    ["--after", "9007199254740992"],
    ["--wait"],
    ["--before", "3", "--wait"],
    ["--after", "1", "--timeout", "5"],
  ]
  for (const args of cases) {
    const result = await agent(["team", "show", ...args], { url: server.url })
    expect(result.code).toBe(2)
  }
  expect(queries).toHaveLength(0)
  expect((await agent(["team", "show", "--after", "0"], { url: server.url })).code).toBe(0)
  expect((await agent(["team", "show", "--after", "9007199254740991"], { url: server.url })).code).toBe(0)
})

test("--wait returns at once when a newer message exists, and once one arrives otherwise", async () => {
  const ready = history(3)
  const now = document(await agent(["team", "show", "--after", "2", "--wait", "--json"], { url: ready.server.url }))
  expect(seqs(now)).toEqual([3])
  const later = history(3, { at: 700, count: 4 })
  const started = Date.now()
  const result = await agent(["team", "show", "Team", "--after", "3", "--wait", "--timeout", "20", "--json"], {
    url: later.server.url,
  })
  expect(result.code).toBe(0)
  expect(seqs(document(result))).toEqual([4])
  expect(Date.now() - started).toBeLessThan(15_000)
  // The room name is resolved once; later polls read it by ID.
  expect(later.queries.filter((query) => query.includes("roomID=trm_team")).length).toBeGreaterThan(1)
})

test("--wait times out with exit 4 and still prints one document", async () => {
  const { server } = history(3)
  const json = await agent(["team", "show", "--after", "3", "--wait", "--timeout", "1", "--json"], { url: server.url })
  expect(json.code).toBe(4)
  const parsed = document(json)
  expect(parsed.status).toBe("timeout")
  expect(parsed.messages).toEqual([])
  expect(parsed.truncated).toBe(false)
  const text = await agent(["team", "show", "--after", "3", "--wait", "--timeout", "1"], { url: server.url })
  expect(text.code).toBe(4)
  expect(text.stdout).toContain("--after 3 --wait")
})

test.each([400, 404])("a room deleted while waiting fails with one JSON error document (HTTP %i)", async (status) => {
  const reads = { count: 0 }
  const server = team({
    "GET /api/team": () =>
      ++reads.count === 1
        ? { ...state(null), messages: [] }
        : Response.json(
            status === 400
              ? { _tag: "InvalidRequestError", kind: "Team.NotFoundError", message: "Room not found" }
              : { _tag: "Team.NotFoundError", message: "Room not found" },
            { status },
          ),
  })
  const result = await agent(["team", "show", "--after", "2", "--wait", "--timeout", "5", "--json"], {
    url: server.url,
  })
  expect(result.code).toBe(1)
  expect(document(result)).toEqual({ error: { message: "Room trm_team was deleted while waiting." } })
  expect(reads.count).toBe(2)
})

test("a missing Team route on the first wait read keeps the older-server guidance", async () => {
  const server = team({ "GET /api/team": () => new Response(null, { status: 404 }) })
  const result = await agent(["team", "show", "--after", "2", "--wait", "--json"], { url: server.url })
  expect(result.code).toBe(1)
  expect(document(result)).toEqual({
    error: { message: "This server has no Team rooms; they need TurenOS 1.0.43 or later." },
  })
})

test("a temporary server failure during a room wait retries before returning new messages", async () => {
  const reads = { count: 0 }
  const server = team({
    "GET /api/team": () => {
      reads.count++
      if (reads.count === 1) return { ...state(null), messages: [] }
      if (reads.count === 2) return new Response(null, { status: 503 })
      return { ...state(null), messages: [message(3, "recovered reply")] }
    },
  })
  const result = await agent(["team", "show", "--after", "2", "--wait", "--timeout", "8", "--json"], {
    url: server.url,
  })
  expect(result.code).toBe(0)
  expect(seqs(document(result))).toEqual([3])
  expect(reads.count).toBe(3)
})
