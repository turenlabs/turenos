// Pack the wasm-pack output plus target docs/provenance into a Forge-ready
// artifact directory with a complete SHA256SUMS manifest.
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const source = path.resolve(process.argv[2] ?? "")
const target = path.resolve(process.argv[3] ?? "")
const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
for (const file of ["LICENSE", "NOTICE", "README.md", "SOURCE.json"]) {
  await cp(path.join(tool, file), path.join(target, file))
}
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/code-signing-wasm",
      version: "0.1.0-turen.1",
      private: true,
      type: "module",
      description: "Turen-packaged bounded code-signing and PKI structure inspector",
      main: "dist/turen_code_signing_wasm.js",
      types: "dist/turen_code_signing_wasm.d.ts",
      exports: {
        ".": {
          types: "./dist/turen_code_signing_wasm.d.ts",
          import: "./dist/turen_code_signing_wasm.js",
          default: "./dist/turen_code_signing_wasm.js",
        },
      },
      files: ["dist/"],
      license: "Apache-2.0 OR MIT",
      repository: "git+ssh://git@github.com/turenlabs/turenos.git",
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
