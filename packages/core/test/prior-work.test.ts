import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "@turenlabs/schema/agent"
import { Session } from "@turenlabs/schema/session"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Location } from "@turenlabs/core/location"
import { PriorWork } from "@turenlabs/core/prior-work"
import { PriorWorkEventTable, PriorWorkRevisionTable } from "@turenlabs/core/prior-work/sql"
import { Project } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SecretPlaceholder } from "@turenlabs/core/secret-placeholder"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const REMOTE = "https://example.com/acme/app.git"
// Every case spawns real git processes; leave headroom when suites run concurrently.
const TIMEOUT = 30_000
const it = testEffect(AppNodeBuilder.build(Database.node))

const agent = (session = "ses_recorder") =>
  ({ actor: "agent", session_id: Session.ID.make(session), agent: Agent.ID.make("build") }) as const
const human = { actor: "human", name: "owner" } as const

const prepared = (overrides: Record<string, unknown> = {}) => ({
  kind: "finding",
  summary: "Session token is compared with ==",
  detail: "Timing-unsafe comparison in the login handler.",
  method: "manual review of src/auth.ts",
  assumptions: [{ text: "Handler is reachable unauthenticated", status: "unknown" }],
  locations: [{ path: "src/auth/login.ts", start_line: 10, end_line: 12 }],
  evidence: [{ kind: "file", ref: "src/auth/login.ts", note: "line 11" }],
  derived_from: [],
  ...overrides,
})

/** PriorWork for a directory, sharing the ambient database so every graph sees the same rows. */
const at = <A, E>(directory: string, body: (service: PriorWork.Interface) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* Effect.gen(function* () {
      const service = yield* PriorWork.Service
      return yield* body(service)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(PriorWork.node, [
          [Database.node, Layer.succeed(Database.Service, database)],
          [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
        ]),
      ),
    )
  })

const scratch = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
)

async function repository(directory: string) {
  await fs.mkdir(path.join(directory, "src"), { recursive: true })
  await fs.writeFile(path.join(directory, "src", "app.ts"), "export {}\n")
  await $`git init -q`.cwd(directory).quiet()
  await configure(directory)
  await $`git add .`.cwd(directory).quiet()
  await $`git commit -q -m initial`.cwd(directory).quiet()
  await $`git remote add origin ${REMOTE}`.cwd(directory).quiet()
}

async function clone(source: string, target: string) {
  await $`git clone -q ${source} ${target}`.quiet()
  await configure(target)
  await $`git remote set-url origin ${REMOTE}`.cwd(target).quiet()
}

async function configure(directory: string) {
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@forge.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
}

describe("PriorWork repository binding", () => {
  it.live(
    "shares records across linked worktrees and keeps them through rename and symlink alias",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const main = path.join(tmp.path, "main")
        const linked = path.join(tmp.path, "linked")
        const renamed = path.join(tmp.path, "renamed")
        const alias = path.join(tmp.path, "alias")
        yield* Effect.promise(async () => {
          await fs.mkdir(main)
          await repository(main)
          await $`git worktree add -q --detach ${linked} HEAD`.cwd(main).quiet()
        })

        expect(yield* at(main, (service) => service.repository())).toBeUndefined()
        const created = yield* at(main, (service) => service.record({ prepared: prepared() }, agent()))
        const binding = yield* at(main, (service) => service.repository())
        expect(binding).toStartWith("pwb_")

        const fromLinked = yield* at(linked, (service) => service.get({ id: created.id }))
        expect(fromLinked.record.repositoryID).toBe(binding!)
        expect(fromLinked.revision?.summary).toBe("Session token is compared with ==")

        yield* Effect.promise(async () => {
          await $`git worktree remove --force ${linked}`.cwd(main).quiet()
          await fs.rename(main, renamed)
          await fs.symlink(renamed, alias)
        })
        expect((yield* at(renamed, (service) => service.search({}))).items.map((item) => item.id)).toEqual([created.id])
        expect(yield* at(alias, (service) => service.repository())).toBe(binding)
        expect((yield* at(alias, (service) => service.get({ id: created.id }))).record.id).toBe(created.id)
      }),
    TIMEOUT,
  )

  it.live(
    "isolates a separate clone and a replacement at the same path until an owner links them",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const main = path.join(tmp.path, "main")
        const other = path.join(tmp.path, "other")
        yield* Effect.promise(async () => {
          await fs.mkdir(main)
          await repository(main)
          await clone(main, other)
        })

        const original = yield* at(main, (service) => service.record({ prepared: prepared() }, agent()))
        const originalBinding = (yield* at(main, (service) => service.repository()))!

        // Same remote, same project, different repository incarnation.
        const database = yield* Database.Service
        const projects = yield* Effect.all(
          [main, other].map((directory) =>
            Effect.gen(function* () {
              return (yield* Location.Service).project.id
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(
                  Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
                  [[Database.node, Layer.succeed(Database.Service, database)]],
                ),
              ),
            ),
          ),
        )
        expect(projects[0]).toBe(projects[1])
        expect(yield* at(other, (service) => service.search({}))).toEqual({ items: [] })
        const crossRepository = yield* at(other, (service) => service.get({ id: original.id })).pipe(Effect.flip)
        expect(crossRepository).toBeInstanceOf(PriorWork.NotFound)
        expect(crossRepository.message).not.toContain(original.id)
        const crossLineage = yield* at(other, (service) =>
          service.record(
            { prepared: prepared({ derived_from: [{ record_id: original.id, revision: 1 }] }) },
            agent("ses_clone"),
          ),
        ).pipe(Effect.flip)
        expect(crossLineage._tag === "PriorWork.NotFound" && crossLineage.path).toBe("prepared.derived_from.0")

        // A clone's own record creates its binding and stays invisible to the original.
        const cloneRecord = yield* at(other, (service) =>
          service.record({ prepared: prepared({ summary: "Clone-only lead", kind: "lead" }) }, agent("ses_clone")),
        )
        expect(
          yield* at(main, (service) => service.get({ id: cloneRecord.id })).pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          ),
        ).toBe("PriorWork.NotFound")

        const cloneBinding = yield* at(other, (service) => service.link(originalBinding, human))
        expect(cloneBinding).not.toBe(originalBinding)
        const linked = yield* at(other, (service) => service.get({ id: original.id }))
        // Provenance is never rewritten by a grant.
        expect(linked.record.repositoryID).toBe(originalBinding)
        expect(linked.revision?.recordedBy).toEqual(agent())
        expect((yield* at(other, (service) => service.search({}))).items).toHaveLength(2)
        // One-directional: the original still does not see the clone.
        expect((yield* at(main, (service) => service.search({}))).items.map((item) => item.id)).toEqual([original.id])

        // Replacement at the same path: a fresh incarnation inherits nothing.
        yield* Effect.promise(async () => {
          await fs.rm(main, { recursive: true, force: true })
          await clone(other, main)
        })
        expect(yield* at(main, (service) => service.repository())).toBeUndefined()
        expect(yield* at(main, (service) => service.search({}))).toEqual({ items: [] })
        expect(
          yield* at(main, (service) => service.get({ id: original.id })).pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          ),
        ).toBe("PriorWork.NotFound")
      }),
    TIMEOUT,
  )

  it.live(
    "rejects the global project",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const failure = yield* at(tmp.path, (service) => service.record({ prepared: prepared() }, agent())).pipe(
          Effect.flip,
        )
        expect(failure).toBeInstanceOf(PriorWork.Unsupported)
        expect(failure._tag === "PriorWork.Unsupported" && failure.reason).toBe("global_project")
        expect(
          yield* at(tmp.path, (service) => service.search({})).pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          ),
        ).toBe("PriorWork.Unsupported")
      }),
    TIMEOUT,
  )

  it.live(
    "fails closed when the common directory has no filesystem incarnation",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const main = path.join(tmp.path, "main")
        yield* Effect.promise(async () => {
          await fs.mkdir(main)
          await repository(main)
        })
        const info = yield* Effect.promise(() => fs.stat(path.join(main, ".git")))
        const supported = info.dev > 0 && info.ino > 0 && info.birthtimeMs > 0
        const outcome = yield* at(main, (service) => service.record({ prepared: prepared() }, agent())).pipe(
          Effect.flip,
          Effect.map((error) => error._tag === "PriorWork.Unsupported" && error.reason),
          Effect.catch(() => Effect.succeed("written" as const)),
        )
        // Platforms without inode or birth time are unbound rather than keyed by path.
        expect(outcome).toBe(supported ? "written" : "unbound")

        // A Location whose common directory cannot be resolved is always unbound.
        const database = yield* Database.Service
        const missing = AbsolutePath.make(path.join(tmp.path, "missing", ".git"))
        const unbound = yield* Effect.gen(function* () {
          const service = yield* PriorWork.Service
          return {
            binding: yield* service.repository(),
            page: yield* service.search({}),
            write: yield* service.record({ prepared: prepared() }, agent()).pipe(Effect.flip),
          }
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(PriorWork.node, [
              [Database.node, Layer.succeed(Database.Service, database)],
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  Location.Service.of({
                    directory: AbsolutePath.make(tmp.path),
                    project: { id: Project.ID.make("prior-work-unbound"), directory: AbsolutePath.make(tmp.path) },
                    vcs: { type: "git", store: missing },
                  }),
                ),
              ],
            ]),
          ),
        )
        expect(unbound.binding).toBeUndefined()
        expect(unbound.page).toEqual({ items: [] })
        expect(unbound.write._tag === "PriorWork.Unsupported" && unbound.write.reason).toBe("unbound")
      }),
    TIMEOUT,
  )
})

describe("PriorWork records", () => {
  it.live(
    "replays exact retries and rejects conflicting key reuse",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        const first = yield* at(tmp.path, (service) => service.record({ key: "k1", prepared: prepared() }, agent()))
        expect(first.replayed).toBe(false)
        const retry = yield* at(tmp.path, (service) => service.record({ key: "k1", prepared: prepared() }, agent()))
        expect(retry).toEqual({ id: first.id, revision: 1, replayed: true })
        expect((yield* at(tmp.path, (service) => service.search({}))).items).toHaveLength(1)

        const conflict = yield* at(tmp.path, (service) =>
          service.record({ key: "k1", prepared: prepared({ summary: "Different claim" }) }, agent()),
        ).pipe(Effect.flip)
        expect(conflict._tag === "PriorWork.Conflict" && conflict.reason).toBe("idempotency_mismatch")

        // Keys are scoped to the calling Session.
        const elsewhere = yield* at(tmp.path, (service) =>
          service.record({ key: "k1", prepared: prepared({ summary: "Different claim" }) }, agent("ses_other")),
        )
        expect(elsewhere.id).not.toBe(first.id)
      }),
    TIMEOUT,
  )

  it.live(
    "keeps revisions immutable, enforces compare-and-swap, and retains the source Session ID",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        const created = yield* at(tmp.path, (service) => service.record({ prepared: prepared() }, agent("ses_gone")))
        const target = { id: created.id, head: 1 }

        const revised = yield* at(tmp.path, (service) =>
          service.record(
            { target, prepared: prepared({ summary: "Comparison is constant-time after all" }) },
            agent("ses_gone"),
          ),
        )
        expect(revised).toEqual({ id: created.id, revision: 2, replayed: false })

        const stale = yield* at(tmp.path, (service) =>
          service.record({ target, prepared: prepared({ summary: "Stale edit" }) }, human),
        ).pipe(Effect.flip)
        expect(stale._tag === "PriorWork.Conflict" && stale.reason).toBe("stale_head")

        const foreign = yield* at(tmp.path, (service) =>
          service.record({ target: { id: created.id, head: 2 }, prepared: prepared() }, agent("ses_intruder")),
        ).pipe(Effect.flip)
        expect(foreign._tag === "PriorWork.Forbidden" && foreign.reason).toBe("not_recorder")

        const kind = yield* at(tmp.path, (service) =>
          service.record({ target: { id: created.id, head: 2 }, prepared: prepared({ kind: "lead" }) }, human),
        ).pipe(Effect.flip)
        expect(kind._tag === "PriorWork.Forbidden" && kind.reason).toBe("kind_immutable")

        const first = yield* at(tmp.path, (service) => service.get({ id: created.id, revision: 1 }))
        expect(first.revision?.summary).toBe("Session token is compared with ==")
        expect(first.revision?.observation).toEqual({ basis: "unknown" })
        expect(first.revision?.recordingCapture).toBeUndefined()
        const head = yield* at(tmp.path, (service) => service.get({ id: created.id }))
        expect(head.record.headRevision).toBe(2)
        expect(head.revision?.summary).toBe("Comparison is constant-time after all")
        expect(head.revision?.observation).toEqual({ basis: "unknown" })
        // The observer's Session is not a foreign key and outlives it.
        expect(head.record.sourceSessionID).toBe(Session.ID.make("ses_gone"))
        expect(head.record.source).toEqual({ kind: "live" })
        expect(head.record.author).toEqual({ actor: "agent", agent: Agent.ID.make("build") })

        const events = yield* Effect.gen(function* () {
          const database = yield* Database.Service
          return yield* Database.primary(database.db)
            .select()
            .from(PriorWorkEventTable)
            .where(eq(PriorWorkEventTable.record_id, created.id))
            .all()
        })
        expect(events.map((event) => [event.action, event.revision])).toEqual([
          ["create", 1],
          ["revise", 2],
        ])
      }),
    TIMEOUT,
  )

  it.live(
    "tombstones deletion, keeps relationships and events, and blanks retraction reasons",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        const claim = yield* at(tmp.path, (service) => service.record({ prepared: prepared() }, agent()))
        const refutation = yield* at(tmp.path, (service) =>
          service.record(
            {
              prepared: prepared({
                kind: "refutation",
                summary: "Comparison happens after a constant-time HMAC check",
                challenges: { resolved: { record_id: claim.id, revision: 1 } },
              }),
            },
            agent("ses_reviewer"),
          ),
        )
        yield* at(tmp.path, (service) => service.retract({ id: claim.id, reason: "RETRACTION-REASON-MARKER" }, agent()))
        expect((yield* at(tmp.path, (service) => service.get({ id: claim.id }))).record.state).toBe("retracted")
        yield* at(tmp.path, (service) => service.delete(claim.id, human))

        const tombstone = yield* at(tmp.path, (service) => service.get({ id: claim.id }))
        expect(tombstone.record).toMatchObject({ id: claim.id, kind: "finding", state: "deleted" })
        expect(tombstone.record.summary).toBeUndefined()
        expect(tombstone.revision).toBeUndefined()
        const challenge = yield* at(tmp.path, (service) => service.get({ id: refutation.id }))
        expect(challenge.revision?.challenges).toEqual({ resolved: { record_id: claim.id, revision: 1 } })

        const rows = yield* Effect.gen(function* () {
          const database = yield* Database.Service
          const db = Database.primary(database.db)
          return {
            revisions: yield* db
              .select()
              .from(PriorWorkRevisionTable)
              .where(eq(PriorWorkRevisionTable.record_id, claim.id))
              .all(),
            events: yield* db
              .select()
              .from(PriorWorkEventTable)
              .where(eq(PriorWorkEventTable.record_id, claim.id))
              .all(),
          }
        })
        expect(rows.revisions).toEqual([])
        expect(rows.events.map((event) => event.action)).toEqual(["create", "retract", "delete"])
        expect(JSON.stringify(rows.events)).not.toContain("RETRACTION-REASON-MARKER")

        const again = yield* at(tmp.path, (service) =>
          service.record({ target: { id: claim.id, head: 1 }, prepared: prepared() }, human),
        ).pipe(Effect.flip)
        expect(again._tag === "PriorWork.Conflict" && again.reason).toBe("record_not_active")
      }),
    TIMEOUT,
  )

  it.live(
    "adopts each source once and resolves pending challenges to the first revision",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        const origin = (source_id: string) => ({
          author: { actor: "agent", agent: "explore" },
          source: "board_note",
          source_id,
          root_session_id: "ses_root_earlier",
          source_session_id: "ses_observer_deleted",
          time_observed: 1_700_000_000_000,
        })
        const pending = yield* at(tmp.path, (service) =>
          service.adopt(
            {
              origin: origin("tbn_refuted"),
              prepared: prepared({
                kind: "refutation",
                summary: "Login handler is not reachable unauthenticated",
                challenges: { unresolved: { source: "board_note", source_id: "tbn_claim" } },
              }),
            },
            agent("ses_adopter"),
          ),
        )
        const before = yield* at(tmp.path, (service) => service.get({ id: pending.id }))
        expect(before.revision?.challenges).toEqual({ unresolved: { source: "board_note", source_id: "tbn_claim" } })
        expect(before.record.author).toEqual({ actor: "agent", agent: Agent.ID.make("explore") })
        expect(before.record.source).toEqual({
          kind: "board_note",
          source_id: "tbn_refuted",
          root_session_id: Session.ID.make("ses_root_earlier"),
        })
        expect(before.record.sourceSessionID).toBe(Session.ID.make("ses_observer_deleted"))
        expect(before.record.timeObserved).toBe(1_700_000_000_000)
        expect(before.revision?.recordedBy).toEqual(agent("ses_adopter"))

        const claim = yield* at(tmp.path, (service) =>
          service.adopt({ origin: origin("tbn_claim"), prepared: prepared() }, agent("ses_adopter")),
        )
        const after = yield* at(tmp.path, (service) => service.get({ id: pending.id }))
        expect(after.record.headRevision).toBe(2)
        expect(after.revision?.challenges).toEqual({ resolved: { record_id: claim.id, revision: 1 } })
        expect(after.revision?.summary).toBe("Login handler is not reachable unauthenticated")

        const twice = yield* at(tmp.path, (service) =>
          service.adopt({ origin: origin("tbn_claim"), prepared: prepared() }, human),
        ).pipe(Effect.flip)
        expect(twice._tag === "PriorWork.Conflict" && twice.reason).toBe("already_adopted")
      }),
    TIMEOUT,
  )

  it.live(
    "pages search results with a cursor and filters by kind, path, author, and text",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        // One graph for the whole scenario: each graph resolves the project through git.
        yield* at(tmp.path, (service) =>
          Effect.gen(function* () {
            const ids = yield* Effect.forEach(
              Array.from({ length: 55 }, (_, index) => index),
              (index) =>
                service
                  .record(
                    {
                      prepared: prepared({
                        kind: index % 5 === 0 ? "coverage" : "finding",
                        summary: `Observation ${index}`,
                        locations: [index % 2 === 0 ? { directory: "src/auth" } : { path: `lib/file-${index}.ts` }],
                      }),
                    },
                    index === 3 ? human : agent(),
                  )
                  .pipe(Effect.map((result) => result.id)),
            )

            const first = yield* service.search({})
            expect(first.items).toHaveLength(50)
            expect(first.items[0]?.id).toBe(ids.at(-1)!)
            expect(first.cursor).toBe(first.items.at(-1)!.id)
            const second = yield* service.search({ cursor: first.cursor })
            expect(second.items).toHaveLength(5)
            expect(second.cursor).toBeUndefined()
            expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(55)

            const oversized = yield* service.search({ limit: 51 }).pipe(Effect.flip)
            expect(oversized._tag).toBe("PriorWork.InvalidInput")

            expect((yield* service.search({ kind: "coverage" })).items).toHaveLength(11)
            expect((yield* service.search({ path: "src/auth/login.ts" })).items).toHaveLength(0)
            expect((yield* service.search({ path: "src" })).items).toHaveLength(28)
            expect((yield* service.search({ path: "lib/file-7.ts" })).items).toHaveLength(1)
            expect((yield* service.search({ author: { actor: "human" } })).items).toHaveLength(1)
            expect((yield* service.search({ text: "Observation 42" })).items).toHaveLength(1)
            expect((yield* service.search({ text: "100%_" })).items).toHaveLength(0)
          }),
        )
      }),
    TIMEOUT,
  )
})

describe("PriorWork input screening", () => {
  it.live(
    "rejects oversized fields by UTF-8 bytes with content-free errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        const marker = "OVERSIZE-MARKER"
        // 300 characters, but 600+ UTF-8 bytes: over the 512-byte summary limit.
        const summary = `${marker}${"é".repeat(300)}`
        expect(summary.length).toBeLessThan(PriorWork.Limits.summaryBytes)
        const failure = yield* at(tmp.path, (service) =>
          service.record({ prepared: prepared({ summary }) }, agent()),
        ).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(PriorWork.InvalidInput)
        expect(failure._tag === "PriorWork.InvalidInput" && failure.reason).toBe("too_large")
        expect(failure._tag === "PriorWork.InvalidInput" && failure.paths).toEqual(["prepared.summary"])
        expect(failure.message).not.toContain(marker)
        expect(JSON.stringify(failure)).not.toContain(marker)

        const tooMany = yield* at(tmp.path, (service) =>
          service.record(
            {
              prepared: prepared({
                assumptions: Array.from({ length: 17 }, () => ({ text: marker, status: "known" })),
              }),
            },
            agent(),
          ),
        ).pipe(Effect.flip)
        expect(tooMany._tag === "PriorWork.InvalidInput" && tooMany.reason).toBe("too_large")
        expect(JSON.stringify(tooMany)).not.toContain(marker)

        const malformed = yield* at(tmp.path, (service) =>
          service.record({ prepared: prepared({ kind: marker, [marker]: marker }) }, agent()),
        ).pipe(Effect.flip)
        expect(malformed._tag === "PriorWork.InvalidInput" && malformed.reason).toBe("malformed")
        expect(malformed.message).not.toContain(marker)
        expect(JSON.stringify(malformed)).not.toContain(marker)

        expect((yield* at(tmp.path, (service) => service.search({}))).items).toEqual([])
      }),
    TIMEOUT,
  )

  it.live(
    "rejects secret placeholders in any field and input it cannot walk",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        const placeholder = "[SECRET:v1:github:0123456789abcdef0123456789abcdef]"
        const inputs = [
          { prepared: prepared({ evidence: [{ kind: "command", ref: "curl", note: `token ${placeholder}` }] }) },
          { prepared: prepared({ summary: "cut [SECRET:v1:git" }) },
          { key: placeholder, prepared: prepared() },
          { prepared: prepared({ [placeholder]: "extra key" }) },
        ]
        const failures = yield* Effect.forEach(inputs, (input) =>
          at(tmp.path, (service) => service.record(input, agent())).pipe(Effect.flip),
        )
        failures.forEach((failure) => {
          expect(failure._tag === "PriorWork.InvalidInput" && failure.reason).toBe("placeholder")
          expect(failure.message).not.toContain("[SECRET")
          expect(JSON.stringify(failure)).not.toContain("[SECRET")
        })

        const cyclic: Record<string, unknown> = prepared()
        cyclic["self"] = cyclic
        const unwalkable = [
          { prepared: cyclic },
          { prepared: prepared({ detail: new Date() }) },
          { prepared: prepared({ assumptions: new Proxy([], {}) }) },
          {
            prepared: Object.defineProperty(prepared(), "detail", {
              enumerable: true,
              get: () => "accessor",
            }),
          },
        ]
        const rejected = yield* Effect.forEach(unwalkable, (input) =>
          at(tmp.path, (service) => service.record(input, agent())).pipe(Effect.flip),
        )
        rejected.forEach((failure) =>
          expect(failure._tag === "PriorWork.InvalidInput" && failure.reason).toBe("placeholder"),
        )
        const retracted = yield* at(tmp.path, (service) =>
          service.retract({ id: "pwr_missing", reason: `because ${placeholder}` }, human),
        ).pipe(Effect.flip)
        expect(retracted._tag === "PriorWork.InvalidInput" && retracted.reason).toBe("placeholder")
        expect((yield* at(tmp.path, (service) => service.search({}))).items).toEqual([])
      }),
    TIMEOUT,
  )

  it.effect(
    "walks every string and fails closed on values it cannot read",
    () =>
      Effect.sync(() => {
        expect(SecretPlaceholder.containsPlaceholder({ a: [{ b: "clean" }], c: 1, d: null, e: true })).toBe(false)
        expect(SecretPlaceholder.containsPlaceholder({ a: [{ b: "x [SECRET:v1" }] })).toBe(true)
        expect(SecretPlaceholder.containsPlaceholder({ "[SECRET:v1:k": 1 })).toBe(true)
        expect(SecretPlaceholder.containsPlaceholder(Number.NaN)).toBe(true)
        expect(SecretPlaceholder.containsPlaceholder(10n)).toBe(true)
        expect(SecretPlaceholder.containsPlaceholder(new Map())).toBe(true)
        const deep = Array.from({ length: 100 }).reduce<unknown>((inner) => [inner], "leaf")
        expect(SecretPlaceholder.containsPlaceholder(deep)).toBe(true)
        const shared = { value: "clean" }
        expect(SecretPlaceholder.containsPlaceholder([shared, shared])).toBe(false)
      }),
    TIMEOUT,
  )
})
