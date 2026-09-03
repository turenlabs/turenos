import { describe, expect, test } from "bun:test"
import { rendererStoreName } from "./renderer-store-name"
import { SETTINGS_STORE } from "./store-keys"

describe("renderer store name", () => {
  test("accepts generated names containing repeated dots", () => {
    expect(rendererStoreName("forge.workspace.-Users-tom-..1a2b3c.dat")).toBe("forge.workspace.-Users-tom-..1a2b3c.dat")
  })

  test.each(["../outside", "safe/../outside", "safe\\..\\outside", ".hidden", "", "a".repeat(256)])(
    "rejects invalid name %j",
    (name) => {
      expect(() => rendererStoreName(name)).toThrow("Invalid store name")
    },
  )

  test.each([SETTINGS_STORE, "forge.updater"])("rejects reserved store %s", (name) => {
    expect(() => rendererStoreName(name)).toThrow("only available through its typed IPC API")
  })
})
