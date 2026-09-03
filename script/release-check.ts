#!/usr/bin/env bun

export function validateReleaseVersion(input: string, canonical: string, tags: string[], resumedTag?: string) {
  const requested = parseVersion(input)
  if (!requested) throw new Error(`Invalid semantic version: ${input}`)
  if (input !== canonical) throw new Error(`Requested version ${input} does not match VERSION (${canonical})`)
  if (resumedTag && resumedTag !== `v${input}`) throw new Error(`Cannot resume ${resumedTag} while releasing v${input}`)

  const latest = tags
    .filter((tag) => tag !== resumedTag)
    .map((tag) => tag.replace(/^v/, ""))
    .map((tag) => ({ raw: tag, parsed: parseVersion(tag) }))
    .filter((tag): tag is { raw: string; parsed: Version } => tag.parsed !== undefined)
    .sort((a, b) => compareVersions(b.parsed, a.parsed))[0]
  if (latest && compareVersions(requested, latest.parsed) <= 0) {
    throw new Error(`Requested version ${input} must be greater than latest tag v${latest.raw}`)
  }
}

type Version = { major: number; minor: number; patch: number; prerelease: string[] }

function parseVersion(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match) return
  const prerelease = match[4]?.split(".") ?? []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function compareVersions(a: Version, b: Version) {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (!a.prerelease.length && b.prerelease.length) return 1
  if (a.prerelease.length && !b.prerelease.length) return -1
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return left.localeCompare(right)
  }
  return 0
}

if (import.meta.main) {
  const input = process.env.FORGE_VERSION
  if (!input) throw new Error("FORGE_VERSION is required")
  const canonical = (await Bun.file(new URL("../VERSION", import.meta.url)).text()).trim()
  const tags = Bun.spawnSync(["git", "tag", "--list", "v*"]).stdout.toString().split(/\r?\n/).filter(Boolean)
  validateReleaseVersion(input, canonical, tags, process.env.FORGE_RESUME_TAG || undefined)
  console.log(`Release version ${input} is valid and monotonic`)
}
