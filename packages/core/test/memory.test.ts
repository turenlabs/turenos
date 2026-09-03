import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Memory } from "@turenlabs/core/memory"
import { MemoryIndex } from "@turenlabs/core/memory/fts"
import { MemoryKey } from "@turenlabs/core/memory/key"
import { MemoryTokenize } from "@turenlabs/core/memory/tokenize"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node])))

function scaffold(suffix: string) {
  return Effect.gen(function* () {
    const service = yield* Memory.Service
    const wing = yield* service.wing({ kind: "project", key: `wing-${suffix}`, name: `Wing ${suffix}` })
    const room = yield* service.room({ wingID: wing.id, slug: "retrieval", name: "Retrieval" })
    return { service, wing, room }
  })
}

const provenance = { assertedBy: "tom", source: "agent" as const, sessionID: "ses_test", commit: "abc123" }

describe("Memory tokenize", () => {
  it.effect("emits the whole identifier alongside its parts", () =>
    Effect.sync(() => {
      expect(MemoryTokenize.tokenize("sessionRunner")).toEqual(["sessionrunner", "session", "runner"])
      expect(MemoryTokenize.tokenize("session_runner")).toEqual(["session_runner", "session", "runner"])
      expect(MemoryTokenize.tokenize("HTTPServer")).toEqual(["httpserver", "http", "server"])
    }),
  )

  it.effect("drops single characters and keeps terms safe to interpolate", () =>
    Effect.sync(() => {
      expect(MemoryTokenize.tokenize("a bb")).toEqual(["bb"])
      // FTS5 metacharacters must not survive into the MATCH expression.
      expect(MemoryTokenize.toMatch(`" OR body : (x*`)).toBe(`"or" OR "body"`)
      expect(MemoryTokenize.toMatch("!!! ???")).toBeUndefined()
    }),
  )

  it.effect("caps the term count so a pasted brief cannot build an unbounded expression", () =>
    Effect.sync(() => {
      const huge = Array.from({ length: 4000 }, (_, index) => `term${index}`).join(" ")
      const match = MemoryTokenize.toMatch(huge)!
      expect(match.split(" OR ").length).toBeLessThanOrEqual(512)
    }),
  )

  it.effect("re-checks every term on the way into MATCH, not only on the way out of the tokenizer", () =>
    Effect.sync(() => {
      // Pruning sits between `searchTerms` and `expression`, so `expression` is
      // the last gate before interpolation and has to hold on its own.
      expect(MemoryTokenize.expression(["session", "runner"])).toBe(`"session" OR "runner"`)
      expect(MemoryTokenize.expression([])).toBeUndefined()
      expect(() => MemoryTokenize.expression([`x" OR body:(y*`])).toThrow()
    }),
  )
})

describe("Memory key", () => {
  it.effect("keys repo-relative and refuses paths outside the worktree", () =>
    Effect.sync(() => {
      expect(MemoryKey.relative("/Users/example/project", "/Users/example/project/packages/core/src/session.ts")).toBe(
        "packages/core/src/session.ts",
      )
      expect(MemoryKey.relative("/Users/example/project", "/etc/passwd")).toBeUndefined()
      // Rehydrates against whatever worktree this machine happens to have.
      expect(MemoryKey.absolute("/elsewhere/forge", { path: "packages/core/src/session.ts" })).toBe(
        "/elsewhere/forge/packages/core/src/session.ts",
      )
    }),
  )
})

describe("Memory", () => {
  it.effect("writes verbatim and retrieves lexically", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("write")
      const body = "The catalog API rate-limits at 50 rps; back off with jitter."
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        kind: "fact",
        title: "catalog rate limit",
        body,
        anchor: { repo: "forge", path: "packages/core/src/catalog.ts", commit: "abc123", symbol: "fetchCatalog" },
        provenance,
      })

      expect(drawer.body).toBe(body)
      expect(drawer.anchor.path).toBe("packages/core/src/catalog.ts")
      expect(drawer.provenance.assertedBy).toBe("tom")
      expect(drawer.provenance.sessionID).toBe("ses_test")

      const hits = yield* service.search({ query: "rate limit jitter", wings: [wing.id] })
      expect(hits.map((hit) => hit.drawer.id)).toEqual([drawer.id])
      expect(hits[0]!.drawer.body).toBe(body)
      expect(hits[0]!.score).toBeGreaterThan(0)
    }),
  )

  it.effect("reaches a drawer through its anchor's basename", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("anchor")
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "untitled",
        body: "no useful prose here",
        anchor: { repo: "forge", path: "packages/core/src/session/runner/llm.ts" },
        provenance,
      })
      const hits = yield* service.search({ query: "llm.ts", wings: [wing.id] })
      expect(hits.map((hit) => hit.drawer.id)).toContain(drawer.id)
    }),
  )

  it.effect("drops corpus-wide terms from the query but never the whole query", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("prune")
      const filler = MemoryIndex.MIN_DOCUMENTS + 40
      for (let index = 0; index < filler; index++) {
        yield* service.write({
          wingID: wing.id,
          roomID: room.id,
          title: "filler",
          body: `session ${index} routine housekeeping note`,
          provenance,
        })
      }
      const target = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "target",
        body: "session quarkslab advisory lock",
        provenance,
      })

      // "session" is in every document, so FTS5 clamps its IDF to 1e-6 and it
      // cannot rank anything. Pruned, the only evidence left is "quarkslab" and
      // the several hundred documents whose sole match was "session" stop
      // filling result slots.
      const hits = yield* service.search({ query: "session quarkslab", wings: [wing.id] })
      expect(hits.map((hit) => hit.drawer.id)).toEqual([target.id])

      // A query made entirely of corpus-wide terms must still search for
      // something. Pruning may never turn a query with content into no query.
      const common = yield* service.search({ query: "session housekeeping note", wings: [wing.id] })
      expect(common.length).toBeGreaterThan(0)
    }),
  )

  it.effect("never returns a drawer from a wing the caller did not name", () =>
    Effect.gen(function* () {
      const mine = yield* scaffold("acl-mine")
      const theirs = yield* scaffold("acl-theirs")
      const service = mine.service

      const secret = yield* service.write({
        wingID: theirs.wing.id,
        roomID: theirs.room.id,
        title: "engagement finding",
        body: "acme corp leaks credentials in their build logs",
        provenance,
      })

      expect(yield* service.search({ query: "acme credentials", wings: [mine.wing.id] })).toEqual([])
      expect(yield* service.read({ id: secret.id, wings: [mine.wing.id] })).toBeUndefined()
      // An empty scope is the caller forgetting to pass one. It must fail closed.
      expect(yield* service.search({ query: "acme credentials", wings: [] })).toEqual([])
      expect(yield* service.read({ id: secret.id, wings: [] })).toBeUndefined()

      const allowed = yield* service.search({ query: "acme credentials", wings: [theirs.wing.id] })
      expect(allowed.map((hit) => hit.drawer.id)).toEqual([secret.id])
    }),
  )

  it.effect("supersedes a fact without destroying what it replaced", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("temporal")
      const original = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        kind: "fact",
        title: "deploy target",
        body: "quarkslab deploys to fly.io",
        provenance,
        validFrom: 1_000,
      })
      const replacement = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        kind: "fact",
        title: "deploy target",
        body: "quarkslab deploys to cloudflare workers",
        provenance,
        validFrom: 2_000,
        supersedes: original.id,
      })

      const now = yield* service.search({ query: "quarkslab deploys", wings: [wing.id], asOf: 3_000 })
      expect(now.map((hit) => hit.drawer.id)).toEqual([replacement.id])

      // The superseded claim is still answerable as of when it was true.
      const before = yield* service.search({ query: "quarkslab deploys", wings: [wing.id], asOf: 1_500 })
      expect(before.map((hit) => hit.drawer.id)).toEqual([original.id])

      const stored = yield* service.read({ id: original.id, wings: [wing.id] })
      expect(stored!.body).toBe("quarkslab deploys to fly.io")
      expect(stored!.timeValidUntil).toBe(2_000)
      expect(stored!.supersededBy).toBe(replacement.id)
    }),
  )

  it.effect("scopes search to rooms when asked", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("rooms")
      const other = yield* service.room({ wingID: wing.id, slug: "infra", name: "Infra" })
      const inRetrieval = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "a",
        body: "postgres advisory lock held across email send",
        provenance,
      })
      yield* service.write({
        wingID: wing.id,
        roomID: other.id,
        title: "b",
        body: "postgres advisory lock is fine here",
        provenance,
      })

      const scoped = yield* service.search({ query: "postgres advisory lock", wings: [wing.id], rooms: [room.id] })
      expect(scoped.map((hit) => hit.drawer.id)).toEqual([inRetrieval.id])
      const unscoped = yield* service.search({ query: "postgres advisory lock", wings: [wing.id] })
      expect(unscoped.length).toBe(2)
    }),
  )

  it.effect("prunes common terms within the requested room rather than the whole wing", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("room-prune")
      const other = yield* service.room({ wingID: wing.id, slug: "other", name: "Other" })
      const target = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "target",
        body: "needle",
        provenance,
      })
      for (let index = 0; index < MemoryIndex.MIN_DOCUMENTS + 10; index += 1) {
        yield* service.write({
          wingID: wing.id,
          roomID: other.id,
          title: "filler",
          body: index < MemoryIndex.MIN_DOCUMENTS - 45 ? "needle common" : `noise${index}`,
          provenance,
        })
      }
      yield* service.write({
        wingID: wing.id,
        roomID: other.id,
        title: "rare one",
        body: "rareone",
        provenance,
      })
      yield* service.write({
        wingID: wing.id,
        roomID: other.id,
        title: "rare two",
        body: "raretwo",
        provenance,
      })
      yield* service.write({
        wingID: wing.id,
        roomID: other.id,
        title: "rare three",
        body: "rarethree",
        provenance,
      })

      const hits = yield* service.search({
        query: "needle rareone raretwo rarethree",
        wings: [wing.id],
        rooms: [room.id],
      })
      expect(hits.map((hit) => hit.drawer.id)).toEqual([target.id])
    }),
  )

  it.effect("lists and updates drawers while keeping the index consistent", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("manage")
      const other = yield* service.room({ wingID: wing.id, slug: "decisions", name: "Decisions" })
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "old title",
        body: "obsolete searchable wording",
        provenance,
      })

      expect((yield* service.list({ wings: [wing.id] })).map((item) => item.id)).toContain(drawer.id)
      expect(yield* service.list({ wings: [wing.id], rooms: [other.id] })).toEqual([])

      const updated = yield* service.update({
        id: drawer.id,
        expectedTimeUpdated: drawer.timeUpdated,
        wingID: wing.id,
        roomID: other.id,
        kind: "decision",
        title: "new title",
        body: "replacement searchable wording",
        anchor: { path: "packages/core/src/memory/index.ts", symbol: "update" },
      })
      expect(updated?.roomID).toBe(other.id)
      expect(updated?.kind).toBe("decision")
      expect(updated?.provenance.commit).toBe("abc123")
      expect((yield* service.list({ wings: [wing.id], rooms: [other.id] })).map((item) => item.id)).toEqual([drawer.id])
      expect(yield* service.search({ query: "obsolete", wings: [wing.id] })).toEqual([])
      expect((yield* service.search({ query: "replacement", wings: [wing.id] }))[0]?.drawer.id).toBe(drawer.id)
      expect(
        yield* service.update({
          id: drawer.id,
          expectedTimeUpdated: drawer.timeUpdated,
          wingID: wing.id,
          roomID: room.id,
          kind: "note",
          title: "stale edit",
          body: "must not overwrite",
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("keeps updated repository anchors consistent with durable and FTS state", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("anchor-update")
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "anchor before",
        body: "old repository marker",
        anchor: { repo: "oldrepo", path: "old/file.ts", commit: "oldcommit", symbol: "oldsymbol" },
        provenance,
      })

      const updated = yield* service.update({
        id: drawer.id,
        expectedTimeUpdated: drawer.timeUpdated,
        wingID: wing.id,
        roomID: room.id,
        kind: "decision",
        title: "anchor after",
        body: "new repository marker",
        anchor: { repo: "newrepo", path: "new/file.ts", commit: "newcommit", symbol: "newsymbol" },
      })

      expect(updated?.anchor).toEqual({
        repo: "newrepo",
        path: "new/file.ts",
        commit: "newcommit",
        symbol: "newsymbol",
      })
      expect(updated?.provenance.commit).toBe("newcommit")
      const preserved = yield* service.update({
        id: drawer.id,
        expectedTimeUpdated: updated!.timeUpdated,
        wingID: wing.id,
        roomID: room.id,
        kind: "decision",
        title: "anchor after body edit",
        body: "new body without anchor input",
      })
      expect(preserved?.anchor).toEqual(updated?.anchor)
      expect((yield* service.search({ query: "newrepo newcommit newsymbol", wings: [wing.id] }))[0]?.drawer.id).toBe(
        drawer.id,
      )
      expect(yield* service.search({ query: "oldrepo oldcommit oldsymbol", wings: [wing.id] })).toEqual([])
    }),
  )

  it.effect("removes FTS rows when a room cascade deletes its drawers", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("cascade-fts")
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "cascade target",
        body: "foreign key cleanup marker",
        provenance,
      })
      const db = Database.primary((yield* Database.Service).db)
      yield* db.run(`DELETE FROM memory_room WHERE id = '${room.id}'`).pipe(Effect.orDie)

      expect(yield* service.read({ id: drawer.id, wings: [wing.id] })).toBeUndefined()
      const rows = yield* db.all<{ count: number }>(
        `SELECT count(*) AS count FROM memory_drawer_fts WHERE drawer_id = '${drawer.id}'`,
      )
      expect(rows[0]?.count).toBe(0)
    }),
  )

  it.effect("refuses a stale edit even when the edit it lost to landed in the same millisecond", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("cas")
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "first",
        body: "first wording",
        provenance,
      })

      // `timeUpdated` is the only version token the API exposes, and a
      // millisecond is coarse enough that two edits routinely share one. Pin the
      // clock so that case is the one under test rather than a coin flip: the
      // token has to advance on every accepted write, or the loser of a race
      // still matches and overwrites the winner it never saw.
      const realNow = Date.now
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Date.now = realNow
        }),
      )
      Date.now = () => drawer.timeUpdated

      const edit = {
        id: drawer.id,
        wingID: wing.id,
        roomID: room.id,
        kind: "note" as const,
        title: "second",
        body: "second wording",
      }
      const accepted = yield* service.update({ ...edit, expectedTimeUpdated: drawer.timeUpdated })
      expect(accepted?.body).toBe("second wording")
      expect(accepted!.timeUpdated).toBeGreaterThan(drawer.timeUpdated)

      const stale = yield* service.update({
        ...edit,
        expectedTimeUpdated: drawer.timeUpdated,
        title: "third",
        body: "must not overwrite",
      })
      expect(stale).toBeUndefined()
      expect((yield* service.read({ id: drawer.id, wings: [wing.id] }))!.body).toBe("second wording")
    }),
  )

  it.effect("forgets a drawer and its index entry together", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("forget")
      const drawer = yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "ephemeral",
        body: "temporary scaffolding note",
        provenance,
      })
      expect(yield* service.forget({ id: drawer.id, wings: [] })).toBe(false)
      expect(yield* service.forget({ id: drawer.id, wings: [wing.id] })).toBe(true)
      expect(yield* service.search({ query: "temporary scaffolding", wings: [wing.id] })).toEqual([])
      expect(yield* service.read({ id: drawer.id, wings: [wing.id] })).toBeUndefined()
    }),
  )

  it.effect("rebuilds the whole index from the drawers alone", () =>
    Effect.gen(function* () {
      const { service, wing, room } = yield* scaffold("reindex")
      yield* service.write({
        wingID: wing.id,
        roomID: room.id,
        title: "rebuildable",
        body: "sqlite wal checkpoint truncate on shutdown",
        provenance,
      })
      const count = yield* service.reindex()
      expect(count).toBeGreaterThanOrEqual(1)
      const hits = yield* service.search({ query: "wal checkpoint", wings: [wing.id] })
      expect(hits.length).toBe(1)
    }),
  )

  it.effect("keeps wing and room upserts idempotent", () =>
    Effect.gen(function* () {
      const service = yield* Memory.Service
      const first = yield* service.wing({ kind: "project", key: "idem", name: "First" })
      const second = yield* service.wing({ kind: "project", key: "idem", name: "Second" })
      expect(second.id).toBe(first.id)
      expect(second.name).toBe("Second")

      const room = yield* service.room({ wingID: first.id, slug: "topic", name: "Topic" })
      const again = yield* service.room({ wingID: first.id, slug: "topic", name: "Topic renamed" })
      expect(again.id).toBe(room.id)
      expect((yield* service.rooms(first.id)).length).toBe(1)
    }),
  )
})
