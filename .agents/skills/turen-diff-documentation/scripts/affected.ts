#!/usr/bin/env bun
// Maps a branch's diff to the Markdown it can make wrong: docs/ pages, specs, READMEs and AGENTS.md files. It lists
// Markdown that cites a file the diff deleted, renamed or changed, or names an env var, CLI option, export or
// upper-case constant the diff removed or changed, plus new env vars and CLI options that no Markdown mentions.
// It proves references only; whether a cited claim is still true comes from reading the new code (../SKILL.md).
// Exits 1 when Markdown still cites a deleted or renamed file, or names an identifier the diff removed from the code,
// and 2 when it can't read the diff. Read-only. The rules live in lib/: git.ts (the range), diff.ts (changed files
// and lines), names.ts (identifiers) and mentions.ts (where Markdown cites them).
//
// The diff runs from the merge base of <base> (default origin/main) to the working tree, so uncommitted and new files
// count. With --head <rev> it runs to that commit instead, for a branch that isn't checked out.
//
// usage: bun .agents/skills/turen-diff-documentation/scripts/affected.ts [base] [--head <rev>]

import { changes, isMarkdown, NOT_SOURCE, parents, patches, STATUS, type Change } from "./lib/diff"
import { existsAtHead, fail, openRepo } from "./lib/git"
import { cites, mentions, type Hit } from "./lib/mentions"
import { changedConstants, newNames, removedNames, type Constant } from "./lib/names"

const args = process.argv.slice(2)
const headFlag = args.indexOf("--head")
if (headFlag !== -1 && args[headFlag + 1] === undefined) fail("usage: affected.ts [base] [--head <rev>]")
const repo = openRepo(
  args.find((arg, index) => !arg.startsWith("--") && (headFlag === -1 || index !== headFlag + 1)) ?? "origin/main",
  headFlag === -1 ? undefined : args[headFlag + 1],
)

const changed = changes(repo)
const gone = new Map<string, string>(
  changed.flatMap((change) => {
    if (change.status === "D") return [[change.path, "deleted in this diff"] as const]
    if (change.status === "R" && change.from !== undefined)
      return [[change.from, `renamed to \`${change.path}\` in this diff`] as const]
    return []
  }),
)
const goneFolders = [...new Set([...gone.keys()].flatMap(parents))].filter((folder) => !existsAtHead(repo, folder))
const changedCode = changed.filter(
  (change) => change.status !== "D" && !isMarkdown(change.path) && !NOT_SOURCE.test(change.path),
)
const lines = await patches(repo)
const removed = removedNames(repo, lines)
const added = newNames(repo, lines)
const constants = changedConstants(lines)

const hits = mentions(repo, [
  ...gone.keys(),
  ...goneFolders,
  ...changedCode.map((change) => change.path),
  ...removed.map((item) => item.doc),
  ...added.map((item) => item.doc),
  ...constants.map((constant) => constant.name),
])
const stale = hits.flatMap((hit) => [
  ...[...gone]
    .filter(([file]) => cites(hit.text, file, "file"))
    .map(([file, why]) => `${hit.at} cites \`${file}\`, ${why}`),
  ...goneFolders
    .filter((folder) => cites(hit.text, folder, "folder"))
    .map((folder) => `${hit.at} cites \`${folder}\`, a folder this diff removed`),
  ...removed
    .filter((item) => cites(hit.text, item.doc, "name"))
    .map((item) => `${hit.at} names \`${item.doc}\`, the ${item.kind} this diff removed from \`${item.file}\``),
])
const citing = Map.groupBy(
  hits.flatMap((hit) =>
    changedCode.filter((change) => cites(hit.text, change.path, "file")).map((change) => ({ hit, change })),
  ),
  (entry) => entry.hit.file,
)
const undocumented = added.filter((item) => !hits.some((hit) => cites(hit.text, item.doc, "name")))
const markdown = changed
  .filter((change) => isMarkdown(change.path) && !NOT_SOURCE.test(change.path))
  .sort((a, b) => a.path.localeCompare(b.path))

const counts = Object.entries(Object.groupBy(changed, (change) => STATUS[change.status] ?? change.status))
console.log(
  `# Docs affected by ${repo.base}...${repo.head ?? "the working tree"} (merge base ${repo.mergeBase.slice(0, 10)})`,
)
console.log(
  `${changed.length} files changed${counts.length > 0 ? ": " : ""}${counts.map(([status, list]) => `${list?.length ?? 0} ${status}`).join(", ")}`,
)
section(`Stale references (fix these): ${stale.length}`, [...new Set(stale)].sort())
section(
  `Pages citing changed code (re-read their claims against it): ${citing.size}`,
  [...citing].sort(([a], [b]) => a.localeCompare(b)).map(([page, entries]) => pageEntry(page, entries, constants)),
)
section(
  `Changed constants: ${constants.length}`,
  constants.map((constant) => {
    const named = hits.filter((hit) => cites(hit.text, constant.name, "name")).map((hit) => hit.at)
    const where = named.length > 0 ? `; named at ${named.join(", ")}` : ""
    return `\`${constant.file}\`: \`${constant.name}\` ${constant.from} -> ${constant.to}${where}`
  }),
)
section(
  `New env vars and CLI options no Markdown mentions: ${undocumented.length}`,
  undocumented.map((item) => `\`${item.doc}\` (${item.kind}) in \`${item.file}\``),
)
section(
  `Markdown changed in this diff (verify every edited claim): ${markdown.length}`,
  markdown.map((change) => `\`${change.path}\` (${STATUS[change.status] ?? change.status})`),
)
console.log(
  "\nThese are references only. Read each listed page against the new code, and read the diff for behavior no name or path reveals (SKILL.md).",
)
process.exit(stale.length > 0 ? 1 : 0)

function pageEntry(page: string, entries: { hit: Hit; change: Change }[], constants: Constant[]) {
  return [
    `\`${page}\``,
    ...[...Map.groupBy(entries, (entry) => entry.change.path)].map(([file, list]) => {
      const lines = [...new Set(list.map((entry) => entry.hit.line))]
      const status = STATUS[list[0]?.change.status ?? ""] ?? "changed"
      const values = constants
        .filter((constant) => constant.file === file)
        .map((constant) => `; \`${constant.name}\` ${constant.from} -> ${constant.to}`)
        .join("")
      return `  - \`${file}\` (${status}), line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}${values}`
    }),
  ].join("\n")
}

function section(title: string, items: string[]) {
  console.log(`\n## ${title}`)
  items.forEach((item) => console.log(`- ${item}`))
}
