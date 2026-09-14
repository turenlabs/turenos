import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
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
import { SqliteInspectRuntime } from "@turenlabs/core/tool/sqlite-inspect-runtime"
import { SqliteInspectTools } from "@turenlabs/core/tool/sqlite-inspect-tools"
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

// simple.db and deleted.db are committed under test/fixtures/ — the same
// databases wasm-tools tools/sqlite-inspect/test/verify.mjs asserts against
// (generated once by test/gen-fixtures.sh with the macOS sqlite3 CLI).
const fixture = (name: string) =>
  fs.readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

const report = (value: unknown) => JSON.parse(String(value)) as Record<string, any>

describe("SqliteInspectRuntime and SqliteInspectTools", () => {
  it.live("inspects SQLite fixtures through a fresh sqlite-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const [simple, deleted] = yield* Effect.promise(() =>
            Promise.all([fixture("simple.db"), fixture("deleted.db")]),
          )
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/simple.db`, simple),
              Bun.write(`${tmp.path}/deleted.db`, deleted),
              Bun.write(`${tmp.path}/garbage.db`, new TextEncoder().encode("not a sqlite database")),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of [
            "sqlite_inspect",
            "sqlite_schema",
            "sqlite_table_stats",
            "sqlite_rows",
            "sqlite_freelist",
            "sqlite_carve",
          ])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_sqlite_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspected = yield* call("call-sqlite-inspect", "sqlite_inspect", { path: "simple.db" })
          expect(inspected.type).toBe("text")
          if (inspected.type !== "text") return
          const header = report(inspected.value)
          expect(header.kind).toBe("sqlite3")
          expect(header.header.magicOk).toBe(true)
          expect(header.header.pageSize).toBe(4096)
          expect(header.header.userVersion).toBe(7)
          expect(header.header.applicationId).toBe(1337)
          expect(header.journalMode).toBe("rollback")
          expect(header.freelist.countMatchesDeclared).toBe(true)

          const schema = yield* call("call-sqlite-schema", "sqlite_schema", { path: "simple.db" })
          expect(schema.type).toBe("text")
          if (schema.type !== "text") return
          const records = report(schema.value).records as Array<Record<string, any>>
          const byName = Object.fromEntries(records.map((r) => [r.name, r]))
          expect(byName.users.type).toBe("table")
          expect(byName.meta.type).toBe("table")
          expect(byName.idx_users_age.type).toBe("index")
          expect(byName.idx_users_age.tblName).toBe("users")
          expect(byName.v_users.type).toBe("view")
          expect(byName.v_users.rootpage).toBe(0)
          expect(byName.trg_users.type).toBe("trigger")
          expect(byName.users.sql).toContain("CREATE TABLE users")

          const stats = yield* call("call-sqlite-table-stats", "sqlite_table_stats", {
            path: "simple.db",
            table: "users",
          })
          expect(stats.type).toBe("text")
          if (stats.type !== "text") return
          const table = report(stats.value).tables[0]
          expect(table.rows).toBe(4)
          expect(table.depth).toBe(1)
          expect(table.rowid.min).toBe(1)
          expect(table.rowid.max).toBe(4)
          expect(table.pages.leaf).toBe(1)
          expect(table.corrupt).toBe(false)

          const rows = yield* call("call-sqlite-rows", "sqlite_rows", {
            path: "simple.db",
            table: "users",
            maxRows: 256,
          })
          expect(rows.type).toBe("text")
          if (rows.type !== "text") return
          const decoded = report(rows.value)
          expect(decoded.withoutRowid).toBe(false)
          expect(decoded.rows.map((r: { rowid: number }) => r.rowid)).toEqual([1, 2, 3, 4])
          expect(decoded.rows[0].values[1].value).toBe("alice")
          expect(decoded.rows[0].values[4].type).toBe("blob")
          expect(decoded.rows[0].values[4].previewHex).toBe("0102deadbeef")
          expect(decoded.columnNames[1]).toBe("name")

          const freelist = yield* call("call-sqlite-freelist", "sqlite_freelist", { path: "deleted.db" })
          expect(freelist.type).toBe("text")
          if (freelist.type !== "text") return
          const free = report(freelist.value)
          expect(free.declaredFreePages).toBe(6)
          expect(free.countedFreePages).toBe(6)
          expect(free.countMatchesDeclared).toBe(true)
          expect(free.broken).toBe(false)
          expect(free.trunks[0].page).toBe(4)
          expect(free.carving.totalCarvableBytes).toBeGreaterThan(1024)

          // maxCandidates 8 keeps the report under the generic output bound
          // while still covering the two dropped scratch rows (candidate
          // order is by file region; the freelist-trunk hits rank 4-5).
          const carved = yield* call("call-sqlite-carve", "sqlite_carve", {
            path: "deleted.db",
            maxCandidates: 8,
          })
          expect(carved.type).toBe("text")
          if (carved.type !== "text") return
          const carve = report(carved.value)
          expect(carve.heuristic).toBe(true)
          expect(carved.value).toContain("scratch-row-111")
          expect(carved.value).toContain("scratch-row-222")
          for (const candidate of carve.candidates as Array<Record<string, any>>) {
            expect(candidate.heuristic).toBe(true)
            expect(candidate.confidence).toBeGreaterThan(0)
            expect(candidate.confidence).toBeLessThanOrEqual(1)
            expect(["unallocated", "freeblock", "freelist-leaf", "freelist-trunk"]).toContain(candidate.region)
          }

          const failed = yield* call("call-sqlite-inspect-bad", "sqlite_inspect", { path: "garbage.db" })
          expect(failed.type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                SqliteInspectRuntime.node,
                SqliteInspectTools.node,
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
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
