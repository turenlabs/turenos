import { git, type Repo } from "./git"

// Markdown that can document TurenOS: everything tracked or new, minus vendored trees and generated notices.
const MARKDOWN = [
  "*.md",
  "*.mdx",
  ":!*vendor/*",
  ":!*node_modules/*",
  ":!Third-Party-Notices.md",
  ":!packages/*-wasm/dist/*",
]

export type Hit = { file: string; at: string; line: string; text: string }

// Markdown lines, at the head of the diff, that contain any of the terms. Use `cites` to keep whole-token matches.
export function mentions(repo: Repo, terms: string[]): Hit[] {
  const distinct = [...new Set(terms)]
  if (distinct.length === 0) return []
  const output = git(
    repo.root,
    [
      "-c",
      "core.quotePath=false",
      "grep",
      "-n",
      "-I",
      "-F",
      ...distinct.flatMap((term) => ["-e", term]),
      ...(repo.head === undefined ? ["--untracked"] : [repo.head]),
      "--",
      ...MARKDOWN,
    ],
    [1],
  )
  // At a commit, git grep prefixes each line with `<rev>:`.
  const prefix = repo.head === undefined ? 0 : repo.head.length + 1
  return (output ?? "")
    .split("\n")
    .map((line) => line.slice(prefix))
    .flatMap((line) => {
      const match = /^(.*?):(\d+):(.*)$/.exec(line)
      if (!match?.[1] || !match[2]) return []
      return [{ file: match[1], at: `${match[1]}:${match[2]}`, line: match[2], text: match[3] ?? "" }]
    })
}

// A path or name counts only as a whole token: `src/a.ts` doesn't match `src/a.tsx`, `FORGE_X` doesn't match
// `FORGE_XY`, and a folder doesn't match the files inside it.
export function cites(text: string, term: string, kind: "file" | "folder" | "name") {
  const before = kind === "name" ? /[\w$]$/ : /[\w-]$/
  const after = kind === "name" ? /^[\w$-]/ : kind === "file" ? /^([\w-]|\.\w)/ : /^([\w-]|\.\w|\/[\w.-])/
  return [...text.matchAll(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].some(
    (match) => !before.test(text.slice(0, match.index)) && !after.test(text.slice(match.index + term.length)),
  )
}
