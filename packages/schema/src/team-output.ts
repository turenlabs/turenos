/** Longest coordinator reply read as factory output: a maximal FactoryPlan with every character escaped as \uXXXX. */
const FACTORY_OUTPUT_MAX = 1_000_000

const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/**
 * The JSON value of a coordinator reply that is only JSON, bare or as the contents of one Markdown code fence.
 * Prose around the JSON, or around the fence, yields undefined. Import-free so the terminal client shares it.
 */
export function parseFactoryOutput(text: string): unknown {
  if (text.length > FACTORY_OUTPUT_MAX) return
  const trimmed = text.trim()
  const body = fenced.exec(trimmed)?.[1] ?? trimmed
  try {
    return JSON.parse(body)
  } catch {
    return
  }
}
