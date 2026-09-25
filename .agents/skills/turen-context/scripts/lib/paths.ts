// Backticked tokens that look like repository paths must exist, relative to the instruction file or one of its
// ancestors.

import path from "node:path"
import { existsSync } from "node:fs"
import { error, note, warning, type Finding } from "./findings"
import { ancestorDirs, type Repo } from "./repo"

const FILE_EXTS = new Set(
  "md mdx ts tsx js jsx mjs cjs json jsonc yaml yml toml py go rs java kt rb php cs sh sql lock txt html css scss env ini cfg conf xml gradle mod sum swift c h cc cpp hpp vue svelte proto".split(
    " ",
  ),
)
const BARE_FILES = new Set(["Makefile", "Dockerfile", "justfile", "Justfile", "Procfile", "Gemfile", "Brewfile"])
const SPECIFIER_EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rs", "/index.ts", "/index.js"]

export function pathFinding(repo: Repo, file: string, raw: string): Finding[] {
  const token =
    raw
      .replace(/:\d+(:\d+)?$/, "")
      .split("#")[0]
      ?.replace(/[.,;]+$/, "") ?? ""
  if (!looksLikePath(token) || token.startsWith("/") || token.startsWith("~")) return []
  if (/(^|[/._-])(foo|bar|baz|example|my|your)([/._-]|$)/i.test(token)) return []
  const clean = token.replace(/\/+$/, "")
  const stripped = clean.replace(/^(\.\.?\/)+/, "")
  const folder = path.posix.dirname(file)
  // Nested files name paths relative to their own area, so any folder from this file up to the root is a valid base.
  const bases = [folder, ...ancestorDirs(folder)].map((dir) => path.join(repo.root, dir))
  if (clean.includes("*")) {
    const glob = new Bun.Glob(`{,**/}${stripped}`)
    return repo.tracked.some((candidate) => glob.match(candidate))
      ? []
      : [note(file, `glob \`${token}\` matches no tracked files`)]
  }
  if (bases.some((base) => SPECIFIER_EXTS.some((ext) => existsSync(path.join(base, clean + ext))))) return []
  const hits = SPECIFIER_EXTS.map((ext) => suffixHits(repo, stripped + ext)).find((found) => found.length > 0) ?? []
  if (hits.length > 0 && !clean.includes("/")) return []
  // Inside a nested file's own subtree, one match is unambiguous for an agent working there.
  const inScope = folder !== "." && hits.length === 1 && hits.every((hit) => hit.startsWith(`${folder}/`))
  if (inScope) return []
  if (hits.length > 0) {
    return [
      warning(
        file,
        `\`${token}\` is not relative to this file or the root; it exists at ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? " ..." : ""}. Name the package so the path is unambiguous`,
      ),
    ]
  }
  const first = stripped.split("/")[0] ?? ""
  // A missing path is only a confident finding when it names a file, is explicitly relative, or starts in an existing
  // folder beside this file. Otherwise it may be an MCP method, route, package or range such as `patches/0001-0004`.
  const strong = hasFileExt(clean) || clean !== stripped || existsSync(path.join(repo.root, folder, first))
  return strong
    ? [error(file, `\`${token}\` does not exist`)]
    : [note(file, `\`${token}\` is not a path in this repo (a package, route, repo slug or placeholder?)`)]
}

export function hasFileExt(token: string) {
  const name = token.replace(/\/+$/, "").split("/").at(-1) ?? ""
  return BARE_FILES.has(name) || (name.includes(".") && FILE_EXTS.has(name.split(".").at(-1) ?? ""))
}

function looksLikePath(token: string) {
  if (token === "" || /[\s<>{}$()|;=,"'\\]|:\/\/|::/.test(token) || /^[-@$]/.test(token)) return false
  if (token.includes("/")) return /^[~./\w*-]+$/.test(token) && !/^\d/.test(token)
  return hasFileExt(token)
}

// Tracked paths that end with this suffix, for tokens written relative to some other package.
function suffixHits(repo: Repo, suffix: string) {
  const needle = `/${suffix}/`
  return [
    ...new Set(
      repo.tracked.flatMap((file) => {
        const padded = `/${file}/`
        const at = padded.indexOf(needle)
        return at === -1 ? [] : [padded.slice(1, at + needle.length - 1)]
      }),
    ),
  ]
}
