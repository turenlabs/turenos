export * as CatalogAgentFixture from "./catalog-agent"

import { ExtensionRuntime } from "@turenlabs/core/extension"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Extension } from "@turenlabs/schema"
import { Effect, Layer } from "effect"

const contribution = Extension.Skill.make({
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
})

const manifest = new Extension.Manifest({
  schemaVersion: 1,
  id: Extension.ID.make("community", "vulnerability-analyst"),
  name: "Vulnerability Analyst",
  description: "Read-only vulnerability analysis",
  version: "1.0.0",
  publisher: "Community",
  trust: "community",
  contributions: [contribution],
})

export const extensions = Layer.mock(ExtensionRuntime.Service, {
  enabled: () => Effect.succeed(true),
  manifests: () => Effect.succeed([manifest, ExtensionCatalog.get("turenlabs/nvd")!]),
  enabledSkills: () => Effect.succeed([{ manifest, contribution }]),
})
