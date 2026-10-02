import type { Patch } from "./diff"
import { git, type Repo } from "./git"

type Kind = "env var" | "CLI option" | "constant" | "export"
// `name` is how code spells it, `doc` how a page would (`--dry-run` for the option `dry-run`).
export type Name = { kind: Kind; name: string; doc: string; file: string }
export type Constant = { file: string; name: string; from: string; to: string }

// When one name matches several patterns, the lowest rank names it.
const RANK: Record<Kind, number> = { "env var": 0, "CLI option": 1, constant: 2, export: 3 }
const PATTERNS: [Kind, RegExp][] = [
  ["env var", /\b(?:FORGE|TUREN)_[A-Z0-9][A-Z0-9_]*\b/g],
  ["env var", /process\.env(?:\.|\[["'`])([A-Z][A-Z0-9_]*)/g],
  ["CLI option", /\.option\(\s*["'`]([a-z][a-z0-9-]*)["'`]/g],
  ["constant", /\b(?:const|let|readonly)\s+([A-Z][A-Z0-9_]{2,})\b/g],
  [
    "export",
    /^\s*export\s+(?:(?:default|declare|abstract|async)\s+)*(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
  ],
  ["export", /^\s*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g],
]
const CONSTANT_VALUE = /\b(?:const|let|readonly)\s+([A-Z][A-Z0-9_]{2,})\b\s*(?::[^=]+)?=\s*(.+)$/

// Names on removed lines that no added line restores and no code at the head of the diff still contains.
export function removedNames(repo: Repo, patches: Patch[]) {
  const restored = new Set(found(patches, "added").map((item) => item.doc))
  const candidates = unique(found(patches, "removed").filter((item) => !restored.has(item.doc)))
  const stillInCode = present(
    repo,
    repo.head,
    candidates.map((item) => item.name),
    true,
  )
  return candidates.filter((item) => !stillInCode.has(item.name))
}

// Env vars and CLI options on added lines that no code at the merge base contains. Other kinds are too common to
// expect a page for each.
export function newNames(repo: Repo, patches: Patch[]) {
  const replaced = new Set(found(patches, "removed").map((item) => item.doc))
  const candidates = unique(found(patches, "added").filter((item) => !replaced.has(item.doc)))
  const env = candidates.filter((item) => item.kind === "env var")
  const options = candidates.filter((item) => item.kind === "CLI option")
  const envAtBase = present(
    repo,
    repo.mergeBase,
    env.map((item) => item.name),
    true,
  )
  const optionsAtBase = present(
    repo,
    repo.mergeBase,
    options.map((item) => `.option("${item.name}"`),
    false,
  )
  return [
    ...env.filter((item) => !envAtBase.has(item.name)),
    ...options.filter((item) => !optionsAtBase.has(`.option("${item.name}"`)),
  ]
}

// Upper-case constants assigned on both a removed and an added line of one file, with different values.
export function changedConstants(patches: Patch[]): Constant[] {
  return patches.flatMap((patch) => {
    const before = values(patch.removed)
    return [...values(patch.added)]
      .filter(([name, value]) => before.has(name) && before.get(name) !== value)
      .map(([name, value]) => ({ file: patch.file, name, from: before.get(name) ?? "", to: value }))
  })
}

function found(patches: Patch[], side: "added" | "removed") {
  return patches.flatMap((patch) => patch[side].flatMap((line) => identifiers(line, patch.file)))
}

function identifiers(line: string, file: string): Name[] {
  // A name in a comment line is prose about the code, not behavior.
  if (/^\s*(\/\/|\/\*|\*|#)/.test(line)) return []
  return PATTERNS.flatMap(([kind, pattern]) =>
    [...line.matchAll(pattern)].map((match) => {
      const name = match[1] ?? match[0]
      return { kind, name, doc: kind === "CLI option" ? `--${name}` : name, file }
    }),
  )
}

function unique(items: Name[]) {
  return [
    ...items
      .reduce((byName, item) => {
        const seen = byName.get(item.doc)
        return seen && RANK[seen.kind] <= RANK[item.kind] ? byName : byName.set(item.doc, item)
      }, new Map<string, Name>())
      .values(),
  ]
}

// Which terms occur in code (anything but Markdown) at a commit, or in the working tree when rev is undefined.
function present(repo: Repo, rev: string | undefined, terms: string[], word: boolean) {
  if (terms.length === 0) return new Set<string>()
  const output = git(
    repo.root,
    [
      "grep",
      "-h",
      "-o",
      "-I",
      "-F",
      ...(word ? ["-w"] : []),
      ...terms.flatMap((term) => ["-e", term]),
      ...(rev === undefined ? ["--untracked"] : [rev]),
      "--",
      ".",
      ":!*.md",
      ":!*.mdx",
    ],
    [1],
  )
  return new Set((output ?? "").split("\n"))
}

function values(lines: string[]) {
  return new Map(
    lines.flatMap((line) => {
      const match = CONSTANT_VALUE.exec(line)
      if (!match?.[1] || !match[2]) return []
      return [
        [
          match[1],
          match[2]
            .replace(/\s+\/\/.*$/, "")
            .replace(/[;,]\s*$/, "")
            .trim(),
        ] as const,
      ]
    }),
  )
}
