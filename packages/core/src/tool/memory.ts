export * as MemoryTool from "./memory"

import path from "path"
import { createHash } from "crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Memory as MemorySchema } from "@turenlabs/schema/memory"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Memory } from "../memory"
import { MemorySemantic } from "../memory/semantic"
import { PermissionV2 } from "../permission"
import { Project } from "../project"
import { PositiveInt } from "../schema"
import { Storage } from "../storage"
import { MAX_BYTES as TOOL_OUTPUT_MAX_BYTES } from "../tool-output-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const searchName = "memory_search"
export const readName = "memory_read"
export const writeName = "memory_write"
export const forgetName = "memory_forget"

export function wingName(directory: string, basename = path.basename) {
  return basename(directory) || directory
}

const IDENTITY_SCOPE = Storage.Scope.make("internal/memory-identity")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = yield* Memory.Service
    const semantic = yield* MemorySemantic.Service
    yield* Effect.forkScoped(semantic.prepare())
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const fs = yield* FSUtil.Service
    const storage = yield* Storage.Service

    // The filesystem identity of the opened directory, which a rename of the
    // directory or of any parent preserves and a freshly created directory does
    // not. `birthtime` rides along in the address so that an inode number the
    // filesystem later recycles onto an unrelated directory cannot inherit this
    // one's memories. Undefined where the platform reports no inode, which
    // leaves nothing durable to bind to.
    const anchor = Effect.fnUntraced(function* () {
      const info = yield* fs.stat(location.directory).pipe(Effect.catch(() => Effect.void))
      if (!info) return undefined
      const ino = Option.getOrUndefined(info.ino)
      if (ino === undefined) return undefined
      const born = Option.getOrUndefined(info.birthtime)
      return Storage.Key.make(`fs:${info.dev}:${ino}:${born ? born.getTime() : ""}`)
    })

    // Non-Git directories all resolve to Project.ID.global, which is not a safe
    // memory boundary, so each one needs a key of its own. The directory path is
    // not ours: people rename and move folders, and because `memory.wing` upserts
    // on (kind, key) a re-derived key silently forks the wing and strands every
    // drawer already written under the old one — `Memory.search` is wing-scoped
    // and there is no unscoped read path. The path may therefore only *seed* a
    // key for a directory nothing has bound yet, and the binding is claimed the
    // moment it is minted; from then on the stored value wins. Seeding reproduces
    // the original derivation exactly, so a directory that already holds drawers
    // keeps the wing it has.
    const identity = Effect.fnUntraced(function* () {
      if (location.project.id !== Project.ID.global) return location.project.id
      const derived = `local:${createHash("sha256").update(location.directory).digest("hex")}`
      const address = yield* anchor()
      if (!address) return derived
      const bound = (yield* storage.get({ scope: IDENTITY_SCOPE, key: address }))?.value.trim()
      if (bound) return bound
      yield* storage.set({ scope: IDENTITY_SCOPE, key: address, value: derived })
      return derived
    })

    const projectKey: string = yield* identity()
    const wing = () =>
      memory.wing({
        kind: "project",
        key: projectKey,
        name: wingName(location.directory),
      })
    const authorize = (
      action: string,
      resources: ReadonlyArray<string>,
      context: Tool.Context,
      save: ReadonlyArray<string> = resources,
    ) =>
      permission.assert({
        action,
        resources,
        save,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })

    yield* tools
      .register({
        [searchName]: Tool.withPermission(
          Tool.make({
            description:
              "Search durable memory from prior sessions in the current project. Use this for established decisions, facts, constraints, user preferences, and previously diagnosed failures that may affect the current task.",
            input: Schema.Struct({
              query: Schema.String.annotate({ description: "What to retrieve from project memory" }),
              limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MemorySchema.MAX_SEARCH_LIMIT)).pipe(Schema.optional),
            }),
            output: Schema.Array(MemorySchema.Result),
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* authorize("memory.read", [projectKey], context)
                const scope = yield* wing()
                return yield* semantic.search({ query: input.query, wings: [scope.id], limit: input.limit })
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : failure("Unable to search memory", error),
                ),
                // Transient DB contention (e.g. SQLITE_BUSY) surfaces as a defect via
                // orDie inside Memory; at the tool boundary it must be a retryable
                // tool failure the model can see, not a turn-level defect.
                Effect.catchDefect((defect) => Effect.fail(failure("Unable to search memory", defect))),
              ),
          }),
          "memory.read",
        ),
        [readName]: Tool.withPermission(
          Tool.make({
            description: "Read one durable memory by ID from the current project.",
            input: Schema.Struct({ id: MemorySchema.DrawerID }),
            output: Schema.NullOr(MemorySchema.Drawer),
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* authorize("memory.read", [projectKey], context)
                const scope = yield* wing()
                return (yield* memory.read({ id: input.id, wings: [scope.id] })) ?? null
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : failure("Unable to read memory", error),
                ),
                // Transient DB contention (e.g. SQLITE_BUSY) surfaces as a defect via
                // orDie inside Memory; at the tool boundary it must be a retryable
                // tool failure the model can see, not a turn-level defect.
                Effect.catchDefect((defect) => Effect.fail(failure("Unable to read memory", defect))),
              ),
          }),
          "memory.read",
        ),
        [writeName]: Tool.withPermission(
          Tool.make({
            description: `Write durable project memory for information likely to matter in later sessions: stable decisions, constraints, preferences, failure causes, and reusable operational knowledge. Do not store routine progress, transient state, secrets, or facts already maintained in source-controlled documentation. The encoded title+body must stay under ${READBACK_BUDGET_BYTES} bytes so the memory reads back whole; split larger content across drawers.`,
            input: Schema.Struct({
              room: Schema.String.pipe(Schema.optional).annotate({
                description: "Topic slug. Defaults to general.",
              }),
              kind: MemorySchema.DrawerKind.pipe(Schema.optional),
              title: Schema.String.check(Schema.isMaxLength(MemorySchema.MAX_TITLE_LENGTH)),
              body: Schema.String.check(Schema.isMaxLength(MemorySchema.MAX_BODY_BYTES)),
              path: Schema.String.check(Schema.isMaxLength(MemorySchema.MAX_PATH_LENGTH)).pipe(Schema.optional),
              symbol: Schema.String.check(Schema.isMaxLength(MemorySchema.MAX_SYMBOL_LENGTH)).pipe(Schema.optional),
              supersedes: MemorySchema.DrawerID.pipe(Schema.optional),
            }),
            output: MemorySchema.Drawer,
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* authorize("memory.write", [projectKey], context)
                if (input.path && invalidPath(input.path)) return yield* failure("Memory paths must be repo-relative")
                // Write and read share one contract: anything accepted here must
                // survive `ToolOutputStore.bound` on the way back. That bound
                // measures the pretty-printed JSON of the whole drawer, so gate
                // on the same encoding (which also prices in JSON escaping) with
                // headroom for ids, anchor, provenance, and timestamps.
                const encoded = readbackSize(input)
                if (encoded > READBACK_BUDGET_BYTES)
                  return yield* failure(
                    `Memory too large to read back intact: the encoded title+body is ${encoded} bytes and the budget is ${READBACK_BUDGET_BYTES} bytes. Split the content across multiple drawers.`,
                  )
                const scope = yield* wing()
                const slug = input.room?.trim() || "general"
                const room = yield* memory.room({ wingID: scope.id, slug, name: slug })
                return yield* memory.write({
                  wingID: scope.id,
                  roomID: room.id,
                  kind: input.kind,
                  title: input.title,
                  body: input.body,
                  anchor: {
                    repo: projectKey,
                    ...(input.path ? { path: input.path } : {}),
                    ...(input.symbol ? { symbol: input.symbol } : {}),
                  },
                  provenance: {
                    assertedBy: context.agent,
                    source: "agent",
                    sessionID: context.sessionID,
                  },
                  supersedes: input.supersedes,
                })
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : failure("Unable to write memory", error),
                ),
                // Transient DB contention (e.g. SQLITE_BUSY) surfaces as a defect via
                // orDie inside Memory; at the tool boundary it must be a retryable
                // tool failure the model can see, not a turn-level defect.
                Effect.catchDefect((defect) => Effect.fail(failure("Unable to write memory", defect))),
              ),
          }),
          "memory.write",
        ),
        [forgetName]: Tool.withPermission(
          Tool.make({
            deferred: true,
            description:
              "Permanently delete one durable memory from the current project. Use only when explicitly requested.",
            input: Schema.Struct({ id: MemorySchema.DrawerID }),
            output: Schema.Boolean,
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* authorize("memory.forget", [input.id], context, [])
                const scope = yield* wing()
                return yield* memory.forget({ id: input.id, wings: [scope.id] })
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : failure("Unable to forget memory", error),
                ),
                // Transient DB contention (e.g. SQLITE_BUSY) surfaces as a defect via
                // orDie inside Memory; at the tool boundary it must be a retryable
                // tool failure the model can see, not a turn-level defect.
                Effect.catchDefect((defect) => Effect.fail(failure("Unable to forget memory", defect))),
              ),
          }),
          "memory.forget",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

/**
 * Headroom between the write gate and `ToolOutputStore.MAX_BYTES` for the parts
 * of a read-back drawer the writer does not control: ids, room, anchor repo,
 * provenance, timestamps, and the JSON envelope around them.
 */
const READBACK_ENVELOPE_BYTES = 2_048
export const READBACK_BUDGET_BYTES = TOOL_OUTPUT_MAX_BYTES - READBACK_ENVELOPE_BYTES

/** Measures the writer-controlled fields exactly as `bound` will: pretty-printed JSON. */
function readbackSize(input: { title: string; body: string; path?: string; symbol?: string }) {
  return Buffer.byteLength(
    JSON.stringify(
      {
        title: input.title,
        body: input.body,
        ...(input.path ? { path: input.path } : {}),
        ...(input.symbol ? { symbol: input.symbol } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  )
}

function failure(message: string, error?: unknown) {
  return new ToolFailure({ message, error })
}

function invalidPath(input: string) {
  const normalized = input.replaceAll("\\", "/")
  return path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")
}

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [
    ToolRegistry.node,
    Memory.node,
    MemorySemantic.node,
    Location.node,
    PermissionV2.node,
    FSUtil.node,
    Storage.node,
  ],
})
