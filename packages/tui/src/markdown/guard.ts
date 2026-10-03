import { CodeRenderable, TextTableRenderable, type Renderable, type TextChunk } from "@opentui/core"

const guarded = new WeakSet<CodeRenderable>()

/** Fixes list margins and restricts link targets in a rendered block and everything below it. */
export function guard(node: Renderable) {
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

function safeLinks(chunks: TextChunk[]): TextChunk[] {
  return chunks.map((chunk) => {
    if (!chunk.link) return chunk
    const target = chunk.link.url
    // Match the terminal-control stripping in server display() plus URL
    // whitespace: any C0/C1 control, bidi isolates/overrides, and embeddings.
    const control =
      /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(target) ||
      Array.from(target).some((char) => char.codePointAt(0)! > 0x10ffff)
    const url = !control && URL.canParse(target) ? new URL(target) : undefined
    if (url && (url.protocol === "http:" || url.protocol === "https:"))
      return { ...chunk, link: { ...chunk.link, url: url.href } }
    return { ...chunk, link: undefined }
  })
}
