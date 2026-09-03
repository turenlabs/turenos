import { describe, expect, test } from "bun:test"
import {
  discoverVersionedPackageFiles,
  INDEPENDENTLY_VERSIONED_PACKAGE_FILES,
  loadCanonicalVersion,
  parseVersion,
  publicationMismatches,
  resolveChannel,
  resolveVersion,
  VERSIONED_PACKAGE_FILES,
  versionMismatches,
} from "../src/version"

describe("TurenOS version authority", () => {
  test("accepts strict semantic versions", () => {
    expect(parseVersion("0.1.0\n")).toBe("0.1.0")
    expect(parseVersion("0.2.0-beta.1")).toBe("0.2.0-beta.1")
    expect(() => parseVersion("v0.1.0")).toThrow("Invalid TurenOS version")
    expect(() => parseVersion("1.0")).toThrow("Invalid TurenOS version")
  })

  test("rejects release overrides and automatic bumps", () => {
    expect(resolveVersion({ canonical: "0.1.0", requested: "0.1.0" })).toBe("0.1.0")
    expect(() => resolveVersion({ canonical: "0.1.0", requested: "0.1.1" })).toThrow("does not match canonical VERSION")
    expect(() => resolveVersion({ canonical: "0.1.0", bump: "patch" })).toThrow("FORGE_BUMP is no longer supported")
  })

  test("normalizes product channels", () => {
    expect(resolveChannel()).toBe("dev")
    expect(resolveChannel("latest")).toBe("prod")
    expect(resolveChannel("prod")).toBe("prod")
    expect(resolveChannel("beta")).toBe("beta")
    expect(() => resolveChannel("nightly")).toThrow("Invalid FORGE_CHANNEL")
  })

  test("keeps every version-bearing manifest synchronized", async () => {
    const version = await loadCanonicalVersion()
    expect(VERSIONED_PACKAGE_FILES).toHaveLength(16)
    expect(await discoverVersionedPackageFiles()).toEqual(
      [...VERSIONED_PACKAGE_FILES, ...INDEPENDENTLY_VERSIONED_PACKAGE_FILES].sort(),
    )
    expect(await versionMismatches(version)).toEqual([])
  })

  test("detects manifest and lockfile drift", async () => {
    const mismatches = await versionMismatches("0.1.1")
    expect(mismatches.some((message) => message.startsWith("package.json:"))).toBe(true)
    expect(mismatches.some((message) => message.startsWith("bun.lock["))).toBe(true)
  })

  test("fails closed for every unapproved package publication lane", () => {
    expect(publicationMismatches("package.json", { private: true })).toEqual([])
    expect(publicationMismatches("package.json", {})).toEqual([
      "package.json: publishing is disabled for TurenOS packages; expected private: true",
    ])
    expect(publicationMismatches("package.json", { private: true, publishConfig: { access: "public" } })).toEqual([
      "package.json: publishing is disabled; remove publishConfig",
    ])
  })
})
