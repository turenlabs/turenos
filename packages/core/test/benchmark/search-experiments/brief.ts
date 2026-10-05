export * as Brief from "./brief"

import { Interned } from "./interned"

export function transform(source: string) {
  const replacements = [
    ['    const body = lines.slice(i, i + 25).join("\\n").slice(0, MAX_BODY_CHARS)\n', ""],
    [
      '              const body = fn.body\n                .slice(0, 4000)\n                .map((t) => t.text)\n                .join(" ")\n                .slice(0, MAX_BODY_CHARS)\n',
      "",
    ],
    ["text: `${name} ${name} ${kind} ${file} ${body}`,", "text: `${name} ${name} ${kind} ${lines[i]!}`,"],
    [
      '`${fn.symbol} ${fn.name} ${fn.receiver} ${fn.kind} ${fn.params.join(" ")} ${file} ${body}`',
      '`${fn.symbol} ${fn.name} ${fn.receiver} ${fn.kind} ${fn.params.join(" ")}`',
    ],
  ] as const
  return replacements.reduce((text, [before, after]) => {
    if (!text.includes(before)) throw new Error(`Missing brief experiment marker: ${before}`)
    return text.replace(before, after)
  }, Interned.transform(source))
}
