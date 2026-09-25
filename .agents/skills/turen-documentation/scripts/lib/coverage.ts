import path from "node:path"
import { readFileSync } from "node:fs"
import type { Docs } from "./docs"

// Workspace packages that no page names. Each is a candidate blind spot to review, not an error: some packages are
// documented by their own README on purpose.
export function coverageNotes(docs: Docs) {
  const root = docs.root
  if (root === undefined) return []
  const corpus = [...docs.pages.values()].join("\n")
  return workspaces(root)
    .toSorted((left, right) => left.localeCompare(right))
    .filter((area) => {
      const name = path.posix.basename(area)
      return !corpus.includes(`${area}/`) && !corpus.includes(`${area}\``) && !corpus.includes(`@turenlabs/${name}`)
    })
    .map((area) => `no docs page mentions ${area}`)
}

// The folders the root package.json declares as workspaces, minus generated WASM packages.
function workspaces(root: string) {
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  const declared =
    typeof manifest === "object" && manifest !== null && "workspaces" in manifest ? manifest.workspaces : undefined
  // `workspaces` is either a list of globs or an object whose `packages` holds them.
  const globs = (
    Array.isArray(declared)
      ? declared
      : typeof declared === "object" && declared !== null && "packages" in declared && Array.isArray(declared.packages)
        ? declared.packages
        : []
  ).filter((glob): glob is string => typeof glob === "string")
  return [
    ...new Set(
      globs.flatMap((glob) =>
        [...new Bun.Glob(`${glob.replace(/\/+$/, "")}/package.json`).scanSync({ cwd: root })].map((file) =>
          path.posix.dirname(file.split(path.sep).join("/")),
        ),
      ),
    ),
  ].filter((area) => !area.endsWith("-wasm") && !area.includes("node_modules/"))
}
