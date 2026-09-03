import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Protected } from "@turenlabs/core/filesystem/protected"

const home = os.homedir()

describe("Protected", () => {
  test("names the folders macOS guards, so a home scan can skip them", () => {
    const names = Protected.names()
    if (process.platform === "darwin") {
      // Reading inside any of these raises a per-category consent prompt.
      for (const name of ["Documents", "Pictures", "Music", "Movies", "Downloads", "Desktop", "Library"]) {
        expect(names.has(name)).toBe(true)
      }
      return
    }
    if (process.platform === "win32") {
      expect(names.has("Documents")).toBe(true)
      return
    }
    expect(names.size).toBe(0)
  })

  test("recognises the home directory itself", () => {
    expect(Protected.isHome(home)).toBe(true)
    expect(Protected.isHome(path.join(home, "projects"))).toBe(false)
    expect(Protected.isHome(path.join(home, "Documents"))).toBe(false)
  })

  test("tolerates an unnormalised home path", () => {
    expect(Protected.isHome(path.join(home, "projects", ".."))).toBe(true)
    expect(Protected.isHome(home + path.sep)).toBe(true)
  })

  test("under() reports protected children relative to the directory given", () => {
    const relatives = Protected.under(home)
    if (process.platform === "darwin") {
      expect(relatives).toContain("Documents")
      expect(relatives).toContain("Pictures")
    }
    // A directory that contains none of them yields none, rather than leaking
    // absolute paths or parent-relative escapes.
    for (const value of Protected.under(path.join(home, "projects", "app"))) {
      expect(value.startsWith("..")).toBe(false)
      expect(path.isAbsolute(value)).toBe(false)
    }
  })
})
