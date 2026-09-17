import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// node script/pack.mjs <wasm-pack pkg dir> <artifact output dir>
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.resolve(process.argv[2] ?? path.join(root, "pkg"))
const target = path.resolve(process.argv[3] ?? path.join(root, "artifact"))

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
for (const file of ["LICENSE", "NOTICE", "README.md", "SOURCE.json"]) {
  await cp(path.join(root, file), path.join(target, file))
  await cp(path.join(root, file), path.join(target, "dist", file))
}
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/macos-artifacts-wasm",
      version: "0.1.0-turen.1",
      private: true,
      type: "module",
      description: "Bounded offline macOS forensic artifact parser for Turen",
      main: "dist/turen_macos_artifacts_wasm.js",
      types: "dist/turen_macos_artifacts_wasm.d.ts",
      exports: {
        ".": {
          types: "./dist/turen_macos_artifacts_wasm.d.ts",
          import: "./dist/turen_macos_artifacts_wasm.js",
          default: "./dist/turen_macos_artifacts_wasm.js",
        },
      },
      files: ["dist/", "LICENSE", "NOTICE", "README.md", "SOURCE.json", "SHA256SUMS"],
      license: "Apache-2.0 OR MIT",
      repository: "git+ssh://git@github.com/turenio/turen.git",
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  path.join(target, "SOURCE.provenance.json"),
  `${JSON.stringify(
    {
      rust: process.env.RUST_TOOLCHAIN ?? null,
      wasmPack: process.env.WASM_PACK_VERSION ?? null,
      run: process.env.GITHUB_RUN_ID ?? null,
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
