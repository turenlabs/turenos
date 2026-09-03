import { describe, expect, test } from "bun:test"
import { validateReleaseVersion } from "../../../../script/release-check"

describe("release version check", () => {
  test("accepts the canonical version when it is newer than every tag", () => {
    expect(() => validateReleaseVersion("0.2.0", "0.2.0", ["v0.1.0", "v0.1.9"])).not.toThrow()
  })

  test("rejects a dispatch version that differs from VERSION", () => {
    expect(() => validateReleaseVersion("0.2.1", "0.2.0", ["v0.1.9"])).toThrow("does not match VERSION")
  })

  test("rejects a version that does not advance the latest release tag", () => {
    expect(() => validateReleaseVersion("0.2.0", "0.2.0", ["v0.2.0"])).toThrow("must be greater")
  })

  test("rejects invalid semantic versions", () => {
    expect(() => validateReleaseVersion("0.2.0-beta.01", "0.2.0-beta.01", [])).toThrow("Invalid semantic version")
  })

  test("allows the exact current tag only for a validated draft resume", () => {
    expect(() => validateReleaseVersion("0.2.0", "0.2.0", ["v0.1.0", "v0.2.0"], "v0.2.0")).not.toThrow()
    expect(() => validateReleaseVersion("0.2.0", "0.2.0", ["v0.2.0"], "v0.1.0")).toThrow("Cannot resume")
  })
})
