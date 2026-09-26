// Rules about what a single page says: the few conventions a script can prove, and backticked repository paths.

import path from "node:path"
import type { Docs } from "./docs"
import { existsExactly } from "./exact"
import { error, warning, type Finding } from "./findings"
import { linkTargets, stripCode } from "./markdown"

const AGENT_FILE = /CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.claude\/rules/
// The experimental status line must sit near the top, where a reader sees it first.
const HEAD_LINES = 12
const STATUS = /^Status: (prototype|benchmark|adopted|abandoned), as of \d{4}-\d{2}-\d{2}\b/m
// Backticked paths from these repository roots are claims about the tree and must exist.
const REPO_PATH = /^(packages|specs|script|services|tools|mockups|docs|command-guard|patches|\.github|\.agents)\//

export function contentFindings(file: string, text: string): Finding[] {
  const prose = stripCode(text)
  const parts = file.split("/")
  const readme = parts.at(-1) === "README.md"
  // A system's main page is systems/<name>.md or systems/<name>/README.md.
  const systemPage = parts[0] === "systems" && ((parts.length === 2 && !readme) || (parts.length === 3 && readme))
  const bare = [...new Set(linkTargets(prose))].filter(
    (target) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target) && !/^\.\.?\//.test(target),
  )
  return [
    ...prose.split("\n").flatMap((line, number) => {
      const match = line.match(AGENT_FILE)
      return match ? [error(`${file}:${number + 1}: references an agent instruction file (${match[0]})`)] : []
    }),
    ...(bare.length > 0 ? [warning(`${file}: write relative links as ./ or ../: ${bare.slice(0, 3).join(", ")}`)] : []),
    ...(systemPage && !/^## Source( map)?\s*$/m.test(prose)
      ? [warning(`${file}: system page has no "## Source" section citing its implementation`)]
      : []),
    ...(parts[0] === "experimental" && !readme && !STATUS.test(text.split("\n").slice(0, HEAD_LINES).join("\n"))
      ? [warning(`${file}: no "Status: <prototype|benchmark|adopted|abandoned>, as of YYYY-MM-DD" line near the top`)]
      : []),
  ]
}

// Backticked repository paths ("see `packages/core/src/memory/index.ts`") are claims about the tree. Links are checked
// separately; this catches the inline mentions a rename leaves behind. Placeholders and globs are skipped.
export function sourcePathFindings(docs: Docs, file: string, text: string): Finding[] {
  const root = docs.root
  if (root === undefined) return []
  return stripCode(text, true)
    .split("\n")
    .flatMap((line, number) =>
      [...line.matchAll(/`([^`\s]+)`/g)].flatMap((match) => {
        const token = (match[1] ?? "")
          .replace(/[),.;:]+$/, "")
          .replace(/#.*$/, "")
          .replace(/:\d+(-\d+)?$/, "")
        if (!REPO_PATH.test(token) || /[<>*{}$]|\.\.\./.test(token)) return []
        return existsExactly(path.resolve(root, token), root)
          ? []
          : [error(`${file}:${number + 1}: \`${token}\` does not exist in the repository`)]
      }),
    )
}
