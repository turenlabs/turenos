export * as Wildcard from "./wildcard"

const insensitive = process.platform === "win32"
const maxCachedPatternLength = 256
const maxCachedPatterns = 256
const patterns = new Map<string, string | RegExp>()

export function match(input: string, pattern: string) {
  if (pattern === "*") return true
  const compiled = patterns.get(pattern) ?? compile(pattern)
  if (typeof compiled !== "string") return compiled.test(input.replaceAll("\\", "/"))
  if (input === compiled) return true
  if (input.length !== compiled.length || !input.includes("\\")) return false
  return input.replaceAll("\\", "/") === compiled
}

function compile(pattern: string) {
  const normalized = pattern.replaceAll("\\", "/")
  const cacheable = pattern.length <= maxCachedPatternLength
  // Windows keeps the RegExp engine's case folding, including non-ASCII literals.
  const compiled =
    cacheable && !insensitive && !normalized.includes("*") && !normalized.includes("?")
      ? normalized
      : expression(normalized)
  if (cacheable) {
    if (patterns.size === maxCachedPatterns) patterns.delete(patterns.keys().next().value!)
    patterns.set(pattern, compiled)
  }
  return compiled
}

function expression(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(
    "^" + (escaped.endsWith(" .*") ? escaped.slice(0, -3) + "( .*)?" : escaped) + "$",
    insensitive ? "si" : "s",
  )
}
