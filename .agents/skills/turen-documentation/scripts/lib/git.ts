// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
export function git(cwd: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

// Git's view of the tree: tracked plus new, unignored files, so ignored generated output never counts.
export function listed(cwd: string, ...pathspecs: string[]): string[] {
  return (git(cwd, "ls-files", "--cached", "--others", "--exclude-standard", ...pathspecs) ?? "")
    .split("\n")
    .filter((file) => file.length > 0)
}
