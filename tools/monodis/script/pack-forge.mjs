import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = path.resolve(process.argv[2] ?? path.join(root, "../../packages/monodis-wasm"))
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(path.join(root, "dist"), path.join(target, "dist"), { recursive: true })
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/monodis-wasm",
      version: "0.1.0",
      private: true,
      description: "Turen-maintained Mono monodis CIL disassembler built for WebAssembly",
      main: "dist/monodis.js",
      files: ["dist/"],
      license: "MIT",
      repository: "git+ssh://git@github.com/turenlabs/turenos.git",
    },
    null,
    2,
  )}\n`,
)
await cp(path.join(root, "NOTICE"), path.join(target, "NOTICE"))
await cp(path.join(root, "upstream/mono/LICENSE"), path.join(target, "LICENSE-MONO"))
await cp(path.join(root, "upstream/mono/PATENTS.TXT"), path.join(target, "PATENTS-MONO"))
await writeFile(
  path.join(target, "SOURCE.json"),
  `${JSON.stringify(
    {
      upstream: "https://github.com/mono/mono",
      commit: "0f53e9e151d92944cacab3e24ac359410c606df6",
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
