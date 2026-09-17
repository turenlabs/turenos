import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.resolve(process.argv[2] ?? path.join(root, "target/wasm32-unknown-unknown/release/turen_binwalk_scan_wasm.wasm"))
const target = path.resolve(process.argv[3] ?? path.join(root, "artifact"))

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist/turen_binwalk_scan_wasm_bg.wasm"))
await cp(path.join(root, "runtime/turen_binwalk_scan_wasm.js"), path.join(target, "dist/turen_binwalk_scan_wasm.js"))
await cp(path.join(root, "runtime/turen_binwalk_scan_wasm.d.ts"), path.join(target, "dist/turen_binwalk_scan_wasm.d.ts"))
await writeFile(
  path.join(target, "dist/package.json"),
  `${JSON.stringify(
    {
      name: "turen-binwalk-scan-wasm",
      version: "0.1.0",
      license: "Apache-2.0 OR MIT",
      type: "module",
      main: "turen_binwalk_scan_wasm.js",
      types: "turen_binwalk_scan_wasm.d.ts",
    },
    null,
    2,
  )}\n`,
)
await cp(path.join(root, "README.md"), path.join(target, "dist/README.md"))
await cp(path.join(root, "LICENSE"), path.join(target, "dist/LICENSE"))
await cp(path.join(root, "LICENSE"), path.join(target, "LICENSE"))
await cp(path.join(root, "NOTICE"), path.join(target, "NOTICE"))
await cp(path.join(root, "README.md"), path.join(target, "README.md"))
await cp(path.join(root, "SOURCE.json"), path.join(target, "SOURCE.json"))
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/binwalk-scan-wasm",
      version: "0.1.0",
      private: true,
      license: "MIT OR Apache-2.0",
      type: "module",
      files: ["dist/", "LICENSE", "NOTICE", "README.md", "SOURCE.json", "SHA256SUMS"],
      exports: "./dist/turen_binwalk_scan_wasm.js",
    },
    null,
    2,
  )}\n`,
)

const names = (await filesUnder(target)).filter((name) => name !== "SHA256SUMS")
const hashes = await Promise.all(names.map(async (name) => `${await hash(path.join(target, name))}  ${name}`))
await writeFile(path.join(target, "SHA256SUMS"), `${hashes.sort().join("\n")}\n`)

async function filesUnder(directory, prefix = "") {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const name = path.join(prefix, entry.name)
        return entry.isDirectory() ? filesUnder(directory, name) : [name]
      }),
    )
  ).flat()
}

async function hash(file) {
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(await readFile(file)).digest("hex")
}
