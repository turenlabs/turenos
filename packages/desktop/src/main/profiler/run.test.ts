import { describe, expect, test } from "bun:test"

import { buildManifest, databaseHint, isProfileOutputPath, runStamp } from "./run"

const env = {
  version: "0.1.0",
  name: "TurenOS Dev",
  channel: "dev",
  packaged: true,
  platform: "darwin",
  arch: "arm64",
  versions: { node: "24.0.0" },
  userData: "/Users/x/Library/Application Support/com.turenlabs.forge.dev",
}

const capture = { file: "sidecar.cpuprofile", samples: 2005, durationMs: 3004.9, sampleRateHz: 667 }

describe("runStamp", () => {
  test("is sortable and filesystem-safe", () => {
    expect(runStamp(new Date("2026-07-29T08:45:00.123Z"))).toBe("20260729-084500-123")
  })

  test("orders lexicographically the same way it orders in time", () => {
    const earlier = runStamp(new Date("2026-07-29T08:45:00.123Z"))
    const later = runStamp(new Date("2026-07-29T08:45:00.124Z"))
    expect(earlier < later).toBe(true)
  })
})

describe("isProfileOutputPath", () => {
  test("accepts an absolute .cpuprofile path", () => {
    expect(isProfileOutputPath("/tmp/profiles/20260729/sidecar.cpuprofile")).toBe(true)
  })

  test.each([
    ["a relative path", "profiles/sidecar.cpuprofile"],
    ["a traversal segment", "/tmp/../etc/sidecar.cpuprofile"],
    ["the wrong extension", "/tmp/sidecar.txt"],
    ["an embedded NUL", "/tmp/sidecar\0.cpuprofile"],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("rejects %s", (_label, value) => {
    expect(isProfileOutputPath(value)).toBe(false)
  })
})

describe("databaseHint", () => {
  // These three cases are the ones that get confused in practice, so they are
  // pinned: the packaged dev app and an unpackaged dev run do NOT share a file.
  test("packaged dev app resolves to forge-dev.db", () => {
    expect(databaseHint({ XDG_DATA_HOME: "/data" }, "dev", true)).toBe("/data/forge/forge-dev.db")
  })

  test("unpackaged dev run resolves to forge.db, because the desktop disables channel DBs", () => {
    expect(databaseHint({ XDG_DATA_HOME: "/data" }, "dev", false)).toBe("/data/forge/forge.db")
  })

  test("a prod build resolves to forge.db", () => {
    expect(databaseHint({ XDG_DATA_HOME: "/data" }, "prod", true)).toBe("/data/forge/forge.db")
  })

  test("FORGE_DB wins, and a bare name is resolved inside the data directory", () => {
    expect(databaseHint({ XDG_DATA_HOME: "/data", FORGE_DB: "scratch.db" }, "dev", true)).toBe("/data/forge/scratch.db")
    expect(databaseHint({ XDG_DATA_HOME: "/data", FORGE_DB: "/tmp/abs.db" }, "dev", true)).toBe("/tmp/abs.db")
    expect(databaseHint({ XDG_DATA_HOME: "/data", FORGE_DB: ":memory:" }, "dev", true)).toBe(":memory:")
  })

  test("a channel with path separators cannot escape the data directory", () => {
    // Dots survive the sanitiser (they are legal in a filename) but separators
    // do not, so the result is always a single file inside the data directory.
    const hint = databaseHint({ XDG_DATA_HOME: "/data" }, "../../etc/passwd", true)
    expect(hint).toBe("/data/forge/forge-..-..-etc-passwd.db")
    expect(hint.startsWith("/data/forge/")).toBe(true)
    expect(hint.slice("/data/forge/".length)).not.toContain("/")
  })
})

describe("buildManifest", () => {
  const base = {
    generated: new Date("2026-07-29T08:45:00.000Z"),
    armedMs: 12_000,
    sampleIntervalUs: 1000,
    failure: null,
    env,
    processEnv: { XDG_DATA_HOME: "/data" } as NodeJS.ProcessEnv,
  }

  test("records the process it covers, so the file is self-describing later", () => {
    const manifest = buildManifest({ ...base, capture })
    expect(manifest.process).toBe("sidecar")
    expect(manifest.capture).toEqual(capture)
    expect(manifest.app.databaseHint).toBe("/data/forge/forge-dev.db")
  })

  test("always states that renderer and main time are absent", () => {
    const manifest = buildManifest({ ...base, capture })
    expect(manifest.notes.some((note) => note.includes("no renderer"))).toBe(true)
  })

  test("leads with a warning when nothing was captured", () => {
    const manifest = buildManifest({ ...base, capture: null, failure: "Sidecar exited during profiling" })
    expect(manifest.notes[0]).toContain("WARNING: no profile was captured")
    expect(manifest.notes[0]).toContain("Sidecar exited during profiling")
  })

  test("leads with a warning when the profile has no samples, which is worse than no file", () => {
    const manifest = buildManifest({ ...base, capture: { ...capture, samples: 0 } })
    expect(manifest.notes[0]).toContain("zero samples")
  })
})
