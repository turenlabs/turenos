import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Queue } from "effect"
import { Config } from "@turenlabs/core/config"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { Pty } from "@turenlabs/core/pty"
import type { PtyID } from "@turenlabs/core/pty/schema"
import { AbsolutePath } from "@turenlabs/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

type PtyEvent = { type: "created" | "exited" | "deleted"; id: PtyID }

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

const subscribePtyEvents = Effect.fn("PtySessionTest.subscribePtyEvents")(function* () {
  const source = yield* EventV2.Service
  const events = yield* Queue.unbounded<PtyEvent>()
  const unsubscribe = yield* source.listen((event) => {
    if (event.type === Pty.Event.Created.type)
      Queue.offerUnsafe(events, { type: "created", id: (event.data as typeof Pty.Event.Created.data.Type).info.id })
    if (event.type === Pty.Event.Exited.type)
      Queue.offerUnsafe(events, { type: "exited", id: (event.data as typeof Pty.Event.Exited.data.Type).id })
    if (event.type === Pty.Event.Deleted.type)
      Queue.offerUnsafe(events, { type: "deleted", id: (event.data as typeof Pty.Event.Deleted.data.Type).id })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return events
})

const createPty = Effect.fn("PtySessionTest.createPty")(function* (command: string, args: string[] = []) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({ command, args, cwd: "/tmp", env: { TERM: "xterm-256color", FORGE_TERMINAL: "1" } }),
    (info) => pty.remove(info.id).pipe(Effect.ignore),
  )
})

const waitForEvents = (events: Queue.Queue<PtyEvent>, id: PtyID, count: number) =>
  Effect.gen(function* () {
    const picked: Array<PtyEvent["type"]> = []
    while (picked.length < count) {
      const evt = yield* Queue.take(events)
      if (evt.id === id) picked.push(evt.type)
    }
    return picked
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timeout waiting for pty events")),
    }),
  )

const attachCollecting = Effect.fn("PtySessionTest.attachCollecting")(function* (id: PtyID, cursor?: number) {
  const pty = yield* Pty.Service
  const output = yield* Queue.unbounded<string>()
  const ended = yield* Deferred.make<{ exitCode?: number }>()
  const attachment = yield* pty.attach(id, {
    cursor,
    onData: (chunk) => Queue.offerUnsafe(output, chunk),
    onEnd: (event) => Deferred.doneUnsafe(ended, Effect.succeed(event)),
  })
  attachment.activate()
  return { attachment, output, ended }
})

const waitForOutput = (output: Queue.Queue<string>, text: string) =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) received += yield* Queue.take(output)
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

const SCROLLBACK_LIMIT = 2 * 1024 * 1024

// Starts a PTY that waits for input, then prints enough output to overflow the scrollback and parks in cat.
// Resolves with the complete live stream, which is the reference for what the scrollback should retain.
const floodPty = Effect.fn("PtySessionTest.floodPty")(function* (script: string) {
  const pty = yield* Pty.Service
  const info = yield* createPty("/usr/bin/env", ["sh", "-c", `read x; ${script}; echo DONE; exec cat`])
  const chunks: string[] = []
  const done = yield* Deferred.make<void>()
  let tail = ""
  const attachment = yield* pty.attach(info.id, {
    cursor: -1,
    onData: (chunk) => {
      chunks.push(chunk)
      tail = (tail + chunk).slice(-16)
      if (tail.endsWith("DONE\r\n")) Deferred.doneUnsafe(done, Effect.void)
    },
    onEnd: () => {},
  })
  attachment.activate()
  attachment.write("\n")
  yield* Deferred.await(done).pipe(Effect.timeout("25 seconds"))
  // The waiter can resume inside onData, before the session has stored that chunk.
  const stream = chunks.join("")
  const total = attachment.cursor + stream.length
  while ((yield* pty.snapshot(info.id, total - 1)).output === "") yield* Effect.sleep("5 millis")
  return { id: info.id, stream, base: attachment.cursor }
})

describe("pty", () => {
  it.live("returns typed not found errors for missing sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const id = "pty_missing" as PtyID

      for (const result of [
        yield* pty.get(id).pipe(Effect.asVoid, Effect.exit),
        yield* pty.update(id, { title: "missing" }).pipe(Effect.asVoid, Effect.exit),
        yield* pty.remove(id).pipe(Effect.exit),
        yield* pty.write(id, "input").pipe(Effect.exit),
        yield* pty.attach(id, { onData: () => {}, onEnd: () => {} }).pipe(Effect.asVoid, Effect.exit),
      ]) {
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.NotFoundError", ptyID: id })
      }
    }),
  )

  ptyTest("retains exited sessions until removed", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* subscribePtyEvents()
      const info = yield* createPty("/usr/bin/env", ["sh", "-c", "exit 3"])

      expect(yield* waitForEvents(events, info.id, 2)).toEqual(["created", "exited"])
      const exited = yield* pty.get(info.id)
      expect(exited.status).toBe("exited")
      expect(exited.exitCode).toBe(3)

      yield* pty.remove(info.id)
      expect(yield* waitForEvents(events, info.id, 1)).toEqual(["deleted"])
      const missing = yield* pty.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  )

  ptyTest("replays buffered output and streams live output to attachments", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      yield* pty.write(info.id, "AAA\n")

      const first = yield* attachCollecting(info.id)
      expect(yield* waitForOutput(first.output, "AAA")).toContain("AAA")

      first.attachment.write("BBB\n")
      yield* waitForOutput(first.output, "BBB")

      // A later attachment replays everything already buffered.
      const replayed = yield* attachCollecting(info.id)
      expect(replayed.attachment.replay).toContain("AAA")
      expect(replayed.attachment.replay).toContain("BBB")
      expect(replayed.attachment.cursor).toBeGreaterThan(0)

      // Tail attachments skip the buffer and only see subsequent output.
      const tail = yield* attachCollecting(info.id, -1)
      expect(tail.attachment.replay).toBe("")
      expect(tail.attachment.cursor).toBe(replayed.attachment.cursor)
    }),
  )

  ptyTest(
    "keeps the newest 2 MiB of scrollback and serves cursors from the retained window",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const flood = yield* floodPty("seq 1 450000")
        expect(flood.stream.length).toBeGreaterThan(SCROLLBACK_LIMIT + 512 * 1024)

        const total = flood.base + flood.stream.length
        const retained = flood.stream.slice(-SCROLLBACK_LIMIT)
        const windowStart = total - SCROLLBACK_LIMIT

        const full = yield* pty.snapshot(flood.id)
        expect(full.cursor).toBe(total)
        expect(full.output.length).toBe(SCROLLBACK_LIMIT)
        expect(full.output === retained).toBe(true)

        // A cursor older than the window returns the whole retained buffer.
        const old = yield* pty.snapshot(flood.id, 5)
        expect(old.cursor).toBe(total)
        expect(old.output === retained).toBe(true)

        for (const cursor of [
          windowStart,
          windowStart + 1,
          windowStart + 4097,
          total - 100_000,
          total - 7,
          total - 1,
        ]) {
          const result = yield* pty.snapshot(flood.id, cursor)
          expect(result.cursor).toBe(total)
          expect(result.output === flood.stream.slice(cursor - flood.base)).toBe(true)
        }

        expect((yield* pty.snapshot(flood.id, total)).output).toBe("")
        expect((yield* pty.snapshot(flood.id, total + 10)).output).toBe("")
        expect((yield* pty.snapshot(flood.id, Number.NaN)).output === retained).toBe(true)
      }),
    30_000,
  )

  ptyTest(
    "bounds scrollback for a single run of output without newlines",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const flood = yield* floodPty("head -c 3000000 /dev/zero | tr '\\0' y")
        const snapshot = yield* pty.snapshot(flood.id)
        expect(snapshot.cursor).toBe(flood.base + flood.stream.length)
        expect(snapshot.output.length).toBe(SCROLLBACK_LIMIT)
        expect(snapshot.output === flood.stream.slice(-SCROLLBACK_LIMIT)).toBe(true)
      }),
    30_000,
  )

  ptyTest(
    "attaches to an overflowed running session with replay from the retained window",
    () =>
      Effect.gen(function* () {
        const flood = yield* floodPty("seq 1 450000")
        const total = flood.base + flood.stream.length
        const retained = flood.stream.slice(-SCROLLBACK_LIMIT)

        const replayed = yield* attachCollecting(flood.id)
        expect(replayed.attachment.cursor).toBe(total)
        expect(replayed.attachment.replay === retained).toBe(true)

        const inside = yield* attachCollecting(flood.id, total - 50_000)
        expect(inside.attachment.replay === flood.stream.slice(-50_000)).toBe(true)

        const old = yield* attachCollecting(flood.id, 1)
        expect(old.attachment.replay === retained).toBe(true)

        const tail = yield* attachCollecting(flood.id, -1)
        expect(tail.attachment.replay).toBe("")
        expect(tail.attachment.cursor).toBe(total)

        const current = yield* attachCollecting(flood.id, total)
        expect(current.attachment.replay).toBe("")
      }),
    30_000,
  )

  ptyTest(
    "snapshot from a subscriber callback ignores the chunk not yet stored",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createPty("/usr/bin/env", [
          "sh",
          "-c",
          "stty -echo; read x; printf alpha; read x; printf bravo; exec cat",
        ])
        const output = yield* Queue.unbounded<string>()
        const checked = yield* Deferred.make<{ output: string }>()
        let from: number | undefined
        const attachment = yield* pty.attach(info.id, {
          cursor: -1,
          onData: (chunk) => {
            Queue.offerUnsafe(output, chunk)
            if (from === undefined || !chunk.includes("bravo")) return
            Deferred.doneUnsafe(checked, Effect.succeed(Effect.runSync(pty.snapshot(info.id, from))))
          },
          onEnd: () => {},
        })
        attachment.activate()
        attachment.write("\n")
        yield* waitForOutput(output, "alpha")
        while (!(yield* pty.snapshot(info.id)).output.endsWith("alpha")) yield* Effect.sleep("5 millis")
        from = (yield* pty.snapshot(info.id)).cursor
        attachment.write("\n")
        const result = yield* Deferred.await(checked).pipe(Effect.timeout("5 seconds"))
        expect(result.output).toBe("")
        while ((yield* pty.snapshot(info.id, from)).output !== "bravo") yield* Effect.sleep("5 millis")
      }),
    30_000,
  )

  ptyTest(
    "snapshot from a subscriber callback on the first chunk does not defect",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createPty("/usr/bin/env", ["sh", "-c", "stty -echo; read x; printf abcde; exec cat"])
        const checked = yield* Deferred.make<string>()
        const attachment = yield* pty.attach(info.id, {
          cursor: -1,
          onData: (chunk) => {
            if (!chunk.includes("abcde")) return
            Deferred.doneUnsafe(checked, Effect.succeed(Effect.runSync(pty.snapshot(info.id, 1)).output))
          },
          onEnd: () => {},
        })
        attachment.activate()
        attachment.write("\n")
        expect(yield* Deferred.await(checked).pipe(Effect.timeout("5 seconds"))).not.toContain("abcde")
        yield* Effect.gen(function* () {
          while (!(yield* pty.snapshot(info.id)).output.endsWith("abcde")) yield* Effect.sleep("5 millis")
        }).pipe(Effect.timeout("5 seconds"))
      }),
    30_000,
  )

  ptyTest("stops delivering output after detach", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      const attached = yield* attachCollecting(info.id, -1)

      attached.attachment.detach()
      yield* pty.write(info.id, "AAA\n")

      const verify = yield* attachCollecting(info.id)
      yield* waitForOutput(verify.output, "AAA")
      const leaked = yield* Queue.poll(attached.output)
      expect(leaked._tag).toBe("None")
    }),
  )

  ptyTest("isolates output between sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const a = yield* createPty("cat")
      const b = yield* createPty("cat")
      const attachedA = yield* attachCollecting(a.id)
      const attachedB = yield* attachCollecting(b.id)

      yield* pty.write(a.id, "AAA\n")
      yield* waitForOutput(attachedA.output, "AAA")

      const leaked = yield* Queue.poll(attachedB.output)
      expect(leaked._tag).toBe("None")
    }),
  )

  ptyTest("notifies attachments with the exit code and rejects attach after exit", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* subscribePtyEvents()
      const info = yield* createPty("cat")
      const attached = yield* attachCollecting(info.id)

      yield* pty.write(info.id, "\u0004")
      expect(yield* Deferred.await(attached.ended).pipe(Effect.timeout("5 seconds"))).toEqual({ exitCode: 0 })
      yield* waitForEvents(events, info.id, 2)

      const result = yield* pty.attach(info.id, { onData: () => {}, onEnd: () => {} }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.ExitedError", ptyID: info.id })
    }),
  )
})

const configuredShell = process.platform === "win32" ? undefined : Bun.which("bash")
const configuredIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [
      Config.node,
      Layer.mock(Config.Service)({
        entries: () =>
          Effect.succeed(
            configuredShell
              ? [new Config.Document({ type: "document", info: new Config.Info({ shell: configuredShell }) })]
              : [],
          ),
      }),
    ],
    [Location.node, locationLayer],
  ]),
)
const configuredTest = process.platform === "win32" ? configuredIt.live.skip : configuredIt.live

describe("pty create defaults", () => {
  configuredTest("defaults command, login args, and cwd from config and location", () =>
    Effect.gen(function* () {
      if (!configuredShell) return
      const pty = yield* Pty.Service
      const info = yield* Effect.acquireRelease(pty.create({ title: "configured" }), (created) =>
        pty.remove(created.id).pipe(Effect.ignore),
      )
      expect(info.command).toBe(configuredShell)
      expect(info.args).toEqual(["-l"])
      expect(info.cwd).toBe("/tmp")
      expect(info.title).toBe("configured")
    }),
  )
})
