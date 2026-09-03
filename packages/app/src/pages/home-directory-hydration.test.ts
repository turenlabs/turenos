import { describe, expect, test } from "bun:test"
import { directoryHydrationKey, directoryHydrationPlan } from "./home-directory-hydration"

describe("directoryHydrationKey", () => {
  test("stabilizes equivalent server and directory plans", () => {
    expect(directoryHydrationKey("sidecar", ["/two", "/one", "/one"])).toBe(
      directoryHydrationKey("sidecar", ["/one", "/two"]),
    )
    expect(directoryHydrationKey("remote", ["/one", "/two"])).not.toBe(
      directoryHydrationKey("sidecar", ["/one", "/two"]),
    )
  })

  test("does not bootstrap passive recent directories", () => {
    expect(
      directoryHydrationPlan({
        focus: ["/running"],
        pinned: ["/pinned", "/running"],
        recent: ["/slow-history", "/another-history"],
      }),
    ).toEqual(["/pinned", "/running"])
  })
})
