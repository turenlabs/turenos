import { expect, test } from "bun:test"
import { checkHealth } from "./health"
import { pollSshHealth } from "./ssh/startup"
import { pollWslHealth } from "./wsl/startup"

test("health checks preserve the route and authentication", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/global/health")
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("forge:synthetic").toString("base64")}`)
      return new Response("ok")
    },
  })
  try {
    expect(await checkHealth(server.url.toString(), "synthetic")).toBe(true)
    expect(await checkHealth("not a URL")).toBe(false)
  } finally {
    await server.stop(true)
  }
})

for (const [label, poll] of [
  ["SSH", pollSshHealth],
  ["WSL", pollWslHealth],
] as const) {
  test(`${label} polling aborts an active HTTP health request`, async () => {
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        entered.resolve()
        return response.promise
      },
    })
    const controller = new AbortController()
    let checks = 0
    const work = poll((signal) => {
      checks++
      return checkHealth(server.url.toString(), null, signal)
    }, controller.signal)
    try {
      await entered.promise
      controller.abort()
      expect(await Promise.race([work.then(() => "stopped"), Bun.sleep(200).then(() => "pending")])).toBe("stopped")
      expect(checks).toBe(1)
    } finally {
      controller.abort()
      response.resolve(new Response("ok"))
      await work
      await server.stop(true)
    }
  })

  test(`${label} polling does not schedule a delay after cancellation during a check`, async () => {
    const controller = new AbortController()
    const work = poll(
      async (signal) => {
        expect(signal).toBe(controller.signal)
        controller.abort()
        return false
      },
      controller.signal,
      1000,
    )
    expect(await Promise.race([work.then(() => "stopped"), Bun.sleep(50).then(() => "pending")])).toBe("stopped")
    await work
  })

  test(`${label} polling does not check after cancellation`, async () => {
    const controller = new AbortController()
    controller.abort()
    await poll(async () => {
      throw new Error("Cancelled polling must not start a request")
    }, controller.signal)
  })
}
