import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Artifact } from "../src/artifact"

describe("Artifact", () => {
  test("round trips a clickable generated artifact", () => {
    const artifact = { uri: "artifact://session/output.csv", mime: "text/csv", name: "output.csv" }

    expect(Schema.decodeUnknownSync(Artifact.Info)(artifact)).toEqual(artifact)
    expect(Schema.encodeSync(Artifact.Info)(artifact)).toEqual(artifact)
  })

  test("keeps the display name optional", () => {
    expect(Schema.decodeUnknownSync(Artifact.Info)({ uri: "artifact://session/output", mime: "text/plain" })).toEqual({
      uri: "artifact://session/output",
      mime: "text/plain",
    })
  })
})
