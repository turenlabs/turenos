import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@turenlabs/core/tool/tool"

test("tool schemas flatten independent bounds without dropping repeated constraints or metadata", () => {
  const example = { type: "array", allOf: [{ maxItems: 2 }], items: { type: "string" } }
  const tool = Tool.make({
    description: "Schema contract",
    input: Schema.Struct({
      rows: Schema.Array(
        Schema.Struct({
          claim: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(2000))),
        }),
      ).pipe(Schema.check(Schema.isMaxLength(24))),
      pattern: Schema.String.pipe(Schema.check(Schema.isPattern(/^a/), Schema.isPattern(/z$/))),
    }).annotate({ examples: [{ rows: [], pattern: "az", ...example }] }),
    output: Schema.Void,
    execute: () => Effect.void,
  })
  expect(Tool.definition("contract", tool).inputSchema).toMatchObject({
    examples: [{ rows: [], pattern: "az", ...example }],
    properties: {
      rows: {
        type: "array",
        maxItems: 24,
        items: {
          required: ["claim"],
          properties: { claim: { type: "string", minLength: 1, maxLength: 2000 } },
        },
      },
      pattern: { type: "string", allOf: [{ pattern: "^a" }, { pattern: "z$" }] },
    },
  })
})
