import {
  CodeRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  TextTableRenderable,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from "@opentui/core"
import { color } from "./theme"

/** Render the bounded, terminal-sanitized output supplied by server.ts. */
export function createMarkdown(renderer: CliRenderer): MarkdownRenderable {
  const style = SyntaxStyle.fromStyles({
    default: { fg: color.text },
    "markup.heading": { fg: color.accent, bold: true },
    ...Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((level) => [`markup.heading.${level}`, { fg: color.accent, bold: true }]),
    ),
    "markup.strong": { fg: color.text, bold: true },
    "markup.italic": { fg: color.text, italic: true },
    "markup.raw": { fg: color.accent, bg: color.panel },
    "markup.raw.block": { fg: color.text, bg: color.panel },
    "markup.list": { fg: color.accent },
    "markup.link": { fg: color.focus },
    "markup.link.label": { fg: color.focus, underline: true },
    "markup.link.url": { fg: color.muted },
    "markup.quote": { fg: color.muted, italic: true },
    conceal: { fg: "#484848" },
    keyword: { fg: color.accent },
    string: { fg: "#b6c99c" },
    number: { fg: "#d6a5d6" },
    comment: { fg: color.muted, italic: true },
  })
  const guarded = new WeakSet<CodeRenderable>()
  function guard(node: Renderable) {
    // OpenTUI 0.5.10 gives next-line list text a leading margin, but not its
    // sibling marker. Correct the first block, including after in-place updates.
    if (/-item-\d+-content$/.test(node.id)) {
      const first = node.getChildren()[0]
      if (first && first.marginTop !== 0) first.marginTop = 0
    }
    if (node instanceof CodeRenderable && !guarded.has(node)) {
      guarded.add(node)
      const original = node.onChunks
      node.onChunks = async (chunks, context) => safeLinks((await original?.(chunks, context)) ?? chunks)
    }
    if (node instanceof TextTableRenderable)
      node.content = node.content.map((row) => row.map((cell) => (cell ? safeLinks(cell) : cell)))
    for (const child of node.getChildren()) guard(child)
  }

  const markdown = new (class extends MarkdownRenderable {
    private requested = ""
    private fallback?: TextRenderable

    override get content() {
      return this.requested
    }

    override set content(value: string) {
      if (this.isDestroyed || this.requested === value) return
      this.requested = value
      if (this.fallback) {
        this.remove(this.fallback)
        this.fallback.destroy()
        this.fallback = undefined
      }
      if (!richContent(value)) {
        super.content = ""
        this.fallback = new TextRenderable(renderer, {
          id: "markdown-plain",
          width: "100%",
          content: value,
          fg: color.text,
          wrapMode: "word",
        })
        this.add(this.fallback)
        return
      }
      super.content = normalizeMarkdown(value)
      // OpenTUI can reuse tables without calling renderNode again.
      guard(this)
    }
  })(renderer, {
    id: "markdown",
    width: "100%",
    syntaxStyle: style,
    fg: color.text,
    bg: color.bg,
    conceal: true,
    concealCode: false,
    streaming: true,
    tableOptions: { style: "columns", wrapMode: "word" },
    renderNode(token, context) {
      const node = context.defaultRender()
      if (!node) return undefined
      if (token.type === "code" && node instanceof CodeRenderable) node.bg = color.panel
      guard(node)
      return node
    },
  })
  // The renderer emits destroy before destroying children that still use this style.
  renderer.once("destroy", () => queueMicrotask(() => style.destroy()))
  return markdown
}

function safeLinks(chunks: TextChunk[]): TextChunk[] {
  return chunks.map((chunk) => {
    if (!chunk.link) return chunk
    const target = chunk.link.url
    // Match the terminal-control stripping in server display() plus URL
    // whitespace: any C0/C1 control, bidi isolates/overrides, and embeddings.
    const control =
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(target) ||
      Array.from(target).some((char) => char.codePointAt(0)! > 0x10ffff)
    const url = !control && URL.canParse(target) ? new URL(target) : undefined
    if (url && (url.protocol === "http:" || url.protocol === "https:"))
      return { ...chunk, link: { ...chunk.link, url: url.href } }
    return { ...chunk, link: undefined }
  })
}

function richContent(value: string) {
  // Parsing/rendering many blocks or deeply nested punctuation can monopolize the
  // terminal. Beyond these budgets, preserve every character as ordinary text.
  if (value.length > 16_000) return false
  const counts = { lines: 1, punctuation: 0 }
  for (const char of value) {
    if (char === "\n" && ++counts.lines > 256) return false
    if ("*_[]()#>~|!`".includes(char) && ++counts.punctuation > 512) return false
  }
  return true
}

export function normalizeMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.replace(/^([ \t]*(?:\d+[.)]|[-*+]))[ \t]*\n(?!\n)(?![ \t]*(?:\d+[.)]|[-*+])\s)[ \t]*(?=\S)/gm, "$1 ")
    })
    .join("")
}
