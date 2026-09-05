import assert from "node:assert/strict"
import { createForgeClient } from "@turenlabs/sdk/v2/client"
import {
  createPromptAdmission,
  promptAdmissionFor,
  timedRequest,
  type PromptAdmission,
  type PromptAdmissionStorage,
} from "@/components/prompt-input/prompt-admission"
import { ServerScope } from "@/utils/server-scope"
import type { Platform } from "@/context/platform"

const scope = ServerScope.local
const entry = (id: string, server = scope): Omit<PromptAdmission, "state" | "error"> => ({
  scope: server,
  sessionID: "session",
  directory: "/project",
  payload: {
    sessionID: "session",
    id,
    delivery: "queue",
    agent: "agent",
    model: { providerID: "provider", id: "model", variant: "high" },
    prompt: {
      text: "exact prompt",
      files: [{ mime: "image/png", filename: "image.png", url: "data:image/png;base64,image" }],
    },
  },
  message: {
    id,
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: "agent",
    model: { providerID: "provider", modelID: "model" },
  },
  parts: [{ id: `part-${id}`, sessionID: "session", messageID: id, type: "text", text: "exact prompt" }],
})
const storage = () => {
  const values = new Map<string, string>()
  return {
    values,
    port: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
      keys: () => [...values.keys()],
    } satisfies PromptAdmissionStorage,
  }
}
const pause = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const until = async (done: () => boolean) => {
  const end = Date.now() + 2000
  while (!done() && Date.now() < end) await pause(2)
  assert.ok(done(), "condition did not complete")
}
const statuses = new Map<string, "admitted" | "promoted" | "cancelled">()
const posts: Array<{ server: string; payload: Record<string, unknown> }> = []
const reads: string[] = []
const releases = new Map<string, () => void>()
const received = new Set<string>()
let mode: "ok" | "reject" | "lost" | "hold" = "ok"
let holdReads = false
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const id = url.pathname.split("/").at(-1)!
    if (request.method === "POST") {
      const payload = (await request.json()) as Record<string, unknown>
      const id = String(payload.id)
      posts.push({ server: url.searchParams.get("server") ?? "primary", payload })
      received.add(id)
      if (mode === "reject") return Response.json({ status: 400, message: "invalid prompt" }, { status: 400 })
      if (mode === "hold") await new Promise<void>((resolve) => releases.set(id, resolve))
      statuses.set(id, "admitted")
      if (mode === "lost") return Response.json({ status: 503 }, { status: 503 })
      return Response.json({ data: { id } })
    }
    reads.push(url.pathname)
    if (holdReads) await new Promise<void>((resolve) => releases.set(`read:${id}`, resolve))
    if (url.pathname.endsWith("/input")) return Response.json({ data: [] })
    const status = statuses.get(id)
    if (url.pathname.includes("/input/") && status) return Response.json({ data: { status } })
    return Response.json({ status: 404 }, { status: 404 })
  },
})
const client = createForgeClient({
  baseUrl: server.url.href,
  throwOnError: true,
  headers: { authorization: "test-secret-never-journaled" },
})
const owner = (port: PromptAdmissionStorage, extra: Partial<Parameters<typeof createPromptAdmission>[0]> = {}) =>
  createPromptAdmission({ storage: port, retryDelays: [], checkDelays: [0, 5], ...extra })
try {
  // Verified writes precede the first real HTTP POST; the stored payload owns
  // its snapshot and contains no SDK headers or client configuration.
  const first = storage()
  const admission = owner(first.port)
  let prepared = false
  const intent = entry("durable")
  const original = JSON.stringify(intent.payload)
  const sent = admission.send(intent, client, undefined, () => {
    assert.equal(posts.length, 0)
    assert.equal(first.values.size, 1)
    assert.ok(![...first.values.values()][0].includes("test-secret"))
    intent.payload.prompt!.text = "edited later"
    prepared = true
  })
  assert.equal(await sent, "admitted")
  assert.ok(prepared)
  assert.deepEqual(posts[0].payload, JSON.parse(original.replace('"sessionID":"session",', "")))
  await until(() => first.values.size === 0)

  // A failed/silent storage adapter cannot acknowledge durability or POST.
  for (const fail of ["throw", "silent"] as const) {
    const saved = storage()
    const count = posts.length
    const failed = owner({
      ...saved.port,
      setItem: () => {
        if (fail === "throw") throw new Error("disk full")
      },
    })
    await assert.rejects(failed.send(entry(`save-${fail}`), client, undefined, () => assert.fail("composer cleared")))
    assert.equal(posts.length, count)
  }

  // A hanging adapter must release Send without allowing a late save to POST.
  // Cleanup stays ordered behind the real write/readback, not its deadline.
  for (const stage of ["write", "read"] as const) {
    const saved = storage()
    const gate = Promise.withResolvers<void>()
    const count = posts.length
    const hanging = owner(
      {
        ...saved.port,
        setItem: async (key, value) => {
          if (stage === "write") await gate.promise
          saved.port.setItem(key, value)
        },
        getItem: async (key) => {
          if (stage === "read") await gate.promise
          return saved.port.getItem(key)
        },
      },
      { requestTimeoutMs: 20 },
    )
    await assert.rejects(hanging.send(entry(`hanging-${stage}`), client, undefined, () => assert.fail("cleared")))
    assert.equal(hanging.sending(scope, "session", `hanging-${stage}`), false)
    assert.equal(posts.length, count)
    gate.resolve()
    await until(() => saved.values.size === 0)
    assert.equal(await owner(saved.port).send(entry(`retry-${stage}`), client), "admitted")
  }

  const preparationStorage = storage()
  const preparation = owner(preparationStorage.port, { requestTimeoutMs: 20 })
  const preparationGate = Promise.withResolvers<void>()
  const preparationCount = posts.length
  let clearedAfterDeadline = false
  await assert.rejects(
    preparation.send(entry("hanging-preparation"), client, undefined, async (signal) => {
      await preparationGate.promise
      signal.throwIfAborted()
      clearedAfterDeadline = true
    }),
  )
  preparationGate.resolve()
  await pause(5)
  assert.equal(clearedAfterDeadline, false)
  assert.equal(posts.length, preparationCount)
  await until(() => preparationStorage.values.size === 0)

  // A prepared-only failure has provably not attempted HTTP and must not
  // leave a ghost row when the original composer is retried.
  const prepareStorage = storage()
  const prepare = owner(prepareStorage.port)
  const prepareCount = posts.length
  await assert.rejects(
    prepare.send(entry("prepare-failed"), client, undefined, () => {
      throw new Error("composer migration failed")
    }),
  )
  assert.equal(prepare.get(scope, "session", "prepare-failed"), undefined)
  await until(() => prepareStorage.values.size === 0)
  assert.equal(posts.length, prepareCount)

  // A transient bootstrap failure is retryable on the same service instance.
  let unavailable = true
  const bootStorage = storage()
  const boot = owner({
    ...bootStorage.port,
    keys: () => {
      if (unavailable) throw new Error("storage offline")
      return bootStorage.port.keys()
    },
  })
  await assert.rejects(boot.ready, /storage offline/)
  assert.match(boot.error()!, /storage offline/)
  unavailable = false
  await boot.ready
  assert.equal(boot.error(), undefined)
  assert.equal(await boot.send(entry("bootstrap"), client), "admitted")

  // A late POST can commit after an authoritative missing read. Keep the ID
  // and exact payload through restart, then resolve without a second POST.
  mode = "hold"
  const lateStorage = storage()
  const late = owner(lateStorage.port)
  const lateAbort = new AbortController()
  const lateSend = late.send(entry("late"), client, lateAbort.signal)
  await until(() => received.has("late"))
  lateAbort.abort()
  assert.equal(await lateSend, "unknown")
  assert.equal(await late.check(scope, "session", "late", client), "missing")
  assert.equal(late.get(scope, "session", "late")?.payload.id, "late")
  const restarted = owner(lateStorage.port)
  await restarted.ready
  assert.equal(JSON.stringify(restarted.get(scope, "session", "late")?.payload), JSON.stringify(entry("late").payload))
  const beforeLate = posts.length
  releases.get("late")!()
  await until(() => statuses.has("late"))
  assert.equal(await restarted.check(scope, "session", "late", client), "pending")
  assert.equal(posts.length, beforeLate)

  // Lost response after admission resolves through the stable durable ID.
  mode = "lost"
  const lostStorage = storage()
  const lost = owner(lostStorage.port)
  assert.equal(await lost.send(entry("lost"), client), "unknown")
  const countLost = posts.length
  assert.equal(await lost.check(scope, "session", "lost", client), "pending")
  assert.equal(posts.length, countLost)

  // A later exact retry receiving 4xx cannot erase earlier uncertainty:
  // credentials can be revoked after the original input was admitted.
  mode = "lost"
  const deniedStorage = storage()
  const denied = owner(deniedStorage.port)
  assert.equal(await denied.send(entry("denied-retry"), client), "unknown")
  mode = "reject"
  assert.equal(await denied.send(entry("denied-retry"), client), "unknown")
  assert.equal(denied.get(scope, "session", "denied-retry")?.state, "unknown")
  statuses.set("denied-retry", "promoted")
  assert.equal(await denied.check(scope, "session", "denied-retry", client), "projected")
  await assert.rejects(
    timedRequest(
      () => {
        throw new Error("sync throw")
      },
      undefined,
      5,
    ),
    /sync throw/,
  )
  await pause(10)

  // Missing permits only an explicit exact-ID retry; no background resend.
  mode = "hold"
  const retryStorage = storage()
  const retry = owner(retryStorage.port)
  const retryAbort = new AbortController()
  const retrySend = retry.send(entry("retry"), client, retryAbort.signal)
  await until(() => received.has("retry"))
  retryAbort.abort()
  assert.equal(await retrySend, "unknown")
  assert.equal(await retry.check(scope, "session", "retry", client), "missing")
  const beforeRetry = posts.length
  releases.get("retry")!()
  await until(() => statuses.has("retry"))
  mode = "ok"
  assert.equal(await retry.send(retry.get(scope, "session", "retry")!, client), "admitted")
  assert.equal(posts.length, beforeRetry + 1)
  assert.deepEqual(posts.at(-1)?.payload, posts[beforeRetry - 1].payload)

  // Offline/closed watchers do no reads, never cancel admitted input, and a
  // fresh renderer reattaches a bounded read-only reconciliation.
  mode = "lost"
  const watchedStorage = storage()
  const watched = owner(watchedStorage.port)
  await watched.send(entry("watched"), client)
  let online = false
  const readCount = reads.length
  const watcher = watched.watch({ scope, sessionID: "session", client, online: () => online, onChange() {} })
  await pause(20)
  assert.equal(reads.length, readCount)
  online = true
  holdReads = true
  watcher.refresh()
  await until(() => reads.length > readCount)
  watcher.dispose()
  releases.get("read:watched")!()
  await pause(25)
  assert.equal(watched.get(scope, "session", "watched")?.state, "unknown")
  assert.equal(watchedStorage.values.size, 1)
  holdReads = false
  const reopened = owner(watchedStorage.port)
  const beforeReopen = posts.length
  const restoredWatcher = reopened.watch({ scope, sessionID: "session", client, onChange() {} })
  await until(() => reopened.get(scope, "session", "watched")?.state === "admitted")
  restoredWatcher.dispose()
  assert.equal(posts.length, beforeReopen)

  // In-flight cancellation of delivery itself leaves uncertain intent; an
  // authoritative cancellation alone removes it and informs presentation.
  mode = "hold"
  const cancelledStorage = storage()
  const cancelled = owner(cancelledStorage.port)
  const abort = new AbortController()
  const cancelling = cancelled.send(entry("cancelled"), client, abort.signal)
  await until(() => received.has("cancelled"))
  abort.abort()
  assert.equal(await cancelling, "unknown")
  assert.equal(cancelledStorage.values.size, 1)
  statuses.set("cancelled", "cancelled")
  const cancellations: string[] = []
  const cancellationWatcher = cancelled.watch({
    scope,
    sessionID: "session",
    client,
    onChange() {},
    onCancelled: (id) => cancellations.push(id),
  })
  await until(() => cancellations.length === 1)
  cancellationWatcher.dispose()
  assert.deepEqual(cancellations, ["cancelled"])
  assert.equal(cancelled.get(scope, "session", "cancelled"), undefined)
  releases.get("cancelled")!()

  // A projected event arriving before the failed POST response must win.
  mode = "hold"
  const projectedStorage = storage()
  const projected = owner(projectedStorage.port)
  const projectedAbort = new AbortController()
  const pending = projected.send(entry("projected"), client, projectedAbort.signal)
  await until(() => received.has("projected"))
  projected.settle(scope, "session", "projected", "projected")
  projectedAbort.abort()
  assert.equal(await pending, "admitted")
  assert.equal(projected.get(scope, "session", "projected"), undefined)
  await until(() => projectedStorage.values.size === 0)
  releases.get("projected")!()

  // Confirmation can arrive while persisting the failure status. It wins
  // after that awaited write as well as while the HTTP request was active.
  mode = "lost"
  for (const status of ["pending", "projected", "cancelled"] as const) {
    const racedStorage = storage()
    let writes = 0
    let release: (() => void) | undefined
    const raced = owner({
      ...racedStorage.port,
      setItem: async (key, value) => {
        writes++
        if (writes === 2)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        racedStorage.port.setItem(key, value)
      },
    })
    const sending = raced.send(entry(`raced-${status}`), client)
    await until(() => !!release)
    raced.settle(scope, "session", `raced-${status}`, status)
    release!()
    assert.equal(await sending, status === "cancelled" ? "cancelled" : "admitted")
    assert.equal(raced.get(scope, "session", `raced-${status}`)?.state, status === "pending" ? "admitted" : undefined)
    await until(() => racedStorage.values.size === 0)
  }

  // Failed admission is explicit and retains exact retry intent. Capacity is
  // bounded by refusing a new send, never deleting an unresolved record.
  mode = "reject"
  const boundedStorage = storage()
  const bounded = owner(boundedStorage.port, { maxEntries: 1 })
  assert.equal(await bounded.send(entry("rejected"), client), "rejected")
  assert.equal(bounded.get(scope, "session", "rejected")?.state, "rejected")
  const boundedCount = posts.length
  await assert.rejects(bounded.send(entry("overflow"), client), /Too many prompts/)
  assert.equal(posts.length, boundedCount)
  assert.equal(boundedStorage.values.size, 1)
  await assert.rejects(
    bounded.send(
      { ...entry("rejected"), payload: { ...entry("rejected").payload, prompt: { text: "different" } } },
      client,
    ),
    /different prompt/,
  )

  // Two owners/windows writing unrelated per-intent keys cannot overwrite a
  // journal snapshot. The same Session/message ID on another server is separate.
  const sharedStorage = storage()
  const one = owner(sharedStorage.port)
  const two = owner(sharedStorage.port)
  await Promise.all([one.ready, two.ready])
  const remoteScope = "remote-scope" as typeof scope
  await Promise.all([one.send(entry("shared"), client), two.send(entry("shared", remoteScope), client)])
  assert.equal(sharedStorage.values.size, 2)
  const both = owner(sharedStorage.port)
  await both.ready
  assert.equal(both.entries(scope, "session").length, 1)
  assert.equal(both.entries(remoteScope, "session").length, 1)
  both.settle(remoteScope, "session", "shared", "cancelled")
  assert.equal(both.get(scope, "session", "shared")?.payload.id, "shared")

  // Exercise the desktop storage adapter's asynchronous key enumeration used
  // by the real renderer, with two fresh platform identities after relaunch.
  const desktop = storage()
  const platform = (): Platform => ({
    platform: "desktop",
    openLink() {},
    restart: async () => {},
    back() {},
    forward() {},
    notify: async () => {},
    openDirectoryPickerDialog: async () => null,
    storage(name) {
      assert.equal(name, "turen.prompt-admission.dat")
      return {
        ...desktop.port,
        getItem: async (key) => desktop.port.getItem(key),
        setItem: async (key, value) => desktop.port.setItem(key, value),
        removeItem: async (key) => desktop.port.removeItem(key),
        clear: async () => {},
        key: async (index) => [...desktop.values.keys()][index] ?? null,
        getLength: async () => desktop.values.size,
        length: Promise.resolve(desktop.values.size),
      }
    },
  })
  const desktopOne = promptAdmissionFor(platform())
  await desktopOne.send(entry("desktop"), client)
  const desktopTwo = promptAdmissionFor(platform())
  await desktopTwo.ready
  assert.equal(
    JSON.stringify(desktopTwo.get(scope, "session", "desktop")?.payload),
    JSON.stringify(entry("desktop").payload),
  )
  console.log("prompt admission lifecycle checks passed")
} finally {
  releases.forEach((release) => release())
  await server.stop(true)
}
