import { expect, test } from "bun:test"
import { connect, errorText } from "../src/server"
import { ClientError } from "@turenlabs/client"
import { session, fixture } from "./server-fixture"

test("HTTP failures show status-specific advice without inventing a status", async () => {
  const server = fixture()
  for (const [status, message] of [
    [401, "Authentication required. Check the server credentials."],
    [403, "Authentication required. Check the server credentials."],
    [503, "Server returned HTTP 503. Retry; if it persists, check the server logs."],
    [404, "Server returned HTTP 404. Check the server URL, requested item, and API version."],
    [409, "Server returned HTTP 409. Check the request and server logs."],
  ] as const) {
    server.routes.set("/api/health", new Response(null, { status }))
    expect(await server.connection.client.health.get().catch(errorText)).toBe(message)
  }
  for (const cause of [undefined, { status: "503" }, { status: NaN }, { status: 999 }]) {
    expect(errorText(new ClientError("UnexpectedStatus", { cause }))).toBe(
      "Server returned an unexpected HTTP response. Check the server logs.",
    )
  }
})

test("local directory mistakes make no requests and retain distinct server validation errors", async () => {
  const server = fixture()
  const hint = "Enter an absolute directory on the server, such as /srv/project."
  expect(() => connect({ url: "https://example.com", directory: "relative" })).toThrow(hint)
  const launch = server.connection.launch()
  for (const directory of ["", "relative", "/srv/\u001bproject", `/${"a".repeat(4096)}`]) {
    await expect(server.connection.agents(directory)).rejects.toThrow(hint)
    await expect(launch({ directory, prompt: "Review this" })).rejects.toThrow(hint)
    expect(launch.input()).toBeUndefined()
  }
  expect(server.calls).toEqual([])
  expect((await server.connection.agents("/srv/project"))[0]?.id).toBe("build")
  server.routes.set("/api/location", { directory: "relative" })
  await expect(server.connection.snapshot()).rejects.toMatchObject({
    reason: "Transport",
    cause: { message: "Invalid server response (absolute directory)." },
  })
})

test("invalid local agent and model choices stay editable before admission", async () => {
  const server = fixture({
    "/api/session": async (request: Request) => {
      const body = (await request.json()) as { id: string }
      server.routes.set(`/api/session/${body.id}/prompt`, async (request: Request) => {
        const prompt = (await request.json()) as { id: string }
        return Response.json({ data: { id: prompt.id, sessionID: body.id } })
      })
      return Response.json({ data: session(body.id) })
    },
  })
  const launch = server.connection.launch()
  const input = { directory: "/srv/project", prompt: "Review this" }
  for (const model of ["provider-only", "provider/", "provider/model\u202e", `provider/${"a".repeat(513)}`]) {
    await expect(launch({ ...input, model })).rejects.toThrow("provider/model")
    expect(launch.input()).toBeUndefined()
  }
  await expect(launch({ ...input, agent: "reviewer\u001b" })).rejects.toThrow("Choose a valid agent")
  expect(launch.input()).toBeUndefined()
  expect(server.calls).toEqual([])
  expect((await launch({ ...input, model: "local/model", agent: "team/reviewer" })).id).toBe(launch.sessionID)
  expect(server.calls).toEqual(["/api/session", `/api/session/${launch.sessionID}/prompt`])
})

test("no-content approvals and interruptions remain valid", async () => {
  const server = fixture({
    "/api/session/ses_test/permission/per_test/reply": new Response(null, { status: 204 }),
    "/api/session/ses_test/question/que_test/reply": new Response(null, { status: 204 }),
    "/api/session/ses_test/interrupt": new Response(null, { status: 204 }),
  })
  await server.connection.client.permissions.reply({ sessionID: "ses_test", requestID: "per_test", reply: "reject" })
  await server.connection.client.questions.reply({ sessionID: "ses_test", requestID: "que_test", answers: [["yes"]] })
  await server.connection.client.sessions.interrupt({ sessionID: "ses_test" })
  expect(server.calls).toHaveLength(3)
})

test("launch never posts the prompt to a substituted session", async () => {
  const server = fixture({ "/api/session": { data: session("ses_other") } })
  await expect(server.connection.launch()({ directory: "/srv/project", prompt: "Review this" })).rejects.toMatchObject({
    reason: "Transport",
    cause: { message: "Invalid server response (session identity)." },
  })
  expect(server.calls).toEqual(["/api/session"])
})

test("launch rejects a mismatched prompt acknowledgment and retries the original identifiers", async () => {
  const prompts: { id: string; sessionID: string }[] = []
  const server = fixture({
    "/api/session": async (request: Request) => {
      const body = (await request.json()) as { id: string }
      server.routes.set(`/api/session/${body.id}/prompt`, async (request: Request) => {
        const prompt = (await request.json()) as { id: string }
        prompts.push({ id: prompt.id, sessionID: body.id })
        return Response.json({ data: { id: prompts.length === 1 ? "msg_wrong" : prompt.id, sessionID: body.id } })
      })
      return Response.json({ data: session(body.id) })
    },
  })
  const launch = server.connection.launch()
  const input = { directory: "/srv/project", prompt: "Review this" }
  await expect(launch(input)).rejects.toMatchObject({
    reason: "Transport",
    cause: { message: "Invalid server response (prompt message identity)." },
  })
  await launch(input)
  expect(prompts[0]).toEqual(prompts[1])
  expect(server.calls.filter((path) => path === "/api/session")).toHaveLength(1)
})

test("permissions, questions, pending input, and message ownership must match the selected session", async () => {
  const server = fixture()
  for (const [route, value] of [
    ["permission", { data: [{ id: "per_test", sessionID: "ses_other", action: "shell", resources: [] }] }],
    ["question", { data: [{ id: "que_test", sessionID: "ses_other", questions: [] }] }],
    ["input", { data: [{ id: "msg_test", sessionID: "ses_other" }] }],
    [
      "message",
      {
        data: [{ id: "msg_test", type: "user", text: "Wrong session", sessionID: "ses_other", time: { created: 1 } }],
        cursor: {},
      },
    ],
  ] as const) {
    const path = `/api/session/ses_test/${route}`
    const original = server.routes.get(path)
    server.routes.set(path, value)
    await expect(server.connection.detail("ses_test")).rejects.toMatchObject({
      reason: "Transport",
      cause: { message: "Invalid server response (session identity)." },
    })
    server.routes.set(path, original)
  }
  const calls = server.calls.length
  await expect(server.connection.detail("__proto__")).rejects.toThrow("identifier")
  expect(server.calls).toHaveLength(calls)
})

test("automation schedules preserve interval and cron fields and reject malformed consumed fields", async () => {
  const server = fixture()
  for (const schedule of [
    { type: "interval", seconds: 3600, timezone: "UTC" },
    { type: "cron", seconds: 3600, expression: "0 2 * * *", timezone: "America/New_York" },
  ] as const) {
    const loop = {
      id: "loop_test",
      name: "Nightly checks",
      status: "active",
      prompt: "Review overnight changes",
      location: { directory: "/srv/project" },
      schedule,
    }
    server.routes.set("/api/loop", [loop])
    expect((await server.connection.snapshot()).loops[0]?.schedule).toEqual(schedule)
    for (const field of ["type", "timezone", ...(schedule.type === "cron" ? ["expression"] : [])]) {
      for (const value of [undefined, null, false, 42, {}, ["cron"], "", "\u001b", "\u202e", "x".repeat(513)]) {
        server.routes.set("/api/loop", [{ ...loop, schedule: { ...schedule, [field]: value } }])
        const snapshot = await server.connection.snapshot()
        expect(snapshot.loops).toEqual([])
        expect(snapshot.inventoryErrors.automations).toContain("Invalid server response")
      }
    }
    server.routes.set("/api/loop", [{ ...loop, schedule: { ...schedule, type: "weekly" } }])
    const snapshot = await server.connection.snapshot()
    expect(snapshot.loops).toEqual([])
    expect(snapshot.inventoryErrors.automations).toBe("Connection failed: Invalid server response (status).")
  }
})

test("automation eventTrigger is validated for file-change and session-end structures", async () => {
  const baseLoop = {
    id: "loop_event_test",
    name: "Event automation",
    status: "active",
    prompt: "Respond to events",
    location: { directory: "/srv/project" },
    schedule: { type: "interval", seconds: 60, timezone: "UTC" },
  }
  const server = fixture({ "/api/loop": [] })

  // Valid file-change trigger
  server.routes.set("/api/loop", [
    {
      ...baseLoop,
      eventTrigger: { type: "file-change", paths: ["src/**/*.ts"], debounceMs: 250 },
    },
  ])
  let snapshot = await server.connection.snapshot()
  expect(snapshot.loops).toHaveLength(1)
  expect(snapshot.loops[0]?.eventTrigger?.type).toBe("file-change")

  // Valid session-end trigger
  server.routes.set("/api/loop", [
    {
      ...baseLoop,
      eventTrigger: { type: "session-end", outcomes: ["failure"], agent: "builder", sessionID: "ses_review" },
    },
  ])
  snapshot = await server.connection.snapshot()
  expect(snapshot.loops).toHaveLength(1)
  expect(snapshot.loops[0]?.eventTrigger?.type).toBe("session-end")

  // Invalid trigger type
  server.routes.set("/api/loop", [
    {
      ...baseLoop,
      eventTrigger: { type: "webhook" },
    },
  ])
  snapshot = await server.connection.snapshot()
  expect(snapshot.loops).toEqual([])
  expect(snapshot.inventoryErrors.automations).toContain("Invalid server response")

  // Invalid file-change trigger without paths
  server.routes.set("/api/loop", [
    {
      ...baseLoop,
      eventTrigger: { type: "file-change", paths: "not-an-array" },
    },
  ])
  snapshot = await server.connection.snapshot()
  expect(snapshot.loops).toEqual([])
  expect(snapshot.inventoryErrors.automations).toContain("Invalid server response")
})

test("automation history is bounded and belongs to the selected automation", async () => {
  const run = { loopID: "loop_test", status: "succeeded", trigger: "manual", time: { created: 1, updated: 1 } }
  const runs = Array.from({ length: 12 }, (_, i) => ({ ...run, id: `run_${i}` }))
  const server = fixture({ "/api/loop/loop_test/run": runs })
  expect(await server.connection.runs("loop_test")).toHaveLength(10)
  server.routes.set("/api/loop/loop_test/run", [{ ...run, id: "run_wrong", loopID: "loop_other" }])
  await expect(server.connection.runs("loop_test")).rejects.toMatchObject({
    reason: "Transport",
    cause: { message: "Invalid server response (automation identity)." },
  })
  // Enter opens a run's session, so a run naming a malformed session is refused before it can.
  server.routes.set("/api/loop/loop_test/run", [{ ...run, id: "run_1", sessionID: "not-a-session" }])
  await expect(server.connection.runs("loop_test")).rejects.toMatchObject({
    cause: { message: "Invalid server response (identifier)." },
  })
})

test("each snapshot request has its own deadline, so a slow link still completes", async () => {
  const server = fixture()
  const slow = (body: unknown) => () => Bun.sleep(2200).then(() => Response.json(body))
  // Five sequential rounds of 2.2 s: the recent page, two batches of missing active sessions, the
  // root list and the terminal inventory. Each is well under the deadline; together they pass 10 s.
  const active = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`ses_active${i}`, { type: "running" }]))
  server.routes.set("/api/session/active", { data: active })
  server.routes.set("/api/session", slow({ data: [], cursor: {} }))
  for (let index = 0; index < 9; index++)
    server.routes.set(
      `/api/session/ses_active${index}`,
      slow({ data: { ...session(), id: `ses_active${index}`, parentID: "ses_root" } }),
    )
  server.routes.set("/api/pty", slow({ location: { directory: "/srv/project" }, data: [] }))
  const snapshot = await server.connection.snapshot()
  expect(snapshot.sessions).toHaveLength(9)
  expect(snapshot.terminalsAvailable).toBe(true)
}, 25000)
