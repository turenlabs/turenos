export * as StreamingFinal from "./streaming-final"

import { StreamingSmall } from "./streaming-small"

export function transform(source: string) {
  const replacements = [
    [
      'import { Context, Effect, Layer, Option, Schema } from "effect"',
      'import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"',
    ],
    [
      "    let requestTail = Promise.resolve()",
      "    const semaphore = yield* Semaphore.make(1)\n    let focus = new Set<string>()\n    let callerIntent = false",
    ],
    [
      "      const scores = new Map<string, number>()",
      `      callerIntent = queries.some((query) => INTENT_RE.test(query))
      focus = new Set(queries.flatMap((query) => query.replace(INTENT_RE, " ").match(/[A-Za-z_$][\\w$]*/g) ?? [])
        .map((token) => token.toLowerCase()).filter((token) => !STOP.has(token)))
      const scores = new Map<string, number>()`,
    ],
    [
      "unit.functions.slice(0, 64)",
      `unit.functions.map((fn) => ({ fn, relevance:
                (focus.has(fn.name.toLowerCase()) ? 2 : 0) +
                (callerIntent && fn.body.some((token) => focus.has(token.text.toLowerCase())) ? 1 : 0),
              })).sort((a, b) => b.relevance - a.relevance).slice(0, 64).map((hit) => hit.fn)`,
    ],
    ["df >= 3 && df <= discoveryLex.n * 0.1", "df >= 1 && df <= discoveryLex.n * 0.1"],
    [
      "if (discoveryLex.inverted.has(stem(token))) continue",
      "if ((discoveryLex.inverted.get(stem(token))?.length ?? 0) > 6) continue",
    ],
    ["      Bun.gc(true)", '      if (typeof Bun !== "undefined") Bun.gc(true)'],
    [
      '  for (let i = 0; i < lines.length; i++) {\n    let name = "", kind = ""',
      '  for (let i = 0; i < lines.length; i++) {\n    if (out.length >= 64) break\n    let name = "", kind = ""',
    ],
    [
      `        Effect.acquireUseRelease(
          Effect.uninterruptible(Effect.promise(() => {
            const pending = requestTail
            let release!: () => void
            requestTail = new Promise<void>((resolve) => { release = resolve })
            return pending.then(() => release)
          })),
          () => Effect.gen(function* () {`,
      `        semaphore.withPermit(Effect.gen(function* () {`,
    ],
    ["          }),\n          (release) => Effect.sync(release),\n        ),", "          }),\n        ),"],
  ] as const
  return replacements.reduce((text, [before, after]) => {
    if (!text.includes(before)) throw new Error(`Missing final streaming marker: ${before}`)
    return text.replaceAll(before, after)
  }, StreamingSmall.transform(source))
}
