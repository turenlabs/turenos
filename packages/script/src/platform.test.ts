import { expect, test } from "bun:test"
import { Platform } from "./platform"

test.each([...Platform.targets])("selects $rustTarget", (target) => {
  expect(Platform.get(target.rustTarget)).toEqual(target)
  expect(target.bun.includes("aarch64")).toBe(target.arch === "arm64")
  expect(target.bun.endsWith("baseline")).toBe(target.arch === "x64")
})

test("rejects unsupported targets", () => {
  expect(() => Platform.get("i686-pc-windows-msvc")).toThrow("Unsupported runtime target")
  expect(() => Platform.get("aarch64-unknown-linux-musl")).toThrow("Unsupported runtime target")
})
