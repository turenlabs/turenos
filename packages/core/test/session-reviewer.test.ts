import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { EventV2 } from "@turenlabs/core/event"
import { Global } from "@turenlabs/core/global"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionHarness } from "@turenlabs/core/session/harness"
import {
  harnessSelfModificationEnabled,
  harnessSelfModificationGloballyEnabled,
  parseReviewerReply,
  SessionReviewer,
} from "@turenlabs/core/session/reviewer"
import { DateTime, Deferred, Effect, Fiber, Layer, LayerMap, Stream } from "effect"
import { tmpdir } from "./fixture/tmpdir"

describe("automatic Harness reviewer replies", () => {
  test("keeps automatic self-modification disabled unless explicitly enabled", () => {
    const document = (value: unknown) => {
      const decoded = Config.decodeDocument(JSON.stringify(value))
      if (!decoded) throw new Error("expected a valid config document")
      return decoded
    }
    const directory = new Config.Directory({ type: "directory", path: AbsolutePath.make("/project") })

    expect(harnessSelfModificationEnabled([])).toBe(false)
    expect(harnessSelfModificationEnabled([document({})])).toBe(false)
    expect(
      harnessSelfModificationEnabled([document({ agent: {}, experimental: { harness_self_modification: true } })]),
    ).toBe(true)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        document({ experimental: { policies: [] } }),
      ]),
    ).toBe(true)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        document({ experimental: { harness_self_modification: false } }),
      ]),
    ).toBe(false)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: false } }),
        document({ experimental: { harness_self_modification: true } }),
      ]),
    ).toBe(false)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        directory,
        document({ experimental: { harness_self_modification: false } }),
      ]),
    ).toBe(false)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        directory,
        document({ experimental: { harness_self_modification: true } }),
      ]),
    ).toBe(true)
    expect(
      harnessSelfModificationGloballyEnabled([
        document({ experimental: { harness_self_modification: false } }),
        document({ experimental: { harness_self_modification: true } }),
      ]),
    ).toBe(true)
  })

  test("skips historical and location scans until globally enabled", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "forge.json")
    await fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: false } }))

    let sessionScans = 0
    let locationAcquisitions = 0
    const startupOrder: string[] = []
    const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
    const session = SessionV2.Info.make({
      id: SessionV2.ID.make("ses_reviewer_startup"),
      projectID: ProjectV2.ID.global,
      agent: AgentV2.ID.make("build"),
      title: "Reviewer startup test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(Date.now()) },
      location,
    })
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(() => {
        locationAcquisitions++
        return Layer.mock(Config.Service, {
          entries: () =>
            Effect.succeed([
              Config.decodeDocument(JSON.stringify({ experimental: { harness_self_modification: true } }))!,
            ]),
        }) as Layer.Layer<LocationServices>
      }),
    )
    const events = Layer.mock(EventV2.Service, {
      subscribe: () => Stream.empty,
      listen: () =>
        Effect.sync(() => {
          startupOrder.push("listen")
          return Effect.void
        }),
    })
    const unused = () => Effect.die("unused SessionV2 test method")
    const sessions = Layer.mock(SessionV2.Service, {
      list: () =>
        Effect.sync(() => {
          startupOrder.push("list")
          sessionScans++
          return [session]
        }),
      get: () => Effect.succeed(session),
      goal: { get: unused, set: unused, edit: unused, status: unused, clear: unused },
      revert: { stage: unused, clear: unused, commit: unused },
    })
    const layer = AppNodeBuilder.build(SessionReviewer.node, [
      [EventV2.node, events],
      [LocationServiceMap.node, locations],
      [SessionCreation.node, Layer.mock(SessionCreation.Service, {})],
      [SessionV2.node, sessions],
      [SessionHarness.node, Layer.mock(SessionHarness.Service, {})],
      [Global.node, Global.layerWith({ config: tmp.path })],
    ])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reviewer = yield* SessionReviewer.Service
          expect(sessionScans).toBe(0)
          expect(locationAcquisitions).toBe(0)
          expect(startupOrder).toEqual(["listen"])

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: true } })),
          )
          yield* reviewer.refresh()
          expect(sessionScans).toBe(1)
          expect(locationAcquisitions).toBe(1)
          expect(startupOrder).toEqual(["listen", "list"])

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: false } })),
          )
          yield* reviewer.refresh()
          expect(sessionScans).toBe(1)

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: true } })),
          )
          yield* reviewer.refresh()
          expect(sessionScans).toBe(2)
          // The original loop still owns this Session, so re-enable must not create a duplicate
          // Location graph or reviewer loop. It observes the fresh global gate on its next review.
          expect(locationAcquisitions).toBe(1)

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: false } })),
          )
          yield* reviewer.refresh()
          const persisted = yield* Deferred.make<void>()
          const blocked = yield* Deferred.make<void>()
          const enabling = yield* reviewer
            .withConfigTransition(
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: true } })),
                )
                yield* Deferred.succeed(persisted, undefined)
                yield* Deferred.await(blocked)
              }),
              { invalidate: true },
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(persisted)
          yield* Fiber.interrupt(enabling)
          for (let attempt = 0; attempt < 100 && sessionScans < 3; attempt++) yield* Effect.yieldNow
          expect(sessionScans).toBe(3)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("preserves the complete guidance replacement list", () => {
    const guidance = Array.from({ length: 18 }, (_, index) => ({
      appliesTo: `src/file-${index}.ts`,
      directive: `Keep directive ${index} short and concrete.`,
    }))
    const result = parseReviewerReply(
      JSON.stringify({
        decision: "proposal",
        baseVersion: 16,
        summary: "Keep the next turn aligned with the confirmed defect.",
        guidance,
      }),
    )

    expect(result.kind).toBe("proposal")
    if (result.kind !== "proposal") throw new Error("expected a proposal")
    expect(result.proposal.changes).toEqual([])
    expect(result.proposal.guidance).toHaveLength(18)
    expect(result.proposal.guidance?.[0]?.appliesTo).toBe("src/file-0.ts")
    expect(result.proposal.guidance?.at(-1)?.appliesTo).toBe("src/file-17.ts")
  })

  test("accepts a guidance-only proposal without changes", () => {
    const result = parseReviewerReply(
      JSON.stringify({
        decision: "proposal",
        baseVersion: 1,
        summary: "Reuse the established baseline.",
        guidance: [{ appliesTo: "src/mem.rs", directive: "Diff against the baseline before editing." }],
      }),
    )

    expect(result.kind).toBe("proposal")
    if (result.kind !== "proposal") throw new Error("expected a proposal")
    expect(result.proposal.changes).toEqual([])
  })

  test("recognizes an explicit no-op reply", () => {
    expect(parseReviewerReply('{"decision":"none"}')).toEqual({ kind: "declined" })
  })
})
