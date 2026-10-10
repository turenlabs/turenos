import { expect, test } from "bun:test"
import { agent, document } from "./agent-fixture"
import { turen, type Route } from "./support"
import { task, state, team, teammate, factoryRun } from "./agent-team-fixture"

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
