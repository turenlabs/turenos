import { describe, expect } from "bun:test"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { testEffect } from "../lib/effect"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Extension } from "@turenlabs/schema"

function skillLayer(enabled: boolean) {
  return LayerNode.compile(Skill.node, [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, {
        enabled: () => Effect.succeed(enabled),
        manifests: () => Effect.succeed([ExtensionCatalog.get("turenlabs/customize-forge")!]),
      }),
    ],
  ])
}

const active = testEffect(skillLayer(true))
const inactive = testEffect(skillLayer(false))

const catalogManifest = new Extension.Manifest({
  schemaVersion: 1,
  id: Extension.ID.make("community", "evidence-triage"),
  name: "Evidence Triage",
  description: "Triage supplied evidence",
  version: "1.0.0",
  publisher: "Community",
  trust: "community",
  contributions: [
    {
      type: "skill",
      id: Extension.ContributionID.make("evidence-triage"),
      name: "Evidence Triage",
      description: "Triage supplied evidence",
      instructions: "Use defensively.",
      adapter: "skill:evidence-triage",
      secrets: [],
      defaultEnabled: false,
      source: { type: "catalog", content: "Report only evidence-supported findings." },
      requires: ["read"],
    },
  ],
})

const catalog = testEffect(
  LayerNode.compile(Skill.node, [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, {
        enabled: () => Effect.succeed(true),
        manifests: () => Effect.succeed([catalogManifest]),
      }),
    ],
  ]),
)

describe("Extension-managed skills", () => {
  active.instance("projects an enabled catalog skill", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const skills = yield* skill.all()

      expect(skills).toEqual([
        expect.objectContaining({
          name: "customize-forge",
          location: "<built-in>",
        }),
      ])
      expect(yield* skill.get("customize-forge")).toEqual(skills[0])
      expect(yield* skill.dirs()).toEqual([])
    }),
  )

  catalog.instance("projects downloaded prompt content without filesystem authority", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      expect(yield* skill.all()).toEqual([
        {
          name: "evidence-triage",
          description: "Triage supplied evidence",
          location: "<extension:community/evidence-triage>",
          content: "Report only evidence-supported findings.",
        },
      ])
      expect(yield* skill.dirs()).toEqual([])
    }),
  )

  inactive.instance("does not discover skills outside enabled Extensions", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      expect(yield* skill.all()).toEqual([])
      expect(yield* skill.dirs()).toEqual([])
    }),
  )

  inactive.instance("reports a typed error when a skill is unavailable", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const error = yield* Effect.flip(skill.require("missing-skill"))

      expect(error).toBeInstanceOf(Skill.NotFoundError)
      expect(error).toMatchObject({ _tag: "Skill.NotFoundError", name: "missing-skill", available: [] })
      expect(error.message).toContain('Skill "missing-skill" not found.')
    }),
  )

  active.instance("applies agent permission policy to the Extension projection", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const denied = yield* skill.available({
        name: "build",
        mode: "primary",
        permission: [{ permission: "skill", pattern: "customize-forge", action: "deny" }],
        options: {},
      })

      expect(denied).toEqual([])
    }),
  )

  active.instance("formats public skill metadata without exposing a filesystem authority", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const output = Skill.fmt(yield* skill.all(), { verbose: true })

      expect(output).toContain("<name>customize-forge</name>")
      expect(output).toContain("<location>&lt;built-in&gt;</location>")
      expect(output).not.toContain("file://")
    }),
  )
})
