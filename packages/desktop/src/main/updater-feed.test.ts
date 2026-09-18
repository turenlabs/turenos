import { describe, expect, test } from "bun:test"
import { releaseTag, type GitHubRelease } from "./updater-feed"

// Shaped like the GitHub releases API response: newest-first, mixing real
// releases with drafts, prereleases, and tags that are not versions.
const releases: GitHubRelease[] = [
  { tag_name: "v1.4.0" },
  { tag_name: "v1.4.1-rc.1", prerelease: true },
  { tag_name: "v1.3.2" },
  { tag_name: "latest" },
  { tag_name: "v1.3.1", draft: true },
  { tag_name: "v1.3.0" },
  { tag_name: "v1.2.0-beta.0", prerelease: true },
  { tag_name: "v1.2.0" },
]

// Usable targets in order: v1.4.0, v1.3.2, v1.3.0, v1.2.0 (hand-picked from
// the fixture: drafts, prereleases, and non-semver tags are not installable).
describe("update track release selection", () => {
  // Contract: lag N targets the release N positions behind the newest usable
  // release, so lag 0 is latest and lag 2 is two releases behind.
  test.each([
    [0, "v1.4.0"],
    [1, "v1.3.2"],
    [2, "v1.3.0"],
    [3, "v1.2.0"],
  ])("lag %i targets %s", (lag, expected) => {
    expect(releaseTag(releases, lag)).toBe(expected)
  })

  // Contract: a lag deeper than the release history clamps to the oldest
  // usable release instead of failing or going out of bounds.
  test.each([[4], [9], [100]])("lag %i clamps to the oldest usable release", (lag) => {
    expect(releaseTag(releases, lag)).toBe("v1.2.0")
  })

  // Contract: drafts, prereleases, and non-version tags are never targets —
  // even when they sit between real releases in the list.
  test("never selects a draft, prerelease, or non-version tag", () => {
    const unusable = ["v1.4.1-rc.1", "latest", "v1.3.1", "v1.2.0-beta.0"]
    for (let lag = 0; lag <= releases.length; lag += 1) {
      expect(unusable).not.toContain(releaseTag(releases, lag))
    }
  })

  // Contract: skipped entries do not consume lag positions — "one release
  // behind" means one published release behind, not one API row behind.
  test("lag counts published releases only, not raw API rows", () => {
    // Row index 3 is the unusable "latest" tag and row 2 is v1.3.2; if lag
    // counted raw rows, lag 1 would land on the prerelease at row 1 instead.
    expect(releaseTag(releases, 1)).toBe("v1.3.2")
    expect(releaseTag(releases, 2)).toBe("v1.3.0")
  })

  // Contract: a list with no usable release yields undefined so the caller
  // can fail the check instead of pinning a nonsense feed URL.
  test.each([
    [[]],
    [[{ tag_name: "v2.0.0", draft: true }]],
    [[{ tag_name: "v2.0.0-beta.1", prerelease: true }]],
    [[{ tag_name: "latest" }, {}]],
  ])("returns undefined for unusable input %#", (input) => {
    expect(releaseTag(input, 1)).toBeUndefined()
  })

  // Contract: malformed rows (missing/empty/non-string tag) are ignored
  // rather than selected or crashing the selection.
  test("ignores releases with missing or malformed tag names", () => {
    const malformed = [{}, { tag_name: "" }, { tag_name: "v1.0" }, { tag_name: "1.2.3" }] as GitHubRelease[]
    expect(releaseTag([...malformed, { tag_name: "v1.0.0" }], 0)).toBe("v1.0.0")
  })
})
