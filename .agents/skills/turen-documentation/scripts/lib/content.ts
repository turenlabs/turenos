// Rules about what a single page says: page conventions from SKILL.md and backticked repository paths.

import path from "node:path"
import { existsSync } from "node:fs"
import type { Docs } from "./docs"
import { error, warning, type Finding } from "./findings"
import { linkTargets, stripCode } from "./markdown"

const AGENT_FILE = /CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.claude\/rules/
const MAX_LINES = 300
const LONG_PAGE_MARKER = "<!-- long-page: reference -->"
// The marker and the experimental status line must sit near the top, where a reader sees them first.
const HEAD_LINES = 12
const STATUS = /^Status: (prototype|benchmark|adopted|abandoned), as of \d{4}-\d{2}-\d{2}\b/m
// Backticked paths from these repository roots are claims about the tree and must exist.
const REPO_PATH = /^(packages|specs|script|services|tools|mockups|docs|command-guard|patches|\.github|\.agents)\//
// Capitalized function words are the reliable sign of a Title Case heading; product names never need them.
const SMALL_WORDS = new Set("A An And As At By For From In Into Of On Or The To Vs With Without".split(" "))

export function contentFindings(file: string, text: string): Finding[] {
  const prose = stripCode(text)
  const lines = text.split("\n")
  const head = lines.slice(0, HEAD_LINES).join("\n")
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
    ...[...prose.matchAll(/^## ((?:known|current) limits)\s*$/gim)].map((match) =>
      warning(`${file}: rename "## ${match[1]}" to "## Limits"`),
    ),
    ...(systemPage && !/^## Source( map)?\s*$/m.test(prose)
      ? [warning(`${file}: system page has no "## Source" section citing its implementation`)]
      : []),
    // Past MAX_LINES a page gets a review: one topic stays (reference pages opt out with the marker), several split.
    ...(lines.length > MAX_LINES && !head.includes(LONG_PAGE_MARKER)
      ? [
          warning(
            `${file}: ${lines.length} lines. If it covers several topics, split it along its ## sections (move.ts, then split.ts); if it is one reference topic, add ${LONG_PAGE_MARKER} in its first ${HEAD_LINES} lines`,
          ),
        ]
      : []),
    ...(parts[0] === "experimental" && !readme && !STATUS.test(head)
      ? [warning(`${file}: no "Status: <prototype|benchmark|adopted|abandoned>, as of YYYY-MM-DD" line near the top`)]
      : []),
    ...[...prose.matchAll(/^#{1,4}\s+(.+?)\s*#*\s*$/gm)]
      .filter((match) => titleCase(match[1] ?? ""))
      .map((match) => warning(`${file}: heading "${match[1]}" is Title Case; use sentence case`)),
    ...linkTextFindings(file, stripCode(text, true)),
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
        return existsSync(path.join(root, token))
          ? []
          : [error(`${file}:${number + 1}: \`${token}\` does not exist in the repository`)]
      }),
    )
}

// "Create An Automation" and "Existing Plaintext Migration" are Title Case; "Claude Code tool routing" and
// "MCP credentials" are not. Code spans and tokens that don't start with a letter are ignored.
function titleCase(heading: string) {
  const words = heading
    .replace(/`[^`]*`/g, "")
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
  if (words.slice(1).some((word) => SMALL_WORDS.has(word))) return true
  return words.length >= 3 && words.every((word) => /^[A-Z]/.test(word))
}

// After a page moves into a folder, links keep text such as `secure-storage.md` while the target becomes
// secure-storage/README.md. Link text that names a Markdown file must name the file it points to.
function linkTextFindings(file: string, prose: string): Finding[] {
  return [...prose.matchAll(/\[`?([\w./-]+\.mdx?)`?\]\(([^)\s#]+)(#[^)]*)?\)/g)].flatMap((match) => {
    const named = (match[1] ?? "").split("/")
    const target = (match[2] ?? "").split("/")
    // A README is named by its folder, so `quality-gate/README.md` must point into quality-gate/.
    const folderDiffers =
      named.at(-1) === "README.md" && named.length > 1 && target.length > 1 && named.at(-2) !== target.at(-2)
    return named.at(-1) === target.at(-1) && !folderDiffers
      ? []
      : [warning(`${file}: link text \`${match[1]}\` does not match its target ${match[2]}`)]
  })
}
