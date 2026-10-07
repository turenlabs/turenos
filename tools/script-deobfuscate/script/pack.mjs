import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.resolve(process.argv[2] ?? path.join(root, "pkg"))
const target = path.resolve(process.argv[3] ?? path.join(root, "artifact", "script-deobfuscate-wasm"))
await mkdir(path.join(target, "dist"), { recursive: true })
for (const name of [
  "turen_script_deobfuscate_wasm.js",
  "turen_script_deobfuscate_wasm.d.ts",
  "turen_script_deobfuscate_wasm_bg.wasm",
  "turen_script_deobfuscate_wasm_bg.wasm.d.ts",
])
  await writeFile(path.join(target, "dist", name), await readFile(path.join(source, name)))
for (const name of ["LICENSE", "LICENSE-OXC", "NOTICE", "README.md"]) {
  const output = name === "LICENSE-OXC" || name === "NOTICE" ? `${name}.txt` : name
  await writeFile(path.join(target, output), await readFile(path.join(root, name)))
  if (output !== name) await rm(path.join(target, name), { force: true })
}
await writeFile(
  path.join(target, "cli.mjs"),
  generated(await readFile(path.join(root, "script", "cli.mjs"), "utf8"), "script/cli.mjs"),
  { mode: 0o755 },
)
await writeFile(
  path.join(target, "cli-worker.mjs"),
  generated(await readFile(path.join(root, "script", "cli-worker.mjs"), "utf8"), "script/cli-worker.mjs"),
)
await writeFile(path.join(target, "dist", "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n")
await writeFile(
  path.join(target, "package.json"),
  JSON.stringify(
    {
      name: "@turenlabs/script-deobfuscate-wasm",
      version: "0.1.0",
      private: true,
      license: "MIT",
      type: "module",
      exports: "./dist/turen_script_deobfuscate_wasm.js",
      bin: { "script-deobfuscate": "./cli.mjs" },
      files: [
        "dist/",
        "cli.mjs",
        "cli-worker.mjs",
        "licenses/",
        "LICENSE",
        "LICENSE-OXC.txt",
        "NOTICE.txt",
        "README.md",
        "SOURCE.json",
        "SHA256SUMS",
        "THIRD_PARTY_LICENSES.json",
      ],
    },
    null,
    2,
  ) + "\n",
)

const metadata = spawnSync(
  "cargo",
  [
    "+1.97.1",
    "metadata",
    "--offline",
    "--locked",
    "--format-version",
    "1",
    "--filter-platform",
    "wasm32-unknown-unknown",
    "--manifest-path",
    path.join(root, "Cargo.toml"),
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
)
if (metadata.status !== 0) throw new Error(metadata.stderr || "Unable to read locked dependency provenance")
const dependencies = JSON.parse(metadata.stdout)
  .packages.filter((item) => item.source)
  .sort((a, b) => a.name.localeCompare(b.name))
const inventory = []
for (const item of dependencies) {
  const directory = path.dirname(item.manifest_path)
  const texts = (await readdir(directory)).filter((name) => /^(license|licence|copying|notice|copyright)/i.test(name))
  const files = []
  for (const name of texts) {
    const contents = await readFile(path.join(directory, name)).catch(() => undefined)
    if (!contents) continue
    const original = `licenses/${item.name}-${item.version}/${name}`
    const relative = original.endsWith(".txt") ? original : `${original}.txt`
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true })
    await writeFile(path.join(target, relative), contents)
    if (relative !== original) await rm(path.join(target, original), { force: true })
    files.push(relative)
  }
  if (item.name.startsWith("oxc_") && files.length === 0) files.push("LICENSE-OXC.txt")
  inventory.push({ crate: item.name, version: item.version, license: item.license, files })
}
await writeFile(path.join(target, "THIRD_PARTY_LICENSES.json"), JSON.stringify(inventory, null, 2) + "\n")
const provenance = JSON.parse(await readFile(path.join(root, "SOURCE.json"), "utf8"))
provenance.cargoLockSha256 = createHash("sha256")
  .update(await readFile(path.join(root, "Cargo.lock")))
  .digest("hex")
provenance.run = process.env.GITHUB_RUN_ID ?? null
await writeFile(path.join(target, "SOURCE.json"), JSON.stringify(provenance, null, 2) + "\n")

async function filesUnder(directory, prefix = "") {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const name = path.posix.join(prefix, entry.name)
        return entry.isDirectory() ? filesUnder(directory, name) : name === "SHA256SUMS" ? [] : [name]
      }),
    )
  ).flat()
}
function generated(code, origin) {
  const header = `// @generated from tools/script-deobfuscate/${origin}. Do not edit.\n`
  if (!code.startsWith("#!")) return header + code
  const line = code.indexOf("\n") + 1
  return code.slice(0, line) + header + code.slice(line)
}

const lines = await Promise.all(
  (await filesUnder(target)).map(
    async (name) =>
      `${createHash("sha256")
        .update(await readFile(path.join(target, name)))
        .digest("hex")}  ${name}`,
  ),
)
await writeFile(path.join(target, "SHA256SUMS"), lines.sort().join("\n") + "\n")
