import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureCliLinks } from "./path-links"

const BINARY = "/Applications/TurenOS.app/Contents/Resources/forge-cli"
const OTHER_APP_BINARY = "/Applications/TurenOS Beta.app/Contents/Resources/forge-cli"

let dir: string

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  dir = mkdtempSync(join(tmpdir(), "path-links-"))
  return join(dir, "bin")
}

describe("ensureCliLinks", () => {
  test("creates the bin directory and links both names", () => {
    const bin = setup()
    const results = ensureCliLinks(bin, BINARY)
    expect(results.map((r) => r.name)).toEqual(["forge", "turenos"])
    expect(results.every((r) => r.state === "linked")).toBe(true)
    for (const name of ["forge", "turenos"]) expect(readlinkSync(join(bin, name))).toBe(BINARY)
  })

  test("leaves an existing link to the same binary alone", () => {
    const bin = setup()
    mkdirSync(bin, { recursive: true })
    symlinkSync(BINARY, join(bin, "forge"))
    ensureCliLinks(bin, BINARY)
    expect(readlinkSync(join(bin, "forge"))).toBe(BINARY)
  })

  test("repoints a link to a different app's bundled binary", () => {
    const bin = setup()
    mkdirSync(bin, { recursive: true })
    symlinkSync(OTHER_APP_BINARY, join(bin, "forge"))
    ensureCliLinks(bin, BINARY)
    expect(readlinkSync(join(bin, "forge"))).toBe(BINARY)
  })

  test("relinks a broken link", () => {
    const bin = setup()
    mkdirSync(bin, { recursive: true })
    symlinkSync("/gone/forge-cli", join(bin, "forge"))
    ensureCliLinks(bin, BINARY)
    expect(readlinkSync(join(bin, "forge"))).toBe(BINARY)
  })

  test("never clobbers a real file", () => {
    const bin = setup()
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "forge"), "#!/bin/sh\n")
    const [forge] = ensureCliLinks(bin, BINARY)
    expect(forge.state).toBe("skipped")
    expect(lstatSync(join(bin, "forge")).isSymbolicLink()).toBe(false)
  })

  test("never clobbers a directory", () => {
    const bin = setup()
    mkdirSync(join(bin, "forge"), { recursive: true })
    const [forge] = ensureCliLinks(bin, BINARY)
    expect(forge.state).toBe("skipped")
  })

  test("leaves a symlink to an unrelated live target alone", () => {
    const bin = setup()
    mkdirSync(bin, { recursive: true })
    const other = join(bin, "other-forge")
    writeFileSync(other, "")
    symlinkSync(other, join(bin, "forge"))
    const [forge] = ensureCliLinks(bin, BINARY)
    expect(forge.state).toBe("skipped")
    expect(existsSync(join(bin, "forge"))).toBe(true)
  })
})
