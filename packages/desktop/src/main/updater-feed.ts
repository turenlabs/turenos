export type GitHubRelease = { tag_name?: string; draft?: boolean; prerelease?: boolean }

/**
 * Picks the update target tag for a lag preference from a GitHub releases
 * listing, which arrives ordered newest-first. Drafts, prereleases, and tags
 * that are not plain `vX.Y.Z` are skipped: none of them are installable
 * update targets. A lag beyond the known history resolves to the oldest
 * usable release. Returns undefined when nothing usable was published.
 */
export function releaseTag(releases: GitHubRelease[], lag: number) {
  const tags = releases
    .filter(
      (release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? ""),
    )
    .map((release) => release.tag_name as string)
  return tags[Math.min(lag, tags.length - 1)]
}
