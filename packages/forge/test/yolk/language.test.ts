import { expect, test } from "bun:test"
import {
  Language,
  detectLanguage,
  lexLanguage,
  shouldSkipIndexDir,
  shouldSkipIndexPath,
  supportedLanguages,
} from "@turenlabs/core/yolk"

test("registry contains the ranked top ten languages", () => {
  const support = supportedLanguages()
  expect(support).toHaveLength(10)
  expect(support.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(new Set(support.map((item) => item.language)).size).toBe(10)
})

test("language detection handles extensions and shell shebangs", () => {
  expect(detectLanguage("component.tsx")).toBe(Language.TypeScript)
  expect(detectLanguage("model.py")).toBe(Language.Python)
  expect(detectLanguage("header.hpp")).toBe(Language.CPP)
  expect(detectLanguage("script", "#!/usr/bin/env bash\necho ok\n")).toBe(Language.Shell)
})

test("managed Forge and worktree directories are excluded from indexing", () => {
  expect([".batou", ".case", ".forge", ".turbo", ".worktrees"].every(shouldSkipIndexDir)).toBe(true)
  expect(shouldSkipIndexDir("generated-effect")).toBe(true)
  expect(shouldSkipIndexDir("packages")).toBe(false)
  expect(shouldSkipIndexDir("Storybook-Static")).toBe(true)
  expect(shouldSkipIndexDir("NODE_MODULES")).toBe(true)
  expect(shouldSkipIndexDir(".perf")).toBe(true)
  expect(["generated.ts", "client.generated.ts", "schema.gen.ts", "api_generated.go"].every(shouldSkipIndexPath)).toBe(
    true,
  )
})

test("lexer preserves C++ preprocessor tokens and accepts Python triple strings", () => {
  expect(() => lexLanguage('# comment\ndef f(x):\n    s = """hello\nworld"""\n', Language.Python)).not.toThrow()
  const cpp = lexLanguage("#include <string>\n// comment\nbool f() { return true; }\n", Language.CPP)
  expect(cpp.some((token) => token.text === "include")).toBe(true)
})

test("ECMAScript regex literals do not consume following class methods", () => {
  const tokens = lexLanguage(
    'globalThis.Go = class { protect(text) { return text.replace(/"/g, "&quot;") } }',
    Language.JavaScript,
  )
  expect(tokens.some((token) => token.text === '/"/g')).toBe(true)
  expect(tokens.some((token) => token.text === "protect")).toBe(true)
})

test("ECMAScript JSX apostrophes and nested templates remain lexable", () => {
  expect(() =>
    lexLanguage(
      "<p>The session's result</p>\nconst output = `value ${items.map((item) => `${item.id}: ${item.value}`)}`\n",
      Language.TypeScript,
    ),
  ).not.toThrow()
  expect(() => lexLanguage("const escaped = `'${value.replace(/'/g, `\"'\"'`)}'`\n", Language.TypeScript)).not.toThrow()
  expect(() =>
    lexLanguage("const value = `${Math.floor(index / 100)}/${text.replace(/\"/g, '\\\"')}`\n", Language.TypeScript),
  ).not.toThrow()
  expect(() => lexLanguage("cat <<EOF\nDon't modify shell files\nEOF\n", Language.Shell)).not.toThrow()
  expect(() => lexLanguage("export function value() { return foo'bar }\n", Language.TypeScript)).toThrow(
    "unterminated string",
  )
  expect(() => lexLanguage("echo foo'bar\n", Language.Shell)).toThrow("unterminated string")
})
