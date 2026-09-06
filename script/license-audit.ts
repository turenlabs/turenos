#!/usr/bin/env bun
import path from "node:path"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"

const root = path.resolve(import.meta.dir, "..")
const outputDirectory = path.join(root, "packages/desktop/resources/licenses")
const noticePath = path.join(outputDirectory, "THIRD_PARTY_NOTICES.txt")
const inventoryPath = path.join(outputDirectory, "THIRD_PARTY_LICENSES.json")
const write = process.argv.includes("--write")
const attributedWorkspacePackages = new Set([
  "@turenlabs/binwalk-scan-wasm",
  "@turenlabs/ghidra-decompiler-wasm",
  "@turenlabs/yara-x-wasm",
  "@turenlabs/email-security-wasm",
  "@turenlabs/email-authenticate-wasm",
  "@turenlabs/goblin-wasm",
  "@turenlabs/stng-core-wasm",
  "@turenlabs/libpcap-wasm",
  "@turenlabs/static-unpack-wasm",
  "@turenlabs/static-analysis-wasm",
  "@turenlabs/wifi-offline-wasm",
  "@turenlabs/windows-artifacts-wasm",
  "@turenlabs/rebuild-timeline-wasm",
  "@turenlabs/wasm-inspect-wasm",
  "@turenlabs/debug-symbols-wasm",
  "@turenlabs/protocol-inspect-wasm",
])
const sourceBundledCopyleftPackages = new Set(["@turenlabs/static-unpack-wasm"])

const workspaceRoots = [
  "packages/app",
  "packages/client",
  "packages/core",
  "packages/desktop",
  "packages/forge",
  "packages/llm",
  "packages/plugin",
  "packages/protocol",
  "packages/schema",
  "packages/sdk/js",
  "packages/server",
  "packages/session-ui",
  "packages/ui",
].map((directory) => path.join(root, directory))

type PackageJson = {
  readonly name?: string
  readonly version?: string
  readonly license?: string | { readonly type?: string }
  readonly licenses?: ReadonlyArray<{ readonly type?: string }>
  readonly homepage?: string
  readonly repository?: string | { readonly url?: string }
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}

type InventoryItem = {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly source?: string
  readonly licenseFiles: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const strings = (value: unknown) => {
  const entries = record(value)
  if (!entries) return undefined
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

const readPackage = (directory: string): PackageJson => {
  const value: unknown = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))
  const pkg = record(value)
  if (!pkg) throw new Error(`Invalid package manifest: ${directory}`)
  const repository = record(pkg.repository)
  const license = record(pkg.license)
  const peerMetadata = record(pkg.peerDependenciesMeta)
  return {
    name: typeof pkg.name === "string" ? pkg.name : undefined,
    version: typeof pkg.version === "string" ? pkg.version : undefined,
    license:
      typeof pkg.license === "string"
        ? pkg.license
        : license && typeof license.type === "string"
          ? { type: license.type }
          : undefined,
    licenses: Array.isArray(pkg.licenses)
      ? pkg.licenses.flatMap((item) => {
          const value = record(item)
          return value && typeof value.type === "string" ? [{ type: value.type }] : []
        })
      : undefined,
    homepage: typeof pkg.homepage === "string" ? pkg.homepage : undefined,
    repository:
      typeof pkg.repository === "string"
        ? pkg.repository
        : repository && typeof repository.url === "string"
          ? { url: repository.url }
          : undefined,
    dependencies: strings(pkg.dependencies),
    optionalDependencies: strings(pkg.optionalDependencies),
    peerDependencies: strings(pkg.peerDependencies),
    peerDependenciesMeta: peerMetadata
      ? Object.fromEntries(
          Object.entries(peerMetadata).flatMap(([name, item]) => {
            const metadata = record(item)
            return metadata ? [[name, { optional: metadata.optional === true }] as const] : []
          }),
        )
      : undefined,
  }
}

const packagePath = (name: string, from: string): string | undefined => {
  const segments = name.split("/")
  for (let directory = from; directory.startsWith(root); directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", ...segments)
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate)
    if (directory === root) return undefined
  }
  return undefined
}

const dependencyNames = (pkg: PackageJson) =>
  [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}).filter((name) => pkg.peerDependenciesMeta?.[name]?.optional !== true),
  ].filter((name, index, names) => names.indexOf(name) === index)

const source = (pkg: PackageJson) => {
  if (typeof pkg.repository === "string") return pkg.repository
  if (pkg.repository?.url) return pkg.repository.url
  return pkg.homepage
}

const sourceKey = (value: string | undefined) =>
  value
    ?.replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^git:\/\//, "https://")
    .replace(/^http:\/\//, "https://")
    .replace(/\.git$/, "")
    .replace(/^([^/:]+\/[^/]+)$/, "https://github.com/$1")

const license = (pkg: PackageJson, directory: string) => {
  if (typeof pkg.license === "string") return pkg.license
  if (pkg.license?.type) return pkg.license.type
  const values = (pkg.licenses ?? []).flatMap((item) => (item.type ? [item.type] : []))
  // khroma 2.1.0 omits manifest metadata; recognize only its exact shipped MIT notice.
  // https://github.com/fabiospampinato/khroma/blob/4968165afb0d3d09be66497e7985a34f7bfe6d42/license
  if (pkg.name === "khroma" && pkg.version === "2.1.0" && values.length === 0) {
    const file = path.join(directory, "license")
    if (
      existsSync(file) &&
      createHash("sha256").update(readFileSync(file)).digest("hex") ===
        "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49"
    )
      return "MIT"
  }
  return values.length === 0 ? "UNKNOWN" : values.join(" OR ")
}

const licenseFiles = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(path.join(directory, entry.name), "utf8")
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim(),
    }))
    .filter((file) => file.text.length > 0)
    .toSorted((a, b) => a.name.localeCompare(b.name))

const collect = () => {
  const queue = [...workspaceRoots, packagePath("electron", path.join(root, "packages/desktop"))].filter(
    (directory): directory is string => directory !== undefined,
  )
  const seen = new Set<string>()
  const packages = new Map<string, InventoryItem>()

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) continue
    const directory = realpathSync(next)
    if (seen.has(directory)) continue
    seen.add(directory)
    const pkg = readPackage(directory)

    if (pkg.name && pkg.version && (!pkg.name.startsWith("@turenlabs/") || attributedWorkspacePackages.has(pkg.name))) {
      const item = {
        name: pkg.name,
        version: pkg.version,
        license: license(pkg, directory),
        source: source(pkg),
        licenseFiles: licenseFiles(directory),
      }
      packages.set(`${item.name}@${item.version}`, item)
    }

    for (const name of dependencyNames(pkg)) {
      const dependency = packagePath(name, directory)
      if (dependency) queue.push(dependency)
    }
  }

  const collected = [...packages.values()]
  const donors = new Map(
    collected
      .filter((pkg) => pkg.licenseFiles.length > 0 && sourceKey(pkg.source))
      .map((pkg) => [`${sourceKey(pkg.source)}\0${pkg.license.toLowerCase()}`, pkg]),
  )
  return collected
    .map((pkg) => {
      if (pkg.licenseFiles.length > 0) return pkg
      const donor = donors.get(`${sourceKey(pkg.source)}\0${pkg.license.toLowerCase()}`)
      if (!donor) return pkg
      return {
        ...pkg,
        licenseFiles: donor.licenseFiles.map((file) => ({
          name: `${file.name} (from ${donor.name}@${donor.version})`,
          text: file.text,
        })),
      }
    })
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

const notice = (packages: ReadonlyArray<InventoryItem>) =>
  [
    "TurenOS third-party notices",
    "===========================",
    "",
    "This file is generated from the installed runtime dependency closure.",
    "Source packages remain governed by their respective license terms.",
    "",
    ...packages.flatMap((pkg) => [
      "--------------------------------------------------------------------------------",
      `${pkg.name}@${pkg.version}`,
      `License: ${pkg.license}`,
      ...(pkg.source ? [`Source: ${pkg.source}`] : []),
      "",
      ...(pkg.licenseFiles.length === 0
        ? ["The installed package did not include a top-level license or notice file.", ""]
        : pkg.licenseFiles.flatMap((file) => [`--- ${file.name} ---`, file.text, ""])),
    ]),
  ].join("\n")

const inventory = (packages: ReadonlyArray<InventoryItem>) =>
  `${JSON.stringify(
    {
      generatedBy: "script/license-audit.ts",
      scope: "TurenOS Desktop and runtime dependency closure",
      packages: packages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        source: pkg.source,
        licenseFiles: pkg.licenseFiles.map((file) => file.name),
      })),
    },
    undefined,
    2,
  )}\n`

const packages = collect()
const prohibited = packages.filter(
  (pkg) =>
    /AGPL|LGPL|GPL|SSPL|BUSL|UNLICENSED|UNKNOWN|SEE LICEN[CS]E|PROPRIETARY/i.test(pkg.license) &&
    !sourceBundledCopyleftPackages.has(pkg.name),
)
const unresolved = packages.filter((pkg) => pkg.license === "UNKNOWN" || pkg.licenseFiles.length === 0)

for (const name of sourceBundledCopyleftPackages) {
  const directory = packagePath(name, path.join(root, "packages/core"))
  if (!directory || !existsSync(path.join(directory, "upx-5.2.0-source.tar.gz"))) {
    console.error(`${name} must ship complete corresponding UPX source.`)
    process.exit(1)
  }
}

if (prohibited.length > 0) {
  console.error(
    `Prohibited or commercially licensed runtime dependencies:\n${prohibited.map((pkg) => `- ${pkg.name}@${pkg.version}: ${pkg.license}`).join("\n")}`,
  )
  process.exit(1)
}

const expectedNotice = notice(packages)
const expectedInventory = inventory(packages)
if (write) {
  await Bun.write(noticePath, expectedNotice)
  await Bun.write(inventoryPath, expectedInventory)
} else {
  const currentNotice = existsSync(noticePath) ? readFileSync(noticePath, "utf8") : ""
  const currentInventory = existsSync(inventoryPath) ? readFileSync(inventoryPath, "utf8") : ""
  const saved: unknown = currentInventory ? JSON.parse(currentInventory) : undefined
  const savedRecord = record(saved)
  const savedPackages = savedRecord && Array.isArray(savedRecord.packages) ? savedRecord.packages : []
  const recorded = savedPackages.flatMap((item) => {
    const pkg = record(item)
    if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string" || typeof pkg.license !== "string")
      return []
    return [{ name: pkg.name, version: pkg.version, license: pkg.license }]
  })
  const recordedPackages = new Map((recorded ?? []).map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]))
  const missing = packages.filter((pkg) => {
    const item = recordedPackages.get(`${pkg.name}@${pkg.version}`)
    return !item || item.license !== pkg.license || !currentNotice.includes(`${pkg.name}@${pkg.version}\n`)
  })
  if (missing.length > 0) {
    console.error("Third-party license artifacts are stale. Run `bun run license:generate`.")
    console.error(missing.map((pkg) => `- ${pkg.name}@${pkg.version}`).join("\n"))
    process.exit(1)
  }
}

console.log(
  `Checked ${packages.length} runtime packages (${unresolved.length} without complete installed license text).`,
)
