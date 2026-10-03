import { SyntaxStyle } from "@opentui/core"
import { color } from "../theme"

export function markdownStyle() {
  return SyntaxStyle.fromStyles({
    default: { fg: color.text },
    "markup.heading": { fg: color.accent, bold: true },
    ...Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((level) => [`markup.heading.${level}`, { fg: color.accent, bold: true }]),
    ),
    "markup.strong": { fg: color.text, bold: true },
    "markup.italic": { fg: color.text, italic: true },
    "markup.raw": { fg: color.accent, bg: color.panel },
    "markup.raw.block": { fg: color.text, bg: color.panel },
    "markup.list": { fg: color.accent },
    "markup.link": { fg: color.focus },
    "markup.link.label": { fg: color.focus, underline: true },
    "markup.link.url": { fg: color.muted },
    "markup.quote": { fg: color.muted, italic: true },
    conceal: { fg: "#484848" },
    keyword: { fg: color.accent },
    string: { fg: "#b6c99c" },
    number: { fg: "#d6a5d6" },
    comment: { fg: color.muted, italic: true },
  })
}
