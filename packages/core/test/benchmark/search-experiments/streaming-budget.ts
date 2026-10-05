import { StreamingFinal } from "./streaming-final"

export function transform(source: string) {
  const replacements = [
    [".slice(0, 128)", ".slice(0, 96)"],
    [".slice(0, 256)", ".slice(0, 128)"],
    [".slice(0, 64)", ".slice(0, 32)"],
    ["out.length >= 64", "out.length >= 32"],
    ["const MAX_BODY_CHARS = 2000", "const MAX_BODY_CHARS = 1000"],
    ["Math.min(vocab.length, 4096)", "Math.min(vocab.length, 3072)"],
    [
      'pattern: "(?i)" + token, limit: 2048',
      'pattern: "(?i)" + token, include: "*.{" + [...EXTENSIONS].map((ext) => ext.slice(1)).join(",") + "}", limit: 2048',
    ],
  ] as const
  return replacements.reduce((text, [before, after]) => {
    if (!text.includes(before)) throw new Error(`Missing budget streaming marker: ${before}`)
    return text.replaceAll(before, after)
  }, StreamingFinal.transform(source))
}
