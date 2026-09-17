export * as Vigil from "./vigil"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@turenlabs/core/global"
import { Extension } from "@turenlabs/schema"
import { Process } from "@/util/process"

const MODEL_SHA256 = "a56667baba56811b35dd7dffc75270f8c0d3f42de88f35dd198666a663e17f1e"
const METADATA_SHA256 = "9c90f3bc1869f77452ed4f1cec1cdb17ffac5e5a20b229060432d6c9596f26db"
const MAX_OUTPUT_BYTES = 64 * 1024

const targets = {
  "darwin-arm64": {
    archive: "vigil-compact-darwin-arm64.tar.gz",
    directory: "vigil-compact-darwin-arm64",
    sha256: "b47164c9e7db7cdc199f5212e90c9865202f0c54fd05fe9225bd9dda4d170436",
  },
  "darwin-x64": {
    archive: "vigil-compact-darwin-amd64.tar.gz",
    directory: "vigil-compact-darwin-amd64",
    sha256: "54c43cbad6ee28089d3ce0683153d36d033bf06e94012e9690917f1d86488a13",
    bundledOnly: true,
  },
  "linux-x64": {
    archive: "vigil-compact-linux-amd64.tar.gz",
    directory: "vigil-compact-linux-amd64",
    sha256: "d4479903615788ebd1c1217318070cbb202639d5993099d9f9eece3d7a256af6",
  },
  "linux-arm64": {
    archive: "vigil-compact-linux-arm64.tar.gz",
    directory: "vigil-compact-linux-arm64",
    sha256: "a344dac51a6a2691061494ae5ea24e5f8edab7a468d3ee9fad5efd14986b95d2",
  },
  "win32-x64": {
    archive: "vigil-compact-windows-amd64.zip",
    directory: "vigil-compact-windows-amd64",
    sha256: "2c5e65696b6704416b9fdbbd63d1079a6af5c3da49e7242541da17c5d412164f",
  },
  "win32-arm64": {
    archive: "vigil-compact-windows-arm64.zip",
    directory: "vigil-compact-windows-arm64",
    sha256: "064d7243b71e735a1e9169a25bdda1e08039bb1080e343d19dec500c1e9ceff5",
  },
} as const

type Config = {
  readonly binary: string
  readonly library: string
  readonly model: string
  readonly metadata: string
}

export type Result = {
  readonly label: "benign" | "malicious"
  readonly maliciousProbability: number
  readonly threshold: number
  readonly reviewed: boolean
}
type Score = Omit<Result, "reviewed">

/**
 * Digests of reviewed catalog skill manifests — `sha256` of the
 * `Extension.Manifest` JSON the client submits at install. Regenerate by
 * hashing `JSON.stringify(manifest)` for each catalog-sourced skill in
 * `ExtensionCatalog.manifests` (services/catalog/manifests/skills); the digest
 * covers every model-visible field, so any manifest edit re-flags the skill.
 */
const reviewedSkillDigests = new Set([
  // turenlabs/bug-root-cause
  "a1dfb48317ba26f516b1e2173789979d911cdb35dac4620c5a08ac393367dfe8",
  // turenlabs/dependency-risk-review
  "232928e74daf16ae9bed90db0d4b53205f0e8612657d34e2231b439c77f013d9",
  // turenlabs/detection-engineering-review
  "a5cc17171c5a7cb8de62e84d6ac903ad1bcda2ab43b38a451d52474dc6bcac3b",
  // turenlabs/iac-config-review
  "9a2b0ee0b3b04c486022045245f005335526f962759c1c2981dc494004535bb0",
  // turenlabs/incident-evidence-triage
  "24d2c42d7b2d26c48960842ead85f7be515b6a357b34369a4af999c1a8f8de26",
  // turenlabs/incident-responder
  "7fa4e7460fc1eef51b1260dd7a5c00bc1702e67e057da00bba6ad10d08ea96e5",
  // turenlabs/secure-code-review
  "550415b8d5cf9256cef61a930c9439f88952ed14a9b73cd462390cd72d5fc3ce",
  // turenlabs/software-architecture-reviewer
  "17f0fc432154a9631087010bd58c30152ecd4f4cbbf9ae3ca821d02b3cb343aa",
  // turenlabs/technical-security-blog
  "aab1c54a3c1909c00d4cfcb69e9d2a5cfec1c763abcfab384db3aed8e34f1831",
  // turenlabs/test-strategy
  "9ef7b51f553db3f1b86cef791e07f6122ea9f5babc6350e08343a8ceff8bb161",
  // turenlabs/threat-hunter
  "1b61adcde5fc79f6df0e5fbfeff617e89533a0570f8895715c25877dbd25fb19",
  // turenlabs/threat-intel-brief
  "bf5b82ca07e89e3cf1fc1c4407714edde5a4226abd391f9f6089d97156b3f70f",
  // turenlabs/threat-model-review
  "f38101c4cc5f44271bff2af3586876ce3b58aeb31997644606b774874f178a91",
  // turenlabs/vulnerability-analyst
  "74a72dc81faa69a6f2d868ca1917ea60588868c03d3f2a5d690f8dffdc42ec4b",
])

type Dependencies = {
  readonly ensure?: () => Promise<Config | undefined>
  readonly run?: typeof Process.run
}

let installing: Promise<Config | undefined> | undefined
let scanQueue = Promise.resolve()

export function target(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch) {
  return targets[`${platform}-${arch}` as keyof typeof targets]
}

export function resetInstallState() {
  installing = undefined
}

export async function ensure() {
  if (installing) return installing
  const selected = target()
  if (!selected) return undefined
  installing = loadBundled()
  try {
    return await installing
  } finally {
    installing = undefined
  }
}

export async function scanManifest(
  manifest: Extension.Manifest,
  dependencies?: Dependencies,
): Promise<Result | undefined> {
  const previous = scanQueue
  let release = () => {}
  scanQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await scanManifestUnlocked(manifest, dependencies)
  } finally {
    release()
  }
}

async function scanManifestUnlocked(
  manifest: Extension.Manifest,
  dependencies?: Dependencies,
): Promise<Result | undefined> {
  const content = manifest.contributions.flatMap((contribution) =>
    contribution.type === "skill" && contribution.source.type === "catalog" ? [contribution.source.content] : [],
  )
  if (content.length === 0) return undefined
  const config = await (dependencies?.ensure ?? ensure)()
  if (!config) throw new Error("Vigil scanner is unavailable on this device")

  const staging = await fs.mkdtemp(path.join(Global.Path.tmp, "vigil-skill-"))
  try {
    await fs.writeFile(path.join(staging, "SKILL.md"), content.join("\n\n"))
    const result = await (dependencies?.run ?? Process.run)(
      [
        config.binary,
        "--require-model",
        "--model",
        config.model,
        "--metadata",
        config.metadata,
        "--runtime-lib",
        config.library,
        "--format",
        "json",
        staging,
      ],
      {
        env: process.platform === "linux" ? { LD_LIBRARY_PATH: path.dirname(config.library) } : null,
        abort: AbortSignal.timeout(30_000),
        timeout: 2_000,
        nothrow: true,
      },
    )
    const output = result.code === 0 ? result.stdout : result.stderr
    if (output.byteLength > MAX_OUTPUT_BYTES) throw new Error("Vigil returned too much output")
    const value = parseResult(output.toString())
    if (result.code !== 0) throw new Error(`Vigil scan failed: ${value.errorCode ?? "unknown error"}`)
    if (!value.result) throw new Error("Vigil returned an invalid scan result")
    return { ...value.result, reviewed: reviewedSkillDigests.has(skillDigest(manifest)) }
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

export function skillDigest(manifest: Extension.Manifest) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}

export function blockReason(result: Result | undefined) {
  if (!result || result.label !== "malicious" || result.reviewed) return undefined
  return `Vigil blocked this skill package (score ${result.maliciousProbability}, threshold ${result.threshold})`
}

function parseResult(output: string): { result?: Score; errorCode?: string } {
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return {}
  const value = JSON.parse(line) as Record<string, unknown>
  if (value.schema_version === "vigil.compact-error.v1") {
    return { errorCode: typeof value.error_code === "string" ? value.error_code : "unknown error" }
  }
  if (
    value.schema_version !== "vigil.compact-score.v1" ||
    (value.label !== "benign" && value.label !== "malicious") ||
    typeof value.malicious_probability !== "number" ||
    typeof value.threshold !== "number" ||
    value.whole_package !== true ||
    value.model_required !== true
  ) {
    return {}
  }
  return {
    result: {
      label: value.label,
      maliciousProbability: value.malicious_probability,
      threshold: value.threshold,
    },
  }
}

async function loadBundled() {
  const root = process.env.FORGE_VIGIL_PATH ?? path.join(path.dirname(process.execPath), "vigil")
  if (!(await directory(root))) return undefined
  const value = runtimeConfig(root)
  // Release packaging signs native files after staging, which necessarily changes their package hashes.
  if (!(await runtimeComplete(value, false))) throw new Error("Bundled Vigil runtime package is incomplete")
  if (process.platform !== "win32") await fs.chmod(value.binary, 0o700)
  return value
}

function runtimeConfig(root: string): Config {
  return {
    binary: path.join(root, process.platform === "win32" ? "vigil-compact.exe" : "vigil-compact"),
    library: path.join(root, runtimeLibrary()),
    model: path.join(root, "compact-model.onnx"),
    metadata: path.join(root, "compact-model.onnx.json"),
  }
}

async function runtimeComplete(config: Config, verifyNative = true) {
  if (!(await file(config.binary)) || !(await file(config.library))) return false
  if (!(await file(config.model)) || !(await file(config.metadata))) return false
  const checksums = await fs.readFile(path.join(path.dirname(config.binary), "SHA256SUMS"), "utf8").catch(() => "")
  const expected = new Map(
    checksums.split("\n").flatMap((line) => {
      const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/)
      return match ? [[match[2], match[1]] as const] : []
    }),
  )
  const files = verifyNative ? [config.binary, config.library, config.model, config.metadata] : [config.model, config.metadata]
  for (const filename of files) {
    const digest = expected.get(path.basename(filename))
    if (!digest || (await sha256File(filename)) !== digest) return false
  }
  return (
    expected.get("compact-model.onnx") === MODEL_SHA256 && expected.get("compact-model.onnx.json") === METADATA_SHA256
  )
}

function runtimeLibrary() {
  if (process.platform === "darwin") return "libonnxruntime.dylib"
  if (process.platform === "win32") return "onnxruntime.dll"
  return "libonnxruntime.so"
}

async function file(filename: string) {
  return fs.stat(filename).then(
    (stat) => stat.isFile(),
    () => false,
  )
}

async function directory(filename: string) {
  return fs.stat(filename).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
}

async function sha256File(filename: string) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(filename))
    .digest("hex")
}
