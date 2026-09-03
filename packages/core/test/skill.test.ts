import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "../src/effect/layer-node"
import { AbsolutePath } from "../src/schema"
import { SkillV2 } from "../src/skill"
import { testEffect } from "./lib/effect"
import { ExtensionRuntime } from "../src/extension"
import { Extension } from "@turenlabs/schema"

const it = testEffect(LayerNode.compile(SkillV2.node))

const manifest = new Extension.Manifest({
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
      source: { type: "catalog", content: "Report evidence-supported findings only." },
      requires: ["read"],
    },
  ],
})

const catalog = testEffect(
  LayerNode.compile(SkillV2.node, [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, {
        enabled: () => Effect.succeed(true),
        manifests: () => Effect.succeed([manifest]),
      }),
    ],
  ]),
)

describe("SkillV2", () => {
  it.effect("lists only embedded catalog-owned sources", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* skill.transform((draft) =>
        draft.source(
          SkillV2.EmbeddedSource.make({
            type: "embedded",
            skill: SkillV2.Info.make({
              name: "catalog-skill",
              description: "Catalog-owned skill",
              location: AbsolutePath.make("/builtin/catalog-skill.md"),
              content: "Use the catalog.",
            }),
          }),
        ),
      )

      expect(yield* skill.list()).toEqual([
        expect.objectContaining({ name: "catalog-skill", location: "/builtin/catalog-skill.md" }),
      ])
    }),
  )

  catalog.effect("lists enabled prompt-only Extension skills without a downloaded directory", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      expect(yield* skill.list()).toEqual([
        expect.objectContaining({
          name: "evidence-triage",
          description: "Triage supplied evidence",
          content: "Report evidence-supported findings only.",
        }),
      ])
      expect((yield* skill.list())[0]?.location).toContain("extension-skills/community/evidence-triage")
    }),
  )
})
