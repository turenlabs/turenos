export * as GraphBrief from "./graph-brief"

import { Brief } from "./brief"

export function transform(source: string) {
  const replacements = [
    [
      "const indexSym = (doc: DocMeta, text: string): number =>",
      "const indexSym = (doc: DocMeta, text: string, callable = true): number =>",
    ],
    ["      if (doc.name) {", "      if (yolkEnabled && callable && doc.name) {"],
    ["indexSym(sym.doc, sym.text)", 'indexSym(sym.doc, sym.text, sym.doc.kind === "function")'],
  ] as const
  return replacements.reduce((text, [before, after]) => {
    if (!text.includes(before)) throw new Error(`Missing graph-brief marker: ${before}`)
    return text.replace(before, after)
  }, Brief.transform(source))
}
