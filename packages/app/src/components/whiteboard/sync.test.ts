import { describe, expect, test } from "bun:test"
import type { Whiteboard } from "@turenlabs/schema/whiteboard"
import { createWhiteboardSync, mergeElements, orderElements, validElement, validFile } from "./sync"
import type { WhiteboardTransport, SyncStatus } from "./sync"
import { emptyOutbox, updateOutbox } from "./outbox"
import type { Outbox, WhiteboardPersistence } from "./outbox"

const element = (id: string, version = 1, versionNonce = 10, isDeleted = false): Whiteboard.Element => ({
  id,
  type: "rectangle",
  version,
  versionNonce,
  isDeleted,
})
const snapshot = (elements: Whiteboard.Element[], revision = 0): Whiteboard.Snapshot => ({
  sessionID: "ses_whiteboard" as Whiteboard.Snapshot["sessionID"],
  revision,
  elements,
  files: {},
  updatedAt: 0,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup(persistence?: WhiteboardPersistence) {
  const writes: { input: Whiteboard.UpdateRequest; result: ReturnType<typeof deferred<Whiteboard.Snapshot>> }[] = []
  const scenes: (readonly Whiteboard.Element[])[] = []
  const statuses: SyncStatus[] = []
  let state = snapshot([])
  const transport: WhiteboardTransport = {
    get: async () => state,
    update(input) {
      const result = deferred<Whiteboard.Snapshot>()
      writes.push({ input, result })
      return result.promise
    },
    presence: async () => ({ participants: [] }),
    async *events(signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    },
  }
  const sync = createWhiteboardSync({
    sessionID: state.sessionID,
    clientID: "client",
    username: "Ada",
    transport,
    persistence,
    scene: (elements) => scenes.push(elements),
    status: (status) => statuses.push(status),
    participants: () => {},
    delay: 60000,
  })
  return {
    sync,
    writes,
    scenes,
    statuses,
    transport,
    remote(value: Whiteboard.Snapshot) {
      state = value
    },
  }
}

describe("whiteboard element reconciliation", () => {
  test("orders complete records lexically before restore without changing versions or stable ties", () => {
    const a = Object.freeze({ ...element("a", 7, 91), index: "a2", x: 25 })
    const b = Object.freeze({ ...element("b", 3, 42), index: "a1", x: 50 })
    const tie = Object.freeze({ ...element("tie", 5, 12), index: "a1" })
    const upper = Object.freeze({ ...element("upper"), index: "Zz" })
    const missing = Object.freeze(element("missing"))
    const empty = Object.freeze({ ...element("empty"), index: "" })
    const input = Object.freeze([missing, a, b, tie, upper, empty])
    expect(orderElements([a, b])).toEqual([b, a])
    const ordered = orderElements(input)
    expect(ordered).toEqual([upper, b, tie, a, missing, empty])
    expect(ordered[1]).toBe(b)
    expect(ordered[3]).toBe(a)
    expect(input).toEqual([missing, a, b, tie, upper, empty])
  })
  test("concurrent distinct edits survive; tombstones win by version; nonce breaks ties", () => {
    expect(
      mergeElements([element("a", 2), element("b")], [element("c"), element("b", 2, 9, true), element("a", 2, 8)]),
    ).toEqual([element("a", 2, 8), element("b", 2, 9, true), element("c")])
  })
  test("rejects invalid identities, versions, embeds and remote image URLs", () => {
    expect(validElement(element("a"))).toBe(true)
    expect(validElement(element("a", 0))).toBe(false)
    expect(validElement({ ...element("a"), type: "embeddable" })).toBe(false)
    expect(validElement(element("x".repeat(129)))).toBe(false)
    expect(validFile({ id: "f", mimeType: "image/png", dataURL: "https://example.com/image.png", created: 0 })).toBe(
      false,
    )
    expect(validFile({ id: "f", mimeType: "image/png", dataURL: "data:image/png;base64,YQ==", created: 0 })).toBe(true)
  })
})

describe("whiteboard serialized outbox", () => {
  test("flushes and acknowledges a 3 MiB image whose base64 payload exceeds the old wire budget", async () => {
    const value = setup()
    const file: Whiteboard.File = {
      id: "large-image",
      mimeType: "image/png",
      dataURL: `data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`,
      created: 0,
    }
    const image: Whiteboard.Element = { ...element("image"), type: "image", fileId: file.id }
    value.sync.change([image], { [file.id]: file })
    expect(value.sync.dirty()).toBe(true)
    const flushing = value.sync.flush()
    expect(value.writes).toHaveLength(1)
    expect(value.writes[0]!.input.patch.elements).toEqual([image])
    expect(value.writes[0]!.input.patch.files?.[file.id]).toEqual(file)
    value.writes[0]!.result.resolve({ ...snapshot([image], 1), files: { [file.id]: file } })
    await flushing
    expect(value.sync.dirty()).toBe(false)
    await value.sync.dispose()
  })
  test("failed route-disposal save is recovered by the next mounted controller", async () => {
    let saved = emptyOutbox()
    const persistence: WhiteboardPersistence = {
      load: async () => saved,
      put: async (patch) => {
        saved = updateOutbox(saved, patch)
      },
      acknowledge: async (patch) => {
        saved = updateOutbox(saved, patch, true)
      },
    }
    const first = setup(persistence)
    await first.sync.initialize()
    first.sync.change([element("offline")], {})
    first.transport.update = async () => {
      throw new Error("Offline")
    }
    await first.sync.dispose()
    const second = setup(persistence)
    await second.sync.initialize()
    expect(second.scenes.at(-1)).toEqual([element("offline")])
    const flushing = second.sync.flush()
    second.writes[0]!.result.resolve(snapshot([element("offline")], 1))
    await flushing
    await second.sync.dispose()
    expect(saved).toEqual(emptyOutbox())
  })
  test("quota failure remains visibly offline until server and storage acknowledge", async () => {
    const persistence: WhiteboardPersistence = {
      load: async () => emptyOutbox(),
      put: async () => {
        throw new Error("QuotaExceededError")
      },
      acknowledge: async () => {
        throw new Error("QuotaExceededError")
      },
    }
    const value = setup(persistence)
    await value.sync.initialize()
    value.sync.change([element("a")], {})
    const flushing = value.sync.flush()
    value.writes[0]!.result.resolve(snapshot([element("a")], 1))
    await flushing
    expect(value.statuses.at(-1)).toBe("Offline")
    expect(value.sync.dirty()).toBe(true)
    value.transport.update = async () => {
      throw new Error("Offline")
    }
    await value.sync.dispose()
  })
  test("durable outbox acknowledges only sent versions and retains tombstones", () => {
    const sent = { elements: [element("a")], files: {} }
    const next = updateOutbox(sent, { elements: [element("a", 2), element("b", 2, 10, true)], files: {} })
    expect(updateOutbox(next, sent, true).elements).toEqual([element("a", 2), element("b", 2, 10, true)])
    expect(updateOutbox(next, next, true)).toEqual(emptyOutbox())
    expect(() =>
      updateOutbox(emptyOutbox(), { elements: [{ ...element("huge"), text: "x".repeat(4 * 1024 * 1024) }], files: {} }),
    ).toThrow("recovery storage exceeds")
  })
  test("restores persisted changes before sync and waits for durable acknowledgement", async () => {
    let saved: Outbox = { elements: [element("recovered")], files: {} }
    const committed = deferred<void>()
    const requested = deferred<void>()
    const persistence: WhiteboardPersistence = {
      load: async () => saved,
      put: async (patch) => {
        saved = updateOutbox(saved, patch)
      },
      acknowledge: async (patch) => {
        requested.resolve()
        await committed.promise
        saved = updateOutbox(saved, patch, true)
      },
    }
    const value = setup(persistence)
    value.sync.change([], {})
    await value.sync.initialize()
    expect(value.scenes.at(-1)).toEqual([element("recovered")])
    const flushing = value.sync.flush()
    value.writes[0]!.result.resolve(snapshot([element("recovered")], 1))
    await requested.promise
    expect(value.sync.dirty()).toBe(true)
    value.sync.change([element("recovered", 2)], {})
    committed.resolve()
    await flushing
    expect(saved.elements).toEqual([element("recovered", 2)])
    const next = value.sync.flush()
    value.writes[1]!.result.resolve(snapshot([element("recovered", 2)], 2))
    await next
    expect(saved.elements).toHaveLength(0)
    await value.sync.dispose()
  })
  test("acknowledgement cannot clear an edit created after its request", async () => {
    const value = setup()
    value.sync.change([element("a")], {})
    const first = value.sync.flush()
    value.sync.change([element("a", 2)], {})
    expect(value.sync.flush()).toBe(first)
    value.writes[0]!.result.resolve(snapshot([element("a")], 1))
    await first
    expect(value.sync.dirty()).toBe(true)
    const second = value.sync.flush()
    expect(value.writes[1]!.input.patch.elements).toEqual([element("a", 2)])
    value.writes[1]!.result.resolve(snapshot([element("a", 2)], 2))
    await second
    expect(value.sync.dirty()).toBe(false)
    await value.sync.dispose()
  })
  test("failed writes retain newer pending edits and reconnect merges other clients", async () => {
    const value = setup()
    value.sync.change([element("a")], {})
    const first = value.sync.flush()
    value.sync.change([element("a", 2)], {})
    value.writes[0]!.result.reject(new Error("offline"))
    await first
    expect(value.statuses.at(-1)).toBe("Offline")
    value.remote(snapshot([element("b")], 2))
    await value.sync.refresh()
    expect(value.scenes.at(-1)).toEqual([element("b"), element("a", 2)])
    const retry = value.sync.flush()
    expect(value.writes[1]!.input.patch.elements).toEqual([element("a", 2)])
    value.writes[1]!.result.resolve(snapshot([element("b"), element("a", 2)], 3))
    await retry
    await value.sync.dispose()
  })
  test("remote echoes and stale snapshots do not generate writes", async () => {
    const value = setup()
    value.remote(snapshot([element("a", 2)], 2))
    await value.sync.refresh()
    value.sync.change([element("a", 2)], {})
    await value.sync.flush()
    expect(value.writes).toHaveLength(0)
    value.remote(snapshot([element("a")], 1))
    await value.sync.refresh()
    expect(value.scenes.at(-1)).toEqual([element("a", 2)])
    await value.sync.dispose()
  })
  test("dispose finishes pending writes without invoking scene or status callbacks", async () => {
    const value = setup()
    value.sync.change([element("a")], {})
    const first = value.sync.flush()
    value.sync.change([element("a", 2)], {})
    const count = value.statuses.length
    const closing = value.sync.dispose()
    value.writes[0]!.result.resolve(snapshot([element("a")], 1))
    await first
    await Promise.resolve()
    expect(value.writes[1]!.input.patch.elements).toEqual([element("a", 2)])
    value.writes[1]!.result.resolve(snapshot([element("a", 2)], 2))
    await closing
    expect(value.scenes).toHaveLength(0)
    expect(value.statuses).toHaveLength(count)
  })
  test("connected notification refreshes a snapshot taken before subscription became live", async () => {
    const value = setup()
    const event = deferred<typeof Whiteboard.Events.Encoded>()
    const applied = deferred<void>()
    let reads = 0
    value.transport.get = async () => {
      reads++
      if (reads === 2) applied.resolve()
      return snapshot(reads === 1 ? [] : [element("remote")], reads - 1)
    }
    value.transport.events = async function* (signal) {
      yield await event.promise
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    }
    value.sync.start()
    event.resolve({
      id: "evt_connected",
      type: "session.whiteboard.connected",
      data: { sessionID: "ses_whiteboard", revision: 1 },
    })
    await applied.promise
    await Promise.resolve()
    expect(value.scenes.at(-1)).toEqual([element("remote")])
    await value.sync.dispose()
  })
  test("dispose fences late reads, presence, and callbacks", async () => {
    const value = setup()
    const read = deferred<Whiteboard.Snapshot>()
    value.transport.get = () => read.promise
    const request = value.sync.refresh()
    await value.sync.dispose()
    read.resolve(snapshot([element("late")], 9))
    await request
    value.sync.change([element("ignored")], {})
    expect(value.scenes).toHaveLength(0)
    expect(value.writes).toHaveLength(0)
  })
})
