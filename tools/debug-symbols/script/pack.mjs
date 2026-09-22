import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.resolve(process.argv[2] ?? path.join(root, "pkg"))
const target = path.resolve(process.argv[3] ?? path.join(root, "artifact"))

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
for (const file of ["LICENSE", "NOTICE", "README.md", "SOURCE.json"]) await cp(path.join(root, file), path.join(target, file))
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify({
    name: "@turenlabs/debug-symbols-wasm",
    version: "0.1.0",
    private: true,
    type: "module",
    description: "TurenOS bounded DWARF, PDB, and symbol inspection",
    main: "dist/turen_debug_symbols_wasm.js",
    types: "dist/turen_debug_symbols_wasm.d.ts",
    license: "MIT OR Apache-2.0",
    repository: "git+ssh://git@github.com/turenlabs/turenos.git",
    files: ["dist/", "LICENSE", "NOTICE", "README.md", "SOURCE.json", "SHA256SUMS"],
    exports: {
      ".": {
        types: "./dist/turen_debug_symbols_wasm.d.ts",
        import: "./dist/turen_debug_symbols_wasm.js",
        default: "./dist/turen_debug_symbols_wasm.js",
      },
    },
  }, null, 2)}\n`,
)
const names = (await filesUnder(target)).filter((file) => file !== "SHA256SUMS")
const hashes = await Promise.all(
  names.map(async (file) => `${createHash("sha256").update(await readFile(path.join(target, file))).digest("hex")}  ${file}`),
)
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
