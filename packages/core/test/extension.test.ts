import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import { Effect, Exit } from "effect"
import { Storage } from "@turenlabs/core/storage"
import { testEffect } from "./lib/effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionCatalog } from "@turenlabs/extensions"

const hosted = (version = "1.0.0") =>
  new Extension.Manifest({
    schemaVersion: 1,
    id: Extension.ID.make("community", "hosted-search"),
    name: "Hosted Search",
    description: "Search a hosted service",
    version,
    publisher: "Community",
    trust: "community",
    contributions: [
      {
        type: "mcp",
        id: Extension.ContributionID.make("hosted-search"),
        name: "Hosted Search",
        description: "Search a hosted service",
        instructions: "Keep usage read-only.",
        adapter: "mcp:hosted-search",
        secrets: [],
        defaultEnabled: false,
        upstreamPolicy: "static",
        deployment: { type: "hosted", url: "https://mcp.example.test/mcp" },
        authentication: "none",
        localOnly: false,
        mcpContext: { maxLoadedTools: 2, unloadAfterIdleTurns: 3 },
        tools: { allow: ["search"], write: [] },
      },
    ],
  })

const catalogSkill = (version = "1.0.0", profile: Extension.SkillAgentProfile = "read") =>
  new Extension.Manifest({
    schemaVersion: 1,
    id: Extension.ID.make("community", "incident-responder"),
    name: "Incident Responder",
    description: "Read-only incident response subagent",
    version,
    publisher: "Community",
    trust: "community",
    contributions: [
      {
        type: "skill",
        id: Extension.ContributionID.make("incident-responder"),
        name: "Incident Responder",
        description: "Review supplied incident evidence",
        instructions: "Use for defensive incident analysis.",
        adapter: "skill:incident-responder",
        secrets: [],
        defaultEnabled: false,
        source: { type: "catalog", content: `Review incident evidence safely. Version ${version}.` },
        requires: ["read", "grep"],
        agent: { profile, steps: 8 },
      },
    ],
  })

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ExtensionRuntime.node, Storage.node])))

describe("ExtensionRuntime", () => {
  it.effect("uses manifest defaults and persists fail-forward activation", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const skill = Extension.ID.make("turenlabs", "customize-forge")
      const notion = Extension.ID.make("turenlabs", "notion")

      expect(yield* extensions.enabled(skill)).toBe(true)
      expect(yield* extensions.enabled(notion)).toBe(false)
      yield* extensions.update(skill, { enabled: false })
      yield* extensions.update(notion, { enabled: true }, { local: true })
      expect(yield* extensions.enabled(skill)).toBe(false)
      expect(yield* extensions.enabled(notion)).toBe(true)
    }),
  )

  it.effect("atomically stores only declared non-secret configuration", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const pagerduty = Extension.ID.make("turenlabs", "pagerduty")
      const first = yield* extensions.update(
        pagerduty,
        {
          enabled: true,
          configuration: { clientId: "forge-test" },
          secrets: { PAGERDUTY_CLIENT_SECRET: "secret" },
        },
        { local: true },
      )
      const retry = yield* extensions.update(
        pagerduty,
        {
          enabled: true,
          configuration: { clientId: "forge-test" },
          secrets: { PAGERDUTY_CLIENT_SECRET: "secret" },
        },
        { local: true },
      )
      expect(first.changed).toBe(true)
      expect(retry).toMatchObject({ changed: false, desired: { revision: first.desired.revision } })
      expect(yield* extensions.configuration(pagerduty)).toEqual({ clientId: "forge-test" })
    }),
  )

  it.effect("rejects undeclared configuration and local-only activation without admission", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const notion = Extension.ID.make("turenlabs", "notion")
      const onePassword = Extension.ID.make("turenlabs", "onepassword")
      expect(
        Exit.isFailure(
          yield* extensions
            .update(notion, { enabled: true, configuration: { endpoint: "https://internal.example" } })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* extensions.update(onePassword, { enabled: true }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* extensions.update(onePassword, { enabled: false }).pipe(Effect.exit))).toBe(true)
      const pagerduty = Extension.ID.make("turenlabs", "pagerduty")
      expect(
        Exit.isFailure(
          yield* extensions
            .update(pagerduty, { enabled: false, configuration: { clientId: "remote-client" } })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* extensions
            .update(pagerduty, { enabled: false, secrets: { PAGERDUTY_CLIENT_SECRET: "remote-secret" } })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isSuccess(yield* extensions.update(onePassword, { enabled: true }, { local: true }).pipe(Effect.exit)),
      ).toBe(true)
    }),
  )

  it.effect("rejects activation for unknown catalog ids", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      expect(Exit.isFailure(yield* extensions.update("community/unknown", { enabled: true }).pipe(Effect.exit))).toBe(
        true,
      )
    }),
  )

  it.effect("installs and updates generic hosted MCP manifests durably", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const manifest = hosted()
      const installed = yield* extensions.update(manifest.id, { enabled: true, manifest })

      expect(installed).toMatchObject({ changed: true, desired: { enabled: true, revision: 1 } })
      expect(yield* extensions.get(manifest.id)).toEqual(manifest)
      expect((yield* extensions.manifests()).map((item) => item.id)).toContain(manifest.id)
      expect(yield* extensions.enabled(manifest.id)).toBe(true)

      const next = hosted("1.1.0")
      expect((yield* extensions.update(next.id, { enabled: true, manifest: next })).desired.revision).toBe(2)
      expect((yield* extensions.get(next.id))?.version).toBe("1.1.0")

      const contribution = hosted().contributions[0]!
      if (contribution.type !== "mcp") throw new Error("Expected hosted MCP fixture")
      const moved = new Extension.Manifest({
        ...hosted("1.2.0"),
        contributions: [
          {
            ...contribution,
            deployment: { type: "hosted", url: "https://attacker.example.test/mcp" },
          },
        ],
      })
      expect(
        Exit.isFailure(yield* extensions.update(moved.id, { enabled: true, manifest: moved }).pipe(Effect.exit)),
      ).toBe(true)
    }),
  )

  it.effect("installs prompt-only skills and preserves subagent authority across updates", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const manifest = catalogSkill()
      const installed = yield* extensions.update(manifest.id, { enabled: true, manifest })

      expect(installed).toMatchObject({ changed: true, desired: { enabled: true, revision: 1 } })
      expect(
        (yield* ExtensionRuntime.enabledSkills(extensions)).find((item) => item.manifest.id === manifest.id),
      ).toEqual(
        expect.objectContaining({
          manifest: expect.objectContaining({ id: manifest.id }),
          contribution: expect.objectContaining({ id: "incident-responder", agent: { profile: "read", steps: 8 } }),
        }),
      )

      const updated = catalogSkill("1.1.0")
      expect((yield* extensions.update(updated.id, { enabled: true, manifest: updated })).desired.revision).toBe(2)
      expect((yield* extensions.get(updated.id))?.version).toBe("1.1.0")

      const escalated = catalogSkill("1.2.0", "data")
      expect(
        Exit.isFailure(
          yield* extensions.update(escalated.id, { enabled: true, manifest: escalated }).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.effect("rejects dynamic local adapters, collisions, and version rewrites", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const manifest = hosted()
      yield* extensions.update(manifest.id, { enabled: false, manifest })

      const rewritten = new Extension.Manifest({ ...manifest, name: "Rewritten" })
      expect(
        Exit.isFailure(
          yield* extensions.update(manifest.id, { enabled: false, manifest: rewritten }).pipe(Effect.exit),
        ),
      ).toBe(true)

      const collision = new Extension.Manifest({
        ...hosted("1.1.0"),
        id: Extension.ID.make("community", "collision"),
        contributions: [
          { ...hosted().contributions[0]!, adapter: ExtensionCatalog.manifests[0]!.contributions[0]!.adapter },
        ],
      })
      expect(
        Exit.isFailure(
          yield* extensions.update(collision.id, { enabled: false, manifest: collision }).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.effect("stores manifest-declared adapter secrets only as vault envelopes", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const storage = yield* Storage.Service
      const exa = Extension.ID.make("turenlabs", "websearch-exa")
      yield* extensions.update(exa, { enabled: true, secrets: { EXA_API_KEY: "exa-secret-canary" } })

      expect(yield* extensions.secret(exa, "EXA_API_KEY")).toBe("exa-secret-canary")
      expect(yield* extensions.secretsSet(exa)).toEqual({ EXA_API_KEY: true })
      const stored = yield* storage.get({
        scope: Storage.Scope.make(`internal/extensions/${exa}`),
        key: Storage.Key.make("secret/EXA_API_KEY"),
      })
      expect(stored?.value).toStartWith("forge-secret:v1:")
      expect(stored?.value).not.toContain("exa-secret-canary")
    }),
  )

  it.effect("stores PagerDuty client registration without placing its secret in configuration", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const storage = yield* Storage.Service
      const pagerduty = Extension.ID.make("turenlabs", "pagerduty")
      yield* extensions.update(
        pagerduty,
        {
          enabled: true,
          configuration: { clientId: "pagerduty-client" },
          secrets: { PAGERDUTY_CLIENT_SECRET: "pagerduty-secret-canary" },
        },
        { local: true },
      )

      expect(yield* extensions.configuration(pagerduty)).toEqual({ clientId: "pagerduty-client" })
      expect(yield* extensions.secret(pagerduty, "PAGERDUTY_CLIENT_SECRET")).toBe("pagerduty-secret-canary")
      const stored = yield* storage.get({
        scope: Storage.Scope.make(`internal/extensions/${pagerduty}`),
        key: Storage.Key.make("secret/PAGERDUTY_CLIENT_SECRET"),
      })
      expect(stored?.value).toStartWith("forge-secret:v1:")
      expect(stored?.value).not.toContain("pagerduty-secret-canary")
    }),
  )
})
