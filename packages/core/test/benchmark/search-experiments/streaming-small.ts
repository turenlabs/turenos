export * as StreamingSmall from "./streaming-small"

import { Streaming } from "./streaming"

export function transform(source: string) {
  const replacements = [
    [".slice(0, 192)", ".slice(0, 128)"],
    [".slice(0, 128)", ".slice(0, 64)"],
    [
      "        for (const token of rare) {",
      "        for (const token of rare) {\n          if (discoveryLex.inverted.has(stem(token))) continue",
    ],
    ["      pendingEdges.clear()", "      pendingEdges.clear()\n      Bun.gc(true)"],
  ] as const
  // Change symbol bounds before the candidate bound so replacements do not overlap.
  const text = Streaming.transform(source)
  return [replacements[1], replacements[0], ...replacements.slice(2)].reduce((text, [before, after]) => {
    if (!text.includes(before)) throw new Error(`Missing small-streaming marker: ${before}`)
    return text.replaceAll(before, after)
  }, text)
}
