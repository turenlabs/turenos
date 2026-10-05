export * as Structural from "./structural"

import { GraphBrief } from "./graph-brief"

export function transform(source: string) {
  const marker = "    if (!name) continue"
  if (!source.includes(marker)) throw new Error("Missing generic declaration marker")
  return GraphBrief.transform(source).replace(
    marker,
    '    if (!name || (kind === "value" && !/=>|\\bfunction\\b|\\bfn(?:Untraced)?\\s*\\(/.test(lines.slice(i, i + 5).join(" ")))) continue',
  )
}
