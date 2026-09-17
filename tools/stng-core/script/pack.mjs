import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const source = path.resolve(process.argv[2] ?? "")
const target = path.resolve(process.argv[3] ?? "")
const upstream = path.resolve(process.argv[4] ?? "")

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
await cp(path.join(upstream, "LICENSE"), path.join(target, "LICENSE"))
await writeFile(
  path.join(target, "NOTICE"),
  "Portable stng-core subset derived from stng by The Atomdrift Project.\nTuren removed host, cache, Rizin, CLI and parallel boundaries and added aggregate limits.\n",
)
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/stng-core-wasm",
      version: "1.9.0-turen.1",
      private: true,
      type: "module",
      description: "Turen portable bounded stng-core WebAssembly string extractor",
      main: "dist/turen_stng_core_wasm.js",
      types: "dist/turen_stng_core_wasm.d.ts",
      exports: { ".": { types: "./dist/turen_stng_core_wasm.d.ts", import: "./dist/turen_stng_core_wasm.js", default: "./dist/turen_stng_core_wasm.js" } },
      files: ["dist/"],
      license: "Apache-2.0",
      repository: "git+ssh://git@github.com/turenio/turen.git",
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  path.join(target, "SOURCE.json"),
  `${JSON.stringify(
    {
      upstream: "https://github.com/atomdrift-project/stng",
      version: "1.9.0",
      commit: process.env.STNG_COMMIT,
      rust: process.env.RUST_TOOLCHAIN,
      wasmPack: process.env.WASM_PACK_VERSION,
      scope: "portable raw, wide, decoder, classification and XOR subset",
      run: process.env.GITHUB_RUN_ID,
    },
    null,
    2,
  )}\n`,
)

const files = await listFiles(target)
const checksums = await Promise.all(
  files
    .filter((file) => path.basename(file) !== "SHA256SUMS")
    .map(async (file) => `${createHash("sha256").update(await readFile(file)).digest("hex")}  ${path.relative(target, file)}`),
)
await writeFile(path.join(target, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`)

async function listFiles(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => {
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? listFiles(file) : [file]
      }),
    )
  ).flat()
}
