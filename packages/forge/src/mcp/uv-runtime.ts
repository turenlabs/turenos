import crypto from "node:crypto"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { Global } from "@turenlabs/core/global"

const VERSION = "0.12.6"
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
const executeFile = promisify(execFile)

const targets = {
  "darwin-arm64": {
    name: "uv-aarch64-apple-darwin.tar.gz",
    directory: "uv-aarch64-apple-darwin",
    sha256: "14b459d51ea2e71eeba28c45a268c922bdf8607fc6455e3f40b4e082895d160d",
  },
  "darwin-x64": {
    name: "uv-x86_64-apple-darwin.tar.gz",
    directory: "uv-x86_64-apple-darwin",
    sha256: "2a26ea71bbeff1c7e12c2cc40245c96a041deff276bc921e7038e304d5d3e04c",
  },
  "linux-arm64": {
    name: "uv-aarch64-unknown-linux-gnu.tar.gz",
    directory: "uv-aarch64-unknown-linux-gnu",
    sha256: "d58030acd26159499ac82f32da12d1b3c12a3a1bfc414232d9082070c03e128d",
  },
  "linux-x64": {
    name: "uv-x86_64-unknown-linux-gnu.tar.gz",
    directory: "uv-x86_64-unknown-linux-gnu",
    sha256: "8681d8921e7d520fb368991dcf5f9c1905b80f5bf2a265a0ed085c8d8e342477",
  },
  "win32-arm64": {
    name: "uv-aarch64-pc-windows-msvc.zip",
    directory: "uv-aarch64-pc-windows-msvc",
    sha256: "6dda514fbbe3152d980758e0f6347116060114d7d24932fc0ea5d8063f8b253a",
  },
  "win32-x64": {
    name: "uv-x86_64-pc-windows-msvc.zip",
    directory: "uv-x86_64-pc-windows-msvc",
    sha256: "df7cb9f243eae1621400d4fcf5b1b3d90f20e264ece91b64deb3b0078abca6ef",
  },
} as const

type Target = (typeof targets)[keyof typeof targets]
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type EnsureUvOptions = {
  readonly platform?: NodeJS.Platform
  readonly arch?: NodeJS.Architecture
  readonly fetch?: Fetch
  readonly extract?: (archive: string, directory: string) => Promise<void>
  readonly binaryPath?: string
  readonly maxArchiveBytes?: number
}

let inflight: Promise<string | undefined> | undefined

export function uvTarget(platform = process.platform, arch = process.arch): Target | undefined {
  return targets[`${platform}-${arch}` as keyof typeof targets]
}

export function uvBinaryPath(platform = process.platform) {
  return path.join(Global.Path.bin, `uv-${VERSION}${platform === "win32" ? ".exe" : ""}`)
}

export async function ensureUvBinary(options?: EnsureUvOptions) {
  const platform = options?.platform ?? process.platform
  const target = uvTarget(platform, options?.arch)
  if (!target) return undefined
  const binary = options?.binaryPath ?? uvBinaryPath(platform)
  if (await executable(binary)) return binary
  if (inflight) return inflight
  const pending = downloadUv(target, platform, binary, options)
    .catch(() => undefined)
    .finally(() => {
      if (inflight === pending) inflight = undefined
    })
  inflight = pending
  return pending
}

async function downloadUv(target: Target, platform: NodeJS.Platform, binary: string, options?: EnsureUvOptions) {
  const url = `https://releases.astral.sh/github/uv/releases/download/${VERSION}/${target.name}`
  const response = await (options?.fetch ?? fetch)(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`uv download failed with HTTP ${response.status}`)
  const maxArchiveBytes = options?.maxArchiveBytes ?? MAX_ARCHIVE_BYTES
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxArchiveBytes) throw new Error("uv archive is too large")
  const bytes = await boundedBody(response, maxArchiveBytes)
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== target.sha256) {
    throw new Error("uv archive checksum verification failed")
  }

  await fs.mkdir(Global.Path.bin, { recursive: true })
  const staging = await fs.mkdtemp(path.join(Global.Path.tmp, "uv-runtime-"))
  const temporary = `${binary}.download-${process.pid}-${Date.now()}`
  try {
    const archive = path.join(staging, target.name)
    await fs.writeFile(archive, bytes, { mode: 0o600 })
    await (options?.extract ?? extractArchive)(archive, staging)
    const extracted = path.join(staging, target.directory, platform === "win32" ? "uv.exe" : "uv")
    if (!(await executable(extracted))) throw new Error("uv archive did not contain the expected executable")
    await fs.copyFile(extracted, temporary)
    await fs.chmod(temporary, 0o700)
    await fs.rename(temporary, binary)
    return binary
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function boundedBody(response: Response, maximum: number) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximum) {
      await reader.cancel("uv archive is too large").catch(() => {})
      throw new Error("uv archive is too large")
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks, size)
}

async function extractArchive(archive: string, directory: string) {
  const error = await executeFile("tar", ["-xf", archive, "-C", directory]).then(
    () => undefined,
    (error) => (error instanceof Error ? error : new Error(String(error))),
  )
  if (error) throw new Error(error.message || "uv archive extraction failed")
}

async function executable(filename: string) {
  const info = await fs.stat(filename).catch(() => undefined)
  return Boolean(info?.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0))
}

export function resetUvDownloadState() {
  inflight = undefined
}
