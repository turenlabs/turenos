// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
export function git(cwd: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}
