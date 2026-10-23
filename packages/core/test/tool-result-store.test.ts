import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { createHash } from "node:crypto"
import { Duration, Effect } from "effect"
import { adjust, layer } from "effect/testing/TestClock"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Global } from "@turenlabs/core/global"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolResultStore } from "@turenlabs/core/tool-result-store"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_retained_results")
const foreignID = SessionV2.ID.make("ses_other_retained_results")
const input = { sessionID, toolCallID: "call_capture", tool: "fixture", text: "retained evidence" }

async function storeAt(data: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ToolResultStore.Service
    }).pipe(Effect.provide(AppNodeBuilder.build(ToolResultStore.node, [[Global.node, Global.layerWith({ data })]]))),
  )
}

function directoryAt(root: string, owner = sessionID) {
  return path.join(root, ToolResultStore.MANAGED_DIRECTORY, createHash("sha256").update(owner).digest("hex"))
}

async function unavailable(effect: Effect.Effect<unknown, ToolResultStore.Error>) {
  const error = await Effect.runPromise(effect.pipe(Effect.flip))
  expect(error.reason).toBe("unavailable")
  expect(error.message).toBe("Retained tool result is unavailable.")
}

describe("ToolResultStore", () => {
  test("survives a new service and preserves original JSON independently of model metadata", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const structured = { retainedResult: "original value", rows: [{ value: 32 }], original: null }
    const reference = await Effect.runPromise(
      store.put({
        ...input,
        assistantMessageID: "msg_capture",
        structured,
        text: "first\n🙂last",
        captureTruncated: true,
      }),
    )
    expect(reference.id).toMatch(/^res_[0-9a-f]{13}_[0-9a-f]{32}$/)
    expect(reference.textBytes).toBe(Buffer.byteLength("first\n🙂last"))
    expect(reference.structuredBytes).toBe(Buffer.byteLength(JSON.stringify(structured)))
    expect(reference.expiresAt - reference.createdAt).toBe(Duration.toMillis(ToolResultStore.RETENTION))
    expect(reference.hasStructured).toBe(true)
    expect(reference.captureTruncated).toBe(true)
    expect(ToolResultStore.referenceOf(ToolResultStore.withReference(structured, reference))).toEqual(reference)
    expect(ToolResultStore.referenceOf(structured)).toBeUndefined()
    expect(ToolResultStore.withReference([1, 2], reference)).toEqual({ data: [1, 2], retainedResult: reference })
    const restarted = await storeAt(tmp.path)
    expect(await Effect.runPromise(restarted.get({ sessionID, id: reference.id }))).toEqual({
      reference,
      text: "first\n🙂last",
      structured,
    })
    expect(await Effect.runPromise(restarted.list({ sessionID }))).toEqual({ results: [reference], incomplete: false })
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(directoryAt(tmp.path), reference.id))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(directoryAt(tmp.path))).mode & 0o777).toBe(0o700)
    }
  })

  test("keeps missing, foreign, traversal and malformed handles indistinguishable", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const reference = await Effect.runPromise(store.put(input))
    for (const id of ["../outside", "/etc/passwd", "res_" + "a".repeat(100), "", reference.id + "/../other"])
      await unavailable(store.get({ sessionID, id }))
    await unavailable(store.get({ sessionID: foreignID, id: reference.id }))
    await unavailable(store.get({ sessionID, id: "res_0000000000000_00000000000000000000000000000000" }))
    expect(await Effect.runPromise(store.list({ sessionID: foreignID }))).toEqual({ results: [], incomplete: false })
    await fs.mkdir(directoryAt(tmp.path, foreignID))
    await fs.copyFile(
      path.join(directoryAt(tmp.path), reference.id),
      path.join(directoryAt(tmp.path, foreignID), reference.id),
    )
    await unavailable(store.get({ sessionID: foreignID, id: reference.id }))
  })

  test("expires at seven days even before bounded cleanup runs", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const reference = yield* store.put(input)
        yield* adjust(Duration.days(7))
        const error = yield* store.get({ sessionID, id: reference.id }).pipe(Effect.flip)
        expect(error.reason).toBe("unavailable")
        expect(yield* store.list({ sessionID })).toEqual({ results: [], incomplete: false })
        yield* Effect.promise(() => fs.writeFile(path.join(directoryAt(tmp.path), "keep.txt"), "unrelated"))
        yield* store.cleanup()
        expect(yield* Effect.promise(() => exists(path.join(directoryAt(tmp.path), reference.id)))).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(path.join(directoryAt(tmp.path), "keep.txt"), "utf8"))).toBe(
          "unrelated",
        )
      }).pipe(Effect.provide(layer())),
    )
  })

  test("cleans expired crash temporaries while preserving recent, unrelated and symlink entries", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const expired = yield* store.put(input)
        const oldTemporary = path.join(directoryAt(tmp.path), `${expired.id}.0123456789abcdef.tmp`)
        const malformed = path.join(directoryAt(tmp.path), `${expired.id}.invalid.tmp`)
        const outside = path.join(tmp.path, "outside")
        const symlink = path.join(directoryAt(tmp.path), `${expired.id}.fedcba9876543210.tmp`)
        yield* Effect.promise(async () => {
          await fs.writeFile(oldTemporary, "incomplete crash capture")
          await fs.writeFile(malformed, "unrelated")
          await fs.writeFile(outside, "external evidence")
          await fs.symlink(outside, symlink)
        })
        yield* adjust(Duration.days(7))
        const recent = yield* store.put({ ...input, toolCallID: "recent" })
        const recentTemporary = path.join(directoryAt(tmp.path), `${recent.id}.0123456789abcdef.tmp`)
        yield* Effect.promise(() => fs.writeFile(recentTemporary, "active capture"))
        yield* store.cleanup()
        expect(yield* Effect.promise(() => exists(oldTemporary))).toBe(false)
        expect(yield* Effect.promise(() => exists(path.join(directoryAt(tmp.path), expired.id)))).toBe(false)
        expect(yield* Effect.promise(() => exists(recentTemporary))).toBe(true)
        expect(yield* Effect.promise(() => exists(malformed))).toBe(true)
        expect(yield* Effect.promise(() => fs.lstat(symlink).then((info) => info.isSymbolicLink()))).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(outside, "utf8"))).toBe("external evidence")
        expect((yield* store.get({ sessionID, id: recent.id })).text).toBe(input.text)
      }).pipe(Effect.provide(layer())),
    )
  })

  test("bounded cleanup retires empty managed Sessions and advances on later passes", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const expired = yield* store.put(input)
        const root = path.join(tmp.path, ToolResultStore.MANAGED_DIRECTORY)
        const unrelated = path.join(root, "keep-empty")
        yield* Effect.promise(async () => {
          await Promise.all(
            Array.from({ length: ToolResultStore.MAX_SCAN + 1 }, (_, index) =>
              fs.mkdir(path.join(root, index.toString(16).padStart(64, "0")), { mode: 0o700 }),
            ),
          )
          await fs.mkdir(unrelated)
        })
        yield* adjust(Duration.days(7))
        yield* store.cleanup()
        yield* store.cleanup()
        yield* store.cleanup()
        expect(yield* Effect.promise(() => exists(path.join(directoryAt(tmp.path), expired.id)))).toBe(false)
        expect(yield* Effect.promise(() => exists(directoryAt(tmp.path)))).toBe(false)
        expect(yield* Effect.promise(() => fs.readdir(root))).toEqual(["keep-empty"])
        expect(yield* Effect.promise(() => exists(unrelated))).toBe(true)
      }).pipe(Effect.provide(layer())),
    )
  })

  test("rejects body corruption and changed provenance without exposing stored bytes", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const reference = await Effect.runPromise(store.put(input))
    const file = path.join(directoryAt(tmp.path), reference.id)
    const original = await fs.readFile(file, "utf8")
    await fs.writeFile(file, original.replace("retained evidence", "altered evidence!"))
    await unavailable(store.get({ sessionID, id: reference.id }))
    const header = JSON.parse(original.slice(0, original.indexOf("\n")))
    header.reference.tool = "tampered provenance"
    await fs.writeFile(file, JSON.stringify(header) + original.slice(original.indexOf("\n")))
    await unavailable(store.get({ sessionID, id: reference.id }))
    await fs.writeFile(file, "{invalid JSON}")
    await unavailable(store.get({ sessionID, id: reference.id }))
    await fs.truncate(file, ToolResultStore.MAX_BYTES + 1)
    await unavailable(store.get({ sessionID, id: reference.id }))
  })

  test("refuses result and managed-directory symlinks", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const reference = await Effect.runPromise(store.put(input))
    const file = path.join(directoryAt(tmp.path), reference.id)
    const outside = path.join(tmp.path, "outside")
    await fs.rename(file, outside)
    await fs.symlink(outside, file)
    await unavailable(store.get({ sessionID, id: reference.id }))
    expect((await Effect.runPromise(store.list({ sessionID }))).results).toEqual([])
    await fs.unlink(file)
    await fs.rmdir(directoryAt(tmp.path))
    await fs.mkdir(path.join(tmp.path, "external-directory"))
    await fs.symlink(path.join(tmp.path, "external-directory"), directoryAt(tmp.path), "dir")
    await unavailable(store.get({ sessionID, id: reference.id }))
    expect((await Effect.runPromise(store.put(input).pipe(Effect.flip))).reason).toBe("write_failed")
    expect(await fs.readdir(path.join(tmp.path, "external-directory"))).toEqual([])
  })

  test("caps the serialized envelope and refuses non-JSON structured data", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const text = "x".repeat(ToolResultStore.MAX_BYTES - 8192)
    const reference = await Effect.runPromise(store.put({ ...input, text }))
    expect((await Effect.runPromise(store.get({ sessionID, id: reference.id }))).text).toBe(text)
    expect((await fs.stat(path.join(directoryAt(tmp.path), reference.id))).size).toBeLessThanOrEqual(
      ToolResultStore.MAX_BYTES,
    )
    for (const text of ["x".repeat(ToolResultStore.MAX_BYTES), "\n".repeat(ToolResultStore.MAX_BYTES / 2)])
      expect(["too_large", "invalid_input"]).toContain(
        (await Effect.runPromise(store.put({ ...input, text }).pipe(Effect.flip))).reason,
      )
    expect(
      (await Effect.runPromise(store.put({ ...input, structured: { value: 1n } as never }).pipe(Effect.flip))).reason,
    ).toBe("invalid_input")
    expect(["too_large", "invalid_input"]).toContain(
      (
        await Effect.runPromise(
          store.put({ ...input, structured: { value: "x".repeat(ToolResultStore.MAX_BYTES) } }).pipe(Effect.flip),
        )
      ).reason,
    )
  })

  test("rejects deeply nested and exponentially shared direct put inputs before expansion", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const deep = Array.from({ length: 20_000 }).reduce<unknown>((value) => ({ child: value }), "leaf")
    const shared = Array.from({ length: 40 }).reduce<unknown>((value) => ({ left: value, right: value }), "leaf")
    for (const structured of [deep, shared]) {
      const error = await Effect.runPromise(store.put({ ...input, structured: structured as never }).pipe(Effect.flip))
      expect(error).toBeInstanceOf(ToolResultStore.StorageError)
      expect(["invalid_input", "too_large"]).toContain(error.reason)
      expect(error.message).not.toContain("RangeError")
    }
    expect(await exists(path.join(tmp.path, ToolResultStore.MANAGED_DIRECTORY))).toBe(false)
  }, 5000)

  test("rejects references outside the Date range while retaining valid timestamp references", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const reference = await Effect.runPromise(store.put(input))
    expect(ToolResultStore.referenceOf({ retainedResult: reference })).toEqual(reference)
    expect(new Date(reference.expiresAt).toISOString()).toBeString()
    for (const timestamp of [8_640_000_000_000_001, Number.MAX_SAFE_INTEGER]) {
      expect(ToolResultStore.referenceOf({ retainedResult: { ...reference, createdAt: timestamp } })).toBeUndefined()
      expect(ToolResultStore.referenceOf({ retainedResult: { ...reference, expiresAt: timestamp } })).toBeUndefined()
    }
    expect((await Effect.runPromise(store.get({ sessionID, id: reference.id }))).reference).toEqual(reference)
  })

  test("commits concurrent captures atomically and paginates complete directory scans", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    const writing = Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        Effect.runPromise(store.put({ ...input, toolCallID: `call_${index}`, text: `result ${index}` })),
      ),
    )
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const page = await Effect.runPromise(store.list({ sessionID }))
        for (const reference of page.results)
          expect((await Effect.runPromise(store.get({ sessionID, id: reference.id }))).text).toStartWith("result ")
      }),
    )
    const references = await writing
    expect(new Set(references.map((reference) => reference.id)).size).toBe(references.length)
    const discovered: ToolResultStore.Reference[] = []
    let cursor: string | undefined
    do {
      const page = await Effect.runPromise(store.list({ sessionID, limit: 9, cursor }))
      expect(page.incomplete).toBe(false)
      discovered.push(...page.results)
      cursor = page.nextCursor
    } while (cursor)
    expect(discovered.map((reference) => reference.id)).toEqual(references.map((reference) => reference.id).sort())
    expect((await fs.readdir(directoryAt(tmp.path))).every((entry) => !entry.endsWith(".tmp"))).toBe(true)
    for (const reference of discovered)
      expect((await Effect.runPromise(store.get({ sessionID, id: reference.id }))).reference).toEqual(reference)
  })

  test("discloses capped discovery without inventing an exhaustive continuation", async () => {
    await using tmp = await tmpdir()
    const store = await storeAt(tmp.path)
    await Promise.all(
      Array.from({ length: ToolResultStore.MAX_SCAN + 1 }, (_, index) =>
        Effect.runPromise(store.put({ ...input, toolCallID: `call_${index}` })),
      ),
    )
    const page = await Effect.runPromise(store.list({ sessionID, limit: 3 }))
    expect(page.results).toHaveLength(3)
    expect(page.incomplete).toBe(true)
    expect(page.nextCursor).toBeUndefined()
    await unavailable(store.list({ sessionID, cursor: "../other" }))
    await unavailable(store.list({ sessionID, limit: ToolResultStore.MAX_LIST + 1 }))
  })
})

async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}
