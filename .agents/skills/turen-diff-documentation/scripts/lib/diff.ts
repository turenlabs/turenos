import { git, newFiles, textOf, type Repo } from "./git"

export const STATUS: Record<string, string> = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "type changed",
}
// Vendored, generated and lock files: a change to one is never what a page needs re-reading for.
export const NOT_SOURCE =
  /(^|\/)(vendor|node_modules|generated|generated-effect)\/|(^|\/)generated\.ts$|\.gen\.ts$|\.lock$|lock\.json$|^Third-Party-Notices\.md$|^packages\/[^/]+-wasm\/dist\//
// Changed lines in these files are not behavior a page documents, so they contribute no names.
const NOT_BEHAVIOR = [
  ":!*.md",
  ":!*.mdx",
  ":!*.lock",
  ":!*lock.json",
  ":!*/test/*",
  ":!*.test.*",
  ":!*.spec.*",
  ":!*/generated/*",
  ":!*/generated-effect/*",
  ":!*/generated.ts",
  ":!*.gen.ts",
]

export type Change = { status: string; path: string; from: string | undefined }
export type Patch = { file: string; added: string[]; removed: string[] }

// Every changed file, with renames detected. A rename keeps its old path in `from`.
export function changes(repo: Repo): Change[] {
  return [
    ...(git(repo.root, ["-c", "core.quotePath=false", "diff", "--name-status", "-M", ...repo.range]) ?? "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [status = "", first = "", second] = line.split("\t")
        return { status: status.slice(0, 1), path: second ?? first, from: second === undefined ? undefined : first }
      }),
    ...newFiles(repo).map((file) => ({ status: "A", path: file, from: undefined })),
  ]
}

// Added and removed lines of every file whose changes can be behavior; a new file is all added lines.
export async function patches(repo: Repo): Promise<Patch[]> {
  const diff = git(repo.root, [
    "-c",
    "core.quotePath=false",
    "diff",
    "-U0",
    "-M",
    "--no-color",
    "--no-ext-diff",
    ...repo.range,
    "--",
    ".",
    ...NOT_BEHAVIOR,
  ])
  const untracked = await Promise.all(
    newFiles(repo, ".", ...NOT_BEHAVIOR).map(async (file) => ({
      file,
      added: (await textOf(repo, file)).split("\n"),
      removed: [],
    })),
  )
  return [...sections(diff ?? ""), ...untracked]
}

export function isMarkdown(file: string) {
  return /\.mdx?$/.test(file)
}

// Folders of at least two segments; a bare `src` or `packages` would match unrelated prose.
export function parents(file: string) {
  const parts = file.split("/").slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join("/")).filter((folder) => folder.includes("/"))
}

function sections(patch: string): Patch[] {
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => {
      const lines = section.split("\n")
      const header = lines.find((line) => line.startsWith("+++ b/")) ?? lines.find((line) => line.startsWith("--- a/"))
      const start = lines.findIndex((line) => line.startsWith("@@"))
      const body = start === -1 ? [] : lines.slice(start)
      return {
        file: (header ?? "").slice(6).replace(/\t$/, ""),
        added: body.filter((line) => line.startsWith("+")).map((line) => line.slice(1)),
        removed: body.filter((line) => line.startsWith("-")).map((line) => line.slice(1)),
      }
    })
}
