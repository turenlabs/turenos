import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "@turenlabs/schema/agent"
import { PriorWork as Contract } from "@turenlabs/schema/prior-work"
import { Session } from "@turenlabs/schema/session"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { GitFingerprint } from "@turenlabs/core/git-fingerprint"
import { Global } from "@turenlabs/core/global"
import { Location } from "@turenlabs/core/location"
import { PriorWork } from "@turenlabs/core/prior-work"
import { bounded, decodeCapture, evaluate, unavailable } from "@turenlabs/core/prior-work/applicability"
import { PriorWorkRepositoryTable, PriorWorkRevisionTable } from "@turenlabs/core/prior-work/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const TIMEOUT = 60_000
const it = testEffect(AppNodeBuilder.build(Database.node))
const darwin = GitFingerprint.supportedPlatform() ? describe : describe.skip

const agent = (session = "ses_recorder") =>
  ({ actor: "agent", session_id: Session.ID.make(session), agent: Agent.ID.make("build") }) as const
const human = { actor: "human", name: "owner" } as const

const prepared = (overrides: Record<string, unknown> = {}) => ({
  kind: "finding",
  summary: "Token comparison is not constant-time",
  detail: "",
  method: "manual review",
  assumptions: [],
  locations: [{ path: "src/auth.ts" }],
  evidence: [],
  derived_from: [],
  ...overrides,
})

const oid = (digit: string) => digit.repeat(40)
const complete = (root: string, anchors: Contract.CaptureAnchor[] = []): Contract.Capture => ({
  scheme: "fp_v1",
  capture_revision: 1,
  status: "available",
  object_format: "sha1",
  root,
  completeness: { state: "complete" },
  anchors,
})
const file = (digit: string, mode: "100644" | "100755" | "120000" = "100644"): Contract.CaptureAnchor => ({
  state: "entry",
  mode,
  oid: oid(digit),
})
const tree = (digit: string, symlink = false): Contract.CaptureAnchor => ({
  state: "tree",
  oid: oid(digit),
  contains_symlink: symlink,
})

describe("PriorWork applicability algebra", () => {
  const run = (input: {
    kind?: Contract.Kind
    original?: string[]
    evaluated?: string[]
    baseline?: Contract.Capture
    current: Contract.Capture
    anchors?: Record<string, Contract.CaptureAnchor>
  }) =>
    evaluate({
      kind: input.kind ?? "finding",
      original: input.original ?? ["a"],
      evaluated: input.evaluated ?? input.original ?? ["a"],
      baseline: input.baseline,
      current: input.current,
      anchor: (value) => input.anchors?.[value],
    })

  it.effect("never yields unchanged without complete compatible captures on both sides", () =>
    Effect.sync(() => {
      const current = complete(oid("1"), [])
      expect(run({ current })).toEqual({ status: "unknown", reason: "no_baseline" })
      expect(run({ baseline: unavailable("timeout"), current })).toEqual({
        status: "unknown",
        reason: "baseline_unavailable",
      })
      expect(run({ baseline: complete(oid("1"), [file("2")]), current: unavailable("race") })).toEqual({
        status: "unknown",
        reason: "current_unavailable",
      })
      const partial: Contract.Capture = {
        ...complete(oid("1"), [file("2")]),
        completeness: { state: "partial", reasons: ["oversized"], excluded: 1, samples: [], omitted: true },
      } as Contract.Capture
      expect(run({ baseline: partial, current, anchors: { a: file("2") } })).toEqual({
        status: "unknown",
        reason: "partial",
      })
      expect(run({ baseline: complete(oid("1"), [file("2")]), current: partial, anchors: { a: file("2") } })).toEqual({
        status: "unknown",
        reason: "partial",
      })
    }),
  )

  it.effect("compares roots for coverage, refutation and anchorless records", () =>
    Effect.sync(() => {
      const baseline = complete(oid("1"), [file("2")])
      for (const kind of ["coverage", "refutation"] as const) {
        // An unrelated change makes coverage and refutation stale even when anchors are equal.
        expect(run({ kind, baseline, current: complete(oid("9")), anchors: { a: file("2") } })).toEqual({
          status: "stale",
          reason: "root_changed",
        })
        expect(run({ kind, baseline, current: complete(oid("1")) })).toEqual({
          status: "unchanged_since_recording",
          reason: "root_unchanged",
        })
      }
      // Zero original anchors never iterate vacuously to unchanged.
      expect(run({ original: [], baseline: complete(oid("1")), current: complete(oid("9")) })).toEqual({
        status: "stale",
        reason: "root_changed",
      })
    }),
  )

  it.effect("compares anchored findings by the union of original and evaluated anchors", () =>
    Effect.sync(() => {
      const baseline = complete(oid("1"), [file("2"), { state: "unknown", reason: "excluded" }])
      const anchors = { a: file("2"), b: file("3") }
      // Unrelated changes leave an anchored finding unchanged.
      expect(run({ baseline, original: ["a"], current: complete(oid("9")), anchors })).toEqual({
        status: "unchanged_since_recording",
        reason: "anchors_unchanged",
      })
      // Stale resolved A outranks unknown-at-recording B.
      expect(
        run({ baseline, original: ["a", "b"], current: complete(oid("9")), anchors: { a: file("4"), b: file("3") } }),
      ).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
      expect(run({ baseline, original: ["a", "b"], current: complete(oid("9")), anchors })).toEqual({
        status: "unknown",
        reason: "anchor_unknown",
      })
      // A newly added anchor has no recorded identifier.
      expect(run({ baseline, original: ["a"], evaluated: ["a", "c"], current: complete(oid("9")), anchors })).toEqual({
        status: "unknown",
        reason: "anchor_unknown",
      })
      // Removing an anchor in a later revision never removes it from evaluation.
      expect(
        run({ baseline, original: ["a"], evaluated: [], current: complete(oid("9")), anchors: { a: file("4") } }),
      ).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
      // Literal absence is stale; newly excluded or ignored is unknown.
      expect(
        run({ baseline, original: ["a"], current: complete(oid("9")), anchors: { a: { state: "absent" } } }),
      ).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
      expect(
        run({
          baseline,
          original: ["a"],
          current: complete(oid("9")),
          anchors: { a: { state: "unknown", reason: "outside_universe" } },
        }),
      ).toEqual({ status: "unknown", reason: "anchor_unknown" })
      expect(
        run({ baseline, original: ["a"], current: complete(oid("9")), anchors: { a: file("2", "100755") } }),
      ).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
      expect(run({ baseline, original: ["a"], current: complete(oid("9")), anchors: { a: tree("2") } })).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
    }),
  )

  it.effect("treats equal symlinks and directories containing symlinks as unknown", () =>
    Effect.sync(() => {
      const link = complete(oid("1"), [file("2", "120000")])
      expect(run({ baseline: link, current: complete(oid("1")), anchors: { a: file("2", "120000") } })).toEqual({
        status: "unknown",
        reason: "anchor_unknown",
      })
      expect(run({ baseline: link, current: complete(oid("9")), anchors: { a: file("3", "120000") } })).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
      const directory = complete(oid("1"), [tree("2", true)])
      expect(run({ baseline: directory, current: complete(oid("1")), anchors: { a: tree("2", true) } })).toEqual({
        status: "unknown",
        reason: "anchor_unknown",
      })
      expect(run({ baseline: directory, current: complete(oid("9")), anchors: { a: tree("3", true) } })).toEqual({
        status: "stale",
        reason: "anchor_changed",
      })
      // A link added inside an otherwise equal directory is still unknown, not unchanged.
      expect(
        run({
          baseline: complete(oid("1"), [tree("2")]),
          current: complete(oid("1")),
          anchors: { a: tree("2", true) },
        }),
      ).toEqual({
        status: "unknown",
        reason: "anchor_unknown",
      })
    }),
  )

  it.effect("bounds stored baselines and decodes legacy values leniently", () =>
    Effect.sync(() => {
      const sample = "\u0001".repeat(170)
      expect(Buffer.byteLength(JSON.stringify(sample))).toBeLessThanOrEqual(1024)
      const worst: GitFingerprint.Result = {
        status: "available",
        scheme: "fp_v1",
        objectFormat: "sha1",
        head: { commit: oid("a"), tree: oid("b") },
        root: oid("c"),
        completeness: {
          state: "partial",
          reasons: ["oversized", "unreadable", "path_encoding", "gitlink", "embedded_repository", "symlink_parent"],
          excluded: 100_000,
          samples: Array(8).fill(sample),
          omitted: true,
        },
        anchors: Array.from({ length: 32 }, () => ({ state: "tree", oid: oid("d"), containsSymlink: false }) as const),
        identity: { worktree: { dev: 1, ino: 1 }, common: { dev: 1, ino: 1, birthtime: 1 } },
        entries: 1,
        readBytes: 1,
      }
      const stored = bounded(worst)
      expect(stored.status).toBe("available")
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(Contract.CAPTURE_BYTES)
      expect(JSON.stringify(stored)).not.toContain("identity")
      // Forced overflow is stored unavailable, never truncated into a different complete value.
      expect(bounded({ ...worst, anchors: Array(33).fill(worst.anchors[0]) })).toEqual(unavailable("metadata_limit"))
      expect(bounded({ ...worst, root: "not-an-object-id" })).toEqual(unavailable("metadata_limit"))
      expect(decodeCapture(null)).toBeUndefined()
      expect(decodeCapture({ commit: "legacy", completeness: { state: "complete" } })).toBeUndefined()
      expect(decodeCapture(stored)).toEqual(stored)
    }),
  )
})

describe("PriorWork prepared anchors", () => {
  it.live(
    "rejects noncanonical prepared anchors without reflecting content",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        yield* Effect.promise(() => repository(tmp.path))
        for (const location of [
          { path: "/etc/passwd" },
          { path: "a/../SECRET-CANARY" },
          { directory: "src/" },
          { path: ".git/config" },
          { path: "a\\b" },
          { directory: "." },
        ]) {
          const failure = yield* at(tmp.path, (service) =>
            service.record({ prepared: prepared({ locations: [{ path: "ok" }, location] }) }, agent()),
          ).pipe(Effect.flip)
          expect(failure._tag === "PriorWork.InvalidInput" && failure.reason).toBe("malformed")
          expect(failure._tag === "PriorWork.InvalidInput" && failure.paths).toEqual([
            `prepared.locations.1.${"path" in location ? "path" : "directory"}`,
          ])
          expect(JSON.stringify(failure) + failure.message).not.toContain("CANARY")
          expect(JSON.stringify(failure) + failure.message).not.toContain("passwd")
        }
        expect((yield* at(tmp.path, (service) => service.search({}))).items).toEqual([])
      }),
    TIMEOUT,
  )
})

darwin("PriorWork applicability", () => {
  it.live(
    "compares disjoint record anchors without applying the stored capture budget to their union",
    () =>
      captureOn(
        Effect.gen(function* () {
          const tmp = yield* scratch
          const main = path.join(tmp.path, "main")
          const other = path.join(tmp.path, "other")
          const groups = ["first", "second"].map((group) =>
            Array.from({ length: 17 }, (_, index) => ({ path: `src/${group}-${index}.ts` })),
          )
          yield* Effect.promise(async () => {
            await fs.mkdir(main)
            await repository(main)
            await Promise.all(groups.flat().map((location) => write(main, location.path, "export {}\n")))
            await commit(main)
            await $`git clone -q ${main} ${other}`.quiet()
          })
          const records = yield* Effect.forEach(groups, (locations) =>
            at(main, (service) => service.record({ prepared: prepared({ locations }) }, agent()), tmp.path),
          )
          const refs = records.map((record) => ({ record_id: record.id, revision: 1 }))
          const history = yield* Effect.forEach(records, (record) =>
            at(main, (service) => service.get({ id: record.id, revision: 1 }), tmp.path),
          )
          expect(history.map((detail) => detail.revision?.recordingCapture)).toMatchObject([
            { status: "available", completeness: { state: "complete" } },
            { status: "available", completeness: { state: "complete" } },
          ])
          const individual = yield* Effect.forEach(refs, (ref) =>
            at(main, (service) => service.applicability({ refs: [ref] }), tmp.path),
          )
          expect(individual.flat().map((result) => result.status)).toEqual([
            "unchanged_since_recording",
            "unchanged_since_recording",
          ])
          expect(yield* at(main, (service) => service.applicability({ refs }), tmp.path)).toEqual(individual.flat())
          yield* Effect.promise(() => write(main, groups[0]![0]!.path, "export const changed = true\n"))
          const changed = yield* at(main, (service) => service.applicability({ refs }), tmp.path)
          expect(changed.map((result) => [result.status, result.reason])).toEqual([
            ["stale", "anchor_changed"],
            ["unchanged_since_recording", "anchors_unchanged"],
          ])
          expect(changed).toEqual(
            (yield* Effect.forEach(refs, (ref) =>
              at(main, (service) => service.applicability({ refs: [ref] }), tmp.path),
            )).flat(),
          )
          expect(
            yield* Effect.forEach(records, (record) =>
              at(main, (service) => service.get({ id: record.id, revision: 1 }), tmp.path),
            ),
          ).toEqual(history)
          expect(
            yield* at(other, (service) => service.applicability({ refs }), tmp.path).pipe(Effect.flip),
          ).toBeInstanceOf(PriorWork.NotFound)
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "stores the original baseline and evaluates file and directory anchors against the current worktree",
    () =>
      captureOn(
        Effect.gen(function* () {
          const tmp = yield* scratch
          const repo = path.join(tmp.path, "repo")
          yield* Effect.promise(async () => {
            await repository(repo)
            await write(repo, "src/auth.ts", "compare(a, b)\n")
            await write(repo, "src/lib/util.ts", "export {}\n")
            await write(repo, "src/other.ts", "unrelated\n")
            await commit(repo)
          })
          const record = (overrides: Record<string, unknown>) =>
            at(repo, (service) => service.record({ prepared: prepared(overrides) }, agent()), tmp.path)
          const fileFinding = yield* record({ locations: [{ path: "src/auth.ts" }] })
          const dirFinding = yield* record({ locations: [{ directory: "src/lib" }] })
          const coverage = yield* record({ kind: "coverage", locations: [{ path: "src/auth.ts" }] })
          const anchorless = yield* record({ locations: [] })
          const all = [fileFinding, dirFinding, coverage, anchorless].map((item) => ({
            record_id: item.id,
            revision: item.revision,
          }))
          const status = () =>
            at(repo, (service) => service.applicability({ refs: all }), tmp.path).pipe(
              Effect.map((items) => items.map((item) => item.status)),
            )

          const stored = yield* at(repo, (service) => service.get({ id: fileFinding.id }), tmp.path)
          expect(stored.revision?.recordingCapture).toMatchObject({
            scheme: "fp_v1",
            capture_revision: 1,
            status: "available",
            completeness: { state: "complete" },
            anchors: [{ state: "entry", mode: "100644" }],
          })
          // Stored baseline (not yet model-facing: no tool renders it) carries identifiers and
          // modes, never anchor paths or contents. Step 3's renderer must also drop OIDs/samples.
          expect(JSON.stringify(stored.revision?.recordingCapture)).not.toContain("auth")
          expect(yield* status()).toEqual(Array(4).fill("unchanged_since_recording"))

          yield* Effect.promise(() => write(repo, "src/other.ts", "unrelated change\n"))
          expect(yield* status()).toEqual(["unchanged_since_recording", "unchanged_since_recording", "stale", "stale"])

          yield* Effect.promise(() => write(repo, "src/lib/util.ts", "changed\n"))
          expect((yield* status())[1]).toBe("stale")

          yield* Effect.promise(() => fs.rename(path.join(repo, "src/auth.ts"), path.join(repo, "src/auth2.ts")))
          expect((yield* status())[0]).toBe("stale")

          // Restoring the bytes restores the comparison: no Git object had to survive.
          yield* Effect.promise(async () => {
            await fs.rename(path.join(repo, "src/auth2.ts"), path.join(repo, "src/auth.ts"))
            await write(repo, "src/other.ts", "unrelated\n")
            await write(repo, "src/lib/util.ts", "export {}\n")
            await fs.rm(path.join(tmp.path, "cache"), { recursive: true, force: true })
          })
          expect(yield* status()).toEqual(Array(4).fill("unchanged_since_recording"))

          // A newly ignored, still present anchor is unknown, not a deletion. HEAD/index-tracked
          // paths stay in the universe, so the removal has to be committed.
          yield* Effect.promise(async () => {
            await $`git rm -q --cached src/auth.ts`.cwd(repo).quiet()
            await write(repo, ".gitignore", "src/auth.ts\n")
            await commit(repo)
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(repo, "src/auth.ts"), "utf8"))).toBe(
            "compare(a, b)\n",
          )
          expect((yield* status())[0]).toBe("unknown")
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "treats equal symlink anchors as unknown, retargeting as stale, and leaves unrelated anchors comparable",
    () =>
      captureOn(
        Effect.gen(function* () {
          const tmp = yield* scratch
          const repo = path.join(tmp.path, "repo")
          yield* Effect.promise(async () => {
            await repository(repo)
            await write(repo, "target/config", "one\n")
            await write(repo, "dir/plain", "plain\n")
            await fs.symlink("../target/config", path.join(repo, "dir", "link"))
            await fs.symlink("target/config", path.join(repo, "link"))
            await commit(repo)
          })
          const record = (location: object) =>
            at(repo, (service) => service.record({ prepared: prepared({ locations: [location] }) }, agent()), tmp.path)
          const items = yield* Effect.all([
            record({ path: "link" }),
            record({ directory: "dir" }),
            record({ path: "dir/plain" }),
          ])
          const refs = items.map((item) => ({ record_id: item.id, revision: 1 }))
          const status = () =>
            at(repo, (service) => service.applicability({ refs }), tmp.path).pipe(
              Effect.map((result) => result.map((item) => item.status)),
            )
          expect(yield* status()).toEqual(["unknown", "unknown", "unchanged_since_recording"])
          // In-repository target edit with equal link text stays unknown, never unchanged.
          yield* Effect.promise(() => write(repo, "target/config", "two\n"))
          expect(yield* status()).toEqual(["unknown", "unknown", "unchanged_since_recording"])
          yield* Effect.promise(async () => {
            await fs.rm(path.join(repo, "link"))
            await fs.symlink("target/elsewhere", path.join(repo, "link"))
            await fs.rm(path.join(repo, "dir", "link"))
            await fs.symlink("../target/elsewhere", path.join(repo, "dir", "link"))
          })
          expect(yield* status()).toEqual(["stale", "stale", "unchanged_since_recording"])
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "carries the original baseline across revisions and evaluates historical revisions by their anchor union",
    () =>
      captureOn(
        Effect.gen(function* () {
          const tmp = yield* scratch
          const repo = path.join(tmp.path, "repo")
          yield* Effect.promise(async () => {
            await repository(repo)
            await write(repo, "a.ts", "a\n")
            await write(repo, "b.ts", "b\n")
            await commit(repo)
          })
          const created = yield* at(
            repo,
            (service) => service.record({ prepared: prepared({ locations: [{ path: "a.ts" }] }) }, agent()),
            tmp.path,
          )
          yield* Effect.promise(() => write(repo, "a.ts", "a changed\n"))
          // A prose revision that drops the stale anchor cannot refresh or escape the baseline.
          const revised = yield* at(
            repo,
            (service) =>
              service.record(
                { target: { id: created.id, head: 1 }, prepared: prepared({ summary: "reworded", locations: [] }) },
                agent(),
              ),
            tmp.path,
          )
          const added = yield* at(
            repo,
            (service) =>
              service.record(
                { target: { id: created.id, head: 2 }, prepared: prepared({ locations: [{ path: "b.ts" }] }) },
                agent(),
              ),
            tmp.path,
          )
          const revisions = yield* Effect.forEach([1, 2, 3], (revision) =>
            at(repo, (service) => service.get({ id: created.id, revision }), tmp.path),
          )
          expect(revisions[1]!.revision?.recordingCapture).toEqual(revisions[0]!.revision?.recordingCapture)
          expect(revisions[2]!.revision?.recordingCapture).toEqual(revisions[0]!.revision?.recordingCapture)
          expect(revisions[2]!.revision?.observation).toEqual({ basis: "unknown" })
          const result = yield* at(
            repo,
            (service) =>
              service.applicability({
                refs: [1, revised.revision, added.revision].map((revision) => ({ record_id: created.id, revision })),
              }),
            tmp.path,
          )
          expect(result.map((item) => item.status)).toEqual(["stale", "stale", "stale"])
          yield* Effect.promise(() => write(repo, "a.ts", "a\n"))
          const restored = yield* at(
            repo,
            (service) =>
              service.applicability({
                refs: [1, 3].map((revision) => ({ record_id: created.id, revision })),
              }),
            tmp.path,
          )
          // Revision 3 added b.ts without a recorded identifier.
          expect(restored.map((item) => item.status)).toEqual(["unchanged_since_recording", "unknown"])
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "keeps adopted, legacy, deleted and capture-failed records unknown, and skips capture when nothing can compare",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const repo = path.join(tmp.path, "repo")
        yield* Effect.promise(() => repository(repo))
        const counter = { captures: 0 }
        const counting = wrap(
          (real) => (input) => Effect.sync(() => counter.captures++).pipe(Effect.andThen(real.capture(input))),
        )
        // A deterministic failure: the read budget is exhausted by the first file, whatever the load.
        const timeout = wrap((real) => (input) => real.capture({ ...input, limits: { readBytes: 1 } }))
        yield* captureOn(
          Effect.gen(function* () {
            const adopted = yield* at(
              repo,
              (service) =>
                service.adopt(
                  {
                    origin: {
                      author: { actor: "agent", agent: "build" },
                      source: "board_note",
                      source_id: "note_1",
                      root_session_id: "ses_old",
                      time_observed: 1,
                    },
                    prepared: prepared(),
                  },
                  agent(),
                ),
              tmp.path,
              counting,
            )
            expect(counter.captures).toBe(0)
            const adoptedDetail = yield* at(repo, (service) => service.get({ id: adopted.id }), tmp.path)
            expect(adoptedDetail.revision?.recordingCapture).toBeUndefined()

            // A failed capture still writes the record, with an explicit unavailable baseline.
            const failed = yield* at(
              repo,
              (service) => service.record({ prepared: prepared() }, agent()),
              tmp.path,
              timeout,
            )
            const failedDetail = yield* at(repo, (service) => service.get({ id: failed.id }), tmp.path)
            expect(failedDetail.revision?.recordingCapture).toEqual(unavailable("read_limit"))

            const deleted = yield* at(repo, (service) => service.record({ prepared: prepared() }, agent()), tmp.path)
            yield* at(repo, (service) => service.delete(deleted.id, human), tmp.path)

            // Legacy step-1 rows have a null baseline; malformed stored anchors stay readable.
            const legacy = yield* at(repo, (service) => service.record({ prepared: prepared() }, agent()), tmp.path)
            const database = yield* Database.Service
            yield* Database.primary(database.db)
              .update(PriorWorkRevisionTable)
              .set({ recording_capture: null, locations: [{ path: "../legacy" }] })
              .where(eq(PriorWorkRevisionTable.record_id, legacy.id))
              .run()
              .pipe(Effect.orDie)
            expect(
              (yield* at(repo, (service) => service.get({ id: legacy.id }), tmp.path)).revision?.locations,
            ).toEqual([{ path: "../legacy" }])

            // A partial baseline is unknown as partial, and does not cost a capture.
            const partial = yield* at(repo, (service) => service.record({ prepared: prepared() }, agent()), tmp.path)
            const stored = (yield* at(repo, (service) => service.get({ id: partial.id }), tmp.path)).revision
              ?.recordingCapture
            const complete = stored?.status === "available" ? stored : undefined
            expect(complete?.completeness).toEqual({ state: "complete" })
            yield* Database.primary(database.db)
              .update(PriorWorkRevisionTable)
              .set({
                recording_capture: {
                  ...complete!,
                  completeness: { state: "partial", reasons: ["oversized"], excluded: 1, samples: [], omitted: false },
                },
              })
              .where(eq(PriorWorkRevisionTable.record_id, partial.id))
              .run()
              .pipe(Effect.orDie)

            counter.captures = 0
            const refs = [adopted, failed, deleted, legacy, partial].map((item) => ({
              record_id: item.id,
              revision: 1,
            }))
            const result = yield* at(repo, (service) => service.applicability({ refs }), tmp.path, counting)
            expect(result.map((item) => [item.status, item.reason])).toEqual([
              ["unknown", "no_baseline"],
              ["unknown", "baseline_unavailable"],
              ["unknown", "record_deleted"],
              ["unknown", "no_baseline"],
              ["unknown", "partial"],
            ])
            expect(yield* at(repo, (service) => service.applicability({ refs: [] }), tmp.path, counting)).toEqual([])
            expect(counter.captures).toBe(0)
          }),
        )
      }),
    TIMEOUT,
  )

  it.live(
    "captures outside transactions: a competing writer progresses and interruption leaves no record or binding",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const repo = path.join(tmp.path, "repo")
        yield* Effect.promise(() => repository(repo))
        const gate = yield* gated()
        yield* captureOn(
          Effect.gen(function* () {
            const pending = yield* Effect.forkChild(
              at(repo, (service) => service.record({ prepared: prepared() }, agent("ses_slow")), tmp.path, gate.layer),
            )
            yield* Deferred.await(gate.started)
            // A competing write commits while the first create is paused mid-capture.
            const other = yield* at(repo, (service) => service.adopt(adoption("note_x"), agent("ses_fast")), tmp.path)
            expect(other.replayed).toBe(false)
            const binding = yield* at(repo, (service) => service.repository(), tmp.path)
            expect(binding).toStartWith("pwb_")
            yield* Fiber.interrupt(pending)
            const items = (yield* at(repo, (service) => service.search({}), tmp.path)).items
            expect(items.map((item) => item.id)).toEqual([other.id])

            // On a fresh repository, an interrupted first create mints no binding.
            const fresh = path.join(tmp.path, "fresh")
            yield* Effect.promise(() => repository(fresh))
            const second = yield* gated()
            const interrupted = yield* Effect.forkChild(
              at(fresh, (service) => service.record({ prepared: prepared() }, agent()), tmp.path, second.layer),
            )
            yield* Deferred.await(second.started)
            yield* Fiber.interrupt(interrupted)
            expect(yield* at(fresh, (service) => service.repository(), tmp.path)).toBeUndefined()
            expect(
              yield* Effect.promise(() => fs.readdir(path.join(tmp.path, "cache", "prior-work", "captures"))),
            ).toEqual([])
          }),
        )
      }),
    TIMEOUT,
  )

  it.live(
    "returns one original record for concurrent exact retries",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const repo = path.join(tmp.path, "repo")
        yield* Effect.promise(() => repository(repo))
        const gate = yield* gated({ release: false })
        yield* captureOn(
          within(repo, tmp.path, gate.layer, (service) =>
            Effect.gen(function* () {
              const request = { key: "k1", prepared: prepared() }
              const first = yield* Effect.forkChild(service.record(request, agent()))
              const second = yield* Effect.forkChild(service.record(request, agent()))
              yield* Deferred.await(gate.started)
              yield* Deferred.succeed(gate.release, undefined)
              const results = [yield* Fiber.join(first), yield* Fiber.join(second)]
              expect(results[0]!.id).toBe(results[1]!.id)
              expect(results.map((item) => item.replayed).toSorted()).toEqual([false, true])
              expect((yield* service.search({})).items).toHaveLength(1)
            }),
          ),
        )
      }),
    TIMEOUT,
  )

  it.live(
    "fails closed when the worktree or binding changes during capture, without minting a replacement binding",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const repo = path.join(tmp.path, "repo")
        yield* Effect.promise(() => repository(repo))
        yield* captureOn(
          Effect.gen(function* () {
            const replace = yield* gated({ release: false })
            const replaced = yield* Effect.forkChild(
              at(repo, (service) => service.record({ prepared: prepared() }, agent()), tmp.path, replace.layer),
            )
            yield* Deferred.await(replace.started)
            yield* Effect.promise(async () => {
              await fs.rename(repo, repo + "-old")
              await fs.cp(repo + "-old", repo, { recursive: true })
            })
            yield* Deferred.succeed(replace.release, undefined)
            const failure = yield* Fiber.join(replaced).pipe(Effect.flip)
            expect(failure._tag === "PriorWork.Conflict" && failure.reason).toBe("repository_changed")
            expect(yield* at(repo, (service) => service.repository(), tmp.path)).toBeUndefined()

            // An existing binding revoked mid-capture is not silently replaced.
            const bound = yield* at(repo, (service) => service.adopt(adoption("note_y"), agent()), tmp.path)
            expect(bound.replayed).toBe(false)
            const revoke = yield* gated({ release: false })
            const revoked = yield* Effect.forkChild(
              at(repo, (service) => service.record({ prepared: prepared() }, agent()), tmp.path, revoke.layer),
            )
            yield* Deferred.await(revoke.started)
            const database = yield* Database.Service
            yield* Database.primary(database.db).delete(PriorWorkRepositoryTable).run().pipe(Effect.orDie)
            yield* Deferred.succeed(revoke.release, undefined)
            const revokedFailure = yield* Fiber.join(revoked).pipe(Effect.flip)
            expect(revokedFailure._tag === "PriorWork.Conflict" && revokedFailure.reason).toBe("repository_changed")
            expect(yield* at(repo, (service) => service.repository(), tmp.path)).toBeUndefined()
          }),
        )
      }),
    TIMEOUT,
  )

  it.live(
    "fails closed when a linked worktree is replaced or re-pointed while its common directory is unchanged",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const main = path.join(tmp.path, "main")
        const linked = path.join(tmp.path, "linked")
        const other = path.join(tmp.path, "other")
        const otherLinked = path.join(tmp.path, "other-linked")
        yield* Effect.promise(async () => {
          await repository(main)
          await $`git worktree add -q --detach ${linked} HEAD`.cwd(main).quiet()
          await repository(other)
          await $`git worktree add -q --detach ${otherLinked} HEAD`.cwd(other).quiet()
        })
        const binding = () => at(main, (service) => service.repository(), tmp.path)
        // Bind main's common directory so the linked worktree resolves to an existing binding.
        yield* at(main, (service) => service.adopt(adoption("note_bind"), agent()), tmp.path)
        const bound = yield* binding()
        const count = () =>
          at(main, (service) => service.search({}), tmp.path).pipe(Effect.map((page) => page.items.length))
        const before = yield* count()
        yield* captureOn(
          Effect.gen(function* () {
            const attempt = (mutate: () => Promise<void>) =>
              Effect.gen(function* () {
                const gate = yield* gated({ release: false })
                const fiber = yield* Effect.forkChild(
                  at(linked, (service) => service.record({ prepared: prepared() }, agent()), tmp.path, gate.layer),
                )
                yield* Deferred.await(gate.started)
                yield* Effect.promise(mutate)
                yield* Deferred.succeed(gate.release, undefined)
                return yield* Fiber.join(fiber).pipe(Effect.flip)
              })
            // Root replaced with an identical copy, keeping the same `.git` pointer: only W changes.
            const replaced = yield* attempt(async () => {
              await fs.rename(linked, linked + "-old")
              await fs.cp(linked + "-old", linked, { recursive: true })
            })
            expect(replaced._tag === "PriorWork.Conflict" && replaced.reason).toBe("repository_changed")
            yield* Effect.promise(async () => {
              await fs.rm(linked, { recursive: true })
              await fs.rename(linked + "-old", linked)
            })
            // `.git` re-pointed at another repository's worktree: the root and A's incarnation are
            // unchanged, but the Git directory no longer resolves to the bound common directory.
            const repointed = yield* attempt(() =>
              fs.copyFile(path.join(otherLinked, ".git"), path.join(linked, ".git")),
            )
            expect(repointed._tag === "PriorWork.Conflict" && repointed.reason).toBe("repository_changed")
            yield* Effect.promise(() => $`git worktree repair ${linked}`.cwd(main).quiet())

            // Mutations after the primitive returns reach only the service's own before/after check.
            const after = (mutate: () => Promise<void>) =>
              at(
                linked,
                (service) => service.record({ prepared: prepared() }, agent()),
                tmp.path,
                wrap((real) => (input) => real.capture(input).pipe(Effect.tap(() => Effect.promise(mutate)))),
              ).pipe(Effect.flip)
            const rootAfter = yield* after(async () => {
              await fs.rename(linked, linked + "-old")
              await fs.cp(linked + "-old", linked, { recursive: true })
            })
            expect(rootAfter._tag === "PriorWork.Conflict" && rootAfter.reason).toBe("repository_changed")
            yield* Effect.promise(async () => {
              await fs.rm(linked, { recursive: true })
              await fs.rename(linked + "-old", linked)
            })
            // Same common directory, different linked worktree administrative directory.
            const sibling = path.join(tmp.path, "sibling")
            yield* Effect.promise(() => $`git worktree add -q --detach ${sibling} HEAD`.cwd(main).quiet())
            const siblingAfter = yield* after(() => fs.copyFile(path.join(sibling, ".git"), path.join(linked, ".git")))
            expect(siblingAfter._tag === "PriorWork.Conflict" && siblingAfter.reason).toBe("repository_changed")
          }),
        )
        // Capture off and a Location resolved before `.git` was re-pointed: nothing is
        // fingerprinted, but the relationship check still refuses.
        const off = yield* at(
          linked,
          (service) =>
            Effect.promise(() => fs.copyFile(path.join(otherLinked, ".git"), path.join(linked, ".git"))).pipe(
              Effect.andThen(service.record({ prepared: prepared() }, agent())),
            ),
          tmp.path,
        ).pipe(Effect.flip)
        expect(off._tag === "PriorWork.Conflict" && off.reason).toBe("repository_changed")
        expect(yield* binding()).toBe(bound)
        expect(yield* count()).toBe(before)
      }),
    TIMEOUT,
  )

  it.live(
    "refuses a nested worktree whose Git directory resolves to an enclosing repository",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scratch
        const outer = path.join(tmp.path, "outer")
        const nested = path.join(outer, "nested")
        yield* Effect.promise(async () => {
          await repository(outer)
          await $`git worktree add -q --detach ${nested} HEAD`.cwd(outer).quiet()
        })
        const binding = () => at(outer, (service) => service.repository(), tmp.path)
        yield* at(outer, (service) => service.adopt(adoption("note_bind"), agent()), tmp.path)
        const bound = yield* binding()
        const count = () =>
          at(outer, (service) => service.search({}), tmp.path).pipe(Effect.map((page) => page.items.length))
        const before = yield* count()
        // The nested worktree loses its `.git` file mid-capture; discovery then walks up to
        // `outer`, whose common directory is still the bound store.
        const pointer = yield* Effect.promise(() => fs.readFile(path.join(nested, ".git")))
        const failure = yield* captureOn(
          Effect.gen(function* () {
            const gate = yield* gated({ release: false })
            const fiber = yield* Effect.forkChild(
              at(nested, (service) => service.record({ prepared: prepared() }, agent()), tmp.path, gate.layer),
            )
            yield* Deferred.await(gate.started)
            yield* Effect.promise(() => fs.rm(path.join(nested, ".git")))
            yield* Deferred.succeed(gate.release, undefined)
            return yield* Fiber.join(fiber).pipe(Effect.flip)
          }),
        )
        expect(failure._tag === "PriorWork.Conflict" && failure.reason).toBe("repository_changed")
        yield* Effect.promise(() => fs.writeFile(path.join(nested, ".git"), pointer))
        // Capture off, with the Location resolved before `.git` disappeared: every observation of
        // this create already sees `outer`, so only the worktree-root equality refuses it.
        const off = yield* at(
          nested,
          (service) =>
            Effect.promise(() => fs.rm(path.join(nested, ".git"))).pipe(
              Effect.andThen(service.record({ prepared: prepared() }, agent())),
            ),
          tmp.path,
        ).pipe(Effect.flip)
        expect(off._tag === "PriorWork.Conflict" && off.reason).toBe("repository_changed")
        expect(yield* binding()).toBe(bound)
        expect(yield* count()).toBe(before)
      }),
    TIMEOUT,
  )

  it.live(
    "carries a real baseline through automated challenge resolution",
    () =>
      captureOn(
        Effect.gen(function* () {
          const tmp = yield* scratch
          const repo = path.join(tmp.path, "repo")
          yield* Effect.promise(() => repository(repo))
          const refutation = yield* at(
            repo,
            (service) =>
              service.record(
                {
                  prepared: prepared({
                    kind: "refutation",
                    challenges: { unresolved: { source: "board_note", source_id: "note_target" } },
                  }),
                },
                agent(),
              ),
            tmp.path,
          )
          const original = yield* at(repo, (service) => service.get({ id: refutation.id, revision: 1 }), tmp.path)
          expect(original.revision?.recordingCapture).toMatchObject({ status: "available", capture_revision: 1 })
          yield* Effect.promise(() => write(repo, "src/app.ts", "changed before adoption\n"))
          // Adopting the challenged source resolves the refutation by writing revision 2.
          yield* at(repo, (service) => service.adopt(adoption("note_target"), agent("ses_other")), tmp.path)
          const resolved = yield* at(repo, (service) => service.get({ id: refutation.id }), tmp.path)
          expect(resolved.record.headRevision).toBe(2)
          expect(resolved.revision?.challenges).toMatchObject({ resolved: { revision: 1 } })
          expect(resolved.revision?.recordingCapture).toEqual(original.revision?.recordingCapture)
          expect(resolved.revision?.observation).toEqual({ basis: "unknown" })
          const status = yield* at(
            repo,
            (service) => service.applicability({ refs: [{ record_id: refutation.id, revision: 2 }] }),
            tmp.path,
          )
          // The worktree changed after the original recording; resolution did not refresh it.
          expect(status[0]!.status).toBe("stale")
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "evaluates against the reader's own worktree and keeps separate clones isolated",
    () =>
      captureOn(
        Effect.gen(function* () {
          const tmp = yield* scratch
          const main = path.join(tmp.path, "main")
          const linked = path.join(tmp.path, "linked")
          const clone = path.join(tmp.path, "clone")
          yield* Effect.promise(async () => {
            await repository(main)
            await write(main, "src/auth.ts", "x\n")
            await commit(main)
            await $`git worktree add -q --detach ${linked} HEAD`.cwd(main).quiet()
            await $`git clone -q ${main} ${clone}`.quiet()
          })
          const created = yield* at(main, (service) => service.record({ prepared: prepared() }, agent()), tmp.path)
          const refs = [{ record_id: created.id, revision: 1 }]
          const fromLinked = () =>
            at(linked, (service) => service.applicability({ refs }), tmp.path).pipe(
              Effect.map((items) => items[0]!.status),
            )
          expect(yield* fromLinked()).toBe("unchanged_since_recording")
          yield* Effect.promise(() => write(linked, "src/auth.ts", "edited in the linked worktree\n"))
          expect(yield* fromLinked()).toBe("stale")
          expect((yield* at(main, (service) => service.applicability({ refs }), tmp.path))[0]!.status).toBe(
            "unchanged_since_recording",
          )
          const foreign = yield* at(clone, (service) => service.applicability({ refs }), tmp.path).pipe(Effect.flip)
          expect(foreign._tag).toBe("PriorWork.NotFound")
        }),
      ),
    TIMEOUT,
  )
})

const scratch = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
)

/** PriorWork for a directory, sharing the ambient database and a scratch-only cache root. */
function at<A, E>(
  directory: string,
  body: (service: PriorWork.Interface) => Effect.Effect<A, E>,
  root?: string,
  fingerprint?: Layer.Layer<GitFingerprint.Service>,
) {
  return within(directory, root, fingerprint, body)
}

function within<A, E>(
  directory: string,
  root: string | undefined,
  fingerprint: Layer.Layer<GitFingerprint.Service> | undefined,
  body: (service: PriorWork.Interface) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const replacements: LayerNode.Replacement[] = [
      [Database.node, Layer.succeed(Database.Service, database)],
      [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    ]
    if (root) replacements.push([Global.node, Global.layerWith({ cache: path.join(root, "cache"), data: root })])
    if (fingerprint) replacements.push([GitFingerprint.node, fingerprint])
    return yield* Effect.gen(function* () {
      const service = yield* PriorWork.Service
      return yield* body(service)
    }).pipe(Effect.provide(AppNodeBuilder.build(PriorWork.node, replacements)))
  })
}

function wrap(
  replace: (real: GitFingerprint.Interface) => GitFingerprint.Interface["capture"],
): Layer.Layer<GitFingerprint.Service> {
  return Layer.effect(
    GitFingerprint.Service,
    Effect.map(GitFingerprint.Service, (real) => GitFingerprint.Service.of({ ...real, capture: replace(real) })),
  ).pipe(Layer.provide(LayerNode.compile(GitFingerprint.node)))
}

/** Pauses a real capture between its two passes until released. */
function gated(options: { release?: boolean } = {}) {
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    if (options.release !== false)
      yield* Deferred.succeed(release, undefined).pipe(Effect.delay("1 hour"), Effect.forkDetach)
    const layer = wrap(
      (real) => (input) =>
        real.capture({
          ...input,
          between: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        }),
    )
    return { started, release, layer }
  })
}

function captureOn<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env["FORGE_EXPERIMENTAL_PRIOR_WORK_CAPTURE"]
      process.env["FORGE_EXPERIMENTAL_PRIOR_WORK_CAPTURE"] = "1"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env["FORGE_EXPERIMENTAL_PRIOR_WORK_CAPTURE"]
        else process.env["FORGE_EXPERIMENTAL_PRIOR_WORK_CAPTURE"] = previous
      }),
  )
}

function adoption(sourceID: string) {
  return {
    origin: {
      author: { actor: "agent", agent: "build" },
      source: "board_note",
      source_id: sourceID,
      root_session_id: "ses_old",
      time_observed: 1,
    },
    prepared: prepared(),
  }
}

async function repository(directory: string) {
  await fs.mkdir(path.join(directory, "src"), { recursive: true })
  await fs.writeFile(path.join(directory, "src", "app.ts"), "export {}\n")
  await $`git init -q`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@forge.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await commit(directory)
  await $`git remote add origin https://example.com/acme/app.git`.cwd(directory).quiet()
}

async function commit(directory: string) {
  await $`git add -A .`.cwd(directory).quiet()
  await $`git commit -q --allow-empty -m fixture`.cwd(directory).quiet()
}

async function write(directory: string, name: string, content: string) {
  await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true })
  await fs.writeFile(path.join(directory, name), content)
}
