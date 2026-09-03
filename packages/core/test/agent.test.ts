import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AgentPlugin } from "@turenlabs/core/plugin/agent"
import { AbsolutePath } from "@turenlabs/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { LayerNode } from "@turenlabs/core/effect/layer-node"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

const subagentManifest = new Extension.Manifest({
  schemaVersion: 1,
  id: Extension.ID.make("community", "vulnerability-analyst"),
  name: "Vulnerability Analyst",
  description: "Read-only vulnerability analysis",
  version: "1.0.0",
  publisher: "Community",
  trust: "community",
  contributions: [
    {
      type: "skill",
      id: Extension.ContributionID.make("vulnerability-analyst"),
      name: "Vulnerability Analyst",
      description: "Correlate vulnerability evidence",
      instructions: "Use defensively.",
      adapter: "skill:vulnerability-analyst",
      secrets: [],
      defaultEnabled: false,
      source: { type: "catalog", content: "Correlate supplied vulnerability evidence." },
      requires: ["nvd_cve_detail"],
      agent: { profile: "data", steps: 10 },
    },
  ],
})

const catalogIt = testEffect(
  LayerNode.compile(AgentV2.node, [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, {
        enabled: () => Effect.succeed(true),
        manifests: () => Effect.succeed([subagentManifest, ExtensionCatalog.get("turenlabs/nvd")!]),
      }),
    ],
  ]),
)

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  catalogIt.effect("projects fixed-profile catalog subagents without write or shell authority", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const agent = yield* agents.get(AgentV2.ID.make("vulnerability-analyst"))

      expect(agent).toMatchObject({
        mode: "subagent",
        hidden: false,
        steps: 10,
        system: "Correlate supplied vulnerability evidence.",
      })
      expect(PermissionV2.evaluate("nvd_cve_detail", "CVE-2026-1", agent?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("read", "src/index.ts", agent?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("read", ".env", agent?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("bash", "rm -rf .", agent?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("edit", "src/index.ts", agent?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("board_read", "*", agent?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("board_post", "finding", agent?.permissions ?? []).effect).toBe("allow")
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("ships bounded specialist agents and reserves shell access for qualification", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "adversarial-review",
        "build",
        "compaction",
        "explore",
        "general",
        "harness-reviewer",
        "lobby",
        "plan",
        "qualification",
        "research",
        "summary",
        "title",
        "worker",
      ])
      agents
        .filter((item) => item.id !== AgentV2.ID.make("qualification"))
        .forEach((item) =>
          expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false),
        )
      const get = (id: string) => {
        const value = agents.find((item) => item.id === AgentV2.ID.make(id))
        if (!value) throw new Error(`Missing built-in agent: ${id}`)
        return value
      }
      const permission = (id: string, action: string) => PermissionV2.evaluate(action, "*", get(id).permissions).effect

      expect(permission("explore", "read")).toBe("allow")
      expect(permission("explore", "edit")).toBe("deny")
      expect(permission("explore", "websearch")).toBe("deny")
      expect(permission("explore", "memory.read")).toBe("allow")
      expect(permission("explore", "memory.write")).toBe("deny")
      expect(permission("worker", "read")).toBe("allow")
      expect(permission("worker", "edit")).toBe("allow")
      expect(permission("worker", "bash")).toBe("deny")
      expect(permission("worker", "memory.read")).toBe("allow")
      expect(permission("adversarial-review", "edit")).toBe("deny")
      expect(permission("adversarial-review", "spawn_agent")).toBe("deny")
      expect(permission("adversarial-review", "memory.read")).toBe("allow")
      agents
        .filter((item) => item.mode === "subagent")
        .forEach((item) => {
          expect(PermissionV2.evaluate("board_read", "*", item.permissions).effect).toBe("allow")
          expect(PermissionV2.evaluate("board_post", "finding", item.permissions).effect).toBe("allow")
        })
      expect(permission("qualification", "bash")).toBe("allow")
      expect(permission("qualification", "read")).toBe("deny")
      expect(permission("research", "websearch")).toBe("allow")
      expect(permission("research", "webfetch")).toBe("allow")
      expect(permission("research", "edit")).toBe("deny")
      expect(permission("research", "memory.read")).toBe("allow")
      expect(permission("plan", "dynamic_mcp")).toBe("deny")
      expect(permission("plan", "semgrep-hosted_semgrep_scan")).toBe("deny")
      expect(permission("plan", "notion_notion-update-page")).toBe("deny")
      expect(permission("plan", "notion_notion-search")).toBe("allow")
      expect(permission("build", "notion_notion-update-page")).toBe("ask")
      expect(permission("build", "dynamic_mcp")).toBe("ask")
      expect(permission("build", "semgrep-hosted_semgrep_scan")).toBe("ask")

      expect(get("adversarial-review").system).toContain("data loss")
      expect(get("adversarial-review").system).toContain("crash recovery")
      expect(get("adversarial-review").system).toContain("stated requested outcomes and constraints")
      expect(get("adversarial-review").system).toContain("changed regions or bounded diff")
      expect(get("adversarial-review").system).toContain("highest-risk regions first")
      expect(get("adversarial-review").system).toContain("do not report style")
      expect(get("adversarial-review").system).toContain("Do not turn a bounded review into a repository-wide audit")
      expect(get("adversarial-review").system).toContain("Return at most three findings")
      expect(get("qualification").system).toContain("exact complete verification commands")
      expect(get("worker").system).toContain("write roots granted to this task")
      expect(get("worker").system).toContain("judge the implementation from the changed code")
      expect(get("worker").system).toContain("highest-risk changed regions")
      expect(get("worker").system).toContain("symbols or regions changed")
      expect(get("research").system).toContain("primary sources")
      expect(get("lobby").system).toContain("untrusted public input")
      expect(get("lobby").system).toContain("Only your final plain-text response is published")
      expect(get("lobby").system).toContain("lobby_room_context")
      expect(get("lobby").tools).toBeUndefined()
      expect(get("compaction").tools).toBe(false)
      expect(get("title").tools).toBe(false)
      expect(get("summary").tools).toBe(false)
      expect(permission("lobby", "read")).toBe("allow")
      expect(permission("lobby", "bash")).toBe("allow")
      expect(permission("lobby", "dynamic_mcp")).toBe("ask")
    }),
  )
})
