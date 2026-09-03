import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ShellToolRouting } from "@turenlabs/core/shell-tool-routing"
import { testEffect } from "./lib/effect"

const Case = Schema.Struct({
  id: Schema.String,
  shell: Schema.Literals(["bash", "powershell", "cmd"]),
  command: Schema.String,
  expected: Schema.Literals(["allow", "grep", "glob", "edit", "apply_patch"]),
})
const cases = Schema.decodeUnknownSync(Schema.Array(Case))(
  await Bun.file(new URL("./fixtures/tool-routing.json", import.meta.url)).json(),
)
const it = testEffect(Layer.empty)

describe("ShellToolRouting", () => {
  for (const fixture of cases) {
    it.effect(fixture.id, () =>
      ShellToolRouting.inspect({ command: fixture.command, cwd: process.cwd(), shell: fixture.shell }).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result?.tool ?? "allow").toBe(fixture.expected))),
        Effect.asVoid,
      ),
    )
  }

  it.effect("explains the specialized retry without executing shell", () =>
    Effect.sync(() => {
      expect(ShellToolRouting.blockedMessage({ tool: "grep", reason: "workspace-search" })).toContain(
        "Use the grep tool instead",
      )
      expect(ShellToolRouting.blockedMessage({ tool: "edit", reason: "workspace-mutation" })).toContain("apply_patch")
    }),
  )

  it.effect("does not mistake stderr duplication for a workspace write", () =>
    ShellToolRouting.inspect({ command: "echo stderr >&2", cwd: process.cwd(), shell: "bash" }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toBeUndefined())),
      Effect.asVoid,
    ),
  )
})
