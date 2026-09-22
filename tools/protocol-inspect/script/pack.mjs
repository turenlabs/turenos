import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const source = path.resolve(process.argv[2] ?? "")
const target = path.resolve(process.argv[3] ?? "")
const license = path.resolve(process.argv[4] ?? path.join(path.dirname(source), "../LICENSE"))

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
await cp(license, path.join(target, "LICENSE"))
await writeFile(
  path.join(target, "NOTICE"),
  "This package contains Turen's bounded offline protocol-inspection WebAssembly operations. It vendors etherparse 0.21.0 and related permissive Rust dependencies.\n",
)
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/protocol-inspect-wasm",
      version: "0.1.0-turen.1",
      private: true,
      type: "module",
      description: "Turen-packaged bounded offline packet and protocol inspection WebAssembly",
      main: "dist/turen_protocol_inspect_wasm.js",
      types: "dist/turen_protocol_inspect_wasm.d.ts",
      exports: {
        ".": {
          types: "./dist/turen_protocol_inspect_wasm.d.ts",
          import: "./dist/turen_protocol_inspect_wasm.js",
          default: "./dist/turen_protocol_inspect_wasm.js",
        },
      },
      files: ["dist/"],
      license: "MIT",
      repository: "git+ssh://git@github.com/turenlabs/turenos.git",
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  path.join(target, "SOURCE.json"),
  `${JSON.stringify(
    {
      crate: "turen-protocol-inspect-wasm",
      sourceRevision: process.env.GITHUB_SHA,
      dependencies: {
        etherparse: {
          version: "0.21.0",
          sourceRevision: "70f72bee542ae49efebb8d2106bde64f84f02a43",
          checksum: "17304d06addb3283cdc4bd528e42dd95e73c8ee2d6492ffce415e93660885449",
        },
      },
      rust: process.env.RUST_TOOLCHAIN,
      wasmPack: process.env.WASM_PACK_VERSION,
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
