import { describe, expect, test } from "bun:test"
import {
  canCommitStreamResult,
  canReusePendingBlock,
  canReusePendingDocument,
  project,
  stream,
} from "./markdown-stream"

describe("markdown stream", () => {
  test("preserves every rendered block while completion parses a final queued delta", () => {
    const previous = project(undefined, "**First** paragraph.\n\n- Second block.\n\nThird paragraph.", true)
    const text = `${previous.text} Final delta.`
    expect(previous.blocks).toHaveLength(3)
    expect(canReusePendingDocument(previous.text, project(previous, text, false))).toBe(true)
    expect(canReusePendingDocument(previous.text, project(previous, text, true))).toBe(false)
    expect(canReusePendingDocument(previous.text, project(previous, "Replacement", false))).toBe(false)
    expect(canReusePendingDocument(previous.text, project(previous, "**First** paragraph.", false))).toBe(false)
  })

  test("slow parsing makes monotonic progress during continuous streaming", () => {
    expect(canCommitStreamResult("**Hello** world grows", "**Hello", "**Hello** world")).toBe(true)
    expect(canCommitStreamResult("**Hello** world grows", "**Hello** world", "**Hello")).toBe(false)
    expect(canCommitStreamResult("replacement", "old content", "old")).toBe(false)
    expect(canCommitStreamResult("replacement grows", "old content", "replacement")).toBe(true)
    expect(canCommitStreamResult("short", "short", "shortened earlier content")).toBe(false)
  })
  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([{ raw: "hello **world", src: "hello **world**", mode: "live" }])
    expect(stream("say `code", true)).toEqual([{ raw: "say `code", src: "say `code`", mode: "live" }])
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live" },
    ])
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "full" },
      { raw: "```ts\nconst x = 1", src: "const x = 1", mode: "code", language: "ts" },
    ])
  })

  test("fully parses a code fence once it closes", () => {
    const text = "before\n\n```ts\nconst x = 1\n```"
    expect(stream(text, true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "full" },
      { raw: "```ts\nconst x = 1\n```", src: "const x = 1", mode: "code", language: "ts", complete: true },
    ])
  })

  test("finds an indented closing fence after many lines and trailing whitespace", () => {
    const code = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n")
    const raw = `\`\`\`ts\n${code}\n  \`\`\`  \n\n`

    expect(stream(raw, true)).toEqual([{ raw, src: code, mode: "code", language: "ts", complete: true }])
  })

  test("keeps a completed code fence in worker-rendered code mode when prose follows", () => {
    expect(stream("```ts\nconst x = 1\n```\n\nafter", true)).toEqual([
      { raw: "```ts\nconst x = 1\n```\n\n", src: "const x = 1", mode: "code", language: "ts", complete: true },
      { raw: "after", src: "after", mode: "live" },
    ])
  })

  test("freezes completed top-level blocks and only keeps the tail live", () => {
    expect(stream("# Plan\n\nFinished paragraph.\n\n- live item", true)).toEqual([
      { raw: "# Plan\n\n", src: "# Plan\n\n", mode: "full" },
      { raw: "Finished paragraph.\n\n", src: "Finished paragraph.\n\n", mode: "full" },
      { raw: "- live item", src: "- live item", mode: "live" },
    ])
  })

  test("keeps a growing table together until a later block freezes it", () => {
    expect(stream("| a | b |\n|---|---|\n| 1 | 2 |", true)).toEqual([
      { raw: "| a | b |\n|---|---|\n| 1 | 2 |", src: "| a | b |\n|---|---|\n| 1 | 2 |", mode: "live" },
    ])
  })

  test("reprojects non-prefix replacements from current content", () => {
    expect(stream("# Replacement\n\nNew body", true)).toEqual([
      { raw: "# Replacement\n\n", src: "# Replacement\n\n", mode: "full" },
      { raw: "New body", src: "New body", mode: "live" },
    ])
  })

  test("reprojects truncation without retaining removed blocks", () => {
    expect(stream("Only the restored prefix", true)).toEqual([
      { raw: "Only the restored prefix", src: "Only the restored prefix", mode: "live" },
    ])
  })

  test("shifts later blocks when an earlier block is inserted", () => {
    expect(stream("# Inserted\n\nFirst body\n\nSecond body", true)).toEqual([
      { raw: "# Inserted\n\n", src: "# Inserted\n\n", mode: "full" },
      { raw: "First body\n\n", src: "First body\n\n", mode: "full" },
      { raw: "Second body", src: "Second body", mode: "live" },
    ])
  })

  test("keeps reference-style markdown as one block", () => {
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ])
  })

  test("keeps compact and indented reference definitions with their uses", () => {
    expect(stream("[docs]\n\n   [docs]:/guide", true)).toEqual([
      {
        raw: "[docs]\n\n   [docs]:/guide",
        src: "[docs]\n\n   [docs]:/guide",
        mode: "live",
      },
    ])
  })

  test("keeps multiline reference definitions with their uses", () => {
    expect(stream("[docs][id]\n\n[id]:\n  /guide", true)).toEqual([
      {
        raw: "[docs][id]\n\n[id]:\n  /guide",
        src: "[docs][id]\n\n[id]:\n  /guide",
        mode: "live",
      },
    ])
  })

  test("uses only the language portion of fence metadata", () => {
    expect(stream("```ts title=example\nconst x = 1", true)).toEqual([
      {
        raw: "```ts title=example\nconst x = 1",
        src: "const x = 1",
        mode: "code",
        language: "ts",
      },
    ])
  })

  test("preserves trailing newlines in open code fences", () => {
    expect(stream("```ts\nconst x = 1\n", true)).toEqual([
      {
        raw: "```ts\nconst x = 1\n",
        src: "const x = 1\n",
        mode: "code",
        language: "ts",
      },
    ])
  })

  test("only reuses pending blocks with compatible identity and content", () => {
    expect(
      canReusePendingBlock(
        { mode: "live", raw: "- **Stable** list" },
        { mode: "full", raw: "- **Stable** list\n\n", src: "" },
      ),
    ).toBe(true)
    expect(
      canReusePendingBlock(
        { mode: "live", raw: "**Stable** text" },
        { mode: "live", raw: "**Stable** text grows", src: "" },
      ),
    ).toBe(true)
    expect(
      canReusePendingBlock({ mode: "live", raw: "old response" }, { mode: "live", raw: "replacement", src: "" }),
    ).toBe(false)
    expect(
      canReusePendingBlock({ mode: "full", raw: "First\n\n" }, { mode: "full", raw: "# Inserted\n\n", src: "" }),
    ).toBe(false)
    expect(
      canReusePendingBlock({ mode: "code", raw: "```ts\none" }, { mode: "code", raw: "```ts\none two", src: "" }),
    ).toBe(true)
    expect(canReusePendingBlock({ mode: "code", raw: "```ts\none" }, { mode: "live", raw: "one", src: "" })).toBe(false)
  })

  test("grows a live paragraph in place during appends", () => {
    const previous = project(undefined, "The answer is", true)
    const next = project(previous, `${previous.text} 42 and counting`, true)

    expect(next.blocks).toHaveLength(1)
    expect(next.blocks[0]?.mode).toBe("live")
    expect(next.blocks).toEqual(stream(next.text, true))
    expect(next.blocks.map((block) => block.raw).join("")).toBe(next.text)
  })

  test("splits a new block boundary that appears in the suffix", () => {
    const previous = project(undefined, "First paragraph", true)
    const next = project(previous, `${previous.text}\n\nSecond paragraph`, true)

    expect(next.blocks).toEqual([
      { raw: "First paragraph\n\n", src: "First paragraph\n\n", mode: "full" },
      { raw: "Second paragraph", src: "Second paragraph", mode: "live" },
    ])
    expect(next.blocks.map((block) => block.raw).join("")).toBe(next.text)
  })

  test("promotes a paragraph tail to a table when a delimiter row arrives", () => {
    const previous = project(undefined, "intro\n\nmore\n\na | b", true)
    const next = project(previous, `${previous.text}\n--- | ---`, true)

    expect(next.blocks[0]).toBe(previous.blocks[0])
    expect(next.blocks).toEqual([
      { raw: "intro\n\n", src: "intro\n\n", mode: "full" },
      { raw: "more\n\n", src: "more\n\n", mode: "full" },
      { raw: "a | b\n--- | ---", src: "a | b\n--- | ---", mode: "live" },
    ])
    expect(next.blocks.map((block) => block.raw).join("")).toBe(next.text)
  })

  test("keeps frozen blocks stable while a trailing code fence opens and closes", () => {
    const previous = project(undefined, "intro\n\nmore\n\n```ts\nconst x = 1\n", true)
    const grown = project(previous, `${previous.text}const y = 2\n`, true)
    const closed = project(grown, `${grown.text}\`\`\``, true)
    const after = project(closed, `${closed.text}\n\ndone`, true)

    expect(grown.blocks[0]).toBe(previous.blocks[0])
    expect(closed.blocks[0]).toBe(previous.blocks[0])
    expect(closed.blocks.at(-1)).toEqual({
      raw: "```ts\nconst x = 1\nconst y = 2\n```",
      src: "const x = 1\nconst y = 2",
      mode: "code",
      language: "ts",
      complete: true,
    })
    expect(after.blocks[0]).toBe(previous.blocks[0])
    expect(after.blocks).toEqual(stream(after.text, true))
  })

  test("reprojects text that does not extend the previous projection", () => {
    const previous = project(undefined, "old content\n\n- item", true)
    const text = "totally different content"

    expect(project(previous, text, true)).toEqual({ text, blocks: stream(text, true) })
  })

  test("keeps raw coverage of the text across mixed append sequences", () => {
    const chunks = [
      "# Title\n\n",
      "first para",
      "graph\n\n",
      "- one\n- two\n\n",
      "```ts\n",
      "code\n",
      "```\n\n",
      "tail | a\n",
      "--- | ---\n",
    ]
    let previous = project(undefined, chunks[0]!, true)
    for (const chunk of chunks.slice(1)) {
      previous = project(previous, previous.text + chunk, true)
      expect(previous.blocks.map((block) => block.raw).join("")).toBe(previous.text)
      expect(previous.blocks).toEqual(stream(previous.text, true))
    }
  })

  test("appends plain code deltas without reprojecting frozen blocks", () => {
    const previous = project(undefined, "# Plan\n\n```ts\nconst one = 1\n", true)
    const next = project(previous, `${previous.text}const two = 2\n`, true)

    expect(next.blocks[0]).toBe(previous.blocks[0])
    expect(next.blocks.at(-1)).toEqual({
      raw: "```ts\nconst one = 1\nconst two = 2\n",
      src: "const one = 1\nconst two = 2\n",
      mode: "code",
      language: "ts",
    })
  })

  test("does not add a blank line before the first streamed code", () => {
    const previous = project(undefined, "```ts\n", true)
    const next = project(previous, `${previous.text}const x = 1`, true)

    expect(next.blocks.at(-1)).toEqual({
      raw: "```ts\nconst x = 1",
      src: "const x = 1",
      mode: "code",
      language: "ts",
    })
  })

  test("closes code fences split across provider deltas", () => {
    const open = project(undefined, "```ts\nconst x = 1\n", true)
    const one = project(open, `${open.text}\``, true)
    const two = project(one, `${one.text}\``, true)
    const closed = project(two, `${two.text}\``, true)
    const prose = project(closed, `${closed.text}\nafter`, true)

    expect(closed.blocks.at(-1)).toEqual({
      raw: "```ts\nconst x = 1\n```",
      src: "const x = 1",
      mode: "code",
      language: "ts",
      complete: true,
    })
    expect(prose.blocks).toEqual([
      { raw: "```ts\nconst x = 1\n```\n", src: "const x = 1", mode: "code", language: "ts", complete: true },
      { raw: "after", src: "after", mode: "live" },
    ])
  })

  test("closes a code fence contained within one provider delta", () => {
    const open = project(undefined, "```ts\nconst one = 1\n", true)
    const closed = project(open, `${open.text}const two = 2\n\`\`\`\nafter`, true)

    expect(closed.blocks).toEqual([
      {
        raw: "```ts\nconst one = 1\nconst two = 2\n```\n",
        src: "const one = 1\nconst two = 2",
        mode: "code",
        language: "ts",
        complete: true,
      },
      { raw: "after", src: "after", mode: "live" },
    ])
  })

  test("closes tilde fences split across provider deltas", () => {
    const open = project(undefined, "~~~ts\nconst x = 1\n", true)
    const one = project(open, `${open.text}~`, true)
    const two = project(one, `${one.text}~`, true)
    const closed = project(two, `${two.text}~`, true)

    expect(closed.blocks.at(-1)).toEqual({
      raw: "~~~ts\nconst x = 1\n~~~",
      src: "const x = 1",
      mode: "code",
      language: "ts",
      complete: true,
    })
  })
})
