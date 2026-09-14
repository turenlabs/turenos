import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { deflateSync } from "node:zlib"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { GitInspectRuntime } from "@turenlabs/core/tool/git-inspect-runtime"
import { GitInspectTools } from "@turenlabs/core/tool/git-inspect-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(Layer.empty)

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        GitInspectRuntime.node,
        GitInspectTools.node,
      ]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    ),
  )

// ---- fixture builders (ported from tools/git-inspect/test/verify.mjs) -------

const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest()
const u32be = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])

const loose = (kind: string, content: Buffer) =>
  deflateSync(Buffer.concat([Buffer.from(`${kind} ${content.length}\0`), content]))

const entryHeader = (kind: number, size: number) => {
  const out = []
  let first = ((kind & 7) << 4) | (size & 0x0f)
  let rest = BigInt(size) >> 4n
  if (rest > 0n) first |= 0x80
  out.push(first)
  while (rest > 0n) {
    let b = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest > 0n) b |= 0x80
    out.push(b)
  }
  return Buffer.from(out)
}

// git's offset varint (with +1 carry), most significant group first.
const offsetVarint = (value: bigint) => {
  const out = [Number(value & 0x7fn)]
  let v = value >> 7n
  while (v > 0n) {
    v -= 1n
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  return Buffer.from(out.reverse())
}

// delta-payload varint: little-endian 7-bit groups, MSB continuation.
const deltaVarint = (value: number) => {
  const out = []
  let v = BigInt(value)
  for (;;) {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
    if (v === 0n) return Buffer.from(out)
  }
}

const copyOp = (offset: number, size: number) => {
  let cmd = 0x80
  const tail = []
  const ob = Buffer.alloc(4)
  ob.writeUInt32LE(offset)
  const sb = Buffer.alloc(4)
  sb.writeUInt32LE(size)
  for (let i = 0; i < 4; i++) if (ob[i] !== 0) { cmd |= 1 << i; tail.push(ob[i]) }
  for (let i = 0; i < 3; i++) if (sb[i] !== 0) { cmd |= 0x10 << i; tail.push(sb[i]) }
  return Buffer.from([cmd, ...tail])
}
const insertOp = (data: Buffer) => Buffer.from([data.length, ...data])
const delta = (baseLen: number, resultLen: number, ops: Buffer[]) =>
  Buffer.concat([deltaVarint(baseLen), deltaVarint(resultLen), Buffer.concat(ops)])

type PackEntry = { kind: number; data: Buffer } | { ofsDelta: number; delta: Buffer }
const pack = (entries: PackEntry[]) => {
  const parts: Buffer[] = [Buffer.from("PACK"), u32be(2), u32be(entries.length)]
  const offsets = []
  for (const e of entries) {
    offsets.push(Buffer.concat(parts).length)
    if ("data" in e) {
      parts.push(entryHeader(e.kind, e.data.length), deflateSync(e.data))
    } else {
      const distance = Buffer.concat(parts).length - offsets[e.ofsDelta]!
      parts.push(entryHeader(6, e.delta.length), offsetVarint(BigInt(distance)), deflateSync(e.delta))
    }
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, sha1(body)])
}

const dircEntry = (path: string, sha: Buffer, mode: number, opts: { stage?: number; size?: number } = {}) => ({
  path,
  sha,
  mode,
  stage: opts.stage ?? 0,
  size: opts.size ?? 0,
})
const dircV2 = (entries: ReadonlyArray<ReturnType<typeof dircEntry>>, extensions: ReadonlyArray<readonly [string, Buffer]> = []) => {
  const parts: Buffer[] = [Buffer.from("DIRC"), u32be(2), u32be(entries.length)]
  for (const e of entries) {
    const fixed = [1700000000, 123456789, 1700000100, 987654321, 0x8001, 0xdead, e.mode, 501, 20, e.size]
    for (const v of fixed) parts.push(u32be(v))
    parts.push(e.sha)
    const flags = ((e.stage & 3) << 12) | Math.min(Buffer.byteLength(e.path), 0xfff)
    parts.push(Buffer.from([flags >> 8, flags & 0xff]))
    const name = Buffer.from(e.path)
    parts.push(name)
    const pad = 8 - ((62 + name.length) % 8)
    parts.push(Buffer.alloc(pad))
  }
  for (const [name, payload] of extensions) {
    parts.push(Buffer.from(name), u32be(payload.length), payload)
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, sha1(body)])
}

const BLOB = Buffer.from("test content\n")
// Canonical git object id for `blob 13\0test content\n` (Pro Git 10.2).
const BLOB_SHA1 = "d670460b4b4aece5915caf5c68d12f560a9fe3e4"
const COMMIT = Buffer.from(
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
    "author A U Thor <author@example.com> 1700000000 +0000\n" +
    "committer C O Mitter <commit@example.com> 1700000100 -0800\n" +
    "\nInitial commit\n",
)
const BASE = Buffer.from("hello world, this is base content")
const RESOLVED = Buffer.from("hello WORLD!")
const PACK = pack([
  { kind: 3, data: BASE },
  { ofsDelta: 0, delta: delta(BASE.length, RESOLVED.length, [copyOp(0, 5), insertOp(Buffer.from(" WORLD!"))]) },
  { kind: 1, data: COMMIT },
])
const DIRC = dircV2(
  [
    dircEntry("src/main.rs", Buffer.alloc(20, 0x11), 0o100644, { size: 1234 }),
    dircEntry("README.md", Buffer.alloc(20, 0x22), 0o100644, { stage: 1, size: 56 }),
  ],
  [["TREE", Buffer.from("\x00tree-data")]],
)

describe("GitInspectRuntime and GitInspectTools", () => {
  it.live("inspects loose objects, packs, and indexes through a fresh git-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/blob`, loose("blob", BLOB)))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/commit`, loose("commit", COMMIT)))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/test.pack`, PACK))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/index`, DIRC))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage`, "definitely not git storage"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of [
            "git_identify",
            "git_index_inspect",
            "git_object_decode",
            "git_pack_inspect",
            "git_pack_entry",
            "git_pack_entry_raw",
          ])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_git_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const idBlob = yield* call("call-identify-blob", "git_identify", { path: "blob" })
          expect(idBlob.type).toBe("text")
          if (idBlob.type !== "text") return
          expect(idBlob.value).toContain('"kind": "loose-object"')
          expect(idBlob.value).toContain('"objectType": "blob"')

          const idPack = yield* call("call-identify-pack", "git_identify", { path: "test.pack" })
          expect(idPack.type).toBe("text")
          if (idPack.type !== "text") return
          expect(idPack.value).toContain('"kind": "pack"')
          expect(idPack.value).toContain('"declaredObjects": 3')

          const idIndex = yield* call("call-identify-index", "git_identify", { path: "index" })
          expect(idIndex.type).toBe("text")
          if (idIndex.type !== "text") return
          expect(idIndex.value).toContain('"kind": "index"')

          const decoded = yield* call("call-object-decode", "git_object_decode", { path: "blob" })
          expect(decoded.type).toBe("text")
          if (decoded.type !== "text") return
          expect(decoded.value).toContain('"type": "blob"')
          expect(decoded.value).toContain(`"sha1": "${BLOB_SHA1}"`)
          expect(decoded.value).toContain('"sizeMatchesDeclared": true')

          const commit = yield* call("call-object-commit", "git_object_decode", { path: "commit" })
          expect(commit.type).toBe("text")
          if (commit.type !== "text") return
          expect(commit.value).toContain('"type": "commit"')
          expect(commit.value).toContain('"tree": "4b825dc642cb6eb9a060e54bf8d69288fbee4904"')
          expect(commit.value).toContain('"Initial commit')

          const packReport = yield* call("call-pack-inspect", "git_pack_inspect", { path: "test.pack" })
          expect(packReport.type).toBe("text")
          if (packReport.type !== "text") return
          expect(packReport.value).toContain('"declaredObjects": 3')
          expect(packReport.value).toContain('"parsedObjects": 3')
          expect(packReport.value).toContain('"type": "ofs_delta"')
          expect(packReport.value).toContain('"ofsDeltaCount": 1')
          const entries = (JSON.parse(String(packReport.value)) as { entries: { offset: number }[] }).entries
          const firstOffset = entries[0]!.offset
          expect(firstOffset).toBe(12)

          const byIndex = yield* call("call-pack-entry-index", "git_pack_entry", {
            path: "test.pack",
            index: 1,
          })
          expect(byIndex.type).toBe("text")
          if (byIndex.type !== "text") return
          expect(byIndex.value).toContain('"type": "blob"')
          expect(byIndex.value).toContain('"chainDepth": 1')
          expect(byIndex.value).toContain('"size": 12')

          const byOffset = yield* call("call-pack-entry-offset", "git_pack_entry", {
            path: "test.pack",
            offset: firstOffset,
          })
          expect(byOffset.type).toBe("text")
          if (byOffset.type !== "text") return
          expect(byOffset.value).toContain('"type": "blob"')
          expect(byOffset.value).toContain(`"size": ${BASE.length}`)

          const raw = yield* call("call-pack-entry-raw", "git_pack_entry_raw", {
            path: "test.pack",
            index: 1,
          })
          expect(raw.type).toBe("text")
          if (raw.type !== "text") return
          expect(raw.value).toContain("12-byte pack entry")
          const rawPath = / to (\S+) \(sha256/.exec(String(raw.value))?.[1]
          expect(rawPath).toBeTruthy()
          const rawBytes = yield* Effect.promise(() => fs.readFile(rawPath!))
          expect(Buffer.compare(rawBytes, RESOLVED)).toBe(0)

          const index = yield* call("call-index-inspect", "git_index_inspect", { path: "index" })
          expect(index.type).toBe("text")
          if (index.type !== "text") return
          expect(index.value).toContain('"kind": "index"')
          expect(index.value).toContain('"version": 2')
          expect(index.value).toContain('"path": "src/main.rs"')
          expect(index.value).toContain('"stage": 1')
          expect(index.value).toContain('"name": "TREE"')
          expect(index.value).toContain('"checksumValid": true')

          const noSelector = yield* call("call-pack-entry-none", "git_pack_entry", { path: "test.pack" })
          expect(noSelector.type).toBe("error")
          const bothSelectors = yield* call("call-pack-entry-both", "git_pack_entry", {
            path: "test.pack",
            index: 0,
            offset: firstOffset,
          })
          expect(bothSelectors.type).toBe("error")
          const notPack = yield* call("call-pack-inspect-garbage", "git_pack_inspect", { path: "garbage" })
          expect(notPack.type).toBe("error")
          const notLoose = yield* call("call-object-decode-pack", "git_object_decode", { path: "test.pack" })
          expect(notLoose.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
