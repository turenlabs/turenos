import { expect, test } from "bun:test"
import { stop } from "../src/agent/stop"
import { settle } from "../src/agent/wait"
import { connect } from "../src/server"
import { cleanup, turen } from "./support"

test("stop and wait resolve the requested session before active-map truncation", async () => {
  const state = { running: false, interrupts: 0 }
  const crowded = Object.fromEntries(
    Array.from({ length: 130 }, (_, index) => [`ses_busy${index}`, { type: "running" }]),
  )
  const server = turen({
    routes: {
      "GET /api/session/active": () => ({
        data: { ...crowded, ...(state.running ? { ses_main: { type: "running" } } : {}) },
      }),
      "POST /api/session/ses_main/interrupt": () => {
        state.interrupts++
        return new Response(null, { status: 204 })
      },
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  const run = {
    connection,
    positionals: ["ses_main"],
    flags: "",
    values: { json: true, tasks: false },
    io: { env: {}, stdout() {}, stderr() {}, stdin: { tty: true, read: async () => "" } },
  }
  expect(await stop(run)).toBe(0)
  expect(state.interrupts).toBe(0)
  expect((await settle(connection, "ses_main", { timeout: 1 })).state).toBe("idle")
  run.values.tasks = true
  expect(await stop(run)).toBe(0)
  expect(state.interrupts).toBe(1)
  run.values.tasks = false
  state.running = true
  expect(await stop(run)).toBe(0)
  expect(state.interrupts).toBe(2)
  expect((await settle(connection, "ses_main", { timeout: 1 })).state).toBe("timeout")
})
