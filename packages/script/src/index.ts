import semver from "semver"
import path from "path"
import { loadCanonicalVersion, resolveChannel, resolveVersion } from "./version"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  FORGE_CHANNEL: process.env["FORGE_CHANNEL"],
  FORGE_BUMP: process.env["FORGE_BUMP"],
  FORGE_VERSION: process.env["FORGE_VERSION"],
  FORGE_RELEASE: process.env["FORGE_RELEASE"],
}
const CHANNEL = resolveChannel(env.FORGE_CHANNEL)
const IS_PREVIEW = CHANNEL !== "prod"
const VERSION = resolveVersion({
  canonical: await loadCanonicalVersion(),
  requested: env.FORGE_VERSION,
  bump: env.FORGE_BUMP,
})

const team = ["Turen Labs", "turen-agent"]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.FORGE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`forge script`, JSON.stringify(Script, null, 2))
