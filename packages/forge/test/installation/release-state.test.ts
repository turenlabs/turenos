import { describe, expect, test } from "bun:test"
import { releaseAction } from "../../../../script/release-state"

const sha = "a".repeat(40)

describe("release draft state", () => {
  test("creates only when neither a release nor tag exists", () => {
    expect(releaseAction({ version: "0.1.0", targetSha: sha })).toBe("create")
    expect(() => releaseAction({ version: "0.1.0", targetSha: sha, tagSha: sha })).toThrow("without a resumable draft")
  })

  test("resumes a draft only at the exact release commit", () => {
    expect(
      releaseAction({
        version: "0.1.0",
        targetSha: sha,
        tagSha: sha,
        release: { tagName: "v0.1.0", isDraft: true, targetCommitish: sha },
      }),
    ).toBe("resume")
    // Draft releases have no git tag — the tag materializes at publish. A
    // tagless draft at the right commit is resumable, not a conflict.
    expect(
      releaseAction({
        version: "0.1.0",
        targetSha: sha,
        release: { tagName: "v0.1.0", isDraft: true, targetCommitish: sha },
      }),
    ).toBe("resume")
  })

  test("rejects published or unrelated releases without deleting them", () => {
    expect(() =>
      releaseAction({
        version: "0.1.0",
        targetSha: sha,
        tagSha: sha,
        release: { tagName: "v0.1.0", isDraft: false, targetCommitish: sha },
      }),
    ).toThrow("published release")
    expect(() =>
      releaseAction({
        version: "0.1.0",
        targetSha: sha,
        tagSha: "b".repeat(40),
        release: { tagName: "v0.1.0", isDraft: true, targetCommitish: "b".repeat(40) },
      }),
    ).toThrow("expected")
  })
})
