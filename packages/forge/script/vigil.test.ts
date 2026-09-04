import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stageVigil } from "./vigil"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-vigil-stage-"))

afterAll(() => fs.rm(root, { recursive: true, force: true }))

describe("stageVigil", () => {
  for (const target of [
    { os: "darwin", arch: "arm64" },
    { os: "darwin", arch: "x64" },
    { os: "linux", arch: "arm64" },
    { os: "linux", arch: "x64" },
    { os: "linux", arch: "arm64", abi: "musl" },
    { os: "linux", arch: "x64", abi: "musl" },
    { os: "win32", arch: "arm64" },
    { os: "win32", arch: "x64" },
  ] as const) {
    test(`stages ${target.os}/${target.arch}`, async () => {
      const destination = path.join(root, `${target.os}-${target.arch}`)
      await stageVigil(target, destination)

      expect(await Bun.file(path.join(destination, "compact-model.onnx")).exists()).toBe(true)
      expect(await Bun.file(path.join(destination, "compact-model.onnx.json")).exists()).toBe(true)
      expect(await Bun.file(path.join(destination, "SHA256SUMS")).exists()).toBe(true)
      expect(
        await Bun.file(path.join(destination, target.os === "win32" ? "vigil-compact.exe" : "vigil-compact")).exists(),
      ).toBe(true)
      expect((await fs.readdir(destination, { recursive: true })).some((file) => path.basename(file).startsWith("._"))).toBe(
        false,
      )
    })
  }
})
