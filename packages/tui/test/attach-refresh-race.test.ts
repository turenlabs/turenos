import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen, until } from "./support"

for (const settle of ["attached", "detached"] as const) {
  for (const outcome of ["snapshot", "error"] as const) {
    test(`a pre-attach ${outcome} settling while ${settle} is discarded and detach reads fresh state`, async () => {
      const ticket = Promise.withResolvers<void>()
      const stale = Promise.withResolvers<void>()
      const fresh = Promise.withResolvers<void>()
      const server = turen({
        routes: {
          "GET /api/pty": (_, url) => ({
            location: { directory: url.searchParams.get("location[directory]") },
            data: [
              {
                id: "pty_shell",
                title: "race shell",
                command: "sh",
                args: [],
                cwd: "/srv/main",
                status: "running",
                pid: 1,
              },
            ],
          }),
          "POST /api/pty/pty_shell/connect-token": async () => {
            await ticket.promise
            return new Response(null, { status: 404 })
          },
        },
      })
      const connection = connect({ url: server.url })
      cleanup.push(connection.close)
      const snapshot = connection.snapshot
      let stage = "initial"
      let reads = 0
      const starts: number[] = []
      connection.snapshot = async (folder) => {
        if (stage === "initial") return snapshot(folder)
        const read = ++reads
        starts.push(Date.now())
        const result = await snapshot(folder)
        if (read === 1) {
          await stale.promise
          if (outcome === "error") throw new Error("stale snapshot failed")
          result.sessions = result.sessions.map((session) => ({ ...session, title: "stale pre-attach state" }))
        }
        if (read === 2) {
          await fresh.promise
          result.sessions = result.sessions.map((session) => ({ ...session, title: "fresh detached state" }))
        }
        return result
      }
      const { view, screen } = await terminal(120, 36)
      const app = mountDashboard(view.renderer, connection, server.url)
      cleanup.push(app.dispose)
      // Release gates even if an assertion fails, so cleanup cannot leave pending work.
      cleanup.push(() => {
        ticket.resolve()
        stale.resolve()
        fresh.resolve()
      })
      await app.ready
      await screen("main task")
      stage = "race"
      const pending = app.refresh()
      await until(() => reads === 1)
      view.mockInput.pressKey("2")
      await screen("race shell")
      view.mockInput.pressEnter()
      await until(() => server.sent("/api/pty/pty_shell/connect-token").length === 1)
      if (settle === "attached") {
        stale.resolve()
        await pending
        expect(reads).toBe(1)
        expect(app.connected()).toBe(true)
      }
      const detachedAt = Date.now()
      ticket.resolve()
      await screen("The terminal exited.")
      if (settle === "detached") stale.resolve()
      await until(() => reads === 2)
      expect(starts[1]! - detachedAt).toBeLessThan(1000)
      expect(app.connected()).toBe(true)
      view.mockInput.pressKey("1")
      const frame = await screen("main task")
      expect(frame).not.toContain("stale pre-attach state")
      fresh.resolve()
      const refreshedAt = Date.now()
      await pending
      await screen("fresh detached state")
      // Reconciliation must continue after the fresh detach snapshot.
      await until(() => reads >= 3)
      expect(starts[2]! - refreshedAt).toBeGreaterThanOrEqual(1900)
      expect(starts[2]! - refreshedAt).toBeLessThan(3500)
      await until(() => reads >= 4)
      expect(starts[3]! - starts[2]!).toBeGreaterThanOrEqual(1900)
      expect(starts[3]! - starts[2]!).toBeLessThan(3500)
    })
  }
}

test("live reconciliation keeps polling every five seconds after each snapshot", async () => {
  const connected = new TextEncoder().encode(
    `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`,
  )
  const server = turen({
    routes: {
      "GET /api/event": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connected)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  const snapshot = connection.snapshot
  const starts: number[] = []
  connection.snapshot = async (folder) => {
    starts.push(Date.now())
    return snapshot(folder)
  }
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connection, server.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("Live")
  await Bun.sleep(500)
  const initial = starts.length
  await Bun.sleep(4000)
  expect(starts.length).toBe(initial)
  await screen("Live")
  const deadline = Date.now() + 8000
  while (starts.length < initial + 2 && Date.now() < deadline) await Bun.sleep(20)
  expect(starts.length).toBe(initial + 2)
  expect(starts.at(-1)! - starts.at(-2)!).toBeGreaterThanOrEqual(4900)
  expect(starts.at(-1)! - starts.at(-2)!).toBeLessThan(6500)
}, 20000)
