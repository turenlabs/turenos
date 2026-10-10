import { expect, test } from "bun:test"
import { session, fixture } from "./server-fixture"

test("a server without terminal inventory keeps sessions and agent selection available", async () => {
  const server = fixture({ "/api/pty": new Response(null, { status: 404 }) })
  const snapshot = await server.connection.snapshot()
  expect(snapshot.sessions[0]?.id).toBe("ses_test")
  expect(snapshot.terminalsAvailable).toBe(false)
  expect(snapshot.terminals).toEqual([])
  expect(snapshot.inventoryErrors).toEqual({ terminals: "", automations: "" })
  expect((await server.connection.agents("/srv/project"))[0]?.id).toBe("build")
})

test("terminal inventory is read per location and rejects a mismatched location", async () => {
  const project = { id: "project", directory: "/srv/project" }
  const server = fixture({
    "/api/pty": (request: Request) =>
      Response.json({
        location: { directory: new URL(request.url).searchParams.get("location[directory]"), project },
        data: [{ id: "pty_test", title: "Shell", command: "sh", args: [], cwd: "/srv", status: "running", pid: 1 }],
      }),
  })
  const snapshot = await server.connection.snapshot()
  expect(snapshot.terminals).toEqual([
    {
      id: "pty_test",
      title: "Shell",
      command: "sh",
      args: [],
      cwd: "/srv",
      status: "running",
      pid: 1,
      location: { directory: "/srv/project", project },
    },
  ])
  server.routes.set("/api/pty", { location: { directory: "/srv/elsewhere" }, data: [] })
  const mismatched = await server.connection.snapshot()
  expect(mismatched.terminalsAvailable).toBe(false)
  expect(mismatched.inventoryErrors.terminals).toBe(
    "Connection failed: Invalid server response (terminal location identity).",
  )
})

for (const path of ["/api/loop", "/api/pty"]) {
  test(`${path} HTTP 500 keeps required snapshot data without retaining stale inventory`, async () => {
    const server = fixture({
      "/api/session/active": { data: { ses_test: { type: "running" } } },
      "/api/pty": {
        location: { directory: "/srv/project" },
        data: [
          {
            id: "pty_test",
            title: "Shell",
            command: "sh",
            args: [],
            cwd: "/srv/project",
            status: "running",
            pid: 1,
          },
        ],
      },
      "/api/loop": [
        {
          id: "loop_test",
          name: "Checks",
          prompt: "Review changes",
          location: { directory: "/srv/project" },
          status: "active",
          schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
        },
      ],
    })
    const before = await server.connection.snapshot()
    expect(before.terminals).toHaveLength(1)
    expect(before.loops).toHaveLength(1)
    expect(before.inventoryErrors).toEqual({ terminals: "", automations: "" })
    const original = server.routes.get(path)
    server.routes.set(path, new Response(null, { status: 500 }))
    const snapshot = await server.connection.snapshot()
    expect(snapshot.sessions).toEqual(before.sessions)
    expect(snapshot.location).toEqual(before.location)
    expect(snapshot.active).toEqual(before.active)
    expect(snapshot.terminals).toEqual(path === "/api/pty" ? [] : before.terminals)
    expect(snapshot.terminalsAvailable).toBe(path !== "/api/pty")
    expect(snapshot.loops).toEqual(path === "/api/loop" ? [] : before.loops)
    const message = "Server returned HTTP 500. Retry; if it persists, check the server logs."
    expect(snapshot.inventoryErrors).toEqual({
      terminals: path === "/api/pty" ? message : "",
      automations: path === "/api/loop" ? message : "",
    })
    server.routes.set(path, original)
    const recovered = await server.connection.snapshot()
    expect(recovered.terminals).toEqual(before.terminals)
    expect(recovered.terminalsAvailable).toBe(true)
    expect(recovered.loops).toEqual(before.loops)
    expect(recovered.inventoryErrors).toEqual({ terminals: "", automations: "" })
  })

  test(`${path} authentication errors fail the entire snapshot even when the other inventory fails`, async () => {
    const server = fixture({
      "/api/loop": new Response(null, { status: 500 }),
      "/api/pty": new Response(null, { status: 500 }),
    })
    for (const response of [
      new Response("Authentication required", { status: 401 }),
      new Response("Forbidden", { status: 403 }),
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), { status: 403 }),
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 400 }),
    ]) {
      server.routes.set(path, response)
      await expect(server.connection.snapshot()).rejects.toMatchObject(
        response.status === 403
          ? { reason: "UnexpectedStatus", cause: { status: 403 } }
          : { _tag: "UnauthorizedError", message: expect.stringContaining("Authentication required") },
      )
    }
  })

  test(`${path} malformed inventory is rejected visibly without losing sessions`, async () => {
    const server = fixture({
      [path]: path === "/api/pty" ? { location: { directory: "/srv/project" }, data: "bad" } : { data: [] },
    })
    const snapshot = await server.connection.snapshot()
    expect(snapshot.sessions[0]?.id).toBe("ses_test")
    expect(snapshot.terminals).toEqual([])
    expect(snapshot.terminalsAvailable).toBe(path !== "/api/pty")
    expect(snapshot.loops).toEqual([])
    const message = "Connection failed: Invalid server response (array expected)."
    expect(snapshot.inventoryErrors).toEqual({
      terminals: path === "/api/pty" ? message : "",
      automations: path === "/api/loop" ? message : "",
    })
  })
}

test("both inventories can fail independently without losing sessions", async () => {
  const server = fixture({
    "/api/loop": new Response(null, { status: 500 }),
    "/api/pty": new Response(null, { status: 500 }),
  })
  const snapshot = await server.connection.snapshot()
  expect(snapshot.sessions[0]?.id).toBe("ses_test")
  expect(snapshot.terminals).toEqual([])
  expect(snapshot.terminalsAvailable).toBe(false)
  expect(snapshot.loops).toEqual([])
  expect(snapshot.inventoryErrors).toEqual({
    terminals: "Server returned HTTP 500. Retry; if it persists, check the server logs.",
    automations: "Server returned HTTP 500. Retry; if it persists, check the server logs.",
  })
})

for (const path of ["/api/location", "/api/session", "/api/session/active", "/api/session/ses_missing"]) {
  test(`${path} remains required for snapshots`, async () => {
    const server = fixture({
      "/api/session/active": { data: { ses_missing: { type: "running" } } },
      "/api/session/ses_missing": { data: session("ses_missing") },
      [path]: new Response(null, { status: 500 }),
    })
    await expect(server.connection.snapshot()).rejects.toThrow()
  })
}

test("an oversized active map is cut to 128 and counted, and a prototype-shaped one is rejected", async () => {
  const server = fixture({
    "/api/session/active": {
      data: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`ses_${i}`, { type: "running" }])),
    },
    ...Object.fromEntries(
      Array.from({ length: 129 }, (_, i) => [`/api/session/ses_${i}`, { data: session(`ses_${i}`) }]),
    ),
  })
  const snapshot = await server.connection.snapshot()
  expect(Object.keys(snapshot.active)).toHaveLength(128)
  expect(snapshot.active).not.toHaveProperty("ses_128")
  expect(snapshot.activeOmitted).toBe(1)
  expect(server.calls).not.toContain("/api/session/ses_128")
  server.routes.set("/api/session/active", JSON.parse('{"data":{"__proto__":{"type":"running"}}}'))
  await expect(server.connection.snapshot()).rejects.toMatchObject({
    reason: "Transport",
    cause: { message: "Invalid server response (identifier)." },
  })
})

test("active-session backfill rejects a response for a different session", async () => {
  const server = fixture({
    "/api/session/active": { data: { ses_missing: { type: "running" } } },
    "/api/session/ses_missing": { data: session("ses_other") },
  })
  await expect(server.connection.snapshot()).rejects.toMatchObject({
    reason: "Transport",
    cause: { message: "Invalid server response (session identity)." },
  })
})

test("snapshots explicitly exclude archived history while retaining archived active work", async () => {
  const archived = { ...session("ses_active"), time: { created: 1, updated: 2, archived: 0 } }
  const server = fixture({
    "/api/session": (request: Request) => {
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        limit: "100",
        order: "desc",
        archived: "false",
      })
      return Response.json({ data: [session()], cursor: { next: "more" } })
    },
    "/api/session/active": { data: { ses_active: { type: "running" } } },
    "/api/session/ses_active": { data: archived },
  })
  const snapshot = await server.connection.snapshot()
  expect(snapshot.sessions).toEqual([archived, session()])
  expect(snapshot.more).toBe(true)
})

test("server title searches bound pages and forward false and true archive filters; cursors omit filters and order", async () => {
  const queries: Record<string, string>[] = []
  const server = fixture({
    "/api/session": (request: Request) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams))
      return Response.json({ data: [session()], cursor: { next: "next", previous: "previous" } })
    },
  })
  for (const archived of [undefined, false, true]) {
    const result = await server.connection.searchSessions({
      search: "title +/&?",
      archived,
      directory: "/srv/other project",
    })
    expect(result.cursor).toEqual({ next: "next", previous: "previous" })
    expect(queries.at(-1)).toEqual({
      search: "title +/&?",
      directory: "/srv/other project",
      limit: "100",
      order: "desc",
      ...(archived === undefined ? {} : { archived: String(archived) }),
    })
  }
  for (const cursor of ["opaque+/=&?cursor", "x".repeat(4096)]) {
    await server.connection.searchSessions({ cursor, search: "ignored", archived: true, directory: "/srv/ignored" })
    expect(queries.at(-1)).toEqual({ cursor, limit: "100" })
  }
  await server.connection.searchSessions({ search: "x".repeat(256), cursor: "" })
  expect(queries.at(-1)).toEqual({ search: "x".repeat(256), limit: "100", order: "desc" })
  const count = server.calls.length
  for (const input of [{ search: "x".repeat(257) }, { cursor: "x".repeat(4097) }, { directory: "relative" }])
    await expect(server.connection.searchSessions(input)).rejects.toThrow()
  expect(server.calls).toHaveLength(count)
  server.routes.set("/api/session", { data: Array.from({ length: 101 }, (_, i) => session(`ses_${i}`)), cursor: {} })
  await expect(server.connection.searchSessions({})).rejects.toMatchObject({
    cause: { message: "Invalid server response (collection exceeds 100 items)." },
  })
})

test("optional archived timestamps must be finite numbers when present, including zero", async () => {
  const server = fixture()
  for (const archived of [undefined, 0, 123]) {
    const current = { ...session(), time: { created: 1, updated: 2, archived } }
    server.routes.set("/api/session", { data: [current], cursor: {} })
    expect((await server.connection.searchSessions({})).data[0]?.time.archived).toBe(archived)
  }
  for (const archived of [null, false, "0", {}, [], Infinity, NaN]) {
    const current = { ...session(), time: { created: 1, updated: 2, archived } }
    for (const path of ["/api/session", "/api/session/ses_test"]) {
      server.routes.set(path, { data: path.endsWith("ses_test") ? current : [current], cursor: {} })
      await expect(
        path.endsWith("ses_test")
          ? server.connection.client.sessions.get({ sessionID: "ses_test" })
          : server.connection.searchSessions({}),
      ).rejects.toMatchObject({ cause: { message: "Invalid server response (number)." } })
    }
  }
})
