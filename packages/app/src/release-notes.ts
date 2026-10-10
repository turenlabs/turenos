import { notes } from "./release-notes/content"

export type ReleaseNote = {
  version: string
  summary: string
  changes: { new: string[]; improved: string[]; fixed: string[] }
}

export const bundledReleaseNotes: readonly ReleaseNote[] = notes

export function releaseNotesFor(current: string, previous?: string): readonly ReleaseNote[] {
  return selectReleaseNotes(bundledReleaseNotes, current, previous)
}

export function selectReleaseNotes(
  history: readonly ReleaseNote[],
  current: string,
  previous?: string,
): readonly ReleaseNote[] {
  if (!stableVersion(current)) return []
  if (previous !== undefined && (!stableVersion(previous) || compareVersions(previous, current) >= 0)) return []
  if (!history.some((note) => note.version === current)) return []
  if (previous === undefined) return history.filter((note) => note.version === current)
  return history
    .filter(
      (note) =>
        stableVersion(note.version) &&
        compareVersions(note.version, previous) > 0 &&
        compareVersions(note.version, current) <= 0,
    )
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, 5)
}

export function releaseNotesUrl(version: string): string {
  if (!stableVersion(version)) throw new Error("Invalid stable release version")
  return `https://github.com/turenlabs/turenos/releases/tag/v${version}`
}

export function releaseNotesIssues(value: unknown, current: string): string[] {
  if (!stableVersion(current)) return ["Invalid canonical release version"]
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return ["Bundle must contain 1–50 releases"]
  const issues: string[] = []
  const versions = new Set<string>()
  value.forEach((note: unknown, index) => {
    const label = `Release notes entry ${index + 1}`
    if (
      !record(note) ||
      Object.keys(note).length !== 3 ||
      !["version", "summary", "changes"].every((key) => key in note)
    ) {
      issues.push(`${label}: expected only version, summary, and changes`)
      return
    }
    if (typeof note.version !== "string" || !stableVersion(note.version)) {
      issues.push(`${label}: invalid stable version`)
      return
    }
    if (versions.has(note.version)) issues.push(`Duplicate release version ${note.version}`)
    if (compareVersions(note.version, current) > 0)
      issues.push(`${label}: ${note.version} is newer than VERSION ${current}`)
    versions.add(note.version)
    if (!boundedText(note.summary)) issues.push(`${label}: summary must contain 1–240 nonblank characters`)
    const changes = note.changes
    if (
      !record(changes) ||
      Object.keys(changes).length !== 3 ||
      !["new", "improved", "fixed"].every((key) => key in changes)
    ) {
      issues.push(`${label}: changes must contain only new, improved, and fixed arrays`)
      return
    }
    const groups = [changes.new, changes.improved, changes.fixed]
    if (!groups.every((group) => Array.isArray(group) && group.length <= 10 && group.every(boundedText))) {
      issues.push(`${label}: each change group must contain at most 10 nonblank strings of 1–240 characters`)
      return
    }
    const count = groups.flat().length
    if (count < 1 || count > 20) issues.push(`${label}: expected 1–20 changes in total`)
  })
  if (!versions.has(current)) issues.push(`Missing release notes for VERSION ${current}`)
  return issues
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240
}

function stableVersion(value: string) {
  return (
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    !/\s/.test(value) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)))
  )
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
}
