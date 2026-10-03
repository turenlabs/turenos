import path from "node:path"
import { existsSync } from "node:fs"

// The diff under review: from the merge base of `base` to `head`, or to the working tree when `head` is undefined.
export type Repo = { root: string; base: string; head: string | undefined; mergeBase: string; range: string[] }

export function openRepo(base: string, head: string | undefined): Repo {
  const root =
    Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
      .stdout.toString()
      .trim() || fail("not inside a git repository")
  const target = head ?? "HEAD"
  if (git(root, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`], [1]) === undefined)
    fail(`no such commit: ${target}`)
  const mergeBase =
    git(root, ["merge-base", base, target], [1])?.trim() ?? fail(`${base} and ${target} share no history`)
  return { root, base, head, mergeBase, range: head === undefined ? [mergeBase] : [mergeBase, head] }
}

// Exit codes in `quiet` mean "no result"; any other failure stops the run, because an empty answer from a failed
// search would read as "nothing cites this" or "removed from the code".
export function git(root: string, args: string[], quiet: number[] = []): string | undefined {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return result.stdout.toString()
  if (quiet.includes(result.exitCode)) return undefined
  return fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
}

export function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

// New, unignored files count as added when diffing to the working tree.
export function newFiles(repo: Repo, ...pathspecs: string[]): string[] {
  if (repo.head !== undefined) return []
  return (
    git(repo.root, [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ]) ?? ""
  )
    .split("\0")
    .filter((file) => file.length > 0)
}

// Text of a new file, or "" for a binary or one over 1 MiB.
export async function textOf(repo: Repo, file: string) {
  const blob = Bun.file(path.join(repo.root, file))
  if (blob.size > 1024 * 1024) return ""
  const text = await blob.text()
  return text.includes("\0") ? "" : text
}

export function existsAtHead(repo: Repo, folder: string) {
  if (repo.head === undefined) return existsSync(path.join(repo.root, folder))
  return git(repo.root, ["cat-file", "-e", `${repo.head}:${folder}`], [1, 128]) !== undefined
}
