import { afterEach, expect, test } from "bun:test"
import {
  CodeRenderable,
  RGBA,
  TextRenderable,
  TextTableRenderable,
  type Renderable,
  type TextChunk,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createMarkdown, normalizeMarkdown } from "../src/markdown"
import { transcript } from "../src/messages"
import { color } from "../src/theme"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

async function setup(width = 80) {
  const view = await createTestRenderer({ width, height: 32 })
  const markdown = createMarkdown(view.renderer)
  view.renderer.root.add(markdown)
  cleanup.push(() => view.renderer.destroy())
  return { ...view, markdown }
}

async function rendered(view: Awaited<ReturnType<typeof setup>>, text: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await view.renderOnce()
    if (
      view.captureCharFrame().includes(text) &&
      descendants(view.markdown).every((node) => !(node instanceof CodeRenderable) || !node.isHighlighting)
    )
      return view.captureCharFrame()
    await Bun.sleep(10)
  }
  throw new Error(`Markdown did not settle:\n${view.captureCharFrame()}`)
}

function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}

test("appended text reparses the trailing paragraph instead of creating a new line per fragment", async () => {
  const view = await setup()
  view.markdown.content = "Agent\nInitial snapshot"
  await rendered(view, "Initial snapshot")
  view.markdown.content += " live text"
  const frame = await rendered(view, "Initial snapshot live text")
  expect(frame).toContain("Initial snapshot live text")
  view.markdown.content += " and more"
  expect(await rendered(view, "Initial snapshot live text and more")).toContain("Initial snapshot live text and more")
})

test.each([38])("numbered items with next-line text align their marker at %s columns", async (width) => {
  const view = await setup(width)
  const source =
    "1.\n   **First item** has enough descriptive words to wrap on narrow screens.\n\n   Separate paragraph.\n2.\n   Second item.\n   1.\n      Nested item."
  view.markdown.content = source
  const frame = await rendered(view, "Nested item.")
  expect(frame).toMatch(/1\. First item/)
  expect(frame).toMatch(/2\. Second item\./)
  expect(frame).toMatch(/1\. Nested item\./)
  const rows = frame.split("\n")
  const paragraph = rows.findIndex((line) => line.includes("Separate paragraph."))
  expect(rows[paragraph - 1]?.trim()).toBe("")
  expect(view.markdown.content).toBe(source)
})

test("streamed numbered items retain baseline alignment as markers widen", async () => {
  const view = await setup(38)
  view.markdown.content = "9.\n   Ninth item."
  expect(await rendered(view, "Ninth item.")).toMatch(/9\. Ninth item\./)
  for (const suffix of ["\n10.", "\n    Tenth", " item."]) {
    view.markdown.content += suffix
    await rendered(view, "Ninth item.")
  }
  const frame = await rendered(view, "Tenth item.")
  expect(frame).toMatch(/9\. Ninth item\./)
  expect(frame).toMatch(/10\. Tenth item\./)
  view.resize(60, 32)
  expect(await rendered(view, "Tenth item.")).toMatch(/10\. Tenth item\./)
})

test.each([1, 9])("response metadata does not swallow an ordered list starting at %s", async (start) => {
  const view = await setup(54)
  view.markdown.content = transcript([
    {
      id: "msg_list",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      time: { created: 1 },
      content: [
        {
          id: "part_list",
          type: "text",
          text: `${start}.\n   First body.\n${start + 1}.\n${" ".repeat(String(start + 1).length + 2)}Second body.`,
        },
      ],
    },
  ])
  const frame = await rendered(view, "Second body.")
  expect(frame).toMatch(new RegExp(`${start}\\. First body\\.`))
  expect(frame).toMatch(new RegExp(`${start + 1}\\. Second body\\.`))
})

test("a preceding response part cannot turn the answer list into a paragraph", async () => {
  const view = await setup(54)
  view.markdown.content = transcript([
    {
      id: "msg_parts",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      time: { created: 1 },
      content: [
        { id: "part_reasoning", type: "reasoning", text: "Earlier reasoning." },
        { id: "part_answer", type: "text", text: "1.\n   First answer.\n2.\n   Second answer." },
      ],
    },
  ])
  const frame = await rendered(view, "Second answer.")
  expect(frame).toContain("1. First answer.")
  expect(frame).toContain("2. Second answer.")
})

test("renders readable headings, emphasis, code and tables, then replaces the content", async () => {
  const view = await setup()
  expect(view.markdown.syntaxStyle.getStyle("markup.heading.1")?.fg).toEqual(RGBA.fromHex(color.accent))
  expect(view.markdown.syntaxStyle.getStyle("markup.raw.block")?.bg).toEqual(RGBA.fromHex(color.panel))
  expect(view.markdown.syntaxStyle.getStyle("markup.link")?.fg).toEqual(RGBA.fromHex(color.focus))
  view.markdown.content = [
    "# Review complete",
    "The **session switcher** keeps _your place_.",
    "- Open `src/index.ts`\n- Run the checks",
    '```typescript\nconst active = "server"\nconsole.log(active)\n```',
    "| Session | State |\n| --- | --- |\n| UI polish | Ready |",
    "[Documentation](https://example.com/docs)",
  ].join("\n\n")
  const frame = await rendered(view, "Documentation")
  expect(frame).toContain("Review complete")
  expect(frame).not.toContain("# Review")
  expect(frame).toContain("session switcher")
  expect(frame).not.toContain("**session")
  expect(frame).toContain('const active = "server"')
  expect(frame).not.toContain("```typescript")
  expect(frame).toContain("UI polish")
  const spans = view.captureSpans().lines.flatMap((line) => line.spans)
  expect(spans.some((span) => span.text.includes("Review complete") && span.attributes !== 0)).toBe(true)
  expect(descendants(view.markdown).some((node) => node instanceof TextTableRenderable)).toBe(true)

  view.markdown.content = "## Updated\n\n**Fresh content** replaces the original."
  const updated = await rendered(view, "Fresh content")
  expect(updated).not.toContain("Review complete")
  expect(updated).not.toContain("## Updated")
  expect(updated).not.toContain("**Fresh")
})

test("only HTTP and HTTPS links survive in prose and reused table cells", async () => {
  const view = await setup()
  const seen: TextChunk[] = []
  function observe() {
    for (const node of descendants(view.markdown)) {
      if (!(node instanceof CodeRenderable)) continue
      const original = node.onChunks!
      node.onChunks = async (chunks, context) => {
        const result = (await original(chunks, context)) ?? chunks
        seen.push(...result)
        return result
      }
    }
  }
  view.markdown.content = [
    "[Secure](https://example.com/docs) [File](file:///tmp/example) [Script](javascript:alert(1))",
    "| Links |\n| --- |\n| [HTTP](http://example.com) |\n| [Bad](custom:launch) |",
  ].join("\n\n")
  observe()
  await rendered(view, "Secure")
  const table = descendants(view.markdown).find((node) => node instanceof TextTableRenderable)!
  expect([...new Set(table.content.flat(2).flatMap((chunk) => chunk?.link?.url ?? []))]).toEqual([
    "http://example.com/",
  ])
  expect(seen.some((chunk) => chunk.link?.url === "https://example.com/docs")).toBe(true)
  expect(seen.filter((chunk) => chunk.link).every((chunk) => chunk.link!.url.startsWith("https://"))).toBe(true)

  seen.length = 0
  view.markdown.content = [
    "[Allowed](HTTP://example.com) [Custom](custom:launch-two)",
    "| Links |\n| --- |\n| [Changed](javascript:launch) |\n| [Good](https://example.com/new) |",
  ].join("\n\n")
  observe()
  await rendered(view, "Allowed")
  const updated = descendants(view.markdown).find((node) => node instanceof TextTableRenderable)!
  expect(updated).toBe(table)
  expect([...new Set(updated.content.flat(2).flatMap((chunk) => chunk?.link?.url ?? []))]).toEqual([
    "https://example.com/new",
  ])
  expect(seen.some((chunk) => chunk.link?.url === "http://example.com/")).toBe(true)
  expect(seen.filter((chunk) => chunk.link).every((chunk) => chunk.link!.url.startsWith("http://"))).toBe(true)
})

test("disables malformed and control-bearing hyperlink targets without hiding their labels", async () => {
  const view = await setup()
  view.markdown.content = "A paragraph."
  const node = descendants(view.markdown).find((child) => child instanceof CodeRenderable)!
  const targets = [
    "javascript:alert(1)",
    "file:///tmp/example",
    "custom:launch",
    "//example.com",
    "https://example.com/\u001b]8;;file:///tmp/example",
    "ht\ttps://example.com",
    "https://example.com/\u009c",
    "http://",
    "https://example.com/docs",
  ]
  const chunks: TextChunk[] = targets.map((url) => ({ __isChunk: true, text: "Read more", link: { url } }))
  const result = await node.onChunks!(chunks, {
    content: "",
    filetype: "markdown",
    syntaxStyle: view.markdown.syntaxStyle,
    highlights: [],
  })
  expect(result?.map((chunk) => chunk.text)).toEqual(targets.map(() => "Read more"))
  expect(result?.flatMap((chunk) => chunk.link?.url ?? [])).toEqual(["https://example.com/docs"])
})

test("preserves complex output as plain text and resumes rich rendering on the next update", async () => {
  const view = await setup()
  for (const value of ["x".repeat(16_001), ">".repeat(513) + " kept", "row\n".repeat(257)]) {
    view.markdown.content = value
    expect(view.markdown.content).toBe(value)
    const fallback = view.markdown.getChildren().find((node) => node instanceof TextRenderable)!
    expect(fallback.plainText).toBe(value)
    expect(descendants(view.markdown).some((node) => node instanceof CodeRenderable)).toBe(false)
  }
  view.markdown.content = "# Back to reading\n\n**Ready** for review."
  const frame = await rendered(view, "Ready")
  expect(frame).toContain("Back to reading")
  expect(frame).not.toContain("# Back")
  expect(frame).not.toContain("**Ready")
})

test("normalizeMarkdown collapses next-line list items and preserves code blocks", () => {
  expect(normalizeMarkdown("1.\nFirst item\n2.\nSecond item")).toBe("1. First item\n2. Second item")
  expect(normalizeMarkdown("1. \nFirst item\n2. \nSecond item")).toBe("1. First item\n2. Second item")
  expect(normalizeMarkdown("1.\n   First item\n2.\n   Second item")).toBe("1. First item\n2. Second item")
  expect(normalizeMarkdown("1. First item\n2. Second item")).toBe("1. First item\n2. Second item")
  expect(normalizeMarkdown("1)\nFirst item\n2)\nSecond item")).toBe("1) First item\n2) Second item")
  expect(normalizeMarkdown("1.\n\nFirst item")).toBe("1.\n\nFirst item")
  expect(normalizeMarkdown("1.\n2. Item")).toBe("1.\n2. Item")
  expect(normalizeMarkdown("- \nFirst item\n- \nSecond item")).toBe("- First item\n- Second item")
  expect(normalizeMarkdown("  1.\n  Nested item")).toBe("  1. Nested item")
  const code = "1.\nFirst\n\n```\n1.\nCode line\n```\n2.\nSecond"
  expect(normalizeMarkdown(code)).toBe("1. First\n\n```\n1.\nCode line\n```\n2. Second")
})
