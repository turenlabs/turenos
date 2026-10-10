import { describe, expect, test } from "bun:test"
import {
  bundledReleaseNotes,
  releaseNotesFor,
  releaseNotesIssues,
  releaseNotesUrl,
  selectReleaseNotes,
  type ReleaseNote,
} from "./release-notes"

describe("release preparation validation", () => {
  const note: ReleaseNote = {
    version: "1.0.10",
    summary: "A release",
    changes: { new: ["A change"], improved: [], fixed: [] },
  }

  test("accepts structured notes with an exact canonical version", () => {
    expect(releaseNotesIssues([note], "1.0.10")).toEqual([])
    expect(releaseNotesIssues(bundledReleaseNotes, bundledReleaseNotes[0]!.version)).toEqual([])
  })

  test("requires the canonical stable version and rejects duplicate or future versions", () => {
    expect(releaseNotesIssues([note], "1.0.11").join("\n")).toContain("Missing release notes for VERSION 1.0.11")
    expect(releaseNotesIssues([note, note], "1.0.10").join("\n")).toContain("Duplicate release version")
    expect(releaseNotesIssues([note], "1.0.9").join("\n")).toContain("newer than VERSION")
    expect(releaseNotesIssues([note], "v1.0.10").join("\n")).toContain("Invalid canonical release version")
    expect(releaseNotesIssues([{ ...note, version: "1.0.10-beta" }], "1.0.10").length).toBeGreaterThan(0)
  })

  test("rejects malformed structures and unrecognized content fields", () => {
    for (const notes of [
      null,
      {},
      [],
      [null],
      [{ ...note, changes: null }],
      [{ ...note, changes: { new: [] } }],
      [{ ...note, media: "https://example.com/image.png" }],
    ]) {
      expect(releaseNotesIssues(notes, "1.0.10").length).toBeGreaterThan(0)
    }
  })

  test("bounds summaries, change text, change counts, and retained history", () => {
    for (const summary of ["", " \n", "x".repeat(241)]) {
      expect(releaseNotesIssues([{ ...note, summary }], "1.0.10").length).toBeGreaterThan(0)
    }
    for (const changes of [
      { new: [], improved: [], fixed: [] },
      { new: [" "], improved: [], fixed: [] },
      { new: ["x".repeat(241)], improved: [], fixed: [] },
      { new: Array(11).fill("Change"), improved: [], fixed: [] },
      { new: Array(10).fill("Change"), improved: Array(10).fill("Change"), fixed: ["Change"] },
    ]) {
      expect(releaseNotesIssues([{ ...note, changes }], "1.0.10").length).toBeGreaterThan(0)
    }
    expect(releaseNotesIssues(Array(51).fill(note), "1.0.10").join("\n")).toContain("1–50 releases")
  })
})

describe("release links", () => {
  test("uses only the canonical repository and a stable version tag", () => {
    expect(releaseNotesUrl("1.0.44")).toBe("https://github.com/turenlabs/turenos/releases/tag/v1.0.44")
  })

  test("rejects hostile, noncanonical, prerelease, and unsafe numeric versions", () => {
    for (const version of [
      "",
      "v1.0.44",
      "01.0.44",
      "1.0.44\n",
      " 1.0.44",
      "1.0.44-beta.1",
      "1.0.44+build",
      "1.0.44/../../evil",
      "1.0.44?redirect=https://evil.test",
      "9007199254740992.0.0",
    ]) {
      expect(() => releaseNotesUrl(version)).toThrow("Invalid stable release version")
    }
  })
})

describe("release history selection", () => {
  const history = ["1.0.9", "1.1.0", "1.0.10", "1.0.11", "1.0.12", "1.0.13", "1.0.14", "2.0.0"].map(
    (version): ReleaseNote => ({
      version,
      summary: "A release",
      changes: { new: ["A change"], improved: [], fixed: [] },
    }),
  )

  test("compares semantic versions numerically and excludes the previous version", () => {
    expect(selectReleaseNotes(history, "1.0.10", "1.0.9").map((note) => note.version)).toEqual(["1.0.10"])
    expect(selectReleaseNotes(history, "1.1.0", "1.0.13").map((note) => note.version)).toEqual(["1.1.0", "1.0.14"])
    expect(selectReleaseNotes(history, "2.0.0", "1.1.0").map((note) => note.version)).toEqual(["2.0.0"])
  })

  test("caps skipped releases at the latest five in descending order", () => {
    expect(selectReleaseNotes(history, "1.1.0", "1.0.0").map((note) => note.version)).toEqual([
      "1.1.0",
      "1.0.14",
      "1.0.13",
      "1.0.12",
      "1.0.11",
    ])
    expect(history[0]!.version).toBe("1.0.9")
  })

  test("never substitutes another release when the installed version is missing", () => {
    expect(selectReleaseNotes(history, "1.0.15", "1.0.9")).toEqual([])
    expect(selectReleaseNotes(history, "1.0.10").map((note) => note.version)).toEqual(["1.0.10"])
  })
})

describe("bundled release notes", () => {
  test("returns only the exact installed version without a previous version", () => {
    const current = bundledReleaseNotes[0]!
    expect(releaseNotesFor(current.version)).toEqual([current])
  })

  test("does not show notes again for the same version or a downgrade", () => {
    const current = bundledReleaseNotes[0]!.version
    expect(releaseNotesFor(current, current)).toEqual([])
    expect(releaseNotesFor(current, "999.0.0")).toEqual([])
  })

  test("fails closed for missing, malformed, or prerelease installed versions", () => {
    for (const current of [
      "999.0.0",
      "",
      "v1.0.44",
      "01.0.44",
      "1.0.44-beta.1",
      "1.0.44+build",
      "../1.0.44",
      "1.0.44\n",
    ]) {
      expect(releaseNotesFor(current, "1.0.0")).toEqual([])
    }
  })

  test("fails closed for malformed previous versions", () => {
    for (const previous of ["", "garbage", "1.0.0-beta.1", "1.0.0?redirect=evil"]) {
      expect(releaseNotesFor(bundledReleaseNotes[0]!.version, previous)).toEqual([])
    }
  })
})
