import { createHash } from "crypto"
import nfs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { Memory } from "@turenlabs/core/memory"
import { Memory as MemorySchema } from "@turenlabs/schema/memory"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { MemoryTool } from "@turenlabs/core/tool/memory"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Database } from "@turenlabs/core/database/database"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const activeLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp/forge-memory-tool") })),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Memory.node, ToolRegistry.node, ToolRegistry.toolsNode, MemoryTool.node]),
  [
    [Location.node, activeLocation],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)

/**
 * A second memory-tool graph for another directory, sharing the caller's
 * database so both graphs see the same wings, drawers, and identity bindings.
 */
const openedAt = (directory: string, database: Database.Interface) =>
  AppNodeBuilder.build(LayerNode.group([Memory.node, ToolRegistry.node, ToolRegistry.toolsNode, MemoryTool.node]), [
    [Database.node, Layer.succeed(Database.Service, database)],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])

const sessionID = SessionV2.ID.make("ses_memory_tool_test")
const call = (name: string, input: unknown, id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const it = testEffect(layer)
// Deliberately without a tool registry of its own: `Effect.provide` merges
// behind the ambient context rather than shadowing it, so a registry here would
// answer for the per-directory graphs `openedAt` builds.
const itAcrossDirectories = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node])))

describe("MemoryTool wing name", () => {
  test("keeps POSIX and Windows filesystem roots non-empty", () => {
    expect(MemoryTool.wingName("/", path.posix.basename)).toBe("/")
    expect(MemoryTool.wingName("/home/forge", path.posix.basename)).toBe("forge")
    expect(MemoryTool.wingName("C:\\", path.win32.basename)).toBe("C:\\")
    expect(MemoryTool.wingName("C:\\Users\\forge", path.win32.basename)).toBe("forge")
  })
})

describe("MemoryTool", () => {
  it.effect("registers project-scoped read and write tools", () =>
    Effect.gen(function* () {
      assertions.length = 0
      denyAction = undefined
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name).toSorted()).toEqual([
        "memory_forget",
        "memory_read",
        "memory_search",
        "memory_write",
      ])

      const written = yield* executeTool(
        registry,
        call(
          "memory_write",
          { kind: "decision", title: "Durable admission", body: "Prompt admission stays separate from execution." },
          "call-memory-write",
        ),
      )
      expect(written.type).toBe("json")
      if (written.type !== "json" || typeof written.value !== "object" || written.value === null) return
      const id = "id" in written.value && typeof written.value.id === "string" ? written.value.id : ""
      expect(id.startsWith("drw_")).toBe(true)

      const searched = yield* executeTool(
        registry,
        call("memory_search", { query: "durable admission" }, "call-memory-search"),
      )
      expect(searched.type).toBe("json")
      if (searched.type === "json" && Array.isArray(searched.value)) expect(searched.value).toHaveLength(1)

      const read = yield* executeTool(registry, call("memory_read", { id }, "call-memory-read"))
      expect(read.type).toBe("json")
      expect(assertions.map((input) => input.action)).toEqual(["memory.write", "memory.read", "memory.read"])

      const invalid = yield* executeTool(
        registry,
        call("memory_search", { query: "durable", limit: -1 }, "call-memory-invalid-limit"),
      )
      expect(invalid.type).toBe("error")
    }),
  )

  it.effect("checks permission before creating a project wing", () =>
    Effect.gen(function* () {
      assertions.length = 0
      denyAction = "memory.read"
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call("memory_search", { query: "anything" }, "call-memory-denied"))
      expect(result.type).toBe("error")
      expect(yield* Memory.Service.use((memory) => memory.wings())).toEqual([])
    }),
  )

  it.effect("accepts only bodies that read back whole, and returns them intact", () =>
    Effect.gen(function* () {
      assertions.length = 0
      denyAction = undefined
      const registry = yield* ToolRegistry.Service

      const oversized = yield* executeTool(
        registry,
        call(
          "memory_write",
          { title: "Oversized runbook", body: "x".repeat(MemoryTool.READBACK_BUDGET_BYTES + 1) },
          "call-memory-write-oversized",
        ),
      )
      expect(oversized.type).toBe("error")
      expect(JSON.stringify(oversized.value)).toContain("read back intact")

      // Newlines double in size under JSON escaping; the gate must price that
      // in, because the read-side bound measures the encoded form too.
      const body = 'line with escapes "quoted"\n'.repeat(1_500)
      const written = yield* executeTool(
        registry,
        call("memory_write", { title: "Round trip", body }, "call-memory-write-roundtrip"),
      )
      expect(written.type).toBe("json")
      if (written.type !== "json" || typeof written.value !== "object" || written.value === null) return
      const id = "id" in written.value && typeof written.value.id === "string" ? written.value.id : ""

      const read = yield* executeTool(registry, call("memory_read", { id }, "call-memory-read-roundtrip"))
      expect(read.type).toBe("json")
      if (read.type !== "json" || typeof read.value !== "object" || read.value === null) return
      expect("body" in read.value && read.value.body).toBe(body)
    }),
  )

  itAcrossDirectories.live("keeps the wing of a non-Git project whose directory is renamed", () =>
    Effect.gen(function* () {
      assertions.length = 0
      denyAction = undefined
      const database = yield* Database.Service
      const memory = yield* Memory.Service

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const original = path.join(tmp.path, "ledger")
      const renamed = path.join(tmp.path, "ledger-archive")
      yield* Effect.promise(() => nfs.mkdir(original))

      const written = yield* Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* executeTool(
          registry,
          call(
            "memory_write",
            { kind: "decision", title: "Ledger cutover", body: "Settlement runs nightly at 02:00 UTC." },
            "call-memory-rename-write",
          ),
        )
      }).pipe(Effect.provide(openedAt(original, database)))
      expect(written.type).toBe("json")
      if (written.type !== "json" || typeof written.value !== "object" || written.value === null) return
      const id = "id" in written.value && typeof written.value.id === "string" ? written.value.id : ""
      expect(id.startsWith("drw_")).toBe(true)
      const drawerID = MemorySchema.DrawerID.make(id)
      // A directory nobody has bound yet still keys exactly where it did before
      // the binding existed, so installs upgrading into this keep their drawers.
      expect((yield* memory.wings()).map((wing) => wing.key)).toEqual([
        `local:${createHash("sha256").update(original).digest("hex")}`,
      ])

      yield* Effect.promise(() => nfs.rename(original, renamed))

      const searched = yield* Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* executeTool(
          registry,
          call("memory_search", { query: "settlement nightly" }, "call-memory-rename-search"),
        )
      }).pipe(Effect.provide(openedAt(renamed, database)))
      expect(searched.type).toBe("json")
      if (searched.type !== "json" || !Array.isArray(searched.value)) return
      expect(searched.value.map((result: Memory.Result) => result.drawer.id)).toEqual([drawerID])
      // The renamed directory has to land in the wing it already had rather than
      // minting a second one and stranding the drawer written above.
      expect((yield* memory.wings()).length).toBe(1)
    }),
  )
})
