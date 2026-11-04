import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopAttach } from "./desktop-attach"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "turen-desktop-attach-"))
  directories.push(directory)
  const warnings: string[] = []
  return {
    directory,
    file: join(directory, "attach.json"),
    warnings,
    attach: createDesktopAttach(directory, (message) => warnings.push(message)),
  }
}

const connection = { url: "http://127.0.0.1:12345", username: "forge", password: "test-secret" }

test("publishes a private version 1 record naming the desktop process", () => {
  const f = fixture()
  f.attach.publish(connection)
  expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual({ version: 1, pid: process.pid, ...connection })
  if (process.platform !== "win32") expect(statSync(f.file).mode & 0o777).toBe(0o600)
  expect(readdirSync(f.directory)).toEqual(["attach.json"])
  expect(f.warnings).toEqual([])
})

test("clears stale records on startup, and clear is idempotent", () => {
  const f = fixture()
  f.attach.publish(connection)
  const restarted = createDesktopAttach(f.directory, (message) => f.warnings.push(message))
  expect(existsSync(f.file)).toBe(false)
  restarted.publish({ ...connection, password: "replacement-secret" })
  restarted.clear()
  restarted.clear()
  expect(readdirSync(f.directory)).toEqual([])
  expect(f.warnings).toEqual([])
})

test.skipIf(process.platform === "win32")("replaces permissive records with a private file", () => {
  const f = fixture()
  writeFileSync(f.file, "stale")
  chmodSync(f.file, 0o644)
  f.attach.publish(connection)
  expect(statSync(f.file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(f.file, "utf8")).password).toBe(connection.password)
})

test.skipIf(process.platform === "win32")("replaces a symlink without writing credentials to its target", () => {
  const f = fixture()
  const target = join(f.directory, "other-file")
  writeFileSync(target, "untouched")
  symlinkSync(target, f.file)
  f.attach.publish(connection)
  expect(readFileSync(target, "utf8")).toBe("untouched")
  expect(JSON.parse(readFileSync(f.file, "utf8")).password).toBe(connection.password)
  expect(f.warnings).toEqual([])
})

test("publication failures leave no temporary credential and warn without secrets", () => {
  const f = fixture()
  mkdirSync(f.file)
  expect(() => f.attach.publish(connection)).not.toThrow()
  expect(readdirSync(f.directory)).toEqual(["attach.json"])
  expect(f.warnings).toEqual(["Could not publish the desktop server attach record"])
})
