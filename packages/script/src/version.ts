import { readdir } from "node:fs/promises"
import path from "path"
import semver from "semver"

const root = path.resolve(import.meta.dir, "../../..")

export const VERSION_FILE = path.join(root, "VERSION")

export const VERSIONED_PACKAGE_FILES = [
  "package.json",
  "packages/app/package.json",
  "packages/codemode/package.json",
  "packages/core/package.json",
  "packages/desktop/package.json",
  "packages/effect-drizzle-sqlite/package.json",
  "packages/effect-sqlite-node/package.json",
  "packages/forge/package.json",
  "packages/http-recorder/package.json",
  "packages/llm/package.json",
  "packages/plugin/package.json",
  "packages/sdk/js/package.json",
  "packages/script/package.json",
  "packages/server/package.json",
  "packages/session-ui/package.json",
  "packages/ui/package.json",
] as const

export const INDEPENDENTLY_VERSIONED_PACKAGE_FILES = [
  "command-guard/package.json",
  "packages/apk-dex-wasm/package.json",
  "packages/binary-diff-wasm/package.json",
  "packages/binwalk-scan-wasm/package.json",
  "packages/browser-artifacts-wasm/package.json",
  "packages/capa-match-wasm/package.json",
  "packages/code-signing-wasm/package.json",
  "packages/codec-wasm/package.json",
  "packages/crypto-markers-wasm/package.json",
  "packages/email-security-wasm/package.json",
  "packages/email-authenticate-wasm/package.json",
  "packages/firmware-formats-wasm/package.json",
  "packages/fuzzy-hash-wasm/package.json",
  "packages/ghidra-decompiler-wasm/package.json",
  "packages/git-inspect-wasm/package.json",
  "packages/goblin-wasm/package.json",
  "packages/image-inspect-wasm/package.json",
  "packages/installer-inspect-wasm/package.json",
  "packages/java-inspect-wasm/package.json",
  "packages/json-query-wasm/package.json",
  "packages/libpcap-wasm/package.json",
  "packages/macos-artifacts-wasm/package.json",
  "packages/minidump-wasm/package.json",
  "packages/monodis-wasm/package.json",
  "packages/pdf-inspect-wasm/package.json",
  "packages/rebuild-timeline-wasm/package.json",
  "packages/ripgrep-wasm/package.json",
  "packages/rtf-inspect-wasm/package.json",
  "packages/sourcemap-wasm/package.json",
  "packages/sqlite-inspect-wasm/package.json",
  "packages/squashfs-wasm/package.json",
  "packages/static-analysis-wasm/package.json",
  "packages/static-unpack-wasm/package.json",
  "packages/stng-core-wasm/package.json",
  "packages/unicode-audit-wasm/package.json",
  "packages/vigil-runtime/package.json",
  "packages/wasm-inspect-wasm/package.json",
  "packages/debug-symbols-wasm/package.json",
  "packages/protocol-inspect-wasm/package.json",
  "packages/wasm-toolkit-wasm/package.json",
  "packages/wifi-offline-wasm/package.json",
  "packages/windows-artifacts-wasm/package.json",
  "packages/yara-x-wasm/package.json",
] as const

export function parseVersion(value: string) {
  const version = value.trim()
  if (semver.valid(version) !== version) throw new Error(`Invalid TurenOS version: ${JSON.stringify(value)}`)
  return version
}

export function resolveVersion(input: { canonical: string; requested?: string; bump?: string }) {
  const canonical = parseVersion(input.canonical)
  if (input.bump) throw new Error("FORGE_BUMP is no longer supported; update VERSION explicitly")
  if (!input.requested) return canonical
  const requested = parseVersion(input.requested)
  if (requested !== canonical) {
    throw new Error(`FORGE_VERSION ${requested} does not match canonical VERSION ${canonical}`)
  }
  return canonical
}

export function resolveChannel(value?: string) {
  if (!value) return "dev" as const
  if (value === "latest") return "prod" as const
  if (value === "dev" || value === "beta" || value === "prod") return value
  throw new Error(`Invalid FORGE_CHANNEL: ${value}; expected dev, beta, or prod`)
}

export async function loadCanonicalVersion() {
  return parseVersion(await Bun.file(VERSION_FILE).text())
}

export async function discoverVersionedPackageFiles() {
  const ignored = new Set([
    ".git",
    ".turbo",
    ".vinxi",
    "build",
    "coverage",
    "dist",
    "experiments",
    "node_modules",
    "out",
    "scratch",
    "services",
    "target",
    "tools",
  ])

  async function scan(directory: string, relative: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    return (
      await Promise.all(
        entries
          .filter((entry) => !entry.isSymbolicLink())
          .flatMap((entry) => {
            const file = path.join(relative, entry.name)
            // Dot-directories hold nothing this repo ships and everything a
            // working tree accumulates: vendored reference checkouts under
            // `.forge`, scratch worktrees, tool caches. Scanning them made the
            // manifest set depend on whatever happened to be lying around, so
            // the check failed locally while passing on a fresh clone.
            if (entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name))
              return [scan(path.join(directory, entry.name), file)]
            if (!entry.isFile() || entry.name !== "package.json") return []
            return [
              Bun.file(path.join(directory, entry.name))
                .json()
                .then((value: { version?: unknown }) => (typeof value.version === "string" ? [file] : [])),
            ]
          }),
      )
    )
      .flat()
      .map((file) => file.split(path.sep).join("/"))
  }

  return (await scan(root, "")).sort()
}

export async function versionMismatches(version: string) {
  const discovered = await discoverVersionedPackageFiles()
  const tracked = new Set<string>(VERSIONED_PACKAGE_FILES)
  const independent = new Set<string>(INDEPENDENTLY_VERSIONED_PACKAGE_FILES)
  const untracked = discovered
    .filter((file) => !tracked.has(file) && !independent.has(file))
    .map((file) => `${file}: version-bearing manifest is not tracked by VERSIONED_PACKAGE_FILES`)
  const manifests = (
    await Promise.all(
      VERSIONED_PACKAGE_FILES.map(async (file) => {
        const value = (await Bun.file(path.join(root, file)).json()) as {
          version?: unknown
          private?: unknown
          publishConfig?: unknown
        }
        return [
          ...(value.version === version ? [] : [`${file}: expected ${version}, found ${String(value.version)}`]),
          ...publicationMismatches(file, value),
        ]
      }),
    )
  ).flat()

  const lockfile = await Bun.file(path.join(root, "bun.lock")).text()
  const workspace = VERSIONED_PACKAGE_FILES.filter((file) => file.startsWith("packages/"))
    .map((file) => file.slice(0, -"/package.json".length))
    .flatMap((directory) => {
      const start = lockfile.indexOf(`    "${directory}": {`)
      const end = lockfile.indexOf("\n    },", start)
      if (start < 0 || end < 0) return [`bun.lock: missing workspace ${directory}`]
      const block = lockfile.slice(start, end)
      if (block.includes(`"version": "${version}"`)) return []
      return [`bun.lock[${directory}]: expected ${version}`]
    })

  return [...untracked, ...manifests, ...workspace]
}

export function publicationMismatches(file: string, value: { private?: unknown; publishConfig?: unknown }) {
  return [
    ...(value.private === true ? [] : [`${file}: publishing is disabled for TurenOS packages; expected private: true`]),
    ...(value.publishConfig === undefined ? [] : [`${file}: publishing is disabled; remove publishConfig`]),
  ]
}
