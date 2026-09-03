import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ProviderPrompt } from "@turenlabs/core/session/provider-prompt"

/**
 * Asserts selection against the prompt files that actually ship, read from disk here rather than
 * re-imported through the same module under test. A test that compared `forModel(...)` to its own
 * inlined string would keep passing if the shipped file were emptied, renamed, or dropped from the
 * package; comparing to `fs.readFileSync` of the real path cannot.
 */
const PROMPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/session/provider-prompt")

const shipped = (name: string) => {
  const file = path.join(PROMPT_DIR, `${name}.txt`)
  const text = fs.readFileSync(file, "utf8")
  if (text.trim().length === 0) throw new Error(`Shipped provider prompt ${file} is empty`)
  return text
}

describe("ProviderPrompt.forModel", () => {
  // Wire ids as providers actually spell them, not synthetic ones.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["claude-sonnet-4-5-20250929", "anthropic"],
    ["claude-opus-4-1-20250805", "anthropic"],
    ["anthropic.claude-3-7-sonnet-20250219-v1:0", "anthropic"],
    ["gpt-5-codex", "codex"],
    ["gpt-5.1-codex-max", "codex"],
    ["gpt-5", "gpt"],
    ["gpt-5-mini", "gpt"],
    ["gpt-4o", "beast"],
    ["gpt-4.1", "beast"],
    ["o1-preview", "beast"],
    ["o3-mini", "beast"],
    ["gemini-2.5-pro", "gemini"],
    ["gemini-3-pro-preview", "gemini"],
    ["muse-spark-1", "meta"],
    ["Trinity-Large", "trinity"],
    ["kimi-k2-thinking", "kimi"],
  ]

  for (const [modelID, file] of cases) {
    test(`${modelID} resolves to ${file}.txt`, () => {
      expect(ProviderPrompt.forModel(modelID)).toBe(shipped(file))
    })
  }

  test("a provider with no specific prompt falls back to default.txt", () => {
    const fallback = shipped("default")
    for (const modelID of ["grok-4", "llama-3.3-70b-instruct", "mistral-large-latest", "deepseek-chat", ""]) {
      expect(ProviderPrompt.forModel(modelID)).toBe(fallback)
    }
    expect(ProviderPrompt.fallback).toBe(fallback)
  })

  test("narrower rules win over the rules that would otherwise shadow them", () => {
    // `gpt-5-codex` contains "gpt", and `gpt-4` reasoning ids contain "gpt" too. Both must beat the
    // general gpt prompt, and they must not collide with each other.
    expect(ProviderPrompt.forModel("gpt-5-codex")).not.toBe(ProviderPrompt.forModel("gpt-5"))
    expect(ProviderPrompt.forModel("gpt-4o")).not.toBe(ProviderPrompt.forModel("gpt-5"))
    expect(ProviderPrompt.forModel("gpt-5-codex")).not.toBe(ProviderPrompt.forModel("gpt-4o"))
  })

  test("every shipped prompt file is reachable from some model id", () => {
    const shippedFiles = fs
      .readdirSync(PROMPT_DIR)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => name.slice(0, -".txt".length))
      .sort()
    const reachable = new Set(
      [...cases.map(([modelID]) => modelID), "grok-4"].map((modelID) => ProviderPrompt.forModel(modelID)),
    )
    expect(shippedFiles.length).toBeGreaterThan(0)
    for (const name of shippedFiles) {
      expect({ name, reachable: reachable.has(shipped(name)) }).toEqual({ name, reachable: true })
    }
  })

  test("selection never returns empty text", () => {
    for (const modelID of ["claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro", "unknown-model", ""]) {
      expect(ProviderPrompt.forModel(modelID).length).toBeGreaterThan(0)
    }
  })
})
