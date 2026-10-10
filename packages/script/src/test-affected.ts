import path from "node:path"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

type Manifest = {
  name?: string
  scripts?: { test?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

type Package = { directory: string; manifest: Manifest }

export function selectAffected(root: string, options: { base: string; head?: string; includeWorkingTree: boolean }) {
  const repository = readJson<Manifest & { workspaces?: { packages?: string[] } }>(path.join(root, "package.json"))
  const packages: Package[] = []
  for (const pattern of repository.workspaces?.packages ?? []) {
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      const directory = path.dirname(file).replaceAll("\\", "/")
      packages.push({ directory, manifest: readJson(path.join(root, file)) })
    }
  }
  packages.sort((a, b) => a.directory.localeCompare(b.directory))
  const tested = packages.filter((pkg) => pkg.manifest.scripts?.test)
  const allTestDirectories = tested.map((pkg) => pkg.directory)
  const fallback = (reason: string, changedPaths: string[] = []) => ({
    base: options.base,
    head: options.head ?? "HEAD",
    changedPaths: changedPaths.sort(),
    selected: allTestDirectories,
    fallbackReason: reason,
  })

  const head = options.head ?? "HEAD"
  const mergeBase = git(root, ["merge-base", options.base, head])
  if (!mergeBase.ok) return fallback(`Cannot find merge base for ${options.base} and ${head}`)
  const changed = git(root, ["diff", "--name-only", "-z", "--no-renames", mergeBase.text.trim(), head])
  if (!changed.ok) return fallback("Git could not list changed paths")
  const changedPaths = changed.text.split("\0").filter(Boolean)
  if (options.includeWorkingTree) {
    const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
    if (!status.ok) return fallback("Git could not read worktree status", changedPaths)
    const entries = status.text.split("\0").filter(Boolean)
    for (const entry of entries) changedPaths.push(entry.slice(3))
  }

  const uniquePaths = [...new Set(changedPaths)].sort()
  if (uniquePaths.some((file) => isSharedPath(file)))
    return fallback("Shared configuration or workspace metadata changed", uniquePaths)

  const byName = new Map(packages.flatMap((pkg) => (pkg.manifest.name ? [[pkg.manifest.name, pkg] as const] : [])))
  const consumers = new Map<string, Set<string>>()
  for (const pkg of packages) {
    const dependencies = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
      ...pkg.manifest.optionalDependencies,
      ...pkg.manifest.peerDependencies,
    }
    for (const [dependency, range] of Object.entries(dependencies)) {
      const target = byName.get(dependency)
      if (!target && (range.startsWith("workspace:") || range.startsWith("file:") || range.startsWith("link:")))
        return fallback(`Cannot resolve local dependency ${dependency} in ${pkg.directory}`)
      if (!target) continue
      if (!consumers.has(target.directory)) consumers.set(target.directory, new Set())
      consumers.get(target.directory)!.add(pkg.directory)
    }
  }

  const changedPackages = new Set<string>()
  for (const file of uniquePaths) {
    if (isDocumentation(file)) continue
    const matched = [...packages]
      .sort((a, b) => b.directory.length - a.directory.length)
      .find((pkg) => file === pkg.directory || file.startsWith(`${pkg.directory}/`))
    if (!matched) return fallback(`Changed path is outside a known package: ${file}`, uniquePaths)
    if (file === `${matched.directory}/package.json`)
      return fallback(`Workspace manifest changed: ${file}`, uniquePaths)
    changedPackages.add(matched.directory)
  }

  const affected = new Set(changedPackages)
  const queue = [...changedPackages]
  while (queue.length) {
    const current = queue.shift()!
    for (const consumer of consumers.get(current) ?? []) {
      if (affected.has(consumer)) continue
      affected.add(consumer)
      queue.push(consumer)
    }
  }
  return {
    base: options.base,
    head,
    changedPaths: uniquePaths,
    selected: tested.filter((pkg) => affected.has(pkg.directory)).map((pkg) => pkg.directory),
    fallbackReason: null as string | null,
  }
}

function readJson<T = Manifest>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  return { ok: result.exitCode === 0, text: new TextDecoder().decode(result.stdout) }
}

function isSharedPath(file: string) {
  return (
    file === "package.json" ||
    file === "bun.lock" ||
    file === "bun.lockb" ||
    file.startsWith(".github/") ||
    file.startsWith("script/") ||
    file.startsWith("tools/") ||
    file.startsWith("patches/") ||
    file === "turbo.json" ||
    file.startsWith("tsconfig")
  )
}

function isDocumentation(file: string) {
  return file.startsWith("docs/") || file === "README.md"
}

export async function runTests(root: string, directories: string[]) {
  const failures: string[] = []
  for (const directory of directories) {
    const child = Bun.spawn([process.execPath, "run", "test"], {
      cwd: path.join(root, directory),
      stdio: ["inherit", "inherit", "inherit"],
    })
    if ((await child.exited) !== 0) failures.push(directory)
  }
  return failures
}

if (import.meta.main) {
  const options = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean" },
      run: { type: "boolean" },
      help: { type: "boolean" },
      base: { type: "string", default: "main" },
      head: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }).values
  if (options.help) {
    console.log("Usage: bun run test:affected [--json] [--run] [--base <ref>] [--head <ref>]")
    console.log(
      "Defaults to main..HEAD plus staged, unstaged, and untracked changes. --head compares committed trees only.",
    )
    process.exit(0)
  }
  if (options.base!.startsWith("-") || options.head?.startsWith("-")) throw new Error("Git refs cannot start with '-'")
  const root = path.resolve(import.meta.dir, "../../..").replaceAll("\\", "/")
  if (options.run && options.head) throw new Error("--run cannot be combined with --head")
  const result = selectAffected(root, {
    base: options.base!,
    head: options.head,
    includeWorkingTree: options.head === undefined,
  })
  console.log(
    options.json
      ? JSON.stringify(result)
      : [
          `Affected tests: ${result.selected.length}`,
          ...result.selected.map((directory) => `  ${directory}`),
          `Changed paths: ${result.changedPaths.length}`,
          result.fallbackReason ? `Fallback: ${result.fallbackReason}` : "Fallback: none",
        ].join("\n"),
  )
  if (!options.run) process.exit(0)
  const failures = await runTests(root, result.selected)
  if (failures.length) throw new Error(`Failed suites: ${failures.join(", ")}`)
}
