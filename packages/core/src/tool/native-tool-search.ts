export * as NativeToolSearch from "./native-tool-search"

/**
 * Provider-native tool search for the OpenAI Responses API.
 *
 * Loading a deferred tool used to change the request's `tools`, which sit at the very front of the cached
 * prefix, so every load re-read the whole window uncached (the turn after a `tool_load` averaged 291k uncached
 * tokens and read no cache at all 79% of the time). With client-executed tool search the request's tools never
 * change: the model calls `tool_search`, we answer with the matching definitions, and the provider injects them
 * at the end of the context window, so earlier content stays cached. Codex CLI works the same way.
 * https://developers.openai.com/api/docs/guides/tools-tool-search
 */

/** `tool_search` is supported on GPT-5.4 and later. */
const SUPPORTED_MODEL = /^gpt-(?:5\.(?:[4-9]|\d{2,})|[6-9]|\d{2,})(?:[.-]|$)/

export const supported = (modelID: string) => SUPPORTED_MODEL.test(modelID)

/**
 * Whether a turn uses native tool search: the caller opted in, the route speaks the Responses protocol, and the
 * model supports it. Anything else keeps the `tool_search` and `tool_load` pair that changes the advertised tools.
 */
export const enabled = (input: { readonly flag: boolean; readonly routeID: string; readonly modelID: string }) =>
  input.flag && input.routeID === "openai-responses" && supported(input.modelID)

export const DESCRIPTION =
  "Search for tools by name or description and load the best matches. Matching tools become callable immediately and their definitions are returned. Call this when you need a capability you do not have a tool for, and name what you need rather than listing every tool."
export const DEFAULT_LIMIT = 8
export const MAX_LIMIT = 20

/**
 * Loaded tools cost no prefix tokens under native search, so the caps that existed to keep the advertised list
 * short (a few tools per server, a dozen overall) no longer apply.
 */
export const MAX_LOADED = 1_000

/**
 * The definitions travel in the tool result, which output bounding spills to a file once it passes its limits
 * (50KB and 2,000 lines by default), and a spilled result would lose them. Stay well inside.
 */
export const MAX_RESULT_BYTES = 40_000
export const MAX_RESULT_LINES = 1_500

export interface Definition {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

const size = (value: unknown) => {
  const text = JSON.stringify(value, null, 2)
  return { bytes: Buffer.byteLength(text), lines: text.split("\n").length }
}

/**
 * The longest prefix of `candidates` whose definitions, with the rest of the result, fit the output limits.
 * Order is the caller's ranking, so the best matches win. Nothing is partially included.
 */
export const fit = <T extends Definition>(rest: object, candidates: ReadonlyArray<T>) => {
  const included: T[] = []
  for (const candidate of candidates) {
    const next = size({ ...rest, tools: [...included, candidate] })
    if (next.bytes > MAX_RESULT_BYTES || next.lines > MAX_RESULT_LINES) break
    included.push(candidate)
  }
  return { included, omitted: candidates.slice(included.length) }
}
