import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = path.resolve(process.argv[2] ?? path.join(root, "../../packages/ghidra-decompiler-wasm"))
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(path.join(root, "dist"), path.join(target, "dist"), { recursive: true })
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/ghidra-decompiler-wasm",
      version: "0.1.0",
      private: true,
      description: "Turen-maintained Ghidra C++ decompiler built for WebAssembly",
      main: "dist/ghidra_decompiler.js",
      files: ["dist/"],
      license: "Apache-2.0",
      repository: "git+ssh://git@github.com/turenlabs/turenos.git",
    },
    null,
    2,
  )}\n`,
)
await cp(path.join(root, "LICENSE"), path.join(target, "LICENSE"))
await cp(path.join(root, "NOTICE"), path.join(target, "NOTICE"))
await writeFile(
  path.join(target, "SOURCE.json"),
  `${JSON.stringify(
    {
      upstream: "https://github.com/mauricelam/ghidra-decompiler",
      commit: "894191f76199a14bf3d34f31e68a2f0c697f8bdd",
      emscripten: "6.0.8",
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
