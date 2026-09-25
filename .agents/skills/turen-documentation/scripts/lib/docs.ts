import path from "node:path"
import { existsSync } from "node:fs"
import { git, listed } from "./git"
import { isPage } from "./markdown"

// Declared rather than inferred so type-aware lint keeps string types where Bun's type definitions aren't installed.
export type Docs = {
  dir: string
  root: string | undefined
  // The docs folder as the repository names it, usually "docs".
  home: string | undefined
  files: string[]
  pages: Map<string, string>
  sections: Map<string, string[]>
}

// One snapshot of the docs tree that every rule reads: its files, page texts, the repository around it, and the
// section table from SKILL.md.
export async function loadDocs(dir: string): Promise<Docs> {
  const root = git(dir, "rev-parse", "--show-toplevel")
  const files = (await listFiles(dir, root))
    .map((file) => file.split(path.sep).join("/"))
    // Names starting with "." or "_" belong to site generators and editors, not to the docs.
    .filter((file) => !file.split("/").some((part) => part.startsWith(".") || part.startsWith("_")))
    .toSorted()
  return {
    dir,
    root,
    home: root === undefined ? undefined : path.relative(root, dir).split(path.sep).join("/"),
    files,
    pages: new Map(
      await Promise.all(
        files.filter(isPage).map(async (file) => [file, await Bun.file(path.join(dir, file)).text()] as const),
      ),
    ),
    sections: await readSections(),
  }
}

// Outside a repository, every file counts.
async function listFiles(dir: string, root: string | undefined): Promise<string[]> {
  if (root === undefined) return Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true }))
  return listed(dir, ".").filter((file) => existsSync(path.join(dir, file)))
}

// SKILL.md's section table is the single source of truth for which top-level folders docs/ may hold.
async function readSections() {
  const skill = await Bun.file(path.join(import.meta.dir, "..", "..", "SKILL.md")).text()
  const table = skill.match(/^## The `docs\/` sections$([\s\S]*?)(?=^## )/m)?.[1] ?? ""
  const rows = [...table.matchAll(/^\|\s*`([a-z0-9-]+)\/`\s*\|([^|]*)\|/gm)]
  if (rows.length === 0) throw new Error("could not read the section table from SKILL.md")
  // "yes: `README.md`" lists required pages; anything else means the section is optional.
  return new Map(
    rows.map((row) => {
      const required = row[2] ?? ""
      const pages = required.trim().startsWith("yes")
        ? [...required.matchAll(/`([^`]+)`/g)].map((page) => page[1] ?? "")
        : []
      return [row[1] ?? "", pages] as const
    }),
  )
}
