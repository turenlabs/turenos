import { describe, expect, test } from "bun:test"
import { Layer, Schema } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Memory } from "@turenlabs/core/memory"
import { Loop } from "@turenlabs/core/loop"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createRoutes } from "@turenlabs/server/routes"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { tmpdir } from "../fixture/fixture"

const authorization = `Basic ${Buffer.from("forge:whiteboard-test").toString("base64")}`
const shape = (id: string, version = 1): Whiteboard.Element => ({
  id,
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 80,
  angle: 0,
  version,
  versionNonce: 10,
  isDeleted: false,
})

// The package preload isolates configuration and SQLite from the user's installation.
const isolatedTmpDir = () => tmpdir({ config: { formatter: false, lsp: false } })

function actualServerAPI(directory: string) {
  const app = HttpRouter.toWebHandler(
    createRoutes("whiteboard-test").pipe(
      Layer.provide(HttpServer.layerServices),
      // These globals are looked up by handlers at request time, not registration time.
      Layer.provideMerge(
        AppNodeBuilder.build(LayerNode.group([Memory.node, Loop.node, PermissionSaved.node, SessionV2.node]), [
          [SessionExecution.node, SessionExecutionLocal.node],
        ]),
      ),
    ),
    { disableLogger: true },
  )
  const request = (path: string, init: RequestInit = {}, authenticated = true) => {
    const headers = new Headers(init.headers)
    headers.set("x-forge-directory", directory)
    if (authenticated) headers.set("authorization", authorization)
    return app.handler(new Request(new URL(path, "http://localhost"), { ...init, headers }))
  }
  const json = (path: string, method: string, body: unknown, authenticated = true) =>
    request(
      path,
      { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      authenticated,
    )
  return {
    request,
    json,
    async create() {
      const response = await json("/api/session", "POST", {
        agent: "build",
        model: { providerID: "test", id: "test" },
        location: { directory },
      })
      expect(response.status).toBe(200)
      const body = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
        await response.json(),
      )
      return `/api/session/${body.data.id}/whiteboard`
    },
    client(clientID: string, username: string) {
      return {
        get: (path: string) => request(path),
        update: (path: string, patch: Whiteboard.Patch) => json(path, "PATCH", { clientID, username, patch }),
        presence: (path: string, pointer = { x: 3, y: 4 }) =>
          json(`${path}/presence`, "POST", { clientID, username, pointer }),
      }
    },
    [Symbol.asyncDispose]: () => app.dispose(),
  }
}

const snapshot = async (response: Response) => {
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Whiteboard.Snapshot)(await response.json())
}

// SSE frames may be split across chunks or coalesced; never equate a read with an event.
async function openStream(api: ReturnType<typeof actualServerAPI>, path: string) {
  const controller = new AbortController()
  const response = await api.request(`${path}/events`, { signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
  expect(response.headers.get("x-accel-buffering")).toBe("no")
  expect(response.body).not.toBeNull()
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async () => {
    while (true) {
      const end = buffer.indexOf("\n\n")
      if (end !== -1) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) return Schema.decodeUnknownSync(Whiteboard.Events)(JSON.parse(data))
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error("whiteboard stream ended before expected event")
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n")
    }
  }
  return {
    next: (label: string) => deadline(next(), label),
    async abort() {
      const pending = reader.read()
      controller.abort()
      // toWebHandler transfers response scope to its body stream; Request.signal only
      // interrupts the already-completed request fiber. A fetch transport would cancel
      // the response body too, so do that explicitly for this in-process HTTP client.
      await deadline(reader.cancel(), "cancel response body after abort")
      expect((await deadline(pending, "pending read after response cancellation")).done).toBe(true)
    },
    [Symbol.asyncDispose]: async () => {
      controller.abort()
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    },
  }
}

async function deadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`whiteboard HTTP stream timed out: ${label}`)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("actual server whiteboard HttpApi", () => {
  test("requires Basic credentials on every endpoint and returns 404 for unknown sessions", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const path = await api.create()
    for (const target of [path, "/api/session/ses_whiteboard_missing/whiteboard"]) {
      for (const route of [
        { path: target, method: "GET", body: undefined },
        { path: target, method: "PATCH", body: { clientID: "a", username: "Alice", patch: { elements: [] } } },
        { path: `${target}/presence`, method: "POST", body: { clientID: "a", username: "Alice" } },
        { path: `${target}/events`, method: "GET", body: undefined },
      ]) {
        const denied =
          route.body === undefined
            ? await api.request(route.path, {}, false)
            : await api.json(route.path, route.method, route.body, false)
        expect(denied.status).toBe(401)
        await denied.body?.cancel()
        if (target === path) continue
        const missing =
          route.body === undefined
            ? await api.request(route.path)
            : await api.json(route.path, route.method, route.body)
        expect(missing.status).toBe(404)
        await missing.body?.cancel()
      }
    }
    expect((await snapshot(await api.request(path))).elements).toEqual([])
  }, 30000)

  test("validates payloads, enforces CAS, and reloads the unchanged board after rejection", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const path = await api.create()
    const alice = api.client("alice", "Alice")
    const initial = await snapshot(await alice.update(path, { elements: [shape("a")], baseRevision: 0 }))
    expect(initial.revision).toBe(1)
    const conflict = await alice.update(path, { elements: [shape("b")], baseRevision: 0 })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ expectedRevision: 0, actualRevision: 1 })
    for (const body of [
      {},
      { clientID: "a", username: "Alice", patch: { elements: "wrong" } },
      { clientID: "a", username: "Alice", patch: { elements: [{ ...shape("bad"), width: -1 }] } },
    ]) {
      expect((await api.json(path, "PATCH", body)).status).toBe(400)
    }
    expect(
      (await api.json(`${path}/presence`, "POST", { clientID: "a", username: "Alice", pointer: { x: "wrong", y: 0 } }))
        .status,
    ).toBe(400)
    expect(await snapshot(await alice.get(path))).toEqual(initial)
  }, 30000)

  test("rejects malformed JSON consistently with the existing session endpoint", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const path = await api.create()
    const before = await snapshot(await api.client("alice", "Alice").update(path, { elements: [shape("saved")] }))
    const baseline = await api.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    const whiteboard = await api.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    // The shared upstream JSON parser uses orDie and can report syntax errors as 500.
    expect(whiteboard.status).toBe(baseline.status)
    expect(whiteboard.status).toBeGreaterThanOrEqual(400)
    expect(await snapshot(await api.request(path))).toEqual(before)
  }, 30000)

  test("independent HTTP clients retain both concurrent edits and deletion tombstones on fresh GET", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const path = await api.create()
    const alice = api.client("alice", "Alice")
    const bob = api.client("bob", "Bob")
    const results = await Promise.all([
      alice.update(path, { elements: [shape("a")] }),
      bob.update(path, { elements: [shape("b")] }),
    ])
    for (const result of results) await snapshot(result)
    const saved = await snapshot(await bob.get(path))
    expect(saved.revision).toBe(2)
    expect(saved.elements.map((item) => item.id).sort()).toEqual(["a", "b"])
    const tombstone = { ...shape("a", 2), isDeleted: true }
    const deleted = await snapshot(await alice.update(path, { elements: [tombstone] }))
    expect(deleted.elements).toContainEqual(tombstone)
    expect(deleted.elements).toContainEqual(shape("b"))
    expect(await snapshot(await bob.update(path, { elements: [shape("a")] }))).toEqual(deleted)
    expect(await snapshot(await api.request(path))).toEqual(deleted)
  }, 30000)

  test("streams initial state, ephemeral presence and updates only for its session, then aborts cleanly", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const path = await api.create()
    const other = await api.create()
    const alice = api.client("alice", "Alice")
    const bob = api.client("bob", "Bob")
    expect((await alice.presence(path)).status).toBe(200)
    const before = await snapshot(await alice.get(path))
    await using stream = await openStream(api, path)
    expect(await stream.next("initial connected")).toMatchObject({
      type: Whiteboard.Connected.type,
      data: { sessionID: before.sessionID, revision: 0 },
    })
    expect(await stream.next("initial presence")).toMatchObject({
      type: Whiteboard.Presence.type,
      data: { sessionID: before.sessionID, participants: [{ clientID: "alice", username: "Alice" }] },
    })
    // Await other-session publication before the target-session marker: a leaking filter
    // yields that event instead of the marker, without a timing-dependent negative wait.
    await snapshot(await bob.update(other, { elements: [shape("private")] }))
    expect((await bob.presence(other)).status).toBe(200)
    expect((await bob.presence(path)).status).toBe(200)
    const presence = await stream.next("target presence after other-session publications")
    expect(presence.type).toBe(Whiteboard.Presence.type)
    expect(presence.data).toMatchObject({
      sessionID: before.sessionID,
      participants: expect.arrayContaining([
        { clientID: "bob", username: "Bob", pointer: { x: 3, y: 4 }, updatedAt: expect.any(Number) },
      ]),
    })
    expect(presence.durable).toBeUndefined()
    expect(await snapshot(await alice.get(path))).toEqual(before)
    const saved = await snapshot(await alice.update(path, { elements: [shape("shared")] }))
    const updated = await stream.next("target durable update")
    expect(updated).toMatchObject({
      type: Whiteboard.Updated.type,
      data: {
        sessionID: before.sessionID,
        revision: saved.revision,
        actor: { id: "alice", name: "Alice", kind: "human" },
      },
    })
    expect("durable" in updated).toBe(true)
    await stream.abort()
    // A new subscription is usable after cancellation and starts at the persisted revision.
    await using reopened = await openStream(api, path)
    expect(await reopened.next("reopened connected")).toMatchObject({
      type: Whiteboard.Connected.type,
      data: { revision: saved.revision },
    })
    expect((await reopened.next("reopened presence")).type).toBe(Whiteboard.Presence.type)
    expect(await snapshot(await bob.get(path))).toEqual(saved)
  }, 30000)
})
