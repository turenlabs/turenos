export * as CodingEvents from "./events"

export type Usage = { input: number; cached: number; output: number; reasoning?: number }
export type Metrics = {
  firstTextMs?: number
  firstReasoningMs?: number
  firstToolMs?: number
  toolCalls: number
  requestsWithUsage: number
  usage: Usage
}

export const empty = (): Metrics => ({ toolCalls: 0, requestsWithUsage: 0, usage: { input: 0, cached: 0, output: 0 } })

export function settlements() {
  const received = new Set<string>()
  let target: string | undefined
  const settled = Promise.withResolvers<boolean>()
  return {
    record(id: string) {
      received.add(id)
      if (id === target) settled.resolve(true)
    },
    async wait(id: string, closed: Promise<unknown>, deadline: Promise<unknown>) {
      if (received.has(id)) return true
      target = id
      return Promise.race([settled.promise, closed.then(() => false), deadline.then(() => false)])
    },
  }
}

export async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const rows = (pending + chunk.value).split("\n")
      pending = rows.pop() ?? ""
      yield* rows
    }
    if (pending) yield pending
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

export const parse = (line: string) => object(JSON.parse(line))
export const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

function progress(metrics: Metrics, kind: string, text: unknown, ms: number) {
  if (kind === "tool") {
    metrics.toolCalls++
    metrics.firstToolMs ??= ms
  }
  if (typeof text !== "string" || !text.trim()) return
  if (kind === "text") metrics.firstTextMs ??= ms
  if (kind === "reasoning") metrics.firstReasoningMs ??= ms
}

function usage(metrics: Metrics, request: Usage) {
  metrics.requestsWithUsage++
  metrics.usage.input += request.input + request.cached
  metrics.usage.cached += request.cached
  metrics.usage.output += request.output
  if (request.reasoning !== undefined) metrics.usage.reasoning = (metrics.usage.reasoning ?? 0) + request.reasoning
}

export function distance(metrics: Metrics, row: Record<string, unknown>, ms: number) {
  if (row.type === "text" || row.type === "reasoning") progress(metrics, row.type, row.text, ms)
  if (row.type === "tool_start") progress(metrics, "tool", undefined, ms)
  if (row.type === "usage") {
    usage(metrics, { input: number(row.input), cached: number(row.cache_read), output: number(row.output) })
  }
}

export function turen(metrics: Metrics, row: Record<string, unknown>, session: string, ms: number) {
  const data = object(row.data)
  if (data.sessionID !== session) return
  if (row.type === "session.next.text.delta") progress(metrics, "text", data.delta, ms)
  if (row.type === "session.next.reasoning.delta") progress(metrics, "reasoning", data.delta, ms)
  if (row.type === "session.next.tool.called") progress(metrics, "tool", undefined, ms)
  if (row.type !== "session.next.step.ended") return
  const tokens = object(data.billed ?? data.tokens)
  if (typeof tokens.input === "number") {
    const reasoning = typeof tokens.reasoning === "number" ? number(tokens.reasoning) : undefined
    usage(metrics, {
      input: tokens.input,
      cached: number(object(tokens.cache).read),
      output: number(tokens.output) + (reasoning ?? 0),
      reasoning,
    })
  }
  return typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
}
