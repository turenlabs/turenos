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
  "This package contains Turen's bounded wifi-offline WebAssembly operations.\nIt vendors pcap-file, ieee80211, and radiotap.\n",
)
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/wifi-offline-wasm",
      version: "0.1.0-turen.1",
      private: true,
      type: "module",
      description: "Offline 802.11 capture summary for Turen",
      main: "dist/turen_wifi_offline_wasm.js",
      types: "dist/turen_wifi_offline_wasm.d.ts",
      exports: {
        ".": {
          types: "./dist/turen_wifi_offline_wasm.d.ts",
          import: "./dist/turen_wifi_offline_wasm.js",
          default: "./dist/turen_wifi_offline_wasm.js",
        },
      },
      files: ["dist/"],
      license: "MIT",
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
      crate: "turen-wifi-offline-wasm",
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
