import { expect, test } from "bun:test"
import { connect, errorText } from "../src/server"
import { ClientError } from "@turenlabs/client"
import { validateResponse } from "../src/response-validation"
import { session, fixture, cleanup } from "./server-fixture"

function legacySession(overrides: Record<string, unknown> = {}) {
  return { id: "ses_test", directory: "/srv/project", title: "Renamed", time: { created: 1, updated: 2 }, ...overrides }
}

test("legacy housekeeping PATCH acknowledges exact directory and mutation then returns a fresh current Session", async () => {
  const mutations: unknown[] = []
  const server = fixture({
    "/session/ses_test": async (request: Request) => {
      expect(request.method).toBe("PATCH")
      expect(new URL(request.url).searchParams.get("directory")).toBe("/srv/project")
      const body = (await request.json()) as { title?: string; time?: { archived: number | null } }
      mutations.push(body)
      return Response.json(
        legacySession({ time: { created: 1, updated: 2, archived: body.time?.archived ?? undefined } }),
      )
    },
    "/api/session/ses_test": { data: { ...session(), title: "Fresh current projection" } },
  })
  for (const change of [{ title: "Renamed" }, { archived: 0 }, { archived: 123 }, { archived: null }]) {
    const result = await server.connection.updateSession(session(), change)
    expect(result).toEqual({ ...session(), title: "Fresh current projection" })
    expect(server.calls.slice(-2)).toEqual(["/session/ses_test", "/api/session/ses_test"])
  }
  expect(mutations).toEqual([
    { title: "Renamed" },
    { time: { archived: 0 } },
    { time: { archived: 123 } },
    { time: { archived: null } },
  ])
})

test("legacy acknowledgements reject identity substitution, envelopes, missing data and no-op mutations", async () => {
  const server = fixture()
  for (const [change, ack] of [
    [{ title: "Renamed" }, legacySession({ id: "ses_other" })],
    [{ title: "Renamed" }, legacySession({ directory: "/srv/other" })],
    [{ title: "Renamed" }, legacySession({ directory: undefined })],
    [{ title: "Renamed" }, { data: legacySession() }],
    [{ title: "Renamed" }, session()],
    [{ title: "Renamed" }, legacySession({ title: "Old title" })],
    [{ title: "Renamed" }, legacySession({ time: { created: 1, updated: 2, archived: false } })],
    [{ archived: 0 }, legacySession()],
    [{ archived: 123 }, legacySession({ time: { created: 1, updated: 2, archived: 456 } })],
    [{ archived: null }, legacySession({ time: { created: 1, updated: 2, archived: 0 } })],
    [{ archived: null }, legacySession({ time: { created: 1, updated: 2, archived: null } })],
  ] as const) {
    server.routes.set("/session/ses_test", ack)
    await expect(server.connection.updateSession(session(), change)).rejects.toMatchObject({ reason: "Transport" })
  }
  for (const status of [200, 204, 205]) {
    server.routes.set("/session/ses_test", new Response(null, { status }))
    await expect(server.connection.updateSession(session(), { title: "Renamed" })).rejects.toThrow()
  }
  expect(server.calls.every((path) => path === "/session/ses_test")).toBe(true)
})

test("legacy validation is narrowly routed and sanitizes unused acknowledgement fields", () => {
  const init = { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) }
  const ack = legacySession({ metadata: { secret: "not returned" } })
  expect(validateResponse(new URL("https://example.test/session/ses_test?directory=/srv/project"), init, ack)).toEqual({
    id: "ses_test",
  })
  for (const path of ["/session/ses_test/extra", "/prefix/session/ses_test", "/session", "/session/ses_test/"])
    expect(() => validateResponse(new URL(`https://example.test${path}?directory=/srv/project`), init, ack)).toThrow(
      "route",
    )
  expect(() =>
    validateResponse(
      new URL("https://example.test/session/ses_test?directory=/srv/project"),
      { ...init, method: "GET" },
      ack,
    ),
  ).toThrow("route")
})

test("housekeeping validates titles and timestamps before making a request", async () => {
  const server = fixture()
  for (const title of ["", "  ", "x".repeat(201), "line\nbreak", "tab\ttitle", "escape\u001b", "bidi\u202e"])
    await expect(server.connection.updateSession(session(), { title })).rejects.toThrow("1 and 200")
  for (const archived of [NaN, Infinity, -Infinity])
    await expect(server.connection.updateSession(session(), { archived })).rejects.toThrow("finite archive")
  await expect(
    server.connection.updateSession({ ...session(), location: { directory: "relative" } }, { title: "Good" }),
  ).rejects.toThrow("absolute directory")
  expect(server.calls).toEqual([])
  server.routes.set("/session/ses_test", legacySession({ title: "x".repeat(200) }))
  server.routes.set("/api/session/ses_test", { data: session() })
  await server.connection.updateSession(session(), { title: "x".repeat(200) })
})

test("housekeeping fresh GET still rejects wrong identity and directory", async () => {
  const server = fixture({ "/session/ses_test": legacySession() })
  for (const current of [session("ses_other"), { ...session(), location: { directory: "/srv/other" } }]) {
    server.routes.set("/api/session/ses_test", { data: current })
    await expect(server.connection.updateSession(session(), { title: "Renamed" })).rejects.toThrow()
  }
})

test("legacy transport preserves authentication, redirect rejection, bounded errors and connection cancellation", async () => {
  const authorization: (string | null)[] = []
  let response = Response.json(legacySession())
  const targetCalls: string[] = []
  const target = Bun.serve({
    port: 0,
    fetch(request) {
      targetCalls.push(request.url)
      return Response.json(legacySession())
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      authorization.push(request.headers.get("authorization"))
      return response.clone()
    },
  })
  const connection = connect({ url: server.url.href, username: "operator", password: "fixture-password" })
  cleanup.push(async () => {
    connection.close()
    await Promise.all([server.stop(true), target.stop(true)])
  })
  response = Response.redirect(target.url.href)
  await expect(connection.updateSession(session(), { title: "Renamed" })).rejects.toMatchObject({ reason: "Transport" })
  expect(authorization[0]).toBe(`Basic ${Buffer.from("operator:fixture-password").toString("base64")}`)
  expect(targetCalls).toEqual([])
  for (const status of [401, 403, 409, 500]) {
    response = new Response("private server failure\u001b", { status })
    const message = await connection.updateSession(session(), { title: "Renamed" }).catch(errorText)
    expect(message).toBe(
      status === 401 || status === 403
        ? "Authentication required. Check the server credentials."
        : errorText(new ClientError("UnexpectedStatus", { cause: { status } })),
    )
  }
  response = new Response(new Uint8Array(8 * 1024 * 1024 + 1))
  await expect(connection.updateSession(session(), { title: "Renamed" })).rejects.toMatchObject({
    cause: { message: "Server response exceeds the 8 MiB TUI limit." },
  })
  response = new Response("[".repeat(65) + "0" + "]".repeat(65))
  await expect(connection.updateSession(session(), { title: "Renamed" })).rejects.toMatchObject({
    cause: { message: "Invalid server response (JSON complexity limit)." },
  })
  const count = authorization.length
  connection.close()
  await expect(connection.updateSession(session(), { title: "Renamed" })).rejects.toMatchObject({ reason: "Transport" })
  expect(authorization).toHaveLength(count)
})

test("legacy transport aborts a stalled response at its ten-second deadline", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
          },
        }),
      )
    },
  })
  const connection = connect({ url: server.url.href })
  cleanup.push(async () => {
    connection.close()
    await server.stop(true)
  })
  await expect(connection.updateSession(session(), { title: "Renamed" })).rejects.toMatchObject({ reason: "Transport" })
}, 15000)

test("closing the connection aborts an in-flight legacy mutation", async () => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const server = Bun.serve({
    port: 0,
    fetch() {
      reached.resolve()
      return release.promise
    },
  })
  const connection = connect({ url: server.url.href })
  cleanup.push(async () => {
    connection.close()
    release.resolve(new Response(null, { status: 503 }))
    // Let the aborted handler finish before Bun waits for server shutdown.
    await Bun.sleep(5)
    await server.stop(true)
  })
  const request = connection.updateSession(session(), { title: "Renamed" })
  await reached.promise
  connection.close()
  await expect(request).rejects.toMatchObject({ reason: "Transport" })
})
