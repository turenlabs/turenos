#!/usr/bin/env bun

export type ExistingRelease = {
  tagName: string
  isDraft: boolean
  targetCommitish: string
}

export function releaseAction(input: {
  version: string
  targetSha: string
  tagSha?: string
  release?: ExistingRelease
}) {
  const expectedTag = `v${input.version}`
  if (!input.release) {
    if (input.tagSha) throw new Error(`${expectedTag} already exists without a resumable draft release`)
    return "create" as const
  }
  if (input.release.tagName !== expectedTag)
    throw new Error(`Release tag ${input.release.tagName} is not ${expectedTag}`)
  if (!input.release.isDraft) throw new Error(`${expectedTag} already exists as a published release`)
  if (input.release.targetCommitish !== input.targetSha) {
    throw new Error(`Draft ${expectedTag} targets ${input.release.targetCommitish}; expected ${input.targetSha}`)
  }
  if (input.tagSha !== input.targetSha) {
    throw new Error(`Tag ${expectedTag} resolves to ${input.tagSha ?? "no commit"}; expected ${input.targetSha}`)
  }
  return "resume" as const
}

if (import.meta.main) {
  const version = process.env.FORGE_VERSION
  const targetSha = process.env.RELEASE_SHA
  if (!version) throw new Error("FORGE_VERSION is required")
  if (!targetSha) throw new Error("RELEASE_SHA is required")
  const release = process.env.RELEASE_JSON ? (JSON.parse(process.env.RELEASE_JSON) as ExistingRelease) : undefined
  const action = releaseAction({
    version,
    targetSha,
    tagSha: process.env.TAG_SHA || undefined,
    release,
  })
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, `action=${action}\n`)
  console.log(action)
}
