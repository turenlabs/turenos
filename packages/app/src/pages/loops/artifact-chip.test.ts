import { describe, expect, test } from "bun:test"
import { artifactLabel, artifactTarget } from "./artifact-chip"
import type { LoopArtifact } from "./artifact-chip"

describe("artifact chip helpers", () => {
  test("uses a file URI as the viewer target and prefers its name", () => {
    const artifact: LoopArtifact = { type: "file", uri: "reports/result.json", mime: "application/json", name: "result.json" }
    expect(artifactTarget(artifact)).toBe("reports/result.json")
    expect(artifactLabel(artifact)).toBe("result.json")
  })

  test("falls back to the URI when a file has no display name", () => {
    const artifact: LoopArtifact = { type: "file", uri: "reports/result.json", mime: "application/json" }
    expect(artifactLabel(artifact)).toBe("reports/result.json")
  })

  test("uses output paths directly", () => {
    const artifact: LoopArtifact = { type: "changed", path: "reports/result.json" }
    expect(artifactTarget(artifact)).toBe("reports/result.json")
    expect(artifactLabel(artifact)).toBe("reports/result.json")
  })
})
