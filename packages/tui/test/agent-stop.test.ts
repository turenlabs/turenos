import { expect, test } from "bun:test"
import { Forge } from "@turenlabs/client"
import { stop } from "../src/agent/stop"
import { connect } from "../src/server"

function fixture(running: boolean, tasks: boolean, status = 204) {
  const calls: string[] = []
  const output: string[] = []
  const connection = connect({ url: "http://127.0.0.1:1" })
  connection.client = Forge.make({
    baseUrl: connection.address,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
        calls.push(`${init?.method ?? "GET"} ${path}`)
        if (path === "/api/session/active") return Response.json({ data: running ? { ses_main: { type: "running" } } : {} })
        if (path !== "/api/session/ses_main/interrupt") throw new Error(`Unexpected request: ${path}`)
        return status === 204
          ? new Response(null, { status })
          : Response.json(
              {
                _tag: "ServiceUnavailableError",
                service: "session.interrupt",
                message: "Cancellation failed",
              },
              { status },
            )
      },
      { preconnect: fetch.preconnect },
    ),
  })
  return {
    calls,
    output,
    run: {
      connection,
      io: {
        env: {},
        stdout: (text: string) => output.push(text),
        stderr: () => {},
        stdin: { tty: false, read: async () => "" },
      },
      positionals: ["ses_main"],
      values: { tasks, json: true },
      flags: "",
    },
  }
}

for (const running of [false, true]) {
  for (const tasks of [false, true]) {
    test(`stop uses Core cancellation with running=${running}, tasks=${tasks}`, async () => {
      const f = fixture(running, tasks)
      try {
        expect(await stop(f.run)).toBe(0)
        expect(f.calls).toEqual([
          "GET /api/session/active",
          ...(running || tasks ? ["POST /api/session/ses_main/interrupt"] : []),
        ])
        expect(JSON.parse(f.output.join(""))).toEqual({
          ok: true,
          session: "ses_main",
          running,
          ...(tasks ? { tasks: { status: "cancelled" } } : {}),
        })
      } finally {
        f.run.connection.close()
      }
    })
  }
}

test("stop never acknowledges cancellation when the server fails", async () => {
  const f = fixture(false, true, 503)
  try {
    await expect(stop(f.run)).rejects.toThrow("Cancellation failed")
    expect(f.output).toEqual([])
    expect(f.calls).toEqual(["GET /api/session/active", "POST /api/session/ses_main/interrupt"])
  } finally {
    f.run.connection.close()
  }
})
