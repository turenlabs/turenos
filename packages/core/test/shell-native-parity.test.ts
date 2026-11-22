import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { ShellNative } from "@turenlabs/core/shell-native"
import { ShellSafety } from "@turenlabs/core/shell-safety"
import type { Node } from "@turenlabs/core/shell-tree"

const library = fileURLToPath(new URL(`../../forge/dist/node/${ShellNative.libraryName}`, import.meta.url))
const parts = ["word", "λ", "😀", "\t", "\n", "'", '"', "\u0000", "\ud800", "\udc00", "\ufeff", "a b"]
const forms = {
  bash: [
    (text: string) => `git status "${text}"`,
    (text: string) => `cat <<'EOF'\n${text}\nEOF\ngit diff`,
    (text: string) => `((3 + ${text})) | cat`,
    (text: string) => `for i in a b; do printf "%s" "${text}"; done`,
  ],
  powershell: [
    (text: string) => `Get-ChildItem "./${text}"`,
    (text: string) => `$text = @'\n${text}\n'@\nWrite-Output $text`,
    (text: string) => `Write-Output "$(Write-Output "${text}")"`,
    (text: string) => `Write-Output '${text}' | Out-String`,
  ],
}

const shape = (node: Node): unknown => [
  node.type,
  node.startIndex,
  node.endIndex,
  node.hasError,
  node.isMissing,
  node.text,
  node.parent?.type,
  node.children.map((child) => child && shape(child)),
]

test.skipIf(!(await Bun.file(library).exists()))(
  "compares packed and WASM shell trees and descendant queries",
  async () => {
    const native = await ShellNative.open(library)
    if (!native) throw new Error("The staged native shell parser failed to load")
    for (const shell of ["bash", "powershell"] as const) {
      const commands = [
        "",
        "git status --short",
        "git diff --stat | head",
        ...forms[shell].flatMap((form) => parts.flatMap((left) => parts.map((right) => form(left + right)))),
      ]
      for (const command of commands) {
        const wasm = await Effect.runPromise(ShellSafety.parse({ command, shell }))
        try {
          const candidate = native.parse(command, shell)
          if (!candidate) throw new Error("Native shell parser rejected the parity fixture")
          expect(shape(candidate.rootNode), JSON.stringify({ shell, command })).toEqual(shape(wasm.rootNode))
          for (const kind of ["command", "ERROR", "file_redirect", "heredoc_end"]) {
            expect(candidate.rootNode.descendantsOfType(kind).map((node) => node && shape(node))).toEqual(
              wasm.rootNode.descendantsOfType(kind).map((node) => node && shape(node)),
            )
          }
          candidate.delete()
        } finally {
          wasm.delete()
        }
      }
    }
    expect(native.parse(" ".repeat(65_537), "bash")).toBeUndefined()
  },
)

test("returns the portable fallback when the native library is unavailable", async () => {
  expect(await ShellNative.open(library + ".missing")).toBeUndefined()
})
