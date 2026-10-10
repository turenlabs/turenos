import { afterEach, expect, test } from "bun:test"
import { connect } from "../src/server"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop()))
})

function fixture(status: number) {
  const control = { status, requests: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/global/storage") return Response.json(null)
      control.requests++
      return new Response(null, { status: control.status })
    },
  })
  const connection = connect({ url: server.url.href, username: "operator", password: "test-only" })
  cleanup.push(async () => {
    connection.close()
    await server.stop(true)
  })
  return { connection, control }
}

for (const status of [404, 405]) {
  test(`a server answering ${status} for storage keeps folders local and notices once per connection`, async () => {
    const { connection } = fixture(status)
    expect(await connection.folders.open("/one")).toEqual(["/one"])
    expect(connection.folders.takeNotice()).not.toBe("")
    expect(await connection.folders.open("/two")).toEqual(["/one", "/two"])
    expect(await connection.folders.close("/one")).toEqual(["/two"])
    expect(connection.folders.takeNotice()).toBe("")
    expect(connection.folders.current()).toEqual(["/two"])
  })
}

test("a failing server still surfaces its error, and an invalid folder is never kept", async () => {
  const { connection, control } = fixture(500)
  for (const status of [401, 403, 500]) {
    control.status = status
    await expect(connection.folders.open("/one")).rejects.toThrow()
  }
  expect(connection.folders.takeNotice()).toBe("")
  control.status = 404
  const before = control.requests
  await expect(connection.folders.open("relative")).rejects.toThrow()
  expect(control.requests).toBe(before)
  expect(connection.folders.current()).toBeUndefined()
})
