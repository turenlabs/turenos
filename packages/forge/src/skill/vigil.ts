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

const reviewedSkillDigests = new Set([
  "a37f910dad1abe5169b4634b8c49c62431ffe888265439b418752d1994d5a29a",
  "044e12760ac3d7fa1271d2cacee2b9a948da9eb94169b9f2a6c467ad649da580",
  "50cb868febebe92e6453193038c57a797109335ba6ba481b561f014aa6060ad0",
  "4211ee283105a097c1c0bd54b49c710076b4361c73bfed8c4d5afc52f3bce217",
  "b284da0187ad665730f1ed34fea6afd646228cee6e603fe4c9eed85febc6d7b2",
  "6fd2cb54571d79bb636818830693d2118aed9360130d695f4c39060c3a35ae8c",
  "fd18e7b9016719e80c4360a40ffa2e2519853926dd10ffa85dbc0ae22562c419",
  "4c091241f13fae3ae5999200f906b6cd0bec928bdee0171ebbfce09a303fa5ef",
  "798c1fccde07a7289dd4873b3b765973fb01c7f9bb15326f93cc8da3576e516f",
  "879a0c07db2c0511924354737730173c75b19d86aaa1ec01ea3cf75f002737d9",
  "c76012a2883684c4a53d83a1d9172d27ab14ef298a754ad36ee2b776323e2853",
  "71250d9b6b067975a618c8191e338d4e3001b11cadfd871105b1e09aa9d1bf99",
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
