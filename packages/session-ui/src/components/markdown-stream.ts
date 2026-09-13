import { marked, type Tokens, type TokensList } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

function refs(text: string) {
  if (!text.includes("]:")) return false
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")
  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const trimmed = raw.trimEnd()
  const last = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim()
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]
  if (!mark) return suffix.includes("```") || suffix.includes("~~~")
  if (suffix.includes(mark)) return true
  return `${raw.slice(-(mark.length - 1))}${suffix.slice(0, mark.length - 1)}`.includes(mark)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  return blocksFromTokens(marked.lexer(text), text)
}

function blocksFromTokens(tokens: TokensList, text: string): Block[] {
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []
  for (let index = 0; index < tail; index++) {
    const token = tokens[index]
    if (!token || token.type === "space") continue
    let raw = token.raw
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw
    if (token.type === "code") {
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }]

  const code = last as Tokens.Code
  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]
  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }]
}

export function canReusePendingBlock(current: Pick<Block, "mode" | "raw"> | undefined, next: Block) {
  if (!current) return false
  if (current.mode !== next.mode && !(current.mode === "live" && next.mode === "full")) return false
  // Keep already-rendered formatting while an append is parsed. Replacing it
  // with raw Markdown on every delta makes lists, headings and links flicker.
  return next.raw.startsWith(current.raw)
}

export function canReusePendingDocument(rendered: string, next: Projection) {
  return next.blocks.length === 1 && next.blocks[0]?.mode === "full" && next.text.startsWith(rendered)
}

/** Accept useful async progress without reviving replaced text or moving backwards. */
export function canCommitStreamResult(text: string, rendered: string, completed: string) {
  return text.startsWith(completed) && (!text.startsWith(rendered) || completed.length >= rendered.length)
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live || !previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (!suffix) return { text, blocks: stream(text, live) }
  if (tail?.mode === "code" && !tail.complete && !closesFence(tail.raw, suffix))
    return {
      text,
      blocks: [
        ...previous.blocks.slice(0, -1),
        {
          ...tail,
          raw: tail.raw + suffix,
          src: tail.src + suffix,
        },
      ],
    }
  if (refs(text)) return { text, blocks: stream(text, live) }
  // Re-lex the last two blocks, not just the new suffix: a paragraph or list
  // tail can still merge with or reshape the block before it (GFM tables,
  // setext headings, lazy continuations). `start` slices the text instead of
  // joining raws because leading space tokens are dropped from block raws.
  const keep = Math.max(previous.blocks.length - 2, 0)
  const kept = previous.blocks.slice(0, keep)
  const start = kept.reduce((sum, block) => sum + block.raw.length, 0)
  const region = text.slice(start)
  const regionBlocks = blocksFromTokens(marked.lexer(region), region)
  const boundary = previous.blocks[keep]
  if (!regionBlocks.length || (keep > 0 && regionBlocks[0]?.raw !== boundary?.raw))
    return { text, blocks: stream(text, live) }
  return { text, blocks: [...kept, ...regionBlocks] }
}
