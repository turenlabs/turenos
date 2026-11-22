import { expect, test } from "bun:test"
import remend from "remend"
import { createMarkdownLinkRepair } from "./markdown-link-repair"

const { instance } = await WebAssembly.instantiate(
  await Bun.file(new URL("./markdown-links.wasm", import.meta.url)).arrayBuffer(),
)
const repair = createMarkdownLinkRepair(instance)
const options = { linkMode: "text-only" } as const

test("matches Remend at each streaming prefix of links, images, and code", () => {
  const input = [
    "- [complete](/guide)\n- 🌍 [pending](/draft",
    "[keep<unfinished]",
    "![complete](/image)[first\n[second\n",
    "- `[code](/path)` [label [nested]](/path",
    "```\n[code\n``` [label",
    "\\`[open [nested",
    "[caption](/broken [nested](/valid)",
    "[first [second](/path\nother) [third",
    "- >25 [docs](/path)\n- [unfinished",
    "[ref]:/path\n\n[ref]",
    "🌍 **title** [link](/draft",
    "\udc00 [label](/draft",
  ]

  input.forEach((source) => {
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end)
      expect(repair(prefix)).toBe(remend(prefix, options))
    }
  })
})

test("matches Remend on generated sequences with ambiguous delimiters", () => {
  const fragments = ["[", "]", "(", ")", "!", "`", "\\", "*", " ", "\n", "🌍"]
  let state = 1729
  for (let index = 0; index < 4_000; index++) {
    const value = Array.from({ length: 4 + (index % 32) }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return fragments[(state >>> 12) % fragments.length]
    }).join("")
    expect(repair(value)).toBe(remend(value, options))
  }
})

test("recovers from an oversized UTF-8 input and reuses the WASM instance", () => {
  const text = "é".repeat(132_000) + "🌍 [label](/draft"
  expect(repair(text)).toBe(remend(text, options))
  expect(repair("[new](/draft")).toBe("new")
})

test("reuses input and output views after WASM memory grows", () => {
  const text = "[ ".repeat(20_000) + "label"
  expect(repair(text)).toBe(remend(text, options))
  expect(repair("🌍 [new](/draft")).toBe("🌍 new")
})
