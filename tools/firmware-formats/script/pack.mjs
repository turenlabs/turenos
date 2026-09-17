import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDirectory, "..")
const source = path.resolve(process.argv[2] ?? path.join(root, "pkg"))
const target = path.resolve(process.argv[3] ?? path.join(root, "artifact"))

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
await cp(path.join(root, "LICENSE"), path.join(target, "LICENSE"))
await cp(path.join(root, "NOTICE"), path.join(target, "NOTICE"))
await cp(path.join(root, "README.md"), path.join(target, "README.md"))

const sourceMetadata = JSON.parse(await readFile(path.join(root, "SOURCE.json"), "utf8"))
sourceMetadata.sourceCommit = process.env.GITHUB_SHA ?? sourceMetadata.sourceCommit
sourceMetadata.workflowRun = process.env.GITHUB_RUN_ID ?? sourceMetadata.workflowRun
await writeFile(path.join(target, "SOURCE.json"), `${JSON.stringify(sourceMetadata, null, 2)}\n`)
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/firmware-formats-wasm",
      version: "0.1.0-turen.1",
      private: true,
      type: "module",
      description: "TurenOS bounded embedded/firmware format decoders",
      main: "dist/turen_firmware_formats_wasm.js",
      types: "dist/turen_firmware_formats_wasm.d.ts",
      exports: {
        ".": {
          types: "./dist/turen_firmware_formats_wasm.d.ts",
          import: "./dist/turen_firmware_formats_wasm.js",
          default: "./dist/turen_firmware_formats_wasm.js",
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

const names = (await filesUnder(target)).filter((name) => name !== "SHA256SUMS")
const hashes = await Promise.all(
  names.map(async (name) => `${await hash(path.join(target, name))}  ${name}`),
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

async function hash(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}
