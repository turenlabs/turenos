import { expect, test } from "bun:test"
import { Ignore } from "@turenlabs/core/filesystem/ignore"

test("match nested and non-nested", () => {
  expect(Ignore.match("node_modules/index.js")).toBe(true)
  expect(Ignore.match("node_modules")).toBe(true)
  expect(Ignore.match("node_modules/")).toBe(true)
  expect(Ignore.match("node_modules/bar")).toBe(true)
  expect(Ignore.match("node_modules/bar/")).toBe(true)
})

test("watcher patterns ignore dependency and VCS folders at any depth", () => {
  expect(Ignore.PATTERNS).toContain("**/node_modules/**")
  expect(Ignore.PATTERNS).toContain("**/.git/**")
  expect(Ignore.PATTERNS).toContain("**/dist/**")
})

test("watcher patterns keep ambiguous source folder names root-only", () => {
  for (const name of ["vendor", "build", "out", "target", "bin", "obj", "desktop"]) {
    expect(Ignore.PATTERNS).toContain(name)
    expect(Ignore.PATTERNS).not.toContain(`**/${name}/**`)
  }
})

test("match ignores nested folders and keeps similarly named files", () => {
  expect(Ignore.match("a/b/node_modules/c.js")).toBe(true)
  expect(Ignore.match(".git/config")).toBe(true)
  expect(Ignore.match("pkg/dist/index.js")).toBe(true)
  expect(Ignore.match("src/nodemodules.ts")).toBe(false)
})
