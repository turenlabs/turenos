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

  it.effect("extracts the body of a bare apply_patch heredoc", () =>
    ShellToolRouting.patchHeredoc({
      command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\nPATCH",
      shell: "bash",
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => expect(result).toBe("*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch")),
      ),
      Effect.asVoid,
    ),
  )

  it.effect("strips leading tabs for an indented <<- heredoc", () =>
    ShellToolRouting.patchHeredoc({
      command: "apply_patch <<-EOF\n\t*** Begin Patch\n\t*** End Patch\n\tEOF",
      shell: "bash",
    }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toBe("*** Begin Patch\n*** End Patch"))),
      Effect.asVoid,
    ),
  )

  it.effect("refuses apply_patch invocations that are not a lone heredoc", () =>
    Effect.gen(function* () {
      for (const command of [
        "cd subdir && apply_patch <<EOF\nx\nEOF",
        "apply_patch <<EOF\nx\nEOF && echo done",
        "apply_patch --check <<EOF\nx\nEOF",
        "cat <<EOF | apply_patch\nx\nEOF",
        "apply_patch",
      ]) {
        const result = yield* ShellToolRouting.patchHeredoc({ command, shell: "bash" })
        expect(result).toBeUndefined()
      }
    }),
  )
})
