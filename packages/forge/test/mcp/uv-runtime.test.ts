import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ensureUvBinary, resetUvDownloadState, uvTarget } from "../../src/mcp/uv-runtime"

describe("managed uv runtime", () => {
  test("selects only reviewed platform archives", () => {
    expect(uvTarget("darwin", "arm64")?.name).toBe("uv-aarch64-apple-darwin.tar.gz")
    expect(uvTarget("linux", "x64")?.name).toBe("uv-x86_64-unknown-linux-gnu.tar.gz")
    expect(uvTarget("win32", "x64")?.name).toBe("uv-x86_64-pc-windows-msvc.zip")
    expect(uvTarget("freebsd", "x64")).toBeUndefined()
  })

  test("rejects an archive before extraction when its checksum differs", async () => {
    resetUvDownloadState()
    let extracted = false
    const result = await ensureUvBinary({
      platform: "darwin",
      arch: "arm64" as const,
      binaryPath: path.join(import.meta.dir, "missing-uv"),
      fetch: async () => new Response("not the reviewed archive"),
      extract: async () => {
        extracted = true
      },
    })
    expect(result).toBeUndefined()
    expect(extracted).toBe(false)
  })

  test("coalesces concurrent downloads", async () => {
    resetUvDownloadState()
    let requests = 0
    const fetch = async () => {
      requests += 1
      await Bun.sleep(20)
      return new Response("invalid archive")
    }
    const options = {
      platform: "linux" as const,
      arch: "arm64" as const,
      binaryPath: path.join(import.meta.dir, "missing-uv"),
      fetch,
    }
    await Promise.all([ensureUvBinary(options), ensureUvBinary(options)])
    expect(requests).toBe(1)
  })

  test("stops reading a chunked archive at the configured byte limit", async () => {
    resetUvDownloadState()
    let extracted = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      },
    })
    const result = await ensureUvBinary({
      platform: "darwin",
      arch: "arm64",
      binaryPath: path.join(import.meta.dir, "missing-bounded-uv"),
      maxArchiveBytes: 4,
      fetch: async () => new Response(body),
      extract: async () => {
        extracted = true
      },
    })
    expect(result).toBeUndefined()
    expect(extracted).toBe(false)
  })
})
