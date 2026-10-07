import { CodeRenderable, type CliRenderer, type MarkdownRenderable } from "@opentui/core"
import { color } from "./theme"
import { guard, guardInitialChunks } from "./markdown/guard"
import { normalizeMarkdown } from "./markdown/normalize"
import { BoundedMarkdown } from "./markdown/renderable"
import { markdownStyle } from "./markdown/style"

export { normalizeMarkdown }

/** Render the bounded, terminal-sanitized output supplied by server.ts. */
export function createMarkdown(renderer: CliRenderer): MarkdownRenderable {
  const style = markdownStyle()
  const markdown = new BoundedMarkdown(renderer, {
    id: "markdown",
    width: "100%",
    syntaxStyle: style,
    fg: color.text,
    bg: color.bg,
    conceal: true,
    concealCode: false,
    streaming: true,
    // With renderNode, the default "coalesced" mode drops the blank-line tokens, so paragraphs lose their gap.
    internalBlockMode: "top-level",
    tableOptions: { style: "columns", wrapMode: "word" },
    renderNode(token, context) {
      const node = context.defaultRender()
      if (!node) return undefined
      if (token.type === "code" && node instanceof CodeRenderable) node.bg = color.panel
      guard(node)
      return node
    },
  })
  guardInitialChunks(markdown)
  // The renderer emits destroy before destroying children that still use this style.
  renderer.once("destroy", () => queueMicrotask(() => style.destroy()))
  return markdown
}
