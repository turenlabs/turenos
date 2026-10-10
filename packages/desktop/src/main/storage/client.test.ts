import { describe, expect, test } from "bun:test"
import { createStorageRemote, StorageHttpError } from "./client"

describe("Storage HTTP client", () => {
  test("uses root auth and encodes scoped reads without exposing values in the URL", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const remote = createStorageRemote({
      ready: async () => ({ url: "http://127.0.0.1:4096", username: "forge", password: "password" }),
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init })
        return Response.json({
          state: {
            scope: "desktop/store/test",
            key: "theme",
            value: "secret-value",
            revision: 1,
            timeCreated: 1,
            timeUpdated: 1,
          },
        })
      },
    })

    expect((await remote.get("desktop/store/test", "theme"))?.value).toBe("secret-value")
    expect(requests[0]?.url).toBe("http://127.0.0.1:4096/global/storage?scope=desktop%2Fstore%2Ftest&key=theme")
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("forge:password").toString("base64")}`,
    )
    expect(requests[0]?.url).not.toContain("secret-value")
  })

  test("retries startup connection failures without duplicating caller logic", async () => {
    const delays: number[] = []
    const calls = { count: 0 }
    const remote = createStorageRemote({
      ready: async () => ({ url: "http://127.0.0.1:4096", username: null, password: null }),
      attempts: 3,
      retryDelay: async (attempt) => {
        delays.push(attempt)
      },
      fetch: async () => {
        calls.count++
        if (calls.count < 3) throw new TypeError("sidecar is starting")
        return Response.json({ items: [] })
      },
    })

    expect(await remote.list("desktop/store/test")).toEqual([])
    expect(calls.count).toBe(3)
    expect(delays).toEqual([0, 1])
  })

  test("does not copy a server response body into errors", async () => {
    const remote = createStorageRemote({
      ready: async () => ({ url: "http://127.0.0.1:4096", username: null, password: null }),
      fetch: async () => new Response('{"value":"must-not-leak"}', { status: 409 }),
    })

    const error = await remote.set("scope", "key", "value").catch((error) => error)
    expect(error).toBeInstanceOf(StorageHttpError)
    expect(error.message).toBe("Storage request failed with status 409")
    expect(error.message).not.toContain("must-not-leak")
  })

  test("coalesces same-key writes so a stalled save does not stack retry loops", async () => {
    const bodies: Array<{ value: string }> = []
    let begin = () => {}
    const began = new Promise<void>((resolve) => (begin = resolve))
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const remote = createStorageRemote({
      ready: async () => ({ url: "http://127.0.0.1:4096", username: null, password: null }),
      attempts: 1,
      fetch: async (_input, init) => {
        const body = JSON.parse(init?.body as string)
        bodies.push(body)
        begin()
        await gate
        return Response.json({
          scope: body.scope,
          key: body.key,
          value: body.value,
          revision: bodies.length,
          timeCreated: 1,
          timeUpdated: 2,
        })
      },
    })

    const first = remote.set("s", "k", "v1")
    await began
    const second = remote.set("s", "k", "v2")
    const third = remote.set("s", "k", "v3")
    release()

    const [state1, state2, state3] = await Promise.all([first, second, third])
    // The queued writes collapsed into one request carrying the newest value.
    expect(bodies.map((body) => body.value)).toEqual(["v1", "v3"])
    expect(state1.value).toBe("v1")
    expect(state2.value).toBe("v3")
    expect(state3.value).toBe("v3")
  })

  test("keeps revision-guarded writes as separate ordered requests", async () => {
    const bodies: Array<{ value: string; expectedRevision?: number }> = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const remote = createStorageRemote({
      ready: async () => ({ url: "http://127.0.0.1:4096", username: null, password: null }),
      attempts: 1,
      fetch: async (_input, init) => {
        const body = JSON.parse(init?.body as string)
        bodies.push(body)
        if (bodies.length === 1) await gate
        return Response.json({ scope: body.scope, key: body.key, value: body.value, revision: bodies.length, timeCreated: 1, timeUpdated: 2 })
      },
    })

    const first = remote.set("s", "k", "v1")
    const guarded = remote.set("s", "k", "v2", 5)
    release()

    await Promise.all([first, guarded])
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.value).toBe("v1")
    expect(bodies[1]).toEqual({ scope: "s", key: "k", value: "v2", expectedRevision: 5 })
  })

  test("sends revision guards and atomic scope replacements without values in URLs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const remote = createStorageRemote({
      ready: async () => ({ url: "http://127.0.0.1:4096", username: null, password: null }),
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init })
        if (init?.method === "DELETE") return Response.json({ removed: true })
        if (input.toString().endsWith("/global/storage/scope")) return Response.json({ written: 2 })
        if (input.toString().endsWith("/global/storage/batch")) return Response.json({ written: 3 })
        return Response.json({
          scope: "desktop/store/test",
          key: "theme",
          value: "next-secret",
          revision: 2,
          timeCreated: 1,
          timeUpdated: 2,
        })
      },
    })

    await remote.set("desktop/store/test", "theme", "next-secret", 1)
    await remote.remove("desktop/store/test", "theme", 2)
    expect(
      await remote.replace("desktop/store/test", [
        { key: "one", value: "secret-one" },
        { key: "two", value: "secret-two" },
      ]),
    ).toBe(2)
    expect(
      await remote.guardedBatch({
        guards: [{ scope: "desktop/store/test", key: "current", expectedRevision: 1 }],
        sets: [{ scope: "desktop/store/test", key: "current", value: "guarded-secret" }],
        removes: [{ scope: "desktop/store/test", key: "old" }],
      }),
    ).toBe(3)

    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({
      scope: "desktop/store/test",
      key: "theme",
      value: "next-secret",
      expectedRevision: 1,
    })
    expect(requests[1]?.url).toContain("expectedRevision=2")
    expect(requests[1]?.url).not.toContain("next-secret")
    expect(requests[2]?.url).toBe("http://127.0.0.1:4096/global/storage/scope")
    expect(requests[3]?.url).toBe("http://127.0.0.1:4096/global/storage/batch")
    expect(requests[3]?.url).not.toContain("guarded-secret")
  })
})
