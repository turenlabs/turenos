import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const source = path.resolve(process.argv[2] ?? "")
const target = path.resolve(process.argv[3] ?? "")
const license = path.resolve(process.argv[4] ?? path.join(path.dirname(source), "../LICENSE"))

// Overlay pack: replace only the extension payload and preserve the checked-in
// base runtime (package.json, dist/turen_static_analysis_wasm.*, source-106).
const overlay = [
  "dist/extensions",
  "LICENSE-EXTENSIONS",
  "LICENSE-DIE",
  "THIRD-PARTY-106.txt",
  "NOTICE-EXTENSIONS",
  "EXTENSION.json",
  "SOURCE-EXTENSIONS.json",
]
for (const entry of overlay) await rm(path.join(target, entry), { recursive: true, force: true })
await mkdir(path.join(target, "dist/extensions"), { recursive: true })
await cp(source, path.join(target, "dist/extensions"), { recursive: true })
await rm(path.join(target, "dist/extensions/.gitignore"), { force: true })
await cp(license, path.join(target, "LICENSE-EXTENSIONS"))
for (const file of ["LICENSE-DIE", "THIRD-PARTY-106.txt"])
  await cp(path.join(path.dirname(source), file), path.join(target, file))
await writeFile(
  path.join(target, "NOTICE-EXTENSIONS"),
  "Overlay this artifact onto an existing @turenlabs/static-analysis-wasm workspace package. Keep its legacy dist runtime and package.json unchanged. The extension requires a 256 MiB WASM memory maximum and a fresh timeout-bounded host worker. See LICENSE-DIE and THIRD-PARTY-106.txt for upstream notices.\n",
)
await writeFile(
  path.join(target, "EXTENSION.json"),
  `${JSON.stringify(
    {
      target: "@turenlabs/static-analysis-wasm",
      format: "overlay",
      runtime: "dist/extensions/turen_static_analysis_wasm.js",
      memoryMaximumBytes: 268435456,
      preserve: ["package.json", "dist/turen_static_analysis_wasm.js", "dist/turen_static_analysis_wasm_bg.wasm"],
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  path.join(target, "SOURCE-EXTENSIONS.json"),
  `${JSON.stringify(
    {
      crate: "turen-static-analysis-wasm",
      sourceCommit: process.env.GITHUB_SHA,
      dependencies: {
        cfb: "0.10.0",
        quickXml: "0.38.3",
        zip: "4.6.1",
      },
      rust: process.env.RUST_TOOLCHAIN,
      wasmPack: process.env.WASM_PACK_VERSION,
      run: process.env.GITHUB_RUN_ID,
    },
    null,
    2,
  )}\n`,
)

const files = (
  await Promise.all(
    overlay.map(async (entry) => {
      const full = path.join(target, entry)
      return (await stat(full)).isDirectory() ? listFiles(full) : [full]
    }),
  )
).flat()
const checksums = await Promise.all(
  files.map(async (file) => `${createHash("sha256").update(await readFile(file)).digest("hex")}  ${path.relative(target, file)}`),
)
await writeFile(path.join(target, "SHA256SUMS.extensions"), `${checksums.sort().join("\n")}\n`)

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
