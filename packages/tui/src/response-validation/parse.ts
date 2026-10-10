import { invalid } from "./primitives"

// The transport's byte limit also applies to unused metadata. A shallow scanner
// rejects pathological JSON nesting before parsing; validators inspect only
// fields consumed by this client, without recursing into arbitrary tool metadata.
export function parseResponse(text: string): unknown {
  let depth = 0
  let containers = 0
  let quoted = false
  let escaped = false
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    if (character === "{" || character === "[") {
      if (++depth > 64 || ++containers > 50000) invalid("JSON complexity limit")
    }
    if (character === "}" || character === "]") {
      depth--
      if (depth < 0) invalid("JSON complexity limit")
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return invalid("JSON")
  }
}
