import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-forge-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("serves the global durable loop index without booting a selected location", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const created = await request("/api/loop", first.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "First location loop",
        prompt: "Check the first location",
        location: { directory: first.path },
        intervalSeconds: 60,
        paused: true,
      }),
    })
    expect(created.status).toBe(200)
    const loopID = ((await created.json()) as { id: string }).id

    const firstList = await request("/api/loop", first.path)
    expect(firstList.status).toBe(200)
    expect((await firstList.json()) as Array<{ id: string }>).toMatchObject([{ id: loopID }])

    const secondList = await request("/api/loop", second.path)
    expect(secondList.status).toBe(200)
    expect((await secondList.json()) as Array<{ id: string }>).toMatchObject([{ id: loopID }])
    expect((await request(`/api/loop/${loopID}`, second.path)).status).toBe(200)
  })

  test("serves guarded durable session goal lifecycle endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const goalID = "goal_httpapi"
    const messageID = "msg_goal_httpapi"
    const set = () =>
      request(`/api/session/${sessionID}/goal`, tmp.path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: goalID,
          messageID,
          objective: "Prove the public goal lifecycle",
        }),
      })

    const first = await set()
    const retried = await set()
    expect(first.status).toBe(200)
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({
      data: {
        id: goalID,
        sessionID,
        revision: 1,
        objective: "Prove the public goal lifecycle",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
      },
    })

    const edit = await request(`/api/session/${sessionID}/goal`, tmp.path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalID,
        expectedRevision: 1,
        objective: "Prove the edited public goal lifecycle",
      }),
    })
    expect(edit.status).toBe(200)
    expect(await edit.json()).toMatchObject({
      data: { id: goalID, revision: 2, objective: "Prove the edited public goal lifecycle" },
    })

    const stale = await request(`/api/session/${sessionID}/goal/status`, tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalID, expectedRevision: 1, status: "paused" }),
    })
    expect(stale.status).toBe(409)
    const paused = await request(`/api/session/${sessionID}/goal/status`, tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalID, expectedRevision: 2, status: "paused" }),
    })
    expect(paused.status).toBe(200)
    expect(await paused.json()).toMatchObject({ data: { id: goalID, revision: 3, status: "paused" } })

    const cleared = await request(`/api/session/${sessionID}/goal`, tmp.path, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalID, expectedRevision: 3 }),
    })
    expect(cleared.status).toBe(204)
    const empty = await request(`/api/session/${sessionID}/goal`, tmp.path)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ data: null })
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/session", publisher.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
