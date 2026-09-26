import path from "node:path"
import { existsSync, readdirSync } from "node:fs"

const listings = new Map<string, Set<string>>()

// Whether a path exists with exactly this letter case. macOS and Windows filesystems ignore case but GitHub doesn't, so
// a link to `./Foo.md` that finds `foo.md` locally is broken for every reader. Each segment below `stop` is compared
// against its folder's real listing; paths outside `stop` fall back to a plain existence check.
export function existsExactly(file: string, stop: string): boolean {
  if (!existsSync(file)) return false
  const parent = path.dirname(file)
  if (file === stop || parent === file || !file.startsWith(stop + path.sep)) return true
  const names = listings.get(parent) ?? new Set(readdirSync(parent))
  listings.set(parent, names)
  return names.has(path.basename(file)) && existsExactly(parent, stop)
}
