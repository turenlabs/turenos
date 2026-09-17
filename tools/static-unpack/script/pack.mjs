import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const targetRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const upxDist = path.resolve(process.argv[2] ?? "")
const mpressDist = path.resolve(process.argv[3] ?? "")
const target = path.resolve(process.argv[4] ?? "")
const upxSource = path.resolve(process.argv[5] ?? "")
const retdecSource = path.resolve(process.argv[6] ?? "")

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist/mpress"), { recursive: true })
await cp(upxDist, path.join(target, "dist"), { recursive: true })
await cp(mpressDist, path.join(target, "dist/mpress"), { recursive: true })
await rm(path.join(target, "dist/mpress/.gitignore"), { force: true })
await cp(path.join(targetRoot, "index.js"), path.join(target, "dist/index.js"))
await cp(path.join(targetRoot, "index.d.ts"), path.join(target, "dist/index.d.ts"))
await cp(path.join(upxSource, "LICENSE"), path.join(target, "UPX-LICENSE"))
await cp(path.join(upxSource, "COPYING"), path.join(target, "COPYING"))
await cp(path.join(retdecSource, "LICENSE"), path.join(target, "RETDEC-LICENSE"))
await writeFile(
  path.join(target, "NOTICE"),
  "UPX is GPL-2.0-or-later and is distributed as a separate unmodified WebAssembly program with complete corresponding source.\nThe MPRESS analysis-grade reconstructor is derived from MIT-licensed RetDec algorithms and does not link to UPX.\n",
)
execFileSync("tar", ["-czf", path.join(target, "upx-5.2.0-source.tar.gz"), "--exclude=.git", "--exclude=*/.git", "-C", path.dirname(upxSource), path.basename(upxSource)])
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/static-unpack-wasm",
      version: "5.2.0-turen.1",
      private: true,
      type: "module",
      description: "Turen bundled static UPX and MPRESS WebAssembly unpackers",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" } },
      files: ["dist/", "upx-5.2.0-source.tar.gz"],
      license: "GPL-2.0-or-later",
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
      upx: { upstream: "https://github.com/upx/upx", version: "5.2.0", commit: process.env.UPX_COMMIT, license: "GPL-2.0-or-later" },
      mpress: { upstream: "https://github.com/avast/retdec", version: "5.0", commit: process.env.RETDEC_COMMIT, license: "MIT", scope: "analysis-grade PE32 LZMAT/LZMA reconstruction" },
      emscripten: process.env.EMSDK_VERSION,
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
  files.filter((file) => path.basename(file) !== "SHA256SUMS").map(async (file) => `${createHash("sha256").update(await readFile(file)).digest("hex")}  ${path.relative(target, file)}`),
)
await writeFile(path.join(target, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`)

async function listFiles(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(file) : [file]
  }))).flat()
}
