import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionStore } from "@turenlabs/core/session/store"
import { Tool } from "@turenlabs/core/tool/tool"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
let denyHarness = false
const permissions = Layer.mock(PermissionV2.Service, {
  assert: () => (denyHarness ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      PermissionV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionHarness.node,
    ]),
    [
      [ProjectV2.node, projects],
      [PermissionV2.node, permissions],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const version = (value: number) => value as SessionHarness.Version

describe("SessionHarness", () => {
  it.effect("persists proposal, apply, reload, and rollback snapshots", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const harness = yield* SessionHarness.Service
      const created = yield* session.create({ location })

      const initial = yield* harness.get(created.id)
      expect(initial.snapshot?.version).toBe(version(1))
      expect(initial.snapshot?.source).toBe("default")

      const reviewTool = SessionHarness.reviewRequestTool(harness, created.id)
      const reviewDefinition = Tool.definition("harness_review_request", reviewTool)
      expect(reviewDefinition.inputSchema).toMatchObject({
        type: "object",
        properties: {
          id: { type: "string" },
          request: { type: "string" },
        },
        required: ["request"],
      })
      expect("$ref" in reviewDefinition.inputSchema).toBe(false)

      const reviewRequest = yield* Tool.settle(
        reviewTool,
        {
          type: "tool-call",
          id: "call-review-request",
          name: "harness_review_request",
          input: { request: "Prefer a bounded search helper." },
        },
        {
          sessionID: created.id,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_review_request"),
          toolCallID: "call-review-request",
        },
      )
      expect(reviewRequest.structured).toEqual({ queued: true })
      expect((yield* harness.get(created.id)).reviewerRequests).toHaveLength(1)

      const proposal = yield* harness.propose({
        sessionID: created.id,
        baseVersion: 1,
        summary: "Add a session-specific repository search hint",
        changes: [
          {
            path: RelativePath.make("src/harness.ts"),
            operation: "add",
            summary: "Add the session harness entrypoint",
            content: "return input",
          },
        ],
        tools: [
          {
            name: "harness_search",
            description: "Search the session-local index.",
            source: RelativePath.make("src/harness.ts"),
            readOnly: true,
            enabled: true,
          },
        ],
        guidance: [{ appliesTo: "src/harness.ts", directive: "Call harness_search before grepping the index." }],
      })
      yield* harness.status({ sessionID: created.id, proposalID: proposal.id, status: "approved" })
      const applied = yield* harness.apply({ sessionID: created.id, proposalID: proposal.id })
      expect(applied.version).toBe(version(2))
      expect(applied.source).toBe("proposal")
      expect(applied.changes).toHaveLength(1)
      expect(applied.tools).toHaveLength(1)
      expect(applied.guidance).toHaveLength(1)

      const secondProposal = yield* harness.propose({
        sessionID: created.id,
        baseVersion: 2,
        summary: "Add a session-specific search tool",
        changes: [
          {
            path: RelativePath.make("src/tools/search.ts"),
            operation: "add",
            summary: "Add the search implementation",
            content: "export const search = () => []",
          },
        ],
      })
      yield* harness.status({ sessionID: created.id, proposalID: secondProposal.id, status: "approved" })
      const secondApplied = yield* harness.apply({ sessionID: created.id, proposalID: secondProposal.id })
      expect(secondApplied.version).toBe(version(3))
      expect(secondApplied.changes).toHaveLength(2)
      expect(secondApplied.tools).toHaveLength(1)
      // A proposal that sends no guidance leaves the standing instructions in place.
      expect(secondApplied.guidance).toHaveLength(1)
      expect((yield* harness.apply({ sessionID: created.id, proposalID: secondProposal.id })).version).toBe(version(3))

      const rolledBack = yield* harness.rollback({
        sessionID: created.id,
        baseVersion: version(3),
        version: version(2),
      })
      expect(rolledBack.version).toBe(version(4))
      expect(rolledBack.source).toBe("rollback")
      expect(rolledBack.changes).toHaveLength(1)
      expect(rolledBack.tools).toHaveLength(1)
      expect(rolledBack.guidance).toHaveLength(1)

      const reloaded = yield* harness.reload({ sessionID: created.id, baseVersion: version(4) })
      expect(reloaded.version).toBe(version(5))
      expect(reloaded.source).toBe("reload")
      expect(reloaded.changes).toHaveLength(1)
      expect(reloaded.tools).toHaveLength(1)
      expect(reloaded.guidance).toHaveLength(1)

      const staleRollback = yield* harness
        .rollback({ sessionID: created.id, baseVersion: version(4), version: version(1) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(staleRollback)).toBeTrue()
      expect((yield* harness.get(created.id)).snapshot?.version).toBe(version(5))
    }),
  )

  it.effect("applies a proposal carrying only guidance", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const harness = yield* SessionHarness.Service
      const created = yield* session.create({ location })

      // No `changes` key at all: standing instructions need no file change, and requiring one
      // rejected every guidance-only proposal the reviewer produced.
      const proposal = yield* harness.propose({
        sessionID: created.id,
        baseVersion: 1,
        summary: "Remind the agent to reuse the established baseline",
        guidance: [{ appliesTo: "src/mem.rs", directive: "Diff against the recorded baseline before editing." }],
      })
      yield* harness.status({ sessionID: created.id, proposalID: proposal.id, status: "approved" })

      const applied = yield* harness.apply({ sessionID: created.id, proposalID: proposal.id })
      expect(applied.version).toBe(version(2))
      expect(applied.changes).toHaveLength(0)
      expect(applied.guidance).toHaveLength(1)
      expect(applied.guidance?.[0]?.appliesTo).toBe("src/mem.rs")
    }),
  )

  it.effect("reserves the built-in Harness review tool name", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const harness = yield* SessionHarness.Service
      const created = yield* session.create({ location })

      const proposal = yield* harness
        .propose({
          sessionID: created.id,
          baseVersion: 1,
          summary: "Shadow the built-in review request",
          tools: [
            {
              name: "harness_review_request",
              description: "Not allowed to shadow the built-in review request.",
              readOnly: true,
              enabled: true,
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(proposal)).toBeTrue()
    }),
  )

  // Live clock: source validation runs the confined interpreter, which a TestClock never advances.
  it.live("rejects applying a tool whose source cannot parse in the confined runtime", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const harness = yield* SessionHarness.Service
      const created = yield* session.create({ location })

      const proposal = yield* harness.propose({
        sessionID: created.id,
        baseVersion: 1,
        summary: "Add a tool that imports a module",
        changes: [
          {
            path: RelativePath.make("tools/harness_broken.ts"),
            operation: "add",
            // CodeMode parses the source as a function body, so any import is a parse error.
            content: 'import { readFile } from "node:fs/promises"\nreturn input',
          },
        ],
        tools: [
          {
            name: "harness_broken",
            description: "A tool whose source cannot parse.",
            source: RelativePath.make("tools/harness_broken.ts"),
            readOnly: true,
            enabled: true,
          },
        ],
      })
      yield* harness.status({ sessionID: created.id, proposalID: proposal.id, status: "approved" })

      const applied = yield* harness.apply({ sessionID: created.id, proposalID: proposal.id }).pipe(Effect.exit)
      expect(Exit.isFailure(applied)).toBeTrue()
      // The broken tool must never reach the active snapshot.
      expect((yield* harness.get(created.id)).snapshot?.version).toBe(version(1))
    }),
  )

  // Live clock: harness tool execution is bounded by wall-clock timeouts, which a TestClock never advances.
  it.live("materializes enabled source-backed harness tools through the confined runtime", () =>
    Effect.gen(function* () {
      denyHarness = false
      const now = yield* DateTime.now
      const permission = yield* PermissionV2.Service
      const snapshot: SessionHarness.Snapshot = {
        version: version(1),
        status: "active",
        source: "proposal",
        changes: [
          {
            path: RelativePath.make("src/tools/harness_double.ts"),
            operation: "add",
            content: "return input.value * 2",
          },
        ],
        tools: [
          {
            name: "harness_double",
            description: "Double a numeric value.",
            source: RelativePath.make("src/tools/harness_double.ts"),
            readOnly: true,
            enabled: true,
          },
        ],
        validation: { status: "passed", errors: [], warnings: [] },
        timestamps: { created: now, updated: now },
      }
      const tools = SessionHarness.tools(snapshot, permission)
      const tool = tools.harness_double
      expect(tool).toBeDefined()
      const output = yield* Tool.settle(
        tool!,
        { type: "tool-call", id: "call-1", name: "harness_double", input: { value: 21 } },
        {
          sessionID: SessionV2.ID.make("ses_harness_tools"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_harness_tools"),
          toolCallID: "call-1",
        },
      )
      expect(output.structured).toBe(42)

      denyHarness = true
      const denied = yield* Tool.settle(
        tool!,
        { type: "tool-call", id: "call-denied", name: "harness_double", input: { value: 21 } },
        {
          sessionID: SessionV2.ID.make("ses_harness_tools"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_harness_tools"),
          toolCallID: "call-denied",
        },
      ).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBeTrue()
      denyHarness = false

      const timedTool = SessionHarness.tools(
        {
          ...snapshot,
          changes: [
            ...snapshot.changes,
            { path: RelativePath.make("src/tools/harness_timeout.ts"), operation: "add", content: "while (true) {}" },
          ],
          tools: [
            ...snapshot.tools,
            {
              name: "harness_timeout",
              description: "A bounded timeout fixture.",
              source: RelativePath.make("src/tools/harness_timeout.ts"),
              readOnly: true,
              enabled: true,
            },
          ],
        },
        permission,
      ).harness_timeout
      const timed = yield* Tool.settle(
        timedTool!,
        { type: "tool-call", id: "call-timeout", name: "harness_timeout", input: {} },
        {
          sessionID: SessionV2.ID.make("ses_harness_tools"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_harness_tools"),
          toolCallID: "call-timeout",
        },
      ).pipe(Effect.exit)
      expect(Exit.isFailure(timed)).toBeTrue()
    }),
  )
})
