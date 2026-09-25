// Rules for each graded AGENTS.md: load budget, size, parent pointers, @mentions, links, emphasis and upstream names,
// plus lines repeated across files.

import path from "node:path"
import { existsSync } from "node:fs"
import { commandFindings } from "./commands"
import { error, note, warning, type Finding } from "./findings"
import { bareMentions, codeSpans, stripFences } from "./markdown"
import { pathFinding } from "./paths"
import { ancestors, chainBytes, type Repo } from "./repo"

// Codex stops adding instruction files once the root-to-directory chain reaches this many bytes (its default).
const CODEX_BUDGET = 32 * 1024
const LINE_GUIDANCE = 200

export function fileFindings(repo: Repo, file: string): Finding[] {
  const text = repo.texts.get(file) ?? ""
  const prose = stripFences(text)
  const lines = text.split("\n").length
  const chain = chainBytes(repo, file)
  const unreferenced =
    file !== "AGENTS.md" &&
    !ancestors(repo, file).some((parent) => {
      const parentText = repo.texts.get(parent) ?? ""
      return parentText.includes(file) || parentText.includes(path.posix.relative(path.posix.dirname(parent), file))
    })
  return [
    ...(chain > CODEX_BUDGET
      ? [
          error(
            file,
            `chain is ${chain} B, over Codex's ${CODEX_BUDGET} B budget: Codex stops adding instruction files there, so this file loads partly or not at all. Slim it, split it deeper, or move repo-wide lines to the root`,
          ),
        ]
      : chain > CODEX_BUDGET * 0.8
        ? [
            warning(
              file,
              `chain is ${chain} B, ${Math.round((chain / CODEX_BUDGET) * 100)}% of Codex's ${CODEX_BUDGET} B budget`,
            ),
          ]
        : []),
    ...(lines > LINE_GUIDANCE ? [warning(file, `${lines} lines, over the ${LINE_GUIDANCE}-line guidance`)] : []),
    ...(unreferenced
      ? [
          warning(
            file,
            `no ancestor AGENTS.md mentions \`${file}\`; Codex sessions started above this folder never load it, so add a "follow \`${file}\` when working in ${path.posix.dirname(file)}/" line to its parent`,
          ),
        ]
      : []),
    ...[...new Set(bareMentions(prose))].map((mention) =>
      warning(file, `bare \`@${mention}\` outside code: Claude Code treats it as a file import; wrap it in backticks`),
    ),
    ...[...new Set(codeSpans(prose))].flatMap((token) => pathFinding(repo, file, token)),
    ...commandFindings(repo, file, text),
    ...[...new Set([...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ""))]
      .filter((target) => target !== "" && !/^([a-z][a-z0-9+.-]*:|#)/i.test(target))
      .filter((target) => !existsSync(path.resolve(repo.root, path.posix.dirname(file), target.split("#")[0] ?? "")))
      .map((target) => error(file, `broken link: ${target}`)),
    ...emphasisFindings(file, prose),
    ...upstreamFindings(file, prose),
  ]
}

export function duplicateFindings(repo: Repo): Finding[] {
  const seen = new Map<string, Set<string>>()
  repo.graded.forEach((file) =>
    stripFences(repo.texts.get(file) ?? "")
      .split("\n")
      .map((line) =>
        line
          .replace(/^[\s>*#-]+/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((line) => line.length >= 40)
      .forEach((line) => seen.set(line, new Set([...(seen.get(line) ?? []), file]))),
  )
  return [...seen]
    .filter((entry) => entry[1].size > 1)
    .map((entry) =>
      warning(
        "",
        `repeated in ${[...entry[1]].join(", ")}: "${entry[0].slice(0, 90)}". Keep it in the deepest file where it is true`,
      ),
    )
}

function emphasisFindings(file: string, prose: string): Finding[] {
  const words = [...prose.matchAll(/\b(IMPORTANT|MUST|NEVER|ALWAYS|CRITICAL|REQUIRED)\b/g)].length
  return words >= 6 ? [note(file, `${words} all-caps emphasis words; when everything is emphasized, nothing is`)] : []
}

// Lines inherited from OpenCode name commands, APIs and hosts that TurenOS never shipped (`opencode dev web`,
// `opencode.tools.register`). TurenOS spells its own identifiers `forge` or TurenOS, so any OpenCode name needs checking.
function upstreamFindings(file: string, prose: string): Finding[] {
  return prose
    .split("\n")
    .flatMap((line, number) =>
      /\bopencode\b/i.test(line)
        ? [
            warning(
              file,
              `line ${number + 1} names OpenCode, the upstream product; confirm the command, API or path exists in TurenOS or remove the line`,
            ),
          ]
        : [],
    )
}
