import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const source = path.resolve(process.argv[2] ?? "")
const target = path.resolve(process.argv[3] ?? "")
const upstream = path.resolve(process.argv[4] ?? "")

await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await cp(path.join(upstream, "LICENSE"), path.join(target, "LICENSE"))
await writeFile(
  path.join(target, "NOTICE"),
  "Contains official libpcap from The Tcpdump Group.\nThe build uses PCAP_TYPE=null and exposes only bounded memory-backed offline reading and filtering.\nRetain all acknowledgements and notices in the accompanying LICENSE.\n",
)
await writeFile(
  path.join(target, "dist/index.d.ts"),
  `export interface Packet { number: number; seconds: number; microseconds: number; capturedLength: number; originalLength: number; bytes: Uint8Array; bytesTruncated: boolean }\nexport interface CaptureResult { datalink?: number; datalinkName?: string; datalinkDescription?: string; offset?: number; packets?: Packet[]; nextOffset?: number | null; eof?: boolean; error?: string }\nexport interface Libpcap { inspectCapture(bytes: Uint8Array, filter: string, offset: number, limit: number, maxPacketBytes: number): CaptureResult }\nexport default function createLibpcap(options?: { locateFile?: (file: string) => string }): Promise<Libpcap>\n`,
)
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/libpcap-wasm",
      version: "1.10.6-turen.1",
      private: true,
      type: "module",
      description: "Turen-packaged official libpcap offline WebAssembly reader",
      main: "dist/libpcap.mjs",
      types: "dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/libpcap.mjs", default: "./dist/libpcap.mjs" } },
      files: ["dist/"],
      license: "BSD-3-Clause",
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
      upstream: "https://github.com/the-tcpdump-group/libpcap",
      version: "1.10.6",
      commit: process.env.LIBPCAP_COMMIT,
      emscripten: process.env.EMSDK_VERSION,
      configuration: "PCAP_TYPE=null; offline reader and numeric-only BPF filters",
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
